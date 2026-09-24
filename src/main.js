import './style.css';
import * as THREE from 'three';
import { FIXED_DT } from './config.js';
import { Input } from './input.js';
import { World, CHAPTERS } from './world.js';
import { Player } from './player.js';
import { CameraRig } from './cameraRig.js';
import { Particles, FAIRY_COLORS, DUST_COLORS, FIREWORK_SETS } from './fx.js';
import { Powerups } from './powerups.js';

// ---------------------------------------------------------------- setup

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
// Resolução adaptativa: começa no máximo e baixa sozinha se o FPS cair (ver adaptResolution).
const MAX_DPR = Math.min(window.devicePixelRatio, 2);
const MIN_DPR = Math.max(0.6, MAX_DPR * 0.5);
let dpr = MAX_DPR;
renderer.setPixelRatio(dpr);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(90, window.innerWidth / window.innerHeight, 0.05, 4000);

const world = new World(scene);
const input = new Input(renderer.domElement);
const player = new Player(world);
const rig = new CameraRig(camera, player);
const particles = new Particles(scene);
particles.setViewport(window.innerHeight * dpr, 90);
let powerups = null;

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------- settings

const settings = { sensitivity: 1, fov: 90, headBob: true };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem('fairyjump.settings') || '{}'));
} catch {}

function bindSetting(id, key, fmt) {
  const el = $(id);
  const out = $(`${id}-out`);
  const isCheck = el.type === 'checkbox';
  if (isCheck) el.checked = settings[key];
  else el.value = settings[key];
  const apply = () => {
    settings[key] = isCheck ? el.checked : parseFloat(el.value);
    if (out) out.textContent = fmt(settings[key]);
    rig.baseFov = settings.fov;
    rig.headBob = settings.headBob;
    try { localStorage.setItem('fairyjump.settings', JSON.stringify(settings)); } catch {}
  };
  el.addEventListener('input', apply);
  apply();
}
bindSetting('sens', 'sensitivity', (v) => v.toFixed(2));
bindSetting('fov', 'fov', (v) => `${v}°`);
bindSetting('bob', 'headBob', () => '');

// --------------------------------------------------------------- state

const state = {
  loaded: false,
  running: false,
  timerStarted: false,
  time: 0,
  best: 0,
  won: false,
  checkpoint: null,
  bestChapter: 0,
  falls: 0,
  biggestFall: 0,
  fireworkT: 0,
};
try { state.best = parseFloat(localStorage.getItem('fairyjump.best.mapa') || '0') || 0; } catch {}

function restart() {
  player.spawn(world.spawnPoint, world.spawnYaw);
  world.resetDynamics();
  powerups?.reset();
  Object.assign(state, { time: 0, timerStarted: false, won: false, bestChapter: 0, falls: 0, biggestFall: 0 });
  $('win').hidden = true;
}

let toastTimer = 0;
function toast(text, seconds = 1.6) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  toastTimer = seconds;
}

input.onKey('KeyR', () => { restart(); toast('Recomeçando'); });
input.onKey('KeyF', () => {
  if (!player.grounded) return toast('Precisa estar no chão');
  state.checkpoint = { pos: player.position.clone(), yaw: player.yaw };
  toast('Ponto salvo (treino)');
});
input.onKey('KeyT', () => {
  if (!state.checkpoint) return toast('Nenhum ponto salvo (F)');
  player.spawn(state.checkpoint.pos, state.checkpoint.yaw);
});
input.onKey('F3', () => { $('debug').hidden = !$('debug').hidden; });

// -------------------------------------------------------------- overlay

const overlay = $('overlay');
const playBtn = $('play');
playBtn.addEventListener('click', () => {
  input.lock();
});
playBtn.disabled = true;
playBtn.textContent = 'Carregando mapa...';
world
  .load('models/mapa.glb', (p) => { playBtn.textContent = `Carregando mapa... ${Math.round(p * 100)}%`; })
  .then(() => {
    powerups = new Powerups(world, player, { particles, toast });
    buildTowerBar();
    restart();
    state.loaded = true;
    playBtn.disabled = false;
    playBtn.textContent = 'Clique para jogar';
  })
  .catch((err) => {
    console.error(err);
    playBtn.textContent = 'Erro ao carregar o mapa';
  });

input.onLockChange = (locked) => {
  state.running = locked && state.loaded;
  overlay.hidden = locked;
  if (!locked) {
    playBtn.textContent = 'Continuar';
    $('overlay-subtitle').textContent = 'Pausado';
  }
  accumulator = 0;
};

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ------------------------------------------------------------ tower bar

let towerTop = 420;
function buildTowerBar() {
  towerTop = world.goal?.position.y ?? 420;
  const bar = $('tower-ticks');
  bar.innerHTML = '';
  for (const c of CHAPTERS.slice(1)) {
    const t = document.createElement('div');
    t.className = 'tick';
    t.style.bottom = `${(c.y / towerTop) * 100}%`;
    t.title = c.name;
    t.textContent = c.short;
    bar.appendChild(t);
  }
}

// ------------------------------------------------------------- events

const FALL_LINES = [
  (m) => `Ai! ${m} m abaixo`,
  (m) => `Caiu ${m} m...`,
  (m) => `Que tombo: ${m} m`,
  (m) => `${m} m de volta. Respira.`,
];

function handleEvents() {
  for (const e of player.events) {
    switch (e.type) {
      case 'doubleJump':
        particles.burst(player.position, { count: 40, speed: 3, colors: FAIRY_COLORS, life: 0.9, gravity: 1.5, size: 0.06, spread: 0.3 });
        break;
      case 'land': {
        if (e.impact > 14) {
          particles.burst(player.position, {
            count: Math.min(60, Math.round(e.impact)), speed: 2 + e.impact * 0.08, up: 1, colors: DUST_COLORS,
            life: 0.8, gravity: 4, size: 0.08, spread: 0.3,
          });
        }
        if (e.fallHeight > 25) {
          const m = Math.round(e.fallHeight);
          state.falls++;
          state.biggestFall = Math.max(state.biggestFall, m);
          toast(FALL_LINES[state.falls % FALL_LINES.length](m), 2.2);
        }
        break;
      }
    }
  }
  for (const e of world.events) {
    if (e.type === 'tileFall') {
      particles.burst(e.position, { count: 30, speed: 2, colors: ['#ffffff', '#ffd6e6', '#222222'], life: 1, gravity: 3, size: 0.1, spread: 0.8 });
    }
  }
  world.events.length = 0;
}

function win() {
  state.won = true;
  toast('Felizes para sempre!', 4);
  $('win-time').textContent = formatTime(state.time);
  $('win-falls').textContent = String(state.falls);
  $('win-fall').textContent = `${state.biggestFall} m`;
  $('win').hidden = false;
}

function updateFireworks(dt) {
  if (!state.won || !world.goal) return;
  state.fireworkT -= dt;
  if (state.fireworkT > 0) return;
  state.fireworkT = 0.35 + Math.random() * 0.4;
  const g = world.goal.position;
  const a = Math.random() * Math.PI * 2;
  const r = 8 + Math.random() * 18;
  const pos = new THREE.Vector3(g.x + Math.cos(a) * r, g.y + 6 + Math.random() * 18, g.z + Math.sin(a) * r);
  particles.burst(pos, {
    count: 110, speed: 9, colors: FIREWORK_SETS[(Math.random() * FIREWORK_SETS.length) | 0],
    life: 1.6, gravity: 3, drag: 1.2, size: 0.6,
  });
}

// ----------------------------------------------------------------- loop

const heightEl = $('height');
const bestEl = $('best');
const timerEl = $('timer');
const chapterEl = $('chapter');
const debugEl = $('debug');
const windEl = $('wind');
const effectEl = $('effect');
const effectFill = $('effect-fill');
const effectLabel = $('effect-label');
const towerMe = $('tower-me');
const towerBest = $('tower-best');
const _interp = new THREE.Vector3();
const _chest = new THREE.Vector3();

function formatTime(t) {
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

let accumulator = 0;
let last = performance.now();
let elapsed = 0;
let fps = 0;
let frameMs = 16;
let slowT = 0;
let fastT = 0;

function adaptResolution(dt) {
  frameMs += (dt * 1000 - frameMs) * 0.1;
  if (!state.running) return;
  if (frameMs > 22) { slowT += dt; fastT = 0; }
  else if (frameMs < 17.5) { fastT += dt; slowT = 0; }
  else { slowT = fastT = 0; }
  let next = dpr;
  if (slowT > 0.75) { next = Math.max(MIN_DPR, dpr - 0.15); slowT = 0; }
  else if (fastT > 3) { next = Math.min(MAX_DPR, dpr + 0.1); fastT = 0; }
  if (next !== dpr) { dpr = next; renderer.setPixelRatio(dpr); }
}
const perf = { sim: 0, upd: 0, render: 0 }; // ms médios por frame (F3)
const ema = (k, v) => { perf[k] += (v - perf[k]) * 0.05; };


function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  elapsed += dt;
  fps += (1 / Math.max(dt, 1e-4) - fps) * 0.05;
  adaptResolution(dt);

  if (state.running) {
    const m = input.consumeMouse();
    player.look(m.x, m.y, settings.sensitivity);

    const tSim = performance.now();
    accumulator += dt;
    let ticks = 0;
    while (accumulator >= FIXED_DT && ticks < 12) {
      world.fixedUpdate(FIXED_DT, player);
      player.fixedUpdate(FIXED_DT, input);
      accumulator -= FIXED_DT;
      ticks++;
    }
    if (ticks === 12) accumulator = 0;
    ema('sim', performance.now() - tSim);

    if (!state.timerStarted && (input.moveX || input.moveZ || input.jump)) state.timerStarted = true;
    if (state.timerStarted && !state.won) state.time += dt;

    if (player.position.y < -60) {
      restart();
      toast('Você caiu do mundo!');
    }

    const chapter = world.chapterAt(player.position.y);
    if (chapter > state.bestChapter) {
      state.bestChapter = chapter;
      toast(CHAPTERS[chapter].name, 3);
      // Anel de pó de fada em volta do jogador (longe o bastante da câmera)
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        _chest.set(player.position.x + Math.cos(a) * 2.5, player.position.y + 0.8, player.position.z + Math.sin(a) * 2.5);
        particles.burst(_chest, { count: 6, speed: 1.2, up: 1.5, colors: FAIRY_COLORS, life: 1.4, gravity: 0.3, size: 0.07, spread: 0.2 });
      }
    }

    const g = world.goal;
    _chest.copy(player.position).y += 0.9;
    if (!state.won && g && _chest.distanceTo(g.position) < g.radius) win();

    handleEvents();
  }

  const tUpd = performance.now();
  const alpha = accumulator / FIXED_DT;
  rig.update(dt, alpha, elapsed);
  player.getInterpolatedPosition(alpha, _interp);
  world.update(dt, elapsed, _interp);
  if (state.running) powerups?.update(dt, elapsed, rig.eye);
  updateFireworks(dt);
  particles.update(dt);
  ema('upd', performance.now() - tUpd);

  // Vento
  windEl.style.opacity = THREE.MathUtils.clamp((-player.velocity.y - 18) / 30, 0, 0.85).toFixed(3);

  // HUD
  const h = Math.max(0, player.position.y);
  if (h > state.best) {
    state.best = h;
    try { localStorage.setItem('fairyjump.best.mapa', String(h)); } catch {}
  }
  heightEl.textContent = `${h.toFixed(1)} m`;
  bestEl.textContent = `${state.best.toFixed(1)} m`;
  timerEl.textContent = formatTime(state.time);
  chapterEl.textContent = CHAPTERS[world.chapterAt(player.position.y)].name;
  towerMe.style.bottom = `${Math.min(100, (h / towerTop) * 100)}%`;
  towerBest.style.bottom = `${Math.min(100, (state.best / towerTop) * 100)}%`;

  const eff = powerups?.effectInfo;
  effectEl.hidden = !eff && !powerups?.fairyDust;
  if (eff) {
    effectLabel.textContent = eff.key === 'shrink' ? 'Beba-me' : 'Coma-me';
    effectFill.style.width = `${(eff.remaining / eff.duration) * 100}%`;
    effectFill.style.background = eff.color;
  } else if (powerups?.fairyDust) {
    effectLabel.textContent = 'Pó de fada: pulo duplo';
    effectFill.style.width = player.usedDoubleJump ? '0%' : '100%';
    effectFill.style.background = '#ffe27a';
  }

  if (toastTimer > 0) {
    toastTimer -= dt;
    if (toastTimer <= 0) $('toast').classList.remove('show');
  }

  if (!debugEl.hidden) {
    const v = player.velocity;
    debugEl.textContent =
      `fps      ${fps.toFixed(0)}  resolução ${Math.round((dpr / MAX_DPR) * 100)}%\n` +
      `pos      ${player.position.x.toFixed(2)} ${player.position.y.toFixed(2)} ${player.position.z.toFixed(2)}\n` +
      `vel h/v  ${player.horizontalSpeed.toFixed(2)} / ${v.y.toFixed(2)}\n` +
      `chão     ${player.grounded ? player.groundCollider?.name ?? 'sim' : 'não'}  n.y ${player.groundNormal.y.toFixed(2)}\n` +
      `escalada ${player.mantle ? 'sim' : 'não'}\n` +
      `ar       ${player.airTime.toFixed(2)} s\n` +
      `draws    ${renderer.info.render.calls}  tris ${(renderer.info.render.triangles / 1000).toFixed(0)}k
` +
      `ms       física ${perf.sim.toFixed(2)}  mundo ${perf.upd.toFixed(2)}  render ${perf.render.toFixed(2)}`;
  }

  particles.setViewport(renderer.domElement.height, camera.fov);
  const tRender = performance.now();
  renderer.render(scene, camera);
  ema('render', performance.now() - tRender);
}
requestAnimationFrame(frame);
