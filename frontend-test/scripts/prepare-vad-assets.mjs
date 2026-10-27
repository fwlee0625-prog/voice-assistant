import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const target = resolve(import.meta.dirname, '../public/vad');
await mkdir(target, { recursive: true });
const vad = dirname(require.resolve('@ricky0123/vad-web'));
const ort = dirname(require.resolve('onnxruntime-web/wasm'));
for (const [folder, file] of [[vad, 'silero_vad_v5.onnx'], [ort, 'ort-wasm-simd-threaded.mjs'], [ort, 'ort-wasm-simd-threaded.wasm']])
  await copyFile(resolve(folder, file), resolve(target, file));
