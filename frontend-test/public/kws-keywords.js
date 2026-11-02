// Accept both model phonemes and tone-marked pinyin syllables from settings.
function normalizeKeywordPhonemes(phonemes, tokens) {
  const initials = ['zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h', 'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w'];
  return phonemes.trim().split(/\s+/).flatMap(token => {
    if (tokens.has(token)) return [token];
    const initial = initials.find(value => token.startsWith(value) && tokens.has(value) && tokens.has(token.slice(value.length)));
    return initial ? [initial, token.slice(initial.length)] : [token];
  });
}
