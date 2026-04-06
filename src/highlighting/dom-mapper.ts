import type { TextNodeEntry, TextMapResult } from '../lib/types';

const SKIP_SELECTORS = [
  'pre',
  'code',
  '.mod-header',
  '.inline-title',
  '.mod-frontmatter',
  '.frontmatter-container',
  '.metadata-container',
  '.metadata-properties',
  '.math',
  '.callout-title',
  '.embedded-backlinks',
  '.mod-footer',
];

const SKIP_SELECTOR = SKIP_SELECTORS.join(', ');

function shouldSkip(node: Node): boolean {
  if (node.nodeType === Node.ELEMENT_NODE) {
    return (node as Element).matches(SKIP_SELECTOR);
  }
  let parent = node.parentElement;
  while (parent) {
    if (parent.matches(SKIP_SELECTOR)) return true;
    parent = parent.parentElement;
  }
  return false;
}

export function buildTextNodeMap(root: Element): TextMapResult {
  const entries: TextNodeEntry[] = [];
  let offset = 0;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      if (shouldSkip(node)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const text = node.nodeValue ?? '';
    if (!text) continue;
    entries.push({ node, globalStart: offset, globalEnd: offset + text.length });
    offset += text.length;
  }

  const text = entries.map((e) => e.node.nodeValue ?? '').join('');
  return { entries, text, sourceElement: root };
}
