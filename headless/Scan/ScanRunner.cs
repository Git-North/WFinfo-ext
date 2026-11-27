using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Newtonsoft.Json;
using WFInfo.Errors;
using WFInfo.MacOS;
using WFInfo.Services.WindowInfo;
using WFInfo.Settings;

namespace WFInfo.Scan
{
    /// <summary>
    /// One hotkey scan: capture the screen (or read a PNG), OCR the reward strip
    /// with WFInfo's own pipeline, price every recognised part from the local
    /// price cache (filling it from warframe.market on demand), pick the best
    /// platinum choice, then persist a scan record for the dashboard and show the
    /// verdict as a desktop notification.
    /// </summary>
    internal sealed class ScanRunner
    {
        /// <summary>A reward screen parses at least two parts; stop hunting other outputs then.</summary>
        private const int PartsGoodEnough = 2;

        /// <summary>Pause between captures while a triggered scan waits for the panel.</summary>
        private const int CaptureRetryIntervalMs = 400;

        private readonly ScanOptions _options;
        private readonly IWindowInfoService _window;
        private readonly MarketSheet _sheet;
        private readonly PriceCache _cache;
        private readonly ApplicationSettings _settings;
        private readonly VisionRewardScan _visionLayout;
        private readonly ScanPublisher _publisher = new ScanPublisher(ScanPaths.ScansDir);
        private int _captureCount;

        /// <param name="visionLayout">
        /// macOS Vision layout scan (no System.Drawing); null runs WFInfo's own
        /// extraction with Tesseract (Linux, or `--ocr tesseract`).
        /// </param>
        public ScanRunner(ScanOptions options, IWindowInfoService window, MarketSheet sheet, PriceCache cache, ApplicationSettings settings,
            VisionRewardScan visionLayout)
        {
            _options = options;
            _window = window;
            _sheet = sheet;
            _cache = cache;
            _settings = settings;
            _visionLayout = visionLayout;
        }

        /// <summary>
        /// A manual scan (CLI, hotkey, dashboard): one accurate pass (Stage
        /// "single"), or the fast and deep passes with `--two-pass`. Returns 0
        /// when a record was produced, 1 when capture/OCR failed.
        /// </summary>
        public Task<int> RunAsync() =>
            RunScanAsync(TriggerManual, twoPass: _options.TwoPass, notify: _options.Notify);

        /// <summary>
        /// An automatic scan (the EE.log trigger): on macOS a fast pass, then
        /// always a deep pass on the same capture. WFInfo-ext's settings are
        /// read at each trigger: they decide whether the scan posts a desktop
        /// notification (default off; `--no-notify` still wins).
        /// </summary>
        public Task<int> RunWatchAsync()
        {
            ExtSettings settings = ExtSettings.Load();
            return RunScanAsync(TriggerWatch, twoPass: true, notify: _options.Notify && settings.Notifications);
        }

        /// <summary>Record field Trigger of an EE.log-triggered scan.</summary>
        public const string TriggerWatch = "watch";

        /// <summary>Record field Trigger of a CLI, hotkey or dashboard scan.</summary>
        public const string TriggerManual = "manual";

        /// <summary>Record field Stage values.</summary>
        public const string StageFast = "fast";
        public const string StageDeep = "deep";
        public const string StageSingle = "single";

        private async Task<int> RunScanAsync(string trigger, bool twoPass, bool notify)
        {
            DateTime startedUtc = DateTime.UtcNow;
            var watch = Stopwatch.StartNew();
            string scanId = startedUtc.ToString("yyyyMMdd_HHmmssfff", CultureInfo.InvariantCulture) + "-" +
                Environment.ProcessId.ToString(CultureInfo.InvariantCulture);
            // The fast and deep passes are a macOS Vision feature; WFInfo's own
            // extraction (Linux, `--ocr tesseract`) reads once.
            twoPass = twoPass && _visionLayout != null;
            ScanResult NewRecord(string stage) => new ScanResult
            {
                Version = 1,
                StartedAt = ScanPaths.Iso(startedUtc),
                CaptureSource = _options.File != null ? "file" : ScreenCapture.SourceName,
                OcrEngine = _visionLayout != null ? "vision-layout" : "tesseract",
                ScanId = scanId,
                Stage = stage,
                Trigger = trigger,
            };

            try
            {
                Directory.CreateDirectory(ScanPaths.ScansDir);
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
            {
                Console.Error.WriteLine($"{ErrorCatalog.Get(ScansFolderCode)}: cannot create {ScanPaths.ScansDir}: {ex.Message}");
                return 1;
            }

            _publisher.DeleteStalePending();

            try
            {
                if (_visionLayout == null) return await RunWfInfoExtractionAsync(NewRecord(StageSingle), startedUtc, watch, notify).ConfigureAwait(false);
                if (!twoPass) return await RunVisionSingleAsync(NewRecord(StageSingle), startedUtc, watch, notify).ConfigureAwait(false);
                return await RunVisionPassesAsync(NewRecord, startedUtc, watch, notify).ConfigureAwait(false);
            }
            catch (Exception ex) when (!(ex is ArgumentException))
            {
                // An unexpected failure still leaves a record with a code (a
                // generated one, with a crash report). Bad options (an
                // ArgumentException) stay a fatal CLI error, as before.
                ScanResult failed = NewRecord(twoPass ? StageDeep : StageSingle);
                SetError(failed, ex.Message, null, ex);
                return Complete(failed, watch, notify);
            }
        }

        /// <summary>
        /// WFInfo's own extraction (Linux, or `--ocr tesseract`): theme probe,
        /// part boxes and Tesseract on each candidate, with the re-capture loop.
        /// </summary>
        private async Task<int> RunWfInfoExtractionAsync(ScanResult result, DateTime startedUtc, Stopwatch watch, bool notify)
        {
            string lastError = null;
            string lastErrorCode = null;
            Bitmap acceptedImage = null;
            string acceptedPath = null;
            byte[] acceptedPng = null;
            string acceptedTarget = null;
            bool acceptedIsTemporary = false;
            var acceptedParts = new List<string>();
            string acceptedTheme = null;
            double acceptedThemeWeight = 0;

            // The game announces a reward screen before the panel is on screen
            // (the EE.log watcher keys on the announcement), so a triggered scan
            // re-captures until a part is recognised or the wait budget is spent.
            DateTime attemptDeadline = startedUtc.AddSeconds(_options.WaitSeconds);
            while (true)
            {
                foreach (CaptureCandidate candidate in BuildCandidates())
                {
                    byte[] png = null;
                    if (candidate.Kind == "memory")
                    {
                        // macOS: the PNG comes back through the helper's stdout.
                        png = ScreenCapture.CaptureMacPng(candidate.Output, candidate.Window, out string captureError);
                        if (png == null)
                        {
                            lastError = captureError;
                            lastErrorCode = CaptureFailedCode;
                            continue;
                        }
                    }
                    else if (candidate.Kind == "capture")
                    {
                        if (!ScreenCapture.Capture(candidate.Output, candidate.Region, candidate.Path, out string captureError))
                        {
                            lastError = captureError;
                            lastErrorCode = CaptureFailedCode;
                            continue;
                        }
                    }

                    string loadError;
                    Bitmap bitmap = png != null
                        ? TryLoadPng(png, candidate.Label, out loadError)
                        : TryLoad(candidate.Path, out loadError);
                    if (bitmap == null)
                    {
                        lastError = loadError;
                        lastErrorCode = ScreenshotUnreadableCode;
                        if (candidate.Kind == "capture") TryDelete(candidate.Path);
                        continue;
                    }

                    List<string> parts = RecognizeParts(bitmap, out string themeUsed, out double themeWeight);
                    if (acceptedImage == null || parts.Count > acceptedParts.Count)
                    {
                        acceptedImage?.Dispose();
                        if (acceptedIsTemporary) TryDelete(acceptedPath);

                        acceptedImage = bitmap;
                        acceptedPath = candidate.Path;
                        acceptedPng = png;
                        acceptedIsTemporary = candidate.Kind == "capture";
                        acceptedTarget = candidate.Kind == "file"
                            ? candidate.Path
                            : candidate.Label;
                        acceptedParts = parts;
                        acceptedTheme = themeUsed;
                        acceptedThemeWeight = themeWeight;
                    }
                    else
                    {
                        bitmap.Dispose();
                        if (candidate.Kind == "capture") TryDelete(candidate.Path);
                    }

                    if (acceptedParts.Count >= PartsGoodEnough) break;
                }

                if (acceptedParts.Count > 0) break;
                if (DateTime.UtcNow >= attemptDeadline) break;

                await Task.Delay(CaptureRetryIntervalMs).ConfigureAwait(false);
            }

            if (acceptedImage == null)
            {
                SetError(result, lastError ?? "no screenshot could be captured or read", lastErrorCode ?? CaptureFailedCode, null);
            }
            else
            {
                result.CaptureTarget = acceptedTarget;
                result.ScreenshotWidth = acceptedImage.Width;
                result.ScreenshotHeight = acceptedImage.Height;
                result.UiScaling = OCR.uiScaling;
                result.Theme = acceptedTheme;
                result.ThemeWeight = acceptedThemeWeight;

                result.ScreenshotPath = acceptedPng != null
                    ? StorePng(acceptedPng)
                    : StoreScreenshot(acceptedPath) ?? acceptedPath;
                await PriceAsync(result, acceptedParts).ConfigureAwait(false);

                acceptedImage.Dispose();
                if (acceptedIsTemporary) TryDelete(acceptedPath);
            }

            CleanTempDirectory();
            return Complete(result, watch, notify);
        }

        /// <summary>
        /// One Vision pass over the candidates, with the re-capture loop: each
        /// candidate (a file, a window, or every display, main first) is one
        /// helper call through <paramref name="read"/>. The attempt with the
        /// most parts wins; while nothing is found, the newest capture of the
        /// first candidate that worked wins (the panel may appear late). Only
        /// the winner keeps its capture; every other capture is deleted.
        /// </summary>
        private async Task<Selection> SelectAsync(DateTime deadline, Func<CaptureCandidate, string, VisionRewardScan.Attempt> read)
        {
            var selection = new Selection();
            int acceptedIndex = -1;
            while (true)
            {
                List<CaptureCandidate> candidates = BuildCandidates();
                for (int index = 0; index < candidates.Count; index++)
                {
                    CaptureCandidate candidate = candidates[index];
                    string file = candidate.Kind == "file" ? candidate.Path : null;

                    // The read deletes the capture of a failed or losing pass itself.
                    VisionRewardScan.Attempt attempt = read(candidate, file);
                    if (attempt.Error != null)
                    {
                        selection.LastFailed = attempt;
                        continue;
                    }

                    VisionRewardScan.Attempt accepted = selection.Accepted;
                    bool better = accepted == null
                        || attempt.Parts.Count > accepted.Parts.Count
                        || (attempt.Parts.Count == 0 && accepted.Parts.Count == 0 && index == acceptedIndex);
                    if (better)
                    {
                        if (accepted?.SavedPng != null) TryDelete(accepted.SavedPng);
                        selection.Accepted = attempt;
                        selection.Target = file ?? candidate.Label;
                        selection.File = file;
                        acceptedIndex = index;
                    }
                    else
                    {
                        TryDelete(attempt.SavedPng);
                    }

                    if (selection.Accepted.Parts.Count >= PartsGoodEnough) break;
                }

                if (selection.Accepted != null && selection.Accepted.Parts.Count > 0) break;
                if (DateTime.UtcNow >= deadline) break;

                await Task.Delay(CaptureRetryIntervalMs).ConfigureAwait(false);
            }
            return selection;
        }

        /// <summary>
        /// macOS manual scan without System.Drawing: one accurate pass (tiles,
        /// and the unknown-scale second pass), as before the two-pass flow.
        /// The helper writes each capture to the scans dir; the accepted one
        /// becomes scans/last.png, the others are deleted. No temporary files.
        /// </summary>
        private async Task<int> RunVisionSingleAsync(ScanResult result, DateTime startedUtc, Stopwatch watch, bool notify)
        {
            Selection selection = await SelectAsync(
                startedUtc.AddSeconds(_options.WaitSeconds),
                (candidate, file) => _visionLayout.Run(candidate.Output, candidate.Window, file, NextCapturePath)).ConfigureAwait(false);

            if (selection.Accepted == null)
            {
                SetError(result, selection.LastFailed);
            }
            else
            {
                FillVision(result, selection, selection.Accepted);
                result.ScreenshotPath = selection.File != null
                    ? StoreScreenshot(selection.File) ?? selection.File
                    : MoveToScreenshot(selection.Accepted.SavedPng);
                await PriceAsync(result, selection.Accepted.Parts).ConfigureAwait(false);
            }

            return Complete(result, watch, notify);
        }

        /// <summary>
        /// The automatic scan: a FAST pass (Vision fast mode, no tiles, one read
        /// at the known or estimated UI scale) with the re-capture loop, then
        /// always a DEEP pass (accurate mode, tiles, the unknown-scale second
        /// pass) on the same capture, read back from its file. The fast record
        /// is published at once when it has parts; the deep record, same
        /// ScanId, replaces it. The deep record keeps the fast parts when the
        /// deep pass reads fewer or fails. The deep record follows the
        /// keep-last-good rule like a manual scan.
        /// </summary>
        private async Task<int> RunVisionPassesAsync(Func<string, ScanResult> newRecord, DateTime startedUtc, Stopwatch watch, bool notify)
        {
            Selection fast = await SelectAsync(
                startedUtc.AddSeconds(_options.WaitSeconds),
                (candidate, file) => _visionLayout.RunFast(candidate.Output, candidate.Window, file, NextCapturePath)).ConfigureAwait(false);

            ScanResult fastRecord = null;
            if (fast.Accepted != null && fast.Accepted.Parts.Count > 0)
            {
                fastRecord = newRecord(StageFast);
                FillVision(fastRecord, fast, fast.Accepted);
                // A copy: the capture stays for the deep pass.
                fastRecord.ScreenshotPath = StoreScreenshot(fast.File ?? fast.Accepted.SavedPng);
                await PriceAsync(fastRecord, fast.Accepted.Parts).ConfigureAwait(false);
                Complete(fastRecord, watch, notify);
            }

            ScanResult deepRecord = newRecord(StageDeep);
            string image = fast.File ?? fast.Accepted?.SavedPng;
            if (image == null)
            {
                SetError(deepRecord, fast.LastFailed);
                return Complete(deepRecord, watch, notify);
            }

            VisionRewardScan.Attempt deep = _visionLayout.Run(null, null, image, null);
            VisionRewardScan.Attempt chosen = deep;
            if (deep.Error != null && fast.Accepted.Parts.Count == 0)
            {
                // Nothing to fall back on: the deep failure is the result.
                SetError(deepRecord, deep);
                TryDelete(fast.Accepted.SavedPng);
                return Complete(deepRecord, watch, notify);
            }
            if (deep.Error != null)
            {
                chosen = fast.Accepted;
                ErrorInfo info = ErrorInfoFor(deep.ErrorCode, deep.Error, deep.Failure, out _);
                deepRecord.Notice = $"Deep pass failed ({info.Code} {info.Name}); this is the fast result";
                Main.AddLog("Deep pass failed: " + deep.Error);
            }
            else if (deep.Parts.Count < fast.Accepted.Parts.Count)
            {
                chosen = fast.Accepted;
                Main.AddLog($"Deep pass read {deep.Parts.Count} parts, the fast pass {fast.Accepted.Parts.Count}; keeping the fast parts");
            }

            FillVision(deepRecord, fast, chosen);
            deepRecord.ScreenshotPath = fast.File != null
                ? StoreScreenshot(fast.File) ?? fast.File
                : MoveToScreenshot(fast.Accepted.SavedPng);
            await PriceAsync(deepRecord, chosen.Parts).ConfigureAwait(false);

            // One notification per new answer: the deep record only notifies
            // when it reads other names than the fast record did.
            bool notifyDeep = notify && (fastRecord == null || ScanNews.FoundNewNames(fastRecord, deepRecord));
            return Complete(deepRecord, watch, notifyDeep);
        }

        /// <summary>Copies the capture facts of a Vision attempt into a record.</summary>
        private static void FillVision(ScanResult result, Selection selection, VisionRewardScan.Attempt attempt)
        {
            result.CaptureTarget = selection.Target;
            result.ScreenshotWidth = attempt.Width;
            result.ScreenshotHeight = attempt.Height;
            result.UiScaling = attempt.UiScale;
            result.Theme = null;
            result.ThemeWeight = 0;
        }

        /// <summary>Prices the recognised parts, flags the best choice and saves the price cache.</summary>
        private async Task PriceAsync(ScanResult result, List<string> parts)
        {
            result.Choices = await PriceChoicesAsync(parts).ConfigureAwait(false);
            result.PriceCache = new PriceCacheStats
            {
                Hits = _cache.Hits,
                Fetched = _cache.Fetched,
                Failed = _cache.Failed,
                Entries = _cache.Entries,
            };
            _cache.Save();
            SetRecommendations(result);
        }

        /// <summary>Finishes the record: timing, publish, console summary, notification.</summary>
        private int Complete(ScanResult result, Stopwatch watch, bool notify)
        {
            result.FinishedAt = ScanPaths.Iso(DateTime.UtcNow);
            result.DurationMs = watch.ElapsedMilliseconds;

            ScanResult published = Persist(result, out bool keptPrevious);
            Print(result);
            if (keptPrevious) Console.WriteLine($"  kept:     the last good record ({published.Notice})");

            if (notify) SendNotification(result);
            if (_options.PrintJson) Console.WriteLine(JsonConvert.SerializeObject(result, Formatting.Indented));

            return result.Error == null ? 0 : 1;
        }

        /// <summary>Sets Error and the catalog fields from a failed Vision attempt (null: nothing was captured).</summary>
        private static void SetError(ScanResult result, VisionRewardScan.Attempt failed)
        {
            if (failed == null)
                SetError(result, "no screenshot could be captured or read", CaptureFailedCode, null);
            else
                SetError(result, failed.Error, failed.ErrorCode, failed.Failure);
        }

        /// <summary>
        /// Sets Error, ErrorCode, ErrorName and ErrorAction. A known catalog
        /// code is used as is; anything else gets a generated GEN- code from
        /// the exception and a crash report (its path goes in CrashReport).
        /// </summary>
        internal static void SetError(ScanResult result, string message, string code, Exception failure)
        {
            ErrorInfo info = ErrorInfoFor(code, message, failure, out Exception cause);
            result.Error = message;
            result.ErrorCode = info.Code;
            result.ErrorName = info.Name;
            result.ErrorAction = info.Action;
            if (info.Generated) result.CrashReport = CrashReport.Write(cause, "scan", info);
        }

        private static ErrorInfo ErrorInfoFor(string code, string message, Exception failure, out Exception cause)
        {
            cause = failure ?? new InvalidOperationException(message);
            return ErrorCatalog.Get(code) ?? ErrorCatalog.ForException(cause);
        }

        /// <summary>Catalog codes the runner sets itself (errors/catalog.json).</summary>
        internal const string CaptureFailedCode = "CAP-004";
        internal const string ScreenshotUnreadableCode = "CAP-005";
        internal const string ScansFolderCode = "DAT-004";

        /// <summary>
        /// A new capture path for one helper call: scans/capture-&lt;pid&gt;-&lt;n&gt;.png.
        /// The process id keeps two scan processes apart; the counter keeps every
        /// call of this process apart (candidates, retries, both scale passes,
        /// and every scan of a watch).
        /// </summary>
        private string NextCapturePath() =>
            Path.Combine(ScanPaths.ScansDir, string.Format(CultureInfo.InvariantCulture,
                "capture-{0}-{1}.png", Environment.ProcessId, ++_captureCount));

        /// <summary>
        /// The helper's capture becomes the pending screenshot (same directory, so
        /// a rename); <see cref="Persist"/> publishes it as scans/last.png.
        /// </summary>
        private string MoveToScreenshot(string savedPng)
        {
            try
            {
                if (string.IsNullOrEmpty(savedPng) || !File.Exists(savedPng)) return null;
                File.Move(savedPng, _publisher.PendingScreenshot, overwrite: true);
                return ScanPaths.ScreenshotPng;
            }
            catch (Exception ex)
            {
                Main.AddLog("Failed to store the scan screenshot: " + ex.Message);
                TryDelete(savedPng);
                return null;
            }
        }

        /// <summary>
        /// Screens to try: the given file, a chosen region, a chosen output, or
        /// every output before the joined (all outputs) capture. The joined
        /// image puts the reward strip off-center whenever monitors sit side by
        /// side, so it is only a fallback — and the last resort when wlr-randr
        /// is unavailable. A file or a region is a single candidate: the caller
        /// asked for exactly that image. On macOS a window id or a display id is
        /// a single candidate too; otherwise every display is tried, main display
        /// first (ScreenCaptureKit has no joined image).
        /// </summary>
        private List<CaptureCandidate> BuildCandidates()
        {
            var candidates = new List<CaptureCandidate>();

            if (_options.File != null)
            {
                string path = Path.GetFullPath(_options.File);
                candidates.Add(new CaptureCandidate("file", null, null, null, path, path));
                return candidates;
            }

            // macOS captures stay in memory (`wfinfo-mac capture -`): no temp folder.
            if (OperatingSystem.IsMacOS())
            {
                if (!string.IsNullOrEmpty(_options.Window))
                {
                    candidates.Add(new CaptureCandidate(
                        "memory", null, null, _options.Window, null,
                        "window " + _options.Window));
                    return candidates;
                }

                List<string> displays = string.IsNullOrEmpty(_options.Output)
                    ? ScreenCapture.ListOutputs()
                    : new List<string> { _options.Output };
                if (displays.Count == 0) displays.Add(null);
                foreach (string display in displays)
                {
                    candidates.Add(new CaptureCandidate(
                        "memory", display, null, null, null,
                        "display " + (display ?? "main")));
                }
                return candidates;
            }

            string directory = Path.Combine(Path.GetTempPath(), "wfinfo-scan-" + Environment.ProcessId);
            Directory.CreateDirectory(directory);

            if (!string.IsNullOrEmpty(_options.Window))
                throw new ArgumentException("--window is a macOS window id; on Linux use --region \"X,Y WxH\"");

            if (!string.IsNullOrEmpty(_options.Region))
            {
                candidates.Add(new CaptureCandidate(
                    "capture", null, _options.Region, null,
                    Path.Combine(directory, "region-" + SafeName(_options.Region) + ".png"),
                    _options.Region));
                return candidates;
            }

            if (!string.IsNullOrEmpty(_options.Output))
            {
                candidates.Add(new CaptureCandidate(
                    "capture", _options.Output, null, null,
                    Path.Combine(directory, SafeName(_options.Output) + ".png"),
                    _options.Output));
                return candidates;
            }

            foreach (string output in ScreenCapture.ListOutputs())
            {
                candidates.Add(new CaptureCandidate(
                    "capture", output, null, null,
                    Path.Combine(directory, SafeName(output) + ".png"),
                    output));
            }

            candidates.Add(new CaptureCandidate(
                "capture", null, null, null, Path.Combine(directory, "all-outputs.png"), "all"));
            return candidates;
        }

        /// <summary>Prices every part concurrently: cache hits answer instantly, misses fetch in parallel.</summary>
        private async Task<List<ScanChoice>> PriceChoicesAsync(List<string> parts)
        {
            var timeToLive = TimeSpan.FromHours(_options.TtlHours);
            var entries = parts.Select(part => _sheet.Lookup(part)).ToList();
            var lookups = entries
                .Select(entry => entry.Slug == null
                    ? Task.FromResult<PriceQuote>(null)
                    : _cache.ResolveAsync(entry.Slug, timeToLive, _options.Refresh))
                .ToArray();

            PriceQuote[] quotes = await Task.WhenAll(lookups).ConfigureAwait(false);

            var choices = new List<ScanChoice>();
            for (int i = 0; i < parts.Count; i++)
            {
                SheetEntry entry = entries[i];
                PriceQuote quote = quotes[i];

                var choice = new ScanChoice
                {
                    Index = i + 1,
                    Part = parts[i],
                    Slug = entry.Slug,
                    Ducats = entry.Ducats,
                };

                if (quote != null)
                {
                    choice.Plat = quote.Plat;
                    choice.PlatSource = quote.Source;
                    choice.PlatFetchedAt = ScanPaths.Iso(quote.FetchedAtUtc);
                    choice.Volume = quote.Volume;
                }
                else if (entry.Plat != null)
                {
                    choice.Plat = entry.Plat;
                    choice.PlatSource = ScanChoice.SourceSheet;
                    choice.Volume = entry.Volume;
                }
                else
                {
                    choice.PlatSource = ScanChoice.SourceNone;
                }

                choices.Add(choice);
            }
            return choices;
        }

        /// <summary>
        /// OCRs the reward strip on one screenshot.
        ///
        /// The theme probe samples a single pixel column, so it misses when the UI
        /// scale differs, the capture is cropped, or the theme is new; the row
        /// filter then rejects every row and nothing is recognised. A failed
        /// attempt therefore retries once per theme before giving up. `--theme`
        /// pins the theme and skips the probe (and the retries).
        /// </summary>
        private List<string> RecognizeParts(Bitmap image, out string themeUsed, out double themeWeight)
        {
            WFtheme detected = OCR.GetThemeWeighted(out themeWeight, image);
            themeUsed = detected.ToString();

            if (_options.Theme != null && _options.Theme != WFtheme.AUTO)
            {
                themeUsed = _options.Theme.Value.ToString();
                _settings.ThemeSelection = _options.Theme.Value;
                List<string> pinned = ExtractParts(image);
                _settings.ThemeSelection = WFtheme.AUTO;
                return pinned;
            }

            List<string> parts = ExtractParts(image);
            if (parts.Count > 0) return parts;

            foreach (WFtheme theme in ScanOptions.ThemeCandidates())
            {
                if (theme == detected) continue;

                _settings.ThemeSelection = theme;
                List<string> attempt = ExtractParts(image);
                if (attempt.Count > 0)
                {
                    themeUsed = theme.ToString();
                    parts = attempt;
                    break;
                }
            }

            _settings.ThemeSelection = WFtheme.AUTO;
            return parts;
        }

        private List<string> ExtractParts(Bitmap image)
        {
            try
            {
                return OCR.ProcessRewardScreenForTest(image, _window) ?? new List<string>();
            }
            catch (Exception ex)
            {
                Main.AddLog("Reward extraction failed: " + ex);
                return new List<string>();
            }
        }

        /// <summary>
        /// Flags the best platinum choice. Ties go to the higher ducat value and
        /// then to the later choice, matching WFInfo's Windows overlay ranking
        /// (WFInfo/Ocr.cs, the bestPlat/bestDucat loop).
        /// </summary>
        private static void SetRecommendations(ScanResult result)
        {
            ScanChoice bestPlat = null;
            ScanChoice bestDucats = null;

            foreach (ScanChoice choice in result.Choices)
            {
                if (choice.Plat != null && choice.Plat > 0)
                {
                    bool better = bestPlat == null
                        || choice.Plat > bestPlat.Plat
                        || (choice.Plat == bestPlat.Plat && (choice.Ducats ?? 0) >= (bestPlat.Ducats ?? 0));
                    if (better) bestPlat = choice;
                }

                if (choice.Ducats != null && (bestDucats == null || choice.Ducats >= bestDucats.Ducats))
                    bestDucats = choice;
            }

            if (bestPlat != null)
            {
                bestPlat.Best = true;
                result.Best = new ScanBest
                {
                    Index = bestPlat.Index,
                    Part = bestPlat.Part,
                    Plat = bestPlat.Plat.Value,
                };
            }

            if (bestDucats != null)
            {
                result.BestDucats = new ScanBestDucats
                {
                    Index = bestDucats.Index,
                    Part = bestDucats.Part,
                    Ducats = bestDucats.Ducats.Value,
                };
            }
        }

        /// <summary>Keeps the OCR'd screenshot next to the scan records for the dashboard.</summary>
        private string StoreScreenshot(string sourcePath)
        {
            try
            {
                if (string.IsNullOrEmpty(sourcePath) || !File.Exists(sourcePath)) return null;
                if (string.Equals(Path.GetFullPath(sourcePath), Path.GetFullPath(ScanPaths.ScreenshotPng), StringComparison.Ordinal))
                    return ScanPaths.ScreenshotPng;

                File.Copy(sourcePath, _publisher.PendingScreenshot, overwrite: true);
                return ScanPaths.ScreenshotPng;
            }
            catch (Exception ex)
            {
                Main.AddLog("Failed to store the scan screenshot: " + ex.Message);
                return null;
            }
        }

        /// <summary>Writes an in-memory capture as the dashboard's scan screenshot.</summary>
        private string StorePng(byte[] png)
        {
            try
            {
                File.WriteAllBytes(_publisher.PendingScreenshot, png);
                return ScanPaths.ScreenshotPng;
            }
            catch (Exception ex)
            {
                Main.AddLog("Failed to store the scan screenshot: " + ex.Message);
                return null;
            }
        }

        /// <summary>
        /// Publishes the record (see <see cref="ScanPublisher"/>: the atomic
        /// last.png + latest.json pair, the history file, and the keep-last-good
        /// rule). Returns the record latest.json now holds, or null when the
        /// publish failed.
        /// </summary>
        private ScanResult Persist(ScanResult result, out bool keptPrevious)
        {
            try
            {
                ScanResult published = _publisher.Publish(result, DateTime.Now, out keptPrevious);
                Main.AddLog("Scan persisted to: " + ScanPaths.ScansDir);
                return published;
            }
            catch (Exception ex)
            {
                Main.AddLog("Failed to persist the scan: " + ex.Message);
                TryDelete(_publisher.PendingRecord);
                TryDelete(_publisher.PendingScreenshot);
                keptPrevious = false;
                return null;
            }
        }

        private static void SendNotification(ScanResult result)
        {
            string summary;
            string body;

            if (result.Choices.Count == 0)
            {
                summary = string.IsNullOrEmpty(result.Error) ? "No reward screen found" : "Scan failed";
                body = string.IsNullOrEmpty(result.Error)
                    ? $"Nothing was recognized on {result.CaptureTarget} — open the reward screen and press the scan hotkey."
                    : result.Error;
            }
            else
            {
                var lines = new List<string>();
                foreach (ScanChoice choice in result.Choices)
                {
                    string value = choice.Plat == null ? "no price" : FormatPlat(choice.Plat.Value) + "p";
                    string ducats = choice.Ducats == null ? string.Empty : $" · {choice.Ducats}d";
                    lines.Add($"{(choice.Best ? "★" : "  ")} {choice.Index}. {choice.Part} — {value}{ducats}");
                }

                if (result.Best == null)
                {
                    summary = "No price for this reward screen";
                }
                else
                {
                    summary = $"Take {result.Best.Part} — {FormatPlat(result.Best.Plat)}p";
                }

                if (result.BestDucats != null && (result.Best == null || result.BestDucats.Index != result.Best.Index))
                    lines.Add($"most ducats: {result.BestDucats.Part} ({result.BestDucats.Ducats}d)");

                body = string.Join("\n", lines);
            }

            Notifier.Send(summary, body);
        }

        private static void Print(ScanResult result)
        {
            Console.WriteLine(result.Stage == StageFast || result.Stage == StageDeep
                ? $"Warframe Info — reward screen scan ({result.Stage} pass)"
                : "Warframe Info — reward screen scan");
            Console.WriteLine($"  started:  {result.StartedAt} ({result.DurationMs} ms)");

            if (result.ScreenshotWidth > 0)
            {
                Console.WriteLine(
                    $"  capture:  {result.CaptureSource} {result.CaptureTarget} " +
                    $"({result.ScreenshotWidth}x{result.ScreenshotHeight}, ui scale {result.UiScaling:F2})");
            }

            if (result.Choices.Count == 0)
            {
                Console.WriteLine($"  no choices: {result.Error ?? "no reward screen detected"}" +
                    (result.ErrorCode == null ? string.Empty : $" [{result.ErrorCode} {result.ErrorName}]"));
            }
            else
            {
                foreach (ScanChoice choice in result.Choices)
                {
                    string plat = (choice.Plat == null ? "-" : FormatPlat(choice.Plat.Value)).PadLeft(7);
                    string ducats = (choice.Ducats == null ? "-" : choice.Ducats.Value.ToString(CultureInfo.InvariantCulture)).PadLeft(4);
                    Console.WriteLine($"  {(choice.Best ? "*" : " ")} {choice.Index}. {choice.Part,-34} {plat}p {ducats}d  ({choice.PlatSource})");
                }

                Console.WriteLine(
                    $"  price cache: {result.PriceCache.Hits} hit, {result.PriceCache.Fetched} fetched, " +
                    $"{result.PriceCache.Failed} failed, {result.PriceCache.Entries} entries");

                if (result.Best != null)
                    Console.WriteLine($"  TAKE: {result.Best.Part} — {FormatPlat(result.Best.Plat)}p");
            }

            Console.WriteLine($"  saved:    {ScanPaths.LatestScan}");
        }

        private static Bitmap TryLoad(string path, out string error)
        {
            try
            {
                if (string.IsNullOrEmpty(path) || !File.Exists(path))
                {
                    error = "screenshot not found: " + path;
                    return null;
                }
                error = null;
                return new Bitmap(path);
            }
            catch (Exception ex)
            {
                error = $"cannot read screenshot {path}: {ex.Message}";
                return null;
            }
        }

        /// <summary>
        /// Decodes a PNG held in memory. GDI+ needs the source stream for the
        /// bitmap's lifetime, so the image is copied into a stand-alone bitmap.
        /// </summary>
        private static Bitmap TryLoadPng(byte[] png, string label, out string error)
        {
            try
            {
                using (var stream = new MemoryStream(png))
                using (var decoded = new Bitmap(stream))
                {
                    error = null;
                    return new Bitmap(decoded);
                }
            }
            catch (Exception ex)
            {
                error = $"cannot read the capture of {label}: {ex.Message}";
                return null;
            }
        }

        private static string FormatPlat(double plat) =>
            plat.ToString("0.#", CultureInfo.InvariantCulture);

        private static string SafeName(string value) =>
            new string(value.Select(c => char.IsLetterOrDigit(c) ? c : '_').ToArray());

        private static void TryDelete(string path)
        {
            try
            {
                if (!string.IsNullOrEmpty(path) && File.Exists(path)) File.Delete(path);
            }
            catch
            {
                // temp files are best-effort
            }
        }

        /// <summary>Removes the per-run capture directory (files are already gone).</summary>
        private static void CleanTempDirectory()
        {
            try
            {
                string directory = Path.Combine(Path.GetTempPath(), "wfinfo-scan-" + Environment.ProcessId);
                if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
            }
            catch
            {
                // best-effort
            }
        }

        /// <summary>The attempt a Vision pass kept, where it came from, and the last failure.</summary>
        private sealed class Selection
        {
            public VisionRewardScan.Attempt Accepted { get; set; }
            public string Target { get; set; }

            /// <summary>The --file path when the candidate was a file, else null.</summary>
            public string File { get; set; }

            /// <summary>The newest failed attempt, or null.</summary>
            public VisionRewardScan.Attempt LastFailed { get; set; }
        }

        private readonly struct CaptureCandidate
        {
            public CaptureCandidate(string kind, string output, string region, string window, string path, string label)
            {
                Kind = kind;
                Output = output;
                Region = region;
                Window = window;
                Path = path;
                Label = label;
            }

            /// <summary>"capture" (grim to a temp file), "memory" (macOS, PNG through a pipe) or "file" (already on disk).</summary>
            public string Kind { get; }

            /// <summary>grim -o output name, or a macOS display id; null means the whole layout (main display on macOS).</summary>
            public string Output { get; }

            /// <summary>macOS window id (CGWindowID); null means a display capture.</summary>
            public string Window { get; }

            /// <summary>grim -g region ("X,Y WxH"); null means an output capture.</summary>
            public string Region { get; }

            /// <summary>PNG to capture into, or the file to read.</summary>
            public string Path { get; }

            /// <summary>What the scan record reports as the capture target.</summary>
            public string Label { get; }
        }
    }
}
