import type { SentenceBoundary } from '../lib/types';

// Common abbreviations that should not trigger a sentence split
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'ave', 'blvd',
  'gen', 'gov', 'sgt', 'cpl', 'pvt', 'capt', 'lt', 'col', 'maj',
  'cmdr', 'adm', 'rev', 'hon', 'pres',
  'dept', 'univ', 'assn', 'bros', 'inc', 'ltd', 'co', 'corp',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
  'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',
  'vol', 'vs', 'etc', 'approx', 'appt', 'est', 'min', 'max',
  'dept', 'div', 'fig', 'no', 'op', 'pp', 'para',
]);

// Multi-character abbreviations like "e.g.", "i.e.", "U.S."
const MULTI_DOT_ABBREV = /^(?:e\.g|i\.e|a\.m|p\.m|u\.s|u\.k|u\.n)$/i;

function isAbbreviation(word: string): boolean {
  // Remove trailing period
  const base = word.replace(/\.$/, '').toLowerCase();
  if (ABBREVIATIONS.has(base)) return true;
  if (MULTI_DOT_ABBREV.test(word.replace(/\.$/, ''))) return true;

  // Single uppercase letter followed by period (initials like "J.")
  if (/^[A-Z]$/.test(base)) return true;

  return false;
}

function isDecimal(text: string, dotIndex: number): boolean {
  // Check if the period is between digits: "3.99"
  if (dotIndex <= 0 || dotIndex >= text.length - 1) return false;
  return /\d/.test(text[dotIndex - 1] ?? '') && /\d/.test(text[dotIndex + 1] ?? '');
}

function isEllipsis(text: string, dotIndex: number): boolean {
  // Three or more consecutive dots
  if (dotIndex >= 2 && text[dotIndex - 1] === '.' && text[dotIndex - 2] === '.') return true;
  if (
    dotIndex >= 1 &&
    dotIndex < text.length - 1 &&
    text[dotIndex - 1] === '.' &&
    text[dotIndex + 1] === '.'
  )
    return true;
  if (dotIndex < text.length - 2 && text[dotIndex + 1] === '.' && text[dotIndex + 2] === '.')
    return true;
  // Unicode ellipsis
  if (text[dotIndex] === '\u2026') return true;
  return false;
}

/**
 * Split text into sentence boundaries with offsets.
 */
export function splitSentences(text: string): SentenceBoundary[] {
  if (!text.trim()) return [];

  const boundaries: SentenceBoundary[] = [];
  let sentenceStart = 0;

  // Skip leading whitespace
  while (sentenceStart < text.length && /\s/.test(text[sentenceStart] ?? '')) {
    sentenceStart++;
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? '';

    // Check for sentence-ending punctuation
    if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '\u2026'
        && ch !== '\u3002' && ch !== '\uFF01' && ch !== '\uFF1F') continue;

    // Skip ellipsis
    if (ch === '.' && isEllipsis(text, i)) continue;
    if (ch === '\u2026') continue;

    // Skip decimals
    if (ch === '.' && isDecimal(text, i)) continue;

    // Skip abbreviations: look backwards to find the preceding word
    if (ch === '.') {
      let wordStart = i - 1;
      while (wordStart >= 0 && /[A-Za-z.]/.test(text[wordStart] ?? '')) {
        wordStart--;
      }
      const precedingWord = text.slice(wordStart + 1, i + 1);
      if (isAbbreviation(precedingWord)) continue;
    }

    // Consume any trailing punctuation (e.g., '!"', '?"', '."')
    let end = i + 1;
    while (end < text.length && /['""\u201C\u201D\u2019)}\]]/.test(text[end] ?? '')) {
      end++;
    }

    // Check if followed by whitespace then an uppercase letter or end of text
    let afterPunct = end;
    while (afterPunct < text.length && /\s/.test(text[afterPunct] ?? '')) {
      afterPunct++;
    }

    const atEnd = afterPunct >= text.length;
    const nextIsUpper = afterPunct < text.length && /[A-Z\u201C\u2018"'(]/.test(text[afterPunct] ?? '');
    const isCjkTerminator = ch === '\u3002' || ch === '\uFF01' || ch === '\uFF1F';
    const nextIsCjk = afterPunct < text.length && /[\u4E00-\u9FFF\u3400-\u4DBF\u3000-\u303F]/.test(text[afterPunct] ?? '');
    const hasNewline = /[\r\n]/.test(text.slice(end, afterPunct));

    if (atEnd || nextIsUpper || isCjkTerminator || nextIsCjk || hasNewline) {
      const sentenceText = text.slice(sentenceStart, end).trim();
      if (sentenceText) {
        boundaries.push({
          text: sentenceText,
          startOffset: sentenceStart,
          endOffset: end,
        });
      }
      sentenceStart = afterPunct;
      i = afterPunct - 1; // will be incremented by for loop
    }
  }

  // Remaining text as last sentence
  const remaining = text.slice(sentenceStart).trim();
  if (remaining) {
    boundaries.push({
      text: remaining,
      startOffset: sentenceStart,
      endOffset: text.length,
    });
  }

  return boundaries;
}

/**
 * Convenience: return just sentence strings.
 */
export function splitSentenceStrings(text: string): string[] {
  return splitSentences(text).map((b) => b.text);
}
