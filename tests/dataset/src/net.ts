/**
 * HTTP for the public sources: https only, listed hosts only (redirects too),
 * a size limit, a pause between requests and a generic User-Agent with no
 * personal data. A refusal (401, 403) ends the run; nothing here tries to get
 * round it.
 */

import { DatasetError } from "./errors.ts";

export const USER_AGENT = "wfinfo-dataset-tools/1.0 (local test dataset)";

export interface PoliteOptions {
  hosts: string[];
  /** Pause between two requests, milliseconds. */
  pauseMs: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** The longest Retry-After the client waits out. */
const MAX_WAIT_SECONDS = 90;

export class PoliteClient {
  private last = 0;
  /** Bytes of response bodies received. */
  received = 0;

  constructor(private readonly options: PoliteOptions) {}

  private sleep(ms: number): Promise<void> {
    return this.options.sleep
      ? this.options.sleep(ms)
      : new Promise((resolve) => setTimeout(resolve, ms));
  }

  private allowed(url: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new DatasetError("DST-012", `not an address: ${url}`);
    }
    if (
      parsed.protocol !== "https:" || parsed.port !== "" ||
      parsed.username !== "" || !this.options.hosts.includes(parsed.hostname)
    ) {
      throw new DatasetError("DST-012", `host not allowed: ${parsed.origin}`);
    }
    return parsed;
  }

  private async request(url: string, accept: string): Promise<Response> {
    const wait = this.last + this.options.pauseMs - Date.now();
    if (this.last > 0 && wait > 0) await this.sleep(wait);
    this.last = Date.now();
    try {
      return await (this.options.fetch ?? fetch)(url, {
        redirect: "manual",
        headers: { "User-Agent": USER_AGENT, Accept: accept },
        signal: AbortSignal.timeout(90_000),
      });
    } catch (error) {
      throw new DatasetError("DST-011", `${new URL(url).hostname}: ${error}`);
    }
  }

  /** The body of a successful GET. */
  async get(
    url: string,
    maxBytes: number,
    accept = "*/*",
  ): Promise<Uint8Array> {
    let current = this.allowed(url);
    let waited = false;
    for (let hop = 0; hop < 5; hop++) {
      const response = await this.request(current.href, accept);
      const where = `${current.hostname}: HTTP ${response.status}`;
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const next = response.headers.get("location");
        if (!next) throw new DatasetError("DST-011", where);
        current = this.allowed(new URL(next, current).href);
        continue;
      }
      if (response.status === 429) {
        await response.body?.cancel();
        const seconds = Number(response.headers.get("retry-after") ?? 60);
        if (waited || !(seconds <= MAX_WAIT_SECONDS)) {
          throw new DatasetError(
            "DST-010",
            `${where}, retry after ${seconds}s`,
          );
        }
        waited = true;
        await this.sleep(Math.max(1, seconds) * 1000);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new DatasetError("DST-009", where);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new DatasetError("DST-011", where);
      }
      return await this.body(response, maxBytes, current.hostname);
    }
    throw new DatasetError(
      "DST-011",
      `${current.hostname}: too many redirects`,
    );
  }

  private async body(
    response: Response,
    maxBytes: number,
    host: string,
  ): Promise<Uint8Array> {
    const tooLarge = () =>
      new DatasetError("DST-012", `${host}: more than ${maxBytes} bytes`);
    if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
      await response.body?.cancel();
      throw tooLarge();
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of response.body ?? []) {
      length += chunk.length;
      if (length > maxBytes) throw tooLarge();
      chunks.push(chunk);
    }
    this.received += length;
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }

  async getJson(url: string): Promise<unknown> {
    const bytes = await this.get(url, 10_000_000, "application/json");
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new DatasetError("DST-013", `${new URL(url).hostname}: not JSON`);
    }
  }
}
