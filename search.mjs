const commonWords = new Set((
  'a an and are as at be by can could did do does for from had has have how i in is it me my of on or ' +
  'please should tell than that the their these they this to up us was were what when where which who ' +
  'why will with would you your'
).split(' '));
const sentences = new Intl.Segmenter('en', { granularity: 'sentence' });

function words(text) {
  return (text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter(word => !commonWords.has(word))
    .map(word => word.length > 4 ? word.replace(/ies$/, 'y').replace(/([^s])s$/, '$1') : word);
}

function* excerpts(content) {
  let heading = '';
  for (const block of content.split(/\n\s*\n/)) {
    for (const line of block.split('\n')) {
      if (/^\s*#{1,6}\s/.test(line)) {
        heading = line.trim();
        continue;
      }
      for (const { segment } of sentences.segment(line)) {
        for (const piece of segment.match(/.{1,700}(?:\s|$)|.{1,700}/gu) ?? []) {
          const quote = piece.trim();
          if (quote) yield { quote, heading };
        }
      }
    }
  }
}

export function findPassages(question, documents) {
  const terms = [...new Set(words(question))];
  if (!terms.length) return [];

  const frequencies = new Map(terms.map(term => [term, 0]));
  const candidates = [];
  let passageCount = 0;
  for (const { id, name, content } of documents) {
    for (const { quote, heading } of excerpts(content)) {
      passageCount++;
      const passageWords = new Set(words(quote));
      const headingWords = new Set(words(heading));
      const direct = terms.filter(term => passageWords.has(term));
      for (const term of direct) frequencies.set(term, frequencies.get(term) + 1);
      const context = terms.filter(term => !passageWords.has(term) && headingWords.has(term));
      if (direct.length && direct.length + context.length >= Math.min(2, terms.length)) {
        candidates.push({ id, name, quote, direct, context });
      }
    }
  }

  const weight = term => 1 + Math.log((passageCount + 1) / (frequencies.get(term) + 1));
  const score = ({ direct, context }) => direct.reduce((sum, term) => sum + weight(term), 0)
    + context.reduce((sum, term) => sum + weight(term) * 0.5, 0);
  const ranked = candidates.map(candidate => ({ ...candidate, score: score(candidate) }))
    .sort((a, b) => b.score - a.score);
  const seen = new Set();
  const citations = [];
  for (const { id, name, quote, score } of ranked) {
    if (score < ranked[0].score * 0.6 || citations.length === 4) break;
    if (seen.has(quote)) continue;
    seen.add(quote);
    citations.push({ id, name, quote });
  }
  return citations;
}
