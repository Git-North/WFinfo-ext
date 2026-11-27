using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using Newtonsoft.Json.Linq;

namespace WFInfo.Errors
{
    /// <summary>One catalog entry (errors/catalog.json), or a generated one.</summary>
    internal sealed class ErrorInfo
    {
        public ErrorInfo(string code, string name, string area, string severity, string title, string description, string action, bool generated)
        {
            Code = code;
            Name = name;
            Area = area;
            Severity = severity;
            Title = title;
            Description = description;
            Action = action;
            Generated = generated;
        }

        public string Code { get; }
        public string Name { get; }
        public string Area { get; }
        public string Severity { get; }
        public string Title { get; }
        public string Description { get; }
        public string Action { get; }

        /// <summary>True for a GEN- code made from an exception that has no catalog entry.</summary>
        public bool Generated { get; }

        /// <summary>"CAP-001 Shutter: Screen Recording not allowed".</summary>
        public override string ToString() => $"{Code} {Name}: {Title}";
    }

    /// <summary>
    /// A failure with a catalog code. Throw it where the cause is known; the
    /// detail is extra context for the record and the crash report and must
    /// never hold personal data (no EE.log text, IP, e-mail or home path).
    /// </summary>
    internal sealed class ScanFailure : Exception
    {
        public ScanFailure(string code, string detail = null, Exception inner = null)
            : base(BuildMessage(code, detail), inner)
        {
            Code = code;
            Detail = detail;
        }

        public string Code { get; }
        public string Detail { get; }
        public ErrorInfo Info => ErrorCatalog.Get(Code);

        private static string BuildMessage(string code, string detail)
        {
            ErrorInfo info = ErrorCatalog.Get(code);
            string head = info == null ? code : info.ToString();
            return string.IsNullOrEmpty(detail) ? head : head + " (" + detail + ")";
        }
    }

    /// <summary>
    /// The shared error catalog (errors/catalog.json, embedded in the runner).
    /// See errors/AGENTS.md for the format and the generated-code rule.
    /// </summary>
    internal static class ErrorCatalog
    {
        private const string ResourceName = "WFInfo.errors.catalog.json";
        private const uint FnvOffset = 0x811c9dc5;
        private const uint FnvPrime = 0x01000193;

        private static readonly Lazy<Catalog> Loaded = new Lazy<Catalog>(Load);

        public static IReadOnlyList<ErrorInfo> All => Loaded.Value.Entries;

        /// <summary>The entry for a code, or null when the catalog has none.</summary>
        public static ErrorInfo Get(string code)
        {
            if (string.IsNullOrEmpty(code)) return null;
            return Loaded.Value.ByCode.TryGetValue(code, out ErrorInfo info) ? info : null;
        }

        /// <summary>
        /// The error for an exception: its catalog entry when it is a
        /// <see cref="ScanFailure"/> with a known code, else a generated
        /// GEN- entry from the exception type and its throwing site.
        /// </summary>
        public static ErrorInfo ForException(Exception error)
        {
            if (error is ScanFailure failure && Get(failure.Code) is ErrorInfo known) return known;
            string input = (error?.GetType().FullName ?? "null") + "|" + Site(error);
            return Generated(input);
        }

        /// <summary>A generated entry for an input text (the rule and test vectors are in the catalog).</summary>
        public static ErrorInfo Generated(string input)
        {
            uint hash = Fnv1a32(input ?? string.Empty);
            IReadOnlyList<string> words = Loaded.Value.Words;
            string code = "GEN-" + ((hash >> 8) & 0xFFFFFF).ToString("x6", System.Globalization.CultureInfo.InvariantCulture);
            string name = words.Count == 0 ? "Unknown" : words[(int)(hash % (uint)words.Count)];
            return new ErrorInfo(code, name, "GEN", "error", "Unexpected error",
                "An error happened that has no catalog entry. The same bug always gets the same code.",
                "Look at the crash report in crash-reports/ and report the code with it.",
                generated: true);
        }

        /// <summary>FNV-1a, 32 bit, over the UTF-8 bytes of the text.</summary>
        public static uint Fnv1a32(string text)
        {
            uint hash = FnvOffset;
            foreach (byte b in Encoding.UTF8.GetBytes(text))
            {
                hash ^= b;
                hash *= FnvPrime;
            }
            return hash;
        }

        /// <summary>
        /// Namespace.Type.Method of the innermost stack frame in WFInfo-ext code
        /// (namespace WFInfo), no line numbers; empty when there is none.
        /// </summary>
        public static string Site(Exception error)
        {
            if (error == null) return string.Empty;
            Exception innermost = error;
            while (innermost.InnerException != null) innermost = innermost.InnerException;
            foreach (StackFrame frame in new StackTrace(innermost, false).GetFrames() ?? Array.Empty<StackFrame>())
            {
                MethodBase method = frame.GetMethod();
                Type type = method?.DeclaringType;
                if (type?.FullName == null || !type.FullName.StartsWith("WFInfo", StringComparison.Ordinal)) continue;
                // Async and lambda state machines: report the method they belong to.
                string typeName = type.FullName;
                string methodName = method.Name;
                int angle = typeName.IndexOf("+<", StringComparison.Ordinal);
                if (angle >= 0)
                {
                    int close = typeName.IndexOf('>', angle);
                    if (close > angle + 2) methodName = typeName.Substring(angle + 2, close - angle - 2);
                    typeName = typeName.Substring(0, angle);
                }
                return typeName.Replace('+', '.') + "." + methodName;
            }
            return string.Empty;
        }

        private sealed class Catalog
        {
            public List<ErrorInfo> Entries { get; } = new List<ErrorInfo>();
            public Dictionary<string, ErrorInfo> ByCode { get; } = new Dictionary<string, ErrorInfo>(StringComparer.Ordinal);
            public List<string> Words { get; } = new List<string>();
        }

        private static Catalog Load()
        {
            var catalog = new Catalog();
            using (Stream stream = typeof(ErrorCatalog).Assembly.GetManifestResourceStream(ResourceName))
            {
                if (stream == null) return catalog;
                using (var reader = new StreamReader(stream, Encoding.UTF8))
                {
                    JObject root = JObject.Parse(reader.ReadToEnd());
                    foreach (JToken word in root["generated"]?["words"] as JArray ?? new JArray())
                        catalog.Words.Add(word.ToString());
                    foreach (JToken entry in root["errors"] as JArray ?? new JArray())
                    {
                        var info = new ErrorInfo(
                            entry["code"]?.ToString(), entry["name"]?.ToString(), entry["area"]?.ToString(),
                            entry["severity"]?.ToString(), entry["title"]?.ToString(),
                            entry["description"]?.ToString(), entry["action"]?.ToString(), generated: false);
                        if (string.IsNullOrEmpty(info.Code) || catalog.ByCode.ContainsKey(info.Code)) continue;
                        catalog.Entries.Add(info);
                        catalog.ByCode[info.Code] = info;
                    }
                }
            }
            return catalog;
        }
    }
}
