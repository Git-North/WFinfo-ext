using System;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using WFInfo.Scan;
using Xunit;

namespace WFInfoExt.Tests.Settings
{
    /// <summary>
    /// A temporary app dir for one test. Refuses to run on the user's real
    /// WFInfo app dir: the tests must never read or write the real
    /// wfinfo-ext-settings.json.
    /// </summary>
    internal sealed class TempAppDir : IDisposable
    {
        public TempAppDir()
        {
            Root = Path.Combine(Path.GetTempPath(), "wfinfo_ext_settings_" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Root);
            GuardNotRealAppDir(Root);
            SettingsPath = Path.Combine(Root, ExtSettings.FileName);
        }

        public string Root { get; }

        public string SettingsPath { get; }

        public void Write(string text) => File.WriteAllText(SettingsPath, text);

        public void Dispose()
        {
            if (Directory.Exists(Root))
            {
                Directory.Delete(Root, true);
            }
        }

        /// <summary>Fail loudly when <paramref name="dir"/> is a real WFInfo app dir.</summary>
        public static void GuardNotRealAppDir(string dir)
        {
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string[] real =
            {
                Path.GetDirectoryName(ExtSettings.DefaultPath),
                Path.Combine(home, "Library", "Application Support", "WFInfo"),
                Path.Combine(home, ".config", "WFInfo"),
            };
            string full = Path.GetFullPath(dir).TrimEnd(Path.DirectorySeparatorChar);
            foreach (string candidate in real.Where(r => !string.IsNullOrEmpty(r)))
            {
                string other = Path.GetFullPath(candidate).TrimEnd(Path.DirectorySeparatorChar);
                if (string.Equals(full, other, StringComparison.Ordinal))
                {
                    throw new InvalidOperationException("Refusing to run: " + dir + " is the real WFInfo app dir.");
                }
            }
        }
    }

    public class ExtSettingsTests
    {
        [Fact]
        public void MissingFileGivesDefaultsWithoutWarning()
        {
            using var dir = new TempAppDir();
            ExtSettings settings = ExtSettings.Load(dir.SettingsPath);
            Assert.False(settings.Notifications);
            Assert.False(settings.OverlayPin);
            Assert.Null(settings.WarningCode);
            Assert.Null(settings.WarningDetail);
        }

        [Fact]
        public void MissingFolderGivesDefaultsWithoutWarning()
        {
            using var dir = new TempAppDir();
            ExtSettings settings = ExtSettings.Load(Path.Combine(dir.Root, "absent", ExtSettings.FileName));
            Assert.False(settings.Notifications);
            Assert.Null(settings.WarningCode);
        }

        [Theory]
        [InlineData(true, true)]
        [InlineData(true, false)]
        [InlineData(false, true)]
        [InlineData(false, false)]
        public void ValidFileIsRead(bool notifications, bool overlayPin)
        {
            using var dir = new TempAppDir();
            dir.Write(new JObject
            {
                ["version"] = 1,
                ["notifications"] = notifications,
                ["overlayPin"] = overlayPin,
            }.ToString());

            ExtSettings settings = ExtSettings.Load(dir.SettingsPath);
            Assert.Equal(notifications, settings.Notifications);
            Assert.Equal(overlayPin, settings.OverlayPin);
            Assert.Null(settings.WarningCode);
        }

        [Fact]
        public void ReadsTheDashboardFormat()
        {
            // Byte for byte what dashboard/src/lib/settings.ts writes.
            using var dir = new TempAppDir();
            dir.Write("{\"version\":1,\"notifications\":true,\"overlayPin\":false}\n");
            ExtSettings settings = ExtSettings.Load(dir.SettingsPath);
            Assert.True(settings.Notifications);
            Assert.False(settings.OverlayPin);
            Assert.Null(settings.WarningCode);
        }

        [Fact]
        public void UnknownKeysAreIgnored()
        {
            using var dir = new TempAppDir();
            dir.Write("{\"version\":1,\"notifications\":true,\"overlayPin\":true,\"later\":{\"x\":[1,2]},\"theme\":\"dark\"}");
            ExtSettings settings = ExtSettings.Load(dir.SettingsPath);
            Assert.True(settings.Notifications);
            Assert.True(settings.OverlayPin);
            Assert.Null(settings.WarningCode);
        }

        [Theory]
        [InlineData("{}")]
        [InlineData("{\"version\":1}")]
        [InlineData("{\"notifications\":false}")]
        public void MissingSwitchesAreOff(string text)
        {
            using var dir = new TempAppDir();
            dir.Write(text);
            ExtSettings settings = ExtSettings.Load(dir.SettingsPath);
            Assert.False(settings.Notifications);
            Assert.False(settings.OverlayPin);
            Assert.Null(settings.WarningCode);
        }

        [Fact]
        public void VersionOneAsFloatIsAccepted()
        {
            using var dir = new TempAppDir();
            dir.Write("{\"version\":1.0,\"overlayPin\":true}");
            ExtSettings settings = ExtSettings.Load(dir.SettingsPath);
            Assert.True(settings.OverlayPin);
            Assert.Null(settings.WarningCode);
        }

        [Theory]
        [InlineData("")]
        [InlineData("   ")]
        [InlineData("{\"version\":1,\"notifications\":true")]
        [InlineData("not json")]
        [InlineData("[true,true]")]
        [InlineData("true")]
        [InlineData("null")]
        [InlineData("{\"version\":2,\"notifications\":true}")]
        [InlineData("{\"version\":\"1\",\"notifications\":true}")]
        [InlineData("{\"version\":1,\"notifications\":\"true\"}")]
        [InlineData("{\"version\":1,\"notifications\":true,\"overlayPin\":1}")]
        [InlineData("{\"version\":1,\"notifications\":null}")]
        public void InvalidFileGivesDefaultsAndSet001(string text)
        {
            using var dir = new TempAppDir();
            dir.Write(text);
            ExtSettings settings = ExtSettings.Load(dir.SettingsPath);
            Assert.False(settings.Notifications);
            Assert.False(settings.OverlayPin);
            Assert.Equal("SET-001", settings.WarningCode);
            Assert.False(string.IsNullOrWhiteSpace(settings.WarningDetail));
            // The detail goes into records and logs: never a path or the file text.
            Assert.DoesNotContain(dir.Root, settings.WarningDetail, StringComparison.Ordinal);
        }

        [Fact]
        public void FolderInPlaceOfTheFileGivesSet001()
        {
            using var dir = new TempAppDir();
            Directory.CreateDirectory(dir.SettingsPath);
            ExtSettings settings = ExtSettings.Load(dir.SettingsPath);
            Assert.Equal("SET-001", settings.WarningCode);
            Assert.False(settings.Notifications);
        }

        [Theory]
        [InlineData(null)]
        [InlineData("")]
        [InlineData("  ")]
        public void BlankPathNeverThrows(string path)
        {
            ExtSettings settings = ExtSettings.Load(path);
            Assert.Equal("SET-001", settings.WarningCode);
            Assert.False(settings.OverlayPin);
        }

        [Fact]
        public void ChangeAppliesOnTheNextLoad()
        {
            // The runner loads at each scan start and watch trigger, so no restart.
            using var dir = new TempAppDir();
            dir.Write("{\"version\":1,\"notifications\":false,\"overlayPin\":false}");
            Assert.False(ExtSettings.Load(dir.SettingsPath).Notifications);
            dir.Write("{\"version\":1,\"notifications\":true,\"overlayPin\":false}");
            Assert.True(ExtSettings.Load(dir.SettingsPath).Notifications);
        }

        [Fact]
        public void DefaultPathIsTheAppDirFile()
        {
            Assert.Equal(ExtSettings.FileName, Path.GetFileName(ExtSettings.DefaultPath));
            Assert.Equal("WFInfo", Path.GetFileName(Path.GetDirectoryName(ExtSettings.DefaultPath)));
        }

        [Fact]
        public void GuardRefusesTheRealAppDir()
        {
            string real = Path.GetDirectoryName(ExtSettings.DefaultPath);
            Assert.Throws<InvalidOperationException>(() => TempAppDir.GuardNotRealAppDir(real));
        }

        [Fact]
        public void Set001IsTheCatalogWarning()
        {
            string catalog = FindRepoFile(Path.Combine("errors", "catalog.json"));
            JObject entry = JObject.Parse(File.ReadAllText(catalog))["errors"]
                .Children<JObject>()
                .Single(e => (string)e["code"] == ExtSettings.UnreadableCode);
            Assert.Equal("Scroll", (string)entry["name"]);
            Assert.Equal("warning", (string)entry["severity"]);
        }

        private static string FindRepoFile(string relative)
        {
            for (DirectoryInfo dir = new DirectoryInfo(AppContext.BaseDirectory); dir != null; dir = dir.Parent)
            {
                string candidate = Path.Combine(dir.FullName, relative);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
            throw new FileNotFoundException("not found above the test output folder", relative);
        }
    }
}
