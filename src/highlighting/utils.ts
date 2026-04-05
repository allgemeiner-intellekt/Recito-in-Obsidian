import type { TextNodeEntry } from '../lib/types';

/**
 * Create a DOM Range spanning the text between `startOffset` and `endOffset`
 * (global character offsets within the concatenated text from buildTextNodeMap).
 */
export function createRangeFromOffsets(
  entries: TextNodeEntry[],
  startOffset: number,
  endOffset: number,
): Range | null {
  if (entries.length === 0 || startOffset >= endOffset) return null;

  let startNode: Text | null = null;
  let startLocal = 0;
  let endNode: Text | null = null;
  let endLocal = 0;

  for (const entry of entries) {
    if (!startNode && startOffset < entry.globalEnd) {
      startNode = entry.node;
      startLocal = startOffset - entry.globalStart;
    }
    if (endOffset <= entry.globalEnd) {
      endNode = entry.node;
      endLocal = endOffset - entry.globalStart;
      break;
    }
  }

  if (!startNode || !endNode) return null;

  try {
    const range = document.createRange();
    range.setStart(startNode, Math.max(0, startLocal));
    range.setEnd(endNode, Math.min(endLocal, endNode.length));
    return range;
  } catch {
    return null;
  }
}
