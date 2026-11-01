/**
 * Normalises text for client-side search: lowercase, strips diacritics
 * ("café" matches "cafe"), collapses whitespace, and treats common
 * punctuation as separators.
 */
export function foldForSearch(s: string) {
  return s
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[_\-./\\,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Highlights matched terms for display; returns segments, not HTML, so it's XSS-safe by construction. */
export function highlight(text: string, query: string): { text: string; hit: boolean }[] {
  const terms = foldForSearch(query).split(' ').filter(Boolean)
  if (!terms.length) return [{ text, hit: false }]

  const folded = foldForSearch(text)
  // Folding can change string length (ligatures), so only highlight if it didn't.
  if (folded.length !== text.length) return [{ text, hit: false }]

  const marks = new Array<boolean>(text.length).fill(false)
  for (const t of terms) {
    let i = folded.indexOf(t)
    while (i !== -1) {
      for (let j = i; j < i + t.length; j++) marks[j] = true
      i = folded.indexOf(t, i + t.length)
    }
  }

  const out: { text: string; hit: boolean }[] = []
  for (let i = 0; i < text.length; i++) {
    const last = out[out.length - 1]
    if (last && last.hit === marks[i]) last.text += text[i]
    else out.push({ text: text[i], hit: marks[i] })
  }
  return out
}
