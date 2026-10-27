import test from 'node:test'
import assert from 'node:assert/strict'
import { createSpeechTimeline, type SpeechProgress } from '../src/audio/speechTimeline.ts'

test('progress follows audible time, excludes buffering gaps and distinguishes repeated sentences', () => {
  const events: SpeechProgress[] = []
  const timeline = createSpeechTimeline(event => events.push(event))
  const first = { sentenceId: 0, text: '你好你好。', start: 0, end: 5 }
  timeline.append(first, 1, 1.5)
  timeline.update(0.9); assert.equal(events.length, 0)
  timeline.update(1.25); assert.equal(events.at(-1)?.progress, 0.25)
  timeline.update(1.5); assert.equal(events.at(-1)?.progress, 0.5)
  // No newly received audio means waiting, even as wall/audio-clock time passes.
  timeline.update(3); assert.equal(events.at(-1)?.progress, 0.5)
  timeline.append(first, 4, 4.5)
  timeline.end(0)
  timeline.update(4.25); assert.equal(events.at(-1)?.progress, 0.75)
  timeline.update(4.5); assert.equal(events.at(-1)?.progress, 1)
  timeline.append({ ...first, sentenceId: 1, start: 5, end: 10 }, 5, 6)
  timeline.end(1)
  timeline.update(4.8); assert.equal(events.at(-1)?.sentenceId, 0)
  timeline.update(5.5); assert.equal(events.at(-1)?.sentenceId, 1); assert.equal(events.at(-1)?.progress, 0.5)
  assert.equal(timeline.update(6), false); assert.equal(events.at(-1)?.progress, 1)
})
test('late audio never rewinds progress, unfinished sentences retain a tail, clearing stops updates', () => {
  const events: SpeechProgress[] = []
  const timeline = createSpeechTimeline(event => events.push(event))
  const sentence = { sentenceId: 0, text: '好。', start: 0, end: 2 }
  timeline.append(sentence, 0, 1); timeline.update(1)
  assert.equal(events.at(-1)?.progress, 0.9)
  timeline.append(sentence, 2, 10); timeline.end(0); timeline.update(2)
  assert.equal(events.at(-1)?.progress, 0.9)
  timeline.update(10); assert.equal(events.at(-1)?.progress, 1)
  timeline.append({ ...sentence, sentenceId: 1 }, 11, 12)
  timeline.clear(); assert.equal(timeline.update(20), false)
  assert.equal(events.length, 2)
})
