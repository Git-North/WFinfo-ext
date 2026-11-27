using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using Newtonsoft.Json;
using WFInfo.MacOS;
using WFInfo.Scan;

namespace WFInfo.Errors
{
    /// <summary>
    /// Minecraft-style crash reports: &lt;app dir&gt;/crash-reports/crash-&lt;time&gt;-&lt;component&gt;.txt
    /// (layout and the no-personal-data rule in errors/AGENTS.md).
    /// </summary>
    internal static class CrashReport
    {
        /// <summary>Reports kept in crash-reports/; older ones are deleted.</summary>
        public const int Keep = 20;

        public const string Header = "---- WFInfo-ext Crash Report ----";

        private const string FilePrefix = "crash-";
        private const string FileTimeFormat = "yyyy-MM-dd_HH.mm.ss";
        private const int MaxSameSecond = 100;

        /// <summary>Short neutral quips; one is picked from the code, so a code always gets the same one.</summary>
        internal static readonly string[] Quips =
        {
            "Well, this is awkward.",
            "The hamster fell off the wheel.",
            "Somebody set us up the bug.",
            "It worked on the test screen.",
            "Not the reward anybody expected.",
            "A cog slipped. Nobody was hurt.",
            "Have you tried turning it off and on again?",
            "The pixels went one way, the code went the other.",
            "Ouch. That one stung.",
            "Everything is fine. Mostly.",
        };

        /// <summary>The crash-reports folder of the app dir.</summary>
        public static string DefaultDirectory => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "WFInfo", "crash-reports");

        /// <summary>
        /// Writes a crash report for an error and returns its path with the home
        /// directory written as "~", or null when nothing was written.
        /// </summary>
        public static string Write(Exception error, string component, ErrorInfo info)
            => Write(error, component, info, DefaultDirectory, DateTimeOffset.Now);

        /// <summary>Same as <see cref="Write(Exception, string, ErrorInfo)"/> into a given folder at a given time (tests).</summary>
        internal static string Write(Exception error, string component, ErrorInfo info, string directory, DateTimeOffset now)
        {
            info ??= ErrorCatalog.ForException(error);
            string safeComponent = Component(component);
            try
            {
                Directory.CreateDirectory(directory);
                string text = Render(error, safeComponent, info, now);
                string path = CreateFile(directory, FileName(now, safeComponent), text);
                Prune(directory, Keep);
                return Redact.Path(path);
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
            {
                Console.Error.WriteLine("WARNING: cannot write a crash report: " + Redact.Text(ex.Message));
                return null;
            }
        }

        /// <summary>"crash-2026-11-27_17.16.49-scan.txt".</summary>
        internal static string FileName(DateTimeOffset time, string component)
            => FilePrefix + time.ToString(FileTimeFormat, CultureInfo.InvariantCulture) + "-" + Component(component) + ".txt";

        /// <summary>The quip for a code (deterministic).</summary>
        internal static string Quip(string code) => Quips[(int)(ErrorCatalog.Fnv1a32(code ?? string.Empty) % (uint)Quips.Length)];

        /// <summary>The whole report text, already scrubbed (<see cref="Redact.Text(string)"/>).</summary>
        internal static string Render(Exception error, string component, ErrorInfo info, DateTimeOffset now)
        {
            info ??= ErrorCatalog.ForException(error);
            var text = new StringBuilder();
            text.AppendLine(Header);
            text.AppendLine("// " + Quip(info.Code));
            text.AppendLine();
            text.AppendLine("Time: " + now.ToString("yyyy-MM-dd HH:mm:ss zzz", CultureInfo.InvariantCulture));
            text.AppendLine("Description: " + info);
            text.AppendLine();
            text.AppendLine("\tCode: " + info.Code);
            text.AppendLine("\tName: " + info.Name);
            text.AppendLine("\tTitle: " + info.Title);
            text.AppendLine("\tWhat happened: " + info.Description);
            text.AppendLine("\tWhat to do: " + info.Action);
            text.AppendLine("\tComponent: " + Component(component));
            if (info.Generated) text.AppendLine("\tSite: " + ErrorCatalog.Site(error));
            text.AppendLine();
            text.AppendLine(error?.ToString() ?? "(no exception)");
            text.AppendLine();
            text.AppendLine("-- System Details --");
            text.AppendLine("Details:");
            foreach (KeyValuePair<string, string> detail in SystemDetails())
                text.AppendLine("\t" + detail.Key + ": " + detail.Value);
            return Redact.Text(text.ToString());
        }

        /// <summary>OS, runtime, runner, helper, layout library, OCR engine and WFInfo-ext settings.</summary>
        internal static IEnumerable<KeyValuePair<string, string>> SystemDetails()
        {
            yield return Pair("Operating System", RuntimeInformation.OSDescription + " (" + RuntimeInformation.OSArchitecture + ")");
            yield return Pair(".NET Runtime", RuntimeInformation.FrameworkDescription + " (" + RuntimeInformation.ProcessArchitecture + ")");
            yield return Pair("Runner Version", RunnerVersion());
            if (OperatingSystem.IsMacOS())
            {
                yield return Pair("Helper (wfinfo-mac)", Safe(() => FileStamp(MacHelper.Path)));
                yield return Pair("Layout Library", Safe(() => FileStamp(Path.Combine(AppContext.BaseDirectory, "libwfinfo_layout.dylib"))));
            }
            yield return Pair("OCR Engine", Safe(() => OcrEngines.Resolve(null)));
            yield return Pair("WFInfo-ext Settings", Safe(() => JsonConvert.SerializeObject(ExtSettings.Load(), Formatting.None)));
            yield return Pair("App Directory", Redact.Path(Path.GetDirectoryName(DefaultDirectory)));
        }

        /// <summary>Keeps the <paramref name="keep"/> newest reports (the time is in the name).</summary>
        internal static void Prune(string directory, int keep)
        {
            IEnumerable<FileInfo> old = new DirectoryInfo(directory)
                .GetFiles(FilePrefix + "*.txt")
                .OrderByDescending(f => f.Name, StringComparer.Ordinal)
                .Skip(keep);
            foreach (FileInfo file in old)
            {
                try
                {
                    file.Delete();
                }
                catch (IOException)
                {
                    // Another runner deleted or holds it; the next report retries.
                }
            }
        }

        /// <summary>Creates the report file; a second report in the same second gets "-2", "-3", ….</summary>
        private static string CreateFile(string directory, string fileName, string text)
        {
            string stem = Path.GetFileNameWithoutExtension(fileName);
            for (int n = 1; n <= MaxSameSecond; n++)
            {
                string path = Path.Combine(directory, n == 1 ? fileName : stem + "-" + n.ToString(CultureInfo.InvariantCulture) + ".txt");
                if (File.Exists(path)) continue;
                try
                {
                    using var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write);
                    using var writer = new StreamWriter(stream, new UTF8Encoding(false));
                    writer.Write(text);
                    return path;
                }
                catch (IOException) when (File.Exists(path))
                {
                    // Another runner took this name between the check and the create.
                }
            }
            throw new IOException("more than " + MaxSameSecond + " crash reports in one second");
        }

        private static string Component(string component)
        {
            var clean = new StringBuilder();
            foreach (char c in (component ?? string.Empty).ToLowerInvariant())
                clean.Append((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' ? c : '-');
            string result = clean.ToString().Trim('-');
            return result.Length == 0 ? "runner" : result;
        }

        private static string RunnerVersion()
        {
            Assembly assembly = typeof(CrashReport).Assembly;
            string informational = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
            return informational ?? assembly.GetName().Version?.ToString() ?? "unknown";
        }

        private static string FileStamp(string path)
        {
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) return "not found";
            var file = new FileInfo(path);
            return "built " + file.LastWriteTimeUtc.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) +
                " UTC, " + file.Length.ToString(CultureInfo.InvariantCulture) + " bytes";
        }

        /// <summary>A detail that must not stop the report: on any error, its code instead.</summary>
        private static string Safe(Func<string> read)
        {
            try
            {
                return read();
            }
            catch (Exception ex)
            {
                // A crash report is written while something is already broken;
                // a detail that fails shows its error code and is never thrown.
                return "unknown (" + ErrorCatalog.ForException(ex).Code + ")";
            }
        }

        private static KeyValuePair<string, string> Pair(string key, string value) => new KeyValuePair<string, string>(key, value ?? "unknown");
    }
}
