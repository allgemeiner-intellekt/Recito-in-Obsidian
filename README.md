# Recito

Read your Obsidian notes aloud with karaoke-style word and sentence highlighting.

Recito streams text-to-speech from your chosen provider, highlights each word as it's spoken, and lets you click any sentence to jump there. It's designed for reading long notes the way you'd listen to a podcast — with your place saved automatically so you can come back later.

## Features

- **Karaoke-style highlighting** — words and sentences highlight in sync with audio using the CSS Highlight API
- **Click-to-seek** — click any sentence in the reading view to jump there and keep playing
- **Gapless playback** — chunks are prefetched and scheduled via the Web Audio API, so you don't hear seams
- **5 TTS providers** — OpenAI, ElevenLabs, Groq, Mimo, and any custom OpenAI-compatible endpoint
- **API key pooling** — add multiple keys per provider; Recito fails over automatically when one is rate-limited or exhausted
- **Resume where you left off** — Recito remembers your playback position per-note
- **Sidebar panel** — dedicated playback controls in a sidebar view
- **Commands & hotkeys** — bind start/pause/stop/skip to your own keybindings
- **Desktop only** — uses the Web Audio API and direct network calls to TTS providers

## Requirements

- Obsidian 1.5.0 or later
- Desktop (Windows / macOS / Linux) — this plugin does not run on mobile
- An API key from at least one of: OpenAI, ElevenLabs, Groq, Mimo, or any OpenAI-compatible TTS endpoint

## Installation

Recito is not yet in the Obsidian community plugin store. Install it manually:

1. Go to the [Releases page](https://github.com/allgemeiner-intellekt/Recito-in-Obsidian/releases) and download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. In your vault, create a folder at `<vault>/.obsidian/plugins/recito/`.
3. Copy the three files into that folder.
4. In Obsidian, go to **Settings → Community plugins**, enable community plugins if you haven't, then toggle **Recito** on in the **Installed plugins** list.

You may need to reload Obsidian (Ctrl/Cmd+R) after the first install.

### Updating

Re-download the three files from the newest release and overwrite them in the same folder. Disable and re-enable the plugin in Obsidian to reload it.

## Setup

1. Open **Settings → Recito**.
2. Under **TTS Providers**, pick a provider and add at least one API key. You can add multiple keys to the same provider — Recito will rotate through them on failure.
3. Under **Voice**, Recito will fetch the voice list from the provider using your key. Pick a voice.
4. Optionally tweak playback settings (speed, chunk size, etc.) and appearance.

### Getting API keys

- **OpenAI** — https://platform.openai.com/api-keys
- **ElevenLabs** — https://elevenlabs.io/app/settings/api-keys
- **Groq** — https://console.groq.com/keys
- **Mimo** — see the Mimo dashboard for your provider
- **Custom** — any OpenAI-compatible `/v1/audio/speech` endpoint

Your keys are stored only in this plugin's local data file (`.obsidian/plugins/recito/data.json`) and never leave your machine except when making requests to the TTS provider you configured.

## Usage

- Open a note in **reading view** (the "book" icon, not edit mode).
- Click the **headphones ribbon icon** on the left, or run the command **Recito: Start reading**.
- The sidebar panel opens on the right with transport controls.
- Click any sentence in the note to jump to it.
- Switching to another note automatically pauses playback.

### Commands

All commands are available in Obsidian's command palette and can be bound to hotkeys under **Settings → Hotkeys**:

- **Recito: Start reading**
- **Recito: Pause / Resume**
- **Recito: Stop reading** (clears resume position)
- **Recito: Clear playback progress for current note**
- **Recito: Skip forward**
- **Recito: Skip backward**
- **Recito: Toggle Recito sidebar**

## Backup & restore

Settings → Recito → **Backup** lets you export your full configuration (providers, keys, voices, playback preferences) as a JSON file and re-import it later. Useful when setting up Recito on a second machine.

## Known limitations

- **Reading view only** — highlighting requires the rendered preview DOM; it will not work in edit / live-preview mode.
- **Desktop only** — mobile Obsidian does not expose the APIs Recito needs.
- **Your own API costs** — every request hits your configured TTS provider and uses your credits.

## Development

```bash
npm install
npm run dev    # watch mode, rebuilds main.js on changes
npm run build  # production (type-check + minify)
npm test       # unit tests
npm run lint   # eslint with obsidianmd rules
```

To develop against a real vault, symlink or clone this repo into `<vault>/.obsidian/plugins/recito/`.

## License

[0BSD](./LICENSE) — do anything you want with it.
