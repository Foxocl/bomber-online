'use strict';

(() => {
  /* ================= константы ================= */
  const TILE = 40, COLS = 15, ROWS = 13;
  const T_WALL = 1, T_BLOCK = 2;
  const MOVE_COOLDOWN = 150; // Должно совпадать с сервером

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  canvas.width = COLS * TILE;
  canvas.height = ROWS * TILE;

  const statusEl = document.getElementById('status');
  const playersEl = document.getElementById('players');
  const nameEl = document.getElementById('name');
  const renameBtn = document.getElementById('rename');

  /* ================= идентичность ================= */
  const LS = { token: 'bomber.token', pid: 'bomber.playerId', name: 'bomber.name' };

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 't-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
  }

  let token = localStorage.getItem(LS.token);
  if (!token) { token = uuid(); localStorage.setItem(LS.token, token); }

  let playerId = localStorage.getItem(LS.pid) || null;
  let playerName = localStorage.getItem(LS.name) || '';
  nameEl.value = playerName;

  /* ================= состояние ================= */
  let grid = null, gridVersion = -1;
  let players = [], bombs = [], explosions = [], items = [];
  const disp = new Map();
  
  // Состояние раунда
  let roundOver = false;
  let winner = null;
  let roundRestartIn = 0;
  let prevRoundOver = false;

  let ws = null, connected = false, backoff = 400;
  let seq = 0;
  const queue = [];

  /* ================= сеть ================= */
  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = 'status ' + cls;
  }

  function connect() {
    setStatus('Подключение...', 'pending');
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';

    try { ws = new WebSocket(proto + location.host); }
    catch { return setTimeout(connect, backoff); }

    ws.onopen = () => {
      connected = true;
      backoff = 400;
      ws.send(JSON.stringify({ type: 'hello', token, name: playerName }));
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      
      if (msg.type === 'error') {
        setStatus(msg.message, 'bad');
        connected = false;
        return;
      }
      
      if (msg.type === 'welcome') onWelcome(msg);
      else if (msg.type === 'state') applyState(msg);
    };

    ws.onclose = () => {
      connected = false;
      setStatus('Нет связи. Переподключение...', 'bad');
      setTimeout(connect, backoff);
      backoff = Math.min(Math.round(backoff * 1.8), 8000);
    };

    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  function safeSend(obj) {
    if (connected && ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(obj)); } catch {}
    }
  }

  function onWelcome(msg) {
    setStatus('В игре', 'ok');

    if (msg.playerId !== playerId) {
      playerId = msg.playerId;
      localStorage.setItem(LS.pid, playerId);
      seq = 0;
      queue.length = 0;
    } else {
      for (const a of queue) safeSend({ type: 'action', action: a });
    }

    gridVersion = -1;
  }

  function sendAction(type, dir) {
    const action = { seq: ++seq, type, dir, t: Date.now() };
    queue.push(action);
    if (queue.length > 32) queue.shift();
    safeSend({ type: 'action', action });
  }

  /* ================= приём состояния ================= */
  function applyState(s) {
    if (s.grid && s.gridVersion !== gridVersion) {
      grid = s.grid;
      gridVersion = s.gridVersion;
    }
    players = s.players || [];
    bombs = s.bombs || [];
    explosions = s.explosions || [];
    items = s.items || [];
    
    // Обработка конца раунда
    if (prevRoundOver && !s.roundOver) {
      disp.clear(); // Очищаем интерполяцию при старте нового раунда
    }
    prevRoundOver = s.roundOver;
    roundOver = s.roundOver;
    winner = s.winner;
    roundRestartIn = s.roundRestartIn || 0;

    const seen = new Set();
    for (const p of players) {
      seen.add(p.id);
      let d = disp.get(p.id);
      if (!d) { d = { x: p.x, y: p.y }; disp.set(p.id, d); }
      if (Math.abs(d.x - p.x) + Math.abs(d.y - p.y) > 3) { d.x = p.x; d.y = p.y; }
    }
    for (const id of [...disp.keys()]) if (!seen.has(id)) disp.delete(id);

    renderPlayersList();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderPlayersList() {
    const sorted = [...players].sort(
      (a, b) => (b.alive - a.alive) || (a.deaths - b.deaths)
    );
    playersEl.innerHTML = sorted.map(p => {
      const me = p.id === playerId;
      return `<li class="pl${me ? ' me' : ''}">
        <span class="dot ${p.connected ? 'on' : 'off'}"></span>
        <span class="swatch" style="background:${p.color}"></span>
        <span class="pname">${escapeHtml(p.name)}${me ? ' (вы)' : ''}</span>
        <span class="pstat">${p.alive
          ? 'B:' + p.maxBombs + ' R:' + p.range
          : 'D:' + p.deaths}</span>
      </li>`;
    }).join('');
  }

  /* ================= рендер ================= */
  let lastTs = performance.now();

  function loop(ts) {
    requestAnimationFrame(loop);
    const dt = Math.min(0.05, (ts - lastTs) / 1000);
    lastTs = ts;
    draw(dt, ts);
  }

  function draw(dt, ts) {
    ctx.fillStyle = '#141c26';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (grid) {
      for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
          const t = grid[y][x];
          const px = x * TILE, py = y * TILE;
          if (t === T_WALL) {
            ctx.fillStyle = '#33475e';
            ctx.fillRect(px, py, TILE, TILE);
            ctx.fillStyle = '#41607f';
            ctx.fillRect(px + 3, py + 3, TILE - 6, TILE - 6);
          } else if (t === T_BLOCK) {
            ctx.fillStyle = '#7c4f24';
            ctx.fillRect(px + 2, py + 2, TILE - 4, TILE - 4);
            ctx.fillStyle = '#9c6733';
            ctx.fillRect(px + 5, py + 5, TILE - 10, TILE - 10);
          } else {
            ctx.fillStyle = ((x + y) & 1) ? '#1a2532' : '#1e2a38';
            ctx.fillRect(px, py, TILE, TILE);
          }
        }
      }
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 15px system-ui, sans-serif';
    for (const it of items) {
      const cx = it.x * TILE + TILE / 2, cy = it.y * TILE + TILE / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, TILE * 0.28, 0, Math.PI * 2);
      ctx.fillStyle = it.type === 'bomb' ? '#7dd3fc' : '#fca5a5';
      ctx.fill();
      ctx.fillStyle = '#0b1118';
      ctx.fillText(it.type === 'bomb' ? 'B' : 'F', cx, cy + 1);
    }

    for (const b of bombs) {
      const cx = b.x * TILE + TILE / 2, cy = b.y * TILE + TILE / 2;
      const k = 1 + 0.12 * Math.sin(ts / 90);
      ctx.beginPath();
      ctx.arc(cx, cy, TILE * 0.32 * k, 0, Math.PI * 2);
      ctx.fillStyle = '#111827';
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(cx + 9, cy - 11, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = b.fuse < 800 ? '#ff4444' : '#ffd166';
      ctx.fill();
    }

    for (const e of explosions) {
      const px = e.x * TILE, py = e.y * TILE;
      const a = 0.55 + 0.35 * Math.sin(ts / 60);
      ctx.fillStyle = `rgba(255,140,40,${a.toFixed(3)})`;
      ctx.fillRect(px + 2, py + 2, TILE - 4, TILE - 4);
      ctx.fillStyle = `rgba(255,235,130,${(a * 0.8).toFixed(3)})`;
      ctx.fillRect(px + 10, py + 10, TILE - 20, TILE - 20);
    }

    for (const p of players) {
      const d = disp.get(p.id);
      if (!d) continue;

      const k = 1 - Math.pow(0.0005, dt);
      d.x += (p.x - d.x) * k;
      d.y += (p.y - d.y) * k;

      const cx = d.x * TILE + TILE / 2;
      const cy = d.y * TILE + TILE / 2;

      ctx.globalAlpha = p.alive ? 1 : 0.28;

      ctx.beginPath();
      ctx.arc(cx, cy, TILE * 0.33, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
      ctx.lineWidth = p.id === playerId ? 3 : 1.5;
      ctx.strokeStyle = p.id === playerId ? '#ffffff' : 'rgba(0,0,0,.6)';
      ctx.stroke();

      ctx.fillStyle = 'rgba(0,0,0,.75)';
      ctx.beginPath(); ctx.arc(cx - 6, cy - 3, 3, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + 6, cy - 3, 3, 0, Math.PI * 2); ctx.fill();

      ctx.globalAlpha = 1;
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = '#dfe9f3';
      ctx.fillText(p.name, cx, cy - TILE * 0.38);
    }

    // Отрисовка экрана конца раунда
    if (roundOver) {
      ctx.fillStyle = 'rgba(11, 17, 24, 0.85)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = '#fff';
      ctx.font = 'bold 24px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      if (winner) {
        ctx.fillStyle = winner.color;
        ctx.fillText(`Победил ${winner.name}!`, canvas.width / 2, canvas.height / 2 - 20);
      } else {
        ctx.fillText('Ничья!', canvas.width / 2, canvas.height / 2 - 20);
      }

      ctx.fillStyle = '#dfe9f3';
      ctx.font = '16px system-ui, sans-serif';
      const sec = Math.ceil(roundRestartIn / 1000);
      ctx.fillText(`Новый раунд через ${sec}...`, canvas.width / 2, canvas.height / 2 + 20);
    }
  }

  /* ================= ввод ================= */
  const keys = new Set();
  let lastMoveAt = 0;

  function getDirFromKey(key) {
    key = key.toLowerCase();
    if (key === 'w' || key === 'ц' || key === 'arrowup') return 'up';
    if (key === 's' || key === 'ы' || key === 'arrowdown') return 'down';
    if (key === 'a' || key === 'ф' || key === 'arrowleft') return 'left';
    if (key === 'd' || key === 'в' || key === 'arrowright') return 'right';
    return null;
  }

  function trySendMove(dir, force = false) {
    if (!connected || !dir) return;
    const now = performance.now();
    if (!force && now - lastMoveAt < MOVE_COOLDOWN) return;
    lastMoveAt = now;
    sendAction('move', dir);
  }

  window.addEventListener('keydown', (e) => {
    // Если пользователь печатает в поле ввода, не перехватываем клавиши
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    const dir = getDirFromKey(e.key);
    if (dir) {
      e.preventDefault();
      if (e.repeat) return;
      keys.add(dir);
      trySendMove(dir, true); // Мгновенный шаг при нажатии
    } else if (e.code === 'Space') {
      e.preventDefault();
      if (!e.repeat) sendAction('bomb');
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    const dir = getDirFromKey(e.key);
    if (dir) keys.delete(dir);
  });

  window.addEventListener('blur', () => keys.clear());

  // Плавное движение при зажатой клавише
  setInterval(() => {
    let dir = null;
    if (keys.has('up')) dir = 'up';
    else if (keys.has('down')) dir = 'down';
    else if (keys.has('left')) dir = 'left';
    else if (keys.has('right')) dir = 'right';
    trySendMove(dir, false);
  }, 30);

  /* ================= имя ================= */
  renameBtn.addEventListener('click', () => {
    const n = nameEl.value.trim().slice(0, 12);
    if (!n) return;
    playerName = n;
    localStorage.setItem(LS.name, n);
    safeSend({ type: 'rename', name: n });
  });

  /* ================= старт ================= */
  connect();
  requestAnimationFrame(loop);
})();