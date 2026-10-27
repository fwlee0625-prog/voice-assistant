/** One warm inference process per server; bounded requests and safe fallback. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import { serverRoot } from '../config.ts';
export interface TurnModelConfig { enabled: boolean; python: string; model: string }
export interface TurnDetector {
  warm(): void;
  predict(audio: Buffer, signal: AbortSignal): Promise<number | undefined>;
  close(): void;
}
export function createTurnDetector(config: TurnModelConfig): TurnDetector {
  let child: ChildProcessWithoutNullStreams | undefined;
  let ready = false; let closed = false; let nextId = 0; let retryAt = 0;
  const pending = new Map<number, { resolve(value: number | undefined): void; cleanup(): void }>();
  function settle(id: number, value?: number) { const item = pending.get(id); if (item) { pending.delete(id); item.cleanup(); item.resolve(value); } }
  function stop() {
    ready = false;
    const old = child; child = undefined;
    if (old) {
      old.kill();
      const force = setTimeout(() => old.kill('SIGKILL'), 1000); force.unref();
      old.once('exit', () => clearTimeout(force));
    }
    for (const id of pending.keys()) settle(id);
  }
  function warm() {
    if (!config.enabled || closed || child || Date.now() < retryAt) return;
    const process = spawn(config.python, ['-u', resolve(serverRoot, 'workers/turn_detector.py'), config.model], { stdio: ['pipe', 'pipe', 'pipe'] });
    child = process;
    let buffer = '';
    const startup = setTimeout(() => { if (child === process && !ready) { retryAt = Date.now() + 30000; stop(); } }, 30000);
    process.stdout.on('data', (chunk: Buffer) => {
      if (child !== process) return;
      buffer += chunk.toString();
      if (buffer.length > 8192) { stop(); return; }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const result = JSON.parse(line);
          if (result.ready === true) { ready = true; clearTimeout(startup); }
          else if (Number.isInteger(result.id)) settle(result.id,
            typeof result.probability === 'number' && result.probability >= 0 && result.probability <= 1 ? result.probability : undefined);
        } catch { stop(); }
      }
    });
    process.stderr.on('data', () => {}); // Never expose model tracebacks or session data.
    process.stdin.on('error', () => { if (child === process) stop(); });
    const failed = () => { clearTimeout(startup); if (child === process) { retryAt = Date.now() + 30000; stop(); } };
    process.once('error', failed); process.once('exit', failed);
  }
  return {
    warm,
    async predict(audio, signal) {
      warm();
      if (!ready || !child || child.stdin.writableLength > 512 * 1024 || pending.size >= 4 || signal.aborted || audio.length < 8000 || audio.length > 256000 || audio.length % 2) return undefined;
      const id = ++nextId;
      return new Promise<number | undefined>(resolve => {
        const abort = () => settle(id);
        const timer = setTimeout(() => { settle(id); retryAt = Date.now() + 30000; stop(); }, 1200);
        pending.set(id, { resolve, cleanup() { clearTimeout(timer); signal.removeEventListener('abort', abort); } });
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); return; }
        child!.stdin.write(JSON.stringify({ id, audio: audio.toString('base64') }) + '\n');
      });
    },
    close() { closed = true; stop(); },
  };
}
