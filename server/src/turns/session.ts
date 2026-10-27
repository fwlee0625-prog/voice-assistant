/** Audience decisions and bounded rolling audio, scoped to one ASR connection. */
import type { SpeakerSegment } from '../asr/protocol.ts';
import { createAudienceGate } from './audience.ts';
import type { TurnDetector } from './worker.ts';
export type TurnEvent = { type: 'interaction'; index: number; final: boolean; parts: ReturnType<ReturnType<typeof createAudienceGate>['decide']>; owner?: number }
  | { type: 'endpoint'; epoch: number; probability?: number; mode: 'model' | 'rules' };
export function createTurnSession(detector: TurnDetector, send: (event: TurnEvent) => void, activated = false) {
  const gate = createAudienceGate(Date.now, activated);
  let audio = Buffer.alloc(0); let epoch = 0; let closed = false;
  let controller: AbortController | undefined;
  let activity = false;
  detector.warm();
  return {
    audio(frame: Buffer) {
      // A copy avoids retaining a large backing buffer. Eight seconds maximum.
      audio = Buffer.concat([audio, frame]).subarray(-256000);
    },
    result(index: number, text: string, final: boolean, parts: SpeakerSegment[]) {
      if (closed) return;
      const decisions = gate.decide(index, parts.length ? parts : [{ speaker_id: -1, text, stable_flag: 0 }]);
      send({ type: 'interaction', index, final, owner: gate.owner(), parts: decisions });
    },
    control(value: Record<string, unknown>): boolean {
      if (value.type === 'playback') {
        if (typeof value.active !== 'boolean' || typeof value.question !== 'string' || value.question.length > 500 ||
            !Array.isArray(value.references) || value.references.length > 12 || value.references.some(r => typeof r !== 'string' || r.length > 160)) throw new Error('Invalid playback context');
        gate.context({ active: value.active, references: value.references as string[], question: value.question });
        return true;
      }
      if (value.type !== 'activity') return false;
      if (typeof value.speaking !== 'boolean' || !Number.isSafeInteger(value.epoch) || (value.epoch as number) < epoch) throw new Error('Invalid activity');
      const next = value.epoch as number;
      if (next === epoch && value.speaking === activity) return true;
      if ((value.speaking && (activity || next !== epoch + 1)) ||
          (!value.speaking && (!activity || next !== epoch))) throw new Error('Invalid activity epoch');
      epoch = next; activity = value.speaking;
      controller?.abort(); controller = new AbortController();
      if (activity) return true;
      const signal = controller.signal; const requestEpoch = epoch;
      void detector.predict(Buffer.from(audio), signal).then(probability => {
        if (!closed && !signal.aborted && requestEpoch === epoch) send({ type: 'endpoint', epoch, probability, mode: probability === undefined ? 'rules' : 'model' });
      }).catch(() => { if (!closed && !signal.aborted) send({ type: 'endpoint', epoch: requestEpoch, mode: 'rules' }); });
      return true;
    },
    close() { closed = true; controller?.abort(); audio = Buffer.alloc(0); },
  };
}
