import { io } from 'socket.io-client';
import { auth, signInWithGoogle, signInWithEmail, registerWithEmail, getIdToken, signOut } from './firebase.ts';
import { state } from './state.ts';
import type {
  CharacterSummary, ClassId, ClientToServerEvents, Direction, EquipSlot, JoinResponse,
  LootCorpseResponse, PostBoardResponse, QuestActionKind, QuestActionResponse,
  QuestsApiPayload, ReadBoardResponse, ServerToClientEvents, StatId,
  TradeMessage, TradeResponse, UseItemResponse,
} from '../../shared/types.ts';
import type { OnlinePlayer, QuestStageAdvance } from './state.ts';

// ---------------------------------------------------------------------------
// Socket — autoConnect: false so we only connect after Firebase auth resolves
// ---------------------------------------------------------------------------

const BACKEND = import.meta.env.VITE_SERVER_URL ?? '';

const socket = (
  BACKEND ? io(BACKEND, { autoConnect: false }) : io({ autoConnect: false })
) as import('socket.io-client').Socket<ServerToClientEvents, ClientToServerEvents>;

Object.assign(state, {
  socket,
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
  questCompletions: [],
  questStageAdvances: [],
  died: false,
  diedAt: null,
  chatLog: [],
  speech: new Map<string, { text: string; t: number }>(),
  quests: { active: [], completed: [] },
  questDefs: {},
  questsByGiver: {},
  onlinePlayers: [],
  sendMove: (dir: Direction) => socket.emit('action', { action: 'move', dir }),
  sendAttack: () => socket.emit('action', { action: 'attack' }),
  sendAutopath: (tx: number, ty: number) => socket.emit('action', { action: 'autopath', tx, ty }),
  sendChat: (text: string) => socket.emit('chat', { text }),
  sendAllocate: (stat: StatId) => socket.emit('allocate', { stat }, () => {}),
  sendEquip: (slot: number) => socket.emit('equip', { slot }, () => {}),
  sendUnequip: (slot: EquipSlot) => socket.emit('unequip', { slot }, () => {}),
  sendQuestAction: (questId: string, action: QuestActionKind, talkingTo?: string) =>
    new Promise<QuestActionResponse>((resolve) =>
      socket.emit('quest_action', { questId, action, talkingTo }, resolve)),
  sendPokeMob: (mobId: string) => socket.emit('poke_mob', { mobId }),
  sendTrade: (msg: TradeMessage) =>
    new Promise<TradeResponse>((resolve) => socket.emit('trade', msg, resolve)),
  sendUseItem: (slot: number) =>
    new Promise<UseItemResponse>((resolve) => socket.emit('use_item', { slot }, resolve)),
  sendLootCorpse: (corpseId: string, slotId: string) =>
    new Promise<LootCorpseResponse>((resolve) => socket.emit('loot_corpse', { corpseId, slotId }, resolve)),
  sendReadBoard: (boardId: string) =>
    new Promise<ReadBoardResponse>((resolve) => socket.emit('read_board', { boardId }, resolve)),
  sendPostToBoard: (boardId: string, text: string) =>
    new Promise<PostBoardResponse>((resolve) => socket.emit('post_to_board', { boardId, text }, resolve)),
});

// ---------------------------------------------------------------------------
// Login modal (interim UI — replaced by the full menu screen in Task 3)
// ---------------------------------------------------------------------------

const loginBackdrop  = document.getElementById('login-backdrop')!;
const loginGoogleBtn = document.getElementById('login-google')!;
const authEmailInput = document.getElementById('auth-email') as HTMLInputElement;
const authPwInput    = document.getElementById('auth-password') as HTMLInputElement;
const authSubmitBtn  = document.getElementById('auth-submit')!;
const authToggleBtn  = document.getElementById('auth-toggle-mode')!;
const authError      = document.getElementById('auth-error')!;

let authMode: 'signin' | 'register' = 'signin';

function showLoginScreen(): void  { loginBackdrop.classList.add('open'); }
function hideLoginScreen(): void  { loginBackdrop.classList.remove('open'); }
function setAuthError(msg: string): void { authError.textContent = msg; }

authToggleBtn.addEventListener('click', () => {
  authMode = authMode === 'signin' ? 'register' : 'signin';
  authSubmitBtn.textContent = authMode === 'signin' ? 'Sign In' : 'Create Account';
  authToggleBtn.textContent = authMode === 'signin' ? 'Register instead' : 'Sign in instead';
  setAuthError('');
});

loginGoogleBtn.addEventListener('click', async () => {
  setAuthError('');
  loginGoogleBtn.setAttribute('disabled', 'true');
  try {
    await signInWithGoogle();
    // onAuthStateChanged handles the rest
  } catch (err) {
    setAuthError(friendlyAuthError(err));
  } finally {
    loginGoogleBtn.removeAttribute('disabled');
  }
});

authSubmitBtn.addEventListener('click', handleEmailSubmit);
authPwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleEmailSubmit(); });

async function handleEmailSubmit(): Promise<void> {
  const email = authEmailInput.value.trim();
  const pw    = authPwInput.value;
  if (!email || !pw) { setAuthError('Email and password are required.'); return; }
  setAuthError('');
  authSubmitBtn.setAttribute('disabled', 'true');
  try {
    console.log('[auth] email submit mode=%s email=%s', authMode, email);
    if (authMode === 'signin') await signInWithEmail(email, pw);
    else                       await registerWithEmail(email, pw);
    console.log('[auth] firebase sign-in resolved, awaiting onAuthStateChanged');
  } catch (err) {
    console.error('[auth] firebase sign-in threw:', err);
    setAuthError(friendlyAuthError(err));
  } finally {
    authSubmitBtn.removeAttribute('disabled');
  }
}

function friendlyAuthError(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: string }).code;
    if (['auth/wrong-password', 'auth/user-not-found', 'auth/invalid-credential'].includes(code))
      return 'Invalid email or password.';
    if (code === 'auth/email-already-in-use') return 'An account with this email already exists.';
    if (code === 'auth/weak-password')        return 'Password must be at least 6 characters.';
    if (code === 'auth/invalid-email')        return 'Invalid email address.';
    if (code === 'auth/popup-closed-by-user') return '';
    if (code === 'auth/network-request-failed') return 'Network error. Check your connection.';
  }
  return 'Sign in failed. Please try again.';
}

// ---------------------------------------------------------------------------
// Character creation (reuses existing welcome modal; replaced in Task 3)
// ---------------------------------------------------------------------------

const COLOR_PALETTE = [
  '#6ec6f0', '#ffd84a', '#5acc5a', '#cc5a5a', '#9a5acc', '#ff8c2a', '#e8e8e8', '#5af0e8',
];

function promptNameAndClass(): Promise<{ name: string; klass: ClassId; color: string }> {
  return new Promise((resolve) => {
    const backdrop    = document.getElementById('welcome-backdrop')!;
    const input       = document.getElementById('name-input') as HTMLInputElement;
    const btn         = document.getElementById('enter-btn')!;
    const classBtns   = document.querySelectorAll<HTMLElement>('.class-btn');
    const colorPicker = document.getElementById('color-picker')!;
    let selectedClass: ClassId = 'fighter';
    let selectedColor = COLOR_PALETTE[0]!;

    // Build color swatches
    colorPicker.innerHTML = '';
    for (const hex of COLOR_PALETTE) {
      const sw = document.createElement('div');
      sw.className = 'color-swatch' + (hex === selectedColor ? ' selected' : '');
      sw.style.background = hex;
      sw.title = hex;
      sw.addEventListener('click', () => {
        selectedColor = hex;
        colorPicker.querySelectorAll<HTMLElement>('.color-swatch').forEach((s) =>
          s.classList.toggle('selected', s.style.background === hex || s.style.background === `${hex}`));
      });
      colorPicker.appendChild(sw);
    }

    classBtns.forEach((b) => {
      b.classList.toggle('selected', b.dataset.class === selectedClass);
      b.addEventListener('click', () => {
        selectedClass = (b.dataset.class as ClassId) || 'fighter';
        classBtns.forEach((x) => x.classList.toggle('selected', x === b));
      });
    });
    backdrop.classList.add('open');
    input.value = '';
    input.focus();

    const submit = () => {
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      backdrop.classList.remove('open');
      btn.removeEventListener('click', submit);
      input.removeEventListener('keydown', onKey);
      resolve({ name, klass: selectedClass, color: selectedColor });
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter') submit(); };
    btn.addEventListener('click', submit);
    input.addEventListener('keydown', onKey);
  });
}

// ---------------------------------------------------------------------------
// Character select screen
// ---------------------------------------------------------------------------

const charSelectBackdrop = document.getElementById('charselect-backdrop')!;
const charSelectList     = document.getElementById('charselect-list')!;
const charSelectErr      = document.getElementById('charselect-err')!;

function showCharSelect(characters: CharacterSummary[], token: string): void {
  charSelectErr.textContent = '';
  charSelectList.innerHTML = '';

  for (const char of characters) {
    const slot = document.createElement('div');
    slot.className = 'cs-slot playable';
    slot.innerHTML = `
      <div class="cs-avatar" style="background:${escHtml(char.color)}"></div>
      <div class="cs-info">
        <div class="cs-name">${escHtml(char.name)}</div>
        <div class="cs-meta">Level ${char.level} ${char.klass} &middot; ${escHtml(char.zone.replace(/_/g, ' '))}</div>
      </div>
      <button class="cs-play-btn primary">Play</button>
    `;
    slot.querySelector('button')!.addEventListener('click', () => {
      hideCharSelect();
      void doJoinAsCharacter(token, char.id);
    });
    charSelectList.appendChild(slot);
  }

  if (characters.length < 3) {
    const newBtn = document.createElement('button');
    newBtn.className = 'cs-new-btn';
    newBtn.textContent = '+ Create New Character';
    newBtn.addEventListener('click', async () => {
      hideCharSelect();
      const picked = await promptNameAndClass();
      let freshToken: string;
      try { freshToken = await getIdToken(); }
      catch { showLoginScreen(); return; }
      void doJoinWithNew(freshToken, picked);
    });
    charSelectList.appendChild(newBtn);
  }

  charSelectBackdrop.classList.add('open');
}

function hideCharSelect(): void {
  charSelectBackdrop.classList.remove('open');
}

// ---------------------------------------------------------------------------
// In-game menu
// ---------------------------------------------------------------------------

const gameMenuBackdrop = document.getElementById('gamemenu-backdrop')!;
const gameMenuBtn      = document.getElementById('game-menu-btn')!;

gameMenuBtn.addEventListener('click', () => gameMenuBackdrop.classList.add('open'));
document.getElementById('menu-close')!.addEventListener('click', () => gameMenuBackdrop.classList.remove('open'));

document.getElementById('menu-logout')!.addEventListener('click', async () => {
  gameMenuBackdrop.classList.remove('open');
  await signOut();
  // onAuthStateChanged(null) will disconnect socket and show login screen
});

document.getElementById('menu-switch-char')!.addEventListener('click', () => {
  gameMenuBackdrop.classList.remove('open');
  gameMenuBtn.classList.remove('visible');
  // Reset transient state so old character doesn't bleed through on re-join
  state.entityId = null;
  state.self = null;
  state.zone = null;
  state.combatEvents = [];
  state.pickupFloats = [];
  state.xpFloats = [];
  state.lastXp = null;
  state.levelUp = null;
  state.zoneBanner = null;
  state.questCompletions = [];
  state.questStageAdvances = [];
  state.died = false;
  state.diedAt = null;
  state.speech = new Map();
  state.quests = { active: [], completed: [] };
  // Wait for server to finish saving before reconnecting so doListAndSelect fires on connect
  socket.once('disconnect', () => socket.connect());
  socket.disconnect();
});

// ---------------------------------------------------------------------------
// Zone banner helper
// ---------------------------------------------------------------------------

function showZoneBanner(snap: { id: string; name?: string }): void {
  state.zoneBanner = { name: snap.name || snap.id, t: performance.now() };
}

// ---------------------------------------------------------------------------
// Online players panel
// ---------------------------------------------------------------------------

async function fetchOnlinePlayers(): Promise<void> {
  try {
    const r = await fetch(`${BACKEND}/api/players`);
    if (!r.ok) return;
    const data = (await r.json()) as { players: OnlinePlayer[] };
    state.onlinePlayers = data.players || [];
    renderPlayersPanel();
  } catch { /* network error — ignore */ }
}

function renderPlayersPanel(): void {
  const panel = document.getElementById('players-panel');
  if (!panel) return;
  const list = state.onlinePlayers;
  if (list.length === 0) { panel.innerHTML = ''; return; }

  const myId = state.entityId;
  const rows = list.map((p) => {
    const isMe = p.id === myId;
    const zoneName = p.zone.replace(/_/g, ' ');
    return `<div class="pp-entry${isMe ? ' pp-me' : ''}">
      <span class="pp-name">${isMe ? '▶ ' : ''}${escHtml(p.name)}</span>
      <span class="pp-info">Lv ${p.level} · ${escHtml(zoneName)}</span>
    </div>`;
  }).join('');

  panel.innerHTML = `<div class="pp-header">Online (${list.length})</div>${rows}`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Post-join setup
// ---------------------------------------------------------------------------

async function handleJoinSuccess(resp: JoinResponse): Promise<void> {
  // Defensive: a malformed/zoneless response must not hard-crash the client.
  if (!resp.self || !resp.zone) {
    showLoginScreen();
    setAuthError(resp.error || 'Join failed: server returned no zone.');
    return;
  }
  state.entityId = resp.entityId;
  state.self     = resp.self;
  state.zone     = resp.zone;
  showZoneBanner(resp.zone);

  const [ts, qs] = await Promise.all([
    fetch(`${BACKEND}/tilesets/overworld`),
    fetch(`${BACKEND}/api/quests`),
  ]);
  if (ts.ok) state.tileset = await ts.json();
  if (qs.ok) {
    const payload = (await qs.json()) as QuestsApiPayload;
    state.questDefs    = payload.defs    || {};
    state.questsByGiver = payload.byGiver || {};
  }

  await fetchOnlinePlayers();
  setInterval(fetchOnlinePlayers, 30_000);

  gameMenuBtn.classList.add('visible');
  window.dispatchEvent(new CustomEvent('mmo:ready'));
}

// ---------------------------------------------------------------------------
// Join flow
// ---------------------------------------------------------------------------

async function doListAndSelect(): Promise<void> {
  let token: string;
  try {
    token = await getIdToken();
  } catch (err) {
    console.error('[auth] getIdToken failed:', err);
    showLoginScreen();
    setAuthError('Could not get auth token. Please sign in again.');
    return;
  }

  socket.emit('list_characters', { firebase_token: token }, (resp) => {
    if (resp.error) {
      showLoginScreen();
      setAuthError(resp.error);
      return;
    }
    if (resp.characters.length === 0) {
      // No characters yet — go straight to creation
      void (async () => {
        const picked = await promptNameAndClass();
        let freshToken: string;
        try { freshToken = await getIdToken(); }
        catch { showLoginScreen(); return; }
        void doJoinWithNew(freshToken, picked);
      })();
      return;
    }
    showCharSelect(resp.characters, token);
  });
}

async function doJoinAsCharacter(token: string, characterId: string): Promise<void> {
  socket.emit('join', { firebase_token: token, character_id: characterId }, async (resp) => {
    if (resp.error) {
      showLoginScreen();
      setAuthError(resp.error);
      return;
    }
    await handleJoinSuccess(resp);
  });
}

async function doJoinWithNew(token: string, picked: { name: string; klass: ClassId; color: string }): Promise<void> {
  socket.emit('join', { firebase_token: token, name: picked.name, klass: picked.klass, color: picked.color }, async (resp) => {
    if (resp.error) {
      setAuthError('Character creation failed. Please try again.');
      return;
    }
    await handleJoinSuccess(resp);
  });
}

// ---------------------------------------------------------------------------
// Firebase auth state drives the socket lifecycle
// ---------------------------------------------------------------------------

auth.onAuthStateChanged(async (user) => {
  console.log('[auth] onAuthStateChanged user=', user?.uid ?? null);
  if (!user) {
    gameMenuBtn.classList.remove('visible');
    if (socket.connected) socket.disconnect();
    showLoginScreen();
    return;
  }
  hideLoginScreen();
  if (!socket.connected) socket.connect();
  else void doListAndSelect();
});

socket.on('connect',       () => { console.log('[socket] connected, sid=', socket.id); void doListAndSelect(); });
socket.on('connect_error', (err) => { console.error('[socket] connect_error:', err); });
socket.on('disconnect',    (reason) => { console.log('[socket] disconnected:', reason); });

// ---------------------------------------------------------------------------
// In-game socket events
// ---------------------------------------------------------------------------

socket.on('quests', ({ quests }) => {
  const prevStages = new Map(state.quests?.active?.map((q) => [q.questId, q.stage]) ?? []);
  const prevActive = new Set(prevStages.keys());
  const newCompleted = new Set(quests.completed);
  const newActive = new Set(quests.active.map((q) => q.questId));

  for (const qid of prevActive) {
    if (!newActive.has(qid) && newCompleted.has(qid)) {
      const def = state.questDefs[qid];
      state.questCompletions.push({ name: def?.name || qid, t: performance.now() });
    }
  }

  const now = performance.now();
  for (const entry of quests.active) {
    const prev = prevStages.get(entry.questId);
    if (prev !== undefined && prev !== entry.stage) {
      state.questStageAdvances.push({ questId: entry.questId, stage: entry.stage, t: now } as QuestStageAdvance);
    }
  }

  state.quests = quests;
  window.dispatchEvent(new CustomEvent('mmo:quests'));
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

socket.on('died', (_ev) => {
  state.died = true;
  state.diedAt = performance.now();
});

socket.on('respawn', ({ zone, self }) => {
  const previousId = state.zone?.id;
  state.zone = zone;
  state.self = self;
  state.died = false;
  if (zone.id !== previousId) showZoneBanner(zone);
  window.dispatchEvent(new CustomEvent('mmo:zone'));
});

socket.on('combat',  (ev) => { state.combatEvents.push({ ...ev, t: performance.now() }); });

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

socket.on('self',   ({ self }) => { state.self = self; window.dispatchEvent(new CustomEvent('mmo:self')); });
socket.on('pickup', (ev)        => { state.pickupFloats.push({ ...ev, t: performance.now() }); });

socket.on('chat', (msg) => {
  state.chatLog.push({ ...msg, recvAt: performance.now() });
  if (state.chatLog.length > 30) state.chatLog.shift();
  state.speech.set(msg.from.id, { text: msg.text, t: performance.now() });
  window.dispatchEvent(new CustomEvent('mmo:chat', { detail: msg }));
});

socket.on('open_map', () => {
  window.dispatchEvent(new CustomEvent('mmo:open_map'));
});

export { socket };
