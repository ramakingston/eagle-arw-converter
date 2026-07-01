/* RAW to Image Converter — Eagle plugin
 *
 * Pipeline: decode .ARW (Sony RAW) -> RGB pixel data, then encode to the
 * requested output formats with FFmpeg (Eagle's bundled FFmpeg dependency).
 *
 * FFmpeg cannot decode camera RAW formats on its own, so decoding is handled
 * by a tiered set of decoders, tried in order until one succeeds:
 *   1. LibRaw compiled to WebAssembly (bundled via the `libraw-wasm` npm
 *      package) — works fully in-process, no extra installs required.
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
  files: [],           // { filePath, name, size, thumbnailURL, tags, folders, include, status, error }
  converting: false,
  customFolder: null,
  ffmpegPaths: null,
};

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);

const el = {
  engineStatus: $('#engineStatus'),
  fileList: $('#fileList'),
  fileCount: $('#fileCount'),
  log: $('#log'),
  qualitySlider: $('#qualitySlider'),
  qualityValue: $('#qualityValue'),
  resizeEnabled: $('#resizeEnabled'),
  resizeValue: $('#resizeValue'),
  useCameraWb: $('#useCameraWb'),
  autoBrightness: $('#autoBrightness'),
  highBitDepth: $('#highBitDepth'),
  btnChooseFolder: $('#btnChooseFolder'),
  customFolderPath: $('#customFolderPath'),
  addToEagle: $('#addToEagle'),
  btnConvert: $('#btnConvert'),
  btnAddFiles: $('#btnAddFiles'),
  btnUseSelection: $('#btnUseSelection'),
  btnSelectAll: $('#btnSelectAll'),
  btnClear: $('#btnClear'),
  btnClearLog: $('#btnClearLog'),
};

function logLine(message, level = 'info') {
  const time = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  line.className = `log-line ${level}`;
  line.textContent = `[${time}] ${message}`;
  el.log.appendChild(line);
  el.log.scrollTop = el.log.scrollHeight;
}

function setEngineStatus(text, status) {
  el.engineStatus.textContent = text;
  el.engineStatus.classList.remove('ok', 'err');
  if (status === 'ok') el.engineStatus.classList.add('ok');
  if (status === 'err') el.engineStatus.classList.add('err');
}

// ---------------------------------------------------------------------------
// File list management
// ---------------------------------------------------------------------------

function isArwPath(p) {
  return path.extname(p).toLowerCase() === '.arw';
}

function addFilesFromPaths(paths) {
  let added = 0;
  let skipped = 0;
  for (const p of paths) {
    if (!isArwPath(p)) { skipped++; continue; }
    if (state.files.some((f) => f.filePath === p)) continue;
    let size = 0;
    try { size = fs.statSync(p).size; } catch {}
    state.files.push({
      filePath: p,
      name: path.basename(p),
      size,
      thumbnailURL: null,
      tags: [],
      folders: [],
      include: true,
      status: 'pending',
      error: null,
    });
    added++;
  }
  if (skipped) logLine(`Skipped ${skipped} file(s) that were not .ARW.`, 'warn');
  if (added) logLine(`Added ${added} file(s).`, 'info');
  renderFileList();
}

function addFilesFromItems(items) {
  let added = 0;
  let skipped = 0;
  for (const item of items) {
    if ((item.ext || '').toLowerCase() !== 'arw') { skipped++; continue; }
    if (state.files.some((f) => f.filePath === item.filePath)) continue;
    state.files.push({
      filePath: item.filePath,
      name: item.name ? `${item.name}.${item.ext}` : path.basename(item.filePath),
      size: item.size || 0,
      thumbnailURL: item.thumbnailURL || null,
      tags: item.tags || [],
      folders: item.folders || [],
      include: true,
      status: 'pending',
      error: null,
    });
    added++;
  }
  if (skipped) logLine(`Skipped ${skipped} selected item(s) that were not .ARW.`, 'warn');
  if (added) logLine(`Added ${added} file(s) from Eagle selection.`, 'info');
  else if (!skipped) logLine('No files found in Eagle selection.', 'warn');
  renderFileList();
}

function removeFile(filePath) {
  state.files = state.files.filter((f) => f.filePath !== filePath);
  renderFileList();
}

function formatBytes(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function statusLabel(file) {
  switch (file.status) {
    case 'working': return 'Converting…';
    case 'done': return 'Done';
    case 'error': return file.error ? `Error` : 'Error';
    default: return 'Pending';
  }
}

function renderFileList() {
  el.fileCount.textContent = `${state.files.length} file${state.files.length === 1 ? '' : 's'}`;

  if (state.files.length === 0) {
    el.fileList.innerHTML = `
      <div class="empty-state">
        <p>No .ARW files yet.</p>
        <p class="muted">Select Sony RAW files in Eagle and click <strong>Use Eagle Selection</strong>, or click <strong>Add ARW Files&hellip;</strong> above.</p>
      </div>`;
    updateConvertButtonState();
    return;
  }

  el.fileList.innerHTML = '';
  for (const file of state.files) {
    const row = document.createElement('div');
    row.className = `file-row status-${file.status}`;
    row.dataset.path = file.filePath;

    const thumbStyle = file.thumbnailURL ? ` style="background-image:url('${file.thumbnailURL.replace(/'/g, "\\'")}')"` : '';

    row.innerHTML = `
      <input type="checkbox" class="file-include" ${file.include ? 'checked' : ''} title="Include in conversion">
      <div class="file-thumb"${thumbStyle}>${file.thumbnailURL ? '' : 'RAW'}</div>
      <div class="file-info">
        <div class="file-name" title="${file.filePath}">${file.name}</div>
        <div class="file-meta">${formatBytes(file.size)}${file.error ? ` &middot; ${file.error}` : ''}</div>
      </div>
      <div class="file-status ${file.status === 'done' ? 'ok' : file.status === 'error' ? 'err' : file.status === 'working' ? 'busy' : ''}">${statusLabel(file)}</div>
      <button class="file-remove" title="Remove">&times;</button>
    `;
    el.fileList.appendChild(row);
  }
  updateConvertButtonState();
}

el.fileList.addEventListener('click', (e) => {
  const row = e.target.closest('.file-row');
  if (!row) return;
  const filePath = row.dataset.path;
  if (e.target.classList.contains('file-remove')) {
    removeFile(filePath);
  }
});

el.fileList.addEventListener('change', (e) => {
  if (!e.target.classList.contains('file-include')) return;
  const row = e.target.closest('.file-row');
  const file = state.files.find((f) => f.filePath === row.dataset.path);
  if (file) file.include = e.target.checked;
});

// ---------------------------------------------------------------------------
// Settings / UI wiring
// ---------------------------------------------------------------------------

el.qualitySlider.addEventListener('input', () => {
  el.qualityValue.textContent = el.qualitySlider.value;
});

el.resizeEnabled.addEventListener('change', () => {
  el.resizeValue.disabled = !el.resizeEnabled.checked;
});

document.querySelectorAll('input[name="outputMode"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    const isCustom = document.querySelector('input[name="outputMode"]:checked').value === 'custom';
    el.btnChooseFolder.disabled = !isCustom;
  });
});

el.btnChooseFolder.addEventListener('click', async () => {
  try {
    const result = await eagle.dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    if (!result.canceled && result.filePaths && result.filePaths[0]) {
      state.customFolder = result.filePaths[0];
      el.customFolderPath.textContent = state.customFolder;
    }
  } catch (err) {
    logLine(`Could not open folder dialog: ${err.message}`, 'err');
  }
});

el.btnAddFiles.addEventListener('click', async () => {
  try {
    const result = await eagle.dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Sony RAW (ARW)', extensions: ['arw', 'ARW'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (!result.canceled) addFilesFromPaths(result.filePaths);
  } catch (err) {
    logLine(`Could not open file dialog: ${err.message}`, 'err');
  }
});

el.btnUseSelection.addEventListener('click', async () => {
  try {
    const items = await eagle.item.getSelected();
    addFilesFromItems(items);
  } catch (err) {
    logLine(`Could not read Eagle selection: ${err.message}`, 'err');
  }
});

el.btnSelectAll.addEventListener('click', () => {
  state.files.forEach((f) => (f.include = true));
  renderFileList();
});

el.btnClear.addEventListener('click', () => {
  state.files = [];
  renderFileList();
});

el.btnClearLog.addEventListener('click', () => {
  el.log.innerHTML = '';
});

el.btnConvert.addEventListener('click', () => {
  convertAll();
});

function updateConvertButtonState() {
  const includedCount = state.files.filter((f) => f.include).length;
  el.btnConvert.disabled = state.converting || !state.ffmpegPaths || includedCount === 0;
}

function setConverting(value) {
  state.converting = value;
  el.btnConvert.textContent = value ? 'Converting…' : 'Convert';
  updateConvertButtonState();
}

// ---------------------------------------------------------------------------
// FFmpeg dependency
// ---------------------------------------------------------------------------

async function initFfmpeg() {
  try {
    if (!eagle.extraModule || !eagle.extraModule.ffmpeg) {
      setEngineStatus('This Eagle version does not support the FFmpeg dependency. Please update Eagle.', 'err');
      return;
    }
    const installed = await eagle.extraModule.ffmpeg.isInstalled();
    if (!installed) {
      setEngineStatus('FFmpeg dependency not installed — click here to install', 'err');
      el.engineStatus.style.cursor = 'pointer';
      el.engineStatus.onclick = async () => {
        setEngineStatus('Opening FFmpeg installer…', null);
        try { await eagle.extraModule.ffmpeg.install(); } catch (err) { logLine(`Install failed: ${err.message}`, 'err'); }
        setTimeout(initFfmpeg, 2000);
      };
      return;
    }
    state.ffmpegPaths = await eagle.extraModule.ffmpeg.getPaths();
    setEngineStatus('FFmpeg ready', 'ok');
    el.engineStatus.onclick = null;
    el.engineStatus.style.cursor = 'default';
  } catch (err) {
    setEngineStatus(`FFmpeg check failed: ${err.message}`, 'err');
  }
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
  try {
    fs.rmSync(intermediate.cleanup, { recursive: true, force: true });
  } catch {}
}

// ---------------------------------------------------------------------------
// RAW decoding (tiered)
// ---------------------------------------------------------------------------

async function decodeWithLibRaw(file, settings) {
  const mod = await import('../node_modules/libraw-wasm/dist/index.js');
  const LibRaw = mod.default;
  const raw = new LibRaw();
  try {
    const buf = await fsp.readFile(file.filePath);
    await raw.open(new Uint8Array(buf), {
      useCameraWb: settings.useCameraWb,
      useAutoWb: !settings.useCameraWb,
      noAutoBright: !settings.autoBrightness,
      outputBps: settings.highBitDepth ? 16 : 8,
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
  const binaries = ['magick', 'convert'];
  let lastErr;
  for (const bin of binaries) {
    try {
      await runProcess(bin, [file.filePath, outPath]);
      if (fs.existsSync(outPath)) return { kind: 'file', filePath: outPath, cleanup: outPath };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('ImageMagick produced no output file');
}

async function decodeToIntermediate(file, settings) {
  const errors = [];

  try {
    return await withTimeout(decodeWithLibRaw(file, settings), 25000, 'timed out (RAW variant may be unsupported by the bundled WASM decoder)');
  } catch (err) { errors.push(`Built-in LibRaw decoder: ${err.message}`); }

  if (process.platform === 'darwin') {
    try {
      return await decodeWithSips(file);
    } catch (err) { errors.push(`macOS sips: ${err.message}`); }
  }

  try {
    return await decodeWithDcraw(file);
  } catch (err) { errors.push(`dcraw: ${err.message}`); }

  try {
    return await decodeWithImageMagick(file);
  } catch (err) { errors.push(`ImageMagick: ${err.message}`); }

  throw new Error(`No RAW decoder succeeded.\n  - ${errors.join('\n  - ')}`);
}

// ---------------------------------------------------------------------------
// FFmpeg encoding
// ---------------------------------------------------------------------------

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

function jpegQFromQuality(q) {
  return clamp(Math.round(31 - (clamp(q, 1, 100) / 100) * 29), 2, 31);
}

function avifCrfFromQuality(q) {
  return clamp(Math.round(63 - (clamp(q, 1, 100) / 100) * 63), 0, 63);
}

function buildFfmpegArgs(intermediate, format, settings, outputPath) {
  const args = ['-y'];

  if (intermediate.kind === 'raw') {
    args.push('-f', 'rawvideo', '-pixel_format', intermediate.pixfmt, '-video_size', `${intermediate.width}x${intermediate.height}`, '-i', 'pipe:0');
  } else {
    args.push('-i', intermediate.filePath);
  }

  if (settings.resizeEnabled && settings.resizeValue > 0) {
    const limit = settings.resizeValue;
    args.push('-vf', `scale=w='min(iw,${limit})':h='min(ih,${limit})':force_original_aspect_ratio=decrease`);
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
      break; // png / tiff / bmp / gif use lossless defaults
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
    formats: Array.from(document.querySelectorAll('#formatGrid input:checked')).map((elm) => elm.value),
    quality: parseInt(el.qualitySlider.value, 10),
    resizeEnabled: el.resizeEnabled.checked,
    resizeValue: parseInt(el.resizeValue.value, 10) || 0,
    useCameraWb: el.useCameraWb.checked,
    autoBrightness: el.autoBrightness.checked,
    highBitDepth: el.highBitDepth.checked,
    outputMode: document.querySelector('input[name="outputMode"]:checked').value,
    customFolder: state.customFolder,
    addToEagle: el.addToEagle.checked,
  };
}

async function convertAll() {
  if (state.converting) return;
  const settings = gatherSettings();

  if (!state.ffmpegPaths) { logLine('FFmpeg dependency is not ready yet.', 'err'); return; }
  if (settings.formats.length === 0) { logLine('Select at least one output format.', 'warn'); return; }
  if (settings.outputMode === 'custom' && !settings.customFolder) { logLine('Choose an output folder first.', 'warn'); return; }

  const targets = state.files.filter((f) => f.include);
  if (targets.length === 0) { logLine('No files selected to convert.', 'warn'); return; }

  setConverting(true);
  logLine(`Starting conversion of ${targets.length} file(s) to: ${settings.formats.join(', ').toUpperCase()}`);

  let successCount = 0;
  let failCount = 0;

  for (const file of targets) {
    file.status = 'working';
    file.error = null;
    renderFileList();
    logLine(`Decoding ${file.name}…`);

    let intermediate;
    try {
      intermediate = await decodeToIntermediate(file, settings);
    } catch (err) {
      file.status = 'error';
      file.error = 'Decode failed';
      renderFileList();
      logLine(`Failed to decode ${file.name}:\n${err.message}`, 'err');
      failCount++;
      continue;
    }

    const outputDir = settings.outputMode === 'source' ? path.dirname(file.filePath) : settings.customFolder;
    try { fs.mkdirSync(outputDir, { recursive: true }); } catch {}

    const producedPaths = [];
    for (const format of settings.formats) {
      const outPath = buildOutputPath(file.filePath, format, outputDir);
      try {
        await encodeWithFfmpeg(intermediate, format, settings, outPath);
        logLine(`Saved ${path.basename(outPath)}`, 'ok');
        producedPaths.push(outPath);
      } catch (err) {
        logLine(`Failed to encode ${file.name} → ${format.toUpperCase()}: ${err.message}`, 'err');
      }
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
        } catch (err) {
          logLine(`Could not add ${path.basename(p)} to Eagle: ${err.message}`, 'warn');
        }
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
  logLine(`Finished. ${successCount} succeeded, ${failCount} failed.`, failCount ? 'warn' : 'ok');

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
  logLine('Plugin ready.');
  await initFfmpeg();
  try {
    const items = await eagle.item.getSelected();
    const arwItems = items.filter((it) => (it.ext || '').toLowerCase() === 'arw');
    if (arwItems.length) addFilesFromItems(arwItems);
  } catch {}
  renderFileList();
});

eagle.onPluginRun(async () => {
  try {
    const items = await eagle.item.getSelected();
    const arwItems = items.filter((it) => (it.ext || '').toLowerCase() === 'arw');
    if (arwItems.length) addFilesFromItems(arwItems);
  } catch {}
});

renderFileList();
