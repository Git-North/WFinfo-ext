using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using WFInfo.Scan;
using Xunit;

namespace WFInfo.Tests.ScanPasses
{
    /// <summary>
    /// The fast/deep flow end to end on macOS: the real runner with
    /// `--two-pass --file` on a synthetic reward screen (wfinfo-mac synth), in
    /// a temporary home. The runner process gets HOME and CFFIXED_USER_HOME
    /// (.NET on macOS ignores HOME alone), and the test refuses to run when the
    /// app dir would be the real one. Skipped (passes empty) off macOS or when
    /// the runner is not built.
    /// </summary>
    public sealed class ScanPassesRunTests : IDisposable
    {
        private readonly string _root = Path.Combine(Path.GetTempPath(), "wfinfo-passes-run-" + Guid.NewGuid().ToString("N"));

        public void Dispose()
        {
            if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
        }

        private static string HeadlessOut()
        {
            for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir != null; dir = dir.Parent)
            {
                string out_ = Path.Combine(dir.FullName, "headless", "bin", "Debug", "net9.0");
                if (File.Exists(Path.Combine(dir.FullName, "headless", "WFInfo.Headless.csproj"))) return out_;
            }
            return null;
        }

        private static (int Exit, string Output) Run(string file, string[] args, string home)
        {
            var psi = new ProcessStartInfo(file)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            foreach (string arg in args) psi.ArgumentList.Add(arg);
            if (home != null)
            {
                psi.Environment["HOME"] = home;
                psi.Environment["CFFIXED_USER_HOME"] = home;
                psi.Environment["WFINFO_DATA_DIR"] = Path.Combine(home, ".config");
            }
            using Process process = Process.Start(psi);
            string output = process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(170000), "runner timed out");
            return (process.ExitCode, output);
        }

        [Fact]
        public void FastThenDeepWithOneScanId()
        {
            string bin = HeadlessOut();
            if (!OperatingSystem.IsMacOS() || bin == null || !File.Exists(Path.Combine(bin, "wfinfo-mac"))) return;

            string realAppDir = ScanPaths.AppDir;
            string appDir = Path.Combine(_root, "Library", "Application Support", "WFInfo");
            // Guard: never write into the user's real app dir.
            Assert.NotEqual(Path.GetFullPath(realAppDir), Path.GetFullPath(appDir));
            Assert.StartsWith(Path.GetFullPath(Path.GetTempPath()), Path.GetFullPath(appDir), StringComparison.Ordinal);
            Directory.CreateDirectory(appDir);
            foreach (string name in new[] { "market_items.json", "market_data.json", "name_data.json", "price_cache.json" })
            {
                string source = Path.Combine(realAppDir, name);
                if (!File.Exists(source)) return; // no market DBs on this machine: nothing to match against
                File.Copy(source, Path.Combine(appDir, name));
            }

            string png = Path.Combine(_root, "synth.png");
            var synth = Run(Path.Combine(bin, "wfinfo-mac"), new[]
            {
                "synth", "--out", png, "--names", "Volt Prime Blueprint|Forma Blueprint|Akstiletto Prime Barrel",
                "--ui-scale", "0.9", "--color", "#FFFFFF", "--seed", "7",
            }, null);
            Assert.True(synth.Exit == 0, synth.Output);

            var scan = Run("dotnet", new[]
            {
                Path.Combine(bin, "WFInfo.Headless.dll"), "--scan", "--two-pass", "--no-notify",
                "--file", png, "--ui-scale", "unknown", "--ttl", "100000",
            }, _root);
            string scans = Path.Combine(appDir, "scans");
            Assert.True(File.Exists(Path.Combine(scans, "latest.json")), "no record in the temp app dir:\n" + scan.Output);
            Assert.True(scan.Exit == 0, scan.Output);

            ScanResult[] history = Directory.GetFiles(scans, "scan-*.json").OrderBy(f => f, StringComparer.Ordinal)
                .Select(f => JsonConvert.DeserializeObject<ScanResult>(File.ReadAllText(f))).ToArray();
            Assert.Equal(new[] { "fast", "deep" }, history.Select(r => r.Stage).ToArray());
            Assert.Equal(history[0].ScanId, history[1].ScanId);
            Assert.All(history, r => Assert.Equal("manual", r.Trigger));
            Assert.NotEmpty(history[0].Choices);

            ScanResult latest = JsonConvert.DeserializeObject<ScanResult>(File.ReadAllText(Path.Combine(scans, "latest.json")));
            Assert.Equal("deep", latest.Stage);
            Assert.Equal(history[0].ScanId, latest.ScanId);
            Assert.Equal(3, latest.Choices.Count);
            Assert.True(File.Exists(Path.Combine(scans, "last.png")));
            Assert.Empty(Directory.GetFiles(scans, "*.tmp"));
            Assert.Empty(Directory.GetFiles(scans, "capture-*.png"));
        }
    }
}
