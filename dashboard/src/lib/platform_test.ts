import { assertEquals } from "./testutil.ts";
import { defaultScanCommand, macHelperPath, shellQuote } from "./platform.ts";

const DLL = "/repo/headless/bin/Debug/net9.0/WFInfo.Headless.dll";

Deno.test("macOS runs the prebuilt runner DLL when it exists", () => {
  assertEquals(
    defaultScanCommand({
      os: "darwin",
      scanRoot: "/repo",
      flakeRoot: "/repo",
      isFile: (path) => path === DLL,
    }),
    `dotnet '${DLL}' --scan --no-notify`,
  );
});

Deno.test("macOS builds the runner with dotnet run when no DLL exists", () => {
  assertEquals(
    defaultScanCommand({
      os: "darwin",
      scanRoot: "/repo",
      flakeRoot: "/repo",
      isFile: () => false,
    }),
    "dotnet run --project '/repo/headless' -- --scan --no-notify",
  );
});

Deno.test("Linux keeps the flake's scan app as the default", () => {
  const input = {
    os: "linux",
    scanRoot: "/home/u/WFinfo-ext",
    flakeRoot: "/home/u/WFinfo-ext",
    isFile: () => true,
  };
  assertEquals(
    defaultScanCommand(input),
    "WFINFO_SCAN_ROOT='/home/u/WFinfo-ext' nix run '/home/u/WFinfo-ext'#scan -- --no-notify",
  );
  assertEquals(
    defaultScanCommand({
      ...input,
      scanRoot: undefined,
      flakeRoot: "/nix/store/x",
    }),
    "nix run '/nix/store/x'#scan -- --no-notify",
    "without a checkout there is no WFINFO_SCAN_ROOT",
  );
});

Deno.test("paths with quotes stay one shell word", () => {
  assertEquals(shellQuote("/a b/it's"), `'/a b/it'\\''s'`);
  assertEquals(
    defaultScanCommand({
      os: "darwin",
      scanRoot: "/it's",
      flakeRoot: "/it's",
      isFile: () => true,
    }),
    `dotnet '/it'\\''s/headless/bin/Debug/net9.0/WFInfo.Headless.dll' --scan --no-notify`,
  );
});

Deno.test("the helper path is WFINFO_MAC_HELPER, else the headless build output", () => {
  assertEquals(
    macHelperPath({}, "/repo"),
    "/repo/headless/bin/Debug/net9.0/wfinfo-mac",
  );
  assertEquals(
    macHelperPath({ WFINFO_MAC_HELPER: "/opt/wfinfo-mac" }, "/repo"),
    "/opt/wfinfo-mac",
  );
  assertEquals(
    macHelperPath({ WFINFO_MAC_HELPER: "  " }, "/repo"),
    "/repo/headless/bin/Debug/net9.0/wfinfo-mac",
  );
});
