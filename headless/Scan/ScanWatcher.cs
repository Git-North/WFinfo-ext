using System;
using System.IO;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;

namespace WFInfo.Scan
{
    /// <summary>
    /// Automatic scanning: watch Warframe's EE.log and start a scan each time the
    /// game announces a reward screen, the Linux/macOS equivalent of the Windows
    /// app's "Auto" mode (WFInfo/Data.cs, LogChanged → AutoTriggered; that app
    /// reads the same lines from the game's debug output, not from the file).
    ///
    /// The expensive parts — OCR engines, the market sheet, the price cache — are
    /// built once by the caller and reused, so the work per trigger is one
    /// capture plus the OCR, which is what keeps the answer fast.
    ///
    /// The watch is event-based on every OS: a FileSystemWatcher on the log's
    /// directory, filtered to the log's name (inotify on Linux, FSEvents on
    /// macOS, ReadDirectoryChangesW on Windows), so a replaced log is still
    /// seen. A slow backup poll (3 s) covers missed events and a new session's
    /// replacement. A buffer overflow only forces a read. Any other watcher
    /// error (for example the inotify watch limit) or a missing directory
    /// switches to a 250 ms poll and retries the watcher every 10 s.
    ///
    /// Under Wine/Proton/CrossOver the game writes EE.log into a normal host
    /// folder, so host file events fire; the game may buffer its writes, so a
    /// trigger can arrive late, which the scan's re-capture wait absorbs.
    /// Only the trigger phrase of a matching line is ever printed.
    /// </summary>
    internal sealed class ScanWatcher
    {
        /// <summary>EE.log poll interval. The reward window is ~20 s; this is prompt.</summary>
        private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(250);

        /// <summary>Backup poll while file events drive the tail (missed events, rotation).</summary>
        private static readonly TimeSpan BackupPollInterval = TimeSpan.FromSeconds(3);

        /// <summary>After a watcher failure, how long the 250 ms poll runs before the watcher is retried.</summary>
        private static readonly TimeSpan WatcherRetryInterval = TimeSpan.FromSeconds(10);

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

            // Null means: poll every PollInterval until the watcher is retried.
            LogEvents events = LogEvents.TryStart(_logPath, _out, quiet: false);
            DateTime retryWatcherAt = events == null ? DateTime.UtcNow + WatcherRetryInterval : DateTime.MaxValue;
            try
            {
                while (!cancellation.IsCancellationRequested)
                {
                    // Only trigger phrases come back: the rest of EE.log stays inside LogTail.
                    foreach (string trigger in tail.ReadNewMatches(EeLog.MatchTrigger))
                    {
                        TimeSpan sinceLast = DateTime.UtcNow - lastScanUtc;
                        if (sinceLast.TotalSeconds < _options.CooldownSeconds)
                        {
                            _out.WriteLine($"  trigger ignored (cooldown): \"{trigger}\"");
                            continue;
                        }

                        _out.WriteLine($"  reward screen detected: \"{trigger}\"");
                        lastScanUtc = DateTime.UtcNow;
                        lastExit = await _scan().ConfigureAwait(false);

                        if (_options.Once) return lastExit;
                    }

                    string failure = events?.FailureReason;
                    if (failure != null)
                    {
                        _out.WriteLine(
                            $"  file events stopped ({failure}); " +
                            $"polling every {PollInterval.TotalMilliseconds:0} ms, " +
                            $"retrying the watcher every {WatcherRetryInterval.TotalSeconds:0} s");
                        events.Dispose();
                        events = null;
                        retryWatcherAt = DateTime.UtcNow + WatcherRetryInterval;
                    }
                    else if (events == null && DateTime.UtcNow >= retryWatcherAt)
                    {
                        events = LogEvents.TryStart(_logPath, _out, quiet: true);
                        retryWatcherAt = events == null ? DateTime.UtcNow + WatcherRetryInterval : DateTime.MaxValue;
                        if (events != null) _out.WriteLine("  file events on again");
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
            /// Starts the watcher, or returns null when it cannot start (the
            /// caller then polls). Prints one line unless <paramref name="quiet"/>.
            /// </summary>
            public static LogEvents TryStart(string logPath, TextWriter output, bool quiet)
            {
                try
                {
                    string full = Path.GetFullPath(logPath);
                    var events = new LogEvents(Path.GetDirectoryName(full), Path.GetFileName(full));
                    if (!quiet)
                        output.WriteLine(
                            $"  file events on · backup poll every {BackupPollInterval.TotalSeconds:0} s");
                    return events;
                }
                catch (Exception error) when (error is ArgumentException || error is IOException
                    || error is UnauthorizedAccessException || error is PlatformNotSupportedException)
                {
                    if (!quiet)
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
                // A full event buffer only means events were lost: the watcher
                // still works, and the read below catches up. Any other error
                // stops the watcher (the loop then polls and retries).
                if (!(e.GetException() is InternalBufferOverflowException))
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
