using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Newtonsoft.Json;
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

        /// <summary>Run files kept next to latest.json (mirrors the OCR-suite retention).</summary>
        private const int RetentionFiles = 60;

        /// <summary>Pause between captures while a triggered scan waits for the panel.</summary>
        private const int CaptureRetryIntervalMs = 400;

        private readonly ScanOptions _options;
        private readonly IWindowInfoService _window;
        private readonly MarketSheet _sheet;
        private readonly PriceCache _cache;
        private readonly ApplicationSettings _settings;
        private readonly VisionRewardScan _visionLayout;
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

        /// <summary>Runs the scan; returns 0 when a record was produced, 1 when capture/OCR failed.</summary>
        public async Task<int> RunAsync()
        {
            DateTime startedUtc = DateTime.UtcNow;
            var watch = Stopwatch.StartNew();
            var result = new ScanResult
            {
                Version = 1,
                StartedAt = ScanPaths.Iso(startedUtc),
                CaptureSource = _options.File != null ? "file" : ScreenCapture.SourceName,
                OcrEngine = _visionLayout != null ? "vision-layout" : "tesseract",
            };

            string lastError = null;
            Bitmap acceptedImage = null;
            string acceptedPath = null;
            byte[] acceptedPng = null;
            string acceptedTarget = null;
            bool acceptedIsTemporary = false;
            var acceptedParts = new List<string>();
            string acceptedTheme = null;
            double acceptedThemeWeight = 0;

            try
            {
                Directory.CreateDirectory(ScanPaths.ScansDir);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"Cannot create {ScanPaths.ScansDir}: {ex.Message}");
                return 1;
            }

            if (_visionLayout != null) return await RunVisionLayoutAsync(result, startedUtc, watch).ConfigureAwait(false);

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
                            continue;
                        }
                    }
                    else if (candidate.Kind == "capture")
                    {
                        if (!ScreenCapture.Capture(candidate.Output, candidate.Region, candidate.Path, out string captureError))
                        {
                            lastError = captureError;
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
                result.Error = lastError ?? "no screenshot could be captured or read";
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
            return Complete(result, watch);
        }

        /// <summary>
        /// macOS scan without System.Drawing: each candidate (a file, a window,
        /// or every display, main first) is one `wfinfo-mac rewards` call that
        /// captures, crops the name rows and reads them with Vision; the layout
        /// and WFInfo's name matching run on text and boxes only. The helper
        /// writes each capture to the scans dir; the accepted one becomes
        /// scans/last.png, the others are deleted. No temporary files.
        /// </summary>
        private async Task<int> RunVisionLayoutAsync(ScanResult result, DateTime startedUtc, Stopwatch watch)
        {
            string lastError = null;
            VisionRewardScan.Attempt accepted = null;
            string acceptedTarget = null;
            string acceptedFile = null;

            DateTime attemptDeadline = startedUtc.AddSeconds(_options.WaitSeconds);
            while (true)
            {
                foreach (CaptureCandidate candidate in BuildCandidates())
                {
                    string file = candidate.Kind == "file" ? candidate.Path : null;

                    // Run deletes the capture of a failed or losing pass itself.
                    VisionRewardScan.Attempt attempt = _visionLayout.Run(candidate.Output, candidate.Window, file, NextCapturePath);
                    if (attempt.Error != null)
                    {
                        lastError = attempt.Error;
                        continue;
                    }

                    if (accepted == null || attempt.Parts.Count > accepted.Parts.Count)
                    {
                        if (accepted?.SavedPng != null) TryDelete(accepted.SavedPng);
                        accepted = attempt;
                        acceptedTarget = file ?? candidate.Label;
                        acceptedFile = file;
                    }
                    else
                    {
                        TryDelete(attempt.SavedPng);
                    }

                    if (accepted.Parts.Count >= PartsGoodEnough) break;
                }

                if (accepted != null && accepted.Parts.Count > 0) break;
                if (DateTime.UtcNow >= attemptDeadline) break;

                await Task.Delay(CaptureRetryIntervalMs).ConfigureAwait(false);
            }

            if (accepted == null)
            {
                result.Error = lastError ?? "no screenshot could be captured or read";
            }
            else
            {
                result.CaptureTarget = acceptedTarget;
                result.ScreenshotWidth = accepted.Width;
                result.ScreenshotHeight = accepted.Height;
                result.UiScaling = accepted.UiScale;
                result.Theme = null;
                result.ThemeWeight = 0;
                result.ScreenshotPath = acceptedFile != null
                    ? StoreScreenshot(acceptedFile) ?? acceptedFile
                    : MoveToScreenshot(accepted.SavedPng);
                await PriceAsync(result, accepted.Parts).ConfigureAwait(false);
            }

            return Complete(result, watch);
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

        /// <summary>Finishes the record: timing, persist, console summary, notification.</summary>
        private int Complete(ScanResult result, Stopwatch watch)
        {
            result.FinishedAt = ScanPaths.Iso(DateTime.UtcNow);
            result.DurationMs = watch.ElapsedMilliseconds;

            Persist(result);
            Print(result);

            if (_options.Notify) SendNotification(result);
            if (_options.PrintJson) Console.WriteLine(JsonConvert.SerializeObject(result, Formatting.Indented));

            return result.Error == null ? 0 : 1;
        }

        /// <summary>
        /// A new capture path for one helper call: scans/capture-&lt;pid&gt;-&lt;n&gt;.png.
        /// The process id keeps two scan processes apart; the counter keeps every
        /// call of this process apart (candidates, retries, both scale passes,
        /// and every scan of a watch).
        /// </summary>
        private string NextCapturePath() =>
            Path.Combine(ScanPaths.ScansDir, string.Format(CultureInfo.InvariantCulture,
                "capture-{0}-{1}.png", Environment.ProcessId, ++_captureCount));

        /// <summary>The helper's capture becomes scans/last.png (same directory, so a rename).</summary>
        private static string MoveToScreenshot(string savedPng)
        {
            try
            {
                if (string.IsNullOrEmpty(savedPng) || !File.Exists(savedPng)) return null;
                File.Move(savedPng, ScanPaths.ScreenshotPng, overwrite: true);
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
        private static string StoreScreenshot(string sourcePath)
        {
            try
            {
                if (string.IsNullOrEmpty(sourcePath) || !File.Exists(sourcePath)) return null;
                if (string.Equals(Path.GetFullPath(sourcePath), Path.GetFullPath(ScanPaths.ScreenshotPng), StringComparison.Ordinal))
                    return ScanPaths.ScreenshotPng;

                File.Copy(sourcePath, ScanPaths.ScreenshotPng, overwrite: true);
                return ScanPaths.ScreenshotPng;
            }
            catch (Exception ex)
            {
                Main.AddLog("Failed to store the scan screenshot: " + ex.Message);
                return null;
            }
        }

        /// <summary>Writes an in-memory capture as the dashboard's scan screenshot.</summary>
        private static string StorePng(byte[] png)
        {
            try
            {
                File.WriteAllBytes(ScanPaths.ScreenshotPng, png);
                return ScanPaths.ScreenshotPng;
            }
            catch (Exception ex)
            {
                Main.AddLog("Failed to store the scan screenshot: " + ex.Message);
                return null;
            }
        }

        /// <summary>Writes latest.json plus one timestamped record, newest 60 kept.</summary>
        private static void Persist(ScanResult result)
        {
            try
            {
                string json = JsonConvert.SerializeObject(result, Formatting.Indented);
                File.WriteAllText(ScanPaths.LatestScan, json);

                string stamp = DateTime.UtcNow.ToString("yyyyMMdd_HHmmssfff", CultureInfo.InvariantCulture);
                File.WriteAllText(Path.Combine(ScanPaths.ScansDir, "scan-" + stamp + ".json"), json);

                foreach (FileInfo old in new DirectoryInfo(ScanPaths.ScansDir).GetFiles("*.json")
                    .OrderByDescending(f => f.LastWriteTimeUtc)
                    .Skip(RetentionFiles))
                {
                    try { old.Delete(); } catch { /* keep going; the next scan retries */ }
                }

                Main.AddLog("Scan persisted to: " + ScanPaths.ScansDir);
            }
            catch (Exception ex)
            {
                Main.AddLog("Failed to persist the scan: " + ex.Message);
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
            Console.WriteLine("Warframe Info — reward screen scan");
            Console.WriteLine($"  started:  {result.StartedAt} ({result.DurationMs} ms)");

            if (result.ScreenshotWidth > 0)
            {
                Console.WriteLine(
                    $"  capture:  {result.CaptureSource} {result.CaptureTarget} " +
                    $"({result.ScreenshotWidth}x{result.ScreenshotHeight}, ui scale {result.UiScaling:F2})");
            }

            if (result.Choices.Count == 0)
            {
                Console.WriteLine($"  no choices: {result.Error ?? "no reward screen detected"}");
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
