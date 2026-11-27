using System;
using System.IO;
using WFInfo.Scan;

namespace WFInfo.Headless.Tests
{
    /// <summary>
    /// The app-data folder of a test run. tests/run.ts sets the environment
    /// before the test process starts, because .NET reads it only then: on
    /// macOS a changed HOME does not move ApplicationData, only
    /// CFFIXED_USER_HOME does. The marker file proves that the folder is a
    /// sandbox, so a test can never write into the user's real WFInfo data.
    /// </summary>
    internal static class Sandbox
    {
        private const string Variable = "WFINFO_TEST_SANDBOX";
        private const string Marker = ".wfinfo-test-sandbox";

        public static bool Active => !string.IsNullOrEmpty(Environment.GetEnvironmentVariable(Variable));

        /// <summary>The runner's app-data folder; throws unless it is inside a sandbox.</summary>
        public static string AppDir
        {
            get
            {
                string appDir = ScanPaths.AppDir;
                for (var dir = new DirectoryInfo(Path.GetFullPath(appDir)); dir != null; dir = dir.Parent)
                {
                    if (File.Exists(Path.Combine(dir.FullName, Marker))) return appDir;
                }
                throw new InvalidOperationException(
                    $"refusing to use '{appDir}': it is not inside a test sandbox (no {Marker} above it)");
            }
        }

        /// <summary>
        /// An app-data folder with small market databases and fresh cached
        /// prices, so a scan needs no network. Four parts cover the price
        /// sources: two cache hits with equal platinum, one price-sheet row and
        /// one part with no price.
        /// </summary>
        public static string ResetAppDir()
        {
            string appDir = AppDir;
            if (Directory.Exists(appDir)) Directory.Delete(appDir, recursive: true);
            Directory.CreateDirectory(appDir);

            File.WriteAllText(ScanPaths.NameData, """
                {
                  "Volt Prime Systems Blueprint": "Volt Prime Systems",
                  "Ash Prime Neuroptics Blueprint": "Ash Prime Neuroptics",
                  "Forma Blueprint": "Forma Blueprint",
                  "Akstiletto Prime Barrel": "Akstiletto Prime Barrel"
                }
                """);
            File.WriteAllText(ScanPaths.MarketItems, """
                {
                  "a": "Volt Prime Systems|volt_prime_systems|Volt Prime Systems Blueprint",
                  "b": "Akstiletto Prime Barrel|akstiletto_prime_barrel|Akstiletto Prime Barrel"
                }
                """);
            File.WriteAllText(ScanPaths.MarketData, """
                {
                  "Volt Prime Systems": { "name": "Volt Prime Systems", "plat": "11", "volume": "3", "ducats": 45 },
                  "Ash Prime Neuroptics": { "name": "Ash Prime Neuroptics", "plat": "5", "volume": "2", "ducats": 100 },
                  "Akstiletto Prime Barrel": { "name": "Akstiletto Prime Barrel", "plat": "9", "volume": "4", "ducats": 15 }
                }
                """);

            string now = ScanPaths.Iso(DateTime.UtcNow);
            File.WriteAllText(ScanPaths.PriceCache, $$"""
                {
                  "version": 1,
                  "prices": {
                    "volt_prime_systems": { "plat": 20, "volume": 7, "fetchedAt": "{{now}}" },
                    "akstiletto_prime_barrel": { "plat": 20, "volume": 8, "fetchedAt": "{{now}}" }
                  }
                }
                """);
            return appDir;
        }
    }
}
