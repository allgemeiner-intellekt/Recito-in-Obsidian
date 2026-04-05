// Ambient declarations for the CSS Custom Highlight API
// (not yet in TypeScript's bundled DOM lib at the versions we target)

interface Highlight {
  priority: number;
  add(range: AbstractRange): void;
  clear(): void;
  delete(range: AbstractRange): boolean;
  has(range: AbstractRange): boolean;
  readonly size: number;
}

declare var Highlight: {
  prototype: Highlight;
  new (...ranges: AbstractRange[]): Highlight;
};

interface HighlightRegistry {
  set(name: string, highlight: Highlight): HighlightRegistry;
  get(name: string): Highlight | undefined;
  delete(name: string): boolean;
  has(name: string): boolean;
  clear(): void;
  readonly size: number;
  forEach(
    callbackfn: (value: Highlight, key: string, map: HighlightRegistry) => void,
    thisArg?: unknown,
  ): void;
}

interface CSS {
  highlights: HighlightRegistry;
}
