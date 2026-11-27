/**
 * POST /settings and GET /api/settings (dashboard/src/lib/settings.ts):
 * same origin and loopback only, like POST /scan/run; a form post redirects
 * back to /scan, a JSON request gets JSON; a failed write is SET-002.
 */
import {
  assertEquals,
  assertStringIncludes,
} from "../../../dashboard/src/lib/testutil.ts";
import {
  apiSettings,
  readSettings,
  settingsPath,
  settingsRoute,
} from "../../../dashboard/src/lib/settings.ts";
import {
  listNames,
  loopback,
  otherHost,
  withTempAppDir,
} from "./settings_testutil.ts";

const errorPage = (message: string): string => `<p>error: ${message}</p>`;

function post(
  body: string,
  headers: Record<string, string>,
): Request {
  return new Request("http://localhost/settings", {
    method: "POST",
    headers: { host: "localhost", ...headers },
    body,
  });
}

const jsonPost = (body: unknown, extra: Record<string, string> = {}) =>
  post(JSON.stringify(body), {
    "content-type": "application/json",
    accept: "application/json",
    ...extra,
  });

Deno.test("loopback JSON request changes one switch and gets JSON", async () => {
  await withTempAppDir(async (appDir) => {
    const opts = { appDir, allowRemote: false, errorPage };
    const resp = await settingsRoute(
      jsonPost({ notifications: true }, { origin: "http://localhost" }),
      { ...opts, remoteAddr: loopback.remoteAddr },
    );
    assertEquals(resp.status, 200);
    const data = await resp.json();
    assertEquals(data.ok, true);
    assertEquals(data.settings, {
      version: 1,
      notifications: true,
      overlayPin: false,
    });
    assertStringIncludes(data.message, "Notify on automatic scans: on");

    // A second change keeps the first.
    await settingsRoute(jsonPost({ overlayPin: true }), {
      ...opts,
      remoteAddr: loopback.remoteAddr,
    });
    assertEquals((await readSettings(appDir)).settings, {
      version: 1,
      notifications: true,
      overlayPin: true,
    });

    const api = await (await apiSettings(appDir)).json();
    assertEquals(api, {
      version: 1,
      notifications: true,
      overlayPin: true,
      warning: null,
    });
  });
});

Deno.test("a form post sets every switch and redirects to /scan", async () => {
  await withTempAppDir(async (appDir) => {
    const opts = {
      appDir,
      allowRemote: false,
      errorPage,
      remoteAddr: loopback.remoteAddr,
    };
    const form = (body: string) =>
      post(body, {
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://localhost",
      });

    const on = await settingsRoute(
      form("notifications=on&overlayPin=on"),
      opts,
    );
    assertEquals(on.status, 303);
    assertEquals(on.headers.get("location"), "/scan");
    assertEquals((await readSettings(appDir)).settings.overlayPin, true);

    // An unchecked box is not sent, so it is off.
    await settingsRoute(form("notifications=on"), opts);
    assertEquals((await readSettings(appDir)).settings, {
      version: 1,
      notifications: true,
      overlayPin: false,
    });
    await settingsRoute(form(""), opts);
    assertEquals((await readSettings(appDir)).settings.notifications, false);
    assertEquals(await listNames(appDir), ["wfinfo-ext-settings.json"]);
  });
});

Deno.test("a cross-site or remote POST is refused and writes nothing", async () => {
  await withTempAppDir(async (appDir) => {
    const opts = { appDir, allowRemote: false, errorPage };

    const crossSite = await settingsRoute(
      jsonPost({ notifications: true }, { origin: "http://evil.example" }),
      { ...opts, remoteAddr: loopback.remoteAddr },
    );
    assertEquals(crossSite.status, 403);
    assertStringIncludes(
      (await crossSite.json()).error,
      "did not come from the dashboard page",
    );

    const badOrigin = await settingsRoute(
      jsonPost({ notifications: true }, { origin: "not a url" }),
      { ...opts, remoteAddr: loopback.remoteAddr },
    );
    assertEquals(badOrigin.status, 403);

    const remote = await settingsRoute(jsonPost({ notifications: true }), {
      ...opts,
      remoteAddr: otherHost.remoteAddr,
    });
    assertEquals(remote.status, 403);
    const remoteError = (await remote.json()).error;
    assertStringIncludes(remoteError, "192.168.1.50 is another host");
    assertStringIncludes(remoteError, "WFINFO_SCAN_REMOTE=1");

    // A plain form post that is refused gets the HTML error page.
    const remoteForm = await settingsRoute(
      post("notifications=on", {
        "content-type": "application/x-www-form-urlencoded",
      }),
      { ...opts, remoteAddr: otherHost.remoteAddr },
    );
    assertEquals(remoteForm.status, 403);
    assertStringIncludes(await remoteForm.text(), "<p>error: ");

    assertEquals(await listNames(appDir), []);
  });
});

Deno.test("WFINFO_SCAN_REMOTE lets another host change a switch", async () => {
  await withTempAppDir(async (appDir) => {
    const resp = await settingsRoute(jsonPost({ overlayPin: true }), {
      appDir,
      allowRemote: true,
      errorPage,
      remoteAddr: otherHost.remoteAddr,
    });
    assertEquals(resp.status, 200);
    assertEquals((await readSettings(appDir)).settings.overlayPin, true);
  });
});

Deno.test("a bad request is 400 and a GET is 405", async () => {
  await withTempAppDir(async (appDir) => {
    const opts = {
      appDir,
      allowRemote: false,
      errorPage,
      remoteAddr: loopback.remoteAddr,
    };
    const bad = [
      jsonPost({ sound: true }),
      jsonPost({ notifications: "yes" }),
      jsonPost({}),
      jsonPost([true]),
      post("{", {
        "content-type": "application/json",
        accept: "application/json",
      }),
      post("x", { "content-type": "text/plain", accept: "application/json" }),
      post("x".repeat(20000), {
        "content-type": "application/json",
        accept: "application/json",
      }),
    ];
    for (const req of bad) {
      const resp = await settingsRoute(req, opts);
      assertEquals(resp.status, 400);
      assertEquals((await resp.json()).ok, false);
    }
    const get = await settingsRoute(
      new Request("http://localhost/settings"),
      opts,
    );
    assertEquals(get.status, 405);
    assertEquals(await listNames(appDir), []);
  });
});

Deno.test("a failed write is SET-002 Seal", async () => {
  await withTempAppDir(async (appDir) => {
    await Deno.mkdir(`${settingsPath(appDir)}/blocker`, { recursive: true });
    const opts = {
      appDir,
      allowRemote: false,
      errorPage,
      remoteAddr: loopback.remoteAddr,
    };
    const resp = await settingsRoute(jsonPost({ notifications: true }), opts);
    assertEquals(resp.status, 500);
    const data = await resp.json();
    assertEquals(data.code, "SET-002");
    assertStringIncludes(data.error, "SET-002 Seal");

    const page = await settingsRoute(
      post("notifications=on", {
        "content-type": "application/x-www-form-urlencoded",
      }),
      opts,
    );
    assertEquals(page.status, 500);
    assertStringIncludes(await page.text(), "SET-002 Seal");
    assertEquals(await listNames(appDir), ["wfinfo-ext-settings.json"]);
  });
});

Deno.test("GET /api/settings reports SET-001 for an invalid file", async () => {
  await withTempAppDir(async (appDir) => {
    await Deno.mkdir(appDir, { recursive: true });
    await Deno.writeTextFile(settingsPath(appDir), '{"notifications":"on"}');
    const data = await (await apiSettings(appDir)).json();
    assertEquals(data, {
      version: 1,
      notifications: false,
      overlayPin: false,
      warning: "SET-001",
    });
  });
});
