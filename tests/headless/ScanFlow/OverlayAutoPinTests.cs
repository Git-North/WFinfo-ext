using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using Newtonsoft.Json;
using WFInfo.Scan;
using Xunit;

namespace WFInfo.Tests.ScanPasses
{
    /// <summary>The overlay pin rules, with a stand-in for the plugin call.</summary>
    public sealed class OverlayAutoPinTests
    {
        private readonly List<string> _sent = new List<string>();
        private readonly List<string> _failures = new List<string>();
        private bool _enabled = true;
        private bool _changed = true;
        private bool _ok = true;

        private OverlayAutoPin Create() => new OverlayAutoPin(
            () => _enabled,
            command =>
            {
                lock (_sent) _sent.Add(command);
                return Task.FromResult(OverlayPinResult.Parse(_ok
                    ? "{\"ok\":true,\"reply\":{\"results\":[{\"window\":\"browser\",\"changed\":" + (_changed ? "true" : "false") + "}]}}"
                    : "{\"ok\":false,\"error\":{\"code\":\"PLG-006\",\"name\":\"Signpost\",\"message\":\"no socket\"}}"));
            },
            (command, result, record) => _failures.Add(command + " " + result.ErrorCode));

        [Fact]
        public async Task NewNamesPinOnceAndTheScreenEndUnpins()
        {
            OverlayAutoPin pin = Create();
            pin.OnPublished(ScanNewsTests.Record("Forma Blueprint"));
            pin.OnPublished(ScanNewsTests.Record("Forma Blueprint")); // the same answer again
            await pin.FlushAsync();

            Assert.Equal(new[] { "pin", "unpin" }, _sent);
        }

        [Fact]
        public async Task NothingNewSendsNothing()
        {
            OverlayAutoPin pin = Create();
            pin.OnPublished(ScanNewsTests.Record());
            await pin.FlushAsync();

            Assert.Empty(_sent);
        }

        [Fact]
        public async Task TheSettingOffSendsNothing()
        {
            _enabled = false;
            OverlayAutoPin pin = Create();
            pin.OnPublished(ScanNewsTests.Record("Forma Blueprint"));
            await pin.FlushAsync();

            Assert.Empty(_sent);
        }

        [Fact]
        public async Task AWindowTheUserPinnedIsNotUnpinned()
        {
            _changed = false; // our pin did not change it
            OverlayAutoPin pin = Create();
            pin.OnPublished(ScanNewsTests.Record("Forma Blueprint"));
            await pin.FlushAsync();

            Assert.Equal(new[] { "pin" }, _sent);
        }

        [Fact]
        public async Task AFailedPinIsReportedAndNotUnpinned()
        {
            _ok = false;
            OverlayAutoPin pin = Create();
            pin.OnPublished(ScanNewsTests.Record("Forma Blueprint"));
            await pin.FlushAsync();

            Assert.Equal(new[] { "pin" }, _sent);
            Assert.Equal(new[] { "pin PLG-006" }, _failures);
        }

        [Fact]
        public async Task TheNextScreenPinsAgainEvenWithTheSameNames()
        {
            OverlayAutoPin pin = Create();
            pin.OnPublished(ScanNewsTests.Record("Forma Blueprint"));
            pin.OnRewardScreenEnded();
            pin.OnPublished(ScanNewsTests.Record("Forma Blueprint"));
            await pin.FlushAsync();

            Assert.Equal(new[] { "pin", "unpin", "pin", "unpin" }, _sent);
        }

        [Theory]
        [InlineData("1.0 Sys [Info]: MatchingService::EndSession", "MatchingService::EndSession")]
        [InlineData("2.0 Script [Info]: Relic timer closed", "Relic timer closed")]
        public void TheEndLinesMatchAndOnlyTheirPhraseLeaves(string line, string phrase)
        {
            Assert.Equal(phrase, EeLog.MatchRewardEnd(line));
            Assert.Equal(phrase, EeLog.MatchWatchLine(line));
            Assert.Null(EeLog.MatchTrigger(line));
        }

        [Fact]
        public void APrivateLineMatchesNothing()
        {
            Assert.Null(EeLog.MatchWatchLine("3.0 Sys [Info]: Account email someone@example.invalid"));
        }

        [Fact]
        public void ALateNoticeIsAddedOnlyToItsOwnScan()
        {
            string dir = Path.Combine(Path.GetTempPath(), "wfinfo-autopin-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            try
            {
                var publisher = new ScanPublisher(dir, processId: 4343);
                ScanResult record = ScanNewsTests.Record("Forma Blueprint");
                record.ScanId = "mine";
                publisher.Publish(record, DateTime.Now, out _);

                publisher.AddNotice("someone-else", "wrong");
                Assert.Null(JsonConvert.DeserializeObject<ScanResult>(File.ReadAllText(publisher.LatestPath)).Notice);

                publisher.AddNotice("mine", "Overlay pin failed: PLG-006 Signpost");
                Assert.Equal("Overlay pin failed: PLG-006 Signpost",
                    JsonConvert.DeserializeObject<ScanResult>(File.ReadAllText(publisher.LatestPath)).Notice);
            }
            finally
            {
                Directory.Delete(dir, recursive: true);
            }
        }
    }
}
