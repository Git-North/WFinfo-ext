using System;
using WFInfo.MacOS;
using Xunit;

namespace WFInfo.Headless.Tests
{
    public class OcrEnginesTests
    {
        private static EnvScope CleanEnvironment() =>
            new EnvScope(("WFINFO_OCR_ENGINE", null), (MacHelper.Variable, null));

        [Fact]
        public void Tesseract_is_accepted_in_any_case_and_with_spaces()
        {
            using var env = CleanEnvironment();
            Assert.Equal("tesseract", OcrEngines.Resolve("  Tesseract "));
        }

        [Fact]
        public void The_environment_sets_the_default_engine()
        {
            using var env = CleanEnvironment();
            env.Set("WFINFO_OCR_ENGINE", "TESSERACT");
            Assert.Equal("tesseract", OcrEngines.Resolve(null));
        }

        [Fact]
        public void An_unknown_engine_is_refused_by_name()
        {
            using var env = CleanEnvironment();
            var error = Assert.Throws<ArgumentException>(() => OcrEngines.Resolve("magic"));
            Assert.Contains("'magic'", error.Message);
        }

        [NotMacFact]
        public void Off_macOS_auto_means_Tesseract_and_Vision_is_refused()
        {
            using var env = CleanEnvironment();
            Assert.Equal("tesseract", OcrEngines.Resolve("auto"));
            Assert.Throws<ArgumentException>(() => OcrEngines.Resolve("vision"));
        }

        [MacFact]
        public void With_a_helper_auto_and_vision_mean_Vision()
        {
            using var dir = new TempDir();
            using var env = CleanEnvironment();
            env.Set(MacHelper.Variable, Helpers.Script(dir, "exit 0"));

            Assert.Equal("vision", OcrEngines.Resolve(null));
            Assert.Equal("vision", OcrEngines.Resolve(""));
            Assert.Equal("vision", OcrEngines.Resolve("vision"));
        }

        [MacFact]
        public void A_helper_override_that_names_no_file_is_an_error_not_a_fallback()
        {
            using var dir = new TempDir();
            using var env = CleanEnvironment();
            env.Set(MacHelper.Variable, dir.File("missing"));

            Assert.Contains("names a missing file", Assert.Throws<ArgumentException>(() => OcrEngines.Resolve("auto")).Message);
            Assert.Contains("names a missing file", Assert.Throws<ArgumentException>(() => OcrEngines.Resolve("vision")).Message);
            Assert.Equal("tesseract", OcrEngines.Resolve("tesseract"));
        }
    }
}
