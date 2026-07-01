/* RAW to Image Converter — Eagle plugin
 *
 * Always reflects Eagle's current selection (no manual file picking). The
 * plugin decodes .ARW (Sony RAW) files, then encodes the requested output
 * formats with FFmpeg (Eagle's bundled FFmpeg dependency).
 *
 * FFmpeg cannot decode camera RAW sensor formats on its own, so decoding is
 * handled by a tiered set of decoders, tried in order until one succeeds:
 *   1. LibRaw compiled to WebAssembly (`libraw-wasm`) — in-process, no extra
 *      installs required. This is the primary path.
 *   2. macOS `sips` (built-in on every Mac).
 *   3. `dcraw` on PATH, if installed.
 *   4. ImageMagick (`magick`/`convert`) on PATH, if installed.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const state = {
  files: [],           // { filePath, name, size, width, height, thumbnailURL, tags, folders, status, error }
  converting: false,
  ffmpegPaths: null,
  formats: ['jpg'],
  size: 'original',
  saveTo: 'source',
  customFolder: null,
};

const $ = (sel) => document.querySelector(sel);

const el = {
  banner: $('#banner'),
  fileList: $('#fileList'),
  fileCount: $('#fileCount'),
  rowQuality: $('#rowQuality'),
  qualityInput: $('#qualityInput'),
  qualityUp: $('#qualityUp'),
  qualityDown: $('#qualityDown'),
  rowSizeCustom: $('#rowSizeCustom'),
  sizeCustomInput: $('#sizeCustomInput'),
  addToEagle: $('#addToEagle'),
  btnConvert: $('#btnConvert'),
  btnClose: $('#btnClose'),
  btnClose2: $('#btnClose2'),

  formatControl: $('#formatControl'),
  formatMenu: $('#formatMenu'),
  formatValue: $('#formatValue'),

  sizeControl: $('#sizeControl'),
  sizeMenu: $('#sizeMenu'),
  sizeValue: $('#sizeValue'),

  saveToControl: $('#saveToControl'),
  saveToMenu: $('#saveToMenu'),
  saveToValue: $('#saveToValue'),
};

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function applyTheme(theme) {
  document.body.setAttribute('data-theme', theme || 'DARK');
}

// ---------------------------------------------------------------------------
// Generic dropdown helper
// ---------------------------------------------------------------------------

function closeAllMenus() {
  document.querySelectorAll('.dropdown-menu').forEach((m) => (m.hidden = true));
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.dropdown') && !e.target.closest('.dropdown-menu')) closeAllMenus();
});

function wireDropdown(controlEl, menuEl) {
  controlEl.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = menuEl.hidden;
    closeAllMenus();
    menuEl.hidden = !isHidden;
  });
}

// ---------------------------------------------------------------------------
// Format dropdown (multi-select)
// ---------------------------------------------------------------------------

wireDropdown(el.formatControl, el.formatMenu);

function updateFormatLabel() {
  if (state.formats.length === 1) {
    el.formatValue.textContent = state.formats[0].toUpperCase();
  } else {
    el.formatValue.textContent = `${state.formats[0].toUpperCase()} +${state.formats.length - 1}`;
  }
  updateQualityRowVisibility();
  renderFileList();
  updateConvertButtonState();
}

el.formatMenu.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
  cb.addEventListener('change', () => {
    const checked = Array.from(el.formatMenu.querySelectorAll('input:checked')).map((c) => c.value);
    if (checked.length === 0) {
      cb.checked = true; // never allow zero formats
      return;
    }
    state.formats = checked;
    updateFormatLabel();
  });
});

const LOSSY_FORMATS = new Set(['jpg', 'jpeg', 'webp', 'avif']);
function updateQualityRowVisibility() {
  const showQuality = state.formats.some((f) => LOSSY_FORMATS.has(f));
  el.rowQuality.style.display = showQuality ? '' : 'none';
}

// ---------------------------------------------------------------------------
// Size dropdown
// ---------------------------------------------------------------------------

wireDropdown(el.sizeControl, el.sizeMenu);

el.sizeMenu.querySelectorAll('.menu-item').forEach((item) => {
  item.addEventListener('click', () => {
    state.size = item.dataset.value;
    el.sizeValue.textContent = state.size === 'custom' ? 'Custom' : 'Original';
    el.rowSizeCustom.hidden = state.size !== 'custom';
    el.sizeMenu.querySelectorAll('.menu-item').forEach((i) => i.classList.toggle('selected', i === item));
    closeAllMenus();
  });
});

// ---------------------------------------------------------------------------
// Save-to dropdown
// ---------------------------------------------------------------------------

wireDropdown(el.saveToControl, el.saveToMenu);

function markSaveToSelected(value) {
  el.saveToMenu.querySelectorAll('.menu-item').forEach((i) => i.classList.toggle('selected', i.dataset.value === value));
}

el.saveToMenu.querySelectorAll('.menu-item').forEach((item) => {
  item.addEventListener('click', async () => {
    closeAllMenus();
    if (item.dataset.value === 'source') {
      state.saveTo = 'source';
      el.saveToValue.textContent = 'Same folder';
      el.saveToValue.title = '';
      markSaveToSelected('source');
      return;
    }
    try {
      const result = await eagle.dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
      if (!result.canceled && result.filePaths && result.filePaths[0]) {
        state.customFolder = result.filePaths[0];
        state.saveTo = 'custom';
        el.saveToValue.textContent = path.basename(state.customFolder);
        el.saveToValue.title = state.customFolder;
        markSaveToSelected('custom');
      }
    } catch (err) {
      // dialog failed silently; keep previous saveTo
    }
  });
});

// ---------------------------------------------------------------------------
// Quality stepper
// ---------------------------------------------------------------------------

function clampQuality(v) { return Math.min(100, Math.max(1, v)); }

el.qualityUp.addEventListener('click', () => {
  el.qualityInput.value = clampQuality((parseInt(el.qualityInput.value, 10) || 0) + 1);
});
el.qualityDown.addEventListener('click', () => {
  el.qualityInput.value = clampQuality((parseInt(el.qualityInput.value, 10) || 0) - 1);
});
el.qualityInput.addEventListener('change', () => {
  el.qualityInput.value = clampQuality(parseInt(el.qualityInput.value, 10) || 90);
});

// ---------------------------------------------------------------------------
// Title bar / footer buttons
// ---------------------------------------------------------------------------

el.btnClose.addEventListener('click', () => window.close());
el.btnClose2.addEventListener('click', () => window.close());
el.btnConvert.addEventListener('click', () => convertAll());

// ---------------------------------------------------------------------------
// Banner (FFmpeg status)
// ---------------------------------------------------------------------------

function showBanner(text, onClick) {
  el.banner.textContent = text;
  el.banner.hidden = false;
  el.banner.onclick = onClick || null;
}
function hideBanner() {
  el.banner.hidden = true;
  el.banner.onclick = null;
}

async function initFfmpeg() {
  try {
    if (!eagle.extraModule || !eagle.extraModule.ffmpeg) {
      showBanner('This Eagle version does not support the FFmpeg dependency. Please update Eagle.');
      return;
    }
    const installed = await eagle.extraModule.ffmpeg.isInstalled();
    if (!installed) {
      showBanner('FFmpeg dependency required — tap to install', async () => {
        showBanner('Opening installer…');
        try { await eagle.extraModule.ffmpeg.install(); } catch {}
        setTimeout(initFfmpeg, 2000);
      });
      return;
    }
    state.ffmpegPaths = await eagle.extraModule.ffmpeg.getPaths();
    hideBanner();
  } catch (err) {
    showBanner(`FFmpeg check failed: ${err.message}`);
  }
  updateConvertButtonState();
}

// ---------------------------------------------------------------------------
// Selection syncing
// ---------------------------------------------------------------------------

function extName(item) {
  return (item.ext || '').toLowerCase();
}

async function refreshFromSelection() {
  try {
    const items = await eagle.item.getSelected();
    const arwItems = items.filter((it) => extName(it) === 'arw');
    state.files = arwItems.map((item) => ({
      filePath: item.filePath,
      name: item.name ? `${item.name}.${item.ext}` : path.basename(item.filePath),
      size: item.size || 0,
      width: item.width || null,
      height: item.height || null,
      thumbnailURL: item.thumbnailURL || null,
      tags: item.tags || [],
      folders: item.folders || [],
      status: 'pending',
      error: null,
    }));
  } catch {
    state.files = [];
  }
  renderFileList();
  updateConvertButtonState();
}

// ---------------------------------------------------------------------------
// File list rendering
// ---------------------------------------------------------------------------

function statusText(file) {
  const formatsLabel = `ARW \u2192 ${state.formats.map((f) => f.toUpperCase()).join(', ')}`;
  switch (file.status) {
    case 'working': return { text: 'Converting…', cls: 'busy' };
    case 'done': return { text: 'Done', cls: 'ok' };
    case 'error': return { text: file.error || 'Failed', cls: 'err' };
    default: return { text: formatsLabel, cls: '' };
  }
}

function renderFileList() {
  el.fileCount.textContent = String(state.files.length);

  if (state.files.length === 0) {
    el.fileList.innerHTML = `<div class="empty-state">Select .ARW files in your Eagle library.</div>`;
    return;
  }

  el.fileList.innerHTML = '';
  for (const file of state.files) {
    const row = document.createElement('div');
    row.className = 'file-row';

    const thumbStyle = file.thumbnailURL ? ` style="background-image:url('${file.thumbnailURL.replace(/'/g, "\\'")}')"` : '';
    const dims = file.width && file.height ? `${file.width}\u00d7${file.height}` : '';
    const st = statusText(file);

    row.innerHTML = `
      <div class="file-thumb"${thumbStyle}>${file.thumbnailURL ? '' : 'RAW'}</div>
      <div class="file-info">
        <div class="file-name" title="${file.filePath}">${file.name}</div>
        <div class="file-sub ${st.cls}">${st.text}</div>
      </div>
      <div class="file-meta">${dims}</div>
    `;
    el.fileList.appendChild(row);
  }
}

function updateConvertButtonState() {
  el.btnConvert.disabled = state.converting || !state.ffmpegPaths || state.files.length === 0;
}

function setConverting(value) {
  state.converting = value;
  el.btnConvert.textContent = value ? 'Converting…' : 'Convert';
  updateConvertButtonState();
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

function runProcess(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(cmd, args, { windowsHide: true, ...opts });
    } catch (err) {
      reject(err);
      return;
    }
    let stderr = '';
    if (proc.stderr) proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => {
      reject(new Error(err.code === 'ENOENT' ? `${cmd} was not found on this system` : err.message));
    });
    proc.on('close', (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`${cmd} exited with code ${code}${stderr ? `: ${stderr.trim().slice(-400)}` : ''}`));
    });
  });
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function tempFilePath(ext) {
  return path.join(os.tmpdir(), `eagle-arw-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
}

function cleanupIntermediate(intermediate) {
  if (!intermediate || !intermediate.cleanup) return;
  try { fs.rmSync(intermediate.cleanup, { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------------------
// RAW decoding (tiered)
// ---------------------------------------------------------------------------

async function decodeWithLibRaw(file) {
  const mod = await import('../node_modules/libraw-wasm/dist/index.js');
  const LibRaw = mod.default;
  const raw = new LibRaw();
  try {
    const buf = await fsp.readFile(file.filePath);
    await raw.open(new Uint8Array(buf), {
      useCameraWb: true,
      noAutoBright: false,
      outputBps: 8,
      outputColor: 1,
    });
    const img = await raw.imageData();
    if (!img || !img.data || !img.width || !img.height) {
      throw new Error('LibRaw returned no image data (unsupported RAW variant)');
    }
    const bits = img.bits || 8;
    const pixfmt = bits === 16 ? 'rgb48le' : 'rgb24';
    const data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
    return { kind: 'raw', data, width: img.width, height: img.height, pixfmt, cleanup: null };
  } finally {
    try { raw.dispose(); } catch {}
  }
}

async function decodeWithSips(file) {
  if (process.platform !== 'darwin') throw new Error('sips is only available on macOS');
  const outPath = tempFilePath('tiff');
  await runProcess('sips', ['-s', 'format', 'tiff', file.filePath, '--out', outPath]);
  if (!fs.existsSync(outPath)) throw new Error('sips produced no output file');
  return { kind: 'file', filePath: outPath, cleanup: outPath };
}

async function decodeWithDcraw(file) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-arw-'));
  const tmpInput = path.join(tmpDir, path.basename(file.filePath));
  fs.copyFileSync(file.filePath, tmpInput);
  await runProcess('dcraw', ['-T', '-w', tmpInput]);
  const outPath = tmpInput.replace(/\.[^.]+$/, '.tiff');
  if (!fs.existsSync(outPath)) throw new Error('dcraw produced no output file');
  return { kind: 'file', filePath: outPath, cleanup: tmpDir };
}

async function decodeWithImageMagick(file) {
  const outPath = tempFilePath('tiff');
  for (const bin of ['magick', 'convert']) {
    try {
      await runProcess(bin, [file.filePath, outPath]);
      if (fs.existsSync(outPath)) return { kind: 'file', filePath: outPath, cleanup: outPath };
    } catch {}
  }
  throw new Error('ImageMagick produced no output file');
}

async function decodeToIntermediate(file) {
  const errors = [];

  try {
    return await withTimeout(decodeWithLibRaw(file), 25000, 'timed out (RAW variant may be unsupported by the bundled WASM decoder)');
  } catch (err) { errors.push(`LibRaw: ${err.message}`); }

  if (process.platform === 'darwin') {
    try { return await decodeWithSips(file); } catch (err) { errors.push(`sips: ${err.message}`); }
  }

  try { return await decodeWithDcraw(file); } catch (err) { errors.push(`dcraw: ${err.message}`); }

  try { return await decodeWithImageMagick(file); } catch (err) { errors.push(`ImageMagick: ${err.message}`); }

  throw new Error(errors[0] || 'No RAW decoder succeeded');
}

// ---------------------------------------------------------------------------
// FFmpeg encoding
// ---------------------------------------------------------------------------

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
function jpegQFromQuality(q) { return clamp(Math.round(31 - (clamp(q, 1, 100) / 100) * 29), 2, 31); }
function avifCrfFromQuality(q) { return clamp(Math.round(63 - (clamp(q, 1, 100) / 100) * 63), 0, 63); }

function buildFfmpegArgs(intermediate, format, settings, outputPath) {
  const args = ['-y'];

  if (intermediate.kind === 'raw') {
    args.push('-f', 'rawvideo', '-pixel_format', intermediate.pixfmt, '-video_size', `${intermediate.width}x${intermediate.height}`, '-i', 'pipe:0');
  } else {
    args.push('-i', intermediate.filePath);
  }

  if (settings.size === 'custom' && settings.sizeValue > 0) {
    args.push('-vf', `scale=w='min(iw,${settings.sizeValue})':h='min(ih,${settings.sizeValue})':force_original_aspect_ratio=decrease`);
  }

  args.push('-frames:v', '1');

  switch (format) {
    case 'jpg':
    case 'jpeg':
      args.push('-q:v', String(jpegQFromQuality(settings.quality)));
      break;
    case 'webp':
      args.push('-quality', String(clamp(settings.quality, 1, 100)), '-lossless', '0');
      break;
    case 'avif':
      args.push('-c:v', 'libaom-av1', '-crf', String(avifCrfFromQuality(settings.quality)), '-b:v', '0', '-pix_fmt', 'yuv420p');
      break;
    default:
      break;
  }

  args.push(outputPath);
  return args;
}

function encodeWithFfmpeg(intermediate, format, settings, outputPath) {
  return new Promise((resolve, reject) => {
    const args = buildFfmpegArgs(intermediate, format, settings, outputPath);
    const proc = spawn(state.ffmpegPaths.ffmpeg, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => reject(new Error(`Failed to launch FFmpeg: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited with code ${code}: ${stderr.trim().slice(-400)}`));
    });
    if (intermediate.kind === 'raw') {
      proc.stdin.on('error', () => {});
      proc.stdin.write(intermediate.data);
      proc.stdin.end();
    }
  });
}

function buildOutputPath(sourcePath, format, outputDir) {
  const base = path.basename(sourcePath, path.extname(sourcePath));
  let candidate = path.join(outputDir, `${base}.${format}`);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(outputDir, `${base} (${i}).${format}`);
    i++;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Conversion orchestration
// ---------------------------------------------------------------------------

function gatherSettings() {
  return {
    formats: state.formats,
    quality: parseInt(el.qualityInput.value, 10) || 90,
    size: state.size,
    sizeValue: parseInt(el.sizeCustomInput.value, 10) || 0,
    saveTo: state.saveTo,
    customFolder: state.customFolder,
    addToEagle: el.addToEagle.checked,
  };
}

async function convertAll() {
  if (state.converting) return;
  const settings = gatherSettings();

  if (!state.ffmpegPaths) return;
  if (state.files.length === 0) return;
  if (settings.saveTo === 'custom' && !settings.customFolder) return;

  setConverting(true);

  let successCount = 0;
  let failCount = 0;

  for (const file of state.files) {
    file.status = 'working';
    file.error = null;
    renderFileList();

    let intermediate;
    try {
      intermediate = await decodeToIntermediate(file);
    } catch (err) {
      file.status = 'error';
      file.error = 'Decode failed';
      renderFileList();
      failCount++;
      continue;
    }

    const outputDir = settings.saveTo === 'source' ? path.dirname(file.filePath) : settings.customFolder;
    try { fs.mkdirSync(outputDir, { recursive: true }); } catch {}

    const producedPaths = [];
    for (const format of settings.formats) {
      const outPath = buildOutputPath(file.filePath, format, outputDir);
      try {
        await encodeWithFfmpeg(intermediate, format, settings, outPath);
        producedPaths.push(outPath);
      } catch {}
    }

    cleanupIntermediate(intermediate);

    if (settings.addToEagle && producedPaths.length) {
      for (const p of producedPaths) {
        try {
          await eagle.item.addFromPath(p, {
            name: path.basename(p, path.extname(p)),
            tags: file.tags || [],
            folders: file.folders || [],
            annotation: `Converted from ${file.name}`,
          });
        } catch {}
      }
    }

    if (producedPaths.length) {
      file.status = 'done';
      successCount++;
    } else {
      file.status = 'error';
      file.error = 'All formats failed';
      failCount++;
    }
    renderFileList();
  }

  setConverting(false);

  try {
    await eagle.notification.show({
      title: 'RAW to Image Converter',
      body: `${successCount} file(s) converted${failCount ? `, ${failCount} failed` : ''}.`,
      duration: 4000,
    });
  } catch {}
}

// ---------------------------------------------------------------------------
// Eagle lifecycle
// ---------------------------------------------------------------------------

eagle.onPluginCreate(async () => {
  try { applyTheme(await eagle.app.theme); } catch {}
  updateQualityRowVisibility();
  await initFfmpeg();
  await refreshFromSelection();
});

eagle.onPluginRun(async () => {
  await refreshFromSelection();
});

eagle.onPluginShow(async () => {
  await refreshFromSelection();
});

eagle.onThemeChanged((theme) => applyTheme(theme));

renderFileList();
