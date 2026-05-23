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
    #confirm { position: fixed; inset: 0; background: rgba(0,0,0,.75); display: none; place-items: center; z-index: 100; }
    #confirm.show { display: grid; }
    #confirm .box { background: #222; color: #fff; padding: 28px 36px; border-radius: 10px; text-align: center; font-size: 18px; min-width: 280px; }
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
  <div id="keylog"></div>
  <div id="uploading"><div class="spinner"></div><span id="uploadingText">uploading...</span></div>
  <div id="confirm"><div class="box">Confirm to shutdown<div class="hint">press <b>Esc</b> again to shutdown, <b>B</b> to cancel</div></div></div>
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
        render();
      } catch (e) {
        meta.textContent = 'error: ' + e.message;
      }
    }

    async function switchSource() {
      await loadSources();
      sourceIdx = (sourceIdx + 1) % sources.length;
      images = []; index = -1; followLatest = true;
      render();
      refresh();
    }

    function toggleRotate() { img.classList.toggle('rot90'); }

    const keylog = document.getElementById('keylog');
    keylog.textContent = 'press any key';
    function showKey(e) {
      keylog.textContent = 'key: ' + e.key + '  code: ' + e.code + '  keyCode: ' + e.keyCode;
    }

    const confirmEl = document.getElementById('confirm');
    let confirming = false;
    function openConfirm() { confirming = true; confirmEl.classList.add('show'); }
    function closeConfirm() { confirming = false; confirmEl.classList.remove('show'); }
    async function doShutdown() {
      closeConfirm();
      keylog.textContent = 'shutting down...';
      try { await fetch('/shutdown', { method: 'POST' }); }
      catch (e) { /* connection will likely drop */ }
    }

    document.addEventListener('keydown', (e) => {
      showKey(e);
      if (confirming) {
        if (e.key === 'Escape') { doShutdown(); e.preventDefault(); }
        else if (e.key === 'b' || e.key === 'B') { closeConfirm(); e.preventDefault(); }
        else { e.preventDefault(); }
        return;
      }
      if (e.key === 'PageUp') { go(-1); e.preventDefault(); }
      else if (e.key === 'PageDown') { go(1); e.preventDefault(); }
      else if ((e.key === 'b' || e.key === 'B') && !e.repeat) { switchSource(); e.preventDefault(); }
      else if (e.key === 'Tab' && !e.repeat) { toggleRotate(); e.preventDefault(); }
      else if (e.key === 'Home') { index = 0; followLatest = false; render(); }
      else if (e.key === 'End') { followLatest = true; index = images.length - 1; render(); }
      else if (e.key === 'Escape' && !e.repeat) { openConfirm(); e.preventDefault(); }
    });
    prevBtn.addEventListener('click', () => go(-1));
    nextBtn.addEventListener('click', () => go(1));

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
