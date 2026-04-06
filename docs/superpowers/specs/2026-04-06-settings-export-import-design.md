# Settings Export / Import — Cross-Tool Design

**Date:** 2026-04-06
**Status:** Design approved, awaiting implementation plan
**Scope:** Recito Obsidian plugin + Recito Chrome extension

## Goal

Let users export and import their Recito settings as a single JSON file that
works in **both** the Obsidian plugin and the Chrome extension. A file
exported from one tool should be importable into the other, carrying every
field that has a meaningful equivalent and gracefully passing through
fields that don't.

The Chrome extension already has export/import (`{providers, settings}`
envelope, no version, no validation). This design extends that format
into a small shared contract and adds the same feature on the Obsidian side.

## Non-goals

- No encryption or password-protection of the export file. API keys ship
  in plain text, matching Chrome's existing behavior.
- No cloud sync, no over-the-wire transport, no QR codes, no merge UI.
- No reading-progress portability — note paths and URLs are not
  meaningfully convertible across tools.
- No restructuring of either side's on-disk settings schema. The shared
  format lives only in the export envelope; each side keeps its own
  internal `RecitoSettings` / `AppSettings` shape.

## File format

A single JSON file, default name `recito-settings.json`:

```json
{
  "version": 1,
  "providers": [ /* ProviderConfig[] verbatim */ ],
  "settings": { /* settings object — keys vary by source tool */ }
}
```

### `version`

Integer. This revision is `1`. Importers MUST treat a missing `version`
field as `1` so existing Chrome exports (which have no version) keep
loading. Importers that see a higher version than they understand SHOULD
log a warning and proceed best-effort rather than refusing the import.

### `providers`

The provider array verbatim from each side's storage. Both sides MUST
preserve unknown per-provider fields on import — that is, when the
importer reads each provider object, it must not strip keys it doesn't
recognize. This is what makes Obsidian's `disabled` flag survive a
Chrome round-trip and what makes future per-provider fields portable
without further code changes.

### `settings`

Each side's full settings object, written verbatim minus excluded
fields (see below). Each side's importer:

1. Reads the keys it understands and copies them into its internal
   settings shape.
2. Applies the cross-tool aliases below.
3. Preserves keys it doesn't understand (passthrough), so a re-export
   carries them forward.

### Cross-tool aliases

Exactly one alias is needed in this revision:

| Obsidian field | Chrome field | Concept                          |
|----------------|--------------|----------------------------------|
| `accentColor`  | `themeColor` | Highlight accent color           |

On import, if the side's native field is absent and the foreign field
is present, copy the foreign value into the native field. On export,
each side writes its own native name; the alias is applied on the
receiving side.

No other aliases are needed — every other field either fully overlaps
(`activeProviderGroup`, `activeVoiceId`, all `playback.*` and
`highlight.*`) or is one-sided (`theme`, `onboardingComplete`,
`playback.skipReferences`, `ui.artworkCollapsed`).

### Excluded from export

The following are stripped on export and ignored on import:

- Obsidian: `settings.readingProgress` (a `Record<notePath,
  ReadingProgress>` inside `RecitoSettings`).
- Chrome: any `chrome.storage.local` key with the `ir-progress:`
  prefix. (Chrome already excludes these today.)

Reading progress is local session state, not configuration, and the
notePath/URL keys are not portable across tools. Importing a file MUST
NOT mutate the user's existing reading progress on either side.

### Round-tripping

The format is designed so that any field originating in either tool
survives a complete round-trip through the other tool, even fields the
intermediate tool has never heard of. This is achieved by **opaque
passthrough**:

- **Obsidian** stores unknown imported keys in a hidden
  `_foreign?: Record<string, unknown>` field on `RecitoSettings`, and
  re-emits them at the top level of `settings` on the next export.
- **Chrome** gets passthrough for free: its existing import does
  `{...DEFAULT_SETTINGS, ...data.settings}` and `saveSettings` doesn't
  strip unknown keys, so foreign fields survive in `chrome.storage.local`
  and re-appear in the next export's `settings` object.

The result: a Chrome user's `theme: "dark"` setting will return intact
after a trip through Obsidian, and an Obsidian user's `ui.artworkCollapsed`
will return intact after a trip through Chrome.

## Field-by-field reference

| Field                            | Obsidian | Chrome | Behavior across the bridge                          |
|----------------------------------|----------|--------|------------------------------------------------------|
| `providers[]`                    | ✓        | ✓      | Verbatim. Unknown per-provider keys preserved.       |
| `providers[].disabled`           | ✓        | —      | Preserved on Chrome via verbatim store; ignored.     |
| `activeProviderGroup`            | ✓        | ✓      | Direct copy.                                         |
| `activeVoiceId`                  | ✓        | ✓      | Direct copy.                                         |
| `playback.defaultSpeed`          | ✓        | ✓      | Direct copy.                                         |
| `playback.defaultVolume`         | ✓        | ✓      | Direct copy.                                         |
| `playback.bufferSize`            | ✓        | ✓      | Direct copy.                                         |
| `playback.autoScrollEnabled`     | ✓        | ✓      | Direct copy.                                         |
| `playback.skipReferences`        | —        | ✓      | Passthrough (Chrome-only).                           |
| `highlight.*`                    | ✓        | ✓      | Direct copy.                                         |
| `accentColor` ↔ `themeColor`     | ✓        | ✓      | **Aliased.** See above.                              |
| `theme`                          | —        | ✓      | Passthrough (Chrome-only).                           |
| `onboardingComplete`             | —        | ✓      | Passthrough (Chrome-only).                           |
| `ui.artworkCollapsed`            | ✓        | —      | Passthrough (Obsidian-only).                         |
| `readingProgress` (any form)     | ✓        | ✓      | **Excluded** from export entirely.                   |

## Obsidian implementation

### New module: `src/lib/settings-io.ts`

A small, isolated, unit-testable module:

```ts
export interface ExportEnvelope {
  version: 1;
  providers: ProviderConfig[];
  settings: Record<string, unknown>;
}

export function buildExport(settings: RecitoSettings): ExportEnvelope;

export function applyImport(
  current: RecitoSettings,
  envelope: unknown,
): {
  next: RecitoSettings;
  providerCount: number;
  warnings: string[];
};
```

#### `buildExport`

1. Deep-clone `settings`.
2. Strip `readingProgress` from the clone.
3. Pull `providers` out of the clone into the envelope's top-level
   `providers` field. The clone's `settings` no longer carries `providers`.
4. Spread any `_foreign` fields back at the top level of the envelope's
   `settings` object so foreign keys round-trip out, then drop the
   `_foreign` wrapper from the emitted `settings`.
5. Return `{ version: 1, providers, settings }`.

#### `applyImport`

1. Validate envelope shape: object, `providers` is array, `settings` is
   object. On failure throw a typed error → caller surfaces a `Notice`.
2. Read `envelope.version ?? 1`. If `> 1`, push a human-readable
   warning into the result; do not abort.
3. Build `next.providers` from `envelope.providers` verbatim, preserving
   any unknown per-provider fields.
4. Recognized settings keys → copy into `next`. Scalars
   (`activeProviderGroup`, `activeVoiceId`, `accentColor`) are
   replaced. Nested objects (`playback`, `highlight`, `ui`) are
   **shallow-merged** onto the current values
   (`next.playback = { ...current.playback, ...envelope.settings.playback }`)
   so a partial import doesn't wipe sub-fields the import file omitted.
5. **Alias:** if `envelope.settings.accentColor` is missing but
   `themeColor` is present, use `themeColor` for `next.accentColor`.
6. **Foreign passthrough:** every top-level key in `envelope.settings`
   that is not a recognized Obsidian key (and is not `accentColor`,
   `themeColor`, or `providers`) goes into `next._foreign`.
7. Reading progress: keep `current.readingProgress` untouched. The
   import must not delete or replace local progress.
8. Run the existing `ensureActiveGroupValid` helper after assignment in
   case the imported `activeProviderGroup` doesn't match any imported
   pool. If it changes, also clear `next.activeVoiceId`.
9. Return `{ next, providerCount, warnings }`.

### Type changes

In `src/lib/types.ts`, add one optional field to `RecitoSettings`:

```ts
export interface RecitoSettings {
  // ... existing fields ...
  /** Opaque passthrough for cross-tool import: foreign settings keys
   *  this side doesn't recognize, kept verbatim so they round-trip on
   *  re-export. */
  _foreign?: Record<string, unknown>;
}
```

No other type changes. `disabled` already exists on `ProviderConfig`.

### Settings tab change (`src/settings.ts`)

Add `renderBackupSection(containerEl)` called after
`renderAppearanceSection`. Two `Setting` rows:

- **Export settings.** Button: `Export`. On click, build the envelope
  via `buildExport`, serialize with `JSON.stringify(env, null, 2)`,
  trigger a download via `URL.createObjectURL` + a transient `<a>`
  element with `download="recito-settings.json"`. Same approach
  Chrome's exporter uses; works in Obsidian's Electron host with no
  Vault writes.
- **Import settings.** Button: `Import…`. On click, create a transient
  `<input type="file" accept=".json">`, read with `file.text()`,
  `JSON.parse`, then call `applyImport(currentSettings, parsed)`.
  - On parse or validation error: `new Notice('Failed to import settings: <message>')`.
  - On success: open a confirmation modal showing
    *"Import N providers and overwrite current settings? Your current
    M providers will be replaced. Reading progress will be kept."*
    with Cancel / Import buttons.
  - On confirm: `plugin.settings = result.next`,
    `await plugin.saveSettings()`, `this.display()`,
    `new Notice('Settings imported.')`. Surface any `result.warnings`
    as additional Notices.

The confirm modal is a small `Modal` subclass in `settings.ts`,
following the same pattern as the existing `ProviderModal`.

### Tests

A new file `src/lib/settings-io.test.ts` covering:

- **Round-trip:** `applyImport(buildExport(s))` returns settings whose
  recognized fields equal `s`.
- **Foreign passthrough out:** Obsidian-only fields (`ui.artworkCollapsed`)
  appear in the export envelope.
- **Foreign passthrough in:** importing an envelope containing
  `theme: 'dark'` and `onboardingComplete: true` stores both in
  `next._foreign`; a subsequent `buildExport` re-emits both at the top
  level of `settings`.
- **`accentColor` ↔ `themeColor` alias:** importing an envelope with
  only `themeColor` populates `next.accentColor`. Exporting always
  writes `accentColor`.
- **Reading progress excluded:** `buildExport` output contains no
  `readingProgress` key. `applyImport` does not modify
  `current.readingProgress`.
- **Provider `disabled` round-trip:** a provider with `disabled: true`
  survives buildExport → applyImport with the flag intact.
- **Version handling:** `version: 99` is accepted, and the result
  contains a warning string.
- **Malformed input:** non-object, missing `providers`, `providers`
  not an array, all throw a typed error.

## Chrome extension implementation

Touches one file: `src/options/Options.tsx`.

### `exportSettings`

One-line change: prepend `version: 1` to the envelope.

```ts
const blob = new Blob(
  [JSON.stringify({ version: 1, providers, settings }, null, 2)],
  { type: 'application/json' },
);
```

### `importSettings`

Three small additions inside the existing `try` block:

1. **Version handling.** After `JSON.parse`:
   ```ts
   const version = typeof data.version === 'number' ? data.version : 1;
   if (version > 1) {
     console.warn(
       `Recito: import file version ${version} is newer than supported (1).`,
     );
   }
   ```
2. **`accentColor` → `themeColor` alias.** After the spread-merge:
   ```ts
   if (data.settings?.accentColor && !data.settings?.themeColor) {
     merged.themeColor = data.settings.accentColor;
   }
   ```
3. No other changes. Chrome's existing spread-merge already preserves
   unknown fields, so Obsidian's `ui`, `_foreign`, etc. survive in
   `chrome.storage.local` and re-emit on the next export "for free."
   The `disabled` flag on providers already round-trips because Chrome
   stores the array verbatim with `chrome.storage.local.set`.

### Out of scope on the Chrome side

- No type changes (passthrough is implicit via storage).
- No new helpers in `lib/storage.ts`.
- No tests added — Chrome's existing import/export has no test
  harness, and adding one is out of scope. The Obsidian-side test
  suite covers the format contract; if it round-trips correctly, the
  Chrome behavior is constrained by the same format.

**Total Chrome diff:** ~7 lines in one file.

## Risks and mitigations

- **Risk: A user imports a file and loses their existing API keys
  silently.** Mitigation: confirm modal on the Obsidian side states
  the provider counts before/after.
- **Risk: An import populates `activeProviderGroup` with a group key
  that doesn't exist in the imported providers.** Mitigation:
  `applyImport` runs `ensureActiveGroupValid` and falls back to the
  first available pool, clearing `activeVoiceId` if it switched.
- **Risk: A future schema change breaks old importers.** Mitigation:
  the `version` field gives us a explicit signal; v1 importers
  warn-but-load on higher versions, so a v2 file is still recoverable
  on older installs.
- **Risk: API keys in plaintext.** Mitigation: explicitly noted in
  this spec; matches existing Chrome behavior; users are expected to
  treat the export file with the same care as the keys themselves.
- **Risk: Chrome's spread-merge stores unknown keys forever even if
  the user doesn't want them.** Mitigation: minor — the keys are
  small, never read by Chrome, and the user can always re-import a
  clean file or reset settings.
