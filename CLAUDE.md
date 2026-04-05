# Recito in Obsidian

Obsidian plugin that reads notes aloud with karaoke-style word + sentence highlighting. Migrated from the Immersive Reader Chrome extension at `~/allgemeiner-intellekt/immersive-reader/`.

## What This Plugin Does

- TTS playback of Obsidian notes in Reading View with 5 providers (OpenAI, ElevenLabs, Groq, Mimo, Custom)
- Real-time word and sentence highlighting synced to audio (CSS Highlight API)
- Click-to-seek: click any sentence to jump there and keep playing
- Gapless playback with chunk prefetching via Web Audio API
- API key pooling: multiple keys per provider with automatic failover
- Sidebar panel for playback controls (Obsidian `ItemView`)

## Architecture

Single-process Electron app — no message passing. The Chrome extension's 3 isolated contexts collapse into direct function calls.

- **Reading View only** for highlighting (DOM-based, same approach as Chrome extension on web pages)
- **Vanilla DOM** for sidebar UI (no React)
- **Web Audio API** directly (no offscreen document)

## Source Reference

Chrome extension source at `~/allgemeiner-intellekt/immersive-reader/src/` — port logic from there, adapting Chrome APIs to Obsidian APIs.

Key mappings:
- `chrome.storage.local` → `plugin.loadData()`/`plugin.saveData()`
- `chrome.runtime.sendMessage` → direct function calls
- Offscreen document audio → direct `AudioContext`
- Content script DOM access → Reading View DOM access via `.markdown-reading-view`
- Floating toolbar → `ItemView` sidebar panel
- Options page → `PluginSettingTab`

## Design Spec

Full design at `docs/superpowers/specs/2026-04-05-recito-obsidian-migration-design.md`.

## Build & Dev

```bash
npm install
npm run dev    # watch mode
npm run build  # production (type-check + minify)
```

## Module Structure

```
src/
  main.ts              # Plugin entry, ribbon, commands, lifecycle
  settings.ts          # PluginSettingTab, provider config UI
  sidebar.ts           # ItemView for playback controls
  orchestrator.ts      # Session management, chunk sequencing
  audio-player.ts      # Web Audio API, gapless scheduling
  word-timing.ts       # Real timings + interpolation
  highlighting/        # CSS Highlight API, DOM mapping, auto-scroll, click-to-seek
  extraction/          # Reading View DOM walker, sentence splitter, chunker
  providers/           # TTS providers (openai, elevenlabs, groq, mimo, custom) + failover
  lib/                 # Shared types, constants, api-error
```

## Conventions

- Follow AGENTS.md for Obsidian plugin conventions
- Keep `main.ts` minimal — lifecycle only, delegate to modules
- Split files at ~200-300 lines
- `isDesktopOnly: true` (Web Audio API + TTS network calls)
- Use `this.register*` helpers for all cleanup
- No React — vanilla DOM for all UI
- Port provider code from Chrome extension as directly as possible, only changing Chrome-specific APIs
