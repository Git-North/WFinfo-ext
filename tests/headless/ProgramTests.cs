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
    /// <summary>The command line of the runner: modes, exit codes and the watch.</summary>
    public sealed class ProgramTests : IDisposable
    {
        private static readonly TimeSpan Limit = TimeSpan.FromSeconds(60);

        private readonly TempDir _dir = new TempDir();
        private readonly EnvScope _env = new EnvScope(
            ("WFINFO_OCR_ENGINE", null), ("WFINFO_DATA_DIR", null), ("WFINFO_VISION_DEVICE", null),
            ("WFINFO_EE_LOG", null), ("STEAM_ROOT", null), (MacHelper.Variable, null));

        public void Dispose()
        {
            _env.Dispose();
            _dir.Dispose();
        }

        private static async Task<(int Exit, string Output)> Run(params string[] args)
        {
            using var console = new ConsoleCapture();
            int exit = await HeadlessProgram.Main(args);
            return (exit, console.ToString());
        }

        [Theory]
        [InlineData("Usage:")]
        [InlineData("Usage:", "--what")]
        [InlineData("Usage: WFInfo.Headless --test", "--test")]
        [InlineData("map file not found", "--test", "no-such-map.json")]
        [InlineData("Unknown scan option: --nope", "--scan", "--nope")]
        [InlineData("Unknown self-check option: --nope", "--selfcheck", "--nope")]
        [InlineData("--ocr expects", "--selfcheck", "--ocr", "magic")]
        public async Task Bad_command_lines_exit_with_2_and_say_why(string reason, params string[] args)
        {
            _env.Set("WFINFO_OCR_ENGINE", "tesseract");

            (int exit, string output) = await Run(args);

            Assert.Equal(2, exit);
            Assert.Contains(reason, output);
        }

        [Fact]
        public async Task Scan_help_lists_the_options_and_succeeds()
        {
            _env.Set("WFINFO_OCR_ENGINE", "tesseract");

            (int exit, string output) = await Run("--scan", "--help");

            Assert.Equal(0, exit);
            Assert.Contains("--ui-scale", output);
            Assert.Contains("--watch", output);
        }

        [MacSandboxFact]
        public async Task The_Vision_self_check_reads_the_sample_text()
        {
            Sandbox.ResetAppDir();
            _env.Set(MacHelper.Variable, Helpers.Real);

            (int exit, string output) = await Run("--selfcheck", "--ocr", "vision");

            Assert.True(exit == 0, output);
            Assert.Contains("SELF-CHECK PASSED", output);
        }

        [MacSandboxFact]
        public async Task The_self_check_fails_on_wrong_text_and_on_a_broken_helper()
        {
            Sandbox.ResetAppDir();
            using var fake = new FakeCaptureHelper();
            fake.Write("selfcheck.json", """{"text":"something else","ms":1}""");
            _env.Set(MacHelper.Variable, fake.Path);

            (int wrong, string wrongOutput) = await Run("--selfcheck");
            Assert.True(wrong == 1, wrongOutput);
            Assert.Contains("SELF-CHECK FAILED", wrongOutput);

            _env.Set(MacHelper.Variable, Helpers.Script(_dir, "echo 'wfinfo-mac: no Vision' >&2; exit 1"));
            (int broken, string brokenOutput) = await Run("--selfcheck");
            Assert.True(broken == 2, brokenOutput);
            Assert.Contains("Self-check failed: no Vision", brokenOutput);
        }

        [MacSandboxFact]
        public async Task The_watch_refuses_a_log_that_does_not_exist()
        {
            Sandbox.ResetAppDir();
            _env.Set(MacHelper.Variable, Helpers.Script(_dir, "exit 0"));

            (int exit, string output) = await Run("--scan", "--watch", "--log", _dir.File("no/EE.log"));

            Assert.Equal(2, exit);
            Assert.Contains("no such log file", output);
        }

        [MacSandboxFact]
        public async Task Without_any_log_the_watch_lists_where_it_looked()
        {
            Sandbox.ResetAppDir();
            _env.Set(MacHelper.Variable, Helpers.Script(_dir, "exit 0"));
            string home = _dir.File("home");
            Directory.CreateDirectory(Path.Combine(home, "Library", "Application Support", "Steam"));
            _env.Set("HOME", home);

            (int exit, string output) = await Run("--scan", "--watch");

            Assert.Equal(2, exit);
            Assert.Contains("EE.log was not found", output);
            Assert.Contains("compatdata/230410/pfx", output);
        }

        [MacSandboxFact]
        public async Task The_watch_scans_when_the_game_shows_a_reward_screen()
        {
            Sandbox.ResetAppDir();
            using var screen = new RewardScreen();
            using var fake = new FakeCaptureHelper();
            fake.Answer("display-1", screen.Reading, withLines: true);
            _env.Set(MacHelper.Variable, fake.Path);
            string log = _dir.Write("wf/EE.log", "");

            using var console = new ConsoleCapture();
            Task<int> run = Task.Run(() => HeadlessProgram.Main(
                new[] { "--scan", "--no-notify", "--watch", "--once", "--log", log, "--ui-scale", "0.9" }));
            console.Out.WaitFor("trigger:");
            File.AppendAllText(log, "Script [Info]: Got rewards\n");

            Assert.True(await run.WaitAsync(Limit) == 0, console.ToString());
            JObject record = JObject.Parse(File.ReadAllText(ScanPaths.LatestScan));
            Assert.Equal(RewardScreen.Parts, record["Choices"].Select(c => (string)c["Part"]).ToArray());
        }
    }
}
