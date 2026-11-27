using System;
using System.Linq;
using WFInfo.MacOS;
using WFInfo.Scan;
using Xunit;

namespace WFInfo.Headless.Tests
{
    public sealed class ScanOptionsTests : IDisposable
    {
        // A fixed default engine, so parsing does not depend on a built helper.
        private readonly EnvScope _env = new EnvScope(("WFINFO_OCR_ENGINE", "tesseract"), (MacHelper.Variable, null));

        public void Dispose() => _env.Dispose();

        private static ScanOptions Parse(params string[] args) => ScanOptions.Parse(args);

        [Fact]
        public void The_defaults_are_one_notified_scan_of_every_output()
        {
            ScanOptions options = Parse();

            Assert.Null(options.File);
            Assert.Null(options.Output);
            Assert.Null(options.Window);
            Assert.Null(options.Region);
            Assert.Null(options.Theme);
            Assert.Null(options.LogPath);
            Assert.Equal("tesseract", options.Ocr);
            Assert.Equal("auto", options.UiScaleMode);
            Assert.Null(options.UiScale);
            Assert.True(options.Notify);
            Assert.False(options.Refresh || options.PrintJson || options.Watch || options.Once || options.Help);
            Assert.Equal(6, options.TtlHours);
            Assert.Equal(0, options.WaitSeconds);
            Assert.Equal(5, options.CooldownSeconds);
        }

        [Fact]
        public void Every_value_flag_is_read()
        {
            ScanOptions options = Parse(
                "--file", "shot.png", "--output", "DP-2", "--window", "4711", "--ocr", "tesseract",
                "--ttl", "1.5", "--log", "EE.log", "--wait", "2.5", "--cooldown", "0",
                "--refresh", "--no-notify", "--json");

            Assert.Equal("shot.png", options.File);
            Assert.Equal("DP-2", options.Output);
            Assert.Equal("4711", options.Window);
            Assert.Equal(1.5, options.TtlHours);
            Assert.Equal("EE.log", options.LogPath);
            Assert.Equal(2.5, options.WaitSeconds);
            Assert.Equal(0, options.CooldownSeconds);
            Assert.True(options.Refresh);
            Assert.True(options.PrintJson);
            Assert.False(options.Notify);
        }

        [Fact]
        public void Flag_names_ignore_case()
        {
            Assert.False(Parse("--NO-NOTIFY").Notify);
        }

        [Fact]
        public void Watch_waits_ten_seconds_by_default_and_once_implies_watch()
        {
            Assert.Equal(10, Parse("--watch").WaitSeconds);
            ScanOptions once = Parse("--once");
            Assert.True(once.Watch);
            Assert.True(once.Once);
            Assert.Equal(3, Parse("--watch", "--wait", "3").WaitSeconds);
        }

        [Theory]
        [InlineData("auto", "auto", null)]
        [InlineData(" Unknown ", "unknown", null)]
        [InlineData("0.5", "fixed", 0.5)]
        [InlineData("1.25", "fixed", 1.25)]
        public void The_UI_scale_is_auto_unknown_or_a_fixed_number(string value, string mode, double? scale)
        {
            ScanOptions options = Parse("--ui-scale", value);
            Assert.Equal(mode, options.UiScaleMode);
            Assert.Equal(scale, options.UiScale);
        }

        [Theory]
        [InlineData("-h")]
        [InlineData("--help")]
        public void Help_is_a_switch(string flag) => Assert.True(Parse(flag).Help);

        [Theory]
        [InlineData("Unknown scan option", "--nope")]
        [InlineData("--file expects a value", "--file")]
        [InlineData("--window expects a numeric window id", "--window", "abc")]
        [InlineData("--window expects a numeric window id", "--window", "1234567890123")]
        [InlineData("--window expects a numeric window id", "--window", "-4")]
        [InlineData("--ttl expects a positive number", "--ttl", "0")]
        [InlineData("--ttl expects a positive number", "--ttl", "soon")]
        [InlineData("--wait expects a number of seconds", "--wait", "-1")]
        [InlineData("--cooldown expects a number of seconds", "--cooldown", "x")]
        [InlineData("--ui-scale expects", "--ui-scale", "0.4")]
        [InlineData("--ui-scale expects", "--ui-scale", "1.3")]
        [InlineData("--ui-scale expects", "--ui-scale", "big")]
        [InlineData("--ocr expects", "--ocr", "magic")]
        [InlineData("Unknown theme", "--theme", "nope")]
        [InlineData("Unknown theme", "--theme", "CUSTOM")]
        [InlineData("--region expects", "--region", "10,10")]
        [InlineData("--region expects", "--region", "10,10 0x20")]
        [InlineData("--region expects", "--region", "10,10 20x99999999999")]
        [InlineData("--file cannot be combined", "--watch", "--file", "a.png")]
        [InlineData("--file cannot be combined", "--once", "--file", "a.png")]
        public void Bad_input_is_refused_with_a_reason(string reason, params string[] args)
        {
            var error = Assert.Throws<ArgumentException>(() => ScanOptions.Parse(args));
            Assert.Contains(reason, error.Message);
        }

        [NotMacFact]
        public void A_region_is_normalized_for_grim()
        {
            Assert.Equal("-10,44 1900x1026", Parse("--region", " -10 , 44   1900X1026 ").Region);
        }

        [MacFact]
        public void MacOS_refuses_a_Linux_region_instead_of_capturing_a_display()
        {
            var error = Assert.Throws<ArgumentException>(() => Parse("--region", "10,44 1900x1026"));
            Assert.Contains("--region is Linux-only", error.Message);
        }

        [Fact]
        public void A_theme_can_be_pinned_or_left_automatic()
        {
            Assert.Equal(WFtheme.AUTO, Parse("--theme", "Auto").Theme);
            WFtheme real = ScanOptions.ThemeCandidates().First();
            Assert.Equal(real, Parse("--theme", real.ToString().ToLowerInvariant()).Theme);
        }

        [Fact]
        public void The_theme_list_has_only_real_themes()
        {
            Assert.DoesNotContain(WFtheme.AUTO, ScanOptions.ThemeCandidates());
            Assert.DoesNotContain(WFtheme.CUSTOM, ScanOptions.ThemeCandidates());
            Assert.Contains(ScanOptions.ThemeCandidates().First().ToString(), ScanOptions.ThemeNames());
        }
    }
}
