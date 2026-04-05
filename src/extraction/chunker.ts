import type { TextChunk } from '../lib/types';
import { splitSentenceStrings } from './sentence-splitter';

export interface ChunkConfig {
  minWords: number;
  maxWords: number;
  splitThreshold: number;
}

const DEFAULT_CONFIG: ChunkConfig = { minWords: 15, maxWords: 25, splitThreshold: 50 };
function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Split a long sentence at clause boundaries (comma, semicolon, em-dash).
 */
function splitAtClauseBoundary(text: string, maxWords: number): string[] {
  // Split at comma/semicolon/em-dash followed by a space
  const parts = text.split(/(?<=[,;\u2014])\s+/);
  if (parts.length <= 1) return [text];

  // Merge parts to stay within target range
  const merged: string[] = [];
  let current = '';

  for (const part of parts) {
    const combined = current ? `${current} ${part}` : part;
    if (countWords(combined) > maxWords && current) {
      merged.push(current.trim());
      current = part;
    } else {
      current = combined;
    }
  }
  if (current.trim()) merged.push(current.trim());

  return merged;
}

/**
 * Split text into TTS-friendly chunks.
 *
 * Strategy:
 * 1. Split by paragraphs
 * 2. Split each paragraph into sentences
 * 3. Keep each sentence as its own playback segment
 * 4. Split only very long sentences at clause boundaries
 */
export function chunkText(text: string, config: ChunkConfig = DEFAULT_CONFIG): TextChunk[] {
  if (!text.trim()) return [];

  const { maxWords, splitThreshold } = config;
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());
  const rawChunks: string[] = [];

  for (const para of paragraphs) {
    const sentences = splitSentenceStrings(para.trim());

    for (const sentence of sentences) {
      const sentenceWords = countWords(sentence);

      // Very long sentence: split at clause boundary
      if (sentenceWords > splitThreshold) {
        const clauses = splitAtClauseBoundary(sentence, maxWords);
        for (const clause of clauses) {
          rawChunks.push(clause.trim());
        }
        continue;
      }

      rawChunks.push(sentence.trim());
    }
  }

  // Build TextChunk array with offsets
  const chunks: TextChunk[] = [];
  let globalOffset = 0;

  for (let i = 0; i < rawChunks.length; i++) {
    const chunkText = rawChunks[i] ?? '';
    // Find the chunk in the original text starting from globalOffset
    const idx = text.indexOf(chunkText, globalOffset);
    const startOffset = idx >= 0 ? idx : globalOffset;
    const endOffset = startOffset + chunkText.length;

    chunks.push({
      index: i,
      text: chunkText,
      startOffset,
      endOffset,
      wordCount: countWords(chunkText),
    });

    if (idx >= 0) {
      globalOffset = endOffset;
    }
  }

  return chunks;
}
