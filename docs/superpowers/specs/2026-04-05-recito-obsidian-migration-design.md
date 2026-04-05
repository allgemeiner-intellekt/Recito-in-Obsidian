# Recito in Obsidian — Design Spec

Migration of the Immersive Reader Chrome extension's TTS features and UX to an Obsidian community plugin.

## Core Differentiator

Karaoke-style word + sentence highlighting synchronized to TTS audio playback. This is what sets Recito apart from existing Obsidian TTS plugins.

## Scope

Port all features from the Chrome extension to Obsidian:
- 5 TTS providers (OpenAI, ElevenLabs, Groq, Mimo, Custom)
- Karaoke highlighting (word + sentence level)
- Gapless playback with chunk prefetching
- Click-to-seek on any sentence
- Auto-scroll to current position
- API key pooling with automatic failover
- Reading progress persistence

## Architecture

### Single-Process Simplification

The Chrome extension runs across 3 isolated contexts (service worker, content script, offscreen document) communicating via async message passing. In Obsidian (Electron), everything runs in a single process with direct function calls. This eliminates:
- Message routing (`chrome.runtime.sendMessage`)
- Base64 encoding for audio transfer
- Offscreen document management
- Content script injection

### Approach: DOM-First

Operate directly on Obsidian's Reading View DOM. The reading view renders markdown to HTML, making it structurally similar to the web pages the Chrome extension already handles. This maximizes code reuse from the existing highlighting and extraction systems.

## Highlighting System

### Pipeline

1. **Extract** — Walk the `.markdown-reading-view` DOM, build a `TextNodeEntry[]` map, skip code blocks and frontmatter
2. **Chunk** — Split extracted text into sentences, group into provider-sized chunks (15-50 words depending on provider)
3. **Synthesize** — TTS API call per chunk, prefetch 2 chunks ahead for gapless playback
4. **Highlight** — Map word timing callbacks to DOM ranges via CSS Highlight API, auto-scroll to current word

### Word Timing

- **ElevenLabs**: Real word-level timestamps from `/with-timestamps` endpoint
- **All other providers**: Character-weighted interpolation — longer words get proportionally more time based on audio duration

### Highlight Layers

- **Word highlight**: 35% opacity accent color (CSS Highlight API priority 2)
- **Sentence highlight**: 8% opacity accent color (priority 0)
- No `<mark>` fallback needed — Electron's Chromium always supports CSS Highlight API

### What Ports Directly from Chrome Extension

- CSS Highlight API usage
- Text node map building (`dom-mapper.ts`)
- Character offset → DOM range mapping
- Word/sentence highlight priorities
- Auto-scroll behavior (scroll to viewport center, pause on manual scroll, resume after 5s idle)
- Click-to-seek on sentences
- Word timing relay (real + interpolated)
- Sentence splitter
- Chunker logic

### What Needs Adaptation

- DOM walking targets `.markdown-reading-view` container instead of Readability output
- Skip logic identifies code blocks, frontmatter, callouts in Obsidian's rendered DOM
- Re-init on note switch via `workspace.on('active-leaf-change')`
- Message passing replaced with direct callbacks

## Reading View Only

Playback and highlighting operate exclusively in Reading View. Rationale:
- Reading View renders HTML DOM, directly compatible with the Chrome extension's highlighting approach
- Click-to-seek requires click events on text — in Editing View, clicks place the editor cursor, creating a fundamental conflict
- Reading View is the natural context for listening to a note

When the user presses play, the plugin automatically switches the active leaf to Reading View.

## UI: Sidebar Panel

Replaces the Chrome extension's floating toolbar. Built as an Obsidian `ItemView` (same pattern as Outline, Backlinks).

### Why Sidebar Instead of Floating Toolbar

- Obsidian has a first-class sidebar view API — users expect controls there
- A floating toolbar would require fighting Obsidian's layout system, theme CSS, split panes, and popout windows
- The sidebar persists across note switches
- Can be collapsed/toggled natively

### Sidebar States

**Idle state**: Centered play button, "Open a note and press play" message, active provider display.

**Playing state**:
- Note title
- Elapsed time / estimated total time (e.g., `2:34 / 8:12`)
- Progress bar with seek
- Play/pause, skip back/forward buttons
- Speed presets (1x, 1.25x, 1.5x, 2x)
- Volume slider
- Active provider/voice display
- API key pool health indicators (green/red dots)

### Implementation

- Vanilla DOM manipulation — no React dependency, keeps the plugin lightweight
- Rendered with Obsidian's native `ItemView` class
- Command palette commands + hotkeys work when sidebar is collapsed

## Entry Points

1. **Ribbon icon** — one-click to switch to Reading View + start playback
2. **Command palette** — "Recito: Start reading", "Recito: Pause", "Recito: Resume", etc. (user can bind hotkeys)
3. **Sidebar play button** — when sidebar is open

## TTS Providers

All 5 providers from the Chrome extension, ported as-is:

| Provider | Models | Voices | Chunk Size | Key Features |
|----------|--------|--------|------------|--------------|
| OpenAI | tts-1, tts-1-hd | 6 built-in | 30-50 words | Reliable, consistent |
| ElevenLabs | flash_v2_5, multilingual_v2 | 1000+ (dynamic fetch) | 30-50 words | Word-level timestamps |
| Groq | orpheus-v1-english + arabic | 10 PlayAI | 15-25 words | Ultra-low latency |
| Mimo | — | 3 built-in | 30-50 words | Multilingual |
| Custom | User-defined | Custom | 30-50 words | Any OpenAI-compatible endpoint |

### API Key Pooling

Users can add multiple API keys per provider (e.g., two OpenAI accounts to extend free tier). The failover system automatically rotates to the next healthy key when one hits rate limits:
- 401 → permanent failure (bad key)
- 429 → 1 minute cooldown
- 403 → 5 minute cooldown
- 5xx/network → 30 second cooldown

Port `failover.ts` and storage provider group logic directly.

## Audio Engine

Web Audio API with gapless scheduling, significantly simplified from Chrome extension:
- Direct `AudioContext` access (no offscreen document)
- Prefetch 2 chunks ahead (configurable)
- Schedule next chunk to start exactly when current ends
- Residual playback rate for speed (server synthesizes at clamped speed, player applies remainder)
- Direct `ArrayBuffer` → `AudioBuffer` decode (no base64 message passing)

## Content Extraction

Walk the Reading View DOM to extract prose text:
- Skip YAML frontmatter
- Skip code blocks (inline and fenced)
- Read callout text content (skip callout type/title markup, read the body text)
- Build `TextNodeEntry[]` mapping text content to DOM nodes with character offsets
- No need for Readability or custom scoring — Obsidian's reading view already renders clean content

## Settings

Built with Obsidian's native `PluginSettingTab`. Three sections:

### Providers
- List all providers with configured/not-configured state
- Inline editing: API keys (add/remove/test), model selection, voice selection
- Health indicators per API key

### Playback
- Default speed (dropdown: 1x, 1.25x, 1.5x, 2x)
- Auto-scroll toggle
- Prefetch buffer size (1-3 chunks)

### Appearance
- Accent color for highlights (preset palette + custom)

Hotkeys are handled by Obsidian's native command system — no custom hotkey settings needed.

## Lifecycle & Edge Cases

### Note Switching During Playback
Detected via `workspace.on('active-leaf-change')`. Pause playback, clear highlights. Sidebar shows paused state. User can resume or start a new note.

### Edit View Switch During Playback
Detect view mode change. Pause playback, clear highlights. Offer to resume when user returns to Reading View.

### Click-to-Seek
Click handler on Reading View content. Map click target → text offset → chunk index + position. Seek audio, resume playback, re-highlight from new position.

### Reading Progress Persistence
Save per note path (via `saveData()`). Store chunk index + position. 7-day TTL. On play: check for saved progress, offer to resume.

### Plugin Unload
`onunload()` stops audio, clears highlights, disposes `AudioContext`. Save progress for resume on next load.

## Module Structure

```
src/
  main.ts                    # Plugin entry, ribbon, commands, lifecycle
  settings.ts                # PluginSettingTab, provider config UI
  sidebar.ts                 # ItemView for playback controls
  orchestrator.ts            # Session management, chunk sequencing
  audio-player.ts            # Web Audio API, gapless scheduling
  word-timing.ts             # Real timings + interpolation
  highlighting/
    highlight-manager.ts     # CSS Highlight API, word/sentence ranges
    dom-mapper.ts            # Text node map from Reading View DOM
    auto-scroll.ts           # Scroll to highlighted text
    click-to-seek.ts         # Click handler → seek to position
  extraction/
    extractor.ts             # Walk Reading View DOM, skip non-prose
    sentence-splitter.ts     # Split text into sentences
    chunker.ts               # Group into provider-sized chunks
  providers/
    registry.ts              # Provider registry + chunk limits
    openai.ts                # OpenAI TTS
    elevenlabs.ts            # ElevenLabs + /with-timestamps
    groq.ts                  # Groq PlayAI
    mimo.ts                  # Xiaomi Mimo
    custom.ts                # OpenAI-compatible endpoint
    failover.ts              # Health tracking, key pool rotation
  lib/
    types.ts                 # Shared interfaces
    constants.ts             # Speed ranges, defaults
    api-error.ts             # Error class with retry logic
```

~20 source files (down from ~54 in Chrome extension) due to eliminating message routing, offscreen document, popup, onboarding, React, and `<mark>` fallback.

## What Is NOT In Scope

- Editing View / Live Preview highlighting (future v2)
- Onboarding wizard (settings tab is sufficient)
- Text selection reading (may add later)
- Gmail-specific extraction
- Browser popup
- Theme toggle (respects Obsidian's theme automatically)
- Mobile support (desktop-only for v1 — Web Audio API + TTS APIs require network + compute)
