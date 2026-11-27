/** Runs the built Swift helper `wfinfo-mac` for the tests in this folder. */

const ROOT = new URL("../../", import.meta.url);

/** WFINFO_TEST_HELPER (tests/run.ts sets it), else the runner's build. */
const HELPER = Deno.env.get("WFINFO_TEST_HELPER") ??
  decodeURIComponent(
    new URL("headless/bin/Debug/net9.0/wfinfo-mac", ROOT).pathname,
  );

/** WFInfo's 1080p reward constants (OCR.pixle* / pixelRewardLineHeight). */
export const LAYOUT = [
  "--reward-width",
  "968",
  "--reward-height",
  "235",
  "--reward-y",
  "316",
  "--line-height",
  "48",
];

/** A test that needs the helper, so macOS; skipped elsewhere. */
export function macTest(
  name: string,
  fn: (dir: string) => Promise<void> | void,
): void {
  Deno.test({
    name,
    ignore: Deno.build.os !== "darwin",
    async fn() {
      const dir = await Deno.makeTempDir({ prefix: "wfinfo-swift-" });
      try {
        await fn(dir);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    },
  });
}

export interface HelperResult {
  code: number;
  stdout: Uint8Array;
  text: string;
  stderr: string;
}

export async function helper(
  args: string[],
  input?: Uint8Array,
): Promise<HelperResult> {
  const child = new Deno.Command(HELPER, {
    args,
    stdin: input ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const done = child.output();
  if (input) {
    const writer = child.stdin.getWriter();
    // The helper may exit before it reads all of its input.
    await writer.write(input).catch(() => {});
    await writer.close().catch(() => {});
  }
  const result = await done;
  return {
    code: result.code,
    stdout: result.stdout,
    text: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

/** The JSON answer of a call that must succeed. */
// deno-lint-ignore no-explicit-any
export async function answer(args: string[], input?: Uint8Array): Promise<any> {
  const result = await helper(args, input);
  if (result.code !== 0) {
    throw new Error(
      `wfinfo-mac ${args.join(" ")} exited ${result.code}: ${result.stderr}`,
    );
  }
  return JSON.parse(result.text);
}

/** Asserts a call that must fail with `message` in its error output. */
export async function fails(
  args: string[],
  message: string,
  code = 1,
  input?: Uint8Array,
): Promise<void> {
  const result = await helper(args, input);
  if (result.code !== code || !result.stderr.includes(message)) {
    throw new Error(
      `wfinfo-mac ${
        args.join(" ")
      }: expected exit ${code} with "${message}", ` +
        `got exit ${result.code}: ${result.stderr}`,
    );
  }
}

/** Draws a synthetic reward screen and returns its ground truth. */
export function synth(
  out: string,
  names: string,
  extra: string[] = [],
  // deno-lint-ignore no-explicit-any
): Promise<any> {
  return answer(["synth", "--out", out, "--names", names, ...extra]);
}
