// Thin Socket.IO wrapper. Exposes the current connection on window.mmo so
// game.js can read state and send actions without an import cycle.

const SESSION_KEY = 'mmo.session_token';

const socket = window.io();

const state = {
  socket,
  session_token: localStorage.getItem(SESSION_KEY) || null,
  entityId: null,
  self: null,
  zone: null,        // { id, width, height, grid, entities }
  tileset: null,
};

window.mmo = state;

function promptNameIfNeeded() {
  return new Promise((resolve) => {
    if (state.session_token) return resolve(null);
    const backdrop = document.getElementById('welcome-backdrop');
    const input = document.getElementById('name-input');
    const btn = document.getElementById('enter-btn');
    backdrop.classList.add('open');
    input.focus();
    const submit = () => {
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      backdrop.classList.remove('open');
      btn.removeEventListener('click', submit);
      input.removeEventListener('keydown', onKey);
      resolve(name);
    };
    const onKey = (e) => { if (e.key === 'Enter') submit(); };
    btn.addEventListener('click', submit);
    input.addEventListener('keydown', onKey);
  });
}

function showZoneBanner(snap) {
  state.zoneBanner = { name: snap.name || snap.id, t: performance.now() };
}

socket.on('connect', async () => {
  const name = await promptNameIfNeeded();
  socket.emit('join', { session_token: state.session_token, name }, async (resp) => {
    state.session_token = resp.session_token;
    state.entityId = resp.entityId;
    state.self = resp.self;
    state.zone = resp.zone;
    showZoneBanner(resp.zone);
    localStorage.setItem(SESSION_KEY, resp.session_token);

    const tilesetName = (await fetch(`/tilesets/overworld`)).ok ? 'overworld' : null;
    if (tilesetName) {
      const r = await fetch(`/tilesets/${tilesetName}`);
      state.tileset = await r.json();
    }
    window.dispatchEvent(new CustomEvent('mmo:ready'));
  });
});

socket.on('zone', (snap) => {
  const previousId = state.zone?.id;
  state.zone = snap;
  if (state.entityId) {
    const me = snap.entities.find(e => e.id === state.entityId);
    if (me) state.self = me;
  }
  if (snap.id !== previousId) showZoneBanner(snap);
  window.dispatchEvent(new CustomEvent('mmo:zone'));
});

socket.on('respawn', ({ zone, self }) => {
  const previousId = state.zone?.id;
  state.zone = zone;
  state.self = self;
  state.died = true;
  state.diedAt = performance.now();
  if (zone.id !== previousId) showZoneBanner(zone);
  window.dispatchEvent(new CustomEvent('mmo:zone'));
});

// Float-text + flash queue for combat feedback.
state.combatEvents = [];
socket.on('combat', (ev) => {
  state.combatEvents.push({ ...ev, t: performance.now() });
});

state.xpFloats = [];
socket.on('xp', (ev) => {
  state.lastXp = ev;
  state.xpFloats.push({ amount: ev.gained, t: performance.now() });
});

socket.on('levelup', (ev) => {
  state.levelUp = { level: ev.level, t: performance.now() };
  if (state.self?.components?.progress && typeof ev.unspent_points === 'number') {
    state.self.components.progress.unspent_points = ev.unspent_points;
  }
});

socket.on('self', ({ self }) => {
  state.self = self;
  window.dispatchEvent(new CustomEvent('mmo:self'));
});

state.sendMove = (dir) => socket.emit('action', { action: 'move', dir });
state.sendAttack = () => socket.emit('action', { action: 'attack' });
state.sendChat = (text) => socket.emit('chat', { text });
state.sendAllocate = (stat) => socket.emit('allocate', { stat });
state.sendEquip = (slot) => socket.emit('equip', { slot });
state.sendUnequip = (slot) => socket.emit('unequip', { slot });

state.pickupFloats = [];
socket.on('pickup', (ev) => {
  state.pickupFloats.push({ ...ev, t: performance.now() });
});

// Recent chat for the log panel + per-speaker speech bubbles.
state.chatLog = [];
state.speech = new Map(); // entityId -> { text, t }
socket.on('chat', (msg) => {
  state.chatLog.push({ ...msg, recvAt: performance.now() });
  if (state.chatLog.length > 30) state.chatLog.shift();
  state.speech.set(msg.from.id, { text: msg.text, t: performance.now() });
  window.dispatchEvent(new CustomEvent('mmo:chat', { detail: msg }));
});
