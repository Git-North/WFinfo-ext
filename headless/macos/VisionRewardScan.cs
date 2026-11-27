using System;
using System.Collections.Generic;
using System.Diagnostics;
using Newtonsoft.Json.Linq;

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
    /// 2. <see cref="RewardLayout"/> keeps the lines in the name rows, groups
    ///    them into reward slots and joins wrapped names.
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

        public sealed class Attempt
        {
            public List<string> Parts { get; } = new List<string>();
            public string Error { get; set; }
            public string Source { get; set; }
            public int Width { get; set; }
            public int Height { get; set; }
            public double UiScale { get; set; }
            public bool UiScaleEstimated { get; set; }
            /// <summary>Where the helper wrote the captured PNG (null for --file or on failure).</summary>
            public string SavedPng { get; set; }
            public long ElapsedMs { get; set; }
        }

        /// <summary>
        /// One capture-and-read. Exactly one of <paramref name="file"/>,
        /// <paramref name="window"/>, <paramref name="display"/> is used (in that
        /// order; none = main display). <paramref name="savePath"/> receives the
        /// capture as PNG (ignored for a file).
        /// </summary>
        public Attempt Run(string display, string window, string file, string savePath)
        {
            var watch = Stopwatch.StartNew();
            Attempt first = RunOnce(display, window, file, savePath, _uiScale);
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
            Attempt second = RunOnce(display, window, file, savePath, estimate);
            Attempt best = second.Error == null && second.Parts.Count >= first.Parts.Count ? second : first;
            best.UiScaleEstimated = true;
            best.ElapsedMs = watch.ElapsedMilliseconds;
            return best;
        }

        private Attempt RunOnce(string display, string window, string file, string savePath, double? uiScale)
        {
            var attempt = new Attempt();
            var arguments = new List<string> { "rewards" };
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
                return attempt;
            }

            attempt.Source = answer["source"]?.ToString();
            attempt.Width = answer["width"]?.Value<int>() ?? 0;
            attempt.Height = answer["height"]?.Value<int>() ?? 0;
            attempt.SavedPng = answer["saved"]?.Type == JTokenType.String ? answer["saved"].ToString() : null;

            RewardLayoutResult layout = RewardLayout.Analyze(
                answer, OCR.pixleRewardWidth, OCR.pixleRewardHeight, OCR.pixleRewardYDisplay, lineHeight);
            attempt.UiScale = layout.UiScale;
            attempt.UiScaleEstimated = layout.UiScaleEstimated;
            foreach (string note in layout.Notes) Main.AddLog("Reward layout: " + note);

            foreach (RewardSlot slot in layout.Slots)
            {
                string name = MatchSlot(slot);
                if (name != null) attempt.Parts.Add(name);
            }

            return attempt;
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
        /// The market name for one slot: the closest valid candidate under
        /// WFInfo's distance threshold, or null. Same checks as WFInfo's reward
        /// pipeline (OCR.ProcessRewardScreenForTest).
        /// </summary>
        private static string MatchSlot(RewardSlot slot)
        {
            string best = null;
            int bestDistance = int.MaxValue;
            foreach (string candidate in slot.Candidates)
            {
                if (string.IsNullOrWhiteSpace(candidate) || !OCR.PartNameValid(candidate)) continue;
                string name = Main.dataBase.GetPartName(candidate, out int distance, true, out _);
                if (distance == 9999 || string.IsNullOrEmpty(name)) continue;
                if (distance > MaxDistance(candidate.Length)) continue;
                if (distance < bestDistance)
                {
                    best = name;
                    bestDistance = distance;
                }
            }
            return best;
        }
    }
}
