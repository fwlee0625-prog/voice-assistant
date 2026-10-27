/** Local decision service adapter: select from configured phrases or stay silent. */
import type { ChatMessage } from './client.ts';
import { fillerDescription } from '../tts/fillers.ts';

export type FillerDecision = (messages: ChatMessage[], fillers: string[], signal: AbortSignal) => Promise<string | undefined>;

const SILENCE = 'Stay silent and answer directly when no phrase fits, or the user is correcting, responding briefly, or asking to stop.';
const INSTRUCTIONS = 'A Chinese billiards coach will answer the user. Pick the most natural short phrase to say while preparing an answer, or silence if none is appropriate. Consider the user intent and recent conversation.';

function shortText(text: string, max: number): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
}

export function createFillerDecision(config: { url: string; timeoutMs: number; enabled: boolean }, fetcher: typeof fetch = fetch): FillerDecision {
  return async (messages, fillers, signal) => {
    if (!config.enabled || !fillers.length || !messages.length || signal.aborted) return;
    const last = messages.at(-1);
    if (!last || last.role !== 'user') return;
    const state = {
      utterance: shortText(last.content, 800),
      recent_conversation: messages.slice(-3, -1).map(m => ({ role: m.role, content: shortText(m.content, 250) })),
    };
    // The model service accepts up to eight options per question, including silence.
    const groups: { items: { key: string; text: string }[] }[] = [];
    const questions: Record<string, unknown> = {};
    for (let start = 0; start < fillers.length; start += 7) {
      const items = fillers.slice(start, start + 7).map((text, offset) => ({ key: `f${start + offset}`, text }));
      groups.push({ items });
      const criteria: Record<string, string> = { silence: SILENCE };
      for (const item of items) criteria[item.key] = `${item.text}: ${fillerDescription(item.text)}`;
      questions[`group${groups.length - 1}`] = { type: 'choice', instructions: INSTRUCTIONS, criteria };
    }
    try {
      const response = await fetcher(`${config.url}/v1/decisions`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'laya-multilingual', state, questions }),
      });
      if (!response.ok) { await response.body?.cancel(); return; }
      const data = await response.json() as { usage?: { truncated?: unknown }; answers?: Record<string, { choice?: unknown; probabilities?: Record<string, unknown> }> };
      if (data.usage?.truncated !== false || !data.answers) return;
      let best: { text: string; score: number } | undefined;
      for (let i = 0; i < groups.length; i++) {
        const answer = data.answers[`group${i}`];
        const group = groups[i];
        if (!answer || !group || typeof answer.choice !== 'string') return;
        const silence = answer.probabilities?.silence;
        if (typeof silence !== 'number' || !Number.isFinite(silence) || silence < 0 || silence > 1) return;
        if (answer.choice === 'silence') continue;
        const item = group.items.find(candidate => candidate.key === answer.choice);
        const chosen = answer.probabilities?.[answer.choice];
        if (!item || typeof chosen !== 'number' || !Number.isFinite(chosen) || chosen < 0 || chosen > 1 || chosen < silence || chosen + silence === 0) return;
        // Compare each group winner against the same silence option; these are ranking scores, not calibrated confidence.
        const score = chosen / (chosen + silence);
        if (!best || score > best.score) best = { text: item.text, score };
      }
      return best?.text;
    } catch { return; }
  };
}
