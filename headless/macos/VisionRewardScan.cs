using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using WFInfo.Errors;

namespace WFInfo.MacOS
{
    /// <summary>
    /// The macOS reward scan ("vision-layout"). It replaces WFInfo's
    /// System.Drawing extraction (theme colour filter + part boxes) on macOS, so
    /// libgdiplus is never loaded. There is no fallback to that extraction.
    ///
    /// 1. `wfinfo-mac rewards` captures the screen (or reads a file), crops a
    ///    band around WFInfo's reward-name rows and runs Apple Vision on the raw
    ///    colour crop. Lines come back with full-image boxes.
    /// 2. The reward layout (Rust, headless/macos/layout, `libwfinfo_layout`)
    ///    keeps the lines in the name rows, groups them into reward slots and
    ///    joins wrapped names.
    /// 3. Each slot's candidates go through WFInfo's own name checks:
    ///    OCR.PartNameValid, Data.GetPartName and
    ///    OCR.GetMaxAllowedLevenshteinDistance (shared code, not copies; the
    ///    last one is private, so it is bound by reflection).
    ///
    /// The crop geometry is WFInfo's: the OCR.pixle*/pixel* constants are
    /// compile-time values, so passing them touches no image code.
    /// </summary>
    internal sealed class VisionRewardScan
    {
        /// <summary>
        /// Helper timeout per call. The first Vision call of a new helper binary
        /// prepares Apple's models (40-50 s once), so 120 s; the dashboard kills
        /// a scan at 180 s.
        /// </summary>
        private const int TimeoutMs = 120000;

        private readonly double? _uiScale;

        /// <param name="uiScale">Warframe's UI scale from EE.cfg; null = unknown (the layout estimates it).</param>
        public VisionRewardScan(double? uiScale)
        {
            _uiScale = uiScale;
            Device = (Environment.GetEnvironmentVariable("WFINFO_VISION_DEVICE") ?? "auto").Trim().ToLowerInvariant();
        }

        public string Device { get; }

        /// <summary>The configured UI scale, or null when the layout must estimate it.</summary>
        public double? ConfiguredUiScale => _uiScale;

        /// <summary>
        /// The UI scale the last accurate pass estimated (rounded to 0.05), or
        /// null. With an unknown UI scale the fast pass of the next watch scan
        /// reads at this scale.
        /// </summary>
        public double? LastEstimatedUiScale { get; private set; }

        public sealed class Attempt
        {
            public List<string> Parts { get; } = new List<string>();
            public string Error { get; set; }

            /// <summary>
            /// Catalog code of <see cref="Error"/>, or null when the failure has
            /// no catalog entry (then <see cref="Failure"/> holds the exception
            /// for a generated code and a crash report).
            /// </summary>
            public string ErrorCode { get; set; }

            /// <summary>The exception behind <see cref="Error"/>, or null.</summary>
            public Exception Failure { get; set; }

            public string Source { get; set; }
            public int Width { get; set; }
            public int Height { get; set; }
            public double UiScale { get; set; }
            public bool UiScaleEstimated { get; set; }
            /// <summary>Where the helper wrote the captured PNG (null for --file or on failure).</summary>
            public string SavedPng { get; set; }
            public long ElapsedMs { get; set; }

            /// <summary>True for a fast pass (Vision fast mode, no tiles).</summary>
            public bool Fast { get; set; }
        }

        /// <summary>
        /// The fast pass of an automatic scan: one capture-and-read in Vision's
        /// fast mode, without tiles, at the configured UI scale, else at the
        /// last estimated one, else over the wide range (one read, no second
        /// pass). Same capture-path rules as <see cref="Run"/>.
        /// </summary>
        public Attempt RunFast(string display, string window, string file, Func<string> nextSavePath)
        {
            var watch = Stopwatch.StartNew();
            double? scale = _uiScale ?? LastEstimatedUiScale;
            Attempt attempt = RunOnce(display, window, file, NextPath(file, nextSavePath), scale, fast: true);
            attempt.Fast = true;
            attempt.UiScaleEstimated = !_uiScale.HasValue;
            attempt.ElapsedMs = watch.ElapsedMilliseconds;
            return attempt;
        }

        /// <summary>
        /// One capture-and-read. Exactly one of <paramref name="file"/>,
        /// <paramref name="window"/>, <paramref name="display"/> is used (in that
        /// order; none = main display). <paramref name="nextSavePath"/> gives a
        /// new, unique PNG path for each helper call (ignored for a file). Only
        /// the returned attempt keeps its capture (<see cref="Attempt.SavedPng"/>);
        /// the capture of a failed or losing pass is deleted here.
        /// </summary>
        public Attempt Run(string display, string window, string file, Func<string> nextSavePath)
        {
            var watch = Stopwatch.StartNew();
            Attempt first = RunOnce(display, window, file, NextPath(file, nextSavePath), _uiScale, fast: false);
            if (_uiScale.HasValue || first.Error != null)
            {
                first.ElapsedMs = watch.ElapsedMilliseconds;
                return first;
            }

            // Unknown UI scale: the first pass reads a wide band (UI scale
            // 0.5-1.25) and the layout estimates the scale. Vision misses or
            // merges names in such a wide crop more often (synthetic 2560x1440
            // screens at 80 %), so read again with the exact crop for the
            // estimate and keep the pass that found more parts.
            double estimate = Math.Round(first.UiScale * 20) / 20;
            Attempt second = RunOnce(display, window, file, NextPath(file, nextSavePath), estimate, fast: false);
            Attempt best = second.Error == null && second.Parts.Count >= first.Parts.Count ? second : first;
            Attempt loser = ReferenceEquals(best, first) ? second : first;
            DeleteCapture(loser.SavedPng);
            loser.SavedPng = null;
            best.UiScaleEstimated = true;
            best.ElapsedMs = watch.ElapsedMilliseconds;
            if (best.Error == null && best.UiScale > 0) LastEstimatedUiScale = Math.Round(best.UiScale * 20) / 20;
            return best;
        }

        private static string NextPath(string file, Func<string> nextSavePath) =>
            string.IsNullOrEmpty(file) ? nextSavePath?.Invoke() : null;

        /// <summary>Deletes a helper capture; best-effort.</summary>
        internal static void DeleteCapture(string path)
        {
            try
            {
                if (!string.IsNullOrEmpty(path) && System.IO.File.Exists(path)) System.IO.File.Delete(path);
            }
            catch (Exception ex) when (ex is System.IO.IOException || ex is UnauthorizedAccessException)
            {
                // a stray capture is harmless; the next scan uses a new name
            }
        }

        private Attempt RunOnce(string display, string window, string file, string savePath, double? uiScale, bool fast)
        {
            var attempt = new Attempt();
            var arguments = new List<string> { "rewards" };
            if (fast) arguments.Add("--fast");
            if (!string.IsNullOrEmpty(file))
            {
                arguments.Add("--file");
                arguments.Add(file);
            }
            else
            {
                if (!string.IsNullOrEmpty(window))
                {
                    arguments.Add("--window");
                    arguments.Add(window);
                }
                else if (!string.IsNullOrEmpty(display))
                {
                    arguments.Add("--display");
                    arguments.Add(display);
                }
                if (!string.IsNullOrEmpty(savePath))
                {
                    arguments.Add("--save");
                    arguments.Add(savePath);
                }
            }

            int lineHeight = OCR.pixelRewardLineHeight;
            arguments.AddRange(new[]
            {
                "--reward-width", OCR.pixleRewardWidth.ToString(System.Globalization.CultureInfo.InvariantCulture),
                "--reward-height", OCR.pixleRewardHeight.ToString(System.Globalization.CultureInfo.InvariantCulture),
                "--reward-y", OCR.pixleRewardYDisplay.ToString(System.Globalization.CultureInfo.InvariantCulture),
                "--line-height", lineHeight.ToString(System.Globalization.CultureInfo.InvariantCulture),
                "--device", Device,
            });
            if (uiScale.HasValue)
            {
                arguments.Add("--ui-scale");
                arguments.Add(uiScale.Value.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture));
            }
            else
            {
                arguments.AddRange(new[] { "--ui-scale-min", "0.5", "--ui-scale-max", "1.25" });
            }

            JToken answer;
            try
            {
                answer = MacHelper.Run(arguments, TimeoutMs);
            }
            catch (InvalidOperationException ex)
            {
                attempt.Error = ex.Message;
                attempt.ErrorCode = HelperErrorCode(ex);
                attempt.Failure = ex;
                DeleteCapture(savePath); // the helper may have saved before it failed
                return attempt;
            }

            attempt.Source = answer["source"]?.ToString();
            attempt.Width = answer["width"]?.Value<int>() ?? 0;
            attempt.Height = answer["height"]?.Value<int>() ?? 0;
            attempt.SavedPng = answer["saved"]?.Type == JTokenType.String ? answer["saved"].ToString() : null;
            if (attempt.SavedPng != savePath) DeleteCapture(savePath); // never leave an untracked file

            JObject layout;
            try
            {
                layout = Layout(answer, lineHeight);
            }
            catch (Exception ex) when (ex is DllNotFoundException || ex is EntryPointNotFoundException || ex is JsonException)
            {
                attempt.Error = "reward layout library: " + ex.Message +
                    " (build headless/WFInfo.Headless.csproj on macOS; it builds headless/macos/layout with cargo)";
                attempt.ErrorCode = ex is JsonException ? LayoutFailedCode : LayoutMissingCode;
                attempt.Failure = ex;
                return attempt;
            }
            if (layout["error"] != null && layout["error"].Type != JTokenType.Null)
            {
                (string code, string message) = LayoutError(layout["error"]);
                attempt.Error = "reward layout: " + message;
                attempt.ErrorCode = code;
                return attempt;
            }

            attempt.UiScale = layout["uiScale"]?.Value<double>() ?? 0;
            attempt.UiScaleEstimated = layout["uiScaleEstimated"]?.Value<bool>() ?? false;
            foreach (JToken note in layout["notes"] as JArray ?? new JArray())
                Main.AddLog("Reward layout: " + note);

            foreach (JToken slot in layout["slots"] as JArray ?? new JArray())
            {
                string name = MatchSlot(slot["candidates"]?.Values<string>() ?? Array.Empty<string>());
                if (name != null) attempt.Parts.Add(name);
            }

            return attempt;
        }

        /// <summary>Catalog code: the layout library is not next to the runner.</summary>
        internal const string LayoutMissingCode = "SYS-005";

        /// <summary>Catalog code: the layout library returned an error.</summary>
        internal const string LayoutFailedCode = "LAY-002";

        private static readonly Regex LeadingCode = new Regex(
            @"^\s*(?:wfinfo-mac:\s*)?\[?([A-Z]{3}-\d{3})(?![0-9])",
            RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));

        /// <summary>
        /// The catalog code of a helper failure: a <see cref="ScanFailure"/>'s
        /// code, else a known code at the start of the helper's error text
        /// ("CAP-001 ...", "CAP-001: ..." or "[CAP-001] ..."), else null.
        /// </summary>
        internal static string HelperErrorCode(Exception error)
        {
            if (error is ScanFailure failure && ErrorCatalog.Get(failure.Code) != null) return failure.Code;
            Match match;
            try
            {
                match = LeadingCode.Match(error?.Message ?? string.Empty);
            }
            catch (RegexMatchTimeoutException)
            {
                return null;
            }
            return match.Success && ErrorCatalog.Get(match.Groups[1].Value) != null ? match.Groups[1].Value : null;
        }

        /// <summary>
        /// The layout library's error: {"code":"LAY-00x","message":...} or a
        /// plain string (older builds). An unknown or missing code becomes LAY-002.
        /// </summary>
        internal static (string Code, string Message) LayoutError(JToken error)
        {
            if (error is JObject detail)
            {
                string code = detail["code"]?.Type == JTokenType.String ? detail["code"].ToString() : null;
                string message = detail["message"]?.ToString() ?? detail.ToString(Formatting.None);
                return (ErrorCatalog.Get(code) != null ? code : LayoutFailedCode, message);
            }
            return (LayoutFailedCode, error?.ToString() ?? string.Empty);
        }

        [DllImport("wfinfo_layout", EntryPoint = "wfinfo_layout")]
        [DefaultDllImportSearchPaths(DllImportSearchPath.AssemblyDirectory)]
        private static extern IntPtr NativeLayout(byte[] jsonUtf8);

        [DllImport("wfinfo_layout", EntryPoint = "wfinfo_layout_free")]
        [DefaultDllImportSearchPaths(DllImportSearchPath.AssemblyDirectory)]
        private static extern void NativeLayoutFree(IntPtr text);

        /// <summary>
        /// Runs the Rust reward layout (libwfinfo_layout.dylib next to the
        /// runner): helper JSON + WFInfo's layout constants in, slots out, both
        /// as UTF-8 JSON. The library owns the returned string until it is freed.
        /// </summary>
        private static JObject Layout(JToken helperJson, int lineHeight)
        {
            var input = new JObject
            {
                ["helper"] = helperJson,
                ["rewardWidth"] = OCR.pixleRewardWidth,
                ["rewardHeight"] = OCR.pixleRewardHeight,
                ["rewardY"] = OCR.pixleRewardYDisplay,
                ["lineHeight"] = lineHeight,
            };
            byte[] bytes = Encoding.UTF8.GetBytes(input.ToString(Formatting.None) + "\0");
            IntPtr result = NativeLayout(bytes);
            if (result == IntPtr.Zero) throw new JsonException("the layout library returned nothing");
            try
            {
                return JObject.Parse(Marshal.PtrToStringUTF8(result) ?? "{}");
            }
            finally
            {
                NativeLayoutFree(result);
            }
        }

        /// <summary>
        /// WFInfo's own locale-aware distance threshold
        /// (OCR.GetMaxAllowedLevenshteinDistance). It is private in the shared
        /// code, and the macOS port does not change shared files, so it is
        /// called by reflection instead of copied; a rename fails loudly here.
        /// </summary>
        private static readonly Func<int, int> MaxDistance = BindMaxDistance();

        private static Func<int, int> BindMaxDistance()
        {
            var method = typeof(OCR).GetMethod(
                "GetMaxAllowedLevenshteinDistance",
                System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static,
                null, new[] { typeof(int) }, null);
            if (method == null || method.ReturnType != typeof(int))
                throw new InvalidOperationException(
                    "WFInfo's OCR.GetMaxAllowedLevenshteinDistance(int) is missing; update VisionRewardScan to the new name.");
            return (Func<int, int>)method.CreateDelegate(typeof(Func<int, int>));
        }

        /// <summary>
        /// The market name for one slot: the first valid candidate (best first) under
        /// WFInfo's distance threshold, or null. Same checks as WFInfo's reward
        /// pipeline (OCR.ProcessRewardScreenForTest).
        /// </summary>
        private static string MatchSlot(IEnumerable<string> candidates)
        {
            // Candidates come best first: the whole name (wrapped lines
            // joined), then shorter prefixes. Take the first one that matches
            // within WFInfo's threshold. Picking the lowest distance over all
            // of them instead lets a short prefix ("AKSTILETTO PRIME") beat the
            // whole name, because a short text is close to many items.
            foreach (string candidate in candidates)
            {
                if (string.IsNullOrWhiteSpace(candidate) || !OCR.PartNameValid(candidate)) continue;
                string name = Main.dataBase.GetPartName(candidate, out int distance, true, out _);
                if (distance == 9999 || string.IsNullOrEmpty(name)) continue;
                if (distance > MaxDistance(candidate.Length)) continue;
                return name;
            }
            return null;
        }
    }
}
