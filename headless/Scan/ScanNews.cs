using System;
using System.Collections.Generic;
using System.Linq;

namespace WFInfo.Scan
{
    /// <summary>
    /// Tells whether a scan record shows a new reward screen. The overlay pin
    /// and the watch notification use it: a scan that read the same names as
    /// the record already published sends nothing new.
    /// </summary>
    internal static class ScanNews
    {
        /// <summary>
        /// True when <paramref name="current"/> has at least one choice and its
        /// part names differ from those of <paramref name="previousPublished"/>
        /// (null counts as no names). The order of the choices does not count,
        /// and the names compare without case.
        /// </summary>
        public static bool FoundNewNames(ScanResult previousPublished, ScanResult current)
        {
            List<string> now = Names(current);
            if (now.Count == 0) return false;
            return !now.SequenceEqual(Names(previousPublished), StringComparer.OrdinalIgnoreCase);
        }

        private static List<string> Names(ScanResult record) =>
            (record?.Choices ?? new List<ScanChoice>())
                .Select(choice => (choice?.Part ?? string.Empty).Trim())
                .Where(part => part.Length > 0)
                .OrderBy(part => part, StringComparer.OrdinalIgnoreCase)
                .ToList();
    }
}
