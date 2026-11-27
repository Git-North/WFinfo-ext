using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace WFInfo.Scan
{
    /// <summary>
    /// The answer to one <see cref="OverlayPin"/> call. A failure carries a
    /// code and name from errors/catalog.json (PLG-nnn, or GEN- for a bug in
    /// the library) and a message with the home folder written as "~".
    /// </summary>
    internal sealed class OverlayPinResult
    {
        private OverlayPinResult(bool ok, string code, string name, string message, JObject reply)
        {
            Ok = ok;
            ErrorCode = code;
            ErrorName = name;
            Message = message;
            Reply = reply;
        }

        public bool Ok { get; }

        /// <summary>Null on success.</summary>
        public string ErrorCode { get; }

        /// <summary>Null on success.</summary>
        public string ErrorName { get; }

        /// <summary>Null on success.</summary>
        public string Message { get; }

        /// <summary>
        /// The plugin's own answer; null when it sent no readable one. A
        /// failed change keeps it, with what happened to each window.
        /// </summary>
        public JObject Reply { get; }

        /// <summary>
        /// True when this call changed the pin of <paramref name="window"/>.
        /// After a pin, false means the user had pinned it already: leave it
        /// pinned when the reward screen ends.
        /// </summary>
        public bool Changed(string window)
        {
            if (!(Reply?["results"] is JArray results)) return false;
            foreach (JToken result in results)
            {
                if (result is JObject entry
                    && entry["window"]?.ToString() == window
                    && entry["changed"]?.Type == JTokenType.Boolean
                    && (bool)entry["changed"])
                    return true;
            }
            return false;
        }

        internal static OverlayPinResult Failure(string code, string name, string message, JObject reply = null) =>
            new OverlayPinResult(false, code, name, message, reply);

        /// <summary>Reads the library's JSON answer; throws <see cref="JsonException"/> when it is not one.</summary>
        internal static OverlayPinResult Parse(string json)
        {
            JObject answer = JObject.Parse(json);
            var reply = answer["reply"] as JObject;
            if (answer["ok"]?.Type == JTokenType.Boolean && (bool)answer["ok"])
                return new OverlayPinResult(true, null, null, null, reply);
            if (answer["error"] is JObject error && error["code"] != null)
                return Failure((string)error["code"], (string)error["name"], (string)error["message"], reply);
            throw new JsonException("the overlay library's answer has no ok and no error");
        }
    }

    /// <summary>
    /// Pins Steam overlay windows through the user's Overlay Auto-Pin
    /// Millennium plugin. The work is in the Rust library
    /// libwfinfo_overlay (headless/native/overlay), which talks to the
    /// plugin's Unix socket and nothing else. No method throws: a missing
    /// library, a missing plugin and a hung Steam are all results.
    ///
    /// The feature is off by default; this class does not read the setting.
    /// The caller calls it only when the user turned it on.
    /// </summary>
    internal static class OverlayPin
    {
        /// <summary>Steam's overlay web browser, which shows the scan page.</summary>
        public const string Browser = "browser";

        /// <summary>The longest one call may take, retries included (the library's default).</summary>
        public const int DefaultTimeoutMs = 10000;

        private const string Library = "wfinfo_overlay";

        private static readonly Lazy<bool> Loadable = new Lazy<bool>(() =>
            NativeLibrary.TryLoad(Library, typeof(OverlayPin).Assembly,
                DllImportSearchPath.AssemblyDirectory, out _));

        /// <summary>False when libwfinfo_overlay was not built or cannot be loaded.</summary>
        public static bool Available => Loadable.Value;

        /// <summary>Pins a window ("all": every open one). Blocks; see <see cref="RequestAsync"/>.</summary>
        public static OverlayPinResult Pin(string window = Browser, int timeoutMs = DefaultTimeoutMs) =>
            Request("pin", window, timeoutMs);

        /// <summary>Unpins a window ("all": every open one). Blocks.</summary>
        public static OverlayPinResult Unpin(string window = Browser, int timeoutMs = DefaultTimeoutMs) =>
            Request("unpin", window, timeoutMs);

        /// <summary>
        /// One call: "list", "status" (both without a window), "pin", "unpin"
        /// or "toggle". Blocks for at most <paramref name="timeoutMs"/>.
        /// </summary>
        public static OverlayPinResult Request(string command, string window = null, int timeoutMs = DefaultTimeoutMs)
        {
            var request = new JObject { ["cmd"] = command, ["timeoutMs"] = timeoutMs };
            if (window != null) request["window"] = window;
            return Send(request);
        }

        /// <summary><see cref="Request"/> on the thread pool, so a busy plugin does not delay a scan.</summary>
        public static Task<OverlayPinResult> RequestAsync(string command, string window = null, int timeoutMs = DefaultTimeoutMs) =>
            Task.Run(() => Request(command, window, timeoutMs));

        /// <summary>
        /// Sends a request object in the library's own form, which also takes
        /// "refresh" and "socket" (see headless/native/overlay/src/lib.rs).
        /// </summary>
        public static OverlayPinResult Send(JObject request)
        {
            if (!Available)
                return OverlayPinResult.Failure("PLG-019", "Cupboard",
                    "the overlay client library (libwfinfo_overlay) is not next to the runner or cannot be loaded");
            byte[] bytes = Encoding.UTF8.GetBytes(request.ToString(Formatting.None) + "\0");
            try
            {
                IntPtr answer = NativeOverlay(bytes);
                if (answer == IntPtr.Zero) return Unusable("it returned nothing");
                try
                {
                    return OverlayPinResult.Parse(Marshal.PtrToStringUTF8(answer));
                }
                finally
                {
                    NativeOverlayFree(answer);
                }
            }
            catch (EntryPointNotFoundException)
            {
                return Unusable("it does not have the expected functions");
            }
            catch (Exception ex) when (ex is JsonException || ex is ArgumentException || ex is InvalidCastException)
            {
                return Unusable("its answer is not readable");
            }
        }

        private static OverlayPinResult Unusable(string why) =>
            OverlayPinResult.Failure("PLG-020", "Sprocket",
                "the overlay client library (libwfinfo_overlay) cannot be used: " + why);

        [DllImport(Library, EntryPoint = "wfinfo_overlay")]
        [DefaultDllImportSearchPaths(DllImportSearchPath.AssemblyDirectory)]
        private static extern IntPtr NativeOverlay(byte[] requestUtf8);

        [DllImport(Library, EntryPoint = "wfinfo_overlay_free")]
        [DefaultDllImportSearchPaths(DllImportSearchPath.AssemblyDirectory)]
        private static extern void NativeOverlayFree(IntPtr answer);
    }
}
