using System;
using System.IO;
using Tesseract;

namespace WFInfo.MacOS
{
    /// <summary>
    /// Native libraries for the macOS developer modes only: libgdiplus
    /// (System.Drawing, which WFInfo's Ocr.cs image code needs) and
    /// libtesseract/libleptonica from Homebrew. The normal scan and self-check
    /// load neither.
    /// </summary>
    internal static class MacNative
    {
        private static readonly string[] LibraryDirs = { "/opt/homebrew/lib", "/usr/local/lib" };

        /// <summary>Runs before any WFInfo code touches System.Drawing or Tesseract.</summary>
        public static void Configure()
        {
            if (!OperatingSystem.IsMacOS()) return;

            // .NET puts ApplicationData at ~/Library/Application Support on macOS
            // and does not read XDG_CONFIG_HOME, so the override cannot apply.
            if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("WFINFO_DATA_DIR")))
                Console.Error.WriteLine(
                    "WARNING: WFINFO_DATA_DIR has no effect on macOS; the app dir is " +
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "WFInfo"));

            // Nothing to load at startup: the normal macOS scan and self-check
            // use Apple Vision through wfinfo-mac and never touch System.Drawing,
            // so libgdiplus is not loaded. Developer modes call EnableGdiPlus.
        }

        /// <summary>
        /// For developer modes that run WFInfo's System.Drawing image code
        /// (`--ocr tesseract`, `--test`, `--theme-test`, the Tesseract
        /// self-check). System.Drawing.Common probes "libgdiplus.dylib" in the
        /// runtime dir, its own assembly dir, then by bare name; dyld never
        /// searches the Homebrew prefix, so a link goes in the assembly dir.
        /// Returns false (with a message) when libgdiplus is not installed.
        /// </summary>
        public static bool EnableGdiPlus()
        {
            if (!OperatingSystem.IsMacOS()) return true;

            string brew = FindLibraryDir("libgdiplus.dylib");
            if (brew == null)
            {
                Console.Error.WriteLine(
                    "ERROR: this mode needs libgdiplus (System.Drawing); `brew install mono-libgdiplus`. " +
                    "The normal scan and --selfcheck do not need it.");
                return false;
            }

            string drawingDir = Path.GetDirectoryName(typeof(System.Drawing.Bitmap).Assembly.Location);
            try
            {
                if (!string.IsNullOrEmpty(drawingDir))
                    Link(Path.Combine(drawingDir, "libgdiplus.dylib"), Path.Combine(brew, "libgdiplus.dylib"));
                return true;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"ERROR: cannot link libgdiplus into {drawingDir}: {ex.Message}");
                return false;
            }
        }

        /// <summary>
        /// For runs that use Tesseract (`--ocr tesseract`, the OCR suite):
        /// points the wrapper at Homebrew's libraries. Tesseract is optional on
        /// macOS (`brew install tesseract`); Vision runs never call this.
        /// </summary>
        public static void EnableTesseract()
        {
            if (!OperatingSystem.IsMacOS()) return;
            if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("WFINFO_NATIVE_LIBS"))) return;

            string farm = TesseractFarm();
            if (farm == null)
            {
                Console.Error.WriteLine(
                    "WARNING: Tesseract is not installed; `brew install tesseract` to use --ocr tesseract or the OCR suite.");
                return;
            }
            Environment.SetEnvironmentVariable("WFINFO_NATIVE_LIBS", farm);
            TesseractEnviornment.CustomSearchPath = farm;
        }

        private static string FindLibraryDir(string file)
        {
            foreach (string dir in LibraryDirs)
            {
                if (File.Exists(Path.Combine(dir, file))) return dir;
            }
            return null;
        }

        /// <summary>
        /// The Tesseract wrapper loads exact names (libtesseract50, libleptonica-1.82.0);
        /// Homebrew ships libtesseract.5 / libleptonica.6 with the same C API. A
        /// symlink farm next to the runner maps one onto the other. Null when
        /// Homebrew's tesseract is not installed.
        /// </summary>
        private static string TesseractFarm()
        {
            string dir = FindLibraryDir("libtesseract.5.dylib");
            if (dir == null || !File.Exists(Path.Combine(dir, "libleptonica.6.dylib"))) return null;

            string farm = Path.Combine(AppContext.BaseDirectory, "macos-native");
            try
            {
                // The wrapper probes a per-architecture subfolder, like the flake's farm.
                foreach (string sub in new[] { "", "x64", "x86", "arm64" })
                {
                    string target = Path.Combine(farm, sub);
                    Directory.CreateDirectory(target);
                    Link(Path.Combine(target, "libtesseract50.dylib"), Path.Combine(dir, "libtesseract.5.dylib"));
                    Link(Path.Combine(target, "libleptonica-1.82.0.dylib"), Path.Combine(dir, "libleptonica.6.dylib"));
                }
                return farm;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"WARNING: cannot prepare the Tesseract library links in {farm}: {ex.Message}");
                return null;
            }
        }

        /// <summary>
        /// Makes <paramref name="link"/> a symlink to <paramref name="target"/>.
        /// Two runners can do this at the same time: when the create fails
        /// because the other one made the link first, a link to the same
        /// target is accepted.
        /// </summary>
        private static void Link(string link, string target)
        {
            var info = new FileInfo(link);
            if (info.Exists || info.LinkTarget != null)
            {
                if (info.LinkTarget == target) return;
                info.Delete();
            }
            try
            {
                File.CreateSymbolicLink(link, target);
            }
            catch (IOException) when (new FileInfo(link).LinkTarget == target)
            {
                // Another runner created the same link between the check and the create.
            }
        }
    }
}
