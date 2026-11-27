using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Tesseract;
using WFInfo.Errors;
using WFInfo.MacOS;
using WFInfo.Scan;
using WFInfo.Services.HDRDetection;
using WFInfo.Services.WarframeProcess;
using WFInfo.Services.WindowInfo;
using WFInfo.Settings;
using WFInfo.Tests;
using WFInfoMain = WFInfo.Main;

namespace WFInfo
{
    /// <summary>
    /// WFInfo.Headless — native Linux/macOS entry point for WFInfo's real OCR/theme core.
    ///
    /// The sources under headless/Platform plus the linked WFInfo core files form a
    /// net9.0 console build with no WPF/WinForms/Win32 dependencies, so the OCR test
    /// suite, the theme-detection runner, and engine self-checks run natively on Linux.
    ///
    /// Modes (mirroring CustomEntrypoint):
    ///   WFInfo.Headless --test map.json [results.json]   OCR regression suite
    ///   WFInfo.Headless map.json [results.json]          (flag is optional)
    ///   WFInfo.Headless --theme-debug <folder> [uiScale] theme detection runner
    ///   WFInfo.Headless --theme-test  <folder> [uiScale] alias of --theme-debug
    ///   WFInfo.Headless --selfcheck [--ocr <engine>]     end-to-end OCR engine check
    ///   WFInfo.Headless --scan [options]                 reward-screen scan (capture + OCR + prices)
    ///   WFInfo.Headless --scan --watch [options]         scan on every reward screen (EE.log watch)
    ///
    /// Environment:
    ///   WFINFO_NATIVE_LIBS  directory with libtesseract50.so + libleptonica-1.82.0.so
    ///                       (see nix flake devShell; on Windows the app downloads them)
    ///   WFINFO_DATA_DIR     override for the application-data root (defaults to the
    ///                       OS XDG config dir; tessdata + market DBs land below it)
    ///   WFINFO_EE_LOG       EE.log path for --watch (else the Steam/Proton prefix
    ///                       is searched)
    /// </summary>
    internal static class HeadlessProgram
    {
        private const int ExitAllPassed = 0;
        private const int ExitSomeFailed = 1;
        private const int ExitFatal = 2;

        /// <summary>
        /// Top-level guard: any exception that escapes a mode writes a crash
        /// report and prints "ERROR &lt;code&gt; &lt;name&gt;: … (crash report: …)", exit 2.
        /// </summary>
        public static async Task<int> Main(string[] args)
        {
            AppDomain.CurrentDomain.UnhandledException += (_, e) =>
                ErrorConsole.Fail(e.ExceptionObject as Exception ?? new InvalidOperationException("unhandled non-exception object"), "runner", true);
            try
            {
                return await RunMode(args).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                return ErrorConsole.Fail(ex, "runner", true);
            }
        }

        private static async Task<int> RunMode(string[] args)
        {
            Console.OutputEncoding = System.Text.Encoding.UTF8;
            ConfigureEnvironment();

            // Developer hook: proves the guard and the crash report end to end.
            if (Environment.GetEnvironmentVariable("WFINFO_FAULT") == "crash")
                throw new InvalidOperationException("forced failure (WFINFO_FAULT=crash)");

            string[] clean = args ?? Array.Empty<string>();
            if (clean.Length == 0)
            {
                PrintUsage();
                return ExitFatal;
            }

            string first = clean[0];

            if (first.Equals("--test", StringComparison.OrdinalIgnoreCase) ||
                first.Equals("-test", StringComparison.OrdinalIgnoreCase) ||
                first.Equals("--map", StringComparison.OrdinalIgnoreCase))
            {
                return await RunOcrSuite(clean.Skip(1).ToArray()).ConfigureAwait(false);
            }

            if (first.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
            {
                return await RunOcrSuite(clean).ConfigureAwait(false);
            }

            if (first.Equals("--theme-debug", StringComparison.OrdinalIgnoreCase) ||
                first.Equals("--theme-test", StringComparison.OrdinalIgnoreCase))
            {
                string folder = clean.Length > 1 ? clean[1] : ".";
                double overrideScale = clean.Length > 2 &&
                    double.TryParse(clean[2], System.Globalization.NumberStyles.Float,
                        System.Globalization.CultureInfo.InvariantCulture, out double scale)
                    ? scale : -1;
                if (!MacNative.EnableGdiPlus()) return ExitFatal;
                return ThemeTestRunner.Run(folder, overrideScale);
            }

            if (first.Equals("--selfcheck", StringComparison.OrdinalIgnoreCase))
            {
                return await RunSelfCheck(clean.Skip(1).ToArray()).ConfigureAwait(false);
            }

            if (first.Equals("--scan", StringComparison.OrdinalIgnoreCase))
            {
                return await RunScan(clean.Skip(1).ToArray()).ConfigureAwait(false);
            }

            PrintUsage();
            return ExitFatal;
        }

        private static void ConfigureEnvironment()
        {
            // Point .NET's ApplicationData folder at an override BEFORE any WFInfo
            // static initializer runs (those capture the path at class load).
            string dataDir = Environment.GetEnvironmentVariable("WFINFO_DATA_DIR");
            if (!string.IsNullOrEmpty(dataDir))
                Environment.SetEnvironmentVariable("XDG_CONFIG_HOME", dataDir);

            // Native tesseract/leptonica location. The Windows app downloads these
            // to %APPDATA%; on Linux they come from the nix flake (or the distro).
            string nativeLibs = Environment.GetEnvironmentVariable("WFINFO_NATIVE_LIBS");
            if (!string.IsNullOrEmpty(nativeLibs))
                TesseractEnviornment.CustomSearchPath = nativeLibs;

            // macOS without Nix: libgdiplus comes from Homebrew (no-op on other
            // systems). Tesseract is linked later, only when it runs.
            MacNative.Configure();
        }

        private static async Task<int> RunOcrSuite(string[] args)
        {
            if (args.Length < 1)
            {
                Console.Error.WriteLine("Usage: WFInfo.Headless --test <map.json> [results.json]");
                return ExitFatal;
            }

            string mapPath = args[0];
            string outputPath = args.Length > 1
                ? args[1]
                : $"test_results_{DateTime.Now:yyyyMMdd_HHmmss}.json";

            Console.WriteLine("WFInfo OCR Test Runner (headless)");
            Console.WriteLine("=================================");
            Console.WriteLine($"Map:    {Path.GetFullPath(mapPath)}");
            Console.WriteLine($"Output: {Path.GetFullPath(outputPath)}");
            Console.WriteLine();

            if (!File.Exists(mapPath))
            {
                Console.Error.WriteLine($"ERROR: map file not found: {mapPath}");
                return ExitFatal;
            }

            if (!MacNative.EnableGdiPlus()) return ExitFatal;
            PrepareTesseract();

            try
            {
                Console.WriteLine("Initializing services...");
                var settings = ApplicationSettings.GlobalSettings;
                settings.Debug = true;

                var processFinder = new HeadlessProcessFinder();
                var windowService = new HeadlessWindowInfoService();

                Console.WriteLine("Updating databases (network; first run may take a while)...");
                WFInfoMain.dataBase = new Data(ApplicationSettings.GlobalReadonlySettings, processFinder, windowService);
                await WFInfoMain.dataBase.Update().ConfigureAwait(false);
                Console.WriteLine("Databases ready.");

                Console.WriteLine("Initializing OCR engines (tessdata is fetched on demand)...");
                var suiteService = new TesseractService();
                try
                {
                    OCR.InitForTest(
                        suiteService,
                        ApplicationSettings.GlobalReadonlySettings,
                        windowService,
                        new HeadlessHDRDetector(false));
                    Console.WriteLine("OCR engine ready.");
                    Console.WriteLine();

                    var runner = new OCRTestRunner(windowService);
                    var results = runner.RunTestSuite(mapPath);
                    OCRTestRunner.SaveResults(results, outputPath);
                    PersistSuiteResults(results);
                    PrintSummary(results);

                    Console.WriteLine();
                    Console.WriteLine($"Results saved to: {Path.GetFullPath(outputPath)}");

                    if (!string.IsNullOrEmpty(results.ErrorMessage))
                        return ExitFatal;
                    if (results.FailedTests > 0 || results.ErrorTests > 0)
                        return ExitSomeFailed;
                    return ExitAllPassed;
                }
                finally
                {
                    suiteService.Dispose();
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("Test execution failed.");
                return ErrorConsole.Fail(ex, "ocr-suite");
            }
        }

        /// <summary>
        /// Reward-screen scan (`--scan`): capture the screen (or read a PNG), run
        /// the shared OCR pipeline over it, price every recognised part from the
        /// local price cache (filling it from warframe.market on demand), pick the
        /// best platinum choice, then persist a scan record under
        /// &lt;app dir&gt;/scans for the dashboard and show the verdict as a desktop
        /// notification.
        ///
        /// The cached market databases are read from disk instead of calling
        /// Data.Update(): a hotkey press must not wait for a network refresh.
        /// </summary>
        private static async Task<int> RunScan(string[] args)
        {
            ScanOptions options;
            try
            {
                options = ScanOptions.Parse(args);
            }
            catch (ArgumentException ex)
            {
                Console.Error.WriteLine("ERROR: " + ex.Message);
                PrintScanUsage();
                return ExitFatal;
            }
            catch (ScanFailure ex)
            {
                return ErrorConsole.Fail(ex, "scan");
            }

            if (options.Help)
            {
                PrintScanUsage();
                return ExitAllPassed;
            }

            if (options.Ocr == "tesseract")
            {
                // WFInfo's own extraction: System.Drawing (libgdiplus) + Tesseract.
                if (!MacNative.EnableGdiPlus()) return ExitFatal;
                PrepareTesseract();
            }

            try
            {
                var settings = ApplicationSettings.GlobalSettings;
                settings.Locale = "en";
                settings.Debug = false;

                var processFinder = new HeadlessProcessFinder();
                var windowService = new HeadlessWindowInfoService();

                var data = new Data(ApplicationSettings.GlobalReadonlySettings, processFinder, windowService)
                {
                    marketItems = LoadLocalJson(ScanPaths.MarketItems, "DAT-001"),
                    marketData = LoadLocalJson(ScanPaths.MarketData, "DAT-002"),
                    nameData = LoadLocalJson(ScanPaths.NameData, "DAT-003"),
                };
                WFInfoMain.dataBase = data;

                // macOS Vision layout: the helper captures and reads the screen, so
                // no Tesseract engine, no tessdata and no System.Drawing are used.
                VisionRewardScan vision = null;
                if (options.Ocr == "vision")
                {
                    double? uiScale = options.UiScaleMode == "auto"
                        ? EeLog.ReadUiScale(options.LogPath)
                        : options.UiScale;
                    vision = new VisionRewardScan(uiScale);
                }
                var tesseractService = vision == null ? new TesseractService() : null;
                try
                {
                    OCR.InitForTest(
                        (ITesseractService)tesseractService ?? new NoTesseractService(),
                        ApplicationSettings.GlobalReadonlySettings,
                        windowService,
                        new HeadlessHDRDetector(false));

                    using (var http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) })
                    {
                        http.DefaultRequestHeaders.UserAgent.ParseAdd(
                            "WFInfo/" + WFInfoMain.BuildVersion + " (+https://github.com/cernoh/WFinfo-ext)");

                        MarketSheet sheet = MarketSheet.Load(ScanPaths.MarketItems, ScanPaths.MarketData, out string sheetWarning);
                        if (!string.IsNullOrEmpty(sheetWarning))
                            Console.Error.WriteLine("WARNING: " + sheetWarning);

                        var cache = new PriceCache(ScanPaths.PriceCache, http);
                        var runner = new ScanRunner(options, windowService, sheet, cache, settings, vision);

                        if (!options.Watch)
                            return await runner.RunAsync().ConfigureAwait(false);

                        return await WatchAsync(options, runner).ConfigureAwait(false);
                    }
                }
                finally
                {
                    tesseractService?.Dispose();
                }
            }
            catch (Exception ex)
            {
                return ErrorConsole.Fail(ex, "scan");
            }
        }

        /// <summary>
        /// Watch mode: tail Warframe's EE.log and run a scan for every reward
        /// screen the game announces. The OCR engines, market sheet and price
        /// cache are already built by the caller, so each triggered scan is one
        /// capture plus the OCR — the reason an answer arrives in well under a
        /// second. Ctrl-C (or SIGTERM) stops the watch.
        /// </summary>
        private static async Task<int> WatchAsync(ScanOptions options, ScanRunner runner)
        {
            string logPath = EeLog.Resolve(options.LogPath);
            if (logPath == null)
            {
                ErrorConsole.Print("LOG-001",
                    options.LogPath != null
                        ? $"no such log file: {Path.GetFullPath(options.LogPath)}"
                        : "looked in:");
                if (options.LogPath == null)
                {
                    foreach (string candidate in EeLog.CandidatePaths())
                        Console.Error.WriteLine("  " + Redact.Path(candidate));
                }
                return ExitFatal;
            }

            // Ctrl-C and SIGTERM both stop the watch between scans, so a kill
            // never lands in the middle of writing a scan record. The handlers
            // are detached before the source is disposed: a ProcessExit-time
            // signal would otherwise cancel a disposed source and abort.
            var cancellation = new CancellationTokenSource();
            ConsoleCancelEventHandler onCancelKeyPress = (_, e) =>
            {
                e.Cancel = true;
                cancellation.Cancel();
            };
            Console.CancelKeyPress += onCancelKeyPress;
            using PosixSignalRegistration term = PosixSignalRegistration.Create(
                PosixSignal.SIGTERM,
                context =>
                {
                    context.Cancel = true;
                    cancellation.Cancel();
                });

            try
            {
                var watcher = new ScanWatcher(logPath, options, runner.RunAsync, Console.Out);
                return await watcher.RunAsync(cancellation.Token).ConfigureAwait(false);
            }
            finally
            {
                Console.CancelKeyPress -= onCancelKeyPress;
                cancellation.Dispose();
            }
        }

        /// <summary>
        /// Reads one of WFInfo's cached database files. A missing or unreadable
        /// file is its catalog code (DAT-001/002/003): an error-severity code
        /// stops the scan (ScanFailure); a warning is printed and gives an
        /// empty object.
        /// </summary>
        private static JObject LoadLocalJson(string path, string code)
        {
            string problem = null;
            Exception cause = null;
            if (!File.Exists(path))
            {
                problem = $"{Path.GetFileName(path)} missing at {path}";
            }
            else
            {
                try
                {
                    return JObject.Parse(File.ReadAllText(path));
                }
                catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is JsonException)
                {
                    problem = $"cannot read {Path.GetFileName(path)}: {ex.Message}";
                    cause = ex;
                }
            }

            if (ErrorCatalog.Get(code)?.Severity == "error")
                throw new ScanFailure(code, Redact.Text(problem), cause);
            ErrorConsole.Print(code, problem);
            return new JObject();
        }

        private static void PrintScanUsage()
        {
            Console.WriteLine("Usage: WFInfo.Headless --scan [options]");
            Console.WriteLine();
            Console.WriteLine("  --file <png>      OCR this screenshot instead of capturing the screen");
            Console.WriteLine("  --output <name>   grim output (Linux) or display id (macOS) to capture;");
            Console.WriteLine("                    default tries every output");
            Console.WriteLine("  --region \"X,Y WxH\" capture one layout region (a window's frame), e.g. \"10,44 1900x1026\" (Linux)");
            Console.WriteLine("  --window <id>     capture one window by its id (macOS, see `wfinfo-mac windows`)");
            Console.WriteLine("                    --file wins over --window/--region, those over --output");
            Console.WriteLine("  --ocr <engine>    auto | vision | tesseract (default auto: Vision on macOS)");
            Console.WriteLine("  --ui-scale <s>    macOS Vision scan: auto (EE.cfg, default) | unknown (estimate) | 0.5-1.25");
            Console.WriteLine("  --theme <name>    force a UI theme instead of the automatic probe");
            Console.WriteLine("                    (auto | " + ScanOptions.ThemeNames() + ")");
            Console.WriteLine("  --refresh         ignore the local price-cache TTL for this run");
            Console.WriteLine("  --ttl <hours>     price-cache lifetime in hours (default 6)");
            Console.WriteLine("  --no-notify       do not post the desktop notification");
            Console.WriteLine("  --json            print the scan record to stdout");
            Console.WriteLine();
            Console.WriteLine("Watch mode (scan automatically when the game shows a reward screen):");
            Console.WriteLine("  --watch           tail Warframe's EE.log and scan on every reward screen");
            Console.WriteLine("  --once            scan on the first trigger, then exit");
            Console.WriteLine("  --log <path>      EE.log to watch (default: the Steam/Proton prefix,"
                + " or $WFINFO_EE_LOG)");
            Console.WriteLine("  --wait <seconds>  re-capture until a part is recognised (default 10 in watch)");
            Console.WriteLine("  --cooldown <s>    ignore further triggers for this long after a scan (default 5)");
        }

        /// <summary>
        /// Copies the suite results into the app-data dir so the WFInfo Dashboard
        /// ("Recently seen" page) can surface OCR runs without knowing the CLI's
        /// output path: &lt;app dir&gt;/ocr_runs/latest.json plus one timestamped file.
        /// </summary>
        private static void PersistSuiteResults(TestSuiteResult results)
        {
            try
            {
                string runsDir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    "WFInfo", "ocr_runs");
                Directory.CreateDirectory(runsDir);
                string json = JsonConvert.SerializeObject(results, Formatting.Indented);
                File.WriteAllText(Path.Combine(runsDir, "latest.json"), json);
                string stamp = DateTime.UtcNow.ToString(
                    "yyyyMMdd_HHmmssfff", System.Globalization.CultureInfo.InvariantCulture);
                File.WriteAllText(
                    Path.Combine(runsDir, results.TestSuiteName + "-" + stamp + ".json"),
                    json);
                WFInfoMain.AddLog("Suite results persisted to: " + runsDir);
                PruneOldRunFiles(runsDir);
            }
            catch (Exception ex)
            {
                WFInfoMain.AddLog("Failed to persist suite results: " + ex);
            }
        }

        /// <summary>Keeps latest.json plus the 59 newest timestamped run files.</summary>
        private static void PruneOldRunFiles(string runsDir)
        {
            try
            {
                var files = new DirectoryInfo(runsDir).GetFiles("*.json")
                    .OrderByDescending(f => f.LastWriteTimeUtc).ToList();
                foreach (FileInfo old in files.Skip(60))
                {
                    old.Delete();
                }
            }
            catch (Exception ex)
            {
                WFInfoMain.AddLog("Failed to prune old OCR run files: " + ex.Message);
            }
        }

        private static void PrintSummary(TestSuiteResult results)
        {
            Console.WriteLine();
            Console.WriteLine("=== Summary ===");
            Console.WriteLine($"Total:  {results.TotalTests}");
            Console.WriteLine($"Passed: {results.PassedTests}");
            Console.WriteLine($"Failed: {results.FailedTests}");
            Console.WriteLine($"Errors: {results.ErrorTests}");
            Console.WriteLine($"Pass rate: {results.PassRate:F1}%  Overall accuracy: {results.OverallAccuracy:F1}%");
            if (!string.IsNullOrEmpty(results.ErrorMessage))
                Console.WriteLine($"Suite error: {results.ErrorMessage}");
        }

        /// <summary>
        /// Renders "Volt Prime Blueprint" through the real OCR pipeline to prove the
        /// full native stack works on this machine — no game screenshot required.
        /// Tesseract: libtesseract + leptonica + tessdata + System.Drawing. Vision
        /// (macOS): the wfinfo-mac helper renders with CoreText and reads with
        /// Apple's text recognizer; no System.Drawing.
        /// `--ocr` picks the engine (default auto: Vision on macOS).
        /// </summary>
        private static async Task<int> RunSelfCheck(string[] args)
        {
            Console.WriteLine("WFInfo Headless Self-Check");
            Console.WriteLine("===========================");

            string engineName;
            try
            {
                string requested = null;
                for (int i = 0; i < args.Length; i++)
                {
                    if (args[i].Equals("--ocr", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
                        requested = args[++i];
                    else
                        throw new ArgumentException("Unknown self-check option: " + args[i]);
                }
                engineName = OcrEngines.Resolve(requested);
            }
            catch (ArgumentException ex)
            {
                Console.Error.WriteLine("ERROR: " + ex.Message);
                return ExitFatal;
            }
            catch (ScanFailure ex)
            {
                return ErrorConsole.Fail(ex, "selfcheck");
            }

            Console.WriteLine("OCR engine: " + engineName);
            string debugOut = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "WFInfo", "selfcheck.png");
            Directory.CreateDirectory(Path.GetDirectoryName(debugOut));

            if (engineName == "vision")
            {
                // The helper renders the sample with CoreText and reads it with
                // Vision: no System.Drawing (libgdiplus) in this process.
                try
                {
                    var watch = System.Diagnostics.Stopwatch.StartNew();
                    string device = (Environment.GetEnvironmentVariable("WFINFO_VISION_DEVICE") ?? "auto").Trim().ToLowerInvariant();
                    JToken answer = MacHelper.Run(new[] { "selfcheck", "--save", debugOut, "--device", device }, 60000);
                    string visionText = (answer["text"]?.ToString() ?? string.Empty).Trim();
                    Console.WriteLine($"Vision device: {device}; Vision time {answer["ms"]} ms, call {watch.ElapsedMilliseconds} ms");
                    return ReportSelfCheck(visionText);
                }
                catch (InvalidOperationException ex)
                {
                    Console.Error.WriteLine("Self-check failed.");
                    return ErrorConsole.Fail(ex, "selfcheck");
                }
            }

            // Tesseract: WFInfo's own System.Drawing + Tesseract stack.
            if (!MacNative.EnableGdiPlus()) return ExitFatal;
            PrepareTesseract();

            try
            {
                var settings = ApplicationSettings.GlobalSettings;
                settings.Locale = "en";
                settings.Debug = false;

                var windowService = new HeadlessWindowInfoService();
                var tesseractService = new TesseractService();
                try
                {
                    OCR.InitForTest(
                        tesseractService,
                        ApplicationSettings.GlobalReadonlySettings,
                        windowService,
                        new HeadlessHDRDetector(false));

                    using (var image = RenderSampleImage())
                    {
                        image.Save(debugOut, System.Drawing.Imaging.ImageFormat.Png);

                        string text = string.Empty;
                        var watch = System.Diagnostics.Stopwatch.StartNew();
                        foreach (var engine in tesseractService.Engines)
                        {
                            if (engine == null) continue;
                            text = OCR.GetTextFromImage(image, engine);
                            if (!string.IsNullOrWhiteSpace(text)) break;
                        }
                        Console.WriteLine($"Tesseract time {watch.ElapsedMilliseconds} ms");
                        return ReportSelfCheck((text ?? string.Empty).Trim());
                    }
                }
                finally
                {
                    tesseractService.Dispose();
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("Self-check failed.");
                return ErrorConsole.Fail(ex, "selfcheck");
            }
        }

        private static int ReportSelfCheck(string text)
        {
            Console.WriteLine($"Recognized text: \"{text}\"");
            bool ok = text.Contains("Volt", StringComparison.OrdinalIgnoreCase);
            Console.WriteLine(ok ? "SELF-CHECK PASSED" : "SELF-CHECK FAILED (expected text containing 'Volt')");
            return ok ? ExitAllPassed : ExitSomeFailed;
        }

        private static Bitmap RenderSampleImage()
        {
            int width = 1400, height = 260;
            var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(bitmap))
            {
                g.Clear(Color.White);

                FontFamily family = ResolveFontFamily(g);
                using (var font = new Font(family, 64f, FontStyle.Regular, GraphicsUnit.Pixel))
                using (var brush = new SolidBrush(Color.Black))
                {
                    var format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
                    g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAlias;
                    g.DrawString("Volt Prime Blueprint", font, brush, new RectangleF(0, 0, width, height), format);
                }
            }
            return bitmap;
        }

        private static FontFamily ResolveFontFamily(Graphics g)
        {
            try
            {
                var installed = new InstalledFontCollection();
                string preferred = installed.Families.FirstOrDefault(f =>
                    f.Name.Equals("DejaVu Sans", StringComparison.OrdinalIgnoreCase) ||
                    f.Name.Equals("Helvetica", StringComparison.OrdinalIgnoreCase))?.Name;
                if (preferred != null)
                    return new FontFamily(preferred);
            }
            catch
            {
                // fall through to generic
            }
            return FontFamily.GenericSansSerif;
        }

        /// <summary>
        /// Called only when Tesseract will run. macOS: links Homebrew's
        /// libtesseract/libleptonica now (Vision runs never load them). Linux:
        /// warns when the flake's native-library dir is not set.
        /// </summary>
        private static void PrepareTesseract()
        {
            if (OperatingSystem.IsMacOS())
            {
                MacNative.EnableTesseract();
                return;
            }

            if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("WFINFO_NATIVE_LIBS")))
                Console.Error.WriteLine(
                    "WARNING: WFINFO_NATIVE_LIBS is not set; Tesseract native libraries may not load. " +
                    "Run inside `nix develop` or point it at a directory containing libtesseract50.so and libleptonica-1.82.0.so.");
        }

        private static void PrintUsage()
        {
            Console.WriteLine("WFInfo.Headless — native Linux/macOS runner for WFInfo's OCR/theme core");
            Console.WriteLine();
            Console.WriteLine("Usage:");
            Console.WriteLine("  WFInfo.Headless --test <map.json> [results.json]   Run OCR regression suite");
            Console.WriteLine("  WFInfo.Headless <map.json> [results.json]           (flag optional)");
            Console.WriteLine("  WFInfo.Headless --theme-debug <folder> [uiScale]   Run theme detection over PNGs");
            Console.WriteLine("  WFInfo.Headless --selfcheck [--ocr <engine>]        Verify the OCR engine end-to-end");
            Console.WriteLine("  WFInfo.Headless --scan [options]                    Reward-screen scan (see --scan --help)");
            Console.WriteLine("  WFInfo.Headless --scan --watch                      Scan automatically on every reward screen");
            Console.WriteLine();
            Console.WriteLine("Environment:");
            Console.WriteLine("  WFINFO_NATIVE_LIBS  dir with libtesseract50.so + libleptonica-1.82.0.so");
            Console.WriteLine("  WFINFO_DATA_DIR     application-data root override (tessdata + market DBs)");
            Console.WriteLine("  WFINFO_OCR_ENGINE   default OCR engine: auto | vision | tesseract");
            Console.WriteLine("  WFINFO_VISION_DEVICE  Vision compute device: auto | ane | gpu | cpu (macOS)");
            Console.WriteLine("  WFINFO_MAC_HELPER   path of the wfinfo-mac helper (macOS; default next to the runner)");
            Console.WriteLine("  WFINFO_EE_LOG       EE.log path for --scan --watch");
        }
    }
}
