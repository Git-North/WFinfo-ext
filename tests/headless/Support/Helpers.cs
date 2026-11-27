using System;
using System.IO;
using WFInfo.MacOS;

namespace WFInfo.Headless.Tests
{
    /// <summary>The real Swift helper and stand-ins for it.</summary>
    internal static class Helpers
    {
        /// <summary>
        /// The built wfinfo-mac: WFINFO_TEST_HELPER (tests/run.ts sets it, to
        /// the coverage build when it measures coverage), else the runner's
        /// output. Not WFINFO_MAC_HELPER: tests change that one.
        /// </summary>
        public static string Real
        {
            get
            {
                string chosen = Environment.GetEnvironmentVariable("WFINFO_TEST_HELPER");
                if (!string.IsNullOrEmpty(chosen)) return chosen;
                string outDir = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "headless-out.txt")).Trim();
                return Path.GetFullPath(Path.Combine(outDir, MacHelper.FileName));
            }
        }

        /// <summary>A stand-in helper: a shell script with the given body.</summary>
        public static string Script(TempDir dir, string body)
        {
            string path = dir.Write("fake-helper", "#!/bin/sh\n" + body + "\n");
            if (!OperatingSystem.IsWindows())
                File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            return path;
        }
    }
}
