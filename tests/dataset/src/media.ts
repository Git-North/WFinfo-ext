/**
 * ffmpeg and ffprobe: image size, decoding to raw RGB, PNG encoding and video
 * frame sampling. Inputs can be downloaded files, so every call limits ffmpeg
 * to local files and pipes: a crafted file cannot make it open a network
 * address.
 */

import { DatasetError } from "./errors.ts";
import type { RgbImage } from "./imaging.ts";

const LOCAL_ONLY = ["-protocol_whitelist", "file,pipe"];

export interface RunResult {
  code: number;
  stdout: Uint8Array;
  stderr: string;
}

/** Runs a program to its end. A missing program is DST-002. */
export async function run(
  program: string,
  args: string[],
  options: {
    input?: Uint8Array;
    timeoutMs?: number;
    env?: Record<string, string>;
    clearEnv?: boolean;
  } = {},
): Promise<RunResult> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(program, {
      args,
      stdin: options.input ? "piped" : "null",
      stdout: "piped",
      stderr: "piped",
      env: options.env,
      clearEnv: options.clearEnv,
    }).spawn();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new DatasetError("DST-002", `${program} is not on PATH`);
    }
    throw error;
  }
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // it ended just now
    }
  }, options.timeoutMs ?? 10 * 60_000);
  try {
    const feed = options.input ? send(child.stdin, options.input) : undefined;
    const output = await child.output();
    await feed;
    return {
      code: output.code,
      stdout: output.stdout,
      stderr: new TextDecoder().decode(output.stderr),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function send(
  stream: WritableStream<Uint8Array>,
  bytes: Uint8Array,
): Promise<void> {
  const writer = stream.getWriter();
  try {
    await writer.write(bytes);
    await writer.close();
  } catch {
    // The program stopped reading; its exit code reports why.
  }
}

function lastLine(text: string): string {
  return text.trim().split("\n").at(-1) ?? "";
}

export interface ImageInfo {
  width: number;
  height: number;
  codec: string;
}

export async function probeImage(path: string): Promise<ImageInfo> {
  const result = await run("ffprobe", [
    "-v",
    "error",
    ...LOCAL_ONLY,
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_name,width,height",
    "-of",
    "json",
    `file:${path}`,
  ], { timeoutMs: 60_000 });
  let stream: { codec_name?: string; width?: number; height?: number } = {};
  if (result.code === 0) {
    stream = JSON.parse(new TextDecoder().decode(result.stdout)).streams?.[0] ??
      {};
  }
  const { width, height, codec_name: codec } = stream;
  if (!width || !height || !codec) {
    throw new DatasetError("DST-006", `ffprobe: ${lastLine(result.stderr)}`);
  }
  return { width, height, codec };
}

/** Largest image the tools decode: 8K UHD with room to spare. */
const MAX_PIXELS = 8192 * 4608;

export async function decodeRgb(path: string): Promise<RgbImage> {
  const { width, height } = await probeImage(path);
  if (width * height > MAX_PIXELS) {
    throw new DatasetError("DST-006", `image too large: ${width}x${height}`);
  }
  const result = await run("ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    ...LOCAL_ONLY,
    "-noautorotate",
    "-i",
    `file:${path}`,
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "pipe:1",
  ], { timeoutMs: 120_000 });
  if (result.code !== 0 || result.stdout.length !== width * height * 3) {
    throw new DatasetError("DST-006", `ffmpeg: ${lastLine(result.stderr)}`);
  }
  return { width, height, data: result.stdout };
}

export async function encodePng(image: RgbImage, path: string): Promise<void> {
  const result = await run("ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-y",
    ...LOCAL_ONLY,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-video_size",
    `${image.width}x${image.height}`,
    "-i",
    "pipe:0",
    "-frames:v",
    "1",
    "-c:v",
    "png",
    "-f",
    "image2",
    "-update",
    "1",
    `file:${path}`,
  ], { input: image.data, timeoutMs: 120_000 });
  if (result.code !== 0) {
    throw new DatasetError("DST-006", `ffmpeg: ${lastLine(result.stderr)}`);
  }
}

export interface Frame {
  path: string;
  /** Position in the video, seconds. */
  seconds: number;
}

/** Presentation times that ffmpeg's showinfo filter logged, in frame order. */
export function parseShowinfoTimes(log: string): number[] {
  return [...log.matchAll(/\[Parsed_showinfo[^\]]*\].*?pts_time:\s*([0-9.]+)/g)]
    .map((m) => Number(m[1]));
}

/** One PNG every `intervalSeconds` of the video, into the empty `folder`. */
export async function sampleFrames(
  video: string,
  folder: string,
  intervalSeconds: number,
): Promise<Frame[]> {
  const result = await run("ffmpeg", [
    "-nostdin",
    "-hide_banner",
    "-nostats",
    ...LOCAL_ONLY,
    "-i",
    `file:${video}`,
    "-an",
    "-sn",
    "-vf",
    `select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,${intervalSeconds})',showinfo`,
    "-fps_mode",
    "vfr",
    `file:${folder}/frame-%06d.png`,
  ], { timeoutMs: 30 * 60_000 });
  if (result.code !== 0) {
    throw new DatasetError("DST-006", `ffmpeg: ${lastLine(result.stderr)}`);
  }
  return parseShowinfoTimes(result.stderr).map((seconds, i) => ({
    path: `${folder}/frame-${String(i + 1).padStart(6, "0")}.png`,
    seconds,
  }));
}
