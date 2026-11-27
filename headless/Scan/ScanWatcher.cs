using System;
using System.IO;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;

namespace WFInfo.Scan
{
    /// <summary>
    /// Automatic scanning: watch Warframe's EE.log and start a scan each time the
    /// game announces a reward screen, the Linux equivalent of the Windows app's
    /// "Auto" mode (WFInfo/Data.cs, LogChanged → AutoTriggered).
    ///
    /// The expensive parts — OCR engines, the market sheet, the price cache — are
    /// built once by the caller and reused, so the work per trigger is one
    /// capture plus the OCR, which is what keeps the answer fast.
    ///
    /// Linux polls the log every 250 ms. macOS reacts to file events instead
    /// (FileSystemWatcher, backed by FSEvents there) and keeps a slow backup
    /// poll for missed events and rotation; if the watcher fails, it falls back
    /// to the 250 ms poll.
    /// </summary>
    internal sealed class ScanWatcher
    {
        /// <summary>EE.log poll interval. The reward window is ~20 s; this is prompt.</summary>
        private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(250);

        /// <summary>Backup poll while file events drive the tail (missed events, rotation).</summary>
        private static readonly TimeSpan BackupPollInterval = TimeSpan.FromSeconds(3);

        private readonly string _logPath;
        private readonly ScanOptions _options;
        private readonly Func<Task<int>> _scan;
        private readonly TextWriter _out;

        public ScanWatcher(string logPath, ScanOptions options, Func<Task<int>> scan, TextWriter output)
        {
            _logPath = logPath;
            _options = options;
            _scan = scan;
            _out = output;
        }

        /// <summary>
        /// Tails EE.log until cancellation. Returns the exit code of the last
        /// scan when <c>--once</c> is set, else 0.
        /// </summary>
        public async Task<int> RunAsync(CancellationToken cancellation)
        {
            var tail = new LogTail(_logPath);
            DateTime lastScanUtc = DateTime.MinValue;
            int lastExit = 0;

            _out.WriteLine($"Watching {_logPath}");
            _out.WriteLine(
                $"  trigger: \"Got rewards\" / \"Pause countdown done\" · " +
                $"re-capture up to {_options.WaitSeconds:0.#} s · cooldown {_options.CooldownSeconds:0.#} s");

            // Null means: poll every PollInterval (Linux, or the macOS fallback).
            LogEvents events = OperatingSystem.IsMacOS() ? LogEvents.TryStart(_logPath, _out) : null;
            try
            {
                while (!cancellation.IsCancellationRequested)
                {
                    foreach (string line in tail.ReadNewLines())
                    {
                        if (!EeLog.IsRewardTrigger(line)) continue;

                        TimeSpan sinceLast = DateTime.UtcNow - lastScanUtc;
                        if (sinceLast.TotalSeconds < _options.CooldownSeconds)
                        {
                            _out.WriteLine($"  trigger ignored (cooldown): {line.Trim()}");
                            continue;
                        }

                        _out.WriteLine($"  reward screen detected: {line.Trim()}");
                        lastScanUtc = DateTime.UtcNow;
                        lastExit = await _scan().ConfigureAwait(false);

                        if (_options.Once) return lastExit;
                    }

                    string failure = events?.FailureReason;
                    if (failure != null)
                    {
                        _out.WriteLine(
                            $"  file events stopped ({failure}); " +
                            $"polling every {PollInterval.TotalMilliseconds:0} ms");
                        events.Dispose();
                        events = null;
                    }

                    try
                    {
                        if (events == null)
                        {
                            await Task.Delay(PollInterval, cancellation).ConfigureAwait(false);
                        }
                        else
                        {
                            await events.WaitAsync(BackupPollInterval, cancellation).ConfigureAwait(false);
                        }
                    }
                    catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
                    {
                        break;
                    }
                }
            }
            finally
            {
                events?.Dispose();
            }

            _out.WriteLine("Stopped watching.");
            return _options.Once ? lastExit : 0;
        }

        /// <summary>
        /// File events for one log file: a FileSystemWatcher on the log's
        /// directory, filtered to its name. Each Changed/Created/Renamed event
        /// puts one wake-up in a single-slot channel (a burst of events
        /// coalesces into one), so the watch loop reads the tail once per
        /// burst and never spins.
        /// </summary>
        private sealed class LogEvents : IDisposable
        {
            private readonly FileSystemWatcher _watcher;
            private readonly string _directory;
            private readonly Channel<bool> _wake = Channel.CreateBounded<bool>(
                new BoundedChannelOptions(1)
                {
                    FullMode = BoundedChannelFullMode.DropWrite,
                    SingleReader = true,
                });
            private volatile string _failure;
            private bool _disposed;

            private LogEvents(string directory, string fileName)
            {
                _directory = directory;
                _watcher = new FileSystemWatcher(directory, fileName)
                {
                    IncludeSubdirectories = false,
                    NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite
                        | NotifyFilters.Size | NotifyFilters.CreationTime,
                };
                _watcher.Changed += OnEvent;
                _watcher.Created += OnEvent;
                _watcher.Renamed += OnEvent;
                _watcher.Error += OnError;
                _watcher.EnableRaisingEvents = true;
            }

            /// <summary>
            /// Starts the watcher, or prints one line and returns null when it
            /// cannot start (the caller then polls).
            /// </summary>
            public static LogEvents TryStart(string logPath, TextWriter output)
            {
                try
                {
                    string full = Path.GetFullPath(logPath);
                    var events = new LogEvents(Path.GetDirectoryName(full), Path.GetFileName(full));
                    output.WriteLine(
                        $"  file events on · backup poll every {BackupPollInterval.TotalSeconds:0} s");
                    return events;
                }
                catch (Exception error) when (error is ArgumentException || error is IOException
                    || error is UnauthorizedAccessException || error is PlatformNotSupportedException)
                {
                    output.WriteLine(
                        $"  file events unavailable ({error.Message}); " +
                        $"polling every {PollInterval.TotalMilliseconds:0} ms");
                    return null;
                }
            }

            /// <summary>Why the events stopped (watcher error, directory gone), or null.</summary>
            public string FailureReason =>
                _failure ?? (Directory.Exists(_directory) ? null : "log directory is gone");

            /// <summary>Waits for a file event or the timeout, whichever comes first.</summary>
            public async Task WaitAsync(TimeSpan timeout, CancellationToken cancellation)
            {
                using var timer = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
                timer.CancelAfter(timeout);
                try
                {
                    await _wake.Reader.ReadAsync(timer.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (!cancellation.IsCancellationRequested)
                {
                    // Timeout: this is the backup poll.
                }
            }

            private void OnEvent(object sender, FileSystemEventArgs e) => _wake.Writer.TryWrite(true);

            private void OnError(object sender, ErrorEventArgs e)
            {
                _failure = e.GetException()?.Message ?? "watcher error";
                _wake.Writer.TryWrite(true);
            }

            public void Dispose()
            {
                if (_disposed) return;
                _disposed = true;
                _watcher.EnableRaisingEvents = false;
                _watcher.Changed -= OnEvent;
                _watcher.Created -= OnEvent;
                _watcher.Renamed -= OnEvent;
                _watcher.Error -= OnError;
                _watcher.Dispose();
            }
        }
    }
}
