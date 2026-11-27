using System;
using System.Text.RegularExpressions;
using Newtonsoft.Json.Linq;

namespace WFInfo.Errors
{
    /// <summary>
    /// Turns what other components report into catalog codes: a code at the
    /// start of a text (the Swift helper's "[CAP-001] ..." on stderr, or a
    /// <see cref="ScanFailure"/> message "CAP-001 Shutter: ..."), an error
    /// object in any component's JSON (the Rust layout's
    /// {"error":{"code":"LAY-001","message":"..."}}, the overlay crate's
    /// {"ok":false,"error":{"code":"PLG-001","name":"...","message":"..."}}),
    /// and a missing native library (SYS-005, SYS-006, SYS-007).
    /// </summary>
    internal static class ErrorMapping
    {
        private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(1);

        private static readonly Regex CodePattern = new Regex(
            @"^(?:[A-Z]{3}-\d{3}|GEN-[0-9a-f]{6})$",
            RegexOptions.CultureInvariant, Timeout);

        // "[CAP-001] text", "CAP-001 Shutter: text", "CAP-001: text" or the code alone.
        private static readonly Regex LeadingCode = new Regex(
            @"^\s*(?:\[(?<code>[A-Z]{3}-\d{3}|GEN-[0-9a-f]{6})\]|(?<code>[A-Z]{3}-\d{3}|GEN-[0-9a-f]{6})(?=[\s:]|$)):?\s*(?<rest>.*)$",
            RegexOptions.CultureInvariant | RegexOptions.Singleline, Timeout);

        /// <summary>True for a well-formed code: AAA-000 or GEN-xxxxxx.</summary>
        public static bool IsCode(string code)
        {
            if (string.IsNullOrEmpty(code)) return false;
            try
            {
                return CodePattern.IsMatch(code);
            }
            catch (RegexMatchTimeoutException)
            {
                return false;
            }
        }

        /// <summary>
        /// Reads a code at the start of <paramref name="text"/>. On success,
        /// <paramref name="rest"/> is the text after the code.
        /// </summary>
        public static bool TryParseCode(string text, out string code, out string rest)
        {
            code = null;
            rest = text;
            if (string.IsNullOrEmpty(text)) return false;
            Match match;
            try
            {
                match = LeadingCode.Match(text);
            }
            catch (RegexMatchTimeoutException)
            {
                return false;
            }
            if (!match.Success) return false;
            code = match.Groups["code"].Value;
            rest = match.Groups["rest"].Value.Trim();
            return true;
        }

        /// <summary>The code at the start of an error text, or null (for scan records: Error → ErrorCode).</summary>
        public static string CodeOf(string text) => TryParseCode(text, out string code, out _) ? code : null;

        /// <summary>A failure for a text that starts with a code, or null when it has none.</summary>
        public static ScanFailure FromCodedText(string text, Exception inner = null)
        {
            if (!TryParseCode(text, out string code, out string rest)) return null;
            return new ScanFailure(code, string.IsNullOrEmpty(rest) ? null : rest, inner);
        }

        /// <summary>
        /// A failure for an error in a component's JSON answer. Takes the
        /// "error" value itself or the whole answer (then its "error" member):
        /// an object with "code" (and "message", optional "name"), or a plain
        /// string (which may start with a code). A missing or malformed code
        /// gives <paramref name="fallbackCode"/>. Null when there is no error.
        /// </summary>
        public static ScanFailure FromJson(JToken error, string fallbackCode)
        {
            if (error is JObject answer && answer["error"] != null && answer["code"] == null) error = answer["error"];
            if (error == null || error.Type == JTokenType.Null) return null;

            if (error is JObject entry)
            {
                string code = entry["code"]?.Type == JTokenType.String ? entry["code"].ToString().Trim() : null;
                string message = entry["message"]?.Type == JTokenType.String ? entry["message"].ToString() : null;
                string name = entry["name"]?.Type == JTokenType.String ? entry["name"].ToString() : null;
                if (!IsCode(code))
                {
                    message = string.IsNullOrEmpty(code) ? message : code + ": " + message;
                    code = fallbackCode;
                }
                return new ScanFailure(code, string.IsNullOrWhiteSpace(message) ? null : message.Trim()) { ReportedName = name };
            }

            string text = error.Type == JTokenType.String ? error.ToString() : error.ToString(Newtonsoft.Json.Formatting.None);
            return FromCodedText(text) ?? new ScanFailure(fallbackCode, string.IsNullOrWhiteSpace(text) ? null : text.Trim());
        }

        /// <summary>
        /// The SYS- code for a native library name or a loader message:
        /// wfinfo_layout → SYS-005, gdiplus → SYS-006, tesseract or leptonica
        /// → SYS-007; null for any other library.
        /// </summary>
        public static string LibraryCode(string text)
        {
            if (string.IsNullOrEmpty(text)) return null;
            if (text.Contains("wfinfo_layout", StringComparison.OrdinalIgnoreCase)) return "SYS-005";
            if (text.Contains("gdiplus", StringComparison.OrdinalIgnoreCase)) return "SYS-006";
            if (text.Contains("tesseract", StringComparison.OrdinalIgnoreCase) ||
                text.Contains("leptonica", StringComparison.OrdinalIgnoreCase)) return "SYS-007";
            return null;
        }

        /// <summary>
        /// A failure for a missing native library anywhere in the exception
        /// chain (DllNotFoundException, EntryPointNotFoundException, or one
        /// wrapped in a TypeInitializationException); null for anything else.
        /// </summary>
        public static ScanFailure FromNative(Exception error)
        {
            for (Exception e = error; e != null; e = e.InnerException)
            {
                if (e is ScanFailure) return null;
                if (e is DllNotFoundException || e is EntryPointNotFoundException)
                {
                    string code = LibraryCode(e.Message);
                    if (code != null) return new ScanFailure(code, Redact.Text(e.Message), error);
                }
            }
            return null;
        }
    }
}
