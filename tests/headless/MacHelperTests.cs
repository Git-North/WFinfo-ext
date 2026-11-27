using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using WFInfo.MacOS;
using WFInfo.Errors;
using Xunit;

namespace WFInfo.Headless.Tests
{
    /// <summary>
    /// The process plumbing around the Swift helper, with a shell script as the
    /// helper, so it runs on Linux too.
    /// </summary>
    public sealed class MacHelperTests : IDisposable
    {
        private readonly TempDir _dir = new TempDir();
        private readonly EnvScope _env = new EnvScope((MacHelper.Variable, null));

        public void Dispose()
        {
            _env.Dispose();
            _dir.Dispose();
        }

        private void UseHelper(string body) => _env.Set(MacHelper.Variable, Helpers.Script(_dir, body));

        [UnixFact]
        public void Run_passes_the_arguments_unchanged_and_parses_the_JSON_answer()
        {
            UseHelper("printf '{\"first\":\"%s\",\"second\":\"%s\",\"count\":%s}' \"$1\" \"$2\" \"$#\"");

            var answer = MacHelper.Run(new[] { "rewards", "a b|$HOME" }, 10000);

            Assert.Equal("rewards", answer["first"]?.ToString());
            Assert.Equal("a b|$HOME", answer["second"]?.ToString());
            Assert.Equal("2", answer["count"]?.ToString());
        }

        [UnixFact]
        public void An_answer_that_is_not_JSON_is_reported()
        {
            UseHelper("echo 'not json'");
            var error = Assert.Throws<ScanFailure>(() => MacHelper.Run(new[] { "x" }, 10000));
            Assert.Contains("printed no JSON", error.Message);
        }

        [UnixFact]
        public void A_failure_reports_the_helper_message_without_its_prefix()
        {
            UseHelper("echo 'wfinfo-mac: window 7 is not on screen' >&2; exit 1");
            var error = Assert.Throws<InvalidOperationException>(() => MacHelper.RunBytes(new[] { "x" }, 10000));
            Assert.Equal("window 7 is not on screen", error.Message);
        }

        [UnixFact]
        public void A_silent_failure_reports_the_exit_code()
        {
            UseHelper("exit 7");
            var error = Assert.Throws<InvalidOperationException>(() => MacHelper.RunBytes(new[] { "x" }, 10000));
            Assert.Equal("wfinfo-mac exited with 7", error.Message);
        }

        [UnixFact]
        public void Large_input_goes_through_stdin_and_back_unchanged()
        {
            UseHelper("cat");
            var input = new byte[4 * 1024 * 1024];
            new Random(1).NextBytes(input);

            byte[] output = MacHelper.RunBytes(new[] { "ocr", "-" }, 60000, input);

            Assert.True(input.AsSpan().SequenceEqual(output));
        }

        [UnixFact]
        public void A_helper_that_exits_before_it_reads_its_input_reports_its_own_error()
        {
            UseHelper("echo 'wfinfo-mac: bad frame' >&2; exit 3");
            var error = Assert.Throws<InvalidOperationException>(
                () => MacHelper.RunBytes(new[] { "ocr", "--frames" }, 30000, new byte[8 * 1024 * 1024]));
            Assert.Equal("bad frame", error.Message);
        }

        [UnixFact]
        public void A_helper_past_its_time_limit_is_stopped()
        {
            UseHelper("exec sleep 30");
            var watch = Stopwatch.StartNew();

            var error = Assert.Throws<ScanFailure>(() => MacHelper.RunBytes(new[] { "x" }, 500));

            Assert.Contains("timed out after 500 ms", error.Message);
            Assert.True(watch.Elapsed < TimeSpan.FromSeconds(15), $"took {watch.Elapsed}");
        }

        [Fact]
        public void The_override_is_trimmed_and_a_blank_value_counts_as_unset()
        {
            _env.Set(MacHelper.Variable, "  /opt/helper  ");
            Assert.Equal("/opt/helper", MacHelper.Configured);
            _env.Set(MacHelper.Variable, "   ");
            Assert.Null(MacHelper.Configured);
        }

        [Fact]
        public void A_missing_override_is_never_replaced_by_another_helper()
        {
            _env.Set(MacHelper.Variable, _dir.File("nowhere"));

            Assert.Null(MacHelper.Path);
            Assert.False(MacHelper.Available);
            var error = Assert.Throws<ScanFailure>(() => MacHelper.RunBytes(new[] { "x" }, 1000));
            Assert.Contains("names a missing file", error.Message);
        }

        [MacFact]
        public void On_macOS_a_missing_override_fails_the_configuration_check()
        {
            _env.Set(MacHelper.Variable, _dir.File("nowhere"));
            Assert.Equal("SYS-004", Assert.Throws<ScanFailure>(MacHelper.CheckConfigured).Code);
        }

        [Fact]
        public void Frames_prefix_each_image_with_its_big_endian_length()
        {
            byte[] big = Enumerable.Repeat((byte)9, 0x01_02_03).ToArray();

            byte[] frames = MacHelper.Frames(new[] { Encoding.ASCII.GetBytes("ab"), big });

            Assert.Equal(new byte[] { 0, 0, 0, 2, (byte)'a', (byte)'b', 0, 1, 2, 3 }, frames.Take(10).ToArray());
            Assert.Equal(4 + 2 + 4 + big.Length, frames.Length);
        }
    }
}
