/** Startup configuration only. No provider connections or HTTP side effects. */
import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenv } from "dotenv";

export const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export interface ServerConfig {
  host: string;
  port: number;
  allowedOrigins: Set<string>;
  asr: { appId: string; secretKey: string };
  turns: { enabled: boolean; python: string; model: string };
  decision: { enabled: boolean; url: string; timeoutMs: number };
  enhancement: {
    python: string;
    model: string;
    ffmpeg: string;
    threads: number;
    attenuation: number;
  };
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new Error("服务端数字配置超出有效范围");
  return parsed;
}

function localModelUrl(value: string | undefined): string {
  let url: URL;
  try { url = new URL(value || 'http://127.0.0.1:8030'); } catch { throw new Error('本地模型服务地址无效'); }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('本地模型服务地址必须是本机 HTTP 地址');
  return url.origin;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: env.HOST || "127.0.0.1",
    port: integer(env.PORT, 8020, 1, 65535),
    allowedOrigins: new Set(
      (env.ALLOWED_ORIGINS || "http://localhost:5178,http://127.0.0.1:5178")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    asr: {
      appId: env.TENCENT_TRTC_SDK_APP_ID?.trim() || "",
      secretKey: env.TENCENT_TRTC_SECRET_KEY?.trim() || "",
    },
    turns: { enabled: env.SMART_TURN_ENABLED !== 'false', python: env.SMART_TURN_PYTHON || resolve(serverRoot, '.venv/bin/python'), model: resolve(serverRoot, env.SMART_TURN_MODEL || 'models/smart-turn-v3.2-cpu.onnx') },
    decision: { enabled: env.MODEL_DECISION_ENABLED !== 'false', url: localModelUrl(env.MODEL_SERVICE_URL), timeoutMs: integer(env.MODEL_DECISION_TIMEOUT_MS, 600, 50, 5000) },
    enhancement: {
      python: env.ENHANCE_PYTHON || "python3",
      model: resolve(serverRoot, env.SPEECH_ENHANCE_MODEL || "models/dpdfnet2_48khz_hr.onnx"),
      ffmpeg: env.FFMPEG_BIN || "ffmpeg",
      threads: integer(env.SPEECH_ENHANCE_THREADS, 2, 1, 32),
      attenuation: integer(env.SPEECH_ENHANCE_ATTENUATION_DB, 0, 0, 100),
    },
  };
}

export function loadConfig(): ServerConfig {
  dotenv({ path: resolve(serverRoot, ".env"), quiet: true });
  return readConfig();
}

/** Credentials stay in the ignored .env; preferences never contain secrets. */
export interface LlmCredentials { get(): string; set(key: string): Promise<void> }
let credentialWrites = Promise.resolve();
export function createLlmCredentials(envPath = resolve(serverRoot, '.env'), initial = process.env.OPENAI_API_KEY || '', variable = 'OPENAI_API_KEY'): LlmCredentials {
  if (!/^[A-Z][A-Z0-9_]*$/.test(variable)) throw new Error('Invalid credential variable');
  let key = initial;
  return {
    get: () => key,
    set(next) {
      const operation = credentialWrites.then(async () => {
        let content = '';
        try { content = await readFile(envPath, 'utf8'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const lines = content.split('\n').filter(line => !new RegExp('^\\s*(?:export\\s+)?' + variable + '\\s*=').test(line));
        await writeFile(envPath + '.tmp', lines.join('\n').trimEnd() + '\n' + variable + '=' + next + '\n', { mode: 0o600 });
        await rename(envPath + '.tmp', envPath);
        key = next;
      });
      credentialWrites = operation.catch(() => {});
      return operation;
    },
  };
}

export function createTtsCredentials() {
  return createLlmCredentials(undefined, process.env.MIMO_API_KEY || '', 'MIMO_API_KEY');
}
