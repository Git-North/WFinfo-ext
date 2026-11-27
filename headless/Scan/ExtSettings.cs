using System;
using System.IO;
using System.Security;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace WFInfo.Scan
{
    /// <summary>
    /// WFInfo-ext's own settings: &lt;app dir&gt;/wfinfo-ext-settings.json,
    /// {"version":1,"notifications":false,"overlayPin":false}. Only the
    /// dashboard writes it (temporary file, then rename); the runner only reads
    /// it, at each scan start and at each watch trigger, so a change applies
    /// without a restart.
    /// </summary>
    /// <remarks>
    /// Rules (the dashboard's src/lib/settings.ts uses the same ones):
    /// a missing file means the defaults (all off) with no warning; a file that
    /// cannot be read, is not JSON, is not an object, has a version other than
    /// 1 or a switch that is not true/false means the defaults plus SET-001.
    /// Unknown keys are ignored. A missing switch is off.
    /// Public, not internal, so a test project can use it without an
    /// InternalsVisibleTo entry in the csproj.
    /// </remarks>
    public sealed class ExtSettings
    {
        /// <summary>The settings file name inside the app dir.</summary>
        public const string FileName = "wfinfo-ext-settings.json";

        /// <summary>The only file format version.</summary>
        public const int CurrentVersion = 1;

        /// <summary>Catalog code for an unreadable or invalid settings file (errors/catalog.json).</summary>
        public const string UnreadableCode = "SET-001";

        private ExtSettings(bool notifications, bool overlayPin, string warningCode, string warningDetail)
        {
            Notifications = notifications;
            OverlayPin = overlayPin;
            WarningCode = warningCode;
            WarningDetail = warningDetail;
        }

        /// <summary>Desktop notifications for EE.log-triggered scans (default off).</summary>
        public bool Notifications { get; }

        /// <summary>Pin the overlay window through the Millennium plugin after a scan with names (default off).</summary>
        public bool OverlayPin { get; }

        /// <summary>
        /// "SET-001" when the file exists but could not be used (the switches are
        /// then the defaults), else null. Callers record it as a warning.
        /// </summary>
        public string WarningCode { get; }

        /// <summary>
        /// Why the file could not be used, in a few words (never the file text or
        /// a path), or null. Safe for the scan record and debug.log.
        /// </summary>
        public string WarningDetail { get; }

        /// <summary>The defaults: every switch off, no warning.</summary>
        public static ExtSettings Defaults { get; } = new ExtSettings(false, false, null, null);

        /// <summary>&lt;app dir&gt;/wfinfo-ext-settings.json.</summary>
        public static string DefaultPath => Path.Combine(ScanPaths.AppDir, FileName);

        /// <summary>The current settings from &lt;app dir&gt;/wfinfo-ext-settings.json. Never throws.</summary>
        public static ExtSettings Load() => Load(DefaultPath);

        /// <summary>The settings from <paramref name="path"/>. Never throws.</summary>
        public static ExtSettings Load(string path)
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                return Unreadable("no settings path");
            }

            string text;
            try
            {
                if (Directory.Exists(path))
                {
                    return Unreadable("the settings path is a folder");
                }
                if (!File.Exists(path))
                {
                    return Defaults;
                }
                text = File.ReadAllText(path);
            }
            catch (Exception error) when (error is FileNotFoundException || error is DirectoryNotFoundException)
            {
                // Removed between the check and the read: the same as no file.
                return Defaults;
            }
            catch (Exception error) when (error is IOException || error is UnauthorizedAccessException ||
                                          error is SecurityException || error is NotSupportedException ||
                                          error is ArgumentException)
            {
                return Unreadable("the file could not be read (" + error.GetType().Name + ")");
            }

            return Parse(text);
        }

        /// <summary>The settings from the file's text. Never throws.</summary>
        public static ExtSettings Parse(string text)
        {
            JToken root;
            try
            {
                root = JToken.Parse(text ?? string.Empty);
            }
            catch (JsonException)
            {
                return Unreadable("the file is not valid JSON");
            }

            if (!(root is JObject settings))
            {
                return Unreadable("the file is not a JSON object");
            }

            JToken version = settings["version"];
            if (version != null && !IsVersionOne(version))
            {
                return Unreadable("the file version is not " + CurrentVersion);
            }

            if (!TryReadSwitch(settings, "notifications", out bool notifications) ||
                !TryReadSwitch(settings, "overlayPin", out bool overlayPin))
            {
                return Unreadable("a switch is not true or false");
            }

            return new ExtSettings(notifications, overlayPin, null, null);
        }

        private static bool IsVersionOne(JToken version)
        {
            switch (version.Type)
            {
                case JTokenType.Integer:
                    return version.Value<long>() == CurrentVersion;
                case JTokenType.Float:
                    // JSON has one number type: 1.0 is the same value as 1.
                    return version.Value<double>().Equals(CurrentVersion);
                default:
                    return false;
            }
        }

        /// <summary>A missing switch is off; a present one must be true or false.</summary>
        private static bool TryReadSwitch(JObject settings, string key, out bool value)
        {
            value = false;
            JToken token = settings[key];
            if (token == null)
            {
                return true;
            }
            if (token.Type != JTokenType.Boolean)
            {
                return false;
            }
            value = token.Value<bool>();
            return true;
        }

        private static ExtSettings Unreadable(string detail) =>
            new ExtSettings(false, false, UnreadableCode, detail);
    }
}
