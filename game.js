'use strict';

const COLS = 15;
const ROWS = 13;

const T_EMPTY = 0, T_WALL = 1, T_BLOCK = 2;

const MOVE_COOLDOWN = 150; // Увеличено, чтобы исключить двойные шаги
const BOMB_FUSE = 2600;
const EXPLOSION_MS = 500;
const RESPAWN_MS = 4000;

const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

const SPAWNS = [
  { x: 1, y: 1 },
  { x: COLS - 2, y: ROWS - 2 },
  { x: COLS - 2, y: 1 },
  { x: 1, y: ROWS - 2 },
];

const COLORS = ['#ff5c5c', '#4aa3ff', '#4ade80', '#fbbf24',
                '#c084fc', '#2dd4bf', '#fb923c', '#f472b6'];

const K = (x, y) => x + ',' + y;
const inBounds = (x, y) => x >= 0 && y >= 0 && x < COLS && y < ROWS;

class Game {
  constructor() {
    this.players = new Map();
    this.bombs = [];
    this.explosions = [];
    this.items = new Map();
    this.tick = 0;
    this.gridVersion = 0;
    this.colorSeq = 0;
    this.dirty = false;
    
    // Состояние раунда
    this.roundOver = false;
    this.winner = null;
    this.roundRestartAt = 0;
    
    this.reset();
  }

  /* ---------- карта ---------- */
  reset() {
    this.grid = [];
    for (let y = 0; y < ROWS; y++) {
      const row = [];
      for (let x = 0; x < COLS; x++) {
        if (x === 0 || y === 0 || x === COLS - 1 || y === ROWS - 1) row.push(T_WALL);
        else if (x % 2 === 0 && y % 2 === 0) row.push(T_WALL);
        else row.push(Math.random() < 0.78 ? T_BLOCK : T_EMPTY);
      }
      this.grid.push(row);
    }
    for (const s of SPAWNS) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = s.x + dx, y = s.y + dy;
          if (inBounds(x, y) && this.grid[y][x] === T_BLOCK) this.grid[y][x] = T_EMPTY;
        }
      }
    }
    this.bombs = [];
    this.explosions = [];
    this.items.clear();
    this.gridVersion++;
    this.dirty = true;
  }

  startNewRound() {
    this.roundOver = false;
    this.winner = null;
    this.roundRestartAt = 0;
    this.reset();

    let spawnIdx = 0;
    for (const p of this.players.values()) {
      p.alive = p.connected;
      p.deaths = 0;
      p.maxBombs = 1;
      p.range = 2;
      p.bombsActive = 0;
      p.respawnAt = 0;
      if (p.connected) {
        const s = SPAWNS[spawnIdx % SPAWNS.length];
        p.x = s.x; p.y = s.y;
        spawnIdx++;
      }
    }
    this.dirty = true;
  }

  /* ---------- игроки ---------- */
  addPlayer(id, name) {
    let spawn = SPAWNS[0];
    let best = -1;
    for (const s of SPAWNS) {
      let d = 999;
      for (const p of this.players.values()) {
        d = Math.min(d, Math.abs(p.x - s.x) + Math.abs(p.y - s.y));
      }
      if (d > best) { best = d; spawn = s; }
    }

    const p = {
      id,
      name: (name || 'Игрок').slice(0, 12),
      x: spawn.x, y: spawn.y,
      color: COLORS[this.colorSeq++ % COLORS.length],
      alive: true,
      maxBombs: 1, range: 2, bombsActive: 0,
      lastMoveAt: 0,
      lastSeq: 0,
      connected: true, disconnectedAt: 0,
      deaths: 0,
      respawnAt: 0,
    };
    this.players.set(id, p);
    this.dirty = true;
    return p;
  }

  /* ---------- обработка действий клиента ---------- */
  handleAction(playerId, action) {
    if (this.roundOver) return; // Блокируем ввод между раундами

    const p = this.players.get(playerId);
    if (!p || !p.connected) return;

    const seq = action && action.seq;
    if (typeof seq !== 'number' || !Number.isFinite(seq)) return;

    if (seq <= p.lastSeq) return;
    p.lastSeq = seq;

    const now = Date.now();
    if (action.type === 'move') this.tryMove(p, action.dir, now);
    else if (action.type === 'bomb') this.tryBomb(p, now);
  }

  tryMove(p, dir, now) {
    if (!p.alive) return;
    if (now - p.lastMoveAt < MOVE_COOLDOWN) return;
    const v = DIRS[dir];
    if (!v) return;

    const nx = p.x + v[0], ny = p.y + v[1];
    if (!inBounds(nx, ny)) return;
    if (this.grid[ny][nx] !== T_EMPTY) return;
    if (this.bombs.some(b => b.x === nx && b.y === ny)) return;

    for (const o of this.players.values()) {
      if (o.id !== p.id && o.alive && o.x === nx && o.y === ny) return;
    }

    p.x = nx; p.y = ny; p.lastMoveAt = now;

    const ik = K(nx, ny);
    const item = this.items.get(ik);
    if (item) {
      this.items.delete(ik);
      if (item.type === 'bomb') p.maxBombs = Math.min(6, p.maxBombs + 1);
      else p.range = Math.min(8, p.range + 1);
    }
    this.dirty = true;
  }

  tryBomb(p, now) {
    if (!p.alive) return;
    if (p.bombsActive >= p.maxBombs) return;
    if (this.bombs.some(b => b.x === p.x && b.y === p.y)) return;

    this.bombs.push({
      x: p.x, y: p.y, ownerId: p.id, range: p.range, placedAt: now,
    });
    p.bombsActive++;
    this.dirty = true;
  }

  /* ---------- симуляция ---------- */
  update(now) {
    this.tick++;

    if (this.roundOver) {
      if (now >= this.roundRestartAt) {
        this.startNewRound();
      }
      return;
    }

    for (const b of [...this.bombs]) {
      if (now - b.placedAt >= BOMB_FUSE) this.explode(b, now);
    }

    if (this.explosions.length) {
      this.explosions = this.explosions.filter(e => e.until > now);
    }

    for (const p of this.players.values()) {
      if (!p.alive) {
        if (p.respawnAt && now >= p.respawnAt) this.respawn(p);
        continue;
      }
      if (this.explosions.some(e => e.x === p.x && e.y === p.y)) {
        p.alive = false;
        p.deaths++;
        p.respawnAt = now + RESPAWN_MS;
        p.bombsActive = 0;
        this.dirty = true;
      }
    }

    const connectedPlayers = [...this.players.values()].filter(p => p.connected);
    const alivePlayers = connectedPlayers.filter(p => p.alive);

    // Условие конца раунда (только если в игре 2 и более игроков)
    if (connectedPlayers.length >= 2 && alivePlayers.length <= 1) {
      this.roundOver = true;
      this.winner = alivePlayers.length === 1 ? alivePlayers[0] : null;
      this.roundRestartAt = now + 5000; // 5 секунд на просмотр результатов
      this.dirty = true;
    }
  }

  respawn(p) {
    let spawn = SPAWNS[0];
    for (const cand of SPAWNS) {
      const occupied = [...this.players.values()].some(
        o => o.id !== p.id && o.alive && o.x === cand.x && o.y === cand.y
      );
      const blocked = this.grid[cand.y][cand.x] !== T_EMPTY ||
                      this.bombs.some(b => b.x === cand.x && b.y === cand.y);
      if (!occupied && !blocked) { spawn = cand; break; }
    }
    p.x = spawn.x; p.y = spawn.y;
    p.alive = true; p.respawnAt = 0;
    p.maxBombs = 1; p.range = 2; p.bombsActive = 0;
    this.dirty = true;
  }

  explode(bomb, now) {
    const i = this.bombs.indexOf(bomb);
    if (i === -1) return;
    this.bombs.splice(i, 1);
    this.dirty = true;

    const owner = this.players.get(bomb.ownerId);
    if (owner) owner.bombsActive = Math.max(0, owner.bombsActive - 1);

    const cells = [{ x: bomb.x, y: bomb.y }];

    for (const dir in DIRS) {
      const [dx, dy] = DIRS[dir];
      for (let r = 1; r <= bomb.range; r++) {
        const x = bomb.x + dx * r, y = bomb.y + dy * r;
        if (!inBounds(x, y)) break;
        const t = this.grid[y][x];
        if (t === T_WALL) break;
        if (t === T_BLOCK) {
          this.grid[y][x] = T_EMPTY;
          this.gridVersion++;
          if (Math.random() < 0.3) {
            this.items.set(K(x, y), { type: Math.random() < 0.5 ? 'bomb' : 'range' });
          }
          cells.push({ x, y });
          break;
        }
        cells.push({ x, y });
        const chain = this.bombs.find(b => b.x === x && b.y === y);
        if (chain) this.explode(chain, now);
      }
    }

    for (const c of cells) this.explosions.push({ x: c.x, y: c.y, until: now + EXPLOSION_MS });
  }

  /* ---------- снапшот для клиентов ---------- */
  snapshot(now = Date.now()) {
    const players = [];
    for (const p of this.players.values()) {
      players.push({
        id: p.id, name: p.name, x: p.x, y: p.y, color: p.color,
        alive: p.alive, connected: p.connected,
        maxBombs: p.maxBombs, range: p.range, bombsActive: p.bombsActive,
        deaths: p.deaths,
      });
    }

    const bombs = this.bombs.map(b => ({
      x: b.x, y: b.y, ownerId: b.ownerId, range: b.range,
      fuse: Math.max(0, BOMB_FUSE - (now - b.placedAt)),
    }));

    const explosions = this.explosions.map(e => ({
      x: e.x, y: e.y, ttl: Math.max(0, e.until - now),
    }));

    const items = [];
    for (const [k, v] of this.items) {
      const [x, y] = k.split(',').map(Number);
      items.push({ x, y, type: v.type });
    }

    return { 
      tick: this.tick, 
      gridVersion: this.gridVersion, 
      players, 
      bombs, 
      explosions, 
      items,
      roundOver: this.roundOver,
      winner: this.winner ? { name: this.winner.name, color: this.winner.color } : null,
      roundRestartIn: Math.max(0, this.roundRestartAt - now)
    };
  }

  /* ---------- персистентность ---------- */
  serialize() {
    return {
      v: 1,
      grid: this.grid,
      gridVersion: this.gridVersion,
      colorSeq: this.colorSeq,
      players: [...this.players.values()],
      bombs: this.bombs,
      items: [...this.items.entries()],
    };
  }

  restore(data) {
    if (!data || data.v !== 1) return false;
    try {
      this.grid = data.grid;
      this.gridVersion = data.gridVersion || 1;
      this.colorSeq = data.colorSeq || 0;
      this.bombs = Array.isArray(data.bombs) ? data.bombs : [];
      this.explosions = [];
      this.items = new Map(Array.isArray(data.items) ? data.items : []);

      this.players = new Map();
      const now = Date.now();
      for (const p of data.players || []) {
        this.players.set(p.id, {
          ...p,
          connected: false,
          disconnectedAt: now,
          lastMoveAt: 0,
          bombsActive: 0,
        });
      }
      for (const b of this.bombs) {
        const o = this.players.get(b.ownerId);
        if (o) o.bombsActive++;
      }
      return true;
    } catch (e) {
      console.error('[game] restore failed:', e.message);
      this.reset();
      return false;
    }
  }
}

module.exports = { Game, COLS, ROWS };