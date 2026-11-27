/**
 * Host-specific defaults: which command runs a scan, and where the macOS
 * helper lives. Pure functions — the OS and file checks come in as arguments,
 * so the tests can choose any platform.
 *
 * Linux runs the flake's scan app (`nix run <root>#scan`). macOS has no Nix
 * here: the scan is the headless runner under Homebrew `dotnet`, prebuilt when
 * its DLL exists, else built first with `dotnet run`.
 */

/** Build output of `headless/` (Debug, net9.0), relative to the checkout. */
export const HEADLESS_BIN = "headless/bin/Debug/net9.0";

/** POSIX single-quote a value for the shell command line. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface ScanCommandInput {
  /** Host OS, as `Deno.build.os` spells it. */
  os: string;
  /** Checkout that holds `headless/`, or undefined when none was found. */
  scanRoot: string | undefined;
  /** Root the command falls back to without a checkout. */
  flakeRoot: string;
  /** True when the path is an existing file. */
  isFile: (path: string) => boolean;
}

/** The scan command used when WFINFO_SCAN_CMD is unset. */
export function defaultScanCommand(input: ScanCommandInput): string {
  const root = input.scanRoot ?? input.flakeRoot;
  if (input.os === "darwin") {
    const dll = `${root}/${HEADLESS_BIN}/WFInfo.Headless.dll`;
    return input.isFile(dll)
      ? `dotnet ${shellQuote(dll)} --scan --no-notify`
      : `dotnet run --project ${
        shellQuote(`${root}/headless`)
      } -- --scan --no-notify`;
  }
  return `${
    input.scanRoot ? `WFINFO_SCAN_ROOT=${shellQuote(input.scanRoot)} ` : ""
  }` +
    `nix run ${shellQuote(input.flakeRoot)}#scan -- --no-notify`;
}

/** The `wfinfo-mac` helper: WFINFO_MAC_HELPER, else the headless build output. */
export function macHelperPath(
  env: Record<string, string | undefined>,
  root: string,
): string {
  const override = (env.WFINFO_MAC_HELPER ?? "").trim();
  return override !== "" ? override : `${root}/${HEADLESS_BIN}/wfinfo-mac`;
}
