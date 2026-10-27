/** Execute the isolated CPU worker; bound memory/time and kill it on disconnect. */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { serverRoot } from "../config.ts";
import type { ServerConfig } from "../config.ts";
import { HttpError } from "../http/errors.ts";

export type EnhanceAudio = (audio: Buffer, signal: AbortSignal) => Promise<Buffer>;
const OUTPUT_LIMIT = 64 * 1024 * 1024;

function runWorker(
  config: ServerConfig["enhancement"],
  audio: Buffer,
  signal: AbortSignal,
): Promise<Buffer> {
  signal.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(config.python, [resolve(serverRoot, "workers/denoise.py")], {
      detached: grouped,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        SPEECH_ENHANCE_MODEL: config.model,
        FFMPEG_BIN: config.ffmpeg,
        SPEECH_ENHANCE_THREADS: String(config.threads),
        SPEECH_ENHANCE_ATTENUATION_DB: String(config.attenuation),
      },
    });
    let settled = false,
      size = 0,
      stderr = "";
    const output: Buffer[] = [];
    const timer = setTimeout(() => stop(new HttpError(422, "人声增强处理超时")), 240000);
    function finish(error?: Error, wav?: Buffer): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolveResult(wav!);
    }
    function stop(error: Error): void {
      if (child.pid) {
        try {
          if (grouped) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
      finish(error);
    }
    function abort(): void {
      stop(new HttpError(499, "请求已取消"));
    }
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", () =>
      finish(new HttpError(422, "无法启动人声增强 worker，请检查 ENHANCE_PYTHON 和 Python 依赖")),
    );
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > OUTPUT_LIMIT) stop(new HttpError(422, "增强结果超过大小限制"));
      else output.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString();
    });
    child.stdin.on("error", () => {
      /* Exit handler reports the worker error. */
    });
    child.on("close", (code) => {
      if (code !== 0) {
        let message = "人声增强失败，请检查模型和音频格式";
        try {
          const error = JSON.parse(stderr) as { error?: string };
          if (error.error) message = error.error;
        } catch {
          /* Native logs stay server-side. */
        }
        finish(new HttpError(422, message));
      } else {
        const wav = Buffer.concat(output);
        if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE")
          finish(new HttpError(422, "增强 worker 未返回有效 WAV"));
        else finish(undefined, wav);
      }
    });
    child.stdin.end(audio);
    if (signal.aborted) abort();
  });
}

export function createEnhancer(config: ServerConfig["enhancement"]): EnhanceAudio {
  let busy = false;
  return async (audio, signal) => {
    if (busy) throw new HttpError(503, "已有录音正在增强，请稍后重试");
    busy = true;
    try {
      return await runWorker(config, audio, signal);
    } finally {
      busy = false;
    }
  };
}
