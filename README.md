# RAW to Image Converter (Eagle Plugin)

Converts Sony **.ARW** RAW photos into a wide range of common image formats —
**JPEG, PNG, WEBP, TIFF, BMP, GIF, AVIF** — right from inside
[Eagle](https://eagle.cool), using Eagle's [Plugin API](https://developer.eagle.cool/plugin-api).

## Why this needs more than FFmpeg

FFmpeg is excellent at *encoding* images/video, but it has no built-in decoder
for camera RAW sensor formats like Sony's `.ARW` (there's no demosaicing /
Bayer-pattern support in stock FFmpeg). So this plugin splits the job in two:

1. **Decode** the RAW file into plain RGB pixel data. This is tried with a
   few different decoders, in order, until one works:
   1. [`libraw-wasm`](https://www.npmjs.com/package/libraw-wasm) — a
      WebAssembly build of [LibRaw](https://www.libraw.org/) that runs
      entirely in-process, no extra installs needed. This is the primary
      path and should handle the vast majority of ARW files.
   2. macOS `sips` (built-in on every Mac) — used automatically as a
      fallback on macOS if step 1 fails.
   3. `dcraw` — used if it's installed and on your `PATH`.
   4. ImageMagick (`magick`/`convert`) — used if installed and on your
      `PATH`.
2. **Encode** the decoded pixels into every format you selected, using
   Eagle's official [FFmpeg dependency plugin](https://developer.eagle.cool/plugin-api/extra-module/ffmpeg)
   (`eagle.extraModule.ffmpeg`). This is where format conversion, quality,
   and resizing happen.

If every decoder fails for a given file (e.g. a brand-new camera RAW variant
that isn't supported yet anywhere), the plugin reports a clear error for that
file instead of silently skipping it.

## Features

- **Always follows your Eagle selection.** There's no "Add Files" or "Use
  Selection" button — select `.ARW` files in your library and open the
  plugin (or reselect while it's open); the file list updates automatically.
- Native-style Eagle UI: frameless window with a custom title bar, compact
  label/dropdown rows, and light/dark palettes that follow Eagle's own theme
  (`eagle.app.theme` / `eagle.onThemeChanged`).
- Batch conversion to JPEG, PNG, WEBP, TIFF, BMP, GIF, and AVIF — pick any
  combination from the **Format** dropdown.
- Adjustable **Quality** (only shown when a lossy format — JPEG/WEBP/AVIF —
  is selected) and an optional **Size** scale (as a percentage of the
  original dimensions).
- Converted files are always saved next to the original `.ARW` and always
  imported back into Eagle (carrying over the original's tags/folders) — no
  extra options to configure.
- Every control (checkboxes, dropdowns, the quality stepper) is a fully
  custom, hand-styled component — no default browser form widgets or focus
  rings anywhere in the UI.

## Setup (development / local use)

1. Install dependencies (this downloads the LibRaw WASM decoder into
   `node_modules/`, which must be present for the plugin to run):

   ```bash
   npm install
   ```

2. In Eagle: click the **Plugin** icon in the toolbar → **Developer Options**
   → **Create Plugin** (choose "Window Plugin") to scaffold a dev plugin
   entry, then point it at (or replace its generated files with) this
   folder. If Eagle assigns its own `id` in the scaffolded `manifest.json`,
   copy that `id` into this project's `manifest.json` so Eagle recognizes it
   consistently between reloads.
3. Open the plugin from the Plugin panel. Press `F12` inside the plugin
   window to open DevTools if you need to debug.
4. The first time you use it, Eagle will prompt you to install the
   **FFmpeg** dependency plugin if it isn't already installed — accept that
   prompt (the top status line in this plugin also shows an inline install
   link).

## Usage

1. Select one or more `.ARW` files in your Eagle library, then open the
   plugin — the file list fills in automatically from whatever is currently
   selected (reselecting files while the plugin window is open refreshes it
   too).
2. Choose **Format** (one or more) and, if applicable, **Quality** and
   **Size**.
3. Click **Convert**. Each file's row shows live status (Converting… / Done
   / an error message) in place of its format label. Converted files land
   next to the original and are automatically added back into Eagle.

## Notes & limitations

- Very new Sony RAW variants (e.g. ARW6 / "Compressed HQ" from 2024+ camera
  bodies) may not yet be supported by the bundled LibRaw WASM build. If
  decoding fails, the plugin automatically tries the OS/CLI fallbacks
  described above — install `dcraw` or ImageMagick if you regularly shoot
  with a very new camera body and want a fallback ready.
- AVIF encoding requires FFmpeg to have been built with `libaom`. Eagle's
  official FFmpeg dependency plugin generally includes this, but if AVIF
  export fails, try a different format.
- This plugin only targets `.ARW`; other RAW formats (`.CR2`, `.CR3`, `.NEF`,
  `.DNG`, …) are intentionally filtered out to keep scope focused, though
  the underlying LibRaw decoder does support many of them.

## Project structure

```
eagle-arw-converter/
├── manifest.json     # Plugin metadata + FFmpeg dependency declaration
├── logo.png          # Plugin icon
├── index.html        # Plugin window UI
├── css/style.css
├── js/plugin.js       # All conversion logic
└── package.json / node_modules/  # libraw-wasm dependency
```

## Packaging / publishing

From Eagle's Plugin panel, right-click this plugin → **Pack Plugin** to
export a `.eagleplugin` file (see Eagle's
[Package Plugin](https://developer.eagle.cool/plugin-api/get-started/package-plugin)
docs). Make sure `npm install` has been run first so `node_modules/` is
present and gets bundled.

## License

MIT
