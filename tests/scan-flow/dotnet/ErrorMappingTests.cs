using Newtonsoft.Json.Linq;
using WFInfo.Errors;
using Xunit;

namespace WFInfo.ScanFlow.Tests.Errors
{
    public class ErrorMappingTests
    {
        [Theory]
        [InlineData("[CAP-001] screen capture is not allowed", "CAP-001", "screen capture is not allowed")]
        [InlineData("CAP-001 Shutter: Screen Recording not allowed (x)", "CAP-001", "Shutter: Screen Recording not allowed (x)")]
        [InlineData("OCR-001: failed", "OCR-001", "failed")]
        [InlineData("GEN-a121f2", "GEN-a121f2", "")]
        public void ReadsALeadingCode(string text, string code, string rest)
        {
            Assert.True(ErrorMapping.TryParseCode(text, out string found, out string after));
            Assert.Equal(code, found);
            Assert.Equal(rest, after);
        }

        [Theory]
        [InlineData("capture expects an output .png path")]
        [InlineData("CAP-0012 too long")]
        [InlineData("cap-001 lower case")]
        [InlineData("")]
        public void TextWithoutACodeHasNone(string text)
        {
            Assert.False(ErrorMapping.TryParseCode(text, out _, out _));
            Assert.Null(ErrorMapping.FromCodedText(text));
        }

        [Fact]
        public void MapsTheRustLayoutErrorObject()
        {
            ScanFailure failure = ErrorMapping.FromJson(
                JObject.Parse("{\"error\":{\"code\":\"LAY-001\",\"message\":\"the helper answer is null\"}}"), "LAY-002");
            Assert.Equal("LAY-001", failure.Code);
            Assert.Equal("the helper answer is null", failure.Detail);
        }

        [Fact]
        public void MapsAnotherComponentsErrorWithItsName()
        {
            ScanFailure failure = ErrorMapping.FromJson(
                JObject.Parse("{\"ok\":false,\"error\":{\"code\":\"PLG-003\",\"name\":\"Pylon\",\"message\":\"no socket\"}}"), "LAY-002");
            Assert.Equal("PLG-003", failure.Code);
            Assert.Equal("Pylon", failure.ReportedName);
        }

        [Fact]
        public void PlainOrBadErrorsGetTheFallbackCode()
        {
            Assert.Equal("LAY-002", ErrorMapping.FromJson(new JValue("internal error"), "LAY-002").Code);
            Assert.Equal("LAY-002", ErrorMapping.FromJson(JObject.Parse("{\"code\":\"nonsense\",\"message\":\"m\"}"), "LAY-002").Code);
            Assert.Null(ErrorMapping.FromJson(JValue.CreateNull(), "LAY-002"));
            Assert.Null(ErrorMapping.FromJson(null, "LAY-002"));
        }

        [Fact]
        public void ErrorLineHasTheContractShape()
        {
            ErrorInfo info = ErrorCatalog.Get("SYS-004");
            Assert.Equal("ERROR SYS-004 Keystone: Helper path is wrong — " + info.Description + " (crash report: ~/x.txt)",
                ErrorConsole.Line(info, "~/x.txt"));
            Assert.StartsWith("WARNING DAT-002 Ledger:", ErrorConsole.Line(ErrorCatalog.Get("DAT-002")));
        }
    }
}
