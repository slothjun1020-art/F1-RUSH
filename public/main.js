// UI flow: start screen -> lobby -> race -> results.

import { Net } from './net.js';
import { RaceView, formatTime } from './game.js';
import { attachInput, requestReset, clearInput } from './input.js';
import { drawTrackFit } from './render.js';
import { Renderer2D } from './view2d.js';
import { getTrack, trackList } from '/shared/tracks.js';
import { normalizeCode, sanitizeNick, MAX_PLAYERS } from '/shared/protocol.js';

const $ = (id) => document.getElementById(id);
const screens = { start: $('screen-start'), lobby: $('screen-lobby'), results: $('screen-results') };
const canvas = $('game');
const canvas3d = $('game3d');
const labelLayer = $('labels');
const hudEl = $('hud');
const hud = {
  lap: $('hud-lap'), pos: $('hud-pos'), time: $('hud-time'), speed: $('hud-speed'),
  board: $('hud-board'), center: $('hud-center'), minimap: $('minimap'),
  dbg: { ping: $('dbg-ping'), fps: $('dbg-fps') },
};

// Small corner overlay of ping and frame rate, only with ?debug=1 in the address (the separate ?debug
// flag below, with no value required, is the older hook automated tests use to reach the live race).
const debugHud = new URLSearchParams(location.search).get('debug') === '1';
$('debug-hud').hidden = !debugHud;

let net = null;
let meId = null;
let room = null;
let race = null;
let toastTimer = 0;
let confirmOpen = false;   // the "really leave?" dialog; driving keys are ignored while it is up

attachInput(() => race !== null && !confirmOpen);
// Automated browser tests read the live race through this hook (opt-in via ?debug).
if (new URLSearchParams(location.search).has('debug')) {
  window.__f1 = { get race() { return race; } };
}

// ---- helpers ------------------------------------------------------------

function toast(text, ms = 2600) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

let raceVisible = false;

function show(name) {
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
  raceVisible = name === 'race' || name === 'results';
  hudEl.hidden = !raceVisible;
  syncCanvases();
  if (name === 'race') for (const el of Object.values(screens)) el.hidden = true;
}

// ---- 2D / 3D view -------------------------------------------------------
// The race is drawn either by the original top-down renderer or by the 3D chase-camera one.
// Default is 3D; `?view=2d` forces the old view, and the V key flips it live (there is no on-screen button).

function initialView() {
  const q = new URLSearchParams(location.search).get('view');
  if (q === '2d' || q === '3d') return q;
  try {
    const saved = localStorage.getItem('f1rush.view');
    if (saved === '2d' || saved === '3d') return saved;
  } catch { /* storage may be unavailable */ }
  return '3d';
}

let view = initialView();
let renderer2d = null;
let renderer3d = null;
let webglFailed = false;
const quality = Number(new URLSearchParams(location.search).get('q')) || 0;

function syncCanvases() {
  canvas.hidden = !(raceVisible && view === '2d');
  canvas3d.hidden = !(raceVisible && view === '3d');
  labelLayer.hidden = canvas3d.hidden;
}

// Load Three.js in the background so the first 3D race starts without a stall.
if (view === '3d') import('./view3d.js').catch(() => {});

async function ensureRenderer() {
  if (view === '3d' && !renderer3d && !webglFailed) {
    try {
      const { Renderer3D } = await import('./view3d.js');
      renderer3d = new Renderer3D({ canvas: canvas3d, labels: labelLayer, quality });
    } catch (err) {
      console.warn('3D view unavailable, using 2D:', err);
      webglFailed = true;
    }
  }
  if (view === '3d' && !renderer3d) {
    view = '2d';
    toast('이 브라우저에서는 3D 화면을 쓸 수 없어 2D 화면으로 전환했어요', 4000);
  }
  if (view === '2d' && !renderer2d) renderer2d = new Renderer2D(canvas);
  return view === '3d' ? renderer3d : renderer2d;
}

async function toggleView() {
  if (!race || webglFailed) return;
  view = view === '3d' ? '2d' : '3d';
  try { localStorage.setItem('f1rush.view', view); } catch { /* ignore */ }
  const next = await ensureRenderer();
  race?.setRenderer(next);
  syncCanvases();
  toast(view === '3d' ? '3D 화면' : '2D 화면', 1200);
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyV' && !e.repeat && race && !confirmOpen) toggleView();
  if (e.key === 'Escape' && confirmOpen) closeConfirm();
});

// HUD buttons. They must never take keyboard focus, otherwise the Space bar (brake) would "click" them.
for (const id of ['btn-reset', 'btn-quit']) {
  const b = $(id);
  b.tabIndex = -1;
  b.addEventListener('mousedown', (e) => e.preventDefault());
}
$('btn-reset').onclick = (e) => { requestReset(); e.currentTarget.blur(); };
$('btn-quit').onclick = (e) => { e.currentTarget.blur(); askToLeave(); };

function storedNick() {
  try { return localStorage.getItem('f1rush.nick') ?? ''; } catch { return ''; }
}
function storeNick(nick) {
  try { localStorage.setItem('f1rush.nick', nick); } catch { /* storage may be unavailable */ }
}

function stopRace() {
  if (race) race.stop();
  race = null;
}

// ---- leaving ------------------------------------------------------------
// "Leaving" means leaving the room: the others see you as DNF, and you go back to the start screen.

function closeConfirm() {
  confirmOpen = false;
  $('confirm').hidden = true;
  document.activeElement?.blur?.();
}

function askToLeave() {
  if (!race) return;
  if (room?.phase === 'results') { leaveToStart(); return; } // the race is over, nothing to lose
  confirmOpen = true;
  clearInput();
  $('confirm').hidden = false;
  $('confirm-no').focus(); // the safe choice has the focus, so a stray Space/Enter keeps you racing
}

function leaveToStart() {
  closeConfirm();
  stopRace();
  net?.close();
  net = null;
  room = null;
  meId = null;
  const url = new URL(location.href);
  url.searchParams.delete('room');
  history.replaceState(null, '', url);
  codeInput.value = '';
  startError('');
  $('btn-create').disabled = false;
  $('btn-join').disabled = false;
  show('start');
  toast('방에서 나왔어요');
}

$('confirm-no').onclick = closeConfirm;
$('confirm-yes').onclick = leaveToStart;

// ---- start screen -------------------------------------------------------

const nickInput = $('nick');
const codeInput = $('code');
nickInput.value = storedNick();
const urlRoom = normalizeCode(new URLSearchParams(location.search).get('room') ?? '');
if (urlRoom) codeInput.value = urlRoom;
(nickInput.value ? codeInput : nickInput).focus();

function startError(text) { $('start-error').textContent = text; }

async function enter(message) {
  const nick = sanitizeNick(nickInput.value);
  if (!nick) { startError('닉네임을 입력해 주세요'); nickInput.focus(); return; }
  storeNick(nick);
  startError('');
  $('btn-create').disabled = true;
  $('btn-join').disabled = true;
  try {
    net = new Net();
    bindNet(net);
    await net.connect();
    net.send({ ...message, nick });
  } catch (err) {
    startError(err.message);
    net = null;
    $('btn-create').disabled = false;
    $('btn-join').disabled = false;
  }
}

$('btn-create').onclick = () => enter({ t: 'create' });
$('btn-join').onclick = () => {
  const code = normalizeCode(codeInput.value);
  if (code.length !== 4) { startError('방 코드 4자리를 입력해 주세요'); codeInput.focus(); return; }
  enter({ t: 'join', code });
};
codeInput.addEventListener('input', () => { codeInput.value = normalizeCode(codeInput.value); });
for (const el of [nickInput, codeInput]) {
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    (codeInput.value.length === 4 ? $('btn-join') : $('btn-create')).click();
  });
}

// ---- networking ---------------------------------------------------------

function bindNet(n) {
  n.on('welcome', (m) => { meId = m.id; });
  n.on('room', onRoom);
  n.on('go', onGo);
  n.on('snap', (m) => race?.handleSnap(m));
  n.on('fin', onFin);
  n.on('left', onLeft);
  n.on('results', onResults);
  n.on('err', (m) => {
    if (room) { toast(m.msg); return; }
    startError(m.msg);
    n.close();
    net = null;
    $('btn-create').disabled = false;
    $('btn-join').disabled = false;
  });
  n.on('close', () => {
    stopRace();
    room = null;
    net = null;
    show('start');
    $('btn-create').disabled = false;
    $('btn-join').disabled = false;
    startError('서버와 연결이 끊겼어요. 다시 입장해 주세요');
  });
}

function onRoom(m) {
  room = m;
  if (race) {
    race.setPlayers(m.players);
    if (m.phase === 'lobby') { stopRace(); show('lobby'); renderLobby(); } // host sent everyone back
    else if (!screens.results.hidden) updateResultsControls(); // the host may have changed
    return;
  }
  if (m.phase === 'lobby' || screens.start.hidden === false) show('lobby');
  renderLobby();
}

async function onGo(m) {
  const track = getTrack(m.track);
  stopRace();
  const renderer = await ensureRenderer();
  renderer.setTrack?.(track);
  show('race');
  race = new RaceView({
    renderer, hud, net, track, laps: m.laps, startAt: m.startAt, grid: m.grid, meId, players: room.players,
    debug: debugHud,
    onLap: (n, ms, done) => {
      if (!done) toast(`LAP ${n} 완료  ${formatTime(ms)}`);
    },
    onReset: () => toast('트랙으로 복귀했어요', 1200),
  });
  race.start();
}

// Someone left (or dropped). During a race they stay on the leaderboard as DNF; if they were the host, say who is now.
function onLeft(m) {
  race?.handleLeft(m);
  let text = m.dnf ? `${m.nick} 님이 나갔어요 (기록 없음)` : `${m.nick} 님이 나갔어요`;
  if (m.hostChanged) {
    const host = room?.players.find((p) => p.id === m.hostId);
    if (m.hostId === meId) text += ' · 이제 내가 방장이에요';
    else if (host) text += ` · ${host.nick} 님이 새 방장이에요`;
  }
  toast(text, 3800);
}

function onFin(m) {
  race?.handleFin(m);
  if (m.id !== meId && race) {
    const p = room?.players.find((x) => x.id === m.id);
    if (p) toast(`🏁 ${p.nick} 님 ${m.place}위 완주  ${formatTime(m.time)}`, 3200);
  }
}

// ---- lobby --------------------------------------------------------------

const trackCards = new Map();
function buildTrackCards() {
  const wrap = $('tracks');
  for (const info of trackList()) {
    const btn = document.createElement('button');
    btn.className = 'track';
    btn.dataset.id = info.id;
    const cv = document.createElement('canvas');
    cv.width = 240;
    cv.height = 160;
    drawTrackFit(cv.getContext('2d'), getTrack(info.id), cv.width, cv.height, { color: info.color, margin: 12 });
    const name = document.createElement('b');
    name.textContent = info.name;
    const meta = document.createElement('small');
    meta.textContent = `${info.country} · ${info.km}km`;
    btn.append(cv, name, meta);
    btn.onclick = () => net?.send({ t: 'track', id: info.id });
    wrap.append(btn);
    trackCards.set(info.id, btn);
  }
}
buildTrackCards();

function renderLobby() {
  if (!room) return;
  const isHost = room.hostId === meId;
  const inLobby = room.phase === 'lobby';
  $('lobby-code').textContent = room.code;
  document.querySelector('.lobby').classList.toggle('guest', !isHost);
  $('pcount').textContent = `${room.players.length}/${MAX_PLAYERS}`;

  const list = $('plist');
  list.replaceChildren(...room.players.map((p) => {
    const li = document.createElement('li');
    if (p.id === meId) li.className = 'me';
    const dot = document.createElement('i');
    dot.style.background = p.color;
    const nick = document.createElement('span');
    nick.className = 'nick';
    nick.textContent = p.nick + (p.id === meId ? ' (나)' : '');
    const tag = document.createElement('span');
    tag.className = 'tag';
    if (p.id === room.hostId) { tag.classList.add('host'); tag.textContent = '👑 방장'; }
    else if (p.ready) { tag.classList.add('ok'); tag.textContent = '준비 완료'; }
    else tag.textContent = '대기 중';
    li.append(dot, nick, tag);
    return li;
  }));

  for (const [id, btn] of trackCards) {
    btn.classList.toggle('selected', id === room.track);
    btn.disabled = !isHost || !inLobby;
  }
  $('track-hint').textContent = isHost ? '방장이 고를 수 있어요' : '방장이 선택해요';

  const me = room.players.find((p) => p.id === meId);
  const others = room.players.filter((p) => p.id !== room.hostId);
  const allReady = others.every((p) => p.ready);
  $('btn-ready').hidden = isHost;
  $('btn-ready').disabled = !inLobby;
  $('btn-ready').textContent = me?.ready ? '준비 취소' : '준비';
  $('btn-start').hidden = !isHost;
  $('btn-start').disabled = !inLobby || !allReady;
  let hint = '';
  if (!inLobby) hint = '레이스 결과를 확인 중이에요';
  else if (isHost) hint = others.length === 0 ? '친구에게 방 코드를 알려 주세요 (혼자서도 연습할 수 있어요)' : allReady ? '' : '모두 준비하면 출발할 수 있어요';
  else hint = me?.ready ? '방장이 시작하길 기다리는 중…' : '준비 버튼을 눌러 주세요';
  $('lobby-hint').textContent = hint;
}

$('btn-ready').onclick = () => {
  const me = room?.players.find((p) => p.id === meId);
  net?.send({ t: 'ready', ready: !me?.ready });
};
$('btn-start').onclick = () => net?.send({ t: 'start' });
$('btn-copy').onclick = async () => {
  const url = `${location.origin}/?room=${room.code}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('초대 링크를 복사했어요');
  } catch {
    toast(`링크: ${url}`, 6000);
  }
};

// ---- results ------------------------------------------------------------

function onResults(m) {
  show('results');
  const info = room ? trackList().find((t) => t.id === room.track) : null;
  $('res-track').textContent = info ? `${info.name} · ${m.laps}바퀴` : '';
  const body = $('res-table').tBodies[0];
  body.replaceChildren(...m.rows.map((r) => {
    const tr = document.createElement('tr');
    const dnf = !r.finished && r.left;                 // left mid-race without finishing: no time
    tr.className = r.id === meId ? 'me' : dnf ? 'left' : '';
    const cells = [
      dnf ? '–' : r.place === 1 ? '🥇' : r.place === 2 ? '🥈' : r.place === 3 ? '🥉' : String(r.place),
      null,
      r.finished ? formatTime(r.time) : dnf ? 'DNF' : '미완주',
      formatTime(r.best),
    ];
    cells.forEach((text, i) => {
      const td = document.createElement('td');
      if (i === 1) {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = r.color;
        td.append(dot, document.createTextNode(r.left ? `${r.nick} (나감)` : r.nick));
      } else td.textContent = text;
      tr.append(td);
    });
    return tr;
  }));
  updateResultsControls();
}

// Only the host can send everyone back to the lobby. Host can change while this screen is open.
function updateResultsControls() {
  const isHost = room?.hostId === meId;
  $('btn-back').hidden = !isHost;
  $('res-hint').textContent = isHost ? '' : '방장이 로비로 돌아가길 기다리는 중…';
}

$('btn-back').onclick = () => net?.send({ t: 'lobby' });
$('btn-leave').onclick = leaveToStart;
