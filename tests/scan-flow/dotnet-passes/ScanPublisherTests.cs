using System;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using WFInfo.Scan;
using Xunit;

namespace WFInfo.Tests.ScanPasses
{
    /// <summary>
    /// The keep-last-good rule on a temporary scans folder (the publisher takes
    /// its folder as an argument, so no test touches the app dir).
    /// </summary>
    public sealed class ScanPublisherTests : IDisposable
    {
        private static readonly DateTime At1432 = new DateTime(2026, 11, 27, 14, 32, 5, DateTimeKind.Local);
        private readonly string _dir = Path.Combine(Path.GetTempPath(), "wfinfo-passes-" + Guid.NewGuid().ToString("N"));
        private readonly ScanPublisher _publisher;

        public ScanPublisherTests()
        {
            Directory.CreateDirectory(_dir);
            _publisher = new ScanPublisher(_dir, processId: 4242);
        }

        public void Dispose() => Directory.Delete(_dir, recursive: true);

        private ScanResult Publish(ScanResult attempt, string screenshotBytes, out bool kept)
        {
            if (screenshotBytes != null) File.WriteAllText(_publisher.PendingScreenshot, screenshotBytes);
            return _publisher.Publish(attempt, At1432, out kept);
        }

        private ScanResult Latest() =>
            JsonConvert.DeserializeObject<ScanResult>(File.ReadAllText(_publisher.LatestPath));

        private ScanResult[] History() =>
            Directory.GetFiles(_dir, "scan-*.json").OrderBy(f => f, StringComparer.Ordinal)
                .Select(f => JsonConvert.DeserializeObject<ScanResult>(File.ReadAllText(f))).ToArray();

        [Fact]
        public void NothingFoundKeepsTheLastGoodRecordAndScreenshot()
        {
            ScanResult good = ScanNewsTests.Record("Forma Blueprint");
            good.ScanId = "good";
            Publish(good, "good-png", out bool keptFirst);
            Assert.False(keptFirst);

            ScanResult empty = ScanNewsTests.Record();
            empty.ScanId = "empty";
            ScanResult published = Publish(empty, "empty-png", out bool kept);

            Assert.True(kept);
            Assert.Equal("good", published.ScanId);
            Assert.Equal("Last scan found nothing at 14:32", Latest().Notice);
            Assert.Equal("good", Latest().ScanId);
            Assert.Equal("good-png", File.ReadAllText(_publisher.ScreenshotPath));
            Assert.False(File.Exists(_publisher.PendingScreenshot));
            Assert.False(File.Exists(_publisher.PendingRecord));

            ScanResult[] history = History();
            Assert.Equal(2, history.Length);
            Assert.Equal("empty", history[1].ScanId);
            Assert.Equal("SCN-001", history[1].ErrorCode);
            Assert.Equal("Hollow", history[1].ErrorName);
            Assert.Null(history[1].Error);
            Assert.Null(history[1].Notice);
        }

        [Fact]
        public void FailureNoticeNamesTheCode()
        {
            Publish(ScanNewsTests.Record("Forma Blueprint"), "good-png", out _);
            var failed = new ScanResult { Error = "Screen Recording is off", ErrorCode = "CAP-001", ErrorName = "Shutter" };
            Publish(failed, null, out bool kept);

            Assert.True(kept);
            Assert.Equal("Last scan failed at 14:32: CAP-001 Shutter", Latest().Notice);
            Assert.Equal("CAP-001", History()[1].ErrorCode);
        }

        [Fact]
        public void WithoutAGoodRecordTheEmptyRecordIsPublished()
        {
            ScanResult empty = ScanNewsTests.Record();
            empty.ScanId = "empty";
            Publish(empty, "empty-png", out bool kept);

            Assert.False(kept);
            Assert.Equal("empty", Latest().ScanId);
            Assert.Equal("SCN-001", Latest().ErrorCode);
            Assert.Null(Latest().Notice);
            Assert.Equal("empty-png", File.ReadAllText(_publisher.ScreenshotPath));
        }

        [Fact]
        public void ANewGoodRecordClearsTheNotice()
        {
            Publish(ScanNewsTests.Record("Forma Blueprint"), "a", out _);
            Publish(ScanNewsTests.Record(), "b", out _);
            Assert.NotNull(Latest().Notice);

            ScanResult next = ScanNewsTests.Record("Volt Prime Blueprint");
            next.ScanId = "next";
            Publish(next, "c", out bool kept);

            Assert.False(kept);
            Assert.Equal("next", Latest().ScanId);
            Assert.Null(Latest().Notice);
            Assert.Equal("c", File.ReadAllText(_publisher.ScreenshotPath));
            Assert.Equal(3, History().Length);
        }

        [Fact]
        public void DecideIsPureAndCopiesThePreviousRecord()
        {
            ScanResult previous = ScanNewsTests.Record("Forma Blueprint");
            ScanResult kept = ScanPublisher.Decide(ScanNewsTests.Record(), previous, At1432, out bool keptPrevious);
            Assert.True(keptPrevious);
            Assert.NotSame(previous, kept);
            Assert.Null(previous.Notice);
            Assert.Equal("Last scan found nothing at 14:32", kept.Notice);
        }
    }
}
