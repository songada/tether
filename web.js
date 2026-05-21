const express = require('express');
const path = require('path');
const fs = require('fs');

const PORT = process.env.WEB_PORT ? Number(process.env.WEB_PORT) : 3000;
const ROOT = path.resolve(process.env.FTP_ROOT || './ftp-root');
const GALLERIES_ROOT = path.resolve(process.env.GALLERIES_ROOT || './galleries');
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif', '.svg', '.hif', '.heic', '.heif']);

fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(GALLERIES_ROOT, { recursive: true });

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
  const cutoff = Date.now() - STABLE_AGE_MS;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && IMAGE_EXTS.has(path.extname(entry.name).toLowerCase())) {
        const { mtimeMs, size } = fs.statSync(full);
        if (mtimeMs > cutoff) continue;
        out.push({ name: path.relative(rootDir, full), mtime: Math.floor(mtimeMs), size });
      }
    }
  };
  walk(rootDir);
  out.sort((a, b) => a.mtime - b.mtime);
  return out;
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
  res.json({ source: source.id, images: listImages(source.root) });
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

app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Pictures</title>
  <style>
    html, body { margin: 0; height: 100%; background: #000; color: #ddd; font: 14px/1.4 system-ui, sans-serif; user-select: none; }
    #wrap { position: fixed; inset: 0; display: grid; place-items: center; }
    #img { max-width: 100%; max-height: 100%; object-fit: contain; transition: transform .2s; }
    #img.rot90 { transform: rotate(90deg); max-width: 100vh; max-height: 100vw; }
    #source { position: fixed; left: 12px; top: 12px; padding: 6px 10px; background: rgba(0,0,0,.5); border-radius: 6px; z-index: 10; font-weight: 600; }
    #meta { position: fixed; left: 12px; bottom: 12px; padding: 6px 10px; background: rgba(0,0,0,.5); border-radius: 6px; z-index: 10; }
    #counter { position: fixed; right: 12px; top: 12px; padding: 6px 10px; background: rgba(0,0,0,.5); border-radius: 6px; font-variant-numeric: tabular-nums; z-index: 10; }
    #rotate { position: fixed; right: 12px; bottom: 12px; padding: 6px 12px; background: rgba(0,0,0,.5); border: none; border-radius: 6px; color: #ddd; font: inherit; cursor: pointer; z-index: 10; }
    #rotate:hover { background: rgba(0,0,0,.75); }
    #empty { opacity: .6; }
    .nav { position: fixed; top: 0; bottom: 0; width: 18%; display: grid; place-items: center; cursor: pointer; opacity: 0; transition: opacity .15s; font-size: 48px; color: #fff; background: linear-gradient(to right, rgba(0,0,0,.4), transparent); z-index: 5; }
    .nav.right { right: 0; background: linear-gradient(to left, rgba(0,0,0,.4), transparent); }
    .nav:hover { opacity: 1; }
    .nav[hidden] { display: none; }
  </style>
</head>
<body>
  <div id="wrap">
    <img id="img" alt="" hidden>
    <div id="empty" hidden>No images yet.</div>
  </div>
  <div id="prev" class="nav left" title="Previous (←)">←</div>
  <div id="next" class="nav right" title="Next (→)">→</div>
  <div id="source"></div>
  <div id="counter"></div>
  <div id="meta"></div>
  <button id="rotate" title="Rotate (Shift)">↻ rotate</button>
  <script>
    const img = document.getElementById('img');
    const empty = document.getElementById('empty');
    const meta = document.getElementById('meta');
    const counter = document.getElementById('counter');
    const sourceLabel = document.getElementById('source');
    const prevBtn = document.getElementById('prev');
    const nextBtn = document.getElementById('next');

    let sources = [{ id: 'uploaded', label: 'Uploaded' }];
    let sourceIdx = 0;
    let images = [];
    let index = -1;
    let followLatest = true;

    function curSource() { return sources[sourceIdx]; }

    function render() {
      sourceLabel.textContent = curSource().label;
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
      meta.textContent = cur.name + '  -  ' + new Date(cur.mtime).toLocaleString();
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

    async function refresh() {
      try {
        const r = await fetch('/list.json?source=' + encodeURIComponent(curSource().id), { cache: 'no-store' });
        const { images: list } = await r.json();
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

    function switchSource() {
      sourceIdx = (sourceIdx + 1) % sources.length;
      images = []; index = -1; followLatest = true;
      render();
      refresh();
    }

    const rotateBtn = document.getElementById('rotate');
    function toggleRotate() { img.classList.toggle('rot90'); }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { go(-1); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { go(1); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { switchSource(); e.preventDefault(); }
      else if (e.key === 'Home') { index = 0; followLatest = false; render(); }
      else if (e.key === 'End') { followLatest = true; index = images.length - 1; render(); }
      else if (e.key === 'Shift' && !e.repeat) { toggleRotate(); }
    });
    prevBtn.addEventListener('click', () => go(-1));
    nextBtn.addEventListener('click', () => go(1));
    rotateBtn.addEventListener('click', toggleRotate);

    img.addEventListener('error', () => {
      if (img.dataset.retried) return;
      img.dataset.retried = '1';
      setTimeout(() => { img.src = img.dataset.url + '&r=1'; }, 600);
    });

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
