import { explicitEnd } from '../chat/control.ts';
/** Conservative per-ASR-session audience gate, not biometric identity or a semantic classifier. */
import type { SpeakerSegment } from '../asr/protocol.ts';
export interface AudiencePart { id: number; speakerId: number; text: string; action: 'accept' | 'stop' | 'ignore' | 'wait' | 'end_conversation' | 'disable_listening'; reason: string }
export interface PlaybackContext { active: boolean; references: string[]; question: string }
const call = /^(?:你好[，,\s]*)?(?:台球助手|小助手|助手)/;
const stop = /^(?:请)?(?:等一下|等等|暂停|停止|停一下|别说了|先别说|不要说了|打住|我接个电话|让我想想|让我看看)/;
const directed = /(?:帮我|请你|你能|我想问|麻烦你)/;
const billiards = /台球|球台|开台|关台|结账|续时|球杆|低杆|高杆|中杆|加塞|母球|白球|目标球|走位|瞄准|出杆|进球|犯规|斯诺克|中八|九球|打球|几号台|[一二三四五六七八九十两\d]+号台/;
const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export function createAudienceGate(now: () => number = Date.now, activated = false) {
  let owner: number | undefined; let lastInteraction = 0; let waiting = false;
  let context: PlaybackContext = { active: false, references: [], question: '' };
  const calls = new Set<string>(); const stops = new Set<string>();
  const ids = new Map<string, number>(); let nextId = 0; let latestCallIndex = -1;
  return {
    context(value: PlaybackContext) {
      context = value;
      if (waiting && value.question.endsWith('还需要什么帮助吗？')) waiting = false;
    },
    decide(index: number, parts: SpeakerSegment[]): AudiencePart[] {
      if (owner !== undefined && now() - lastInteraction > 120000 && !context.active) { owner = undefined; waiting = false; }
      // Group every part by speaker; never silently discard the second person.
      const groups = new Map<number, { text: string; stable: boolean }>();
      for (const part of parts) {
        const id = part.speaker_id > 0 ? part.speaker_id : -1;
        const previous = groups.get(id);
        groups.set(id, { text: (previous?.text || '') + part.text, stable: (previous?.stable ?? true) && part.stable_flag === 1 });
      }
      const decisions = [...groups].map(([speakerId, part]) => {
        const key = `${index}:${speakerId}`;
        if (!ids.has(key)) { ids.set(key, ++nextId); if (ids.size > 1000) ids.delete(ids.keys().next().value!); }
        const base = { id: ids.get(key)!, speakerId, text: part.text };
        const text = part.text.trim(); const compact = normalize(text);
        const addressed = call.test(text);
        const content = text.replace(call, '').replace(/^[，,。.!！?？\s]+/, '').trim();
        const decision = (action: AudiencePart['action'], reason: string) => ({ ...base, text: content || text, action, reason });
        if (!compact) return decision('ignore', 'empty');
        if (context.references.some(ref => normalize(ref).includes(compact)) &&
            !(part.stable && (speakerId === owner || addressed) && (stop.test(content || text) || explicitEnd(content || text)))) return decision('ignore', 'echo');
        if (speakerId < 1 || !part.stable) return decision('wait', 'speaker_unstable');
        // A button click or verified local wake authorizes the first stable speaker.
        if (activated && owner === undefined && !context.active) { owner = speakerId; lastInteraction = now(); }
        const freshCall = addressed && !calls.has(key) && index >= latestCallIndex;
        if (freshCall) { owner = speakerId; waiting = false; lastInteraction = now(); latestCallIndex = index; calls.add(key);
          if (calls.size > 1000) calls.delete(calls.values().next().value!); }
        if (owner === undefined) return decision('wait', 'call_assistant');
        if (speakerId !== owner) return decision('ignore', 'bystander');
        const end = explicitEnd(content || text);
        if (end) return decision(end, 'user_end');
        if (stop.test(content || text)) {
          if (stops.has(key)) return decision('ignore', 'duplicate_control');
          stops.add(key); if (stops.size > 1000) stops.delete(stops.values().next().value!);
          waiting = true; lastInteraction = now(); return decision('stop', 'user_wait');
        }
        const answeringQuestion = /[？?]|(?:哪个|多少|什么|是否|要不要|吗|呢)[。\s]*$/.test(context.question);
        if (waiting || activated || addressed || directed.test(text) || billiards.test(text) || answeringQuestion || /^(?:继续|不是|不对|换个|重新)/.test(text)) {
          waiting = false; lastInteraction = now(); return decision('accept', addressed ? 'addressed' : 'owner');
        }
        return decision('ignore', 'not_addressed');
      });
      return decisions.map(part => (['accept', 'stop', 'end_conversation', 'disable_listening'].includes(part.action)) && part.speakerId !== owner
        ? { ...part, action: 'ignore' as const, reason: 'speaker_switched' } : part);
    },
    owner: () => owner,
  };
}
