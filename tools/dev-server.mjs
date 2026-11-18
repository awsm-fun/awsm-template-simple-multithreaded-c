#!/usr/bin/env node
// dev-server.mjs — a small static server for dist/, with live reload.
// Zero dependencies: plain Node (18+).
//
//   node tools/dev-server.mjs [--root dist] [--port 8000] [--host 127.0.0.1]
//                             [--reload swap|page] [--open]
//
// What it does beyond serving files:
//
//   * Sends the headers that make the page cross-origin isolated (needed for
//     SharedArrayBuffer, i.e. shared wasm memory) and turns off caching:
//       Cross-Origin-Opener-Policy: same-origin
//       Cross-Origin-Embedder-Policy: require-corp
//       Cache-Control: no-store
//
//   * Watches the build stamps in the root (each build task writes its
//     `<name>.stamp` LAST, so a stamp only changes once a build is complete)
//     and tells open pages over Server-Sent Events:
//       app.stamp            → "app": the page swaps the app worker in place
//                              (window.__awsm.swapApp), keeping the renderer
//       any other *.stamp    → "reload": a full page reload (renderer.stamp,
//                              dom.stamp, media.stamp)
//     With --reload=page every change is a full reload.
//
//   * Adds a tiny reload client to HTML pages as it serves them, so the page
//     sources contain no dev-only code.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { parseArgs } from 'node:util';

// ── Options ─────────────────────────────────────────────────────────────────

let options;
try {
  ({ values: options } = parseArgs({
    options: {
      root: { type: 'string', default: 'dist' },
      port: { type: 'string', default: '8000' },
      host: { type: 'string', default: '127.0.0.1' },
      reload: { type: 'string', default: 'swap' },
      open: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }));
} catch (err) {
  fail(`${err.message}\nTry --help.`);
}

if (options.help) {
  console.log(
    'usage: node tools/dev-server.mjs [--root dist] [--port 8000] [--host 127.0.0.1]\n' +
      '                                 [--reload swap|page] [--open]',
  );
  process.exit(0);
}

const root = path.resolve(options.root);
const port = Number(options.port);
const host = options.host;
const reloadMode = options.reload;

if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`--port: not a port number: ${options.port}`);
if (reloadMode !== 'swap' && reloadMode !== 'page') fail(`--reload must be "swap" or "page", not "${reloadMode}"`);
if (!isDirectory(root)) fail(`nothing to serve: ${root} is not a directory (build first, e.g. \`task build\`)`);

function fail(message) {
  console.error(`dev-server: ${message}`);
  process.exit(1);
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ── Responses ───────────────────────────────────────────────────────────────

const BASE_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm', // required for WebAssembly.instantiateStreaming
  '.toml': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.stamp': 'text/plain; charset=utf-8',
  '.ktx2': 'image/ktx2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
};

function contentType(file) {
  return MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

function sendText(res, status, text, extraHeaders = {}) {
  const body = `${text}\n`;
  res.writeHead(status, {
    ...BASE_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

// ── Live reload ─────────────────────────────────────────────────────────────

const EVENTS_PATH = '/__awsm/events';

// Added to every HTML page as it is served (see serveHtml).
const RELOAD_CLIENT = `
<script type="module">
  // Live reload, added by tools/dev-server.mjs (not part of dom/).
  const events = new EventSource(${JSON.stringify(EVENTS_PATH)});
  let lostServer = false;
  events.addEventListener('message', (event) => {
    const { type } = JSON.parse(event.data);
    if (type === 'app' && typeof window.__awsm?.swapApp === 'function') {
      console.info('[dev] app rebuilt: swapping the app worker');
      window.__awsm.swapApp();
    } else {
      console.info('[dev] rebuilt: reloading the page');
      location.reload();
    }
  });
  events.addEventListener('error', () => { lostServer = true; });
  // Reconnected after losing the server: it restarted, maybe with new builds.
  events.addEventListener('open', () => { if (lostServer) location.reload(); });
</script>
`;

const eventClients = new Set();

function openEventStream(req, res) {
  res.writeHead(200, {
    ...BASE_HEADERS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    Connection: 'keep-alive',
  });
  res.write('retry: 1000\n\n'); // reconnect quickly if the server restarts
  eventClients.add(res);
  req.on('close', () => eventClients.delete(res));
}

function broadcast(type) {
  const message = `data: ${JSON.stringify({ type })}\n\n`;
  for (const res of eventClients) res.write(message);
}

// Comments keep idle connections from being closed by anything in between.
setInterval(() => {
  for (const res of eventClients) res.write(': keep-alive\n\n');
}, 15_000).unref();

// Several stamps can change together (e.g. `task build`), and one write can
// fire several file events; gather them briefly and send one message.
const DEBOUNCE_MS = 150;
let debounceTimer = null;
let pendingReload = false; // true if any change needs a full reload
const pendingNames = new Set();

function stampChanged(name) {
  if (name !== 'app.stamp' || reloadMode === 'page') pendingReload = true;
  pendingNames.add(name);
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const type = pendingReload ? 'reload' : 'app';
    log(`${[...pendingNames].join(', ')} changed: ${type === 'app' ? 'swapping the app' : 'reloading'} (${eventClients.size} page${eventClients.size === 1 ? '' : 's'})`);
    pendingReload = false;
    pendingNames.clear();
    broadcast(type);
  }, DEBOUNCE_MS);
}

// Watches the root directory itself (stamps live at the top level). If the
// directory is deleted and recreated (`task clean`, `task build`), the check
// below notices and starts watching the new one.
function watchStamps() {
  let watcher = null;
  let watchedIdentity = null;

  // Tells one directory from a later one at the same path. The inode alone is
  // not enough: some filesystems hand a deleted directory's number straight
  // to the next one created.
  const identity = () => {
    try {
      const stat = fs.statSync(root);
      return `${stat.ino}:${stat.birthtimeMs}`;
    } catch {
      return null; // not there right now
    }
  };
  const stop = () => {
    watcher?.close();
    watcher = null;
  };
  const start = () => {
    try {
      watchedIdentity = identity();
      watcher = fs.watch(root, (_event, filename) => {
        const name = filename?.toString();
        if (name && name.endsWith('.stamp') && !name.includes('/') && !name.includes('\\')) {
          // A stamp being DELETED is a build starting (the renderer task
          // removes its stamp first), not one finishing: wait for the new one.
          if (fs.existsSync(path.join(root, name))) stampChanged(name);
        }
      });
      watcher.on('error', stop);
    } catch {
      watcher = null;
    }
  };

  setInterval(() => {
    const current = identity();
    if (!watcher || current !== watchedIdentity) {
      stop();
      if (current !== null) start();
    }
  }, 1000).unref();
  start();
}

// ── Files ───────────────────────────────────────────────────────────────────

// Maps a URL path to a file under root, or null if it would escape root.
function resolvePath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const file = path.join(root, decoded); // path.join also resolves '..'
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  return file;
}

function serveHtml(req, res, file) {
  fs.readFile(file, 'utf8', (err, html) => {
    if (err) return sendText(res, 500, 'could not read file');
    const body = /<\/body>/i.test(html)
      ? html.replace(/<\/body>/i, () => `${RELOAD_CLIENT}</body>`)
      : html + RELOAD_CLIENT;
    res.writeHead(200, {
      ...BASE_HEADERS,
      'Content-Type': contentType(file),
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}

function serveFile(req, res, file, size) {
  res.writeHead(200, {
    ...BASE_HEADERS,
    'Content-Type': contentType(file),
    'Content-Length': size,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, 'method not allowed', { Allow: 'GET, HEAD' });
  }
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return sendText(res, 400, 'bad request');
  }
  if (url.pathname === EVENTS_PATH) return openEventStream(req, res);

  const file = resolvePath(url.pathname);
  if (file === null) return sendText(res, 403, 'forbidden');

  fs.stat(file, (err, stat) => {
    if (err) {
      log(`404 ${url.pathname}`);
      return sendText(res, 404, `not found: ${url.pathname}`);
    }
    if (stat.isDirectory()) {
      // Directory URLs need the trailing slash, or relative links break.
      if (!url.pathname.endsWith('/')) {
        return sendText(res, 301, 'moved', { Location: `${url.pathname}/${url.search}` });
      }
      const index = path.join(file, 'index.html');
      return fs.stat(index, (indexErr) => {
        if (indexErr) return sendText(res, 404, `no index.html in ${url.pathname}`);
        serveHtml(req, res, index);
      });
    }
    if (path.extname(file).toLowerCase() === '.html') return serveHtml(req, res, file);
    serveFile(req, res, file, stat.size);
  });
}

// ── Start ───────────────────────────────────────────────────────────────────

function log(message) {
  const time = new Date().toLocaleTimeString();
  console.log(`[dev-server ${time}] ${message}`);
}

function openBrowser(url) {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => log(`could not open a browser; visit ${url}`));
  child.unref();
}

const server = http.createServer(handle);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    fail(
      `port ${port} on ${host} is already in use (another dev server still running?).\n` +
        `Stop it, or use another port: task dev PORT=${port + 1}  (or --port ${port + 1})`,
    );
  }
  if (err.code === 'EACCES') fail(`not allowed to listen on port ${port}; pick one above 1023`);
  fail(err.message);
});

server.listen(port, host, () => {
  const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  const url = `http://${shownHost.includes(':') ? `[${shownHost}]` : shownHost}:${server.address().port}/`;
  console.log(`\n  dev server: ${url}`);
  console.log(`  serving ${path.relative(process.cwd(), root) || '.'}/ · reload: ${reloadMode} · Ctrl-C to stop\n`);
  watchStamps();
  if (options.open) openBrowser(url);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
