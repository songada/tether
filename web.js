const express = require('express');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

const PORT = process.env.WEB_PORT ? Number(process.env.WEB_PORT) : 3000;
const ROOT = path.resolve(process.env.FTP_ROOT || './ftp-root');
const GALLERIES_ROOT = path.resolve(process.env.GALLERIES_ROOT || './galleries');
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif', '.svg', '.hif', '.heic', '.heif']);

fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(GALLERIES_ROOT, { recursive: true });

const STALE_AGE_MS = 2 * 60 * 60 * 1000;

function latestMtime(dir) {
  let latest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const mtime = entry.isDirectory() ? latestMtime(full) : fs.statSync(full).mtimeMs;
    if (mtime > latest) latest = mtime;
  }
  return latest;
}

const top = fs.readdirSync(ROOT);
if (top.length === 0) {
  console.log(`Upload folder is empty: ${ROOT}`);
} else {
  const newest = latestMtime(ROOT);
  const ageMs = Date.now() - newest;
  if (ageMs > STALE_AGE_MS) {
    for (const name of top) fs.rmSync(path.join(ROOT, name), { recursive: true, force: true });
    console.log(`Cleared ${top.length} item(s) from upload folder (last upload was ${Math.round(ageMs/60000)} min ago)`);
  } else {
    console.log(`Kept ${top.length} item(s) in upload folder (last upload was ${Math.round(ageMs/60000)} min ago, under 2h threshold)`);
  }
}

const STABLE_AGE_MS = 1000;
const UPLOADED_ID = 'uploaded';

function listSources() {
  const galleries = fs.readdirSync(GALLERIES_ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => ({ id: e.name, label: e.name, root: path.join(GALLERIES_ROOT, e.name) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [{ id: UPLOADED_ID, label: 'Uploaded', root: ROOT }, ...galleries];
}

function findSource(id) {
  return listSources().find(s => s.id === (id || UPLOADED_ID));
}

function listImages(rootDir) {
  const out = [];
  let uploading = 0;
  const cutoff = Date.now() - STABLE_AGE_MS;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!IMAGE_EXTS.has(ext)) continue;
        const { mtimeMs, size } = fs.statSync(full);
        if (mtimeMs > cutoff) { uploading++; continue; }
        out.push({ name: path.relative(rootDir, full), mtime: Math.floor(mtimeMs), size });
      }
    }
  };
  walk(rootDir);
  out.sort((a, b) => a.mtime - b.mtime);
  return { images: out, uploading };
}

function resolveSafe(rootDir, name) {
  const full = path.resolve(rootDir, name);
  if (full !== rootDir && !full.startsWith(rootDir + path.sep)) return null;
  return full;
}

const app = express();

app.get('/sources.json', (_req, res) => {
  res.json({ sources: listSources().map(({ id, label }) => ({ id, label })) });
});

app.get('/list.json', (req, res) => {
  const source = findSource(req.query.source);
  if (!source) return res.status(404).json({ error: 'unknown source' });
  const { images, uploading } = listImages(source.root);
  res.json({ source: source.id, images, uploading });
});

app.get('/image', (req, res) => {
  const source = findSource(req.query.source);
  if (!source) return res.status(404).send('unknown source');
  const name = String(req.query.name || '');
  if (!name) return res.status(400).send('missing name');
  const full = resolveSafe(source.root, name);
  if (!full || !fs.existsSync(full)) return res.status(404).send('not found');
  res.sendFile(full, { headers: { 'Cache-Control': 'no-store' }, etag: false, lastModified: false });
});

app.post('/shutdown', (_req, res) => {
  console.log('[shutdown] requested via web');
  res.json({ ok: true });
  setTimeout(() => {
    exec('sudo shutdown now', (err, stdout, stderr) => {
      if (err) console.error('[shutdown] failed:', err.message, stderr);
    });
  }, 100);
});

app.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Pictures</title>
  <style>
    html, body { margin: 0; height: 100%; background: #000; color: #ddd; font: 14px/1.4 system-ui, sans-serif; user-select: none; overflow: hidden; }
    #wrap { position: fixed; inset: 0; }
    #img { position: absolute; top: 50%; left: 50%; width: 100vw; height: 100vh; object-fit: contain; transform: translate(-50%, -50%); transition: transform .2s; }
    #img.rot90 { width: 100vh; height: 100vw; transform: translate(-50%, -50%) rotate(270deg); }
    #meta { position: fixed; left: 12px; bottom: 12px; padding: 6px 10px; background: rgba(0,0,0,.5); border-radius: 6px; z-index: 10; }
    #counter { position: fixed; right: 12px; bottom: 12px; padding: 6px 10px; background: rgba(0,0,0,.5); border-radius: 6px; font-variant-numeric: tabular-nums; z-index: 10; }
    #rotate { position: fixed; right: 12px; bottom: 48px; padding: 6px 12px; background: rgba(0,0,0,.5); border: none; border-radius: 6px; color: #ddd; font: inherit; cursor: pointer; z-index: 10; }
    #rotate:hover { background: rgba(0,0,0,.75); }
    #empty { opacity: .6; }
    .nav { position: fixed; top: 0; bottom: 0; width: 18%; display: grid; place-items: center; cursor: pointer; opacity: 0; transition: opacity .15s; font-size: 48px; color: #fff; background: linear-gradient(to right, rgba(0,0,0,.4), transparent); z-index: 5; }
    .nav.right { right: 0; background: linear-gradient(to left, rgba(0,0,0,.4), transparent); }
    .nav:hover { opacity: 1; }
    .nav[hidden] { display: none; }
    #keylog { position: fixed; left: 50%; bottom: 12px; transform: translateX(-50%); padding: 6px 12px; background: rgba(0,0,0,.6); border-radius: 6px; font-family: ui-monospace, monospace; pointer-events: none; z-index: 10; }
    #uploading { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); padding: 28px 36px; background: rgba(0,0,0,.7); border-radius: 14px; z-index: 20; display: none; flex-direction: column; align-items: center; gap: 18px; }
    #uploading.show { display: flex; }
    #uploading .spinner { width: 96px; height: 96px; border: 8px solid rgba(255,255,255,.2); border-top-color: #fff; border-radius: 50%; animation: spin .9s linear infinite; }
    #uploadingText { font-size: 18px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    #grid { position: fixed; inset: 0; display: grid; gap: 4px; padding: 4px; box-sizing: border-box; background: #000; }
    #grid[hidden] { display: none; }
    #dir[hidden] { display: none; }
    #grid.s3 { grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(3, 1fr); }
    #grid.s5 { grid-template-columns: repeat(5, 1fr); grid-template-rows: repeat(5, 1fr); }
    #grid.s7 { grid-template-columns: repeat(7, 1fr); grid-template-rows: repeat(7, 1fr); }
    #grid > img { width: 100%; height: 100%; min-width: 0; min-height: 0; object-fit: contain; background: #111; display: block; }
    #dir { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; gap: 16px; padding: 32px; flex-wrap: wrap; }
    #dir .item { padding: 20px 28px; font-size: 22px; border: 2px solid #333; border-radius: 12px; color: #ddd; min-width: 140px; text-align: center; }
    #dir .item.active { border-color: #fff; background: #2a2a2a; transform: scale(1.06); }
    #dir .item.shutdown { color: #f99; border-color: #844; }
    #dir .item.shutdown.active { background: #4a1a1a; border-color: #f44; }
    #confirm { position: fixed; inset: 0; background: rgba(0,0,0,.85); display: grid; place-items: center; z-index: 100; }
    #confirm[hidden] { display: none; }
    #confirm .box { background: #222; color: #fff; padding: 28px 36px; border-radius: 12px; text-align: center; font-size: 20px; min-width: 280px; }
    #confirm .hint { margin-top: 14px; opacity: .6; font-size: 13px; }
  </style>
</head>
<body>
  <div id="wrap">
    <img id="img" alt="" hidden>
    <div id="empty" hidden>No images yet.</div>
  </div>
  <div id="prev" class="nav left" title="Previous (PageUp)">←</div>
  <div id="next" class="nav right" title="Next (PageDown)">→</div>
  <div id="counter"></div>
  <div id="meta"></div>
  <button id="rotate" title="Rotate (Tab)">↻ rotate</button>
  <div id="keylog"></div>
  <div id="uploading"><div class="spinner"></div><span id="uploadingText">uploading...</span></div>
  <div id="grid" hidden></div>
  <div id="dir" hidden></div>
  <div id="confirm" hidden><div class="box">Confirm shutdown<div class="hint">press <b>Tab</b> to confirm, <b>B</b> to cancel</div></div></div>
  <script>
    const img = document.getElementById('img');
    const empty = document.getElementById('empty');
    const meta = document.getElementById('meta');
    const counter = document.getElementById('counter');
    const prevBtn = document.getElementById('prev');
    const nextBtn = document.getElementById('next');

    function formatBytes(n) {
      if (!n && n !== 0) return '';
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
      return (n / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function updateMeta() {
      const cur = images[index];
      if (!cur) return;
      const parts = [
        cur.name,
        new Date(cur.mtime).toLocaleString(),
        formatBytes(cur.size),
      ];
      if (img.naturalWidth) parts.push(img.naturalWidth + '×' + img.naturalHeight + 'px');
      meta.textContent = parts.join('  ·  ');
    }

    let sources = [{ id: 'uploaded', label: 'Uploaded' }];
    let sourceIdx = 0;
    let images = [];
    let index = -1;
    let followLatest = true;

    function curSource() { return sources[sourceIdx]; }

    function render() {
      if (images.length === 0) {
        img.hidden = true; empty.hidden = false;
        counter.textContent = '0 / 0';
        meta.textContent = 'waiting...';
        prevBtn.hidden = nextBtn.hidden = true;
        return;
      }
      if (index < 0 || index >= images.length) index = images.length - 1;
      const cur = images[index];
      const url = '/image?source=' + encodeURIComponent(curSource().id) + '&name=' + encodeURIComponent(cur.name) + '&t=' + cur.mtime;
      if (img.dataset.url !== url) {
        img.dataset.url = url;
        img.dataset.retried = '';
        img.src = url;
      }
      img.hidden = false; empty.hidden = true;
      counter.textContent = (index + 1) + ' / ' + images.length;
      updateMeta();
      prevBtn.hidden = index === 0;
      nextBtn.hidden = index === images.length - 1;
    }

    function go(delta) {
      if (images.length === 0) return;
      const next = Math.min(images.length - 1, Math.max(0, index + delta));
      if (next === index) return;
      index = next;
      followLatest = (index === images.length - 1);
      render();
    }

    async function loadSources() {
      try {
        const r = await fetch('/sources.json', { cache: 'no-store' });
        const { sources: list } = await r.json();
        if (Array.isArray(list) && list.length) {
          const prevId = curSource()?.id;
          sources = list;
          const keep = sources.findIndex(s => s.id === prevId);
          sourceIdx = keep >= 0 ? keep : 0;
          if (mode === 'dir') renderDir();
        }
      } catch (e) { /* ignore */ }
    }

    const uploadingEl = document.getElementById('uploading');
    const uploadingText = document.getElementById('uploadingText');

    async function refresh() {
      try {
        const r = await fetch('/list.json?source=' + encodeURIComponent(curSource().id), { cache: 'no-store' });
        const { images: list, uploading = 0 } = await r.json();
        if (uploading > 0) {
          uploadingText.textContent = uploading > 1 ? 'uploading ' + uploading + ' files...' : 'uploading...';
          uploadingEl.classList.add('show');
        } else {
          uploadingEl.classList.remove('show');
        }
        const currentName = images[index]?.name;
        images = list;
        if (followLatest || !currentName) {
          index = images.length - 1;
        } else {
          const found = images.findIndex(i => i.name === currentName);
          index = found >= 0 ? found : images.length - 1;
        }
        if (mode === 'focus') render();
        else if (mode === 'grid') renderGrid();
      } catch (e) {
        meta.textContent = 'error: ' + e.message;
      }
    }

    const wrap = document.getElementById('wrap');
    const gridEl = document.getElementById('grid');
    const dirEl = document.getElementById('dir');
    const confirmEl = document.getElementById('confirm');
    const rotateBtn = document.getElementById('rotate');

    let mode = 'focus';
    const GRID_SIZES = [9, 25, 49];
    let gridLevel = 0;
    let gridPage = 0;
    let dirItems = [];
    let dirIdx = 0;
    let confirming = false;

    function applyModeVisibility() {
      wrap.hidden = mode !== 'focus';
      gridEl.hidden = mode !== 'grid';
      dirEl.hidden = mode !== 'dir';
      const showFocusChrome = mode === 'focus';
      meta.style.display = showFocusChrome ? '' : 'none';
      rotateBtn.style.display = showFocusChrome ? '' : 'none';
      prevBtn.style.display = showFocusChrome ? '' : 'none';
      nextBtn.style.display = showFocusChrome ? '' : 'none';
    }

    let gridSig = '';
    function renderGrid() {
      const size = GRID_SIZES[gridLevel];
      const side = Math.sqrt(size);
      const totalPages = Math.max(1, Math.ceil(images.length / size));
      if (gridPage >= totalPages) gridPage = totalPages - 1;
      if (gridPage < 0) gridPage = 0;
      const start = gridPage * size;
      const slice = images.slice(start, start + size);
      const sig = size + '|' + curSource().id + '|' + slice.map(im => im.name + ':' + im.mtime).join(',');
      counter.textContent = 'page ' + (gridPage + 1) + ' / ' + totalPages + '  ·  ' + size + ' per page';
      if (sig === gridSig) return;
      gridSig = sig;
      gridEl.className = 's' + side;
      gridEl.innerHTML = '';
      for (const im of slice) {
        const el = document.createElement('img');
        el.src = '/image?source=' + encodeURIComponent(curSource().id) + '&name=' + encodeURIComponent(im.name) + '&t=' + im.mtime;
        gridEl.appendChild(el);
      }
    }

    function renderDir() {
      dirItems = [
        ...sources.map(s => ({ id: s.id, label: s.label, type: 'source' })),
        { id: '__shutdown', label: 'Shutdown', type: 'shutdown' },
      ];
      if (dirIdx >= dirItems.length) dirIdx = 0;
      if (dirIdx < 0) dirIdx = dirItems.length - 1;
      dirEl.innerHTML = '';
      dirItems.forEach((item, i) => {
        const el = document.createElement('div');
        el.className = 'item' + (i === dirIdx ? ' active' : '') + (item.type === 'shutdown' ? ' shutdown' : '');
        el.textContent = item.label;
        dirEl.appendChild(el);
      });
      counter.textContent = (dirIdx + 1) + ' / ' + dirItems.length;
    }

    function setMode(m) {
      mode = m;
      applyModeVisibility();
      if (m === 'focus') render();
      else if (m === 'grid') renderGrid();
      else if (m === 'dir') renderDir();
    }

    function openConfirm() { confirming = true; confirmEl.hidden = false; }
    function closeConfirm() { confirming = false; confirmEl.hidden = true; }
    async function doShutdown() {
      closeConfirm();
      keylog.textContent = 'shutting down...';
      try { await fetch('/shutdown', { method: 'POST' }); } catch (e) { /* connection will drop */ }
    }

    async function selectDirItem() {
      const item = dirItems[dirIdx];
      if (!item) return;
      if (item.type === 'shutdown') { openConfirm(); return; }
      sourceIdx = sources.findIndex(s => s.id === item.id);
      if (sourceIdx < 0) sourceIdx = 0;
      images = []; index = -1; followLatest = true;
      setMode('focus');
      await refresh();
    }

    if (localStorage.getItem('rot90') === '1') img.classList.add('rot90');
    function toggleRotate() {
      img.classList.toggle('rot90');
      localStorage.setItem('rot90', img.classList.contains('rot90') ? '1' : '0');
    }

    const keylog = document.getElementById('keylog');
    const history = [];
    function pushLog(label) {
      history.push(label);
      if (history.length > 10) history.shift();
      keylog.textContent = history.join('  ');
    }
    pushLog('press any key or click');
    history.length = 0;
    function showKey(e) {
      pushLog(e.code || e.key);
    }
    const MOUSE_BUTTONS = ['MouseL', 'MouseM', 'MouseR', 'Mouse4', 'Mouse5'];
    function showMouse(e) {
      pushLog(MOUSE_BUTTONS[e.button] || ('Mouse' + e.button));
    }
    document.addEventListener('mousedown', showMouse);
    document.addEventListener('contextmenu', (e) => e.preventDefault());

    const LEFT_KEYS = new Set(['PageUp', 'ArrowLeft']);
    const RIGHT_KEYS = new Set(['PageDown', 'ArrowRight']);

    document.addEventListener('keydown', (e) => {
      const isEsc = e.code === 'Escape' || e.code === 'KeyP';
      const isB = (e.key === 'b' || e.key === 'B');
      const isTab = e.key === 'Tab';
      const isLeft = LEFT_KEYS.has(e.key);
      const isRight = RIGHT_KEYS.has(e.key);

      if (isEsc) { pushLog('Escape'); e.preventDefault(); e.stopPropagation(); }
      else if (e.code === 'MetaLeft') { showKey(e); e.preventDefault(); e.stopPropagation(); return; }
      else { showKey(e); }

      if (confirming) {
        if (isTab && !e.repeat) { doShutdown(); e.preventDefault(); }
        else if (isB && !e.repeat) { closeConfirm(); e.preventDefault(); }
        else { e.preventDefault(); }
        return;
      }

      if (mode === 'focus') {
        if (isLeft) { go(-1); e.preventDefault(); }
        else if (isRight) { go(1); e.preventDefault(); }
        else if (isTab && !e.repeat) { toggleRotate(); e.preventDefault(); }
        else if (isEsc && !e.repeat) {
          gridLevel = 0;
          gridPage = images.length > 0 ? Math.floor(Math.max(0, index) / GRID_SIZES[gridLevel]) : 0;
          setMode('grid');
        }
        else if (isB && !e.repeat) {
          dirIdx = Math.max(0, sources.findIndex(s => s.id === curSource().id));
          setMode('dir');
          e.preventDefault();
        }
      } else if (mode === 'grid') {
        if (isLeft) {
          if (gridPage > 0) { gridPage--; renderGrid(); }
          e.preventDefault();
        } else if (isRight) {
          const size = GRID_SIZES[gridLevel];
          const totalPages = Math.max(1, Math.ceil(images.length / size));
          if (gridPage < totalPages - 1) { gridPage++; renderGrid(); }
          e.preventDefault();
        } else if (isEsc && !e.repeat) {
          if (gridLevel < GRID_SIZES.length - 1) { gridLevel++; gridPage = 0; renderGrid(); }
        } else if (isB && !e.repeat) {
          if (gridLevel > 0) { gridLevel--; gridPage = 0; renderGrid(); }
          else {
            const size = GRID_SIZES[gridLevel];
            const lastOnPage = Math.min(images.length - 1, gridPage * size + size - 1);
            index = Math.max(0, lastOnPage);
            followLatest = (index === images.length - 1);
            setMode('focus');
          }
          e.preventDefault();
        }
      } else if (mode === 'dir') {
        if (isLeft) {
          dirIdx = (dirIdx - 1 + dirItems.length) % dirItems.length;
          renderDir();
          e.preventDefault();
        } else if (isRight) {
          dirIdx = (dirIdx + 1) % dirItems.length;
          renderDir();
          e.preventDefault();
        } else if (isTab && !e.repeat) {
          selectDirItem();
          e.preventDefault();
        }
      }
    });
    prevBtn.addEventListener('click', () => go(-1));
    nextBtn.addEventListener('click', () => go(1));
    document.getElementById('rotate').addEventListener('click', toggleRotate);

    img.addEventListener('error', () => {
      if (img.dataset.retried) return;
      img.dataset.retried = '1';
      setTimeout(() => { img.src = img.dataset.url + '&r=1'; }, 600);
    });
    img.addEventListener('load', updateMeta);

    (async () => {
      await loadSources();
      render();
      refresh();
      setInterval(refresh, 1000);
      setInterval(loadSources, 5000);
    })();
  </script>
</body>
</html>`);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Web viewer on http://localhost:${PORT}`);
  console.log(`Uploaded: ${ROOT}`);
  console.log(`Galleries: ${GALLERIES_ROOT}`);
});
