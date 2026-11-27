using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using WFInfo.Errors;
using Xunit;

namespace WFInfo.ScanFlow.Tests.Errors
{
    public class ErrorCatalogTests
    {
        /// <summary>errors/catalog.json of this checkout (found from the test binary upwards).</summary>
        internal static JObject CatalogFile()
        {
            for (DirectoryInfo dir = new DirectoryInfo(AppContext.BaseDirectory); dir != null; dir = dir.Parent)
            {
                string path = Path.Combine(dir.FullName, "errors", "catalog.json");
                if (File.Exists(path)) return JObject.Parse(File.ReadAllText(path));
            }
            throw new FileNotFoundException("errors/catalog.json not found above " + AppContext.BaseDirectory);
        }

        [Fact]
        public void EmbeddedCatalogMatchesTheFile()
        {
            var codes = CatalogFile()["errors"].Select(e => e["code"].ToString()).ToList();
            Assert.Equal(codes, ErrorCatalog.All.Select(e => e.Code).ToList());
        }

        [Fact]
        public void CodesAndNamesAreUnique()
        {
            Assert.Equal(ErrorCatalog.All.Count, ErrorCatalog.All.Select(e => e.Code).Distinct().Count());
            Assert.Equal(ErrorCatalog.All.Count, ErrorCatalog.All.Select(e => e.Name).Distinct().Count());
        }

        [Fact]
        public void EveryEntryHasAKnownAreaAndAWellFormedCode()
        {
            var areas = ((JObject)CatalogFile()["areas"]).Properties().Select(p => p.Name).ToHashSet();
            foreach (ErrorInfo info in ErrorCatalog.All)
            {
                Assert.Contains(info.Area, areas);
                Assert.StartsWith(info.Area + "-", info.Code);
                Assert.True(ErrorMapping.IsCode(info.Code), info.Code);
                Assert.Contains(info.Severity, new[] { "error", "warning", "info" });
                Assert.False(string.IsNullOrWhiteSpace(info.Title + info.Description + info.Action));
            }
        }

        public static IEnumerable<object[]> Vectors() =>
            CatalogFile()["generated"]["testVectors"].Select(v => new object[]
            {
                v["input"].ToString(), v["hash"].ToString(), v["code"].ToString(), v["name"].ToString(),
            });

        [Theory]
        [MemberData(nameof(Vectors))]
        public void GeneratedCodesReproduceTheTestVectors(string input, string hash, string code, string name)
        {
            Assert.Equal(hash, ErrorCatalog.Fnv1a32(input).ToString("x8"));
            ErrorInfo info = ErrorCatalog.Generated(input);
            Assert.Equal(code, info.Code);
            Assert.Equal(name, info.Name);
            Assert.True(info.Generated);
        }

        [Fact]
        public void ForExceptionUsesTheCodeOfAScanFailure()
        {
            ErrorInfo info = ErrorCatalog.ForException(new ScanFailure("CAP-001", "denied"));
            Assert.Equal("CAP-001", info.Code);
            Assert.Equal("Shutter", info.Name);
            Assert.False(info.Generated);
        }

        [Fact]
        public void ForExceptionKeepsAnUnlistedCodeAndItsName()
        {
            ErrorInfo info = ErrorCatalog.ForException(new ScanFailure("PLG-042", "socket closed") { ReportedName = "Pylon" });
            Assert.Equal("PLG-042", info.Code);
            Assert.Equal("Pylon", info.Name);
            Assert.Equal("PLG", info.Area);
        }

        [Fact]
        public void ForExceptionMapsAMissingNativeLibrary()
        {
            Assert.Equal("SYS-005", ErrorCatalog.ForException(new DllNotFoundException("Unable to load wfinfo_layout")).Code);
            Assert.Equal("SYS-006", ErrorCatalog.ForException(
                new TypeInitializationException("Gdip", new DllNotFoundException("libgdiplus"))).Code);
            Assert.Equal("SYS-007", ErrorCatalog.ForException(new DllNotFoundException("Failed to find library libleptonica")).Code);
        }

        private static void ThrowPlain() => throw new InvalidOperationException("boom");

        [Fact]
        public void ForExceptionGeneratesACodeForAPlainException()
        {
            InvalidOperationException error = Assert.Throws<InvalidOperationException>(ThrowPlain);
            string site = ErrorCatalog.Site(error);
            Assert.Equal("WFInfo.ScanFlow.Tests.Errors.ErrorCatalogTests.ThrowPlain", site);
            ErrorInfo info = ErrorCatalog.ForException(error);
            Assert.True(info.Generated);
            Assert.Equal(ErrorCatalog.Generated("System.InvalidOperationException|" + site).Code, info.Code);
            Assert.Matches("^GEN-[0-9a-f]{6}$", info.Code);
        }

        private static async Task ThrowLaterAsync()
        {
            await Task.Yield();
            throw new IOException("late");
        }

        [Fact]
        public async Task SiteOfAnAsyncMethodIsTheMethodNotTheStateMachine()
        {
            IOException error = await Assert.ThrowsAsync<IOException>(ThrowLaterAsync);
            Assert.Equal("WFInfo.ScanFlow.Tests.Errors.ErrorCatalogTests.ThrowLaterAsync", ErrorCatalog.Site(error));
        }
    }
}
