using System;
using System.Collections.Generic;

namespace WFInfo.Scan
{
    /// <summary>
    /// Desktop notification for the scan verdict. On Linux notify-send posts
    /// through the session's org.freedesktop.Notifications daemon (Noctalia on
    /// the reference host), so the recommendation shows above the game as an
    /// overlay without taking keyboard focus away from it. On macOS osascript
    /// posts a Notification Center banner (texts go in as script arguments, so
    /// no quoting is involved).
    /// </summary>
    internal static class Notifier
    {
        public static bool Send(string summary, string body)
        {
            if (OperatingSystem.IsMacOS()) return SendMac(summary, body);

            string executable = Shell.Which("notify-send");
            if (executable == null)
            {
                Main.AddLog("notify-send is not on PATH; skipping the scan notification");
                return false;
            }

            var arguments = new List<string>
            {
                "--app-name=Warframe Info",
                "--urgency=normal",
                "--icon=dialog-information",
                "--expire-time=20000",
                summary,
            };
            if (!string.IsNullOrEmpty(body)) arguments.Add(body);

            ShellResult result = Shell.Run(executable, arguments, 5000);
            return result.ExitCode == 0;
        }

        private static bool SendMac(string summary, string body)
        {
            var arguments = new List<string>
            {
                "-e", "on run argv",
                "-e", "display notification (item 2 of argv) with title \"Warframe Info\" subtitle (item 1 of argv)",
                "-e", "end run",
                summary ?? string.Empty,
                body ?? string.Empty,
            };
            ShellResult result = Shell.Run("/usr/bin/osascript", arguments, 5000);
            if (result.ExitCode != 0)
                Main.AddLog("osascript notification failed: " + result.StdErr.Trim());
            return result.ExitCode == 0;
        }
    }
}
