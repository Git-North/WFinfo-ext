using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Newtonsoft.Json.Linq;

namespace WFInfo.MacOS
{
    /// <summary>
    /// Offline self-test of <see cref="RewardLayout"/> over hand-written fixtures in
    /// the <c>wfinfo-mac rewards</c> JSON shape. The fixture boxes follow WFInfo's
    /// geometry (1080p units times su = s*u): name glyphs 17 tall, line advance 20,
    /// first line top 4 below the row top; squad names 14 tall, 4 below the row
    /// bottom; "1 OWNED" 14 tall, 60 above the row top (the band filter drops it).
    /// Case (a) puts the header inside the band tolerance instead, so the
    /// header-group rule must drop it.
    /// </summary>
    internal static class RewardLayoutTest
    {
        // OCR.pixleRewardWidth, pixleRewardHeight, pixleRewardYDisplay, pixelRewardLineHeight.
        private const int RewardWidth = 968, RewardHeight = 235, RewardY = 316, LineHeight = 48;

        public static int Run()
        {
            var cases = new List<(string name, Func<string> check)>
            {
                ("(a) 4 slots 1920x1080 u=1.0 known, wrapped name, squad + in-band OWNED", CaseA),
                ("(b) 3 slots 2560x1440 u=0.8 unknown", CaseB),
                ("(c) 2 slots 3440x1440 u=1.0 unknown (21:9, s=1.333)", CaseC),
                ("(d) 1 slot 1728x1117 u=1.25 known", CaseD),
                ("(e) no-letter noise in the band, stray word outside the strip", CaseE),
                ("(f) no lines", CaseF),
                ("(g) 1 slot 1920x1080 u=0.9 unknown, wrapped name, squad", CaseG),
                ("(h) 5 columns: the 4 that fit the grid stay", CaseH),
                ("(i) no helper JSON", CaseI),
            };

            int failed = 0;
            foreach (var (name, check) in cases)
            {
                string problem;
                try { problem = check(); }
                catch (Exception ex) { problem = "exception: " + ex; }
                if (problem == null) Console.WriteLine("PASS " + name);
                else { failed++; Console.WriteLine("FAIL " + name + ": " + problem); }
            }
            Console.WriteLine(failed == 0
                ? $"layout-test: all {cases.Count} cases passed"
                : $"layout-test: {failed} of {cases.Count} cases failed");
            return failed == 0 ? 0 : 1;
        }

        private static string CaseA()
        {
            var f = new Fixture(1920, 1080, 1.0, known: true);
            string[][] names =
            {
                new[] { "Forma Blueprint" },
                new[] { "Lex Prime Receiver" },
                new[] { "Nikana Prime", "Blueprint" },
                new[] { "Akstiletto Prime Barrel" },
            };
            string[] squad = { "TennoOne", "xXSlayerXx", "Moonlit", "Ordis42" };
            for (int i = 0; i < 4; i++)
            {
                f.Name(i, 4, names[i]);
                f.Squad(i, 4, squad[i]);
                if (i != 1) f.OwnedInBand(i, 4, "1 OWNED");
            }
            return Expect(f, "Forma Blueprint", "Lex Prime Receiver", "Nikana Prime Blueprint",
                "Akstiletto Prime Barrel")
                ?? ExpectSecond(f, 2, "Nikana Prime")
                ?? ExpectHeader(f, new[] { 0, 2, 3 }, "1 OWNED");
        }

        private static string CaseB()
        {
            var f = new Fixture(2560, 1440, 0.8, known: false);
            string[][] names =
            {
                new[] { "Saryn Prime", "Chassis Blueprint" },
                new[] { "Braton Prime Stock" },
                new[] { "Forma Blueprint" },
            };
            for (int i = 0; i < 3; i++)
            {
                f.Name(i, 3, names[i]);
                f.Squad(i, 3, "Squadmate" + (i + 1));
                f.Owned(i, 3, (i + 2) + " OWNED");
            }
            return Expect(f, "Saryn Prime Chassis Blueprint", "Braton Prime Stock", "Forma Blueprint")
                ?? ExpectScale(f, 0.8);
        }

        private static string CaseC()
        {
            var f = new Fixture(3440, 1440, 1.0, known: false);
            f.Name(0, 2, "Paris Prime String");
            f.Name(1, 2, "Volt Prime", "Neuroptics Blueprint");
            f.Squad(0, 2, "Hunter");
            f.Squad(1, 2, "Gatherer");
            return Expect(f, "Paris Prime String", "Volt Prime Neuroptics Blueprint") ?? ExpectScale(f, 1.0);
        }

        private static string CaseD()
        {
            var f = new Fixture(1728, 1117, 1.25, known: true);
            f.Name(0, 1, "Ash Prime Systems", "Blueprint");
            f.Squad(0, 1, "Solo");
            f.Owned(0, 1, "3 OWNED");
            return Expect(f, "Ash Prime Systems Blueprint");
        }

        private static string CaseE()
        {
            var f = new Fixture(1920, 1080, 1.0, known: true);
            f.Name(0, 4, "Forma Blueprint");
            f.Name(1, 4, "Bronco Prime Barrel");
            f.Name(2, 4, "Carrier Prime Cerebrum");
            f.Name(3, 4, "Mag Prime Blueprint");
            // Noise with no letters, on the first name row of slot 1, right of the name.
            double su = f.Su;
            f.Add("== 42 ==", f.SlotX(1, 4) + 100 * su, f.RowTop + 4 * su, 17 * su);
            // Noise with no letters between the slots, inside the band.
            f.Add("|||", f.SlotX(2, 4) + 121 * su, f.RowTop + 10 * su, 17 * su);
            // A stray word far outside the strip, at the name-row height.
            f.Add("Warframe", 80, f.RowTop + 4 * su, 17 * su);
            return Expect(f, "Forma Blueprint", "Bronco Prime Barrel", "Carrier Prime Cerebrum",
                "Mag Prime Blueprint");
        }

        private static string CaseF()
        {
            var f = new Fixture(1920, 1080, 1.0, known: false);
            return Expect(f) ?? ExpectScale(f, 1.0);
        }

        private static string CaseG()
        {
            var f = new Fixture(1920, 1080, 0.9, known: false);
            f.Name(0, 1, "Rhino Prime", "Systems Blueprint");
            f.Squad(0, 1, "Lotus");
            return Expect(f, "Rhino Prime Systems Blueprint") ?? ExpectScale(f, 0.9);
        }

        private static string CaseH()
        {
            // Real cards always sit 242*su apart, so a fifth column needs an uneven
            // spread: five texts 180 px apart. The middle one is off the 4-slot grid.
            var f = new Fixture(1920, 1080, 1.0, known: true);
            string[] names = { "Forma Blueprint", "Lex Prime Barrel", "Burston Prime Stock", "Nova Prime Systems" };
            double[] offsets = { -360, -180, 180, 360 };
            for (int i = 0; i < 4; i++)
                f.Add(names[i], 960 + offsets[i], f.RowTop + 4 * f.Su, 17 * f.Su, width: 150);
            f.Add("Relic", 960, f.RowTop + 4 * f.Su, 17 * f.Su, width: 45);
            var r = f.Analyze();
            if (!r.Notes.Any(n => n.Contains("Relic"))) return "no note names the extra column";
            return Expect(f, names);
        }

        private static string CaseI()
        {
            var r = RewardLayout.Analyze(null, RewardWidth, RewardHeight, RewardY, LineHeight);
            if (r.Slots.Count != 0) return $"expected 0 slots, got {r.Slots.Count}";
            return r.Notes.Contains("no helper JSON") ? null : "no note for the missing JSON";
        }

        // ---- checks ---------------------------------------------------------------

        private static string Expect(Fixture f, params string[] firsts)
        {
            var r = f.Analyze();
            var got = r.Slots.Select(s => s.Candidates.FirstOrDefault() ?? "").ToList();
            string detail = $" got [{string.Join(" | ", got)}], u={F(r.UiScale)}, notes: {string.Join("; ", r.Notes)}";
            if (r.Slots.Count != firsts.Length) return $"expected {firsts.Length} slot(s)," + detail;
            for (int i = 0; i < firsts.Length; i++)
                if (got[i] != firsts[i]) return $"slot {i}: expected \"{firsts[i]}\"," + detail;
            for (int i = 1; i < r.Slots.Count; i++)
                if (r.Slots[i].CenterX <= r.Slots[i - 1].CenterX) return "slots not left to right," + detail;
            return null;
        }

        private static string ExpectSecond(Fixture f, int slot, string text)
        {
            var c = f.Analyze().Slots[slot].Candidates;
            return c.Count > 1 && c[1] == text ? null : $"slot {slot}: second candidate is not \"{text}\"";
        }

        /// <summary>The header passed the band filter and the header-group rule kept it out of the name.</summary>
        private static string ExpectHeader(Fixture f, int[] slots, string text)
        {
            var r = f.Analyze();
            foreach (int i in slots)
            {
                if (!r.Slots[i].OtherLines.Any(l => l.Text == text))
                    return $"slot {i}: \"{text}\" is not a header line (dropped by the band filter?)";
                if (r.Slots[i].Lines.Any(l => l.Text == text))
                    return $"slot {i}: \"{text}\" is part of the name";
            }
            return null;
        }

        private static string ExpectScale(Fixture f, double u)
        {
            var r = f.Analyze();
            return Math.Abs(r.UiScale - u) < 0.026 ? null : $"ui scale {F(r.UiScale)}, expected {F(u)}";
        }

        private static string F(double v) => v.ToString("0.00", CultureInfo.InvariantCulture);

        // ---- fixture builder ------------------------------------------------------

        private sealed class Fixture
        {
            private readonly double _w, _h, _s, _u;
            private readonly bool _known;
            private readonly JArray _lines = new JArray();

            public Fixture(double w, double h, double u, bool known)
            {
                _w = w; _h = h; _u = u; _known = known;
                _s = Math.Min(w / 1920.0, h / 1080.0);
            }

            public double Su => _s * _u;
            public double RowTop => _h / 2 - (RewardY - RewardHeight + LineHeight) * Su;
            public double RowBottom => _h / 2 - (RewardY - RewardHeight) * Su;
            public double SlotX(int i, int n) => _w / 2 + (i - (n - 1) / 2.0) * (RewardWidth / 4.0) * Su;

            public void Name(int i, int n, params string[] rows)
            {
                for (int k = 0; k < rows.Length; k++)
                    Add(rows[k], SlotX(i, n), RowTop + (4 + 20 * k) * Su, 17 * Su);
            }

            public void Squad(int i, int n, string text) => Add(text, SlotX(i, n), RowBottom + 4 * Su, 14 * Su);

            public void Owned(int i, int n, string text) =>
                Add(text, SlotX(i, n) - 60 * Su, RowTop - 60 * Su, 14 * Su);

            /// <summary>
            /// A header inside the band tolerance (centre 11.8*su above the row top,
            /// tolerance 12*su) but its own row group: its bottom is 8.8*su above the
            /// name (4*su below the row top), over the 0.6 * median-height join gap
            /// (8.4*su with this case's 14-tall lines).
            /// </summary>
            public void OwnedInBand(int i, int n, string text) =>
                Add(text, SlotX(i, n) - 60 * Su, RowTop - 18.8 * Su, 14 * Su);

            public void Add(string text, double centreX, double top, double height, double? width = null)
            {
                double wd = width ?? Math.Min(230 * Su, text.Length * 9 * Su);
                _lines.Add(new JObject
                {
                    ["text"] = text,
                    ["confidence"] = 0.9,
                    ["box"] = new JObject
                    {
                        ["x"] = centreX - wd / 2, ["y"] = top, ["width"] = wd, ["height"] = height,
                    },
                });
            }

            public RewardLayoutResult Analyze()
            {
                double cropH = 200 * _s * 1.25;
                var json = new JObject
                {
                    ["source"] = "fixture",
                    ["width"] = _w,
                    ["height"] = _h,
                    ["screenScaling"] = _s,
                    ["uiScaleMin"] = _known ? _u : 0.5,
                    ["uiScaleMax"] = _known ? _u : 1.25,
                    ["crop"] = new JObject
                    {
                        ["x"] = _w / 2 - RewardWidth * _s * 1.25 / 2,
                        ["y"] = _h / 2 - cropH,
                        ["width"] = RewardWidth * _s * 1.25,
                        ["height"] = cropH,
                    },
                    ["lines"] = _lines,
                };
                return RewardLayout.Analyze(json, RewardWidth, RewardHeight, RewardY, LineHeight);
            }
        }
    }
}
