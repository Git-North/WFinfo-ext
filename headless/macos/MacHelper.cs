using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using WFInfo.Errors;
using WFInfo.Scan;

namespace WFInfo.MacOS
{
    /// <summary>
    /// Runs the Swift helper `wfinfo-mac` (headless/macos/wfinfo-mac.swift). The
    /// csproj builds it next to WFInfo.Headless.dll on macOS;
    /// <c>WFINFO_MAC_HELPER</c> points at another build.
    /// </summary>
    internal static class MacHelper
    {
        public const string FileName = "wfinfo-mac";

        public const string Variable = "WFINFO_MAC_HELPER";

        /// <summary>
        /// The trimmed <c>WFINFO_MAC_HELPER</c> value, or null when it is unset
        /// or holds only white space.
        /// </summary>
        public static string Configured
        {
            get
            {
                string value = Environment.GetEnvironmentVariable(Variable)?.Trim();
                return string.IsNullOrEmpty(value) ? null : value;
            }
        }

        /// <summary>
        /// On macOS, throws a <see cref="ScanFailure"/> SYS-004 when
        /// <c>WFINFO_MAC_HELPER</c> names a file that does not exist: a bad
        /// override is a configuration error, not "no helper".
        /// </summary>
        public static void CheckConfigured()
        {
            if (!OperatingSystem.IsMacOS()) return;
            string configured = Configured;
            if (configured != null && !File.Exists(configured))
                throw MissingConfigured(configured);
        }

        private static ScanFailure MissingConfigured(string configured)
            => new ScanFailure("SYS-004", $"{Variable} names a missing file: '{Redact.Path(configured)}'");

        /// <summary>Full path of the helper, or null when it is not built.</summary>
        public static string Path
        {
            get
            {
                string configured = Configured;
                if (configured != null)
                    return File.Exists(configured) ? configured : null;

                string local = System.IO.Path.Combine(AppContext.BaseDirectory, FileName);
                return File.Exists(local) ? local : null;
            }
        }

        public static bool Available => OperatingSystem.IsMacOS() && Path != null;

        /// <summary>
        /// Runs one subcommand and parses its JSON answer. Throws a
        /// <see cref="ScanFailure"/> SYS-003 when the answer is not JSON; see
        /// <see cref="RunBytes"/> for the other failures.
        /// </summary>
        public static JToken Run(IEnumerable<string> arguments, int timeoutMs, byte[] input = null)
        {
            byte[] output = RunBytes(arguments, timeoutMs, input);
            try
            {
                return JToken.Parse(Encoding.UTF8.GetString(output));
            }
            catch (JsonException ex)
            {
                throw new ScanFailure("SYS-003", $"{FileName} printed no JSON: {ex.Message}", ex);
            }
        }

        /// <summary>
        /// Runs one subcommand with optional stdin bytes and returns raw stdout
        /// (a PNG for `capture -`, JSON otherwise). Images go through the pipes,
        /// so nothing is written to a temporary folder. stdin is written while
        /// stdout and stderr are read, so a large image cannot block a full pipe.
        /// Failures are <see cref="ScanFailure"/>s: SYS-004 (bad
        /// WFINFO_MAC_HELPER), SYS-001 (not built or cannot start), SYS-002
        /// (timeout), or the code the helper printed ("wfinfo-mac: [CAP-001] …").
        /// A helper error without a code (a usage error) stays an
        /// <see cref="InvalidOperationException"/> with the helper's text.
        /// </summary>
        public static byte[] RunBytes(IEnumerable<string> arguments, int timeoutMs, byte[] input = null)
        {
            string helper = Path;
            if (helper == null && Configured != null)
                throw MissingConfigured(Configured);
            if (helper == null)
                throw new ScanFailure("SYS-001",
                    $"{FileName} is not built; build headless/WFInfo.Headless.csproj on macOS (it compiles headless/macos/{FileName}.swift) or set {Variable}");

            var psi = new ProcessStartInfo(helper)
            {
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            foreach (string argument in arguments) psi.ArgumentList.Add(argument);

            Process started;
            try
            {
                started = Process.Start(psi);
            }
            catch (System.ComponentModel.Win32Exception ex)
            {
                throw new ScanFailure("SYS-001", $"cannot start {Redact.Path(helper)}: {ex.Message}", ex);
            }
            using (Process process = started)
            {
                if (process == null) throw new ScanFailure("SYS-001", "cannot start " + Redact.Path(helper));

                var stdout = new MemoryStream();
                Task copyOut = process.StandardOutput.BaseStream.CopyToAsync(stdout);
                Task<string> readErr = process.StandardError.ReadToEndAsync();
                Task writeIn = Task.Run(() =>
                {
                    try
                    {
                        if (input != null) process.StandardInput.BaseStream.Write(input, 0, input.Length);
                    }
                    catch (IOException)
                    {
                        // The helper exited early; its exit code and stderr say why.
                    }
                    finally
                    {
                        try { process.StandardInput.Close(); } catch (IOException) { }
                    }
                });

                if (!process.WaitForExit(timeoutMs))
                {
                    try { process.Kill(true); } catch { /* already gone */ }
                    throw new ScanFailure("SYS-002", $"{FileName} timed out after {timeoutMs} ms");
                }
                Task.WaitAll(copyOut, readErr, writeIn);

                if (process.ExitCode != 0)
                {
                    string message = string.IsNullOrWhiteSpace(readErr.Result)
                        ? $"{FileName} exited with {process.ExitCode}"
                        : readErr.Result.Trim();
                    message = message.Replace(FileName + ": ", string.Empty);
                    throw ErrorMapping.FromCodedText(message) ?? new InvalidOperationException(message);
                }
                return stdout.ToArray();
            }
        }

        /// <summary>Frames for `ocr --frames`: a 4-byte big-endian length, then the image bytes.</summary>
        public static byte[] Frames(IEnumerable<byte[]> images)
        {
            using (var buffer = new MemoryStream())
            {
                foreach (byte[] image in images)
                {
                    int length = image.Length;
                    buffer.WriteByte((byte)(length >> 24));
                    buffer.WriteByte((byte)(length >> 16));
                    buffer.WriteByte((byte)(length >> 8));
                    buffer.WriteByte((byte)length);
                    buffer.Write(image, 0, length);
                }
                return buffer.ToArray();
            }
        }
    }
}
