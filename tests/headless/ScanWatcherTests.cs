using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using WFInfo.Scan;
using Xunit;

namespace WFInfo.Headless.Tests
{
    /// <summary>The EE.log watch with a counting stand-in for the scan. Needs no game and no capture.</summary>
    public sealed class ScanWatcherTests : IDisposable
    {
        private const string Secret = "someone@example.invalid";
        private static readonly TimeSpan Limit = TimeSpan.FromSeconds(30);

        private readonly EnvScope _env = new EnvScope(("WFINFO_OCR_ENGINE", "tesseract"));
        private readonly TempDir _dir = new TempDir();
        private readonly SharedWriter _output = new SharedWriter();
        private readonly CancellationTokenSource _stop = new CancellationTokenSource(Limit);
        private readonly string _log;
        private int _scans;

        public ScanWatcherTests() => _log = _dir.Write("logs/EE.log", "Got rewards (before the watch)\n");

        public void Dispose()
        {
            _stop.Cancel();
            _stop.Dispose();
            _dir.Dispose();
            _env.Dispose();
        }

        private Task<int> Watch(int scanExit, params string[] options)
        {
            var watcher = new ScanWatcher(
                _log, ScanOptions.Parse(options),
                () =>
                {
                    Interlocked.Increment(ref _scans);
                    _output.WriteLine("scan ran");
                    return Task.FromResult(scanExit);
                },
                _output);
            Task<int> run = Task.Run(() => watcher.RunAsync(_stop.Token));
            _output.WaitFor("trigger:");
            return run;
        }

        [Fact]
        public async Task Once_runs_one_scan_for_the_first_new_trigger_and_returns_its_exit_code()
        {
            Task<int> run = Watch(7, "--once");

            File.AppendAllText(_log, $"Sys [Info]: {Secret}\nScript [Info]: Got rewards {Secret}\n");

            Assert.Equal(7, await run.WaitAsync(Limit));
            Assert.Equal(1, _scans);
            Assert.Contains("reward screen detected: \"Got rewards\"", _output.ToString());
            // EE.log holds private data: only the trigger phrase may be printed.
            Assert.DoesNotContain(Secret, _output.ToString());
        }

        [Fact]
        public async Task A_second_trigger_inside_the_cooldown_is_ignored_and_a_stop_exits_cleanly()
        {
            Task<int> run = Watch(1, "--watch", "--cooldown", "600");

            File.AppendAllText(_log, "Got rewards\nPause countdown done\n");
            _output.WaitFor("trigger ignored (cooldown): \"Pause countdown done\"");
            await _stop.CancelAsync();

            Assert.Equal(0, await run.WaitAsync(Limit));
            Assert.Equal(1, _scans);
            Assert.Contains("Stopped watching.", _output.ToString());
        }

        [Fact]
        public async Task Without_a_cooldown_every_trigger_scans()
        {
            Task<int> run = Watch(0, "--watch", "--cooldown", "0");

            File.AppendAllText(_log, "Got rewards\n");
            _output.WaitFor("scan ran");
            File.AppendAllText(_log, "Got rewards\n");
            Assert.True(SpinWait.SpinUntil(() => Volatile.Read(ref _scans) == 2, Limit), _output.ToString());

            await _stop.CancelAsync();
            await run.WaitAsync(Limit);
        }

        [Fact]
        public async Task A_lost_log_folder_falls_back_to_polling_and_the_watcher_comes_back()
        {
            Task<int> run = Watch(0, "--once");
            string folder = Path.GetDirectoryName(_log);

            Directory.Delete(folder, recursive: true);
            _output.WaitFor("polling every 250 ms");

            // The retry runs 10 s after the failure.
            Directory.CreateDirectory(folder);
            File.WriteAllText(_log, "session two\n");
            _output.WaitFor("file events on again");

            File.AppendAllText(_log, "Got rewards\n");
            Assert.Equal(0, await run.WaitAsync(Limit));
            Assert.Equal(1, _scans);
        }
    }
}
