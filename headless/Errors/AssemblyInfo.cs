using System.Runtime.CompilerServices;

// The dev-only xUnit tests (tests/scan-flow/dotnet, later tests/headless)
// test the internal error types directly.
[assembly: InternalsVisibleTo("WFInfo.Headless.Tests")]
