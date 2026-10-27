/** Finite local-only smoke test: no server, microphone or cloud calls. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readConfig, serverRoot } from '../src/config.ts';
import { createTurnDetector } from '../src/turns/worker.ts';
const detector = createTurnDetector(readConfig({}).turns);
const wav = await readFile(resolve(serverRoot, '../frontend-test/test/fixtures/silero-speech.wav'));
const audio = wav.subarray(44);
try {
  detector.warm();
  let probability: number | undefined;
  const started = performance.now();
  while (probability === undefined && performance.now() - started < 30000) {
    probability = await detector.predict(audio, new AbortController().signal);
    if (probability === undefined) await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (probability === undefined) throw new Error('Smart Turn did not become ready');
  const elapsed: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    probability = await detector.predict(audio, new AbortController().signal);
    if (probability === undefined) throw new Error('Prediction failed');
    elapsed.push(Math.round(performance.now() - start));
  }
  console.log(JSON.stringify({ ready: true, model: 'smart-turn-v3.2-cpu', probability, roundTripMs: elapsed }));
} finally { detector.close(); }
