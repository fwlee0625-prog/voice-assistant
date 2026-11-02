/** Bridge: stream dialogue text while an injected TTS implementation speaks phrases. */
import { createToneDecoder } from './tone.ts';
import { HttpError } from '../http/errors.ts';
import { createSentenceSplitter, type SpeechSentence } from '../tts/sentences.ts';
import { DEFAULT_FILLERS, fillerStyle } from '../tts/fillers.ts';
import type { AudioChunk, TtsProvider } from '../tts/provider.ts';
import type { ChatMessage } from './client.ts';
import type { FillerDecision } from './filler-decision.ts';
export type ReplyEvent = { type: 'speech'; enabled: boolean } | { type: 'text'; delta: string }
  | ({ type: 'audio'; sentenceId: number } & SpeechSentence & AudioChunk)
  | ({ type: 'filler_audio'; text: string } & AudioChunk)
  | { type: 'sentence_end'; sentenceId: number }
  | { type: 'speech_error'; error: string } | { type: 'done' };
/** Model head start before an interjection is worth a synthesis call. */
const FILLER_GRACE_MS = 300;
/** Never hold the answer back longer than this for an interjection. */
const FILLER_TIMEOUT_MS = 1500;
function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
export async function streamSpokenReply(
  text: AsyncIterable<string>, provider: TtsProvider | undefined, voice: string,
  signal: AbortSignal, emit: (event: ReplyEvent) => Promise<void>,
  options: { filler?: boolean; fillers?: string[]; messages?: ChatMessage[]; decideFiller?: FillerDecision; onStage?: (stage: string, sentenceId?: number) => Promise<void> } = {},
) {
  const splitter = createSentenceSplitter();
  const queue: (SpeechSentence & { style?: string })[] = [];
  const decoder = createToneDecoder();
  let style: string | undefined;
  let sentenceId = 0;
  await emit({ type: 'speech', enabled: !!provider });
  let wake: (() => void) | undefined;
  let ended = false; let failed = false;
  const speechAbort = new AbortController();
  const speechSignal = AbortSignal.any([signal, speechAbort.signal]);
  const notify = () => { wake?.(); wake = undefined; };
  speechSignal.addEventListener('abort', notify);
  let modelStarted!: () => void;
  const modelSpeaking = new Promise<void>(resolve => { modelStarted = resolve; });
  let modelHasText = false;
  const fillerAbort = new AbortController();
  const fillerSignal = AbortSignal.any([speechSignal, fillerAbort.signal]);
  let interjection: { text: string; chunks: AudioChunk[] } | undefined;
  // Runs next to the model: the interjection only survives when the model stays silent.
  const filler = (async () => {
    if (!provider || !options.filler) return;
    const fillers = options.fillers ?? DEFAULT_FILLERS;
    if (!fillers.length || !options.decideFiller || !options.messages?.length) return;
    try {
      const decision = options.decideFiller(options.messages, fillers, fillerSignal).catch(() => undefined);
      const outcome = await Promise.race([
        modelSpeaking.then(() => 'model' as const),
        wait(FILLER_GRACE_MS, fillerSignal).then(() => 'grace' as const),
      ]);
      if (outcome === 'model' || fillerSignal.aborted) return;
      const fillerText = await decision;
      if (!fillerText || !fillers.includes(fillerText) || fillerSignal.aborted) return;
      const chunks: AudioChunk[] = [];
      const timeout = setTimeout(() => fillerAbort.abort(), FILLER_TIMEOUT_MS);
      try {
        for await (const chunk of provider.synthesize({ text: fillerText, voice, style: fillerStyle(fillerText), signal: fillerSignal })) {
          fillerSignal.throwIfAborted();
          chunks.push(chunk);
        }
      } catch { return; }
      finally { clearTimeout(timeout); }
      if (chunks.length && !fillerSignal.aborted) interjection = { text: fillerText, chunks };
    } catch { /* An interjection must never break the answer. */ }
  })();
  const speaking = (async () => {
    if (!provider) return;
    try {
      await Promise.race([filler, modelSpeaking]);
      speechSignal.throwIfAborted();
      if (interjection && !modelHasText) {
        for (const chunk of interjection.chunks) {
          speechSignal.throwIfAborted();
          await emit({ type: 'filler_audio', text: interjection.text, ...chunk });
        }
      }
      while (!speechSignal.aborted) {
        const sentence = queue.shift();
        if (sentence !== undefined) {
          const id = sentenceId++;
          await options.onStage?.('tts.request', id);
          let firstChunk = true;
          for await (const chunk of provider.synthesize({ text: sentence.text, voice, style: sentence.style, signal: speechSignal })) {
            speechSignal.throwIfAborted();
            if (firstChunk) { firstChunk = false; await options.onStage?.('tts.first_audio', id); }
            await emit({ type: 'audio', ...chunk, text: sentence.text, start: sentence.start, end: sentence.end, sentenceId: id });
          }
          speechSignal.throwIfAborted();
          await options.onStage?.('tts.end', id);
          await emit({ type: 'sentence_end', sentenceId: id });
        } else if (ended) break;
        else await new Promise<void>(resolve => { wake = resolve; });
      }
    } catch (error) {
      if (speechSignal.aborted) return;
      failed = true; queue.length = 0;
      await emit({ type: 'speech_error', error: error instanceof HttpError ? error.message : '语音合成失败，文字回答仍可查看' });
    }
  })();
  // Observe rejection immediately even while the model is still streaming.
  const observed = speaking.catch(() => { failed = true; });
  try {
    const accept = async (delta: string, flush = false) => {
      for (const part of decoder.push(delta, flush)) {
        if (part.type === 'style') {
          if (provider && !failed) queue.push(...splitter.push('', true).map(sentence => ({ ...sentence, style })));
          style = part.value || undefined;
        } else {
          if (!modelHasText && part.value.trim()) {
            modelHasText = true; fillerAbort.abort(); modelStarted();
          }
          await emit({ type: 'text', delta: part.value });
          if (provider && !failed) queue.push(...splitter.push(part.value).map(sentence => ({ ...sentence, style })));
        }
      }
      if (queue.reduce((size, sentence) => size + sentence.text.length, 0) > 16000) throw new HttpError(502, '待合成文字过长');
      notify();
    };
    for await (const delta of text) {
      signal.throwIfAborted();
      await accept(delta);
    }
    await accept('', true);
    if (provider && !failed) queue.push(...splitter.push('', true).map(sentence => ({ ...sentence, style })));
    if (!modelHasText) { fillerAbort.abort(); modelStarted(); }
    ended = true; notify();
    await observed;
    signal.throwIfAborted();
    await emit({ type: 'done' });
  } finally {
    speechAbort.abort(); ended = true; notify();
    await observed;
    speechSignal.removeEventListener('abort', notify);
  }
}
