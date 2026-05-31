import { io } from 'socket.io-client';
import { state } from './state.ts';
import type {
  ClassId, ClientToServerEvents, Direction, EquipSlot, ServerToClientEvents, StatId,
} from '../../shared/types.ts';

const SESSION_KEY = 'mmo.session_token';

const socket = io() as ReturnType<typeof io> as import('socket.io-client').Socket<
  ServerToClientEvents,
  ClientToServerEvents
>;

Object.assign(state, {
  socket,
  session_token: localStorage.getItem(SESSION_KEY),
  entityId: null,
  self: null,
  zone: null,
  tileset: null,
  combatEvents: [],
  pickupFloats: [],
  xpFloats: [],
  lastXp: null,
  levelUp: null,
  zoneBanner: null,
  died: false,
  diedAt: null,
  chatLog: [],
  speech: new Map<string, { text: string; t: number }>(),
  sendMove: (dir: Direction) => socket.emit('action', { action: 'move', dir }),
  sendAttack: () => socket.emit('action', { action: 'attack' }),
  sendChat: (text: string) => socket.emit('chat', { text }),
  sendAllocate: (stat: StatId) => socket.emit('allocate', { stat }, () => {}),
  sendEquip: (slot: number) => socket.emit('equip', { slot }, () => {}),
  sendUnequip: (slot: EquipSlot) => socket.emit('unequip', { slot }, () => {}),
});

function promptNameIfNeeded(): Promise<{ name: string; klass: ClassId } | null> {
  return new Promise((resolve) => {
    if (state.session_token) { resolve(null); return; }
    const backdrop = document.getElementById('welcome-backdrop')!;
    const input = document.getElementById('name-input') as HTMLInputElement;
    const btn = document.getElementById('enter-btn')!;
    const classBtns = document.querySelectorAll<HTMLElement>('.class-btn');
    let selectedClass: ClassId = 'fighter';
    classBtns.forEach((b) => {
      if (b.dataset.class === selectedClass) b.classList.add('selected');
      b.addEventListener('click', () => {
        selectedClass = (b.dataset.class as ClassId) || 'fighter';
        classBtns.forEach((x) => x.classList.toggle('selected', x === b));
      });
    });
    backdrop.classList.add('open');
    input.focus();
    const submit = () => {
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      backdrop.classList.remove('open');
      btn.removeEventListener('click', submit);
      input.removeEventListener('keydown', onKey);
      resolve({ name, klass: selectedClass });
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter') submit(); };
    btn.addEventListener('click', submit);
    input.addEventListener('keydown', onKey);
  });
}

function showZoneBanner(snap: { id: string; name?: string }): void {
  state.zoneBanner = { name: snap.name || snap.id, t: performance.now() };
}

socket.on('connect', async () => {
  const picked = await promptNameIfNeeded();
  socket.emit(
    'join',
    { session_token: state.session_token, name: picked?.name, klass: picked?.klass },
    async (resp) => {
      state.session_token = resp.session_token;
      state.entityId = resp.entityId;
      state.self = resp.self;
      state.zone = resp.zone;
      showZoneBanner(resp.zone);
      localStorage.setItem(SESSION_KEY, resp.session_token);

      const r = await fetch('/tilesets/overworld');
      if (r.ok) state.tileset = await r.json();
      window.dispatchEvent(new CustomEvent('mmo:ready'));
    },
  );
});

socket.on('zone', (snap) => {
  const previousId = state.zone?.id;
  state.zone = snap;
  if (state.entityId) {
    const me = snap.entities.find(e => e.id === state.entityId);
    if (me && me.type === 'player') state.self = me as unknown as typeof state.self;
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

socket.on('combat', (ev) => {
  state.combatEvents.push({ ...ev, t: performance.now() });
});

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

socket.on('pickup', (ev) => {
  state.pickupFloats.push({ ...ev, t: performance.now() });
});

socket.on('chat', (msg) => {
  state.chatLog.push({ ...msg, recvAt: performance.now() });
  if (state.chatLog.length > 30) state.chatLog.shift();
  state.speech.set(msg.from.id, { text: msg.text, t: performance.now() });
  window.dispatchEvent(new CustomEvent('mmo:chat', { detail: msg }));
});
