'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { Game } = require('./game');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'game.json');

const TICK_MS = 50;            
const BROADCAST_MS = 66;       
const SAVE_MS = 2000;          
const DISCONNECT_GRACE_MS = 60000; 

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ================= статика ================= */
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); } catch { urlPath = '/'; }
  if (urlPath === '/') urlPath = '/index.html';

  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

/* ================= состояние + диск ================= */
const game = new Game();
const sessions = new Map(); 

function readDisk() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return null; }
}

function writeDisk(payload) {
  const tmp = DATA_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('[storage] save failed:', e.message);
  }
}

const saved = readDisk();
if (saved) {
  if (saved.game) game.restore(saved.game);
  if (Array.isArray(saved.sessions)) {
    for (const [token, pid] of saved.sessions) {
      if (game.players.has(pid)) sessions.set(token, pid);
    }
  }
  console.log(`[storage] восстановлено: игроков=${game.players.size}, тик=${game.tick}`);
}

/* ================= WebSocket ================= */
const wss = new WebSocketServer({ server, maxPayload: 128 * 1024 });

const newPlayerId = () =>
  'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);

function handleHello(ws, msg) {
  if (ws.ctx) return;

  const token = (typeof msg.token === 'string' && msg.token.length >= 8 && msg.token.length <= 100)
    ? msg.token : null;
  if (!token) return ws.close(1008, 'bad token');

  let playerId = sessions.get(token);
  let player = playerId ? game.players.get(playerId) : null;

  if (!player) {
    playerId = newPlayerId();
    const name = typeof msg.name === 'string' && msg.name.trim()
      ? msg.name.trim().slice(0, 12) : 'Игрок';
    player = game.addPlayer(playerId, name);
    sessions.set(token, playerId);
  } else {
    player.connected = true;
    player.disconnectedAt = 0;
    if (typeof msg.name === 'string' && msg.name.trim()) {
      player.name = msg.name.trim().slice(0, 12);
    }
  }

  ws.ctx = { playerId, token };
  ws.gridVersion = -1;   
  game.dirty = true;

  ws.send(JSON.stringify({ type: 'welcome', playerId, color: player.color }));
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.ctx = null;
  ws.gridVersion = -1;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'hello') {
      // Проверка на лимит игроков (максимум 4)
      const activeCount = [...game.players.values()].filter(p => 
        p.connected || (p.disconnectedAt && Date.now() - p.disconnectedAt < DISCONNECT_GRACE_MS)
      ).length;
      const isExisting = sessions.has(msg.token) && game.players.has(sessions.get(msg.token));

      if (!isExisting && activeCount >= 4) {
        ws.send(JSON.stringify({ type: 'error', message: 'Игра заполнена (макс. 4 игрока)' }));
        setTimeout(() => ws.close(1008, 'Server full'), 500);
        return;
      }
      return handleHello(ws, msg);
    }

    if (!ws.ctx) return;
    const player = game.players.get(ws.ctx.playerId);
    if (!player) return;

    if (msg.type === 'action') {
      game.handleAction(ws.ctx.playerId, msg.action);
    } else if (msg.type === 'rename' && typeof msg.name === 'string') {
      const n = msg.name.trim().slice(0, 12);
      if (n) { player.name = n; game.dirty = true; }
    }
  });

  ws.on('close', () => {
    if (!ws.ctx) return;
    const p = game.players.get(ws.ctx.playerId);
    if (p) {
      p.connected = false;
      p.disconnectedAt = Date.now();
      game.dirty = true;
    }
  });

  ws.on('error', () => {});
});

/* ================= рассылка состояния ================= */
setInterval(() => {
  const snap = game.snapshot(Date.now());
  const base = { type: 'state', ...snap };

  const withoutGrid = JSON.stringify(base);
  const withGrid = JSON.stringify({ ...base, grid: game.grid });

  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN || !ws.ctx) continue;
    const needGrid = ws.gridVersion !== game.gridVersion;
    try { ws.send(needGrid ? withGrid : withoutGrid); } catch {}
    if (needGrid) ws.gridVersion = game.gridVersion;
  }
}, BROADCAST_MS);

/* ================= игровой цикл ================= */
setInterval(() => {
  const now = Date.now();
  game.update(now);

  for (const [id, p] of game.players) {
    if (!p.connected && p.disconnectedAt && now - p.disconnectedAt > DISCONNECT_GRACE_MS) {
      game.players.delete(id);
      game.dirty = true;
      for (const [t, pid] of sessions) if (pid === id) sessions.delete(t);
    }
  }
}, TICK_MS);

/* ================= сохранение ================= */
function persist() {
  writeDisk({
    v: 1,
    savedAt: Date.now(),
    game: game.serialize(),
    sessions: [...sessions.entries()],
  });
}

setInterval(() => {
  if (!game.dirty) return;
  game.dirty = false;
  persist();
}, SAVE_MS);

function shutdown() { persist(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`Bomber Online: http://localhost:${PORT}`);
});