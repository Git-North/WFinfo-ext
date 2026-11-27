using System;

namespace WFInfo.Errors
{
    /// <summary>
    /// Minecraft-style crash reports: &lt;app dir&gt;/crash-reports/crash-&lt;time&gt;-&lt;component&gt;.txt
    /// (layout and the no-personal-data rule in errors/AGENTS.md).
    /// </summary>
    internal static class CrashReport
    {
        /// <summary>
        /// Writes a crash report for an error and returns its path with the home
        /// directory written as "~", or null when nothing was written.
        /// STUB: the errors work fills this in; callers may use it already.
        /// </summary>
        public static string Write(Exception error, string component, ErrorInfo info)
        {
            _ = error;
            _ = component;
            _ = info;
            return null;
        }
    }
}
