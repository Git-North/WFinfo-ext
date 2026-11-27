using System;
using System.IO;
using System.Linq;
using WFInfo.Errors;
using Xunit;

namespace WFInfo.ScanFlow.Tests.Errors
{
    /// <summary>
    /// Crash reports go to a temp folder only. The guard refuses the user's
    /// real app dir, so a test can never leave reports there.
    /// </summary>
    public sealed class CrashReportTests : IDisposable
    {
        private readonly string _dir;

        public CrashReportTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "wfinfo-crash-test-" + Guid.NewGuid().ToString("N"));
            string real = Path.GetFullPath(CrashReport.DefaultDirectory);
            if (Path.GetFullPath(_dir).StartsWith(Path.GetDirectoryName(real), StringComparison.Ordinal))
                throw new InvalidOperationException("refusing to write crash reports into the real app dir: " + real);
        }

        public void Dispose()
        {
            if (Directory.Exists(_dir)) Directory.Delete(_dir, true);
        }

        [Fact]
        public void ScrubRemovesHomeEmailIpAndLogLines()
        {
            string[] homes = { "/srv/ann" };
            string text = "at X in /srv/ann/src/a.cs:line 3\n/srv/anna/keep\n" +
                "/Users/bob/x.cs /home/eve/y C:\\Users\\Joe\\z /Users/Shared/s\n" +
                "mail ann.example+1@mail.example.com ip 192.168.1.20 v6 fe80::1ff:fe23:4567:890a\n" +
                "12.345 Sys [Info]: Logged in as ann (public IP 8.8.8.8)\n" +
                "Time: 17:16:49 Version=1.0.0.0";
            string clean = Redact.Text(text, homes);
            Assert.Contains("in ~/src/a.cs:line 3", clean);
            Assert.Contains("/srv/anna/keep", clean);
            Assert.Contains("~/x.cs ~/y ~\\z /Users/Shared/s", clean);
            Assert.DoesNotContain("@", clean);
            Assert.DoesNotContain("192.168", clean);
            Assert.DoesNotContain("fe80", clean);
            Assert.DoesNotContain("Logged in", clean);
            Assert.Contains(Redact.LogLineMarker, clean);
            Assert.Contains("17:16:49", clean);
            Assert.Contains("Version=1.0.0.0", clean);
        }

        [Fact]
        public void FileNameFollowsTheMinecraftLayout()
        {
            var time = new DateTimeOffset(2026, 11, 27, 17, 16, 49, TimeSpan.FromHours(3));
            Assert.Equal("crash-2026-11-27_17.16.49-scan.txt", CrashReport.FileName(time, "scan"));
            Assert.Equal("crash-2026-11-27_17.16.49-ocr-suite.txt", CrashReport.FileName(time, "OCR suite"));
        }

        [Fact]
        public void ReportHasTheLayoutAndNoHomePath()
        {
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            var error = new InvalidOperationException("failed at " + Path.Combine(home, "secret.txt") + " for a@b.example");
            string written = CrashReport.Write(error, "scan", null, _dir, DateTimeOffset.Now);
            Assert.NotNull(written);
            string text = File.ReadAllText(Directory.GetFiles(_dir).Single());
            Assert.StartsWith(CrashReport.Header, text);
            Assert.Contains("Description: GEN-", text);
            Assert.Contains("-- System Details --", text);
            Assert.Contains("WFInfo-ext Settings:", text);
            Assert.DoesNotContain(home + "/", text);
            Assert.Contains("~/secret.txt", text);
            Assert.DoesNotContain("a@b.example", text);
        }

        [Fact]
        public void KeepsTheNewestTwentyReports()
        {
            var start = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
            for (int i = 0; i < 25; i++)
                CrashReport.Write(new ScanFailure("SCN-003"), "scan", null, _dir, start.AddSeconds(i));
            string[] names = Directory.GetFiles(_dir).Select(Path.GetFileName).OrderBy(n => n, StringComparer.Ordinal).ToArray();
            Assert.Equal(CrashReport.Keep, names.Length);
            Assert.Equal(CrashReport.FileName(start.AddSeconds(5), "scan"), names[0]);
            Assert.Equal(CrashReport.FileName(start.AddSeconds(24), "scan"), names[^1]);
        }

        [Fact]
        public void TwoReportsInOneSecondBothSurvive()
        {
            DateTimeOffset now = DateTimeOffset.Now;
            CrashReport.Write(new ScanFailure("SCN-003"), "scan", null, _dir, now);
            CrashReport.Write(new ScanFailure("SCN-003"), "scan", null, _dir, now);
            Assert.Equal(2, Directory.GetFiles(_dir).Length);
        }

        [Fact]
        public void QuipIsDeterministic()
        {
            Assert.Equal(CrashReport.Quip("CAP-001"), CrashReport.Quip("CAP-001"));
            Assert.Contains(CrashReport.Quip("GEN-a121f2"), CrashReport.Quips);
        }
    }
}
