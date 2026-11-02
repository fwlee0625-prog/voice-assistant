import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../public/kws-keywords.js', import.meta.url), 'utf8')
const tokens = new Set(readFileSync(new URL('../public/kws/tokens.txt', import.meta.url), 'utf8').trim().split(/\r?\n/).map(line => line.split(/\s+/)[0]))
function normalize(phonemes: string): string[] {
  return Array.from(runInNewContext(`${source}\nnormalizeKeywordPhonemes(phonemes, tokens)`, { phonemes, tokens }))
}

test('custom tone-marked syllables become supported model phonemes', () => {
  assert.deepEqual(normalize('nǐ hǎo xiǎo měi'), ['n', 'ǐ', 'h', 'ǎo', 'x', 'iǎo', 'm', 'ěi'])
  assert.deepEqual(normalize('zhù shǒu'), ['zh', 'ù', 'sh', 'ǒu'])
})
test('existing model phonemes stay unchanged and invalid tokens remain detectable', () => {
  assert.deepEqual(normalize('n ǐ h ǎo zh ù sh ǒu'), ['n', 'ǐ', 'h', 'ǎo', 'zh', 'ù', 'sh', 'ǒu'])
  assert.deepEqual(normalize('invalid'), ['invalid'])
})
