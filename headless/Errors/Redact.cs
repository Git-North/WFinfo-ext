using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace WFInfo.Errors
{
    /// <summary>
    /// Removes personal data from text before it goes into a crash report, a
    /// scan record or the console (errors/AGENTS.md): the home directory
    /// becomes "~", and e-mail addresses, IP addresses and EE.log lines are
    /// replaced with a marker.
    /// </summary>
    internal static class Redact
    {
        public const string EmailMarker = "<e-mail>";
        public const string IpMarker = "<ip>";
        public const string LogLineMarker = "<EE.log line removed>";
        public const string TimeoutMarker = "<text removed: the privacy filter timed out>";

        private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(1);

        private static readonly Regex Email = new Regex(
            @"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}",
            RegexOptions.CultureInvariant, Timeout);

        // Four dotted octets. Not after "=" or a word/dot, so "Version=1.0.0.0"
        // in an assembly name stays.
        private static readonly Regex IPv4 = new Regex(
            @"(?<![\w.=])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\w.])",
            RegexOptions.CultureInvariant, Timeout);

        // Colon-separated hex groups; MatchIPv6 drops clock times (12:34:56).
        private static readonly Regex IPv6 = new Regex(
            @"(?<![\w:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![\w:])",
            RegexOptions.CultureInvariant, Timeout);

        // Any user's home folder (macOS, Linux, Windows), also when $HOME points
        // elsewhere (a test root, or the source paths of a build).
        private static readonly Regex AnyHome = new Regex(
            @"(?<![\w.~-])(?:/Users/(?!Shared(?:[/\s'"":]|$))[^/\s'"":]+|/home/[^/\s'"":]+|[A-Za-z]:\\Users\\[^\\\s'"":]+)",
            RegexOptions.CultureInvariant, Timeout);

        // An EE.log line: "12.345 Sys [Info]: ...".
        private static readonly Regex LogLine = new Regex(
            @"^[ \t]*\d+\.\d{3}[ \t]+\w+[ \t]+\[\w+\]:.*$",
            RegexOptions.CultureInvariant | RegexOptions.Multiline, Timeout);

        /// <summary>The home directories to write as "~": the user profile and $HOME.</summary>
        public static IReadOnlyList<string> HomeDirectories()
        {
            var homes = new List<string>
            {
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                Environment.GetEnvironmentVariable("HOME"),
            };
            return homes
                .Where(h => !string.IsNullOrEmpty(h))
                .Select(h => h.TrimEnd('/', '\\'))
                .Where(h => h.Length > 1)
                .Distinct(StringComparer.Ordinal)
                .OrderByDescending(h => h.Length)
                .ToList();
        }

        /// <summary>A path with the home directory written as "~".</summary>
        public static string Path(string path)
        {
            if (string.IsNullOrEmpty(path)) return path;
            try
            {
                return AnyHome.Replace(Home(path, HomeDirectories()), "~");
            }
            catch (RegexMatchTimeoutException)
            {
                return TimeoutMarker;
            }
        }

        /// <summary>The whole scrub: home → "~", then e-mail, IP and EE.log lines removed.</summary>
        public static string Text(string text) => Text(text, HomeDirectories());

        /// <summary>The whole scrub with given home directories (tests).</summary>
        public static string Text(string text, IEnumerable<string> homes)
        {
            if (string.IsNullOrEmpty(text)) return text;
            try
            {
                string result = AnyHome.Replace(Home(text, homes), "~");
                result = LogLine.Replace(result, LogLineMarker);
                result = Email.Replace(result, EmailMarker);
                result = IPv4.Replace(result, IpMarker);
                result = IPv6.Replace(result, MatchIPv6);
                return result;
            }
            catch (RegexMatchTimeoutException)
            {
                // Never let unscrubbed text through: drop it all.
                return TimeoutMarker;
            }
        }

        private static string Home(string text, IEnumerable<string> homes)
        {
            if (string.IsNullOrEmpty(text) || homes == null) return text;
            string result = text;
            foreach (string home in homes.Where(h => !string.IsNullOrEmpty(h) && h.Length > 1).OrderByDescending(h => h.Length))
            {
                // Only a whole path part: "/Users/ann" must not change "/Users/anna".
                var pattern = new Regex(Regex.Escape(home) + @"(?![\w.-])", RegexOptions.CultureInvariant, Timeout);
                result = pattern.Replace(result, "~");
            }
            return result;
        }

        private static string MatchIPv6(Match match)
        {
            string value = match.Value;
            int groups = value.Count(c => c == ':') + 1;
            bool hasHex = value.Any(c => (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'));
            // "::" or 5+ groups is an address; "12:34:56" (a time) and "a:b" stay.
            bool address = value.Contains("::", StringComparison.Ordinal)
                ? value.Length > 2 && (groups >= 3 || hasHex)
                : groups >= 5;
            return address ? IpMarker : value;
        }
    }
}
