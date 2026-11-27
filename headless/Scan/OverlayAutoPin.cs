using System;
using System.Threading;
using System.Threading.Tasks;

namespace WFInfo.Scan
{
    /// <summary>
    /// Pins the overlay window while a reward screen with new names is up, in
    /// the watch only (a manual scan has no screen-end line to unpin on).
    ///
    /// Rules: pin only when the "overlayPin" setting is on and the published
    /// record shows names that this screen has not pinned for yet; unpin when
    /// EE.log shows the screen ended, and only when our own pin changed the
    /// window (a window the user pinned stays pinned). Calls run one after
    /// another in the background, so a pin finishes before its unpin and the
    /// scan never waits. A failure never fails a scan: it is reported through
    /// the callback.
    /// </summary>
    internal sealed class OverlayAutoPin
    {
        private const string PinCommand = "pin";
        private const string UnpinCommand = "unpin";

        private readonly Func<bool> _enabled;
        private readonly Func<string, Task<OverlayPinResult>> _send;
        private readonly Action<string, OverlayPinResult, ScanResult> _onFailure;
        private readonly object _gate = new object();

        private ScanResult _screen;
        private Task _chain = Task.CompletedTask;
        private bool _ourPin;

        /// <param name="enabled">Reads the "overlayPin" setting now.</param>
        /// <param name="send">Sends "pin" or "unpin" for the browser window.</param>
        /// <param name="onFailure">Called with the command, the failed answer and the record that caused a pin (null for an unpin).</param>
        public OverlayAutoPin(Func<bool> enabled, Func<string, Task<OverlayPinResult>> send,
            Action<string, OverlayPinResult, ScanResult> onFailure)
        {
            _enabled = enabled;
            _send = send;
            _onFailure = onFailure;
        }

        /// <summary>A watch record was published.</summary>
        public void OnPublished(ScanResult record)
        {
            if (!ScanNews.FoundNewNames(_screen, record) || !_enabled()) return;
            _screen = record;
            Enqueue(PinCommand, record);
        }

        /// <summary>EE.log says the reward screen is over.</summary>
        public void OnRewardScreenEnded()
        {
            _screen = null;
            Enqueue(UnpinCommand, null);
        }

        /// <summary>Called before the watch (or a --once run) ends: unpins ours and waits.</summary>
        public Task FlushAsync()
        {
            OnRewardScreenEnded();
            lock (_gate) return _chain;
        }

        private void Enqueue(string command, ScanResult record)
        {
            lock (_gate)
            {
                _chain = RunAfterAsync(_chain, command, record);
            }
        }

        private async Task RunAfterAsync(Task previous, string command, ScanResult record)
        {
            await previous.ConfigureAwait(false);
            await Task.Yield();

            // Unpin only what we pinned. This is checked after the pin finished.
            if (command == UnpinCommand && !Volatile.Read(ref _ourPin)) return;

            OverlayPinResult result;
            try
            {
                result = await _send(command).ConfigureAwait(false);
            }
            catch (Exception ex) when (!(ex is OutOfMemoryException))
            {
                // The wrapper does not throw; this guards the chain all the same.
                Main.AddLog($"Overlay {command} failed: {ex.Message}");
                return;
            }

            if (command == UnpinCommand)
            {
                Volatile.Write(ref _ourPin, false);
            }
            else if (result.Ok && result.Changed(OverlayPin.Browser))
            {
                Volatile.Write(ref _ourPin, true);
            }

            if (!result.Ok) _onFailure(command, result, record);
        }
    }
}
