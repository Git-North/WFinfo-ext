using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Newtonsoft.Json.Linq;

namespace WFInfo.MacOS
{
    /// <summary>A text box in full-image pixels, top-left origin.</summary>
    internal readonly record struct LayoutBox(double X, double Y, double Width, double Height)
    {
        public double Right => X + Width;
        public double Bottom => Y + Height;
        public double CenterX => X + Width / 2;
        public double CenterY => Y + Height / 2;

        public static LayoutBox Union(IEnumerable<LayoutBox> boxes)
        {
            double l = double.MaxValue, t = double.MaxValue, r = double.MinValue, b = double.MinValue;
            foreach (var x in boxes)
            {
                l = Math.Min(l, x.X); t = Math.Min(t, x.Y);
                r = Math.Max(r, x.Right); b = Math.Max(b, x.Bottom);
            }
            return l > r ? default : new LayoutBox(l, t, r - l, b - t);
        }
    }

    /// <summary>One Vision text line from <c>wfinfo-mac rewards</c>.</summary>
    internal sealed record LayoutLine(string Text, double Confidence, LayoutBox Box);

    /// <summary>One reward card: the name lines it used and the texts to try.</summary>
    internal sealed class RewardSlot
    {
        internal RewardSlot(double centerX, double gridX, IReadOnlyList<LayoutLine> lines,
            IReadOnlyList<string> candidates, IReadOnlyList<LayoutLine> otherLines)
        {
            CenterX = centerX;
            GridX = gridX;
            Lines = lines;
            Candidates = candidates ?? Array.Empty<string>();
            OtherLines = otherLines;
        }

        /// <summary>Measured horizontal centre of the name lines (pixels).</summary>
        public double CenterX { get; }

        /// <summary>Slot centre the geometry predicts for this card (pixels).</summary>
        public double GridX { get; }

        /// <summary>Name lines, top to bottom (left to right on one visual row).</summary>
        public IReadOnlyList<LayoutLine> Lines { get; }

        /// <summary>Part-name texts to try, best first. Never null; may be empty.</summary>
        public IReadOnlyList<string> Candidates { get; }

        /// <summary>Lines of this column that are not the name ("1 OWNED", squad names).</summary>
        public IReadOnlyList<LayoutLine> OtherLines { get; }
    }

    /// <summary>The score of one tried UI scale (unknown-scale estimation only).</summary>
    internal readonly record struct ScaleScore(double UiScale, double Score);

    internal sealed class RewardLayoutResult
    {
        internal RewardLayoutResult(double uiScale, bool estimated, double screenScaling,
            double rowTop, double rowBottom, IReadOnlyList<RewardSlot> slots,
            IReadOnlyList<string> notes, IReadOnlyList<ScaleScore> scores)
        {
            UiScale = uiScale;
            UiScaleEstimated = estimated;
            ScreenScaling = screenScaling;
            RowTop = rowTop;
            RowBottom = rowBottom;
            Slots = slots;
            Notes = notes;
            ScaleScores = scores;
        }

        /// <summary>The UI scale used: the known one, or the estimate.</summary>
        public double UiScale { get; }
        public bool UiScaleEstimated { get; }
        public double ScreenScaling { get; }

        /// <summary>Name-row band for <see cref="UiScale"/> (pixels, before tolerance).</summary>
        public double RowTop { get; }
        public double RowBottom { get; }

        /// <summary>Reward slots, left to right.</summary>
        public IReadOnlyList<RewardSlot> Slots { get; }
        public IReadOnlyList<string> Notes { get; }

        /// <summary>Every tried scale with its score; empty when the scale was known.</summary>
        public IReadOnlyList<ScaleScore> ScaleScores { get; }
    }

    /// <summary>
    /// Turns the Vision lines of <c>wfinfo-mac rewards</c> into one name per reward
    /// slot, with WFInfo's reward-screen geometry (1080p units, see OCR constants).
    /// For UI scale u and screen scaling s (su = s*u):
    /// <list type="bullet">
    /// <item>name rows: top = H/2 - (rewardY - rewardHeight + lineHeight)*su,
    /// bottom = H/2 - (rewardY - rewardHeight)*su;</item>
    /// <item>kept lines: vertical centre inside [top - L/4, bottom + L/4]
    /// (L = lineHeight*su), horizontal centre inside the strip
    /// (rewardWidth*su wide, centred on W/2), and at least one letter;</item>
    /// <item>slot i of n: centre W/2 + (i - (n-1)/2) * (rewardWidth/4)*su.</item>
    /// </list>
    /// Columns: lines sorted by horizontal centre; a new column starts when a line
    /// is more than half a slot from the current column's mean centre. Over four
    /// columns, the four that best fit the four-slot grid stay (the rest go in
    /// Notes). In a column, lines are grouped into visual rows (centres within half
    /// the median line height, ordered left to right), and rows join while the
    /// vertical gap is under 0.6 of the median line height of all kept lines. The
    /// name is the first such group with a row centre inside [top, bottom]: groups
    /// above it are header text ("1 OWNED"), groups below it are squad names. If no
    /// group lies in the rows, the top-most group is the name. Text is never
    /// invented; a slot's candidates are the joined name rows, then shorter row
    /// prefixes (for a wrapped name: all rows, then the first row).
    /// </summary>
    internal static class RewardLayout
    {
        private const double ScaleStep = 0.05;
        private const double DefaultScaleMin = 0.5;
        private const double DefaultScaleMax = 1.25;
        private const int MaxSlots = 4;

        /// <summary>
        /// Analyzes the helper JSON. Pass the OCR constants:
        /// <c>OCR.pixleRewardWidth, OCR.pixleRewardHeight, OCR.pixleRewardYDisplay</c> and
        /// the line height (<c>OCR.pixelRewardLineHeight</c>, 58 for CJK).
        /// <para>
        /// Unknown UI scale (uiScaleMin != uiScaleMax): every u from uiScaleMin to
        /// uiScaleMax in 0.05 steps is tried with the full analysis above, and scored
        /// <c>score(u) = rowLines + Σ align + Σ vfit + heightFit</c>, where
        /// rowLines = name lines whose centre lies inside [top, bottom] (no tolerance);
        /// align (per slot, 0..1) = 1 - |CenterX - gridX(u)| / (slot width/2), with the
        /// grid for as many slots as were found; vfit (per slot, 0..1) = 1 - |first
        /// name row centre - expected| / (L/2), expected = top + (4 + 17/2)/48 * L
        /// (WFInfo names sit at the top of the rows, glyphs about 17/48 of L tall);
        /// heightFit (0..1) = mean over name lines of 1 - |h - 17/48*L| / (17/96*L).
        /// The highest score wins; scores within 1e-9 count as a tie, and a tie goes
        /// to the u nearest 1.0. No lines at all gives the u nearest 1.0.
        /// Limit: the alignment term assumes every card produced a name; a card that
        /// Vision missed skews the estimate (a known scale has no such limit).
        /// </para>
        /// </summary>
        public static RewardLayoutResult Analyze(JToken helperJson, int rewardWidth, int rewardHeight,
            int rewardY, int lineHeight)
        {
            var notes = new List<string>();
            var geo = new Geometry(rewardWidth, rewardHeight, rewardY, lineHeight);

            if (helperJson == null)
            {
                notes.Add("no helper JSON");
                return new RewardLayoutResult(NearestToOne(DefaultScaleMin, DefaultScaleMax), true, 0, 0, 0,
                    Array.Empty<RewardSlot>(), notes, Array.Empty<ScaleScore>());
            }

            double w = Num(helperJson["width"]) ?? 0;
            double h = Num(helperJson["height"]) ?? 0;
            string error = helperJson["error"]?.Type == JTokenType.String ? (string)helperJson["error"] : null;
            if (!string.IsNullOrWhiteSpace(error)) notes.Add("helper error: " + error);

            double a = Num(helperJson["uiScaleMin"]) ?? DefaultScaleMin;
            double b = Num(helperJson["uiScaleMax"]) ?? DefaultScaleMax;
            if (!(a > 0)) a = DefaultScaleMin;
            if (!(b > 0)) b = DefaultScaleMax;
            if (a > b) (a, b) = (b, a);
            bool known = Math.Abs(a - b) < 1e-9;

            if (!(w > 0) || !(h > 0))
            {
                notes.Add("no image size in the helper JSON");
                double u0 = known ? a : NearestToOne(a, b);
                return new RewardLayoutResult(u0, !known, 0, 0, 0, Array.Empty<RewardSlot>(), notes,
                    Array.Empty<ScaleScore>());
            }

            double s = Num(helperJson["screenScaling"]) ?? 0;
            if (!(s > 0)) s = Math.Min(w / 1920.0, h / 1080.0);

            var all = ParseLines(helperJson["lines"]);
            var lines = all.Where(l => l.Text.Any(char.IsLetter)).ToList();
            int noLetters = all.Count - lines.Count;
            if (noLetters > 0) notes.Add($"{noLetters} line(s) without letters dropped");

            double u;
            var scores = new List<ScaleScore>();
            if (known)
            {
                u = a;
            }
            else
            {
                int steps = (int)Math.Floor((b - a) / ScaleStep + 1e-6);
                var tried = new List<double>();
                for (int k = 0; k <= steps; k++) tried.Add(Math.Round(a + k * ScaleStep, 4));
                if (b - tried[tried.Count - 1] > 1e-6) tried.Add(b);

                foreach (double t in tried)
                    scores.Add(new ScaleScore(t, Evaluate(lines, w, h, s, t, geo, null).Score));

                double best = scores.Max(x => x.Score);
                u = scores.Where(x => x.Score >= best - 1e-9)
                    .OrderBy(x => Math.Abs(x.UiScale - 1.0)).ThenBy(x => x.UiScale)
                    .First().UiScale;
                notes.Add(string.Format(CultureInfo.InvariantCulture,
                    "ui scale estimated {0:0.00} (range {1:0.00}-{2:0.00}, score {3:0.###})", u, a, b, best));
            }

            var final = Evaluate(lines, w, h, s, u, geo, notes);
            return new RewardLayoutResult(u, !known, s, final.Top, final.Bottom, final.Slots, notes, scores);
        }

        private sealed class Geometry
        {
            public Geometry(int width, int height, int y, int line)
            {
                StripWidth = width;
                RowTopOffset = y - height + line;
                RowBottomOffset = y - height;
                LineHeight = line;
                SlotWidth = width / (double)MaxSlots;
                GlyphHeight = line * 17.0 / 48.0;
                NameTopOffset = line * 4.0 / 48.0;
            }

            public double StripWidth, RowTopOffset, RowBottomOffset, LineHeight, SlotWidth, GlyphHeight, NameTopOffset;
        }

        private sealed class Evaluation
        {
            public double Top, Bottom, Score;
            public List<RewardSlot> Slots = new List<RewardSlot>();
        }

        private sealed class Row
        {
            public List<LayoutLine> Lines;
            public LayoutBox Box;
            public string Text;
        }

        /// <summary>Runs the full analysis for one UI scale. notes == null: scoring only.</summary>
        private static Evaluation Evaluate(List<LayoutLine> lines, double w, double h, double s, double u,
            Geometry geo, List<string> notes)
        {
            double su = s * u;
            double lh = geo.LineHeight * su;
            var ev = new Evaluation
            {
                Top = h / 2 - geo.RowTopOffset * su,
                Bottom = h / 2 - geo.RowBottomOffset * su,
            };
            double tol = 0.25 * lh;
            double slotW = geo.SlotWidth * su;
            double cx0 = w / 2;
            double stripHalf = geo.StripWidth * su / 2;

            var inBand = lines.Where(l => l.Box.CenterY >= ev.Top - tol && l.Box.CenterY <= ev.Bottom + tol).ToList();
            var kept = inBand.Where(l => Math.Abs(l.Box.CenterX - cx0) <= stripHalf).ToList();
            if (notes != null && kept.Count < inBand.Count)
                notes.Add("outside the reward strip, ignored: " +
                          string.Join(", ", inBand.Except(kept).Select(l => Quote(l.Text))));
            if (kept.Count == 0) return ev;

            double medianH = Median(kept.Select(l => l.Box.Height));

            // Columns by horizontal centre.
            var columns = new List<List<LayoutLine>>();
            double colCentre = double.NaN;
            foreach (var line in kept.OrderBy(l => l.Box.CenterX))
            {
                if (columns.Count == 0 || line.Box.CenterX - colCentre > slotW / 2)
                {
                    columns.Add(new List<LayoutLine> { line });
                }
                else
                {
                    columns[columns.Count - 1].Add(line);
                }
                colCentre = columns[columns.Count - 1].Average(l => l.Box.CenterX);
            }

            if (columns.Count > MaxSlots)
            {
                var centres = columns.Select(c => c.Average(l => l.Box.CenterX)).ToList();
                var keep = BestSubset(centres, Grid(cx0, MaxSlots, slotW));
                if (notes != null)
                {
                    var extra = Enumerable.Range(0, columns.Count).Where(i => !keep.Contains(i))
                        .Select(i => string.Join(" / ", columns[i].Select(l => Quote(l.Text))));
                    notes.Add($"{columns.Count} columns, kept the {MaxSlots} that fit the slot grid; extra: " +
                              string.Join("; ", extra));
                }
                columns = keep.Select(i => columns[i]).ToList();
            }

            double expectedFirstY = ev.Top + (geo.NameTopOffset + geo.GlyphHeight / 2) * su;
            double glyph = geo.GlyphHeight * su;
            var named = new List<(List<Row> name, List<LayoutLine> other)>();
            foreach (var col in columns)
            {
                var groups = GroupRows(SplitRows(col, medianH), medianH);
                int pick = groups.FindIndex(g => g.Any(r => r.Box.CenterY >= ev.Top && r.Box.CenterY <= ev.Bottom));
                if (pick < 0) pick = 0;
                var other = groups.Where((g, i) => i != pick).SelectMany(g => g).SelectMany(r => r.Lines).ToList();
                named.Add((groups[pick], other));
            }

            int n = named.Count;
            var grid = Grid(cx0, n, slotW);
            double rowLines = 0, alignSum = 0, vfitSum = 0, heightSum = 0;
            int heightCount = 0;
            for (int i = 0; i < n; i++)
            {
                var rows = named[i].name;
                var used = rows.SelectMany(r => r.Lines).ToList();
                double centreX = LayoutBox.Union(used.Select(l => l.Box)).CenterX;

                rowLines += used.Count(l => l.Box.CenterY >= ev.Top && l.Box.CenterY <= ev.Bottom);
                alignSum += 1 - Math.Min(1, Math.Abs(centreX - grid[i]) / (slotW / 2));
                vfitSum += 1 - Math.Min(1, Math.Abs(rows[0].Box.CenterY - expectedFirstY) / (lh / 2));
                foreach (var l in used)
                {
                    heightSum += 1 - Math.Min(1, Math.Abs(l.Box.Height - glyph) / (glyph / 2));
                    heightCount++;
                }

                ev.Slots.Add(new RewardSlot(centreX, grid[i], used, Candidates(rows), named[i].other));
            }
            ev.Score = rowLines + alignSum + vfitSum + (heightCount > 0 ? heightSum / heightCount : 0);
            return ev;
        }

        /// <summary>Visual rows: lines whose centres are within half a line height, left to right.</summary>
        private static List<Row> SplitRows(List<LayoutLine> column, double medianH)
        {
            var rows = new List<Row>();
            List<LayoutLine> current = null;
            double rowY = 0;
            foreach (var line in column.OrderBy(l => l.Box.CenterY).ThenBy(l => l.Box.X))
            {
                if (current == null || line.Box.CenterY - rowY > medianH / 2)
                {
                    current = new List<LayoutLine>();
                    rows.Add(new Row { Lines = current });
                    rowY = line.Box.CenterY;
                }
                current.Add(line);
            }
            foreach (var r in rows)
            {
                r.Lines.Sort((x, y) => x.Box.X.CompareTo(y.Box.X));
                r.Box = LayoutBox.Union(r.Lines.Select(l => l.Box));
                r.Text = Clean(string.Join(" ", r.Lines.Select(l => l.Text)));
            }
            return rows;
        }

        /// <summary>Joins rows while the vertical gap is under 0.6 of the median line height.</summary>
        private static List<List<Row>> GroupRows(List<Row> rows, double medianH)
        {
            var groups = new List<List<Row>>();
            foreach (var row in rows)
            {
                if (groups.Count == 0 || row.Box.Y - groups[groups.Count - 1].Last().Box.Bottom >= 0.6 * medianH)
                    groups.Add(new List<Row>());
                groups[groups.Count - 1].Add(row);
            }
            return groups;
        }

        private static List<string> Candidates(List<Row> rows)
        {
            var list = new List<string>();
            for (int k = rows.Count; k >= 1; k--)
            {
                string text = Clean(string.Join(" ", rows.Take(k).Select(r => r.Text)));
                if (text.Length > 0 && !list.Contains(text)) list.Add(text);
            }
            return list;
        }

        private static double[] Grid(double cx0, int n, double slotW)
        {
            var g = new double[n];
            for (int i = 0; i < n; i++) g[i] = cx0 + (i - (n - 1) / 2.0) * slotW;
            return g;
        }

        /// <summary>Indices (ascending) of grid.Length centres that best fit the grid in order.</summary>
        private static List<int> BestSubset(List<double> centres, double[] grid)
        {
            List<int> best = null;
            double bestCost = double.MaxValue;
            var pick = new int[grid.Length];

            void Recurse(int depth, int start, double cost)
            {
                if (cost >= bestCost) return;
                if (depth == grid.Length)
                {
                    bestCost = cost;
                    best = pick.ToList();
                    return;
                }
                for (int i = start; i <= centres.Count - (grid.Length - depth); i++)
                {
                    pick[depth] = i;
                    Recurse(depth + 1, i + 1, cost + Math.Abs(centres[i] - grid[depth]));
                }
            }

            Recurse(0, 0, 0);
            return best;
        }

        private static List<LayoutLine> ParseLines(JToken token)
        {
            var result = new List<LayoutLine>();
            if (token is not JArray array) return result;
            foreach (var item in array)
            {
                if (item is not JObject o) continue;
                string text = o["text"]?.Type == JTokenType.String ? Clean((string)o["text"]) : "";
                var box = o["box"];
                double? x = Num(box?["x"]), y = Num(box?["y"]), bw = Num(box?["width"]), bh = Num(box?["height"]);
                if (text.Length == 0 || x == null || y == null || bw == null || bh == null || bh <= 0) continue;
                result.Add(new LayoutLine(text, Num(o["confidence"]) ?? 0, new LayoutBox(x.Value, y.Value, bw.Value, bh.Value)));
            }
            return result;
        }

        private static double? Num(JToken t)
        {
            if (t == null) return null;
            if (t.Type != JTokenType.Float && t.Type != JTokenType.Integer) return null;
            double v = t.Value<double>();
            return double.IsFinite(v) ? v : null;
        }

        private static double Median(IEnumerable<double> values)
        {
            var v = values.OrderBy(x => x).ToList();
            if (v.Count == 0) return 0;
            return v.Count % 2 == 1 ? v[v.Count / 2] : (v[v.Count / 2 - 1] + v[v.Count / 2]) / 2;
        }

        private static double NearestToOne(double a, double b) => Math.Min(b, Math.Max(a, 1.0));

        private static string Clean(string s) =>
            string.Join(" ", (s ?? "").Split((char[])null, StringSplitOptions.RemoveEmptyEntries));

        private static string Quote(string s) => "\"" + s + "\"";
    }
}
