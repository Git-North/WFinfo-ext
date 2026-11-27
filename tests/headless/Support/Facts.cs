using System;
using Xunit;

// The runner has process-wide state (environment variables, the console,
// WFInfo's static OCR and database objects), so tests run one at a time.
[assembly: CollectionBehavior(DisableTestParallelization = true)]

namespace WFInfo.Headless.Tests
{
    /// <summary>Skip reasons shared by the attributes below.</summary>
    internal static class Needs
    {
        public static string Unix => OperatingSystem.IsWindows() ? "needs a Unix shell" : null;

        public static string Mac => OperatingSystem.IsMacOS() ? null : "needs macOS (Apple Vision)";

        public static string Sandbox => Tests.Sandbox.Active
            ? null
            : "needs the sandbox app-data folder: run through `deno run -A tests/run.ts dotnet`";
    }

    /// <summary>Linux and macOS: uses a stand-in shell script or Unix paths.</summary>
    public sealed class UnixFactAttribute : FactAttribute
    {
        public UnixFactAttribute() => Skip = Needs.Unix;
    }

    /// <summary>macOS only.</summary>
    public sealed class MacFactAttribute : FactAttribute
    {
        public MacFactAttribute() => Skip = Needs.Mac;
    }

    /// <summary>Not macOS: the behaviour of other hosts.</summary>
    public sealed class NotMacFactAttribute : FactAttribute
    {
        public NotMacFactAttribute() => Skip = OperatingSystem.IsMacOS() ? "not for macOS" : null;
    }

    /// <summary>Writes into the app-data folder, which must be the sandbox.</summary>
    public sealed class SandboxFactAttribute : FactAttribute
    {
        public SandboxFactAttribute() => Skip = Needs.Sandbox;
    }

    /// <summary>macOS and the sandbox app-data folder.</summary>
    public sealed class MacSandboxFactAttribute : FactAttribute
    {
        public MacSandboxFactAttribute() => Skip = Needs.Mac ?? Needs.Sandbox;
    }
}
