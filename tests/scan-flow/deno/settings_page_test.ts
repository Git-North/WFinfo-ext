/**
 * The switches on /scan and the routes as main.ts wires them. main.ts reads
 * the app dir from the environment at import time, so HOME (macOS) and
 * WFINFO_DATA_DIR (Linux) point at a temporary root BEFORE the import; this
 * file has its own worker, so the import is fresh.
 */
import {
  assertEquals,
  assertStringIncludes,
  assertTrue,
} from "../../../dashboard/src/lib/testutil.ts";
import { resolveAppDir } from "../../../dashboard/src/lib/fsdata.ts";
import { settingsFormHtml } from "../../../dashboard/src/lib/view.ts";
import { guardNotRealAppDir, loopback } from "./settings_testutil.ts";

Deno.test("settingsFormHtml shows both switches and escapes the warning", () => {
  const off = settingsFormHtml({
    settings: { version: 1, notifications: false, overlayPin: false },
    warning: null,
    detail: null,
  });
  assertStringIncludes(off, 'action="/settings"');
  assertStringIncludes(off, 'name="notifications"');
  assertStringIncludes(off, 'name="overlayPin"');
  assertStringIncludes(off, "Notify on automatic scans");
  assertStringIncludes(off, "Pin the overlay after a scan");
  assertEquals(off.includes(" checked"), false);
  assertEquals(off.includes("govuk-warning-text"), false);

  const on = settingsFormHtml({
    settings: { version: 1, notifications: true, overlayPin: true },
    warning: "SET-001",
    detail: "<b>odd</b>",
  });
  assertEquals(on.split(" checked").length - 1, 2);
  assertStringIncludes(on, "SET-001 Scroll");
  assertStringIncludes(on, "&lt;b&gt;odd&lt;/b&gt;");
  assertEquals(on.includes("<b>odd</b>"), false);
});

Deno.test("main.ts serves the switches, POST /settings and GET /api/settings", async () => {
  const saved = {
    home: Deno.env.get("HOME"),
    data: Deno.env.get("WFINFO_DATA_DIR"),
  };
  const real = [
    resolveAppDir(Deno.env.toObject()),
    `${saved.home ?? ""}/Library/Application Support/WFInfo`,
    `${saved.home ?? ""}/.config/WFInfo`,
  ];
  const root = await Deno.makeTempDir({ prefix: "wfinfo_ext_settings_page_" });
  try {
    Deno.env.set("HOME", root);
    Deno.env.set("WFINFO_DATA_DIR", root);
    const appDir = resolveAppDir(Deno.env.toObject());
    guardNotRealAppDir(appDir, real);
    assertTrue(appDir.startsWith(root), appDir);

    const { handler } = await import("../../../dashboard/src/main.ts");

    const before = await (await handler(
      new Request("http://localhost/api/settings"),
      loopback,
    )).json();
    assertEquals(before, {
      version: 1,
      notifications: false,
      overlayPin: false,
      warning: null,
    });

    const changed = await handler(
      new Request("http://localhost/settings", {
        method: "POST",
        headers: {
          host: "localhost",
          origin: "http://localhost",
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ notifications: true, overlayPin: true }),
      }),
      loopback,
    );
    assertEquals(changed.status, 200);
    assertEquals(
      await Deno.readTextFile(`${appDir}/wfinfo-ext-settings.json`),
      '{"version":1,"notifications":true,"overlayPin":true}\n',
    );

    const page = await (await handler(
      new Request("http://localhost/scan"),
      loopback,
    )).text();
    assertStringIncludes(page, 'id="wf-settings-form"');
    assertEquals(page.split(" checked").length - 1, 2);

    const crossSite = await handler(
      new Request("http://localhost/settings", {
        method: "POST",
        headers: {
          host: "localhost",
          origin: "http://evil.example",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "",
      }),
      loopback,
    );
    assertEquals(crossSite.status, 403);
    await crossSite.body?.cancel();
    const after = await (await handler(
      new Request("http://localhost/api/settings"),
    )).json();
    assertEquals(after.notifications, true);
  } finally {
    if (saved.home === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", saved.home);
    if (saved.data === undefined) Deno.env.delete("WFINFO_DATA_DIR");
    else Deno.env.set("WFINFO_DATA_DIR", saved.data);
    await Deno.remove(root, { recursive: true });
  }
});
