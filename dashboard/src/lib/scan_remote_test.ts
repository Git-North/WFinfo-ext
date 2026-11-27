import { assertEquals, assertStringIncludes } from "./testutil.ts";

/**
 * WFINFO_SCAN_REMOTE=1 lets another host see the display and window lists.
 * src/main.ts reads the variable at import time, so this test lives in its own
 * file (its own worker) and sets it BEFORE the import. Stub `wlr-randr`,
 * `mmsg` and `wfinfo-mac` stand in for the host tools on Linux and macOS.
 */
Deno.test("WFINFO_SCAN_REMOTE=1 shows the target lists to another host", async () => {
  const root = await Deno.makeTempDir({ prefix: "wfinfo_scan_remote_" });
  const savedPath = Deno.env.get("PATH") ?? "";
  const savedHome = Deno.env.get("HOME");
  try {
    const tools = `${root}/tools`;
    await Deno.mkdir(tools, { recursive: true });
    const stub = async (name: string, script: string) => {
      await Deno.writeTextFile(`${tools}/${name}`, `#!/bin/sh\n${script}\n`);
      await Deno.chmod(`${tools}/${name}`, 0o755);
    };
    await stub(
      "wlr-randr",
      `echo '[{"name":"DP-2","enabled":true,"position":{"x":0,"y":0},` +
        `"modes":[{"width":1920,"height":1080,"current":true}]}]'`,
    );
    await stub(
      "mmsg",
      `echo '{"clients":[{"id":7,"appid":"steam_app_230410","title":"Warframe",` +
        `"monitor":"DP-2","x":0,"y":0,"width":1920,"height":1080,` +
        `"is_focused":true,"is_visible":true}]}'`,
    );
    await stub(
      "wfinfo-mac",
      [
        `if [ "$1" = displays ]; then`,
        `echo '[{"id":1,"name":"Built-in Retina Display","main":true,` +
        `"x":0,"y":0,"width":1728,"height":1117}]'`,
        "else",
        `echo '[{"id":7,"owner":"steam_app_230410","title":"Warframe",` +
        `"x":0,"y":0,"width":1728,"height":1117,"frontmost":true}]'`,
        "fi",
      ].join("\n"),
    );
    Deno.env.set("PATH", `${tools}:${savedPath}`);
    Deno.env.set("WFINFO_MAC_HELPER", `${tools}/wfinfo-mac`);
    Deno.env.set("WFINFO_DATA_DIR", root);
    Deno.env.set("HOME", root);
    Deno.env.set("WFINFO_SCAN_REMOTE", "1");
    const { handler } = await import("../main.ts");

    const response = await handler(
      new Request("http://localhost/api/scan/targets?refresh=1"),
      otherHost,
    );
    assertEquals(response.status, 200);
    const targets = await response.json();
    assertEquals(targets.displays.length, 1);
    assertEquals(targets.windows.length, 1);
    assertStringIncludes(targets.windows[0].label, "Warframe");
    assertEquals(
      targets.notes.some((n: string) => n.includes("another host")),
      false,
    );
  } finally {
    Deno.env.set("PATH", savedPath);
    Deno.env.delete("WFINFO_MAC_HELPER");
    Deno.env.delete("WFINFO_DATA_DIR");
    Deno.env.delete("WFINFO_SCAN_REMOTE");
    if (savedHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", savedHome);
    await Deno.remove(root, { recursive: true });
  }
});

const otherHost: Deno.ServeHandlerInfo = {
  remoteAddr: { transport: "tcp", hostname: "192.168.1.50", port: 42210 },
  completed: Promise.resolve(),
};
