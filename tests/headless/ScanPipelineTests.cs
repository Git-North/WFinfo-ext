using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using WFInfo.MacOS;
using WFInfo.Scan;
using Xunit;

namespace WFInfo.Headless.Tests
{
    /// <summary>
    /// `--scan` from the command line to the written record, on macOS: the real
    /// Swift helper (Apple Vision), the Rust layout and WFInfo's own name
    /// matching, offline (market databases and cached prices are fixtures).
    /// </summary>
    public sealed class ScanPipelineTests : IClassFixture<RewardScreen>, IDisposable
    {
        private readonly RewardScreen _screen;
        private readonly TempDir _dir = new TempDir();
        private readonly EnvScope _env = new EnvScope(
            ("WFINFO_OCR_ENGINE", null), ("WFINFO_DATA_DIR", null), ("WFINFO_VISION_DEVICE", null),
            ("WFINFO_EE_LOG", null), (MacHelper.Variable, null));

        public ScanPipelineTests(RewardScreen screen)
        {
            _screen = screen;
            if (!Sandbox.Active) return;
            Sandbox.ResetAppDir();
            if (OperatingSystem.IsMacOS()) _env.Set(MacHelper.Variable, Helpers.Real);
        }

        public void Dispose()
        {
            _env.Dispose();
            _dir.Dispose();
        }

        private static async Task<(int Exit, JObject Record, string Output)> Scan(params string[] options)
        {
            using var console = new ConsoleCapture();
            int exit = await HeadlessProgram.Main(new[] { "--scan", "--no-notify" }.Concat(options).ToArray());
            JObject record = File.Exists(ScanPaths.LatestScan)
                ? JObject.Parse(File.ReadAllText(ScanPaths.LatestScan))
                : null;
            return (exit, record, console.ToString());
        }

        private static string[] Parts(JObject record) =>
            record["Choices"].Select(choice => choice["Part"].ToString()).ToArray();

        private static string[] ScanFiles(string pattern) =>
            Directory.GetFiles(ScanPaths.ScansDir, pattern).Select(Path.GetFileName).ToArray();

        private static void AssertNoLeftovers()
        {
            Assert.Empty(ScanFiles("*.tmp"));
            Assert.Empty(ScanFiles("capture-*.png"));
        }

        [MacSandboxFact]
        public async Task A_reward_screen_gives_a_priced_record_with_the_best_choice()
        {
            (int exit, JObject record, string output) =
                await Scan("--file", _screen.Png, "--ui-scale", "0.9", "--json");

            Assert.True(exit == 0, output);
            Assert.Equal(RewardScreen.Parts, Parts(record));
            Assert.Equal("file", (string)record["CaptureSource"]);
            Assert.Equal("vision-layout", (string)record["OcrEngine"]);
            Assert.Equal(1920, (int)record["ScreenshotWidth"]);
            Assert.Equal(1080, (int)record["ScreenshotHeight"]);
            Assert.Equal(0.9, (double)record["UiScaling"], 3);
            Assert.Equal(new[] { "cache", "sheet", "none", "cache" },
                record["Choices"].Select(c => (string)c["PlatSource"]).ToArray());
            // Equal platinum (20): the higher ducat value wins.
            Assert.Equal(1, (int)record["Best"]["Index"]);
            Assert.Equal(new[] { true, false, false, false }, record["Choices"].Select(c => (bool)c["Best"]).ToArray());
            Assert.Equal(2, (int)record["BestDucats"]["Index"]);
            Assert.Equal(2, (int)record["PriceCache"]["Hits"]);
            Assert.Equal(0, (int)record["PriceCache"]["Fetched"] + (int)record["PriceCache"]["Failed"]);
            Assert.Equal(File.ReadAllBytes(_screen.Png), File.ReadAllBytes(ScanPaths.ScreenshotPng));
            Assert.Single(ScanFiles("scan-*.json"));
            Assert.Contains("TAKE: Volt Prime Systems", output);
            Assert.Contains("\"OcrEngine\": \"vision-layout\"", output);
            AssertNoLeftovers();
        }

        [MacSandboxFact]
        public async Task An_unknown_UI_scale_is_estimated_from_the_screen()
        {
            (int exit, JObject record, string output) = await Scan("--file", _screen.Png, "--ui-scale", "unknown");

            Assert.True(exit == 0, output);
            Assert.Equal(RewardScreen.Parts, Parts(record));
            Assert.Equal(0.9, (double)record["UiScaling"], 1);
        }

        [MacSandboxFact]
        public async Task The_automatic_UI_scale_comes_from_EE_cfg_next_to_the_log()
        {
            string log = _dir.Write("wf/EE.log", "");
            _dir.Write("wf/EE.cfg", "Flash.FlashDrawScale=0.9\n");

            (int exit, JObject record, string output) = await Scan("--file", _screen.Png, "--log", log);

            Assert.True(exit == 0, output);
            Assert.Equal(RewardScreen.Parts, Parts(record));
            Assert.Equal(0.9, (double)record["UiScaling"], 3);
        }

        [MacSandboxFact]
        public async Task A_screen_without_rewards_is_a_record_without_choices_and_without_error()
        {
            string png = _dir.File("other.png");
            RewardScreen.Run("selfcheck", "--text", "Nothing to see", "--save", png);

            (int exit, JObject record, string output) = await Scan("--file", png, "--ui-scale", "1.0");

            Assert.True(exit == 0, output);
            Assert.Empty(record["Choices"]);
            Assert.Equal(JTokenType.Null, record["Error"].Type);
        }

        [MacSandboxFact]
        public async Task A_file_that_is_no_image_is_a_failed_scan_with_the_reason()
        {
            string notAnImage = _dir.Write("broken.png", "this is not a PNG");

            (int exit, JObject record, string output) = await Scan("--file", notAnImage);

            Assert.True(exit == 1, output);
            Assert.Contains("not an image", (string)record["Error"]);
        }

        [MacSandboxFact]
        public async Task Pending_files_of_dead_or_old_scans_are_removed_and_running_ones_stay()
        {
            Directory.CreateDirectory(ScanPaths.ScansDir);
            string Pending(string name, int ageMinutes)
            {
                string path = Path.Combine(ScanPaths.ScansDir, name);
                File.WriteAllText(path, "pending");
                File.SetLastWriteTimeUtc(path, DateTime.UtcNow.AddMinutes(-ageMinutes));
                return path;
            }
            string dead = Pending("last.png.99999999.tmp", 0);
            string old = Pending("latest.json.1.tmp", 30);
            string running = Pending("last.png.1.tmp", 0); // process 1 always runs
            string unrelated = Pending("other.99999999.tmp", 30);

            await Scan("--file", _screen.Png, "--ui-scale", "0.9");

            Assert.False(File.Exists(dead));
            Assert.False(File.Exists(old));
            Assert.True(File.Exists(running));
            Assert.True(File.Exists(unrelated));
        }

        // ---- live capture, through a stand-in helper ---------------------------

        private FakeCaptureHelper FakeCapture()
        {
            var fake = new FakeCaptureHelper();
            fake.Answer("display-1", _screen.Reading, withLines: true);
            fake.Answer("display-2", _screen.Reading, withLines: true);
            fake.Answer("window-42", _screen.Reading, withLines: true);
            fake.Answer("empty", _screen.Reading, withLines: false);
            _env.Set(MacHelper.Variable, fake.Path);
            return fake;
        }

        [MacSandboxFact]
        public async Task The_main_display_is_read_first_and_a_reward_screen_ends_the_search()
        {
            using FakeCaptureHelper fake = FakeCapture();

            (int exit, JObject record, string output) = await Scan("--ui-scale", "0.9");

            Assert.True(exit == 0, output);
            Assert.Equal("screencapturekit", (string)record["CaptureSource"]);
            Assert.Equal("display 1", (string)record["CaptureTarget"]);
            Assert.Equal(RewardScreen.Parts, Parts(record));
            Assert.Contains("--display 1", Assert.Single(fake.Calls("rewards")));
            Assert.Equal("capture of display-1", File.ReadAllText(ScanPaths.ScreenshotPng));
            AssertNoLeftovers();
        }

        [MacSandboxFact]
        public async Task The_display_with_the_reward_screen_wins_and_other_captures_are_deleted()
        {
            using FakeCaptureHelper fake = FakeCapture();
            fake.Answer("display-1", _screen.Reading, withLines: false);

            (int exit, JObject record, string output) = await Scan("--ui-scale", "0.9");

            Assert.True(exit == 0, output);
            Assert.Equal("display 2", (string)record["CaptureTarget"]);
            Assert.Equal(2, fake.Calls("rewards").Length);
            Assert.Equal("capture of display-2", File.ReadAllText(ScanPaths.ScreenshotPng));
            AssertNoLeftovers();
        }

        [MacSandboxFact]
        public async Task A_chosen_window_is_the_only_capture_and_an_unknown_scale_reads_it_twice()
        {
            using FakeCaptureHelper fake = FakeCapture();

            (int exit, JObject record, string output) = await Scan("--window", "42", "--ui-scale", "unknown");

            Assert.True(exit == 0, output);
            Assert.Equal("window 42", (string)record["CaptureTarget"]);
            Assert.Empty(fake.Calls("displays"));
            string[] calls = fake.Calls("rewards");
            Assert.Equal(2, calls.Length);
            Assert.All(calls, call => Assert.Contains("--window 42", call));
            Assert.Contains("--ui-scale-min 0.5 --ui-scale-max 1.25", calls[0]);
            Assert.Contains("--ui-scale 0.9", calls[1]);
            AssertNoLeftovers();
        }

        [MacSandboxFact]
        public async Task A_triggered_scan_captures_again_until_the_panel_is_there()
        {
            using FakeCaptureHelper fake = FakeCapture();
            fake.Write("first-call-empty", "");

            (int exit, JObject record, string output) = await Scan("--output", "1", "--ui-scale", "0.9", "--wait", "30");

            Assert.True(exit == 0, output);
            Assert.Equal(RewardScreen.Parts, Parts(record));
            Assert.Equal(2, fake.Calls("rewards").Length);
            AssertNoLeftovers();
        }

        [MacSandboxFact]
        public async Task A_capture_that_fails_is_recorded_with_the_helpers_reason()
        {
            using FakeCaptureHelper fake = FakeCapture();
            fake.Write("fail", "screen capture is not allowed");

            (int exit, JObject record, string output) = await Scan("--ui-scale", "0.9");

            Assert.True(exit == 1, output);
            Assert.Equal("screen capture is not allowed", (string)record["Error"]);
            Assert.Empty(record["Choices"]);
            Assert.False(File.Exists(ScanPaths.ScreenshotPng));
            AssertNoLeftovers();
        }
    }
}
