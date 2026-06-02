import { io } from 'socket.io-client';
import { auth, signInWithGoogle, signInWithEmail, registerWithEmail, getIdToken } from './firebase.ts';
import { state } from './state.ts';
import type {
  ClassId, ClientToServerEvents, Direction, EquipSlot, JoinResponse,
  QuestActionKind, QuestActionResponse, QuestsApiPayload,
  ServerToClientEvents, StatId,
} from '../../shared/types.ts';

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
  died: false,
  diedAt: null,
  chatLog: [],
  speech: new Map<string, { text: string; t: number }>(),
  quests: { active: [], completed: [] },
  questDefs: {},
  questsByGiver: {},
  sendMove: (dir: Direction) => socket.emit('action', { action: 'move', dir }),
  sendAttack: () => socket.emit('action', { action: 'attack' }),
  sendChat: (text: string) => socket.emit('chat', { text }),
  sendAllocate: (stat: StatId) => socket.emit('allocate', { stat }, () => {}),
  sendEquip: (slot: number) => socket.emit('equip', { slot }, () => {}),
  sendUnequip: (slot: EquipSlot) => socket.emit('unequip', { slot }, () => {}),
  sendQuestAction: (questId: string, action: QuestActionKind, talkingTo?: string) =>
    new Promise<QuestActionResponse>((resolve) =>
      socket.emit('quest_action', { questId, action, talkingTo }, resolve)),
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

function promptNameAndClass(): Promise<{ name: string; klass: ClassId }> {
  return new Promise((resolve) => {
    const backdrop = document.getElementById('welcome-backdrop')!;
    const input    = document.getElementById('name-input') as HTMLInputElement;
    const btn      = document.getElementById('enter-btn')!;
    const classBtns = document.querySelectorAll<HTMLElement>('.class-btn');
    let selectedClass: ClassId = 'fighter';

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
      resolve({ name, klass: selectedClass });
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter') submit(); };
    btn.addEventListener('click', submit);
    input.addEventListener('keydown', onKey);
  });
}

// ---------------------------------------------------------------------------
// Zone banner helper
// ---------------------------------------------------------------------------

function showZoneBanner(snap: { id: string; name?: string }): void {
  state.zoneBanner = { name: snap.name || snap.id, t: performance.now() };
}

// ---------------------------------------------------------------------------
// Post-join setup
// ---------------------------------------------------------------------------

async function handleJoinSuccess(resp: JoinResponse): Promise<void> {
  state.entityId = resp.entityId;
  state.self     = resp.self!;
  state.zone     = resp.zone!;
  showZoneBanner(resp.zone!);

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
  window.dispatchEvent(new CustomEvent('mmo:ready'));
}

// ---------------------------------------------------------------------------
// Join flow
// ---------------------------------------------------------------------------

async function doJoin(): Promise<void> {
  console.log('[auth] doJoin: currentUser=', auth.currentUser?.uid ?? null);
  let token: string;
  try {
    token = await getIdToken();
    console.log('[auth] got ID token (length=%d)', token.length);
  } catch (err) {
    console.error('[auth] getIdToken failed:', err);
    showLoginScreen();
    setAuthError('Could not get auth token. Please sign in again.');
    return;
  }

  socket.emit('join', { firebase_token: token }, async (resp) => {
    console.log('[auth] server join response:', resp);
    if (resp.error) {
      showLoginScreen();
      setAuthError(resp.error);
      return;
    }

    if (resp.needsCharacter) {
      // First-time user — prompt for name/class then re-join
      const picked = await promptNameAndClass();
      let freshToken: string;
      try { freshToken = await getIdToken(); }
      catch { showLoginScreen(); return; }

      socket.emit('join', { firebase_token: freshToken, name: picked.name, klass: picked.klass }, async (resp2) => {
        if (resp2.error || resp2.needsCharacter) {
          console.error('[auth] character creation failed:', resp2);
          setAuthError('Character creation failed. Please try again.');
          return;
        }
        await handleJoinSuccess(resp2);
      });
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
    if (socket.connected) socket.disconnect();
    showLoginScreen();
    return;
  }
  hideLoginScreen();
  if (!socket.connected) socket.connect();
  else await doJoin();
});

socket.on('connect',       () => { console.log('[socket] connected, sid=', socket.id); void doJoin(); });
socket.on('connect_error', (err) => { console.error('[socket] connect_error:', err); });
socket.on('disconnect',    (reason) => { console.log('[socket] disconnected:', reason); });

// ---------------------------------------------------------------------------
// In-game socket events
// ---------------------------------------------------------------------------

socket.on('quests', ({ quests }) => {
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

socket.on('respawn', ({ zone, self }) => {
  const previousId = state.zone?.id;
  state.zone = zone;
  state.self = self;
  state.died = true;
  state.diedAt = performance.now();
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

export { socket };
