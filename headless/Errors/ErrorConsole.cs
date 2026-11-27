using System;
using System.IO;

namespace WFInfo.Errors
{
    /// <summary>
    /// The runner's error lines on stderr:
    /// "ERROR CAP-001 Shutter: Screen Recording not allowed — &lt;description&gt; (crash report: &lt;path&gt;)",
    /// then the detail and what to do. Warnings use "WARNING" (catalog severity).
    /// </summary>
    internal static class ErrorConsole
    {
        /// <summary>Exit code of a run that stopped on an error.</summary>
        public const int ExitFatal = 2;

        /// <summary>The first line for an error, without a trailing newline.</summary>
        public static string Line(ErrorInfo info, string crashReport = null)
        {
            if (info == null) throw new ArgumentNullException(nameof(info));
            string level = info.Severity == "warning" || info.Severity == "info" ? "WARNING" : "ERROR";
            string line = $"{level} {info.Code} {info.Name}: {info.Title} — {info.Description}";
            return string.IsNullOrEmpty(crashReport) ? line : line + " (crash report: " + crashReport + ")";
        }

        /// <summary>Prints the error line, the detail (scrubbed) and the action.</summary>
        public static void Print(ErrorInfo info, string detail = null, string crashReport = null, TextWriter writer = null)
        {
            if (info == null) throw new ArgumentNullException(nameof(info));
            writer ??= Console.Error;
            writer.WriteLine(Line(info, crashReport));
            if (!string.IsNullOrWhiteSpace(detail)) writer.WriteLine("  Detail: " + Redact.Text(detail.Trim()));
            if (!string.IsNullOrWhiteSpace(info.Action)) writer.WriteLine("  What to do: " + info.Action);
        }

        /// <summary>Prints a catalog code (a warning or an error per the catalog).</summary>
        public static void Print(string code, string detail = null, TextWriter writer = null)
        {
            ErrorInfo info = ErrorCatalog.Get(code) ?? ErrorCatalog.ForException(new ScanFailure(code, detail));
            Print(info, detail, null, writer);
        }

        /// <summary>
        /// Reports an exception that stopped a mode and returns <see cref="ExitFatal"/>.
        /// A <see cref="ScanFailure"/> (or a mapped native-library error) with a
        /// catalog entry is an expected failure: one coded line, no crash report.
        /// Anything else, and every case with <paramref name="alwaysCrashReport"/>,
        /// also writes a crash report and names it on the line.
        /// </summary>
        public static int Fail(Exception error, string component, bool alwaysCrashReport = false)
        {
            ErrorInfo info = ErrorCatalog.ForException(error);
            ScanFailure failure = error as ScanFailure ?? ErrorMapping.FromNative(error);
            bool expected = failure != null && !info.Generated && ErrorCatalog.Get(info.Code) != null;
            string report = alwaysCrashReport || !expected ? CrashReport.Write(error, component, info) : null;
            string detail = failure?.Detail ?? (expected ? null : error?.Message);
            Print(info, detail, report);
            return ExitFatal;
        }
    }
}
