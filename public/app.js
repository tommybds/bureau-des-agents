import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// =====================================================================
// Constantes
// =====================================================================
const STATUS = {
  working: { label: 'Au travail', color: '#4ade80' },
  waiting: { label: "T'attend", color: '#fbbf24' },
  idle:    { label: 'En pause', color: '#8b95a5' },
};
const CLAUDE = 0xd97757;
const CEIL = 2.75;                // hauteur sous faux plafond
const ZN = -3.4;                  // mur des fenêtres (nord) ; la pièce s'étend vers le sud
const XE = 12;                    // mur est : salon, niche de la cuisine
const GROUND_REF = -9;            // niveau de la rue pour lequel le décor extérieur est construit
let GROUND = GROUND_REF;          // niveau réel de la rue, selon l'étage (voir buildBuilding)
const HUB = { x: 7.6, z: 2 };     // carrefour entre les postes et le salon (recalculé)
const TOKEN = document.querySelector('meta[name=token]')?.content || '';
// Réglages venus de config.json (via le serveur) : décor, costumes par projet, orientation des fenêtres
let CONFIG = { decor: 'neutre', costumes: {}, fenetres: 'sud', etage: 3, etages: 3 };
const costumeFor = (project) => Object.entries(CONFIG.costumes).find(([name]) => name.toLowerCase() === String(project).toLowerCase())?.[1];
const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('agents3d.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('agents3d.' + k, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
};

// =====================================================================
// Rendu
// =====================================================================
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.prepend(renderer.domElement);
const canvasEl = renderer.domElement;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fb8dc);
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 1500);
camera.rotation.order = 'YXZ';
let yaw = -2.35, pitch = -0.1;
camera.position.set(5.2, 1.65, 4.6);
camera.rotation.set(pitch, yaw, 0);

// =====================================================================
// Outils
// =====================================================================
const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0, ...o });
function box(w, h, d, m, x = 0, y = 0, z = 0, parent = scene, rounded = 0) {
  const geo = rounded ? new RoundedBoxGeometry(w, h, d, 2, rounded) : new THREE.BoxGeometry(w, h, d);
  const mesh = new THREE.Mesh(geo, m);
  mesh.position.set(x, y, z);
  mesh.castShadow = mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'); draw?.(ctx, w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return { canvas: c, ctx, tex: t };
}
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
function fitText(ctx, text, maxW) {
  text = text || '';
  if (ctx.measureText(text).width <= maxW) return text;
  while (text.length > 1 && ctx.measureText(text + '…').width > maxW) text = text.slice(0, -1);
  return text + '…';
}
function wrap(ctx, text, maxW, maxLines) {
  const words = (text || '').split(/\s+/); const lines = []; let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; if (lines.length === maxLines) break; }
    else cur = t;
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length === maxLines) lines[maxLines - 1] = fitText(ctx, lines[maxLines - 1] + ' …', maxW);
  return lines;
}
const ago = (iso) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "à l'instant"; if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  return `il y a ${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}`;
};
const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hashHue = (s) => { let h = 7; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
const projColor = (name) => new THREE.Color().setHSL(hashHue(name) / 360, 0.6, 0.52);
const fmt = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' G' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' M' : n >= 1e3 ? Math.round(n / 1e3) + ' k' : String(n)).replace('.', ',');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dur = (ms) => { const m = Math.round((ms || 0) / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`; };
const eur = (usd) => { const v = (usd || 0) * (lastStats?.fx?.eurPerUsd || 0.92); return v.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: v >= 100 ? 0 : 2 }); };
const damp = (k, dt) => 1 - Math.exp(-k * dt);
const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
function disposeTree(o) {
  o.traverse((c) => {
    c.geometry?.dispose?.();
    if (c.material?.map?.isCanvasTexture) c.material.map.dispose();
  });
}
const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), q1 = new THREE.Quaternion();

// =====================================================================
// Lumières
// =====================================================================
const hemi = new THREE.HemisphereLight(0xfff6ec, 0x8a7a6a, 1.1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff0dd, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);

// =====================================================================
// Collisions (boîtes au sol)
// =====================================================================
const staticObs = [], dynObs = [];
let obsTarget = staticObs;
const block = (x, z, w, d) => obsTarget.push({ x0: x - w / 2, x1: x + w / 2, z0: z - d / 2, z1: z + d / 2 });
let shellX0 = 2, shellZ1 = 6.6; // mur ouest et mur sud (la pièce est carrée)
const PR = 0.3;
const MEET = { x0: 0, x1: 0, z0: 0, z1: 0, door: 0 }; // salle de réunion en face (remplie par buildBuilding)
const CORR = { x0: -20, x1: 20 };                       // longueur du couloir (idem)
// où l'on marche : notre étage, le hall du rez-de-chaussée (et la rue devant), ou le toit-terrasse
let level = 'bureau';
const BLD = { hallY: -13, top: 3.2, spots: {}, obs: { rdc: [], toit: [] }, wc: [0, 0, 0, 0], wcDoor: [0, 0, 0, 0] }; // rempli par buildBuilding
const levelY = () => (level === 'rdc' ? BLD.hallY : level === 'toit' ? BLD.top : 0);
const floorName = (n) => (n === 0 ? 'rez-de-chaussée' : n === 1 ? '1er étage' : `${n}e étage`);
const inRect = (x, z, [a, b, c, d], m = 0) => x > a + m && x < b - m && z > c + m && z < d - m;
function collidesElsewhere(x, z) {
  const hitObs = (list) => list.some((o) => x > o[0] - PR && x < o[1] + PR && z > o[2] - PR && z < o[3] + PR);
  if (level === 'toit') return !BLD.inRoof(x, z) || hitObs(BLD.obs.toit);
  return !(inRect(x, z, BLD.hall, 0.3) || inRect(x, z, BLD.entrance) || inRect(x, z, BLD.street)) || hitObs(BLD.obs.rdc);
}
function collides(x, z) {
  if (level !== 'bureau') return collidesElsewhere(x, z);
  const zc0 = shellZ1 + 0.2, zc1 = zc0 + CORW;
  const inRoom = x > shellX0 + 0.3 && x < XE - 0.3 && z > ZN + 0.22 && z < shellZ1 - 0.3;
  const inDoor = doorIsOpen() && x > shellX0 + 1.32 && x < shellX0 + 1.98 && z > shellZ1 - 0.4 && z < zc0 + 0.4;
  const inCorr = x > CORR.x0 + 0.4 && x < CORR.x1 - 0.4 && z > zc0 + 0.28 && z < zc1 - 0.28;
  const inMeet = x > MEET.x0 + 0.3 && x < MEET.x1 - 0.3 && z > MEET.z0 + 0.3 && z < MEET.z1 - 0.3;
  const inMeetDoor = x > MEET.door - 0.33 && x < MEET.door + 0.33 && z > zc1 - 0.4 && z < MEET.z0 + 0.4;
  const inWC = inRect(x, z, BLD.wc, 0.3) || inRect(x, z, BLD.wcDoor);
  if (!inRoom && !inDoor && !inCorr && !inMeet && !inMeetDoor && !inWC) return true;
  const hit = (o) => x > o.x0 - PR && x < o.x1 + PR && z > o.z0 - PR && z < o.z1 + PR;
  return staticObs.some(hit) || dynObs.some(hit);
}

// =====================================================================
// Matériaux partagés
// =====================================================================
const wallM = mat(0xf3eee6, { roughness: 0.9 });
const metal = mat(0x3a3633, { roughness: 0.4, metalness: 0.6 });
const dark = mat(0x1f1c1a, { roughness: 0.4 });
const panelM = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4e2, emissiveIntensity: 1.2 });
const paperM = mat(0xfbfaf6, { roughness: 0.9 });
const bodyM = mat(CLAUDE, { roughness: 0.55 });
const skinM = mat(0xf5ede2, { roughness: 0.5 });
const eyeM = mat(0x1a1614, { roughness: 0.2 });
const shirtM = mat(0xa9c5df, { roughness: 0.85 });  // chemise bleu ciel
const chinoM = mat(0xe9e5db, { roughness: 0.9 });   // chino blanc
const hairM = mat(0x3a2a1f, { roughness: 0.95 });   // cheveux et barbe bruns
const helmetM = mat(0x1d1e20, { roughness: 0.55 });   // casque jet adventure noir mat
const trimM = mat(0x3a3c40, { roughness: 0.4, metalness: 0.4 });
const visorM = new THREE.MeshStandardMaterial({ color: 0x1a1e24, roughness: 0.12, metalness: 0.35, side: THREE.DoubleSide });


// =====================================================================
// Textures procédurales
// =====================================================================
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const repeatTex = (t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; return t; };
const carpetTex = repeatTex(canvasTex(256, 256, (ctx, w, h) => {
  ctx.fillStyle = '#2d2f32'; ctx.fillRect(0, 0, w, h);
  const r = rng(3);
  for (let i = 0; i < 9000; i++) { const v = 30 + Math.floor(r() * 26); ctx.fillStyle = `rgb(${v},${v + 1},${v + 4})`; ctx.fillRect(r() * w, r() * h, 1.5, 1.5); }
}).tex);
const pineTex = repeatTex(canvasTex(1024, 128, (ctx, w, h) => {
  ctx.fillStyle = '#d8a767'; ctx.fillRect(0, 0, w, h);
  const r = rng(11);
  for (let i = 0; i < 70; i++) {
    ctx.strokeStyle = `rgba(${150 + r() * 40},${95 + r() * 30},${40 + r() * 20},${0.15 + r() * 0.25})`; ctx.lineWidth = 1 + r() * 2;
    const y = r() * h; ctx.beginPath(); ctx.moveTo(0, y);
    for (let x = 0; x <= w; x += 64) ctx.lineTo(x, y + Math.sin(x / 90 + i) * 4);
    ctx.stroke();
  }
  for (let i = 0; i < 5; i++) { ctx.fillStyle = 'rgba(140,85,35,.45)'; ctx.beginPath(); ctx.ellipse(r() * w, r() * h, 10, 5, 0, 0, 7); ctx.fill(); }
}).tex);
const tileTex = repeatTex(canvasTex(128, 128, (ctx, w, h) => {
  ctx.fillStyle = '#f3f2ee'; ctx.fillRect(0, 0, w, h);
  const r = rng(5);
  for (let i = 0; i < 500; i++) { ctx.fillStyle = `rgba(160,155,150,${r() * 0.18})`; ctx.fillRect(r() * w, r() * h, 1, 1); }
  ctx.strokeStyle = '#c5c2bc'; ctx.lineWidth = 4; ctx.strokeRect(0, 0, w, h);
}).tex);
const osbTex = repeatTex(canvasTex(256, 256, (ctx, w, h) => {
  ctx.fillStyle = '#c9a46a'; ctx.fillRect(0, 0, w, h);
  const r = rng(9);
  for (let i = 0; i < 260; i++) {
    const l = 45 + r() * 25; ctx.fillStyle = `hsl(${30 + r() * 12}, ${35 + r() * 20}%, ${l}%)`;
    ctx.save(); ctx.translate(r() * w, r() * h); ctx.rotate(r() * Math.PI);
    ctx.fillRect(-18 - r() * 12, -4 - r() * 3, 36 + r() * 24, 8 + r() * 6); ctx.restore();
  }
}).tex);

// =====================================================================
// Matériaux intérieurs
// =====================================================================
const carpetM = mat(0xffffff, { map: carpetTex, roughness: 1 });
const pineM = mat(0xffffff, { map: pineTex, roughness: 0.55 });
const ceilTileM = mat(0xffffff, { map: tileTex, roughness: 0.9, emissive: 0xffffff, emissiveMap: tileTex, emissiveIntensity: 0.12 });
const winFrameM = mat(0x2b2d31, { roughness: 0.45, metalness: 0.3 });
const blindM = mat(0xf1f1ee, { roughness: 0.6 });
const winGlassM = new THREE.MeshBasicMaterial({ color: 0xcfe3ee, transparent: true, opacity: 0.07, depthWrite: false });
const futonM = mat(0x8f9294, { roughness: 0.95 });
const greenM = mat(0x2f7a45, { roughness: 0.8 });
const copperM = mat(0xc47a45, { metalness: 0.3, roughness: 0.35 });
const blackM = mat(0x1e1f22, { roughness: 0.6 });
const whiteM = mat(0xf2f1ec, { roughness: 0.7 });

// =====================================================================
// Grand écran de stats et tableau blanc (placés par buildShell)
// =====================================================================
const statsTex = canvasTex(1800, 770);
const statsScreen = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 1.07), new THREE.MeshBasicMaterial({ map: statsTex.tex, toneMapped: false }));
statsScreen.rotation.y = -Math.PI / 2; scene.add(statsScreen);
const statsFrame = box(0.03, 1.15, 2.58, blackM, 0, 1.95, 0);
const board = canvasTex(1400, 640);
const boardMesh = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.0), mat(0xffffff, { map: board.tex, roughness: 0.4 }));
boardMesh.rotation.y = Math.PI / 2; scene.add(boardMesh);
const boardFrame = box(0.03, 1.06, 2.28, mat(0xb0b0b0, { metalness: 0.6, roughness: 0.3 }), 0, 2.05, 0);
// Écran de la salle de réunion : historique par semaine et par mois
const meetTex = canvasTex(1600, 800);
let longHist = [];
function drawMeet() {
  const { ctx, canvas, tex } = meetTex; const W = canvas.width, Hh = canvas.height, sans = '-apple-system, "Segoe UI", sans-serif';
  ctx.fillStyle = '#1b1816'; ctx.fillRect(0, 0, W, Hh);
  ctx.fillStyle = '#d97757'; ctx.font = `700 54px ${sans}`; ctx.fillText('✻ Historique des agents', 50, 84);
  ctx.fillStyle = '#9a9189'; ctx.font = `26px ${sans}`;
  if (!longHist.length) { ctx.fillText('Lecture de l\u2019historique…', 52, 150); tex.needsUpdate = true; return; }
  const sum = (arr, k) => arr.reduce((a, d) => a + (d[k] || 0), 0);
  const last30 = longHist.slice(-30);
  ctx.fillText(`30 derniers jours : ${fmt(sum(last30, 'output'))} tokens · ${dur(sum(last30, 'activeMs'))} de travail · ≈ ${eur(sum(last30, 'cost'))} au tarif API`, 52, 132);
  // semaines
  const weeks = new Map(), months = new Map();
  for (const d of longHist) {
    const dt = new Date(d.date + 'T12:00'), mon = new Date(dt); mon.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
    const wk = `${mon.getDate()}/${mon.getMonth() + 1}`, mk = d.date.slice(0, 7);
    for (const [map, key, label] of [[weeks, wk, wk], [months, mk, dt.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })]]) {
      const g = map.get(key) || { label, output: 0, cost: 0, activeMs: 0, calls: 0 };
      for (const k of ['output', 'cost', 'activeMs', 'calls']) g[k] += d[k] || 0;
      map.set(key, g);
    }
  }
  const wl = [...weeks.values()].slice(-10), wm = Math.max(1, ...wl.map((w) => w.output));
  ctx.fillStyle = '#9a9189'; ctx.font = `600 22px ${sans}`; ctx.fillText('PAR SEMAINE (tokens générés)', 50, 200);
  wl.forEach((w, i) => {
    const x = 50 + i * 84, hg = Math.max(4, (w.output / wm) * 380);
    ctx.fillStyle = i === wl.length - 1 ? '#d97757' : w.output ? '#8a7466' : '#3a322d';
    roundRect(ctx, x, 640 - hg, 60, hg, 6); ctx.fill();
    ctx.fillStyle = '#f4efe8'; ctx.font = `20px ${sans}`; ctx.textAlign = 'center'; ctx.fillText(fmt(w.output), x + 30, 628 - hg);
    ctx.fillStyle = '#9a9189'; ctx.fillText(w.label, x + 30, 672); ctx.fillText(eur(w.cost), x + 30, 700);
    ctx.textAlign = 'left';
  });
  // mois
  ctx.fillStyle = '#9a9189'; ctx.font = `600 22px ${sans}`; ctx.fillText('PAR MOIS', 960, 200);
  ['Tokens', 'Temps', 'Coût estimé'].forEach((h, i) => ctx.fillText(h.toUpperCase(), 1180 + i * 140, 200));
  [...months.values()].slice(-5).reverse().forEach((m, i) => {
    const y = 260 + i * 70;
    ctx.fillStyle = 'rgba(255,255,255,.05)'; roundRect(ctx, 950, y - 40, 610, 56, 10); ctx.fill();
    ctx.fillStyle = '#f4efe8'; ctx.font = `600 28px ${sans}`; ctx.fillText(m.label, 970, y);
    ctx.font = `28px ${sans}`; ctx.fillText(fmt(m.output), 1180, y); ctx.fillText(dur(m.activeMs), 1320, y); ctx.fillText(eur(m.cost), 1460, y);
  });
  ctx.fillStyle = '#6b625a'; ctx.font = `20px ${sans}`; ctx.fillText('Coût : équivalent au tarif public de l\u2019API, pas le prix d\u2019un abonnement.', 950, 760);
  tex.needsUpdate = true;
}
async function loadLongHistory() {
  if (demo) return;
  try { const r = await fetch('/api/history?days=90', { cache: 'no-store' }); longHist = (await r.json()).days || []; drawMeet(); } catch { /* on réessaiera */ }
}
// Places du coin salon / cuisine (reconstruites avec la pièce), par ordre de préférence
const LOUNGE = [];
const seatSpot = (x, z, rot, lx = 0) => ({ x: x + lx * Math.cos(rot) - 0.05 * Math.sin(rot), z: z - lx * Math.sin(rot) - 0.05 * Math.cos(rot), yaw: rot });

// =====================================================================
// Dehors : la vue depuis le 3e étage
// =====================================================================
const extMats = [];
const emat = (color, o = {}) => { const m = new THREE.MeshLambertMaterial({ color, ...o }); extMats.push({ m, base: m.color.clone(), baseE: m.emissiveMap ? null : m.emissive.clone() }); return m; };
const outside = new THREE.Group(); scene.add(outside);
const lampGlowM = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffe2a8, emissiveIntensity: 0 });
const cityWinMats = [];
function ebox(w, h, d, m, x, y, z, parent = outside) { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); parent.add(b); return b; }
(function exterior() {
  const G = GROUND, r = rng(42);
  // notre façade sous les fenêtres, trottoir, route, bande plantée, trottoir d'en face
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(900, 860), emat(0x6d7a55)); ground.rotation.x = -Math.PI / 2; ground.position.set(0, G - 0.02, -220); outside.add(ground);
  ebox(300, 0.12, 2.6, emat(0xbab5aa), 0, G + 0.06, -5.2);
  ebox(300, 0.08, 7, emat(0x4b4d51), 0, G + 0.04, -9.95);
  const lineM = emat(0xe9e7e0);
  ebox(300, 0.02, 0.12, lineM, 0, G + 0.09, -6.8); ebox(300, 0.02, 0.12, lineM, 0, G + 0.09, -13.1);
  const dash = new THREE.InstancedMesh(new THREE.BoxGeometry(3, 0.02, 0.12), lineM, 40);
  for (let i = 0; i < 40; i++) dash.setMatrixAt(i, new THREE.Matrix4().makeTranslation(-150 + i * 7.5, G + 0.09, -9.95));
  outside.add(dash);
  ebox(300, 0.14, 1.9, emat(0x4a3d31), 0, G + 0.07, -14.4);
  ebox(300, 0.12, 1.6, emat(0xc4bfb3), 0, G + 0.06, -16.1);
  // arbustes bas, jeunes arbres, lampadaires blancs
  const bushM = emat(0x2f4a2a), leafM = emat(0x6a6b3c), leaf2M = emat(0x7b6a3a), trunkM = emat(0x4d3a2a), poleM = emat(0xf0f0ec);
  const sphere = new THREE.SphereGeometry(1, 10, 8);
  const bushes = new THREE.InstancedMesh(sphere, bushM, 160), m4b = new THREE.Matrix4();
  for (let i = 0; i < 160; i++) {
    const s = 0.4 + r() * 0.35;
    bushes.setMatrixAt(i, m4b.compose(new THREE.Vector3(-120 + i * 1.5 + r(), G + 0.2, -14.4 + (r() - 0.5) * 1.2), new THREE.Quaternion(), new THREE.Vector3(s * 1.4, s * 0.7, s)));
  }
  outside.add(bushes);
  const hedge = new THREE.InstancedMesh(sphere, emat(0x2e4d2c), 110);
  for (let i = 0; i < 110; i++) {
    const s = 0.6 + r() * 0.4;
    hedge.setMatrixAt(i, m4b.compose(new THREE.Vector3(-70 + i * 0.85, G + 0.5, -17.3 + (r() - 0.5) * 0.6), new THREE.Quaternion(), new THREE.Vector3(s, s * 0.9, s)));
  }
  outside.add(hedge);
  const canopy = new THREE.InstancedMesh(sphere, leafM, 34 * 7), canopy2 = new THREE.InstancedMesh(sphere, leaf2M, 34 * 3);
  let ci = 0, ci2 = 0;
  for (let k = 0; k < 34; k++) {
    const x = -150 + k * 9 + r() * 2, z = -14.4;
    ebox(0.14, 3, 0.14, trunkM, x, G + 1.5, z);
    for (let j = 0; j < 7; j++) canopy.setMatrixAt(ci++, m4b.compose(new THREE.Vector3(x + (r() - 0.5) * 1.8, G + 3 + r() * 1.8, z + (r() - 0.5) * 1.6), new THREE.Quaternion(), new THREE.Vector3().setScalar(0.45 + r() * 0.4)));
    for (let j = 0; j < 3; j++) canopy2.setMatrixAt(ci2++, m4b.compose(new THREE.Vector3(x + (r() - 0.5) * 1.8, G + 3.2 + r() * 1.5, z + (r() - 0.5) * 1.6), new THREE.Quaternion(), new THREE.Vector3().setScalar(0.35 + r() * 0.3)));
    if (k % 2 === 0) {
      ebox(0.09, 4.4, 0.09, poleM, x + 4.5, G + 2.2, -15.2);
      const globe = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 10), lampGlowM); globe.position.set(x + 4.5, G + 4.5, -15.2); outside.add(globe);
    }
  }
  outside.add(canopy, canopy2);

  // le grand bâtiment blanc en béton d'en face
  const facade = canvasTex(2048, 200, (ctx, w, h) => {
    ctx.fillStyle = '#e4e3df'; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 90; i++) { ctx.fillStyle = `rgba(120,118,110,${r() * 0.06})`; ctx.fillRect(r() * w, 0, 2 + r() * 30, h); }
    ctx.fillStyle = '#b9c7d0'; ctx.fillRect(170, 0, 150, h); // angle vitré
    ctx.strokeStyle = '#7d8a93'; ctx.lineWidth = 3;
    for (let x = 170; x <= 320; x += 30) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y <= h; y += 50) { ctx.beginPath(); ctx.moveTo(170, y); ctx.lineTo(320, y); ctx.stroke(); }
    ctx.fillStyle = '#34383c';
    for (let i = 0; i < 38; i++) {
      const x = 360 + r() * (w - 420), y = 30 + r() * (h - 70);
      if (r() < 0.5) ctx.fillRect(x, y, 34 + r() * 30, 5); else ctx.fillRect(x, y, 5, 22 + r() * 35);
    }
  });
  const roofTex = repeatTex(canvasTex(512, 512, (ctx, w, h) => {
    ctx.fillStyle = '#5c5e60'; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 500; i++) { ctx.fillStyle = `rgba(${r() < 0.5 ? '255,255,255' : '0,0,0'},${r() * 0.05})`; ctx.fillRect(r() * w, r() * h, 3 + r() * 20, 3 + r() * 20); }
    ctx.strokeStyle = 'rgba(200,200,195,.35)'; ctx.lineWidth = 2;
    for (let x = 0; x < w; x += 64) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y < h; y += 128) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    ctx.fillStyle = 'rgba(90,110,60,.35)'; for (let i = 0; i < 40; i++) ctx.fillRect(r() * w, r() * h, 4, 4);
  }).tex);
  roofTex.repeat.set(6, 3);
  const whiteC = emat(0xe6e4df, { emissive: 0x3a3a38 }), roofM = emat(0xffffff, { map: roofTex }), faceM = emat(0xffffff, { map: facade.tex, emissive: 0x4a4a48 });
  const bx0 = -65, bx1 = 22, bz0 = -18, bz1 = -62, top = G + 6.6, cx = (bx0 + bx1) / 2, cz = (bz0 + bz1) / 2;
  ebox(bx1 - bx0 - 0.6, 1.3, bz0 - bz1 - 0.6, emat(0x34373b), cx, G + 0.65, cz);
  const main = new THREE.Mesh(new THREE.BoxGeometry(bx1 - bx0, 5.3, bz0 - bz1), [whiteC, whiteC, roofM, whiteC, faceM, whiteC]);
  main.position.set(cx, G + 1.3 + 2.65, cz); outside.add(main);
  const parapetM = emat(0xe9e8e3);
  ebox(bx1 - bx0, 0.45, 0.3, parapetM, cx, top + 0.22, bz0 - 0.15); ebox(bx1 - bx0, 0.45, 0.3, parapetM, cx, top + 0.22, bz1 + 0.15);
  ebox(0.3, 0.45, bz0 - bz1, parapetM, bx0 + 0.15, top + 0.22, cz); ebox(0.3, 0.45, bz0 - bz1, parapetM, bx1 - 0.15, top + 0.22, cz);
  ebox(bx1 - bx0 - 6, 0.12, 0.8, emat(0xa6a59f), cx + 2, G + 1.36, bz0 + 0.3); // auvent au-dessus du rez-de-chaussée
  const skyM = emat(0xf4f4f0);
  for (let i = 0; i < 12; i++) ebox(1.4, 0.35, 0.9, skyM, bx0 + 8 + r() * (bx1 - bx0 - 16), top + 0.18, bz0 - 5 - r() * 30);
  ebox(4.5, 2.6, 3.5, whiteC, bx0 + 12, top + 1.3, bz1 + 6); ebox(1.1, 1.9, 0.05, emat(0x9a9892), bx0 + 12, top + 0.95, bz1 + 7.78);
  ebox(5, 1.4, 3, emat(0xd4d2cc), bx0 + 30, top + 0.7, bz0 - 9);
  ebox(40, 1.2, 0.3, emat(0xcfcdc6), cx - 10, top + 0.6, bz1 - 1); // bâtiment derrière
  ebox(40, 0.1, 18, emat(0x55575a), cx - 10, top + 1.2, bz1 - 10);
  // l'entrepôt blanc à bandes rouges
  const stripes = canvasTex(1024, 160, (ctx, w, h) => {
    ctx.fillStyle = '#ecebe7'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#3c4146'; ctx.fillRect(200, 55, 90, 40); ctx.fillRect(420, 55, 110, 40);
    ctx.fillStyle = '#b3272d';
    for (let i = 0; i < 14; i++) { const x = 660 + i * 22 + r() * 8; ctx.fillRect(x, 0, 12, 25 + r() * 90); }
  });
  const whA = emat(0xe9e8e3), whF = emat(0xffffff, { map: stripes.tex });
  const wh = new THREE.Mesh(new THREE.BoxGeometry(45, 6.2, 22), [whA, whA, emat(0x9a9c9f), whA, whF, whA]);
  wh.position.set(52, G + 3.1, -33); outside.add(wh);
  const fenceM = emat(0x2d3033, { transparent: true, opacity: 0.55 });
  ebox(60, 1.8, 0.05, fenceM, 52, G + 0.9, -19.6);
  ebox(18, 0.06, 5, emat(0x55575b), 40, G + 0.05, -20);
  // de l'autre côté de l'immeuble : parking, voitures, rangée d'arbres
  ebox(110, 0.06, 26, emat(0x55575b), 0, G + 0.03, 52);
  for (let i = 0; i < 22; i++) {
    const cxp = -48 + i * 4.4 + r() * 0.6;
    ebox(0.1, 0.02, 5, lineM, cxp - 1.4, G + 0.08, 46);
    if (r() < 0.6) { const car = emat(new THREE.Color().setHSL(r(), 0.25 + r() * 0.3, 0.3 + r() * 0.35)); ebox(1.8, 0.9, 4.2, car, cxp, G + 0.55, 46); ebox(1.6, 0.6, 2.2, car, cxp, G + 1.25, 46.2); }
  }
  const backTrees = new THREE.InstancedMesh(sphere, emat(0x35502f), 60);
  for (let i = 0; i < 60; i++) { const sc = 2.5 + r() * 2.5; backTrees.setMatrixAt(i, m4b.compose(new THREE.Vector3(-90 + i * 3.1 + r() * 2, G + 3 + r() * 2, 68 + r() * 8), new THREE.Quaternion(), new THREE.Vector3(sc, sc * 1.2, sc))); }
  outside.add(backTrees);
  // lointain : rideau d'arbres, immeubles, tour, grues
  const treeFar = new THREE.InstancedMesh(sphere, emat(0x2c4428), 220), treeFar2 = new THREE.InstancedMesh(sphere, emat(0x3b5733), 140);
  for (let i = 0; i < 220; i++) { const s = 3 + r() * 3.5; treeFar.setMatrixAt(i, m4b.compose(new THREE.Vector3(-260 + r() * 520, G + 3 + r() * 3, -95 - r() * 35), new THREE.Quaternion(), new THREE.Vector3(s, s * 1.15, s))); }
  for (let i = 0; i < 140; i++) { const s = 4 + r() * 5; treeFar2.setMatrixAt(i, m4b.compose(new THREE.Vector3(-300 + r() * 600, G + 4 + r() * 5, -170 - r() * 90), new THREE.Quaternion(), new THREE.Vector3(s, s * 1.1, s))); }
  outside.add(treeFar, treeFar2);
  const winTex = repeatTex(canvasTex(128, 128, (ctx, w, h) => {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    for (let y = 8; y < h; y += 32) for (let x = 6; x < w; x += 32) { ctx.fillStyle = r() < 0.55 ? '#ffd48a' : '#1a1a1a'; ctx.fillRect(x, y, 18, 14); }
  }).tex);
  const facadeWin = repeatTex(canvasTex(128, 128, (ctx, w, h) => {
    ctx.fillStyle = '#eeeae1'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#8a929a'; for (let y = 8; y < h; y += 32) for (let x = 6; x < w; x += 32) ctx.fillRect(x, y, 18, 14);
    ctx.fillStyle = '#dcd6ca'; for (let y = 26; y < h; y += 32) ctx.fillRect(0, y, w, 3);
  }).tex);
  const blocks = [[-120, -120, 34, 14], [-80, -135, 26, 20], [-40, -115, 22, 12], [-15, -150, 30, 18], [15, -125, 24, 16], [60, -140, 36, 22], [95, -118, 28, 13],
    [130, -150, 40, 18], [-150, -160, 30, 24], [-95, -175, 24, 30], [40, -175, 30, 26], [-60, -180, 50, 16], [110, -185, 34, 20]];
  for (const [x, z, w, hh] of blocks) {
    const t = facadeWin.clone(); t.needsUpdate = true; t.repeat.set(w / 3.2, hh / 3.2);
    const e = winTex.clone(); e.needsUpdate = true; e.repeat.set(w / 3.2, hh / 3.2);
    const m = emat(0xffffff, { map: t, emissive: 0xffffff, emissiveMap: e, emissiveIntensity: 0 }); cityWinMats.push(m);
    ebox(w, hh, 12, m, x, G + hh / 2, z - 45);
    ebox(w + 0.4, 0.4, 12.4, emat(0xd8d2c6), x, G + hh + 0.2, z - 45);
  }
  const tm = emat(0xffffff, { map: (() => { const t = facadeWin.clone(); t.needsUpdate = true; t.repeat.set(3, 16); return t; })(), emissive: 0xffffff, emissiveMap: (() => { const e = winTex.clone(); e.needsUpdate = true; e.repeat.set(3, 16); return e; })(), emissiveIntensity: 0 });
  cityWinMats.push(tm);
  ebox(9, 50, 9, tm, 70, G + 25, -260);
  const craneM = emat(0xf1efe6);
  for (const [x, z, h, a] of [[-12, -190, 36, 0.3], [-2, -200, 32, -0.4]]) {
    ebox(0.8, h, 0.8, craneM, x, G + h / 2, z);
    const jib = ebox(26, 0.7, 0.7, craneM, x + 8, G + h, z); jib.rotation.y = a;
    ebox(2, 1.4, 1.4, craneM, x - 3, G + h - 0.5, z);
  }
})();

// Ciel (dôme)
const sky = canvasTex(1024, 512);
const skyDome = new THREE.Mesh(new THREE.SphereGeometry(600, 32, 16), new THREE.MeshBasicMaterial({ map: sky.tex, side: THREE.BackSide, fog: false, toneMapped: false }));
scene.add(skyDome);
const cirrus = (() => {
  const r = rng(77); const out = [];
  for (let i = 0; i < 70; i++) {
    const x = r() * 1024, y = 90 + r() * 150, len = 60 + r() * 220, bend = (r() - 0.5) * 60;
    out.push({ x, y, len, bend, w: 1 + r() * 5, a: 0.05 + r() * 0.2, ang: -0.35 + (r() - 0.5) * 0.5 });
  }
  for (let i = 0; i < 12; i++) out.push({ puff: true, x: r() * 1024, y: 150 + r() * 90, rx: 6 + r() * 14, ry: 3 + r() * 5, a: 0.5 + r() * 0.4 });
  return out;
})();

// =====================================================================
// L'immeuble autour du bureau : 4 niveaux (on est au 3e), long couloir central,
// d'autres bureaux de chaque côté, étages au-dessus et toit (masqués en vue d'ensemble)
// =====================================================================
const FLOOR_H = 3.2, CORW = 2.2; // hauteur d'un étage, largeur du couloir
const PARK_D = 5.6;               // parking en épi devant l'immeuble : la rue est repoussée d'autant
const bayTex = (lit) => repeatTex(canvasTex(256, 256, (ctx, w, h) => {
  ctx.fillStyle = lit ? '#000' : '#dddad4'; ctx.fillRect(0, 0, w, h);
  const wx = 40, wy = 38, ww = 176, wh = 136; // fenêtre du même dessin que les nôtres, une par travée et par étage
  if (lit) { ctx.fillStyle = '#ffd896'; ctx.fillRect(wx, wy, ww, wh); return; }
  ctx.fillStyle = '#2c2f33'; ctx.fillRect(wx - 5, wy - 5, ww + 10, wh + 10);
  ctx.fillStyle = '#6f8595'; ctx.fillRect(wx, wy, ww, wh);
  ctx.fillStyle = 'rgba(240,240,236,.85)'; // stores à moitié baissés
  for (let y = wy; y < wy + wh * 0.45; y += 4) ctx.fillRect(wx, y, ww, 2);
  ctx.fillStyle = '#e9e6e0'; ctx.fillRect(wx - 8, wy + wh + 4, ww + 16, 5);
}).tex);
const bayDay = bayTex(false), bayNight = bayTex(true);
const shellExt = []; // matériaux extérieurs créés avec la pièce (retirés à chaque reconstruction)
function facadeMat(w, h, offX = 0, y0 = 0) { // y0 : bas du pan, pour caler les fenêtres sur les étages
  const map = bayDay.clone(); map.needsUpdate = true; map.repeat.set(w / 3.4, h / FLOOR_H); map.offset.set(offX / 3.4, y0 / FLOOR_H);
  const em = bayNight.clone(); em.needsUpdate = true; em.repeat.copy(map.repeat); em.offset.copy(map.offset);
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff, map, emissive: 0xffffff, emissiveMap: em, emissiveIntensity: 0 });
  const e = { m, base: m.color.clone(), baseE: null };
  extMats.push(e); cityWinMats.push(m); shellExt.push(e);
  return m;
}
function forgetShellExt() {
  for (const e of shellExt) {
    const i = extMats.indexOf(e); if (i >= 0) extMats.splice(i, 1);
    const j = cityWinMats.indexOf(e.m); if (j >= 0) cityWinMats.splice(j, 1);
  }
  shellExt.length = 0;
}
const roofMatB = emat(0x6a6c6e), parapetB = emat(0xe2e0db);
const leafM = mat(0x4f7a4a, { roughness: 0.8 }), potM = mat(0xb4674a);
function plant(x, z, sc = 1, solid = true, parent = scene) {
  const g = new THREE.Group(); g.position.set(x, 0, z); g.scale.setScalar(sc); parent.add(g);
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.17, 0.4, 20), potM); pot.position.y = 0.2; pot.castShadow = true; g.add(pot);
  for (let i = 0; i < 7; i++) {
    const l = new THREE.Mesh(new THREE.SphereGeometry(0.2 + Math.random() * 0.12, 10, 8), leafM);
    l.position.set((Math.random() - 0.5) * 0.35, 0.55 + Math.random() * 0.5, (Math.random() - 0.5) * 0.35); l.castShadow = true; g.add(l);
  }
  if (solid) block(x, z, 0.5 * sc, 0.5 * sc);
  return g;
}
const corrFloorM = mat(0x8d9093, { roughness: 0.7 }), doorM = mat(0x6b5a50, { roughness: 0.6 }), frameBlueM = mat(0x2c3e8c);

// Motos garées devant l'entrée (modèles simplifiés) : l'avant regarde vers +x, la roue avant à droite
function makeMoto(kind) {
  const gsa = kind === 'gsa';
  const root = new THREE.Group(), b = new THREE.Group(); root.add(b);
  b.rotation.x = 0.09; // posée sur la béquille latérale
  const M = (c, o = {}) => mat(c, { roughness: 0.45, ...o });
  const paint = gsa ? M(0xa3161a, { roughness: 0.3 }) : M(0xefefea, { roughness: 0.3 }); // GSA rouge, CB500X blanche
  const blackP = M(0x1b1c1e), greyP = M(0x6d7277), chrome = M(0xc9ccd0, { roughness: 0.25, metalness: 0.7 });
  const alu = M(0xbfc3c6, { roughness: 0.35, metalness: 0.55 }), tyre = M(0x151515, { roughness: 0.9 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x9fb3bf, transparent: true, opacity: 0.35, roughness: 0.1 });
  const bx = (w, h, d, m, x, y, z, rz = 0, parent = b) => { const o = box(w, h, d, m, x, y, z, parent); o.rotation.z = rz; return o; };
  const cyl = (r, len, m, x, y, z, axis = 'z') => {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 14), m); c.position.set(x, y, z);
    if (axis === 'z') c.rotation.x = Math.PI / 2; else if (axis === 'x') c.rotation.z = Math.PI / 2; c.castShadow = true; b.add(c); return c;
  };
  const wheel = (x, r, spoked) => {
    const t = new THREE.Mesh(new THREE.TorusGeometry(r - 0.065, 0.065, 10, 28), tyre); t.position.set(x, r, 0); t.castShadow = true; b.add(t);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(r - 0.13, 0.014, 6, 28), spoked ? alu : blackP); rim.position.set(x, r, 0); b.add(rim);
    cyl(0.05, 0.16, spoked ? alu : blackP, x, r, 0);
    const n = spoked ? 16 : 5, len = r - 0.17;
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2, s = bx(len, spoked ? 0.008 : 0.035, spoked ? 0.008 : 0.02, spoked ? chrome : blackP, x + Math.cos(a) * len / 2, r + Math.sin(a) * len / 2, 0); s.rotation.z = a; }
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.45, r * 0.45, 0.01, 24), chrome); disc.rotation.x = Math.PI / 2; disc.position.set(x, r, 0.08); b.add(disc);
  };
  const fx = gsa ? 0.78 : 0.72, rx = gsa ? -0.75 : -0.7, fr = gsa ? 0.36 : 0.35, rr = gsa ? 0.34 : 0.33;
  wheel(fx, fr, gsa); wheel(rx, rr, gsa);
  // fourche inclinée, guidon large, rétroviseurs
  for (const z of [-0.09, 0.09]) bx(0.05, 0.75, 0.05, gsa ? blackP : chrome, fx - 0.17, fr + 0.36, z, 0.45);
  cyl(0.016, gsa ? 0.92 : 0.8, blackP, fx - 0.36, 1.17, 0);
  for (const z of [-1, 1]) { bx(0.12, 0.07, 0.05, blackP, fx - 0.36, 1.17, z * (gsa ? 0.44 : 0.38)); bx(0.02, 0.18, 0.02, blackP, fx - 0.4, 1.28, z * 0.26); bx(0.03, 0.06, 0.1, blackP, fx - 0.4, 1.38, z * 0.28); }
  if (gsa) {
    // flat-twin : les deux cylindres qui dépassent sur les côtés, protégés par les arceaux
    bx(0.42, 0.34, 0.3, greyP, 0.05, 0.47, 0);
    for (const z of [-1, 1]) {
      cyl(0.095, 0.26, chrome, 0.2, 0.5, z * 0.27); bx(0.14, 0.2, 0.06, blackP, 0.22, 0.5, z * 0.42);
      const guard = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.014, 6, 20, Math.PI), blackP); guard.position.set(0.22, 0.5, z * 0.47); guard.rotation.z = -Math.PI / 2; b.add(guard);
    }
    bx(0.62, 0.3, 0.5, paint, 0.25, 0.93, 0);                                  // grand réservoir anguleux
    for (const z of [-1, 1]) bx(0.42, 0.26, 0.04, paint, 0.32, 0.8, z * 0.27, -0.2);
    bx(0.75, 0.1, 0.32, blackP, -0.28, 0.95, 0); bx(0.3, 0.08, 0.3, blackP, -0.6, 1.02, 0);
    bx(0.46, 0.06, 0.24, paint, fx - 0.12, fr + 0.5, 0, -0.35);                // le « bec »
    bx(0.38, 0.04, 0.16, paint, fx, fr + 0.12, 0, 0.1);
    bx(0.18, 0.3, 0.32, M(0x3a3d41), fx - 0.2, 1.1, 0);                         // tête de fourche, double optique
    for (const z of [-0.07, 0.08]) { const h = cyl(z < 0 ? 0.05 : 0.065, 0.02, glass, fx - 0.1, 1.12, z, 'x'); h.material = M(0xe8eef2, { emissive: 0x333333 }); }
    const ws = bx(0.02, 0.42, 0.4, glass, fx - 0.28, 1.42, 0, 0.35); ws.castShadow = false;
    bx(0.55, 0.03, 0.32, chrome, -0.62, 1.08, 0);                               // porte-bagages
    bx(0.6, 0.07, 0.06, greyP, -0.38, 0.38, -0.13, 0.08);                      // monobras
    cyl(0.06, 0.45, chrome, -0.5, 0.62, -0.24, 'x');                           // silencieux haut à droite
    for (const z of [-1, 1]) {                                                 // valises alu
      const v = bx(0.52, 0.42, 0.24, alu, -0.58, 0.74, z * 0.36);
      for (const [dx, dy] of [[-0.26, 0.21], [0.26, 0.21], [-0.26, -0.21], [0.26, -0.21]]) bx(0.05, 0.05, 0.26, blackP, -0.58 + dx, 0.74 + dy, z * 0.36);
      bx(0.5, 0.02, 0.01, M(0x8c9094, { metalness: 0.6 }), -0.58, 0.85, z * 0.485); v.castShadow = true;
    }
  } else {
    // bicylindre en ligne, cadre acier, carénage court
    bx(0.42, 0.38, 0.28, blackP, 0.08, 0.47, 0); bx(0.24, 0.22, 0.26, greyP, 0.24, 0.68, 0, -0.3);
    for (const z of [-1, 1]) bx(0.75, 0.05, 0.04, blackP, 0.05, 0.75, z * 0.15, 0.25);
    bx(0.52, 0.26, 0.42, paint, 0.2, 0.92, 0);
    for (const z of [-1, 1]) bx(0.4, 0.3, 0.04, M(0x55595e), 0.36, 0.86, z * 0.24, -0.25);
    bx(0.62, 0.09, 0.28, blackP, -0.28, 0.9, 0); bx(0.35, 0.12, 0.2, paint, -0.66, 0.98, 0, 0.15);
    bx(0.16, 0.24, 0.26, paint, fx - 0.2, 1.06, 0); const hl = bx(0.03, 0.08, 0.18, M(0xe8eef2, { emissive: 0x333333 }), fx - 0.11, 1.04, 0); hl.castShadow = false;
    const ws = bx(0.02, 0.28, 0.3, glass, fx - 0.27, 1.28, 0, 0.4); ws.castShadow = false;
    bx(0.32, 0.04, 0.14, blackP, fx, fr + 0.1, 0, 0.1);
    bx(0.55, 0.06, 0.06, blackP, -0.35, 0.36, 0.13, 0.1); bx(0.55, 0.06, 0.06, blackP, -0.35, 0.36, -0.13, 0.1);
    cyl(0.055, 0.32, M(0x3a3c3f), -0.15, 0.32, -0.18, 'x');                   // pot court sous le moteur
  }
  bx(0.02, 0.3, 0.02, chrome, -0.05, 0.15, 0.2, 0.5);                        // béquille latérale
  return root;
}

function buildBuilding(g, ceilingGroup, up) {
  forgetShellExt();
  const x0 = shellX0, S = XE - x0, z1 = shellZ1, et = CONFIG.etage;
  // la rue descend avec l'étage ; tout ce qui est au-dessus de notre plafond (étages, toit) disparaît en vue d'ensemble
  GROUND = -FLOOR_H * et - 0.4; outside.position.set(0, GROUND - GROUND_REF, -PARK_D);
  const G = GROUND, TOP = FLOOR_H * (CONFIG.etages - et + 1);
  const zc0 = z1 + 0.2, zc1 = zc0 + CORW, zm = (zc0 + zc1) / 2, zB = zc1 + 0.2 + S, zN = ZN - 0.21;
  // Plan d'étage courant, relevé sur un plan d'évacuation : bâtiment en parallélogramme, couloir central entre
  // deux cages d'escalier, bureaux de part et d'autre, grands plateaux aux deux bouts.
  // Les positions sont exprimées en largeurs de notre bureau (le plan est à l'échelle de la pièce).
  const at = (f) => x0 + f * S;
  const xN0 = at(-4.05), xN1 = at(2.62), xS0 = at(-3.47), xS1 = at(3.14);
  const xW = (z) => xN0 + (xS0 - xN0) * (z - zN) / (zB - zN), xE = (z) => xN1 + (xS1 - xN1) * (z - zN) / (zB - zN);
  const xc0 = at(-1.62), xc1 = at(1.43), lx = at(-1.095), rx = x0 + 3.0, mx0 = at(-0.27), mx1 = at(0.8);
  const st1 = [xc0, at(-1.2)], st2 = [at(1.05), xc1], stD = 0.45 * S; // cages d'escalier (côté sud)
  const sx1 = at(-1.41), sx2 = at(1.24); // portes des escaliers
  Object.assign(CORR, { x0: xc0, x1: xc1 });
  // hall du rez-de-chaussée sous l'ouest du couloir, entrée vitrée côté rue
  const hallY = G + 0.12, hx0 = xc0, hx1 = at(-0.99), ex = (hx0 + hx1) / 2, ex0 = ex - 1.1, ex1 = ex + 1.1;
  const roofObs = [];
  Object.assign(BLD, {
    hallY, top: TOP, hall: [hx0, hx1, zN, zc1], entrance: [ex0 + 0.3, ex1 - 0.3, zN - 0.5, zN + 0.5], street: [xN0 - 25, xN1 + 25, -13.3 - PARK_D, zN - 0.3],
    inRoof: (x, z) => z > zN + 0.5 && z < zB - 0.5 && x > xW(z) + 0.5 && x < xE(z) - 0.5,
    obs: { rdc: [], toit: roofObs },
    spots: { liftBureau: [lx, zm], liftRdc: [lx, zc1 - 1.2], stairsBureau: [sx1, zm], stairsRdc: [sx1, zc1 - 1.2], roofBureau: [sx2, zm], roofTop: [sx2, zc1 - 0.7] },
  });
  const plane = (w, h, m, x, y, z, ry, parent = g) => { const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m); p.position.set(x, y, z); p.rotation.y = ry; parent.add(p); return p; };
  const face = (xa, za, xb, zb, y0, y1, parent, m) => { // pan de façade de A vers B, vu de l'extérieur
    const w = Math.hypot(xb - xa, zb - za), h = y1 - y0;
    if (w > 0.01 && h > 0.01) plane(w, h, m || facadeMat(w, h, 0, y0), (xa + xb) / 2, (y0 + y1) / 2, (za + zb) / 2, Math.atan2(-(zb - za), xb - xa), parent);
  };
  // Bardage d'après la vraie façade : rez-de-chaussée bleu-gris à vitrines, étages en mosaïque de panneaux
  // blancs, gris et bleus, avec des parties anthracite aux fenêtres irrégulières. u court de gauche à droite vu de dehors.
  const HF = TOP - G, yb = (f) => (f - et) * FLOOR_H;
  const paint = (W, side, holes = [], skip = [], ue = 0.5 * W) => { // ue : position de l'entrée
    const k = Math.min(26, 3800 / W), cw = Math.ceil(W * k), ch = Math.ceil(HF * k);
    const day = canvasTex(cw, ch), night = canvasTex(cw, ch), d = day.ctx, n = night.ctx, r = rng(side.length * 7 + Math.round(W));
    n.fillStyle = '#000'; n.fillRect(0, 0, cw, ch);
    const R = (c, u0, u1, y0, y1, col) => { c.fillStyle = col; c.fillRect(u0 * k, (TOP - y1) * k, (u1 - u0) * k, (y1 - y0) * k); };
    const skipped = (u0, u1, f) => skip.some(([a, b, ff]) => ff === f && u1 > a && u0 < b);
    const win = (u0, u1, y0, y1, f, lit = 0.25) => {
      if (skipped(u0, u1, f)) return;
      R(d, u0 - 0.05, u1 + 0.05, y0 - 0.05, y1 + 0.05, '#23262a'); R(d, u0, u1, y0, y1, '#7f909f');
      R(d, u0, u0 + (u1 - u0) * 0.35, y0, y1, 'rgba(255,255,255,.12)');
      if (r() < lit) R(n, u0, u1, y0, y1, r() < 0.7 ? '#ffd896' : '#cfe4ff');
    };
    const dark = side === 'pignon' ? [[0, W]] : side === 'rue' ? [[ue - 0.13 * W, ue + 0.04 * W], [0.15 * W, 0.17 * W]] : [[0.8 * W, W], [0.35 * W, 0.38 * W]];
    const inDark = (u) => dark.some(([a, b]) => u > a - 0.3 && u < b + 0.3);
    // rez-de-chaussée
    const y1st = yb(1);
    R(d, 0, W, G, y1st, '#8e9cac'); R(d, 0, W, y1st - 0.3, y1st, '#7b8898');
    if (side === 'rue') {
      const shops = [['Coiffure', 0.33], ['Traiteur', 0.46], ['Cabinet', 0.71], ['Bureaux', 0.84]];
      for (const [label, f] of shops) {
        const u = f * W; R(d, u - 1.6, u + 1.6, G + 0.1, y1st - 1.0, '#1f2328'); R(d, u - 1.5, u + 1.5, G + 0.2, y1st - 1.1, '#56616c');
        R(d, u - 1.7, u + 1.7, y1st - 0.95, y1st - 0.45, '#16181b');
        d.fillStyle = '#f2f1ec'; d.font = `700 ${Math.round(0.32 * k)}px sans-serif`; d.textAlign = 'center'; d.fillText(label, u * k, (TOP - y1st + 0.6) * k);
        R(n, u - 1.5, u + 1.5, G + 0.2, y1st - 1.1, r() < 0.5 ? '#ffe2b0' : '#000');
      }
    } else if (side === 'cour') for (let u = 1.5; u < W - 1; u += 3.2) win(u, u + 1.2, G + 1.0, G + 2.6, 0, 0.15);
    // étages
    for (let f = 1; f <= CONFIG.etages; f++) {
      const y = yb(f), last = f === CONFIG.etages;
      for (let j = 0; j < 4; j++) for (let u = -r() * 2; u < W;) { // panneaux de 1,2 à 3,6 m, rangs de 80 cm
        const w = 1.2 * (1 + Math.floor(r() * 3)), q = r();
        const col = last ? (q < 0.8 ? '#e8e7e2' : '#bcc3ca') : q < 0.28 ? '#e8e7e2' : q < 0.5 ? '#b4bcc6' : q < 0.78 ? '#7b8797' : '#4a4f58';
        R(d, u, u + w, y + j * 0.8, y + (j + 1) * 0.8, col); R(d, u, u + 0.02, y + j * 0.8, y + (j + 1) * 0.8, 'rgba(0,0,0,.15)'); u += w;
      }
      for (const [a, b] of dark) { R(d, a, b, y, y + FLOOR_H, '#3b3c3f'); for (let u = a + 1.2; u < b; u += 1.2) R(d, u, u + 0.03, y, y + FLOOR_H, '#333437'); }
      for (let u = 1.2; u < W - 0.8; u += 2.4) if (!inDark(u)) win(u - 0.42, u + 0.42, y + 0.95, y + 2.5, f);
      for (const [a, b] of dark) for (let u = a + 0.8; u < b - 1; u += 2.6 + r() * 1.6) {
        const t = r();
        if (t < 0.4) win(u, u + 0.9, y + 0.55, y + 2.45, f); else if (t < 0.7) { win(u, u + Math.min(2.4, b - u - 0.3), y + 1.75, y + 2.3, f); u += 1.2; } else win(u, u + 0.8, y + 1.6, y + 2.15, f);
      }
    }
    R(d, 0, W, TOP - 0.3, TOP, '#dcdbd6');
    for (const [u0, u1, y0, y1] of holes) { d.clearRect(u0 * k, (TOP - y1) * k, (u1 - u0) * k, (y1 - y0) * k); }
    return { day, night };
  };
  const cladMat = (p, y0, y1) => {
    const set = (t) => { const c = t.clone(); c.needsUpdate = true; c.repeat.set(1, (y1 - y0) / HF); c.offset.set(0, (y0 - G) / HF); return c; };
    const m = new THREE.MeshLambertMaterial({ color: 0xffffff, map: set(p.day.tex), emissive: 0xffffff, emissiveMap: set(p.night.tex), emissiveIntensity: 0, alphaTest: 0.5 });
    const e = { m, base: m.color.clone(), baseE: null }; extMats.push(e); cityWinMats.push(m); shellExt.push(e);
    return m;
  };
  const seg = (xa, za, xb, zb, h, y, t, m, parent) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(Math.hypot(xb - xa, zb - za), h, t), m);
    b.position.set((xa + xb) / 2, y + h / 2, (za + zb) / 2); b.rotation.y = Math.atan2(-(zb - za), xb - xa); parent.add(b); return b;
  };
  const outline = [[xN0, zN], [xN1, zN], [xS1, zB], [xS0, zB]];
  const slab = (y, m, parent) => {
    const s = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, -z)))), m);
    s.rotation.x = -Math.PI / 2; s.position.y = y; parent.add(s); return s;
  };
  // façades : côté rue (le nôtre), pignon ouest, côté cour, pignon est
  const sides = [[xN1, zN, xN0, zN], [xN0, zN, xS0, zB], [xS0, zB, xS1, zB], [xS1, zB, xN1, zN]];
  // côté rue : percé de l'entrée du hall et de nos fenêtres (u = xN1 - x)
  const holesN = [[xN1 - ex1, xN1 - ex0, hallY, hallY + 2.6], ...roomWin.xs.map((wx) => [xN1 - wx - roomWin.w / 2, xN1 - wx + roomWin.w / 2, roomWin.y0, roomWin.y1])];
  const paints = [paint(xN1 - xN0, 'rue', holesN, [[xN1 - XE - 0.3, xN1 - x0 + 0.3, et]], xN1 - ex), null, paint(xS1 - xS0, 'cour'), null];
  paints[1] = paints[3] = paint(Math.hypot(xS0 - xN0, zB - zN), 'pignon');
  sides.forEach((s, i) => { face(...s, G, FLOOR_H, g, cladMat(paints[i], G, FLOOR_H)); face(...s, FLOOR_H, TOP, up, cladMat(paints[i], FLOOR_H, TOP)); });
  // toit-terrasse : acrotère, lanterneaux, édicules des escaliers et de l'ascenseur
  slab(TOP, roofMatB, up);
  for (const s of sides) seg(...s, 0.5, TOP, 0.3, parapetB, up);
  const railM = mat(0x8c9196, { roughness: 0.5, metalness: 0.4 });
  const posts = [];
  for (const [xa, za, xb, zb] of sides) {
    seg(xa, za, xb, zb, 0.05, TOP + 1.05, 0.05, railM, up);
    const L = Math.hypot(xb - xa, zb - za); for (let t = 0; t <= L; t += 1.6) posts.push([xa + (xb - xa) * t / L, za + (zb - za) * t / L]);
  }
  const postIM = new THREE.InstancedMesh(new THREE.BoxGeometry(0.04, 0.6, 0.04), railM, posts.length);
  posts.forEach(([x, z], i) => postIM.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, TOP + 0.8, z))); up.add(postIM);
  const acM = mat(0xc9ccce, { roughness: 0.6 }), fanM = mat(0x2a2c2f);
  const acx = at(-0.9), acz = zN + 0.17 * (zB - zN);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) {
    const x = acx + i * 1.3, z = acz + j * 1.3;
    box(1.1, 0.9, 1.1, acM, x, TOP + 0.45, z, up).castShadow = false;
    const f = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.02, 20), fanM); f.position.set(x, TOP + 0.91, z); up.add(f);
  }
  roofObs.push([acx - 0.6, acx + 3 * 1.3 + 0.6, acz - 0.6, acz + 1.3 + 0.6]);
  const duct = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, at(-1.05) - at(-2.8), 16), acM);
  duct.rotation.z = Math.PI / 2; duct.position.set((at(-2.8) + at(-1.05)) / 2, TOP + 0.55, acz + 0.6); up.add(duct);
  roofObs.push([at(-2.8), at(-1.05), acz + 0.25, acz + 0.95]);
  const turf = canvasTex(128, 128, (ctx) => { ctx.fillStyle = '#5f8f3e'; ctx.fillRect(0, 0, 128, 128); for (let i = 0; i < 900; i++) { ctx.fillStyle = Math.random() < 0.5 ? '#6fa04a' : '#517d34'; ctx.fillRect(Math.random() * 128, Math.random() * 128, 2, 2); } });
  turf.tex.wrapS = turf.tex.wrapT = THREE.RepeatWrapping;
  const gx0 = at(1.75), gx1 = at(2.45), gz0 = zN + 0.8, gz1 = zB - 0.8;
  turf.tex.repeat.set((gx1 - gx0) / 2, (gz1 - gz0) / 2);
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(gx1 - gx0, gz1 - gz0), mat(0xffffff, { map: turf.tex, roughness: 1 }));
  grass.rotation.x = -Math.PI / 2; grass.position.set((gx0 + gx1) / 2, TOP + 0.01, (gz0 + gz1) / 2); up.add(grass);
  for (const [x, z] of [[gx0 + 1.5, gz0 + 3], [gx0 + 1.5, gz1 - 3]]) { box(1.8, 0.45, 0.5, pineM, x, TOP + 0.225, z, up, 0.03); roofObs.push([x - 0.9, x + 0.9, z - 0.25, z + 0.25]); }
  for (const [x, z] of [[gx1 - 1, gz0 + 1], [gx1 - 1, (gz0 + gz1) / 2], [gx1 - 1, gz1 - 1]]) { const pg = plant(0, 0, 1.3, false, up); pg.position.set(x, TOP, z); roofObs.push([x - 0.35, x + 0.35, z - 0.35, z + 0.35]); }
  const skyM = emat(0xf1f1ee); shellExt.push(extMats.at(-1));
  for (let i = 0; i < 9; i++) {
    const x = at(-3.1 + i * 0.68), z = zm + ((i % 3) - 1) * 0.3 * S;
    box(1.2, 0.3, 0.8, skyM, x, TOP + 0.15, z, up).castShadow = false; roofObs.push([x - 0.6, x + 0.6, z - 0.4, z + 0.4]);
  }
  for (const [a, b] of [[st1[0], at(-0.99)], st2]) {
    box(b - a, 2.4, stD, parapetB, (a + b) / 2, TOP + 1.2, zc1 + 0.2 + stD / 2, up).castShadow = false; roofObs.push([a, b, zc1 + 0.2, zc1 + 0.2 + stD]);
  }
  // devant : allée, parking en épi, gabions près de l'entrée (la rue commence au-delà)
  const sY = G + 0.12, pz0 = zN - 1.3, pz1 = zN - 0.3 - PARK_D;
  const walkM = emat(0xbab5aa), asphM = emat(0x4b4d51), lineM2 = emat(0xe9e7e0); shellExt.push(...extMats.slice(-3));
  box(xN1 - xN0 + 60, 0.12, 1.3, walkM, (xN0 + xN1) / 2, G + 0.06, zN - 0.65, g).castShadow = false;
  box(xN1 - xN0 + 60, 0.08, pz0 - pz1, asphM, (xN0 + xN1) / 2, G + 0.04, (pz0 + pz1) / 2, g).castShadow = false;
  const rr = rng(5);
  for (let x = xN0 - 28; x < xN1 + 28; x += 2.5) {
    box(0.1, 0.02, 4.6, lineM2, x, G + 0.09, pz0 - 2.4, g).castShadow = false;
    const cx2 = x + 1.25; if (Math.abs(cx2 - ex) < 3 || rr() > 0.62) continue;
    const car = emat(new THREE.Color().setHSL(rr(), rr() * 0.25, 0.18 + rr() * 0.5)); shellExt.push(extMats.at(-1));
    box(1.8, 0.8, 4.2, car, cx2, G + 0.5, pz0 - 2.4, g, 0.06); box(1.6, 0.55, 2.2, car, cx2, G + 1.15, pz0 - 2.3, g, 0.06);
    box(1.62, 0.4, 2.0, blackM, cx2, G + 1.17, pz0 - 2.3, g).castShadow = false; // vitres
    BLD.obs.rdc.push([cx2 - 0.9, cx2 + 0.9, pz0 - 4.5, pz0 - 0.3]);
  }
  const gabM = emat(0x8b7a62); shellExt.push(extMats.at(-1));
  // les deux motos, garées le nez vers la rue sur la place devant l'entrée
  if (CONFIG.decor === 'mon-bureau') for (const [kind, dx, label, snd] of [['cb', -1.0, 'Honda CB500X', 'twin'], ['gsa', 0.9, 'BMW R1200GS Adventure 2008, valises alu', 'boxer']]) {
    const mo = makeMoto(kind); mo.position.set(ex + dx, G + 0.08, pz0 - 1.7); mo.rotation.y = Math.PI / 2; g.add(mo);
    BLD.obs.rdc.push([ex + dx - 0.5, ex + dx + 0.5, pz0 - 2.9, pz0 - 0.5]);
    interact(mo, { label: () => `${label} : faire ronfler le moteur`, act: () => { sfx(snd); toast(kind === 'gsa' ? '🏍️ Le flat-twin gronde' : '🏍️ Le bicylindre ronronne'); }, range: 3 });
  }
  for (const dx of [-2.2, 2.2, 3.6]) { box(0.6, 0.85, 0.6, gabM, ex + dx, sY + 0.42, zN - 1.0, g); BLD.obs.rdc.push([ex + dx - 0.3, ex + dx + 0.3, zN - 1.3, zN - 0.7]); }
  // derrière : aile basse à deux niveaux, toit à lanterneaux
  const wingM = emat(0xdedcd6); shellExt.push(extMats.at(-1));
  const wx0 = at(-2.6), wx1 = at(1.6), wz1 = zB + 9, wTop = yb(2);
  box(wx1 - wx0, wTop - G, wz1 - zB, wingM, (wx0 + wx1) / 2, (G + wTop) / 2, (zB + wz1) / 2, g).castShadow = false;
  for (let x = wx0 + 2; x < wx1 - 2; x += 3.2) box(1.4, 0.35, 2.2, skyM, x, wTop + 0.17, zB + 4.5, g).castShadow = false;
  // voisins sur notre trottoir : petit immeuble de bureaux à l'ouest, entrepôt à panneaux solaires à l'est
  const offM = emat(0xe4e2dc), bandM = emat(0x2f3338), redM2 = emat(0x9b3b2e), solar = canvasTex(128, 128, (ctx) => { ctx.fillStyle = '#1d2a44'; ctx.fillRect(0, 0, 128, 128); ctx.strokeStyle = '#8ea0bd'; ctx.lineWidth = 2; for (let i = 0; i <= 128; i += 32) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 128); ctx.moveTo(0, i); ctx.lineTo(128, i); ctx.stroke(); } });
  shellExt.push(...extMats.slice(-3));
  const ox1 = xW(zN) - 9, oz0 = zN + 2;
  box(22, 7, 16, offM, ox1 - 11, G + 3.5, oz0 + 8, g).castShadow = false;
  for (const y of [G + 1.6, G + 5.0]) box(22.05, 1.1, 16.05, bandM, ox1 - 11, y, oz0 + 8, g).castShadow = false;
  const sx0 = xE(zN) + 10;
  box(36, 8, 30, mat(0xc9c8c3, { roughness: 0.8 }), sx0 + 18, G + 4, zN + 17, g).castShadow = false;
  box(0.2, 7.9, 29.8, redM2, sx0 - 0.05, G + 3.95, zN + 17, g).castShadow = false;
  solar.tex.wrapS = solar.tex.wrapT = THREE.RepeatWrapping; solar.tex.repeat.set(12, 10);
  const pv = new THREE.Mesh(new THREE.PlaneGeometry(34, 28), new THREE.MeshLambertMaterial({ map: solar.tex })); pv.rotation.x = -Math.PI / 2; pv.position.set(sx0 + 18, G + 8.02, zN + 17); g.add(pv);
  BLD.obs.rdc.push([ox1 - 22, ox1, oz0, oz0 + 16], [sx0, sx0 + 36, zN + 2, zN + 32]);

  // plancher de l'étage (visible chez les voisins en vue d'ensemble)
  slab(-0.01, mat(0x3a3c3f, { roughness: 1 }), g);

  // cloisons ; chacune est aussi tracée sur le plan d'évacuation
  const lines = [];
  const wallX = (a, b, z, gaps = []) => { // mur le long du bâtiment, avec des passages
    lines.push([a, z, b, z]); let p = a;
    for (const { x, w } of [...gaps].sort((u, v) => u.x - v.x)) {
      if (x - w / 2 - p > 0.01) box(x - w / 2 - p, CEIL, 0.2, wallM, (p + x - w / 2) / 2, CEIL / 2, z, g);
      box(w, CEIL - 2.1, 0.2, wallM, x, (CEIL + 2.1) / 2, z, g); p = x + w / 2;
    }
    if (b - p > 0.01) box(b - p, CEIL, 0.2, wallM, (p + b) / 2, CEIL / 2, z, g);
  };
  const wallZ = (x, a, b) => { lines.push([x, a, x, b]); box(0.15, CEIL, b - a, wallM, x, CEIL / 2, (a + b) / 2, g); };
  wallX(at(-1.94), x0 - 0.2, zc0 - 0.1); wallX(XE + 0.2, xE(zc0), zc0 - 0.1);           // couloir, côté rue
  wallX(xc0, xc1, zc1 + 0.1, [{ x: rx, w: 0.9 }, { x: lx, w: 1.0 }]);                  // couloir, côté cour
  wallZ(at(-1.94), zN, zc0); wallZ(at(-1.29), zN, zc0);                                // bureaux voisins côté rue
  const wdz = zc1 - 0.6; // porte des toilettes
  wallZ(xc0, zc0, wdz - 0.45); wallZ(xc0, wdz + 0.45, zB); box(0.15, CEIL - 2.1, 0.9, wallM, xc0, (CEIL + 2.1) / 2, wdz, g);
  wallZ(at(-1.2), zc1, zB); wallZ(at(-0.99), zc1, zB);            // escalier, ascenseur
  wallZ(st2[0], zc1, zB); wallZ(xc1, zc0, zB);                                         // local technique, escalier, plateau est
  // toilettes au bout ouest : vestibule avec lavabos, deux cabines au fond
  const wc = [xc0 - 3.4, xc0 - 0.075, zc0 + 1.15, zc1 + 3.0], wcx = (wc[0] + wc[1]) / 2, wcz = (wc[2] + wc[3]) / 2, cz0 = zc1 + 1.4;
  BLD.wc = wc; BLD.wcDoor = [xc0 - 0.5, xc0 + 0.5, wdz - 0.33, wdz + 0.33];
  wallX(wc[0], xc0, wc[2] - 0.1); wallX(wc[0], xc0, wc[3] + 0.1); wallZ(wc[0] - 0.075, wc[2], wc[3]);
  const tile = canvasTex(128, 128, (ctx) => { ctx.fillStyle = '#e6e9ec'; ctx.fillRect(0, 0, 128, 128); ctx.fillStyle = '#c9ced3'; for (let i = 0; i <= 128; i += 32) { ctx.fillRect(i, 0, 2, 128); ctx.fillRect(0, i, 128, 2); } });
  tile.tex.wrapS = tile.tex.wrapT = THREE.RepeatWrapping; tile.tex.repeat.set((wc[1] - wc[0]) / 0.6, (wc[3] - wc[2]) / 0.6);
  const wf = new THREE.Mesh(new THREE.PlaneGeometry(wc[1] - wc[0], wc[3] - wc[2]), mat(0xffffff, { map: tile.tex, roughness: 0.4 })); wf.rotation.x = -Math.PI / 2; wf.position.set(wcx, 0.003, wcz); wf.receiveShadow = true; g.add(wf);
  box(wc[1] - wc[0], 0.04, wc[3] - wc[2], ceilTileM, wcx, CEIL + 0.02, wcz, ceilingGroup).receiveShadow = false;
  box(0.58, 0.02, 0.58, panelM, wcx, CEIL - 0.005, wcz - 0.6, ceilingGroup).castShadow = false;
  const porcM = mat(0xf7f7f5, { roughness: 0.25 }), partM = mat(0x8aa0b8, { roughness: 0.5 }), chromeM = mat(0xcfd3d6, { roughness: 0.2, metalness: 0.6 });
  // lavabos sous un grand miroir, sèche-mains
  box(2.0, 0.08, 0.5, mat(0x2e3135), wcx - 0.3, 0.84, wc[2] + 0.25, g); block(wcx - 0.3, wc[2] + 0.25, 2.0, 0.5);
  const sinks = [];
  for (const sxw of [wcx - 0.8, wcx + 0.2]) {
    const sk = new THREE.Group(); sk.position.set(sxw, 0, wc[2] + 0.25); g.add(sk);
    box(0.42, 0.1, 0.34, porcM, 0, 0.9, 0.02, sk, 0.03); box(0.04, 0.18, 0.04, chromeM, 0, 1.0, -0.14, sk); box(0.04, 0.03, 0.14, chromeM, 0, 1.08, -0.08, sk);
    sinks.push(sk);
  }
  const mirror = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 0.9), new THREE.MeshStandardMaterial({ color: 0xc9d8e0, roughness: 0.08, emissive: 0x2a3338 }));
  mirror.position.set(wcx - 0.3, 1.6, wc[2] + 0.005); g.add(mirror);
  const dryer = box(0.3, 0.32, 0.18, chromeM, wc[0] + 0.02 + 0.09, 1.3, wc[2] + 0.9, g); dryer.rotation.y = Math.PI / 2;
  // deux cabines : cloisons bleues, portes ouvertes, cuvette et réservoir
  const toilets = [];
  box(0.05, 2.0, wc[3] - cz0, partM, wcx, 1.0, (cz0 + wc[3]) / 2, g); block(wcx, (cz0 + wc[3]) / 2, 0.05, wc[3] - cz0);
  for (const [a, b] of [[wc[0], wcx - 1.1], [wcx - 0.4, wcx + 0.4], [wcx + 1.1, wc[1]]]) { box(b - a, 2.0, 0.05, partM, (a + b) / 2, 1.0, cz0, g); block((a + b) / 2, cz0, b - a, 0.05); }
  for (const [i, cx3] of [[0, wcx - 0.75], [1, wcx + 0.75]]) {
    const leafW = box(0.7, 1.85, 0.04, partM, cx3 + 0.35 - 0.02, 1.0, cz0 - 0.33, g); leafW.rotation.y = Math.PI / 2; // porte de cabine, ouverte
    const t = new THREE.Group(); t.position.set(cx3, 0, wc[3] - 0.35); g.add(t);
    box(0.38, 0.42, 0.5, porcM, 0, 0.21, 0.05, t, 0.08); box(0.4, 0.05, 0.46, porcM, 0, 0.44, 0.05, t, 0.02); box(0.42, 0.4, 0.16, porcM, 0, 0.75, -0.24, t, 0.03);
    box(0.06, 0.02, 0.04, chromeM, 0.1, 0.96, -0.24, t);
    block(cx3, wc[3] - 0.35, 0.45, 0.7);
    const sign = canvasTex(64, 64, (ctx) => { ctx.fillStyle = '#f2f1ec'; ctx.fillRect(0, 0, 64, 64); ctx.fillStyle = '#2c3e8c'; ctx.font = '700 44px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(i ? '♀' : '♂', 32, 48); });
    const sg = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 0.14), new THREE.MeshBasicMaterial({ map: sign.tex, toneMapped: false })); sg.position.set(cx3, 1.75, cz0 - 0.03); sg.rotation.y = Math.PI; g.add(sg);
    toilets.push(t);
  }
  for (const t of toilets) interact(t, { label: () => 'Tirer la chasse', act: () => { sfx('flush'); toast('🚽 Chasse tirée'); } });
  for (const sk of sinks) interact(sk, { label: () => 'Se laver les mains', act: () => { sfx('tap'); toast('🧼 Mains lavées'); } });
  interact(dryer, { label: () => 'Se sécher les mains', act: () => { sfx('dryer'); toast('💨 Fffffuuuu…'); } });
  // poteaux et postes de travail des plateaux et des bureaux voisins (vus d'en haut)
  const lo = zN + 0.33 * (zB - zN), hi = zN + 0.7 * (zB - zN);
  for (const f of [-3.6, -3.05, -2.5, 1.85, 2.4, 2.95]) for (const z of [lo, hi]) {
    const x = at(f); if (x < xW(z) + 1 || x > xE(z) - 1 || (x > wc[0] - 0.5 && x < xc1 + 0.5 && z > zc0 - 1)) continue;
    box(0.4, CEIL, 0.4, wallM, x, CEIL / 2, z, g).castShadow = false;
  }
  const deskSpots = [];
  const furnish = (a, b, za, zb) => { for (let x = a + 1.3; x < b - 1.2; x += 2.6) for (const z of [za + (zb - za) * 0.3, za + (zb - za) * 0.7]) deskSpots.push([x, z]); };
  furnish(xW(zc0) + 0.6, at(-1.94), zN, zc0 - 0.2); furnish(at(-1.94), at(-1.29), zN, zc0 - 0.2); furnish(at(-1.29), x0 - 0.2, zN, zc0 - 0.2);
  furnish(XE + 0.2, xE(zc0) - 0.6, zN, zc0 - 0.2); furnish(xW(zB) + 0.6, wc[0] - 0.4, zc1 + 0.4, zB); furnish(at(-0.99), mx0, zc1 + 0.4, zB);
  furnish(xc1, xE(zB) - 0.6, zc0 + 0.4, zB);
  const deskTop = new THREE.InstancedMesh(new THREE.BoxGeometry(1.4, 0.74, 0.7), whiteM, deskSpots.length);
  const deskScr = new THREE.InstancedMesh(new THREE.BoxGeometry(0.55, 0.34, 0.04), blackM, deskSpots.length);
  deskSpots.forEach(([x, z], i) => { deskTop.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, 0.37, z)); deskScr.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, 0.95, z - 0.2)); });
  g.add(deskTop, deskScr);
  // marches des deux escaliers (montée vers l'étage du dessus)
  const stepM = mat(0x9a9894, { roughness: 0.8 });
  for (const [a, b] of [st1, st2]) {
    const w = (b - a) / 2 - 0.2;
    for (let i = 0; i < 9; i++) box(w, 0.17 * (i + 1), 0.3, stepM, a + 0.1 + w / 2, 0.085 * (i + 1), zc1 + stD - 0.15 - i * 0.3, g).castShadow = false;
    box(w, 0.02, stD - 0.5, blackM, b - 0.1 - w / 2, 0.01, zc1 + 0.2 + stD / 2, g);
  }

  // couloir : sol, faux plafond à dalles
  const cl = xc1 - xc0, cxm = (xc0 + xc1) / 2;
  const cf = new THREE.Mesh(new THREE.PlaneGeometry(cl, CORW), corrFloorM); cf.rotation.x = -Math.PI / 2; cf.position.set(cxm, 0.002, zm); cf.receiveShadow = true; g.add(cf);
  const cc = box(cl, 0.04, CORW, ceilTileM, cxm, CEIL + 0.02, zm, ceilingGroup); cc.receiveShadow = false;
  for (let x = xc0 + 2.4; x < xc1 - 1; x += 4.8) box(0.58, 0.02, 0.58, panelM, x, CEIL - 0.005, zm, ceilingGroup).castShadow = false;
  // portes : bois à cadre bleu, acier pour l'escalier et le local technique, verre dépoli vers les plateaux
  const steelM = mat(0x9ea3a8, { roughness: 0.45, metalness: 0.3 });
  const frostM = new THREE.MeshStandardMaterial({ color: 0xdfe8ee, transparent: true, opacity: 0.55, roughness: 0.3 });
  const plaque = (text, parent, x, y, z) => {
    const t = canvasTex(256, 80, (ctx) => { ctx.fillStyle = '#f2f1ec'; ctx.fillRect(0, 0, 256, 80); ctx.fillStyle = '#2c3e8c'; ctx.fillRect(0, 0, 8, 80); ctx.fillStyle = '#222'; ctx.font = '600 28px sans-serif'; ctx.fillText(text, 20, 50); });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.106), new THREE.MeshBasicMaterial({ map: t.tex, toneMapped: false })); m.position.set(x, y, z); parent.add(m); return m;
  };
  const door = (x, z, ry, { leaf = true, kind = 'wood', label = '', y = 0, parent = g } = {}) => { // la porte regarde vers +z local
    const d = new THREE.Group(); d.position.set(x, y, z); d.rotation.y = ry; parent.add(d);
    if (leaf) box(0.9, 2.1, 0.04, kind === 'glass' ? frostM : kind === 'steel' ? steelM : doorM, 0, 1.05, 0.02, d);
    box(0.98, 0.05, 0.05, frameBlueM, 0, 2.12, 0.02, d);
    for (const s of [-1, 1]) box(0.04, 2.12, 0.05, frameBlueM, s * 0.47, 1.06, 0.02, d);
    if (leaf) box(0.12, 0.03, 0.05, metal, 0.3, 1.02, 0.05, d);
    if (label) plaque(label, d, leaf ? 0 : 0.7, leaf ? 1.6 : 1.55, 0.055);
    return d;
  };
  const exitTex = canvasTex(128, 48, (ctx) => { ctx.fillStyle = '#1f9d55'; ctx.fillRect(0, 0, 128, 48); ctx.fillStyle = '#fff'; ctx.font = '700 22px sans-serif'; ctx.fillText('SORTIE ➜', 12, 32); });
  const exitM = new THREE.MeshBasicMaterial({ map: exitTex.tex, toneMapped: false });
  const num = (n) => `${et}${String(n).padStart(2, '0')}`;
  door(at(-1.45), zc0, 0, { label: `Bureau ${num(1)}` }); door(at(-0.35), zc0, 0, { label: `Bureau ${num(2)}` });
  door(x0 + 1.65, zc0, 0, { leaf: false, label: `${num(3)} · Agents` });               // la nôtre : le battant est côté bureau
  door(at(1.22), zc0, 0, { label: `Bureau ${num(4)}` });
  const exitSign = (x, y, z, ry, parent = g) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.18), exitM); m.position.set(x, y, z); m.rotation.y = ry; parent.add(m); };
  const stairsDown = door(sx1, zc1, Math.PI, { kind: 'steel', label: 'Escalier' });
  const stairsUp = door(sx2, zc1, Math.PI, { kind: 'steel', label: 'Escalier' });
  for (const sx of [sx1, sx2]) exitSign(sx, 2.35, zc1 - 0.01, Math.PI);
  interact(stairsDown, { label: () => 'Descendre par l’escalier (rez-de-chaussée)', act: () => travel('rdc', 'stairsRdc', 'steps') });
  interact(stairsUp, { label: () => 'Monter sur le toit-terrasse', act: () => travel('toit', 'roofTop', 'steps') });
  const roofDoor = door(sx2, zc1 + 0.2, Math.PI, { kind: 'steel', label: 'Escalier', y: TOP, parent: up });
  interact(roofDoor, { label: () => `Redescendre au ${floorName(et)}`, act: () => travel('bureau', 'roofBureau', 'steps') });
  door(at(-0.6), zc1, Math.PI, { label: `Bureau ${num(5)}` });
  door(at(0.93), zc1, Math.PI, { kind: 'steel', label: '⚡ Technique' });
  door(xc0 + 0.075, zc0 + 0.6, Math.PI / 2, { kind: 'glass', label: 'Plateau ouest' });
  const wcDoor = door(xc0 + 0.075, wdz, Math.PI / 2, { leaf: false }); // battant qui se rabat contre le mur, côté lavabos
  const wcPivot = new THREE.Group(); wcPivot.position.set(0.45, 0, -0.075); wcDoor.add(wcPivot);
  box(0.88, 2.08, 0.04, doorM, -0.45, 1.05, 0, wcPivot); box(0.12, 0.03, 0.05, metal, -0.75, 1.02, 0.04, wcPivot);
  plaque('WC  ♂ ♀', wcPivot, -0.45, 1.6, 0.03);
  wcSwing = { pivot: wcPivot, x: xc0, z: wdz, open: 0 };
  door(xc1 - 0.075, zm, -Math.PI / 2, { kind: 'glass', label: 'Plateau est' });
  // sécurité incendie : robinet d'incendie armé, extincteurs, plantes
  const redM = mat(0xc0282d, { roughness: 0.4 });
  box(0.6, 0.7, 0.2, redM, xc0 + 0.75, 1.25, zc1 - 0.1, g);
  const ria = canvasTex(128, 40, (ctx) => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 128, 40); ctx.fillStyle = '#c0282d'; ctx.font = '800 26px sans-serif'; ctx.fillText('R.I.A.', 24, 30); });
  const rl = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.125), new THREE.MeshBasicMaterial({ map: ria.tex, toneMapped: false })); rl.position.set(xc0 + 0.75, 1.45, zc1 - 0.205); rl.rotation.y = Math.PI; g.add(rl);
  for (const x of [sx1 + 0.8, sx2 - 0.8]) { const e = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.5, 12), redM); e.position.set(x, 0.6, zc1 - 0.12); g.add(e); }
  plant(xc0 + 1.2, zc0 + 0.4, 0.9, true, g); plant(xc1 - 0.7, zc0 + 0.4, 0.9, true, g);

  // ascenseur : on l'appelle, il arrive au bout de quelques secondes, s'ouvre puis se referme
  const lg = new THREE.Group(); lg.position.set(lx, level === 'rdc' ? hallY : 0, zc1); lg.rotation.y = Math.PI; g.add(lg); // +z local = côté couloir
  for (const s of [-1, 1]) box(0.12, 2.3, 0.06, steelM, s * 0.56, 1.15, 0.03, lg);
  box(1.24, 0.2, 0.06, steelM, 0, 2.2, 0.03, lg);
  const leaves = [-1, 1].map((s) => box(0.5, 2.1, 0.03, steelM, s * 0.25, 1.05, -0.08, lg));
  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.3, 2.3, 1.6), new THREE.MeshStandardMaterial({ color: 0xc9ccd0, roughness: 0.35, metalness: 0.3, side: THREE.BackSide, emissive: 0x3a3a36 }));
  cab.position.set(0, 1.15, -1.0); lg.add(cab);
  const shown = canvasTex(96, 48);
  const show = (n) => { const c = shown.ctx; c.fillStyle = '#0b0b0b'; c.fillRect(0, 0, 96, 48); c.fillStyle = '#ff9a3c'; c.font = '700 34px monospace'; c.textAlign = 'center'; c.fillText(String(n), 48, 37); shown.tex.needsUpdate = true; };
  show(level === 'rdc' ? 0 : et);
  const disp = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.12), new THREE.MeshBasicMaterial({ map: shown.tex, toneMapped: false })); disp.position.set(0, 2.42, 0.03); lg.add(disp);
  box(0.1, 0.24, 0.03, steelM, 0.82, 1.1, 0.015, lg);
  const btnM = new THREE.MeshStandardMaterial({ color: 0xdddddd, emissive: 0xffb347, emissiveIntensity: 0 });
  const btn = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.02, 16), btnM); btn.rotation.x = Math.PI / 2; btn.position.set(0.82, 1.12, 0.035); lg.add(btn);
  lift = { group: lg, leaves, btnM, show, open: 0, callAt: null, dinged: false };
  interact(lg, {
    label: () => (lift.open > 0.6 ? (level === 'rdc' ? `Monter au ${floorName(et)}` : 'Descendre au rez-de-chaussée') : lift.callAt == null ? 'Appeler l’ascenseur' : 'L’ascenseur arrive…'),
    act: () => (lift.open > 0.6 ? rideLift() : callLift()),
  });

  // hall du rez-de-chaussée : sol en pierre, boîtes aux lettres, tableau des occupants, portes automatiques
  const hcx = (hx0 + hx1) / 2, hcz = (zN + zc1) / 2, HW = hx1 - hx0, HD = zc1 - zN;
  const hf = new THREE.Mesh(new THREE.PlaneGeometry(HW, HD), mat(0xd3ccbf, { roughness: 0.45 })); hf.rotation.x = -Math.PI / 2; hf.position.set(hcx, hallY + 0.002, hcz); hf.receiveShadow = true; g.add(hf);
  box(HW, 0.04, HD, ceilTileM, hcx, hallY + CEIL + 0.02, hcz, g).receiveShadow = false;
  for (let x = hx0 + 1.6; x < hx1 - 1; x += 2.4) for (let z = zN + 1.6; z < zc1 - 1; z += 2.6) box(0.58, 0.02, 0.58, panelM, x, hallY + CEIL - 0.005, z, g).castShadow = false;
  const hwall = (w, h, d, x, y, z) => box(w, h, d, wallM, x, hallY + y, z, g);
  hwall(0.2, CEIL, HD, hx0 - 0.1, CEIL / 2, hcz); hwall(0.2, CEIL, HD, hx1 + 0.1, CEIL / 2, hcz);
  // mur côté rue un peu en retrait de la façade (sinon les deux surfaces se chevauchent et scintillent)
  hwall(ex0 - hx0, CEIL, 0.2, (hx0 + ex0) / 2, CEIL / 2, zN + 0.13); hwall(hx1 - ex1, CEIL, 0.2, (ex1 + hx1) / 2, CEIL / 2, zN + 0.13);
  hwall(ex1 - ex0, CEIL - 2.6, 0.2, ex, (CEIL + 2.6) / 2, zN + 0.13);
  hwall(lx - 0.5 - hx0, CEIL, 0.2, (hx0 + lx - 0.5) / 2, CEIL / 2, zc1 + 0.1); hwall(hx1 - lx - 0.5, CEIL, 0.2, (lx + 0.5 + hx1) / 2, CEIL / 2, zc1 + 0.1);
  hwall(1.0, CEIL - 2.1, 0.2, lx, (CEIL + 2.1) / 2, zc1 + 0.1);
  const hallStairs = door(sx1, zc1, Math.PI, { kind: 'steel', label: 'Escalier', y: hallY });
  exitSign(sx1, hallY + 2.35, zc1 - 0.01, Math.PI);
  interact(hallStairs, { label: () => `Monter au ${floorName(et)} par l’escalier`, act: () => travel('bureau', 'stairsBureau', 'steps') });
  const glassM = new THREE.MeshStandardMaterial({ color: 0xd7e7ef, transparent: true, opacity: 0.28, roughness: 0.1, depthWrite: false });
  const autoLeaves = [-1, 1].map((s) => { const l = box(1.1, 2.55, 0.03, glassM, ex + s * 0.55, hallY + 1.275, zN + 0.1, g); l.castShadow = false; return l; });
  for (const s of [-1, 1]) box(0.06, 2.6, 0.12, winFrameM, ex + s * 1.13, hallY + 1.3, zN + 0.05, g);
  hall = { leaves: autoLeaves, x: ex, z: zN, open: 0 };
  box(ex1 - ex0 + 1.6, 0.15, 1.6, mat(0x2b2d31), ex, hallY + 2.85, zN - 0.8, g);                                 // auvent
  const mat2 = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.4), mat(0x3a3530)); mat2.rotation.x = -Math.PI / 2; mat2.position.set(ex, hallY + 0.004, zN + 1.0); g.add(mat2);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 6; c++) box(0.04, 0.24, 0.32, steelM, hx0 + 0.04, hallY + 1.0 + r * 0.27, hcz - 1 + c * 0.35, g).castShadow = false; // boîtes aux lettres
  const dir = canvasTex(320, 420, (ctx, W) => {
    ctx.fillStyle = '#20242a'; ctx.fillRect(0, 0, W, 420); ctx.fillStyle = '#e9e6df'; ctx.font = '700 30px sans-serif'; ctx.fillText('Bienvenue', 24, 52);
    ctx.font = '18px sans-serif'; ctx.fillStyle = '#9aa1ab'; ctx.fillText('Occupants de l’immeuble', 24, 80);
    const rows = []; for (let f = CONFIG.etages; f >= 0; f--) rows.push([f ? `${f}` : 'RDC', f === et ? 'Bureau des agents' : f ? 'Bureaux' : 'Hall · accueil']);
    rows.forEach(([n, t], i) => { const y = 124 + i * Math.min(44, 280 / rows.length); ctx.fillStyle = t === 'Bureau des agents' ? '#d97757' : '#e9e6df'; ctx.font = '700 22px sans-serif'; ctx.fillText(n, 24, y); ctx.font = '20px sans-serif'; ctx.fillText(t, 90, y); });
  });
  const dm = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 1.05), new THREE.MeshBasicMaterial({ map: dir.tex, toneMapped: false })); dm.position.set(hx1 - 0.02, hallY + 1.55, hcz - 1.5); dm.rotation.y = -Math.PI / 2; g.add(dm);
  interact(dm, { label: () => 'Lire le tableau des occupants', act: () => focusOn(dm, 1.3), range: 4 });
  box(0.45, 0.45, 1.8, pineM, hx0 + 0.45, hallY + 0.225, hcz + 2.2, g, 0.03); BLD.obs.rdc.push([hx0, hx0 + 0.7, hcz + 1.3, hcz + 3.1]); // banc
  for (const [x, z] of [[hx0 + 0.6, zN + 0.7], [hx1 - 0.6, zN + 0.7]]) { const pg = plant(0, 0, 1.2, false, g); pg.position.set(x, hallY, z); BLD.obs.rdc.push([x - 0.3, x + 0.3, z - 0.3, z + 0.3]); }

  // distributeur de snacks
  const vx = x0 + 5.2;
  const vend = new THREE.Group(); vend.position.set(vx, 0, zc1 - 0.45); g.add(vend);
  box(0.9, 1.85, 0.7, mat(0xb3202a, { roughness: 0.5 }), 0, 0.925, 0, vend, 0.03);
  const snackTex = canvasTex(160, 256, (ctx) => {
    ctx.fillStyle = '#10151c'; ctx.fillRect(0, 0, 160, 256);
    const c = ['#f2c230', '#d35400', '#3aa39a', '#c0392b', '#8e44ad', '#ecf0f1'];
    for (let r = 0; r < 5; r++) for (let k = 0; k < 4; k++) { ctx.fillStyle = c[(r * 4 + k) % c.length]; ctx.fillRect(12 + k * 36, 14 + r * 46, 26, 30); }
  });
  const glassV = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 1.2), new THREE.MeshStandardMaterial({ map: snackTex.tex, emissiveMap: snackTex.tex, emissive: 0xffffff, emissiveIntensity: 0.5 }));
  glassV.position.set(-0.1, 1.15, -0.352); glassV.rotation.y = Math.PI; vend.add(glassV);
  box(0.16, 0.5, 0.02, blackM, 0.3, 1.3, -0.36, vend);
  block(vx, zc1 - 0.45, 0.9, 0.7);
  interact(vend, { label: () => 'Acheter un snack', act: buySnack });
  // salle de réunion visitable, en face dans le couloir : grande table, chaises, écran d'historique, fenêtres côté cour
  const mz0 = zc1 + 0.2, mz1 = zB - 0.2, mcx = (mx0 + mx1) / 2, mcz = (mz0 + mz1) / 2;
  Object.assign(MEET, { x0: mx0, x1: mx1, z0: mz0, z1: mz1, door: rx });
  lines.push([mx0, mz0, mx0, mz1], [mx1, mz0, mx1, mz1]);
  const mfl = new THREE.Mesh(new THREE.PlaneGeometry(mx1 - mx0, mz1 - mz0), mat(0x3b4854, { roughness: 1 })); mfl.rotation.x = -Math.PI / 2; mfl.position.set(mcx, 0.003, mcz); mfl.receiveShadow = true; g.add(mfl);
  box(0.15, CEIL, mz1 - mz0, wallM, mx0 - 0.075, CEIL / 2, mcz, g); box(0.15, CEIL, mz1 - mz0, wallM, mx1 + 0.075, CEIL / 2, mcz, g);
  const mcl = box(mx1 - mx0, 0.04, mz1 - mz0, ceilTileM, mcx, CEIL + 0.02, mcz, ceilingGroup); mcl.receiveShadow = false;
  for (const lx2 of [mcx - 2, mcx + 2]) for (const lz of [mcz - 2, mcz + 2]) box(0.58, 0.02, 0.58, panelM, lx2, CEIL - 0.005, lz, ceilingGroup).castShadow = false;
  // mur du fond avec trois fenêtres
  let mp = mx0;
  for (const wx of [mx0 + 1.8, mcx, mx1 - 1.8]) {
    const a = wx - 0.8, b = wx + 0.8;
    box(a - mp, CEIL, 0.2, wallM, (mp + a) / 2, CEIL / 2, mz1 + 0.1, g); mp = b;
    box(1.6, 0.95, 0.2, wallM, wx, 0.475, mz1 + 0.1, g); box(1.6, CEIL - 2.55, 0.2, wallM, wx, (CEIL + 2.55) / 2, mz1 + 0.1, g);
    for (const y of [0.975, 2.525]) box(1.7, 0.05, 0.08, winFrameM, wx, y, mz1 + 0.05, g);
    for (const x of [a - 0.025, b + 0.025]) box(0.05, 1.6, 0.08, winFrameM, x, 1.75, mz1 + 0.05, g);
    const gl = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6), winGlassM); gl.position.set(wx, 1.75, mz1 + 0.08); gl.rotation.y = Math.PI; g.add(gl);
  }
  box(mx1 - mp, CEIL, 0.2, wallM, (mp + mx1) / 2, CEIL / 2, mz1 + 0.1, g);
  // porte (cadre bleu sans battant) et plaque
  box(0.98, 0.05, 0.22, frameBlueM, rx, 2.12, zc1 + 0.1, g);
  for (const sgn of [-1, 1]) box(0.04, 2.12, 0.22, frameBlueM, rx + sgn * 0.47, 1.06, zc1 + 0.1, g);
  const plate = canvasTex(256, 96, (ctx) => { ctx.fillStyle = '#f2f1ec'; ctx.fillRect(0, 0, 256, 96); ctx.fillStyle = '#2c3e8c'; ctx.fillRect(0, 0, 10, 96); ctx.fillStyle = '#222'; ctx.font = '700 26px sans-serif'; ctx.fillText('Salle de réunion', 22, 42); ctx.font = '18px sans-serif'; ctx.fillStyle = '#777'; ctx.fillText('Historique des agents', 22, 72); });
  const pl = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.19), new THREE.MeshBasicMaterial({ map: plate.tex, toneMapped: false })); pl.position.set(rx + 0.85, 1.6, zc1 - 0.005); pl.rotation.y = Math.PI; g.add(pl);
  // table, chaises
  box(4.2, 0.06, 1.5, pineM, mcx, 0.74, mcz, g, 0.03);
  for (const lx2 of [-1.7, 1.7]) box(0.08, 0.72, 1.1, blackM, mcx + lx2, 0.36, mcz, g);
  block(mcx, mcz, 4.2, 1.5);
  const mchair = (x, z, rot) => {
    const c = new THREE.Group(); c.position.set(x, 0, z); c.rotation.y = rot; g.add(c);
    box(0.46, 0.06, 0.44, blackM, 0, 0.46, 0, c, 0.03); box(0.46, 0.45, 0.06, blackM, 0, 0.72, 0.2, c, 0.03);
    for (const [lx2, lz] of [[-0.2, -0.18], [0.2, -0.18], [-0.2, 0.18], [0.2, 0.18]]) box(0.03, 0.45, 0.03, blackM, lx2, 0.22, lz, c);
  };
  for (const dx of [-1.5, -0.5, 0.5, 1.5]) { mchair(mcx + dx, mcz - 1.15, Math.PI); mchair(mcx + dx, mcz + 1.15, 0); }
  mchair(mcx - 2.55, mcz, Math.PI / 2); mchair(mcx + 2.55, mcz, -Math.PI / 2);
  plant(mx1 - 0.6, mz0 + 0.6, 1.2, true, g);
  // écran mural : historique par semaine et par mois
  const tv = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 1.7), new THREE.MeshBasicMaterial({ map: meetTex.tex, toneMapped: false }));
  tv.position.set(mx0 + 0.04, 1.65, mcz); tv.rotation.y = Math.PI / 2; g.add(tv);
  box(0.03, 1.8, 3.5, blackM, mx0 + 0.015, 1.65, mcz, g);
  interact(tv, { label: () => 'Regarder l’historique (semaines et mois)', act: () => focusOn(tv, 2.6), range: 7 });

  // plan d'évacuation de l'étage, à côté de l'ascenseur, avec « Vous êtes ici »
  const px = at(-0.84);
  const evac = canvasTex(768, 480, (ctx, W, H) => {
    ctx.fillStyle = '#fbfaf6'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#c0282d'; ctx.lineWidth = 6; ctx.strokeRect(8, 8, W - 16, H - 16);
    ctx.fillStyle = '#111'; ctx.font = '800 34px sans-serif'; ctx.fillText('PLAN D’ÉVACUATION', 32, 58);
    ctx.fillStyle = '#555'; ctx.font = '600 24px sans-serif'; ctx.fillText(floorName(et).replace(/^./, (c) => c.toUpperCase()), 32, 92);
    const m = 40, top = 130, sc = Math.min((W - 2 * m) / (xS1 - xN0), (H - top - 40) / (zB - zN));
    const P = (x, z) => [m + (x - xN0) * sc, top + (z - zN) * sc];
    const rect = (a, b, za, zb, fill) => { const [u, v] = P(a, za), [u2, v2] = P(b, zb); ctx.fillStyle = fill; ctx.fillRect(u, v, u2 - u, v2 - v); };
    rect(x0, XE, ZN, z1, '#f6d2bd'); rect(xc0, xc1, zc0, zc1, '#e4e2dc');
    for (const [a, b] of [st1, st2]) { const [u, v] = P(a, zc1), [u2, v2] = P(b, zc1 + stD); ctx.fillStyle = '#d9ecdf'; ctx.fillRect(u, v, u2 - u, v2 - v); ctx.strokeStyle = '#555'; ctx.lineWidth = 1; for (let k = u + 4; k < u2; k += 6) { ctx.beginPath(); ctx.moveTo(k, v); ctx.lineTo(k, v2); ctx.stroke(); } }
    ctx.strokeStyle = '#111'; ctx.lineWidth = 2;
    for (const [a, za, b, zb] of lines) { ctx.beginPath(); ctx.moveTo(...P(a, za)); ctx.lineTo(...P(b, zb)); ctx.stroke(); }
    ctx.lineWidth = 5; ctx.beginPath(); outline.forEach(([x, z], i) => ctx[i ? 'lineTo' : 'moveTo'](...P(x, z))); ctx.closePath(); ctx.stroke();
    // flèches vertes vers les deux escaliers
    ctx.strokeStyle = '#1f9d55'; ctx.fillStyle = '#1f9d55'; ctx.lineWidth = 4;
    for (const tx of [sx1, sx2]) {
      const [u, v] = P(px, zm), [u2] = P(tx, zm), d = Math.sign(u2 - u);
      ctx.beginPath(); ctx.moveTo(u + d * 14, v); ctx.lineTo(u2, v); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(u2 + d * 10, v); ctx.lineTo(u2 - d * 4, v - 8); ctx.lineTo(u2 - d * 4, v + 8); ctx.fill();
    }
    const [u, v] = P(px, zc1 - 0.2);
    ctx.fillStyle = '#1f6fd1'; ctx.beginPath(); ctx.arc(u, v, 11, 0, Math.PI * 2); ctx.fill();
    ctx.font = '700 20px sans-serif'; ctx.fillText('Vous êtes ici', u - 58, Math.min(H - 24, v + 36));
  });
  const evacM = new THREE.Mesh(new THREE.PlaneGeometry(0.96, 0.6), new THREE.MeshBasicMaterial({ map: evac.tex, toneMapped: false }));
  evacM.position.set(px, 1.55, zc1 - 0.025); evacM.rotation.y = Math.PI; g.add(evacM);
  box(1.0, 0.64, 0.02, mat(0xe8e6e1), px, 1.55, zc1 - 0.002, g).castShadow = false;
  interact(evacM, { label: () => 'Regarder le plan d’évacuation', act: () => focusOn(evacM, 1.1), range: 4 });
}

// =====================================================================
// La pièce : carrée, fenêtres au nord, salon et coin cuisine à l'est,
// porte dans le coin opposé aux fenêtres. Elle grandit en restant carrée.
// =====================================================================
let shell = null;
const shellParts = { north: null, south: null, west: null, east: null, ceiling: null, upper: null };
let ROOM_S = 10;
const shadowBox = { cx: 6, cz: 2 };
let roomWin = { xs: [], w: 1.3, y0: 0.95, y1: 2.55 }; // fenêtres de notre pièce (percées dans la façade) // centre de la zone où le soleil projette des ombres


function buildLounge(g) {
  const E = XE, N = ZN, SZ = shellZ1, x0 = shellX0;
  const zf = N + 4.1;                 // axe du futon
  const put = (m, x, y, z) => { m.position.set(x, y, z); g.add(m); m.castShadow = true; m.receiveShadow = true; return m; };
  const mine = CONFIG.decor === 'mon-bureau'; // détails propres au bureau d'origine (affiche, casque de moto)
  // table ronde blanche + affiche posée dessus
  put(new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.03, 28), mat(0xe8e6e2, { roughness: 0.3 })), E - 0.45, 0.55, N + 2.2);
  for (const a of [0, 2.1, 4.2]) { const l = box(0.02, 0.56, 0.02, metal, E - 0.45 + Math.cos(a) * 0.2, 0.27, N + 2.2 + Math.sin(a) * 0.2, g); l.rotation.z = Math.cos(a) * 0.2; }
  block(E - 0.45, N + 2.2, 0.7, 0.7);
  const poster = canvasTex(256, 320, (ctx, w, h) => {
    ctx.fillStyle = '#fafafa'; ctx.fillRect(0, 0, w, h); ctx.strokeStyle = '#cfcfcf'; ctx.lineWidth = 6; ctx.strokeRect(3, 3, w - 6, h - 6);
    if (mine) {
      ctx.fillStyle = '#6b6b6b'; ctx.font = '900 118px Helvetica, Arial, sans-serif'; ctx.fillText('LA', 26, 135);
      ctx.fillStyle = '#222'; ctx.font = '800 40px Helvetica, Arial, sans-serif'; ctx.fillText('HAUTE', 28, 200); ctx.fillText('JOAILLERIE', 28, 245);
    } else { // affiche neutre : l'astérisque et un aplat de couleur
      ctx.fillStyle = '#d97757'; ctx.fillRect(22, 22, w - 44, 170);
      ctx.fillStyle = '#fafafa'; ctx.font = '900 150px Helvetica, Arial, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('✻', w / 2, 165);
      ctx.fillStyle = '#222'; ctx.font = '800 30px Helvetica, Arial, sans-serif'; ctx.fillText('BUREAU', w / 2, 240); ctx.fillText('DES AGENTS', w / 2, 278); ctx.textAlign = 'left';
    }
  });
  const pst = put(new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.5), mat(0xffffff, { map: poster.tex })), E - 0.2, 0.82, N + 2.2);
  pst.rotation.y = -Math.PI / 2; pst.rotation.x = -0.12;
  // futon gris sur cadre à lattes, dos au mur est
  const futon = new THREE.Group(); futon.position.set(E - 0.55, 0, zf); futon.rotation.y = Math.PI / 2; g.add(futon);
  box(2.3, 0.1, 1.0, pineM, 0, 0.12, 0, futon);
  for (let i = 0; i < 6; i++) box(0.1, 0.72, 0.04, pineM, -1.0 + i * 0.4, 0.55, 0.5, futon);
  box(2.3, 0.08, 0.05, pineM, 0, 0.88, 0.5, futon);
  box(2.2, 0.2, 0.9, futonM, 0, 0.28, -0.03, futon, 0.09);
  box(2.2, 0.55, 0.22, futonM, 0, 0.6, 0.34, futon, 0.09);
  block(E - 0.55, zf, 1.1, 2.4);
  interact(futon, { label: () => 'S’asseoir sur le futon', act: sitDown, range: 3 });
  // table basse en planches croisées
  const TX = E - 2.15; // axe de la table basse
  const tb = new THREE.Group(); tb.position.set(TX, 0, zf); tb.rotation.y = Math.PI / 2; g.add(tb);
  for (const a of [0.38, -0.38]) {
    const p = box(1.1, 0.04, 0.32, pineM, 0, 0.4, 0, tb); p.rotation.y = a;
    const line = box(1.1, 0.005, 0.02, blackM, 0, 0.423, 0, tb); line.rotation.y = a;
  }
  for (const [lx, lz] of [[-0.35, -0.2], [0.35, 0.2], [-0.3, 0.25], [0.3, -0.25]]) box(0.05, 0.38, 0.22, pineM, lx, 0.19, lz, tb);
  block(TX, zf, 1.0, 1.2);
  // deux fauteuils verts
  function armchair(x, z, rot) {
    const a = new THREE.Group(); a.position.set(x, 0, z); a.rotation.y = rot; g.add(a);
    box(0.78, 0.13, 0.72, greenM, 0, 0.42, 0, a, 0.05);
    const back = box(0.84, 0.62, 0.12, greenM, 0, 0.74, 0.36, a, 0.05); back.rotation.x = -0.18;
    for (const sx of [-0.42, 0.42]) box(0.09, 0.26, 0.6, greenM, sx, 0.56, 0.03, a, 0.04);
    for (const [lx, lz] of [[-0.32, -0.28], [0.32, -0.28], [-0.32, 0.28], [0.32, 0.28]]) box(0.03, 0.36, 0.03, metal, lx, 0.18, lz, a);
    block(x, z, 0.9, 0.9);
    interact(a, { label: () => 'S’asseoir dans le fauteuil', act: sitDown, range: 3 });
  }
  const chairs = [[TX - 1.15, zf - 1.05], [TX - 0.95, zf + 1.25]].map(([x, z]) => {
    const dx = TX - x, dz = zf - z, d = Math.hypot(dx, dz), rot = Math.atan2(-dx, -dz); // dossier à l'opposé de la table
    armchair(x, z, rot);
    return { x, z, rot, front: [x + (dx / d) * 0.72, z + (dz / d) * 0.72] };
  });
  // coin cuisine à plat contre le mur est, de gauche à droite (vu de la pièce) :
  // étagère à cubes, micro-ondes + Nespresso avec le frigo dessous, case ouverte, évier dans le bac acier, poubelle
  const kc = SZ - 3.3;                     // axe de l'étagère à cubes
  const c0 = SZ - 2.85, c1 = SZ - 0.8;      // bac acier
  const cm = (c0 + c1) / 2, cl = c1 - c0, KX = E - 0.3;
  const cubes = new THREE.Group(); cubes.position.set(E - 0.22, 0, kc); g.add(cubes);
  box(0.4, 1.1, 0.03, pineM, 0, 0.55, -0.4, cubes); box(0.4, 1.1, 0.03, pineM, 0, 0.55, 0.4, cubes); box(0.4, 1.1, 0.03, pineM, 0, 0.55, 0, cubes);
  for (const y of [0.02, 0.38, 0.74, 1.1]) box(0.4, 0.03, 0.83, pineM, 0, y, 0, cubes);
  for (let i = 0; i < 4; i++) box(0.34, 0.07, 0.34, mat(0x2f4f9a, { roughness: 0.4 }), 0, 0.78 + i * 0.08, -0.2, cubes);
  box(0.3, 0.2, 0.3, mat(0x2c2c2c), 0, 0.14, 0.2, cubes); box(0.25, 0.08, 0.3, whiteM, 0, 0.44, 0.2, cubes);
  const lampArm = box(0.02, 0.42, 0.02, metal, -0.05, 1.3, -0.25, cubes); lampArm.rotation.z = 0.35;
  put(new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), metal), E - 0.35, 1.52, kc - 0.25);
  const osb = mat(0xffffff, { map: osbTex, roughness: 0.9 });
  const steel = mat(0xc4c7ca, { metalness: 0.25, roughness: 0.3 }); // sans reflets d'environnement, un acier très métallique paraît noir
  box(0.62, 0.86, 0.04, osb, KX, 0.43, c0 + 0.02);                        // joue OSB côté salon
  box(0.62, 0.04, cl, steel, KX, 0.88, cm);                               // bac acier
  box(0.04, 0.1, cl, steel, E - 0.02, 0.95, cm);                          // rebord arrière
  box(0.62, 0.04, 0.04, steel, KX, 0.92, c1 - 0.02);
  box(0.4, 0.14, 0.44, mat(0x9a9da1, { metalness: 0.25, roughness: 0.25 }), KX, 0.83, c1 - 0.38); // cuve de l'évier
  const tap = box(0.02, 0.22, 0.02, metal, E - 0.08, 1.0, c1 - 0.38, g); box(0.16, 0.02, 0.02, metal, E - 0.15, 1.1, c1 - 0.38, g);
  for (const z of [c0 + 0.05, c1 - 0.05]) box(0.04, 0.84, 0.04, pineM, E - 0.58, 0.42, z, g);
  box(0.52, 0.82, 0.52, whiteM, KX, 0.41, c0 + 0.35, g, 0.02);            // frigo sous le micro-ondes
  box(0.01, 0.06, 0.3, metal, KX - 0.27, 0.72, c0 + 0.35, g);
  box(0.46, 0.46, 0.02, whiteM, KX, 0.27, c0 + 0.66); box(0.46, 0.46, 0.02, whiteM, KX, 0.27, c0 + 1.14); // case ouverte
  box(0.46, 0.02, 0.48, whiteM, KX, 0.5, c0 + 0.9); box(0.46, 0.02, 0.48, whiteM, KX, 0.04, c0 + 0.9);
  box(0.3, 0.3, 0.34, mat(0x3aa39a), KX, 0.2, c0 + 0.9);                // sac vert
  box(0.35, 0.4, 0.3, mat(0xf2f0ec, { roughness: 1 }), KX, 0.2, c1 - 0.45); // sacs sous l'évier
  put(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.4, 8), mat(0x777a7e, { metalness: 0.6 })), E - 0.2, 0.6, c1 - 0.3);
  const mw = box(0.4, 0.28, 0.52, blackM, E - 0.3, 1.04, c0 + 0.35, g, 0.02);         // micro-ondes
  const mwDoor = box(0.01, 0.2, 0.34, mat(0x0c0c0c, { roughness: 0.15 }), E - 0.505, 1.04, c0 + 0.3, g); mwDoor.castShadow = false;
  microwave = { door: mwDoor, busy: false };
  interact(mw, { label: () => 'Lancer le micro-ondes', act: heatMicrowave });
  const nesp = box(0.26, 0.24, 0.14, blackM, E - 0.3, 1.3, c0 + 0.35, g, 0.03);         // Nespresso
  const cup = put(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.03, 0.07, 14), whiteM), E - 0.43, 1.215, c0 + 0.35); cup.visible = false;
  coffee = { cup, steamAt: new THREE.Vector3(E - 0.43, 1.26, c0 + 0.35), steamUntil: 0, busy: false };
  interact(nesp, { label: () => 'Faire un café', act: brewCoffee });
  put(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.2, 14), whiteM), E - 0.3, 1.0, c0 + 0.78);   // bouilloire
  put(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.26, 16), whiteM), E - 0.28, 1.03, c0 + 0.98); // essuie-tout
  put(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.12, 12), metal), E - 0.25, 0.96, c0 + 1.2);
  put(new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.64, 18), mat(0xc9ccce, { metalness: 0.3, roughness: 0.3 })), E - 0.3, 0.32, SZ - 0.5);
  // étagère aux cuivres et trois cadres au-dessus
  box(0.24, 0.03, 1.3, pineM, E - 0.12, 1.62, cm - 0.2);
  for (const dz of [-0.55, 0.45]) box(0.2, 0.3, 0.03, pineM, E - 0.1, 1.5, cm - 0.2 + dz, g);
  [-0.6, -0.35, -0.1, 0.15, 0.35].forEach((dz, i) => put(new THREE.Mesh(new THREE.CylinderGeometry(0.045 + (i % 2) * 0.01, 0.04, 0.09 + (i % 3) * 0.02, 16), i === 2 ? mat(0xc0392b) : copperM), E - 0.12, 1.68 + (i % 3) * 0.01, cm - 0.2 + dz));
  [-0.3, 0, 0.3].forEach((dz, i) => {
    box(0.02, 0.28, 0.22, pineM, E - 0.03, 1.93, cm - 0.2 + dz, g);
    const p = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.22), mat([0xd9c7a3, 0xc9b38a, 0xe0d2b8][i])); p.position.set(E - 0.045, 1.93, cm - 0.2 + dz); p.rotation.y = -Math.PI / 2; g.add(p);
  });
  block(E - 0.3, (kc - 0.45 + SZ) / 2, 0.65, SZ - kc + 0.45);
  // pilier blanc et guéridons hexagonaux devant la cuisine
  box(0.45, CEIL, 0.45, wallM, E - 2.3, CEIL / 2, SZ - 2.4, g); block(E - 2.3, SZ - 2.4, 0.45, 0.45);
  const hex = (x, z, h) => {
    const t = new THREE.Group(); t.position.set(x, 0, z); g.add(t);
    const frame = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, h, 6, 1, true), new THREE.MeshStandardMaterial({ color: 0x1e1f22, wireframe: true }));
    frame.position.y = h / 2; t.add(frame);
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.03, 6), pineM); top.position.y = h; top.castShadow = true; t.add(top);
    block(x, z, 0.35, 0.35);
  };
  hex(E - 2.95, SZ - 2.2, 0.62); hex(E - 2.1, SZ - 3.05, 0.72);
  // meuble noir en escalier le long du mur sud : haut côté cuisine (écran, classeurs), puis de plus en plus bas
  const bs = new THREE.Group(); bs.position.set(0, 0, SZ - 0.2); g.add(bs);
  const steps = [[E - 1.0, 1.25], [E - 1.9, 0.85], [E - 2.8, 0.46]];
  for (const [x, h] of steps) { // caissons ouverts : fond, joues, dessus et tablettes
    box(0.88, h, 0.03, blackM, x, h / 2, 0.175, bs);
    box(0.03, h, 0.38, blackM, x - 0.425, h / 2, 0, bs); box(0.03, h, 0.38, blackM, x + 0.425, h / 2, 0, bs);
    for (let y = 0.015; y < h; y += 0.4) box(0.88, 0.03, 0.38, blackM, x, y, 0, bs);
    box(0.88, 0.03, 0.38, blackM, x, h - 0.015, 0, bs);
  }
  box(0.62, 0.44, 0.05, mat(0x0d0d0f, { roughness: 0.2 }), E - 1.1, 1.48, 0.05, bs);            // écran posé en haut
  const gmt = canvasTex(128, 170, (ctx, w, h) => { ctx.fillStyle = '#10151c'; ctx.fillRect(0, 0, w, h); ctx.fillStyle = '#e8e8e8'; ctx.font = '700 26px serif'; if (mine) ctx.fillText('GMT', 30, 30); ctx.beginPath(); ctx.arc(64, 100, 34, 0, 7); ctx.fillStyle = '#c9ced6'; ctx.fill(); });
  const gp = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.42), mat(0xffffff, { map: gmt.tex })); gp.position.set(E - 0.68, 1.47, -0.05); gp.rotation.x = -0.12; bs.add(gp);
  [0x1f4fa0, 0x1f4fa0, 0x2458b5, 0x1f4fa0, 0x2e7d32, 0xc0392b, 0xc0392b].forEach((c, i) => box(0.07, 0.34, 0.3, mat(c), E - 1.35 + i * 0.09, 1.02, -0.02, bs));
  for (let i = 0; i < 3; i++) box(0.3, 0.2, 0.3, mat(i ? 0xa98a5f : 0xf2f0ec, { roughness: 0.95 }), E - 1.25 + i * 0.3, 0.52, -0.02, bs);
  for (let i = 0; i < 12; i++) box(0.05, 0.26 + (i % 3) * 0.03, 0.26, mat([0xf2c230, 0xc0392b, 0x1f4fa0, 0xeeeeee, 0xc0392b][i % 5]), E - 2.28 + i * 0.07, 0.6, -0.03, bs);
  box(0.24, 0.05, 0.16, blackM, E - 2.75, 0.49, 0, bs); box(0.14, 0.14, 0.14, whiteM, E - 2.5, 0.54, 0, bs); // box internet
  for (const [x, y] of [[E - 2.5, 0.12], [E - 2.95, 0.12], [E - 2.7, 0.36]]) box(0.4, 0.22, 0.3, mat(0xa98a5f, { roughness: 0.95 }), x, y, -0.4, bs);
  block(E - 1.9, SZ - 0.3, 2.7, 0.6);
  // tableau électrique et tuyaux (mur sud)
  box(0.42, 0.55, 0.06, whiteM, E - 3.9, 1.55, SZ - 0.03, g); box(0.12, 0.12, 0.04, mat(0x8fd14f), E - 3.8, 1.68, SZ - 0.07, g);
  for (const x of [E - 4.2, E - 4.12]) box(0.04, CEIL - 1.85, 0.04, whiteM, x, (CEIL + 1.85) / 2, SZ - 0.03, g);
  // porte à l'autre bout du mur sud (à droite quand on est dos à la fenêtre), interphone, cartons
  const pivot = new THREE.Group(); pivot.position.set(x0 + 1.2, 0, SZ - 0.03); g.add(pivot);
  box(0.9, 2.1, 0.05, mat(0x6b5a50, { roughness: 0.6 }), 0.45, 1.05, 0, pivot);
  for (const s of [-1, 1]) box(0.12, 0.03, 0.04, metal, 0.75, 1.02, s * 0.05, pivot);
  door = { pivot, open: door ? door.open : true, angle: door ? door.angle : 1.6 };
  pivot.rotation.y = door.angle;
  interact(pivot, { label: () => (door.open ? 'Fermer la porte' : 'Ouvrir la porte'), act: () => { door.open = !door.open; sfx('door'); } });
  const sw = box(0.08, 0.12, 0.02, whiteM, x0 + 2.3, 1.1, SZ - 0.02, g); box(0.03, 0.05, 0.02, mat(0xdddddd), x0 + 2.3, 1.1, SZ - 0.035, g);
  interact(sw, { label: () => (lightsOn ? 'Éteindre la lumière' : 'Allumer la lumière'), act: toggleLights });
  box(0.96, 0.05, 0.06, mat(0x2c3e8c), x0 + 1.65, 2.12, SZ - 0.03, g);
  for (const s of [-1, 1]) box(0.04, 2.12, 0.06, mat(0x2c3e8c), x0 + 1.65 + s * 0.47, 1.06, SZ - 0.03, g);
  box(0.08, 0.2, 0.05, whiteM, x0 + 2.45, 1.45, SZ - 0.03, g);
  box(0.5, 0.7, 0.2, mat(0xa98a5f, { roughness: 0.95 }), x0 + 2.95, 0.35, SZ - 0.15, g);
  // chaises noires empilées et table ronde repliée dans le coin sud-ouest
  for (let i = 0; i < 3; i++) {
    const c = new THREE.Group(); c.position.set(x0 + 0.35, 0, SZ - 1.75 + i * 0.5); c.rotation.y = -Math.PI / 2; g.add(c);
    box(0.46, 0.06, 0.44, blackM, 0, 0.46, 0, c, 0.03); box(0.46, 0.45, 0.06, blackM, 0, 0.72, 0.2, c, 0.03);
    for (const [lx, lz] of [[-0.2, -0.18], [0.2, -0.18], [-0.2, 0.18], [0.2, 0.18]]) box(0.03, 0.45, 0.03, blackM, lx, 0.22, lz, c);
  }
  block(x0 + 0.35, SZ - 1.25, 0.5, 1.6);
  const disc = put(new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.03, 32), whiteM), x0 + 0.75, 0.46, SZ - 0.35);
  disc.rotation.z = Math.PI / 2 - 0.12; disc.rotation.y = 0.5;
  // casque de moto par terre
  if (mine) {
    const helmet = put(new THREE.Mesh(new THREE.SphereGeometry(0.15, 18, 14), mat(0x151515, { roughness: 0.25 })), x0 + 1.4, 0.14, SZ - 2.6);
    helmet.scale.y = 0.9;
  }

  // places, par ordre de préférence
  LOUNGE.length = 0;
  const add = (spot, pose, via, dy = -0.03) => LOUNGE.push({ ...spot, pose, via, dy, taken: null });
  for (const lx of [0, 0.7, -0.7]) { const s = seatSpot(E - 0.55, zf, Math.PI / 2, lx); add(s, 'sit', [[E - 3.4, N + 1.9], [E - 1.38, N + 1.9], [E - 1.38, s.z]], -0.08); }
  for (const c of chairs) add(seatSpot(c.x, c.z, c.rot), 'sit', [[TX - 1.9, zf + 0.1], c.front]);
  for (const [x, z] of [[E - 0.95, c0 + 0.35], [E - 0.95, c0 + 1.0], [E - 1.5, c0 + 0.65]]) add({ x, z, yaw: -Math.PI / 2 }, 'coffee', [[E - 1.4, kc - 0.9]], 0);
  add({ x: x0 + 1.15, z: N + 1.3, yaw: Math.PI / 2 }, 'print', [[x0 + 2.3, N + 2.4]], 0); // devant l'imprimante
  for (const x of [E - 1.95, E - 1.15]) add({ x, z: N + 0.5, yaw: 0 }, 'window', [[E - 2.6, N + 1.4], [x, N + 1.2]], 0);
  add({ x: E - 1.9, z: SZ - 1.0, yaw: Math.PI }, 'read', [[E - 1.5, SZ - 1.6]], 0);
  HUB.x = E - 4.4; HUB.z = N + ROOM_S * 0.55;
  // grand écran au-dessus du futon
  // grand écran : à droite du salon, sur le mur est entre le futon et le pilier de la cuisine
  const s0 = zf + 1.2, s1 = kc - 0.65, sc = Math.min(1, (s1 - s0 - 0.1) / 2.5), zc = (s0 + s1) / 2;
  statsScreen.scale.set(sc, sc, 1); statsFrame.scale.set(1, sc, sc);
  statsScreen.position.set(E - 0.04, 1.95, zc); statsFrame.position.set(E - 0.02, 1.95, zc);
}

function buildShell(S) {
  if (shell) { scene.remove(shell); disposeTree(shell); }
  shell = new THREE.Group(); scene.add(shell);
  resetInteractables(); blinds.length = 0;
  if (seated) { camera.position.copy(seated.prev); seated = null; }
  ROOM_S = S; shellX0 = XE - S; shellZ1 = ZN + S;
  const x0 = shellX0, z1 = shellZ1, W = S, cx = x0 + W / 2, cz = (ZN + z1) / 2;
  // moquette anthracite
  const cm = carpetM.clone(); cm.map = carpetTex.clone(); cm.map.needsUpdate = true; cm.map.repeat.set(W / 1.5, S / 1.5);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, S), cm);
  floor.rotation.x = -Math.PI / 2; floor.position.set(cx, 0, cz); floor.receiveShadow = true; shell.add(floor);
  // faux plafond à dalles, dalles LED, cassette de clim
  const ceiling = new THREE.Group(); shell.add(ceiling); shellParts.ceiling = ceiling;
  const tm = ceilTileM.clone(); tm.map = tileTex.clone(); tm.map.needsUpdate = true; tm.map.repeat.set(W / 0.6, S / 0.6); tm.emissiveMap = tm.map;
  const ceil = box(W, 0.04, S, tm, cx, CEIL + 0.02, cz, ceiling); ceil.receiveShadow = false;
  const spots = [];
  for (let x = x0 + 1.5; x < XE - 0.5; x += 2.4) for (let z = ZN + 1.5; z < z1 - 0.5; z += 2.4) spots.push([x, z]);
  const leds = new THREE.InstancedMesh(new THREE.BoxGeometry(0.58, 0.02, 0.58), panelM, spots.length);
  spots.forEach(([x, z], i) => leds.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, CEIL - 0.005, z)));
  ceiling.add(leds);
  const acX = XE - 3.6, acZ = ZN + S * 0.55;
  const ac = box(0.84, 0.07, 0.84, whiteM, acX, CEIL - 0.03, acZ, ceiling); ac.castShadow = false;
  const grille = canvasTex(128, 128, (ctx, w, h) => { ctx.fillStyle = '#eee'; ctx.fillRect(0, 0, w, h); ctx.fillStyle = '#aaa'; for (let i = 0; i < 4; i++) { ctx.fillRect(14, 14 + i * 3, 100, 1); ctx.fillRect(14, 110 - i * 3, 100, 1); ctx.fillRect(14 + i * 3, 14, 1, 100); ctx.fillRect(110 - i * 3, 14, 1, 100); } ctx.fillStyle = '#d6d6d6'; ctx.fillRect(40, 40, 48, 48); });
  const gp = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.8), mat(0xffffff, { map: grille.tex })); gp.rotation.x = Math.PI / 2; gp.position.set(acX, CEIL - 0.07, acZ); ceiling.add(gp);
  // murs : sud (porte côté ouest), ouest, est (salon et cuisine)
  shellParts.south = new THREE.Group(); shell.add(shellParts.south);
  const doorA = x0 + 1.2, doorB = x0 + 2.1, xs1 = XE;
  box(doorA - x0, CEIL, 0.2, wallM, (x0 + doorA) / 2, CEIL / 2, z1 + 0.1, shellParts.south);
  box(xs1 - doorB, CEIL, 0.2, wallM, (doorB + xs1) / 2, CEIL / 2, z1 + 0.1, shellParts.south);
  box(doorB - doorA, CEIL - 2.1, 0.2, wallM, (doorA + doorB) / 2, (CEIL + 2.1) / 2, z1 + 0.1, shellParts.south);
  shellParts.west = box(0.2, CEIL, S, wallM, x0 - 0.1, CEIL / 2, cz, shell);
  const east = new THREE.Group(); shell.add(east); shellParts.east = east;
  box(0.2, CEIL, S, wallM, XE + 0.1, CEIL / 2, cz, east);
  const skirt = mat(0xdedbd4);
  box(xs1 - x0, 0.08, 0.02, skirt, (x0 + xs1) / 2, 0.04, z1 - 0.01, shell); box(0.02, 0.08, S, skirt, x0 + 0.01, 0.04, cz, shell);
  // mur nord : hautes fenêtres à stores vénitiens (la plus à l'est est dégagée : on peut s'y coller)
  const north = new THREE.Group(); shell.add(north); shellParts.north = north;
  const wins = [];
  for (let x = XE - 1.55; x > x0 + 1.0; x -= 3.3) wins.unshift(x);
  const WW = 1.3, SILL = 0.95, TOPW = 2.55;
  roomWin = { xs: wins, w: WW, y0: SILL, y1: TOPW };
  let prev = x0;
  const wall = (a, b, y0, y1) => { if (b - a > 0.01) box(b - a, y1 - y0, 0.2, wallM, (a + b) / 2, (y0 + y1) / 2, ZN - 0.1, north); };
  const sq = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.55, 0, 0)), one = new THREE.Vector3(1, 1, 1);
  const SLATS = Math.ceil((TOPW - SILL) / 0.028);
  wins.forEach((wx, i) => {
    const a = wx - WW / 2, b = wx + WW / 2;
    wall(prev, a, 0, CEIL); prev = b;
    wall(a, b, 0, SILL); wall(a, b, TOPW, CEIL);
    box(WW + 0.1, 0.05, 0.08, winFrameM, wx, SILL + 0.025, ZN - 0.05, north); box(WW + 0.1, 0.05, 0.08, winFrameM, wx, TOPW - 0.025, ZN - 0.05, north);
    box(0.05, TOPW - SILL, 0.08, winFrameM, a - 0.025, (SILL + TOPW) / 2, ZN - 0.05, north); box(0.05, TOPW - SILL, 0.08, winFrameM, b + 0.025, (SILL + TOPW) / 2, ZN - 0.05, north);
    box(0.05, 0.12, 0.05, winFrameM, b - 0.06, (SILL + TOPW) / 2, ZN + 0.01, north); // poignée
    box(WW + 0.2, 0.03, 0.18, whiteM, wx, SILL - 0.01, ZN + 0.05, north);
    const wg = new THREE.Group(); north.add(wg);
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(WW, TOPW - SILL), winGlassM); glass.position.set(wx, (SILL + TOPW) / 2, ZN - 0.08); wg.add(glass);
    box(WW + 0.06, 0.05, 0.07, blindM, wx, TOPW - 0.04, ZN + 0.06, wg);
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(WW, 0.003, 0.026), blindM, SLATS);
    for (let k = 0; k < SLATS; k++) mesh.setMatrixAt(k, new THREE.Matrix4().compose(new THREE.Vector3(wx, TOPW - 0.08 - k * 0.028, ZN + 0.06), sq, one));
    mesh.castShadow = true; wg.add(mesh);
    const bar = box(WW + 0.04, 0.02, 0.05, blindM, wx, TOPW - 0.08, ZN + 0.06, wg);
    const key = Math.round(wx - XE);
    const bl = { key, mesh, bar, cover: blindPrefs[key] ?? (wx > XE - 3.3 ? 0.12 : [0.55, 0.3, 0.42, 0.25, 0.5][i % 5]) };
    setBlind(bl); blinds.push(bl);
    interact(wg, { label: () => (bl.cover > 0.3 ? 'Remonter le store' : 'Baisser le store'), act: () => toggleBlind(bl), range: 3.2 });
  });
  wall(prev, XE, 0, CEIL);
  // plans de travail en pin : sous les fenêtres, contre le mur ouest (imprimante), et au sud si besoin
  const counter = (a0, a1, rot, at) => {
    const len = a1 - a0, c = at((a0 + a1) / 2);
    const grp = new THREE.Group(); grp.position.set(c.x, 0, c.z); grp.rotation.y = rot; shell.add(grp);
    const pm = pineM.clone(); pm.map = pineTex.clone(); pm.map.needsUpdate = true; pm.map.repeat.set(len / 3, 1);
    box(len, 0.05, 0.8, pm, 0, 0.75, 0, grp);
    for (let x = -len / 2 + 0.3; x < len / 2 - 0.1; x += 2.3) {
      const l1 = box(0.05, 0.75, 0.05, pineM, x, 0.37, -0.25, grp); l1.rotation.z = 0.12;
      const l2 = box(0.05, 0.75, 0.05, pineM, x, 0.37, 0.25, grp); l2.rotation.z = -0.12;
      box(0.05, 0.05, 0.6, pineM, x, 0.2, 0, grp);
    }
    const along = Math.abs(Math.cos(rot)) > 0.5;
    block(c.x, c.z, along ? len : 0.8, along ? 0.8 : len);
  };
  counter(x0 + 0.05, XE - 3.3, 0, SIDES.N.at);
  counter(ZN + 0.85, z1 - 2.2, Math.PI / 2, SIDES.W.at);
  if (layoutUsesSouth) counter(x0 + 3.5, XE - 4.5, Math.PI, SIDES.S.at);
  // imprimante au bout nord du plan ouest
  const pr = new THREE.Group(); shell.add(pr);
  box(0.42, 0.3, 0.5, whiteM, x0 + 0.4, 0.93, ZN + 1.3, pr, 0.02);
  box(0.3, 0.08, 0.36, whiteM, x0 + 0.42, 1.12, ZN + 1.3, pr);
  box(0.02, 0.12, 0.3, mat(0x222222), x0 + 0.62, 0.92, ZN + 1.3, pr);
  const sheet = box(0.21, 0.004, 0.29, paperM, x0 + 0.45, 0.86, ZN + 1.3, shell); sheet.rotation.y = Math.PI / 2; sheet.visible = false;
  printer = { sheet, sheetFrom: sheet.position.clone(), sheetDir: new THREE.Vector3(1, 0, 0), t0: 0 };
  interact(pr, { label: () => 'Imprimer le rapport du jour', act: printReport });
  // salon, cuisine, porte, puis l'immeuble autour
  buildLounge(shell);
  const upper = new THREE.Group(); shell.add(upper); shellParts.upper = upper;
  buildBuilding(shell, ceiling, upper);
  // tableau blanc au mur ouest, au-dessus des écrans
  boardMesh.position.set(x0 + 0.04, 2.05, cz - 0.6); boardFrame.position.set(x0 + 0.015, 2.05, cz - 0.6);
  // ombres du soleil sur la pièce, le couloir et la salle de réunion (sans quoi il éclairerait à travers les murs)
  const bx0 = Math.min(BLD.wc[0], x0), bx1 = Math.max(CORR.x1, XE), bz1 = MEET.z1;
  Object.assign(shadowBox, { cx: (bx0 + bx1) / 2, cz: (ZN + bz1) / 2 });
  const ext = Math.hypot(bx1 - bx0, bz1 - ZN) / 2 + 1;
  Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: 140 });
  sun.shadow.camera.updateProjectionMatrix();
}

// =====================================================================
// Zones par projet le long des plans de travail (fenêtres, mur sud, mur ouest)
// =====================================================================
let rooms = [];
let desks = [];
const assign = new Map(); // id d'agent -> poste
const SEAT = 1.7;
let layoutUsesSouth = false; // le plan sud n'apparaît que s'il faut plus de places
// Les trois plans de travail : rotation du poste et centre du plan à l'abscisse a
const SIDES = {
  N: { rot: 0, at: (a) => ({ x: a, z: ZN + 0.4 }) },
  S: { rot: Math.PI, at: (a) => ({ x: a, z: shellZ1 - 0.4 }) },
  W: { rot: Math.PI / 2, at: (a) => ({ x: shellX0 + 0.4, z: a }) },
};
function segments(S) {
  const x0 = XE - S, z1 = ZN + S;
  return { N: [x0 + 1.2, XE - 3.3], W: [ZN + 1.9, z1 - 2.4], S: [x0 + 3.6, XE - 4.6] };
}
function computeLayout(need) {
  const items = [...need.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  // range les projets le long des plans (fenêtres, puis mur ouest, puis sud) ; un gros projet peut déborder sur le plan suivant
  const fit = (S, extra) => {
    const seg = segments(S);
    const cur = { N: seg.N[1], S: seg.S[1], W: seg.W[0] };
    const left = (k) => (k === 'W' ? seg.W[1] - cur.W : cur[k] - seg[k][0]);
    const zones = [];
    for (const [idx, [name, n]] of items.entries()) {
      let rest = n + extra(idx);
      const whole = ['N', 'W', 'S'].find((k) => left(k) >= rest * SEAT - 1e-6);
      for (const side of whole ? [whole] : ['N', 'W', 'S']) {
        const cap = Math.min(rest, Math.floor((left(side) + 1e-6) / SEAT));
        if (cap <= 0) continue;
        const len = cap * SEAT;
        if (side === 'W') { zones.push({ name, side, cap, a0: cur.W, a1: cur.W + len }); cur.W += len + 0.3; }
        else { zones.push({ name, side, cap, a0: cur[side] - len, a1: cur[side] }); cur[side] -= len + 0.3; }
        rest -= cap;
        if (!rest) break;
      }
      if (rest > 0) return null;
    }
    return zones;
  };
  const none = () => 0, perProject = () => 1, oneFree = (i) => (i === 0 ? 1 : 0);
  // au moins 12 m : la place du salon, de la cuisine et du grand écran
  let S0 = 12; while (!fit(S0, none) && S0 < 60) S0 += SEAT;
  // des places libres (pour les prochaines sessions… et pour toi), sans trop agrandir la pièce
  for (const S of [S0, S0 + SEAT]) for (const extra of [perProject, oneFree]) { const z = fit(S, extra); if (z) return { rooms: z, S }; }
  return { rooms: fit(S0, none) || [], S: S0 };
}

function buildRoom({ name, side, cap, a0, a1 }) {
  const g = new THREE.Group(); scene.add(g);
  const { rot, at } = SIDES[side], hue = hashHue(name);
  const back = { x: Math.sin(rot), z: Math.cos(rot) };
  const room = { name, side, cap, a0, a1, group: g, color: projColor(name), desks: [] };
  // tapis aux couleurs du projet sous les chaises
  const mid = at((a0 + a1) / 2);
  const rugG = new THREE.Group(); rugG.position.set(mid.x + back.x * 1.05, 0.004, mid.z + back.z * 1.05); rugG.rotation.y = rot; g.add(rugG);
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(a1 - a0 - 0.1, 1.15), mat(new THREE.Color().setHSL(hue / 360, 0.35, 0.3), { roughness: 1 }));
  rug.rotation.x = -Math.PI / 2; rug.receiveShadow = true; rugG.add(rug);
  // écran de stats suspendu, perpendiculaire au plan, au bout de la zone côté salon
  room.stats = canvasTex(1024, 512);
  const endA = side === 'W' ? a0 : a1, end = at(endA);
  const blade = new THREE.Group(); blade.position.set(end.x + back.x * 1.05, 2.36, end.z + back.z * 1.05); blade.rotation.y = rot + Math.PI / 2; g.add(blade);
  box(1.04, 0.54, 0.05, blackM, 0, 0, 0, blade);
  for (const r of [-1, 1]) {
    const face = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.5), new THREE.MeshBasicMaterial({ map: room.stats.tex, toneMapped: false }));
    face.position.z = r * 0.027; face.rotation.y = r > 0 ? 0 : Math.PI; blade.add(face);
  }
  for (const dz of [-0.4, 0.4]) { const rodM = box(0.01, CEIL - 2.63, 0.01, metal, dz, (CEIL - 2.63) / 2 + 0.27, 0, blade); rodM.castShadow = false; }
  for (let i = 0; i < cap; i++) {
    const a = side === 'W' ? a0 + SEAT / 2 + i * SEAT : a1 - SEAT / 2 - i * SEAT;
    const p = at(a);
    const desk = makeDesk(p.x, p.z, rot, g, i);
    desk.room = room;
    room.desks.push(desk);
  }
  return room;
}

function drawRoomStats(room, ps) {
  const agents = room.desks.filter((d) => d.data).map((d) => d.data.status);
  const hist = lastStats?.projectHistory?.[room.name] || [], dates = lastStats?.history || [];
  const key = JSON.stringify(ps || null) + agents.join() + new Date().getHours() + hist.join();
  if (room.statsKey === key) return; room.statsKey = key;
  const { ctx, canvas, tex } = room.stats; const W = canvas.width, Hh = canvas.height;
  const sans = '-apple-system, "Segoe UI", sans-serif', col = '#' + room.color.getHexString();
  ctx.fillStyle = '#1b1816'; ctx.fillRect(0, 0, W, Hh);
  ctx.fillStyle = col; ctx.fillRect(0, 0, 14, Hh);
  ctx.fillStyle = '#f4efe8'; ctx.font = `700 52px ${sans}`; ctx.fillText(fitText(ctx, room.name, 500), 40, 68);
  agents.forEach((st, i) => { ctx.fillStyle = STATUS[st].color; ctx.beginPath(); ctx.arc(60 + ctx.measureText(fitText(ctx, room.name, 500)).width + 30 + i * 34, 50, 12, 0, 7); ctx.fill(); });
  ctx.fillStyle = '#9a9189'; ctx.font = `24px ${sans}`;
  ctx.fillText(ps ? `Aujourd'hui · ${ps.sessions} session${ps.sessions > 1 ? 's' : ''}` : "Aujourd'hui", 42, 104);
  const label = (t, x, y) => { ctx.fillStyle = '#9a9189'; ctx.font = `600 16px ${sans}`; ctx.fillText(t, x, y); };
  // à gauche : le jour en cours
  if (ps) {
    ctx.fillStyle = col; ctx.font = `700 84px ${sans}`; ctx.fillText(fmt(ps.tokens.output), 40, 215);
    ctx.fillStyle = '#d9d2c9'; ctx.font = `24px ${sans}`; ctx.fillText('tokens générés', 44, 250);
    ctx.fillStyle = '#9a9189'; ctx.fillText(`${ps.calls} actions · ${ps.messages} réponses`, 44, 285);
    ctx.fillText(`${dur(ps.activeMs)} de travail · ≈ ${eur(ps.cost)}`, 44, 318);
  } else {
    ctx.fillStyle = '#9a9189'; ctx.font = `30px ${sans}`;
    ctx.fillText(lastStats?.ready ? "Pas d'activité aujourd'hui" : "Lecture de l'historique…", 42, 210);
  }
  // à droite : activité par heure aujourd'hui, puis tokens générés sur les derniers jours
  const bx = 590, now = new Date().getHours();
  label('PAR HEURE', bx, 96);
  const hours = ps?.hours || Array(24).fill(0), hm = Math.max(1, ...hours);
  hours.forEach((n, h) => {
    const hg = Math.max(3, (n / hm) * 66);
    ctx.fillStyle = h === now ? '#d97757' : n ? col : '#3a322d';
    roundRect(ctx, bx + h * 17, 176 - hg, 14, hg, 3); ctx.fill();
  });
  ctx.fillStyle = '#9a9189'; ctx.font = `15px ${sans}`;
  [0, 6, 12, 18].forEach((h) => ctx.fillText(`${h}h`, bx + h * 17, 194));
  if (hist.length) {
    const total = hist.reduce((a, c) => a + c, 0);
    label(`${hist.length} DERNIERS JOURS · ${fmt(total)} tokens`, bx, 228);
    const dm = Math.max(1, ...hist), bw = Math.floor(400 / hist.length) - 6;
    hist.forEach((v, i) => {
      const x = bx + i * (bw + 6), hg = Math.max(3, (v / dm) * 62), last = i === hist.length - 1;
      ctx.fillStyle = last ? '#d97757' : v ? col : '#3a322d';
      roundRect(ctx, x, 306 - hg, bw, hg, 3); ctx.fill();
      ctx.fillStyle = last ? '#f4efe8' : '#9a9189'; ctx.font = `14px ${sans}`; ctx.textAlign = 'center';
      if (dates[i]) ctx.fillText(String(+dates[i].date.slice(8)), x + bw / 2, 324);
      ctx.textAlign = 'left';
    });
  }
  const bars = (items, x, y, w, color) => {
    const m = Math.max(1, ...items.map((i) => i[1]));
    items.forEach(([nm, n], i) => {
      const yy = y + i * 36;
      ctx.fillStyle = 'rgba(255,255,255,.06)'; roundRect(ctx, x, yy - 22, w, 30, 6); ctx.fill();
      ctx.fillStyle = color; roundRect(ctx, x, yy - 22, Math.max(6, (n / m) * w), 30, 6); ctx.fill();
      ctx.fillStyle = '#f4efe8'; ctx.font = `20px ${sans}`; ctx.fillText(fitText(ctx, nm, w - 70), x + 10, yy);
      ctx.textAlign = 'right'; ctx.fillText(n, x + w - 8, yy); ctx.textAlign = 'left';
    });
  };
  label("OUTILS AUJOURD'HUI", 42, 366); label("FICHIERS MODIFIÉS AUJOURD'HUI", 540, 366);
  if (ps?.tools.length) bars(ps.tools.slice(0, 3), 40, 402, 440, 'rgba(217,119,87,.55)');
  if (ps?.files.length) bars(ps.files, 540, 402, 440, 'rgba(96,165,250,.45)');
  ctx.fillStyle = '#6b625a'; ctx.font = `20px ${sans}`;
  if (!ps?.tools.length) ctx.fillText('—', 44, 402);
  if (!ps?.files.length) ctx.fillText("aucun pour l'instant", 542, 402);
  tex.needsUpdate = true;
}

// =====================================================================
// Poste de travail (sur le plan en pin)
// =====================================================================
const PAPER_SLOTS = [[-0.68, 0.2], [-0.7, -0.18], [0.74, -0.24], [-0.45, 0.3]];
const MUG_SLOTS = [[-0.3, -0.05], [-0.82, 0.3], [0.82, 0.32], [-0.58, -0.02]];
const chairDark = mat(0x4a4a4e, { roughness: 0.85 }), chairBlack = mat(0x1f1f22, { roughness: 0.6 });
function makeDesk(x, z, rot, parent, index = 0) {
  const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rot; parent.add(g);
  // écran principal (large, comme l'écran incurvé du vrai bureau)
  const wide = index % 2 === 0;
  const SW = wide ? 1.2 : 0.96, SH = wide ? 0.46 : 0.56;
  box(0.08, 0.28, 0.08, metal, 0, 0.92, -0.26, g);
  const foot = box(0.34, 0.03, 0.22, pineM, 0, 0.79, -0.26, g); foot.rotation.y = 0.05;
  box(SW + 0.05, SH + 0.05, 0.04, dark, 0, 1.3, -0.28, g, 0.012);
  const scr = canvasTex(512, wide ? 196 : 300);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(SW, SH),
    new THREE.MeshStandardMaterial({ map: scr.tex, emissiveMap: scr.tex, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.3 }));
  screen.position.set(0, 1.3, -0.252); g.add(screen);
  // portable ouvert (terminal)
  const lap = new THREE.Group(); lap.position.set(0.62, 0.78, 0.08); lap.rotation.y = -0.35; g.add(lap);
  box(0.32, 0.015, 0.22, mat(0x9ea3a8, { metalness: 0.6, roughness: 0.35 }), 0, 0.008, 0, lap);
  const lid = new THREE.Group(); lid.position.set(0, 0.015, -0.11); lid.rotation.x = -0.28; lap.add(lid);
  box(0.32, 0.21, 0.01, mat(0x9ea3a8, { metalness: 0.6, roughness: 0.35 }), 0, 0.105, 0, lid);
  const term = canvasTex(256, 160);
  const termScreen = new THREE.Mesh(new THREE.PlaneGeometry(0.29, 0.18),
    new THREE.MeshStandardMaterial({ map: term.tex, emissiveMap: term.tex, emissive: 0xffffff, emissiveIntensity: 0.8 }));
  termScreen.position.set(0, 0.105, 0.006); lid.add(termScreen);
  // clavier, souris, mug
  box(0.44, 0.02, 0.14, mat(0xe9e9ea), 0, 0.785, 0.26, g, 0.008);
  box(0.06, 0.02, 0.1, mat(0xe9e9ea), 0.33, 0.785, 0.27, g, 0.01);
  const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.04, 0.1, 16), mat([0xd97757, 0xf4efe8, 0x6c8ebf, 0x3b3b3b][index % 4]));
  mug.position.set(0.32, 0.825, -0.06); mug.castShadow = true; g.add(mug);
  // chaise : fauteuil gaming gris ou chaise de bureau noire
  const chair = new THREE.Group(); chair.position.set(0, 0, 0.85); g.add(chair);
  box(0.05, 0.42, 0.05, metal, 0, 0.23, 0, chair);
  for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2; const leg = box(0.32, 0.03, 0.04, metal, Math.cos(a) * 0.16, 0.04, Math.sin(a) * 0.16, chair); leg.rotation.y = -a; }
  if (index % 2 === 0) {
    box(0.56, 0.1, 0.52, chairDark, 0, 0.47, 0, chair, 0.04);
    const back = box(0.52, 0.95, 0.1, chairDark, 0, 0.98, 0.27, chair, 0.05); back.rotation.x = 0.08;
    box(0.3, 0.14, 0.09, chairBlack, 0, 1.33, 0.22, chair, 0.04);
    box(0.34, 0.16, 0.08, chairBlack, 0, 0.72, 0.22, chair, 0.04);
    for (const sx of [-0.3, 0.3]) { box(0.05, 0.22, 0.05, chairBlack, sx, 0.62, 0.02, chair); box(0.08, 0.03, 0.26, chairBlack, sx, 0.74, 0.02, chair); }
  } else {
    box(0.52, 0.07, 0.5, chairBlack, 0, 0.47, 0, chair, 0.03);
    box(0.5, 0.6, 0.06, chairBlack, 0, 0.85, 0.25, chair, 0.03);
  }
  // anneau d'état au sol, nuage d'orage, désordre
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.62, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 }));
  ring.rotation.x = -Math.PI / 2; ring.position.set(0, 0.012, 0.85); g.add(ring);
  const storm = makeStorm(); storm.position.set(0, 2.05, -0.28); g.add(storm);
  const clutter = new THREE.Group(); g.add(clutter);
  const back = { x: Math.sin(rot), z: Math.cos(rot) };
  interact(chair, { label: () => (desk.agent ? 'Poste occupé' : 'S\u2019asseoir à ce poste'), act: () => sitAtDesk(desk) });
  const desk = {
    group: g, rot, back, chair, screen, scr, term, termScreen, ring, storm, clutter, clutterKey: '', agent: null, data: null, robots: [],
    pos: new THREE.Vector3(x, 0, z), seat: { x: x + back.x * 0.8, z: z + back.z * 0.8 },
  };
  drawScreen(desk); drawTerm(desk);
  return desk;
}

function setClutter(desk, workload) {
  const papers = Math.min(4, Math.floor(workload / 80)), mugs = Math.min(4, Math.floor(workload / 150));
  const key = papers + ':' + mugs;
  if (desk.clutterKey === key) return;
  desk.clutterKey = key;
  desk.clutter.clear();
  for (let i = 0; i < papers; i++) {
    const [px, pz] = PAPER_SLOTS[i]; const n = 3 + Math.floor(Math.random() * 6) + i * 2;
    for (let k = 0; k < n; k++) {
      const sh = box(0.21, 0.006, 0.29, paperM, px + (Math.random() - 0.5) * 0.03, 0.782 + k * 0.007, pz + (Math.random() - 0.5) * 0.03, desk.clutter);
      sh.rotation.y = (Math.random() - 0.5) * 0.3; sh.castShadow = false;
    }
  }
  for (let i = 0; i < mugs; i++) {
    const [mx, mz] = MUG_SLOTS[i];
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.04, 0.1, 14), mat(new THREE.Color().setHSL(Math.random(), 0.3, 0.6)));
    m.position.set(mx, 0.825, mz); m.castShadow = true; desk.clutter.add(m);
  }
}

function makeStorm() {
  const g = new THREE.Group(); g.visible = false;
  const cloudM = new THREE.MeshStandardMaterial({ color: 0x4b4f58, roughness: 1, emissive: 0xffffff, emissiveIntensity: 0 });
  [[0, 0, 0, 0.2], [0.2, -0.03, 0, 0.15], [-0.2, -0.02, 0.02, 0.16], [0.09, 0.09, 0, 0.14], [-0.09, 0.08, -0.02, 0.13]].forEach(([x, y, z, r]) => {
    const sp = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 10), cloudM); sp.position.set(x, y, z); g.add(sp);
  });
  const dropM = new THREE.MeshBasicMaterial({ color: 0x8ab4ff });
  g.userData = { cloudM, drops: [] };
  for (let i = 0; i < 10; i++) {
    const d = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.08, 0.01), dropM);
    d.position.set((Math.random() - 0.5) * 0.45, -0.2, (Math.random() - 0.5) * 0.22); d.userData.phase = Math.random();
    g.add(d); g.userData.drops.push(d);
  }
  const bolt = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.3, 0.01), new THREE.MeshBasicMaterial({ color: 0xfff27a }));
  bolt.position.set(0.05, -0.3, 0.1); bolt.rotation.z = 0.35; bolt.visible = false; g.add(bolt); g.userData.bolt = bolt;
  return g;
}

// =====================================================================
// Personnage
// =====================================================================
const zTex = canvasTex(64, 64, (ctx) => { ctx.font = '700 52px sans-serif'; ctx.fillStyle = '#5b6b85'; ctx.textAlign = 'center'; ctx.fillText('z', 32, 50); }).tex;
const bubbleTex = canvasTex(256, 160, (ctx) => {
  ctx.fillStyle = '#fbbf24'; roundRect(ctx, 6, 6, 244, 110, 30); ctx.fill();
  ctx.beginPath(); ctx.moveTo(60, 110); ctx.lineTo(40, 155); ctx.lineTo(100, 112); ctx.fill();
  ctx.fillStyle = '#2a1a05'; ctx.font = '700 52px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('À toi !', 128, 80);
}).tex;
function capsule(r, l, m) { const c = new THREE.Mesh(new THREE.CapsuleGeometry(r, l, 6, 14), m); c.castShadow = true; return c; }

function makeAgent(project) {
  const g = new THREE.Group();
  const pc = projColor(project), pm = mat(pc, { roughness: 0.6 });
  const fisher = costumeFor(project) === 'pecheur'; // costume optionnel : casque jet, chemise bleue, chino blanc, canne à pêche
  const topM = fisher ? shirtM : bodyM, legM = fisher ? chinoM : bodyM;
  const torso = capsule(0.25, 0.4, topM); torso.position.y = 0.97; g.add(torso);
  if (fisher) {
    for (let i = 0; i < 4; i++) { const b = new THREE.Mesh(new THREE.SphereGeometry(0.012, 6, 4), mat(0xeef3f8)); b.position.set(0, 1.18 - i * 0.12, -0.247); g.add(b); }
    for (const s of [-1, 1]) { const c = box(0.1, 0.05, 0.03, shirtM, s * 0.07, 1.33, -0.19, g); c.rotation.set(0.3, 0, s * 0.5); }
    const neck = new THREE.Mesh(new THREE.CircleGeometry(0.055, 12), skinM); neck.position.set(0, 1.3, -0.236); g.add(neck);
  } else {
    const star = new THREE.Group(); star.position.set(0, 1.05, -0.245); g.add(star);
    for (let i = 0; i < 4; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.03, 0.01), skinM); b.rotation.z = (i * Math.PI) / 4; star.add(b); }
  }
  // jambes articulées (hanche -> genou)
  const legs = [-0.12, 0.12].map((sx) => {
    const hip = new THREE.Group(); hip.position.set(sx, 0.57, -0.02); g.add(hip);
    const thigh = capsule(0.09, 0.3, legM); thigh.position.y = -0.2; hip.add(thigh);
    const knee = new THREE.Group(); knee.position.y = -0.42; hip.add(knee);
    const shin = capsule(0.08, 0.38, legM); shin.position.y = -0.24; knee.add(shin);
    if (fisher) { const shoe = box(0.11, 0.06, 0.2, mat(0xd8d2c4), 0, -0.47, -0.04, knee, 0.02); shoe.castShadow = true; }
    return { hip, knee };
  });
  // tête
  const headPivot = new THREE.Group(); headPivot.position.y = 1.42; g.add(headPivot);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 24, 18), skinM); head.position.y = 0.2; head.castShadow = true; headPivot.add(head);
  const eyes = [-0.085, 0.085].map((sx) => {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), eyeM); e.scale.z = 0.5; e.position.set(sx, 0.23, -0.225); headPivot.add(e); return e;
  });
  const antennaM = mat(CLAUDE, { roughness: 0.55, emissive: 0x38e1ff, emissiveIntensity: 0 });
  if (fisher) {
    // casque jet adventure noir mat : calotte, casquette, écran solaire fumé ; visage ouvert
    const hs = new THREE.Group(); hs.position.y = 0.22; headPivot.add(hs);
    const top = new THREE.Mesh(new THREE.SphereGeometry(0.285, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.43), helmetM); top.castShadow = true; hs.add(top);
    const sides = new THREE.Mesh(new THREE.SphereGeometry(0.285, 28, 12, Math.PI * 1.83, Math.PI * 1.34, Math.PI * 0.43, Math.PI * 0.34), helmetM);
    sides.castShadow = true; hs.add(sides);
    const peak = box(0.3, 0.016, 0.16, helmetM, 0, 0.12, -0.29, hs, 0.006); peak.rotation.x = 0.18;
    box(0.2, 0.01, 0.05, trimM, 0, 0.19, -0.19, hs); // ventilation
    const visor = new THREE.Mesh(new THREE.SphereGeometry(0.272, 24, 8, Math.PI * 1.18, Math.PI * 0.64, Math.PI * 0.42, Math.PI * 0.15), visorM);
    hs.add(visor);
    const beard = new THREE.Mesh(new THREE.SphereGeometry(0.25, 20, 12, Math.PI * 1.12, Math.PI * 0.76, Math.PI * 0.61, Math.PI * 0.32), hairM);
    beard.material = hairM.clone(); beard.material.side = THREE.DoubleSide;
    beard.position.set(0, 0.2, 0); headPivot.add(beard);
    const stache = box(0.12, 0.025, 0.03, hairM, 0, 0.13, -0.225, headPivot, 0.01);
  } else {
    const antenna = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8), antennaM); antenna.position.y = 0.47; headPivot.add(antenna);
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.1), bodyM); stick.position.y = 0.42; headPivot.add(stick);
  }
  // accessoire aux couleurs du projet
  const kind = fisher ? -1 : hashHue(project + '#') % 3;
  if (kind === 0) { // casquette
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.25, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), pm); cap.position.y = 0.23; cap.scale.y = 0.75; headPivot.add(cap);
    box(0.3, 0.02, 0.2, pm, 0, 0.25, -0.27, headPivot);
  } else if (kind === 1) { // écharpe
    const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.065, 8, 24), pm); scarf.rotation.x = Math.PI / 2; scarf.position.y = 1.4; g.add(scarf);
    const tail = box(0.1, 0.3, 0.04, pm, 0.1, 1.24, -0.2, g); tail.rotation.z = 0.15;
  } else if (kind === 2) { // bandeau
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.242, 0.035, 8, 28), pm); band.rotation.x = Math.PI / 2; band.position.y = 0.3; headPivot.add(band);
  }
  // bras
  const arms = [-1, 1].map((s) => {
    const pivot = new THREE.Group(); pivot.position.set(0.3 * s, 1.25, 0); g.add(pivot);
    const a = capsule(0.065, 0.46, topM); a.position.y = -0.3; pivot.add(a);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), skinM); hand.position.y = -0.6; pivot.add(hand);
    return pivot;
  });
  // livre (lecture)
  const book = new THREE.Group(); book.position.set(0, 1.12, -0.52); book.rotation.x = -0.9; book.visible = false; g.add(book);
  const coverM = mat(pc, { roughness: 0.7 });
  for (const s of [-1, 1]) { const c = box(0.17, 0.24, 0.015, coverM, s * 0.085, 0, 0, book); c.rotation.y = s * 0.25; }
  const pagePivot = new THREE.Group(); book.add(pagePivot);
  const page = box(0.16, 0.22, 0.004, paperM, 0.08, 0, 0.012, pagePivot); page.castShadow = false;
  // loupe (recherche), tenue par la main droite
  const loupe = new THREE.Group(); loupe.position.set(0, -0.66, -0.02); loupe.visible = false; arms[1].add(loupe);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.014, 8, 24), metal); rim.position.y = -0.16; loupe.add(rim);
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.085, 20), new THREE.MeshStandardMaterial({ color: 0xbfe4ff, transparent: true, opacity: 0.45, side: THREE.DoubleSide }));
  lens.position.y = -0.16; loupe.add(lens);
  box(0.025, 0.12, 0.025, mat(0x6b3f23), 0, -0.02, 0, loupe);
  // canne à pêche (costume « pêcheur ») : poignée turquoise, moulinet, leurre bleu au bout du fil
  let rodTip = null, lure = null, line = null;
  if (fisher) {
    const rod = new THREE.Group(); rod.position.set(0, -0.62, -0.02); rod.rotation.x = -Math.PI / 2 + 0.2; arms[1].add(rod);
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.3, 10), mat(0x1fb1c1, { roughness: 0.5 })); grip.position.y = 0.02; rod.add(grip);
    const blank = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.012, 1.35, 8), mat(0x2a2d31, { roughness: 0.4 })); blank.position.y = 0.85; rod.add(blank);
    const reel = new THREE.Group(); reel.position.set(0, 0.12, 0.07); rod.add(reel);
    const spool = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.05, 16), mat(0x8c9198, { metalness: 0.8, roughness: 0.3 })); spool.rotation.z = Math.PI / 2; reel.add(spool);
    box(0.012, 0.012, 0.07, metal, 0, 0, -0.04, reel); box(0.07, 0.012, 0.012, mat(0x1b1b1b), 0.05, 0, 0.02, reel);
    rodTip = new THREE.Object3D(); rodTip.position.y = 1.53; rod.add(rodTip);
    lure = new THREE.Group(); g.add(lure);
    const body = capsule(0.018, 0.08, mat(0x2f8ee8, { metalness: 0.7, roughness: 0.25, emissive: 0x0b3a6b, emissiveIntensity: 0.3 })); lure.add(body);
    const hook = new THREE.Mesh(new THREE.TorusGeometry(0.018, 0.003, 6, 12, Math.PI * 1.4), metal); hook.position.y = -0.07; lure.add(hook);
    line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0xdfe6ea, transparent: true, opacity: 0.8 }));
    line.frustumCulled = false; g.add(line);
  }
  // tasse (machine à café)
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.04, 0.09, 12), mat(0xffffff)); cup.position.set(0, -0.66, -0.05); cup.visible = false; arms[1].add(cup);
  // bulles et zzz
  const zs = [0, 1, 2].map((i) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: zTex, transparent: true, depthWrite: false }));
    s.scale.setScalar(0.25); g.add(s); s.userData.phase = i / 3; return s;
  });
  const bubble = new THREE.Sprite(new THREE.SpriteMaterial({ map: bubbleTex, transparent: true, depthWrite: false }));
  bubble.scale.set(0.75, 0.46, 1); bubble.position.set(0.55, 1.95, 0); g.add(bubble);
  const thought = canvasTex(512, 230);
  const thoughtSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: thought.tex, transparent: true, depthWrite: false }));
  thoughtSprite.scale.set(1.1, 0.49, 1); thoughtSprite.position.set(0.8, 1.95, 0); thoughtSprite.visible = false; g.add(thoughtSprite);
  // zone de clic et étiquette
  const hit = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.9, 0.9), new THREE.MeshBasicMaterial({ visible: false }));
  hit.position.y = 0.95; g.add(hit);
  const lab = canvasTex(640, 150);
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: lab.tex, transparent: true, depthTest: false, depthWrite: false }));
  label.scale.set(1.9, (1.9 * 150) / 640, 1); label.position.y = 2.33; label.renderOrder = 10; g.add(label);
  return {
    group: g, torso, headPivot, eyes, arms, legs, antennaM, book, pagePivot, loupe, cup, zs, bubble, thought, thoughtSprite, thoughtKey: '',
    hit, label, lab, phase: Math.random() * 10, celebrateUntil: 0, rodTip, lure, line,
    place: 'desk', route: null, u: 0, dir: 1, spot: null, yaw: 0, sit: 1, walk: 0, walkPh: 0,
  };
}

// =====================================================================
// Dessins (étiquettes, écrans, bulles, tableau, stats)
// =====================================================================
function drawLabel(ag, d) {
  const { ctx, canvas, tex } = ag.lab; const W = canvas.width, Hh = canvas.height;
  ctx.clearRect(0, 0, W, Hh);
  ctx.fillStyle = 'rgba(22,19,17,.86)'; roundRect(ctx, 4, 4, W - 8, Hh - 8, 26); ctx.fill();
  ctx.fillStyle = STATUS[d.status].color; ctx.beginPath(); ctx.arc(40, 50, 12, 0, 7); ctx.fill();
  ctx.fillStyle = '#f4efe8'; ctx.font = '700 38px -apple-system, "Segoe UI", sans-serif';
  ctx.fillText(fitText(ctx, d.title, W - 90), 66, 63);
  ctx.font = '28px -apple-system, "Segoe UI", sans-serif';
  let sub;
  if (d.error && d.status === 'working') { ctx.fillStyle = '#f87171'; sub = `⚠ ${d.error.verb} en erreur`; }
  else {
    ctx.fillStyle = '#b8aea3';
    sub = d.status === 'working' ? (d.phase === 'thinking' ? 'réfléchit…' : `${d.current?.verb || ''} ${d.current?.detail || ''}`)
      : d.status === 'waiting' ? `attend ta réponse · ${ago(d.lastActivity)}` : `en pause · ${ago(d.lastActivity)}`;
  }
  ctx.fillText(fitText(ctx, `${d.project} — ${sub}`, W - 60), 30, 115);
  tex.needsUpdate = true;
}

const drawThought = (ag, d) => drawBubble(ag, d.lastText || '…');
function drawBubble(ag, text) {
  if (ag.thoughtKey === text) return; ag.thoughtKey = text;
  const { ctx, canvas, tex } = ag.thought; const W = canvas.width, Hh = canvas.height;
  ctx.clearRect(0, 0, W, Hh);
  ctx.fillStyle = 'rgba(255,255,255,.95)';
  roundRect(ctx, 10, 10, W - 20, 150, 60); ctx.fill();
  [[70, 180, 18], [40, 210, 10]].forEach(([x, y, r]) => { ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); });
  ctx.fillStyle = '#3a3330'; ctx.font = 'italic 30px -apple-system, "Segoe UI", sans-serif';
  wrap(ctx, text, W - 90, 3).forEach((l, i) => ctx.fillText(l, 45, 62 + i * 36));
  tex.needsUpdate = true;
}

function drawScreen(desk, blinkOn = true) {
  const { ctx, canvas, tex } = desk.scr; const W = canvas.width, Hh = canvas.height; const d = desk.data;
  if (!d) { ctx.fillStyle = '#0d0c0b'; ctx.fillRect(0, 0, W, Hh); desk.screen.material.emissiveIntensity = 0.05; tex.needsUpdate = true; return; }
  desk.screen.material.emissiveIntensity = d.status === 'idle' ? 0.25 : 0.95;
  ctx.fillStyle = d.status === 'idle' ? '#10131a' : '#1b1917'; ctx.fillRect(0, 0, W, Hh);
  if (d.status === 'idle') {
    ctx.fillStyle = '#d97757'; ctx.font = '700 64px sans-serif'; ctx.textAlign = 'center';
    const t = performance.now() / 1000; ctx.fillText('✻', W / 2 + Math.sin(t * 0.6) * 150, Hh / 2 + Math.cos(t * 0.8) * 70);
    ctx.textAlign = 'left'; tex.needsUpdate = true; return;
  }
  ctx.fillStyle = '#2a2623'; ctx.fillRect(0, 0, W, 34);
  ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(20 + i * 20, 17, 6, 0, 7); ctx.fill(); });
  ctx.fillStyle = '#b8aea3'; ctx.font = '18px ui-monospace, Menlo, monospace'; ctx.fillText(fitText(ctx, `claude — ${d.title}`, W - 100), 84, 23);
  ctx.font = '17px ui-monospace, Menlo, monospace';
  if (d.status === 'waiting') {
    ctx.fillStyle = '#fbbf24'; ctx.fillText('✻ Terminé — en attente de ta réponse', 14, 66);
    ctx.fillStyle = '#e8e2da';
    wrap(ctx, d.lastText || '…', W - 28, 9).forEach((l, i) => ctx.fillText(l, 14, 96 + i * 22));
  } else {
    const acts = d.actions.slice(-10);
    acts.forEach((a, i) => {
      const y = 62 + i * 22;
      ctx.fillStyle = '#d97757'; ctx.fillText('⏺', 12, y);
      ctx.fillStyle = '#f4efe8'; ctx.fillText(a.verb, 34, y);
      const vw = ctx.measureText(a.verb + ' ').width;
      ctx.fillStyle = '#9a9189'; ctx.fillText(fitText(ctx, a.detail || '', W - 50 - vw), 34 + vw, y);
    });
    const y = Math.min(62 + acts.length * 22, Hh - 12);
    if (d.error) { ctx.fillStyle = '#f87171'; ctx.fillText(fitText(ctx, `✗ ${d.error.text}`, W - 24), 12, y); }
    else { ctx.fillStyle = '#d97757'; ctx.fillText(blinkOn ? '✻ au travail…' : '✢ au travail…', 12, y); }
  }
  tex.needsUpdate = true;
}

function drawTerm(desk) {
  const { ctx, canvas, tex } = desk.term; const W = canvas.width, Hh = canvas.height; const d = desk.data;
  ctx.fillStyle = '#07100a'; ctx.fillRect(0, 0, W, Hh);
  desk.termScreen.material.emissiveIntensity = d && d.status !== 'idle' ? 0.8 : 0.1;
  if (!d || d.status === 'idle') { tex.needsUpdate = true; return; }
  ctx.font = '13px ui-monospace, Menlo, monospace';
  const cmds = d.actions.filter((a) => a.tool === 'Bash').slice(-7);
  cmds.forEach((a, i) => { ctx.fillStyle = '#4ade80'; ctx.fillText('$', 8, 20 + i * 19); ctx.fillStyle = '#b6f5c8'; ctx.fillText(fitText(ctx, a.detail || '', W - 30), 22, 20 + i * 19); });
  ctx.fillStyle = '#4ade80'; ctx.fillText('$ _', 8, 20 + cmds.length * 19);
  tex.needsUpdate = true;
}

function drawBoard(list) {
  const { ctx, canvas, tex } = board; const W = canvas.width, Hh = canvas.height;
  ctx.fillStyle = '#fbfbf8'; ctx.fillRect(0, 0, W, Hh);
  const hand = '"Marker Felt", "Comic Sans MS", "Chalkboard SE", cursive';
  ctx.font = `600 50px ${hand}`; ctx.fillStyle = '#2e5aa8'; ctx.fillText('Tâches des agents', 40, 70);
  const order = { working: 0, waiting: 1, idle: 2 };
  const withTodos = list.filter((a) => a.todos?.length && isVisible(a)).sort((a, b) => order[a.status] - order[b.status]);
  if (!withTodos.length) {
    ctx.font = `34px ${hand}`; ctx.fillStyle = '#555';
    ctx.fillText("Aucun agent n'a de liste de tâches pour l'instant.", 50, 170);
    ctx.fillText('Elles apparaîtront ici dès qu\'un agent planifie son travail.', 50, 220);
    ctx.strokeStyle = '#d33'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(1150, 430, 120, 0, Math.PI * 2); ctx.stroke();
    ctx.font = `44px ${hand}`; ctx.fillStyle = '#d33'; ctx.fillText('ship it!', 1080, 445);
    tex.needsUpdate = true; return;
  }
  const lines = [];
  for (const a of withTodos) {
    lines.push({ head: true, text: `${a.project} — ${a.title}`, color: STATUS[a.status].color });
    const open = a.todos.filter((t) => t.status !== 'completed'), done = a.todos.filter((t) => t.status === 'completed');
    const shown = [...open.slice(0, 5), ...done.slice(-Math.max(0, 5 - open.length))];
    for (const t of shown) lines.push(t);
    if (a.todos.length > shown.length) lines.push({ more: a.todos.length - shown.length });
  }
  const perCol = 14, colW = 650;
  lines.slice(0, perCol * 2).forEach((l, i) => {
    const x = 40 + Math.floor(i / perCol) * (colW + 20), y = 130 + (i % perCol) * 36;
    if (l.head) {
      ctx.fillStyle = l.color; ctx.beginPath(); ctx.arc(x + 10, y - 10, 9, 0, 7); ctx.fill();
      ctx.fillStyle = '#222'; ctx.font = `600 30px ${hand}`; ctx.fillText(fitText(ctx, l.text, colW - 40), x + 28, y);
    } else if (l.more) {
      ctx.fillStyle = '#888'; ctx.font = `26px ${hand}`; ctx.fillText(`… et ${l.more} de plus`, x + 30, y);
    } else {
      const sym = l.status === 'completed' ? '☑' : l.status === 'in_progress' ? '▶' : '☐';
      ctx.fillStyle = l.status === 'completed' ? '#9a9a9a' : l.status === 'in_progress' ? '#c2410c' : '#333';
      ctx.font = `${l.status === 'in_progress' ? '600 ' : ''}28px ${hand}`;
      const text = fitText(ctx, `${sym} ${l.status === 'in_progress' && l.active ? l.active : l.text}`, colW - 40);
      ctx.fillText(text, x + 28, y);
      if (l.status === 'completed') { const w = ctx.measureText(text).width; ctx.fillRect(x + 60, y - 9, w - 32, 2); }
    }
  });
  tex.needsUpdate = true;
}

let lastStats = null;
function drawStats(list, stats) {
  const { ctx, canvas, tex } = statsTex; const W = canvas.width, Hh = canvas.height;
  const g = ctx.createLinearGradient(0, 0, W, Hh); g.addColorStop(0, '#1d1a18'); g.addColorStop(1, '#2a211c');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, Hh);
  const sans = '-apple-system, "Segoe UI", sans-serif';
  ctx.fillStyle = '#d97757'; ctx.font = `700 60px ${sans}`; ctx.fillText("✻ Aujourd'hui", 50, 88);
  ctx.fillStyle = '#9a9189'; ctx.font = `28px ${sans}`;
  ctx.fillText(new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }), 54, 132);
  const counts = { working: 0, waiting: 0, idle: 0 }; list.forEach((a) => counts[a.status]++);
  Object.entries(counts).forEach(([k, n], i) => {
    const x = 1040 + i * 250;
    ctx.fillStyle = STATUS[k].color; ctx.font = `700 76px ${sans}`; ctx.fillText(n, x, 100);
    ctx.fillStyle = '#d9d2c9'; ctx.font = `26px ${sans}`; ctx.fillText(STATUS[k].label, x + 2, 136);
  });
  ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fillRect(50, 165, W - 100, 2);
  const section = (t, x, y) => { ctx.fillStyle = '#9a9189'; ctx.font = `600 24px ${sans}`; ctx.fillText(t, x, y); };
  if (!stats || !stats.ready) {
    ctx.fillStyle = '#9a9189'; ctx.font = `34px ${sans}`; ctx.fillText('Lecture de l\'historique du jour…', 50, 260);
    tex.needsUpdate = true; return;
  }
  // tokens
  section('TOKENS', 50, 225);
  ctx.fillStyle = '#f4efe8'; ctx.font = `700 92px ${sans}`; ctx.fillText(fmt(stats.tokens.output), 50, 330);
  ctx.fillStyle = '#d9d2c9'; ctx.font = `28px ${sans}`; ctx.fillText('générés par les agents', 54, 370);
  ctx.fillStyle = '#9a9189'; ctx.font = `26px ${sans}`;
  [`entrée : ${fmt(stats.tokens.input + stats.tokens.cacheWrite)}`, `lus en cache : ${fmt(stats.tokens.cacheRead)}`,
    `${stats.messages} réponses · ${stats.sessions} sessions`,
    `${dur(stats.activeMs)} de travail · ≈ ${eur(stats.cost)} au tarif API`].forEach((t, i) => ctx.fillText(t, 54, 412 + i * 36));
  // historique : tokens générés par jour sur les 14 derniers jours
  const hist = stats.history || [];
  if (hist.length) {
    section(`${hist.length} DERNIERS JOURS (tokens générés)`, 50, 570);
    const hm = Math.max(1, ...hist.map((d) => d.output)), hw = 24, hg = 8, hy = 720, hh = 105;
    hist.forEach((d, i) => {
      const v = Math.max(3, (d.output / hm) * hh), x = 50 + i * (hw + hg), last = i === hist.length - 1;
      ctx.fillStyle = last ? '#d97757' : d.output ? '#8a7466' : '#3a322d';
      roundRect(ctx, x, hy - v, hw, v, 4); ctx.fill();
      ctx.fillStyle = last ? '#f4efe8' : '#9a9189'; ctx.font = `18px ${sans}`; ctx.textAlign = 'center';
      ctx.fillText(String(+d.date.slice(8)), x + hw / 2, hy + 24); ctx.textAlign = 'left';
    });
    const yest = hist.at(-2);
    if (yest) { ctx.fillStyle = '#9a9189'; ctx.font = `22px ${sans}`; ctx.fillText(`hier : ${fmt(yest.output)} · ${yest.calls} actions`, 50 + hist.length * (hw + hg) + 14, hy - 8); }
  }
  // activité par heure
  section('ACTIVITÉ PAR HEURE (appels d\'outils)', 560, 225);
  const max = Math.max(1, ...stats.hours), now = new Date().getHours();
  const bx = 560, by = 640, bw = 22, gap = 5, bh = 360;
  stats.hours.forEach((n, h) => {
    const hgt = (n / max) * bh;
    ctx.fillStyle = h === now ? '#d97757' : n ? '#8a7466' : '#3a322d';
    roundRect(ctx, bx + h * (bw + gap), by - Math.max(3, hgt), bw, Math.max(3, hgt), 4); ctx.fill();
  });
  ctx.fillStyle = '#9a9189'; ctx.font = `22px ${sans}`;
  [0, 6, 12, 18].forEach((h) => ctx.fillText(`${h}h`, bx + h * (bw + gap), by + 34));
  ctx.fillText(`pic : ${max}`, bx + 24 * (bw + gap) - 110, by + 34);
  // outils et fichiers
  const bars = (items, x, y, color) => {
    const m = Math.max(1, ...items.map((i) => i[1]));
    items.forEach(([name, n], i) => {
      const yy = y + i * 40;
      ctx.fillStyle = 'rgba(255,255,255,.06)'; roundRect(ctx, x, yy - 24, 470, 32, 6); ctx.fill();
      ctx.fillStyle = color; roundRect(ctx, x, yy - 24, Math.max(6, (n / m) * 470), 32, 6); ctx.fill();
      ctx.fillStyle = '#f4efe8'; ctx.font = `22px ${sans}`; ctx.fillText(fitText(ctx, name, 380), x + 12, yy);
      ctx.textAlign = 'right'; ctx.fillText(n, x + 462, yy); ctx.textAlign = 'left';
    });
  };
  section('OUTILS LES PLUS UTILISÉS', 1270, 225);
  bars(stats.tools.slice(0, 6), 1270, 275, 'rgba(217,119,87,.55)');
  section('FICHIERS LES PLUS MODIFIÉS', 1270, 545);
  bars(stats.files.slice(0, 5), 1270, 595, 'rgba(96,165,250,.45)');
  tex.needsUpdate = true;
}

// =====================================================================
// Jour / nuit et météo en direct (lieu réglé dans config.json, via le serveur)
// =====================================================================
let timeLapse = false, lapseBase = 0, lapseStart = 0;
const fixedHour = params.has('heure') ? parseFloat(params.get('heure')) : null;
let weather = null; // { place, temp, code, cloud, precip, wind, sunrise, sunset }
const METEO_TEST = { clair: { code: 0, cloud: 5 }, nuageux: { code: 3, cloud: 95 }, pluie: { code: 63, cloud: 100, precip: 2 }, orage: { code: 95, cloud: 100, precip: 5 }, neige: { code: 73, cloud: 100, precip: 1 }, brouillard: { code: 45, cloud: 100 } };
function currentHour() {
  if (timeLapse) return (lapseBase + ((performance.now() - lapseStart) / 1000) * (24 / 60)) % 24;
  if (fixedHour != null && !Number.isNaN(fixedHour)) return fixedHour;
  const d = new Date(); return d.getHours() + d.getMinutes() / 60;
}
const hourOf = (iso, dflt) => { const m = /T(\d\d):(\d\d)/.exec(iso || ''); return m ? +m[1] + m[2] / 60 : dflt; };
function sky3(w) {
  const code = w?.code ?? 0;
  return {
    overcast: clamp((w?.cloud ?? 10) / 100, 0, 1),
    rain: (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95,
    snow: (code >= 71 && code <= 77) || code === 85 || code === 86,
    storm: code >= 95,
    fog: code === 45 || code === 48,
  };
}
function weatherIcon(w, day) {
  const c = w?.code ?? -1;
  if (c >= 95) return '⛈️'; if (c >= 71 && c <= 77) return '❄️'; if (c >= 80) return '🌦️'; if (c >= 51) return '🌧️';
  if (c === 45 || c === 48) return '🌫️'; if (c === 3) return '☁️'; if (c === 1 || c === 2) return day ? '🌤️' : '☁️';
  return day ? '☀️' : '🌙';
}

const cDayTop = new THREE.Color('#2f6fc4'), cDayMid = new THREE.Color('#8fbbe6'), cDayBot = new THREE.Color('#e4eef4');
const cNightTop = new THREE.Color('#040816'), cNightMid = new THREE.Color('#0e1530'), cNightBot = new THREE.Color('#1f2140');
const cDusk = new THREE.Color('#f08a50'), cDuskHi = new THREE.Color('#f3c08c');
const cGrayTop = new THREE.Color('#7d8792'), cGrayMid = new THREE.Color('#a4acb4'), cGrayBot = new THREE.Color('#c3c8cc');
const bigClouds = (() => { const r = rng(91); return Array.from({ length: 46 }, () => ({ x: r() * 1024, y: 120 + r() * 140, rx: 40 + r() * 90, ry: 12 + r() * 22, t: r() })); })();
let skyKey = '';
function drawSky(day, dusk, oc) {
  const key = day.toFixed(2) + dusk.toFixed(2) + oc.toFixed(2);
  if (key === skyKey) return; skyKey = key;
  const { ctx, canvas, tex } = sky; const W = canvas.width, Hh = canvas.height, hz = Hh / 2;
  const g = oc * 0.85;
  const top = cNightTop.clone().lerp(cDayTop, day).lerp(cGrayTop.clone().multiplyScalar(0.15 + 0.85 * day), g);
  const mid = cNightMid.clone().lerp(cDayMid, day).lerp(cDuskHi, dusk * 0.5 * (1 - oc)).lerp(cGrayMid.clone().multiplyScalar(0.15 + 0.85 * day), g);
  const bot = cNightBot.clone().lerp(cDayBot, day).lerp(cDusk, dusk * 0.75 * (1 - oc)).lerp(cGrayBot.clone().multiplyScalar(0.18 + 0.82 * day), g);
  const grd = ctx.createLinearGradient(0, 0, 0, hz);
  grd.addColorStop(0, top.getStyle()); grd.addColorStop(0.55, mid.getStyle()); grd.addColorStop(1, bot.getStyle());
  ctx.fillStyle = grd; ctx.fillRect(0, 0, W, hz);
  ctx.fillStyle = bot.getStyle(); ctx.fillRect(0, hz, W, Hh - hz);
  if (day < 0.35 && oc < 0.8) {
    ctx.fillStyle = `rgba(255,255,255,${(1 - day / 0.35) * 0.9 * (1 - oc)})`;
    for (let i = 0; i < 260; i++) { const x = (i * 97.3) % W, y = (i * 53.7) % (hz * 0.85); ctx.fillRect(x, y, i % 9 === 0 ? 2 : 1, i % 9 === 0 ? 2 : 1); }
  }
  const cloud = new THREE.Color('#ffffff').lerp(new THREE.Color('#f6b98a'), dusk * 0.8 * (1 - oc)).lerp(new THREE.Color('#39405c'), 1 - Math.max(day, dusk * 0.6)).lerp(new THREE.Color('#8a9097'), oc * 0.5 * day);
  const rgba = (a) => `rgba(${cloud.r * 255 | 0},${cloud.g * 255 | 0},${cloud.b * 255 | 0},${a})`;
  ctx.lineCap = 'round';
  for (const c of cirrus) {
    if (c.puff) { ctx.fillStyle = rgba(c.a); ctx.beginPath(); ctx.ellipse(c.x, c.y, c.rx, c.ry, 0, 0, 7); ctx.fill(); continue; }
    ctx.strokeStyle = rgba(c.a * (1 - oc * 0.6)); ctx.lineWidth = c.w;
    ctx.beginPath(); ctx.moveTo(c.x, c.y);
    ctx.quadraticCurveTo(c.x + Math.cos(c.ang) * c.len / 2, c.y + Math.sin(c.ang) * c.len / 2 + c.bend, c.x + Math.cos(c.ang) * c.len, c.y + Math.sin(c.ang) * c.len);
    ctx.stroke();
  }
  // gros nuages selon la couverture nuageuse
  ctx.filter = 'blur(6px)';
  for (const b of bigClouds) {
    if (b.t > oc) continue;
    ctx.fillStyle = rgba(0.35 + oc * 0.4);
    ctx.beginPath(); ctx.ellipse(b.x, b.y, b.rx, b.ry, 0, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(b.x + b.rx * 0.4, b.y - b.ry * 0.5, b.rx * 0.6, b.ry, 0, 0, 7); ctx.fill();
  }
  ctx.filter = 'none';
  tex.needsUpdate = true;
  scene.background.copy(bot);
}

// Pluie / neige dehors, devant les fenêtres
const PRECIP_N = 900;
const precip = new THREE.InstancedMesh(new THREE.BoxGeometry(0.012, 0.45, 0.012), new THREE.MeshBasicMaterial({ color: 0xc7d3de, transparent: true, opacity: 0.55 }), PRECIP_N);
precip.frustumCulled = false; precip.visible = false; scene.add(precip);
const drops = Array.from({ length: PRECIP_N }, () => ({ x: Math.random(), z: Math.random(), y: Math.random() }));
let flashUntil = 0;
function updatePrecip(dt, t) {
  const s3 = sky3(weather);
  precip.visible = s3.rain || s3.snow;
  if (!precip.visible) return;
  const snow = s3.snow, speed = snow ? 1.2 : 11, x0 = shellX0 - 12, xw = ROOM_S + 26, top = 10, bottom = GROUND;
  precip.material.color.set(snow ? 0xffffff : 0xc7d3de);
  const sc = snow ? new THREE.Vector3(3, 0.09, 3) : new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < PRECIP_N; i++) {
    const d = drops[i];
    d.y -= (speed * dt) / (top - bottom);
    if (d.y < 0) { d.y += 1; d.x = Math.random(); d.z = Math.random(); }
    const sway = snow ? Math.sin(t * 1.3 + i) * 0.4 : 0;
    m4.compose(v1.set(x0 + d.x * xw + sway, bottom + d.y * (top - bottom), ZN - 0.6 - d.z * 32), q1.identity(), sc);
    precip.setMatrixAt(i, m4);
  }
  precip.instanceMatrix.needsUpdate = true;
  if (s3.storm && t > flashUntil + 4 && Math.random() < dt * 0.25) flashUntil = t + 0.15;
}

let lastTimeApply = -1;
function applyTime(h) {
  const rise = hourOf(weather?.sunrise, 7.5), set = hourOf(weather?.sunset, 19.75);
  const s3 = sky3(weather), oc = s3.overcast;
  const k = (h - rise) / (set - rise);
  const el = Math.sin(Math.PI * k); // hauteur du soleil (négative la nuit)
  const day = THREE.MathUtils.smoothstep(el, -0.08, 0.3);
  const dusk = clamp(1 - Math.abs(el) / 0.3, 0, 1);
  const { cx, cz } = shadowBox;
  const dim = 1 - 0.75 * oc ** 1.5; // les nuages cachent le soleil
  if (el > -0.05) {
    // le soleil va de l'est au sud puis à l'ouest ; on le place par rapport au côté où donnent les fenêtres (−z)
    const th = { est: 0, sud: Math.PI / 2, ouest: Math.PI, nord: -Math.PI / 2 }[CONFIG.fenetres] ?? Math.PI / 2;
    const e = Math.cos(Math.PI * k), so = Math.sin(Math.PI * k);
    const front = e * Math.cos(th) + so * Math.sin(th), side = -e * Math.sin(th) + so * Math.cos(th);
    sun.position.set(cx + side * 35, 4 + Math.max(0, el) * 30, cz - front * 40);
    sun.color.set(0xffa25e).lerp(new THREE.Color(0xfff0dd), clamp(el / 0.5, 0, 1));
    sun.intensity = (0.25 + 2.4 * day) * dim;
  } else { // lune
    sun.position.set(cx - 20, 30, -25); sun.color.set(0x9fb4ff); sun.intensity = 0.25 * (1 - oc * 0.8);
  }
  sun.target.position.set(cx, 0, cz);
  hemi.intensity = hemi.userData.base = (0.8 + 0.4 * day) * (1 - oc * 0.15);
  hemi.color.set(0xffe4c4).lerp(new THREE.Color(0xf4f7ff), day).lerp(new THREE.Color(0xdfe4ea), oc * day * 0.6);
  panelM.emissiveIntensity = lightsOn ? 0.9 + (1 - day * dim) * 1.3 : 0.02;
  ceilTileM.emissiveIntensity = lightsOn ? 0.1 + (1 - day) * 0.15 : 0;
  if (!lightsOn) hemi.intensity = hemi.userData.base = hemi.userData.base * (0.25 + 0.55 * day * dim);
  const f = (0.1 + 0.9 * Math.max(day, dusk * 0.35)) * (1 - oc * 0.25);
  const warm = new THREE.Color(1, 0.86, 0.75);
  for (const { m, base, baseE } of extMats) {
    m.color.copy(base).multiplyScalar(f);
    if (dusk > 0.2 && day > 0.05 && oc < 0.7) m.color.lerp(base.clone().multiply(warm).multiplyScalar(f), dusk * 0.4);
    if (baseE) m.emissive.copy(baseE).multiplyScalar(f);
  }
  for (const m of cityWinMats) m.emissiveIntensity = (1 - day) * 0.9;
  lampGlowM.emissiveIntensity = (1 - day) * 2.5;
  scene.fog = s3.fog ? new THREE.Fog(scene.background, 20, 90) : null;
  drawSky(day, dusk, oc);
  const hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
  const w = weather && typeof weather.temp === 'number' ? ` · ${Math.round(weather.temp)}° ${weather.place || ''}` : '';
  $('clock').textContent = `${weatherIcon(weather, day > 0.3)} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}${timeLapse ? ' ⏩' : ''}${w}`;
  $('clock').title = weather ? `Météo en direct : ${weather.place}, ${weather.temp}°C, nuages ${weather.cloud} %, vent ${weather.wind} km/h · lever ${String(weather.sunrise || '').slice(11)} · coucher ${String(weather.sunset || '').slice(11)}` : 'Météo indisponible';
}

// =====================================================================
// Données
// =====================================================================
let agentsData = [];
let demo = params.has('demo');
let firstLoad = true;
const seenActions = new Set();

async function poll() {
  let data;
  if (!demo) {
    try {
      const r = await fetch('/api/agents', { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      data = await r.json();
      $('source').textContent = '● en direct';
    } catch { demo = true; }
  }
  if (demo) { data = demoData(); $('source').textContent = 'mode démo (lance node server.js)'; }
  const test = METEO_TEST[params.get('meteo')];
  const nextWeather = test ? { ...(data.weather || {}), place: data.weather?.place || '', temp: data.weather?.temp ?? 16, ...test } : data.weather || null;
  if (JSON.stringify(nextWeather) !== JSON.stringify(weather)) { weather = nextWeather; lastTimeApply = -1; }
  isRemote = !!data.remote;
  if (data.config && JSON.stringify(data.config) !== JSON.stringify(CONFIG)) { CONFIG = { ...CONFIG, ...data.config }; lastTimeApply = -1; forceRelayout = true; } // décor à reconstruire
  update(data.agents, data.stats);
}
let isRemote = false;

function countByProject(list) {
  const need = new Map();
  for (const a of list) need.set(a.project, (need.get(a.project) || 0) + 1);
  return need;
}
function layoutStale(need) {
  if (!shell || forceRelayout) return true;
  const names = new Set(rooms.map((r) => r.name));
  if (names.size !== need.size) return true;
  for (const [name, n] of need) if (rooms.filter((x) => x.name === name).reduce((k, r) => k + r.desks.length, 0) < n) return true;
  return false;
}
let forceRelayout = false;
function relayout(need) {
  forceRelayout = false;
  for (const d of desks) if (d.agent) removeAgent(d);
  assign.clear();
  for (const r of rooms) { scene.remove(r.group); disposeTree(r.group); }
  rooms = []; desks = [];
  dynObs.length = 0; obsTarget = dynObs;
  const layout = computeLayout(need);
  layoutUsesSouth = layout.rooms.some((r) => r.side === 'S');
  buildShell(layout.S);
  rooms = layout.rooms.map(buildRoom);
  desks = rooms.flatMap((r) => r.desks);
  obsTarget = staticObs;
  applyTime(currentHour());
  applyCutaway();
  if (collides(walkPose.pos.x, walkPose.pos.z)) { backToOffice(); walkPose.pos.set(shellX0 + ROOM_S * 0.35, 1.65, ZN + ROOM_S * 0.75); if (mode === 'walk' && !tween) camera.position.copy(walkPose.pos); }
}

function update(list, stats) {
  const prevById = new Map(agentsData.map((a) => [a.id, a]));
  agentsData = list;
  if (stats) lastStats = stats;
  const need = countByProject(list);
  if (layoutStale(need)) relayout(need);
  const ids = new Set(list.map((a) => a.id));
  for (const [id, desk] of assign) if (!ids.has(id)) { removeAgent(desk); assign.delete(id); }
  for (const a of list) {
    let desk = assign.get(a.id);
    if (!desk) {
      desk = rooms.filter((r) => r.name === a.project).flatMap((r) => r.desks).find((d) => !d.data);
      if (!desk) continue;
      assign.set(a.id, desk);
      desk.agent = makeAgent(a.project); desk.chair.add(desk.agent.group); desk.agent.group.position.z = -0.05;
      desk.data = a;
      if (a.status === 'idle') leaveDesk(desk, true); // déjà en pause : directement au canapé
      desk.data = null;
    }
    const prev = desk.data; desk.data = a;
    if (!prev || JSON.stringify(prev) !== JSON.stringify(a)) { drawLabel(desk.agent, a); drawScreen(desk); drawTerm(desk); }
    desk.ring.material.color.set(STATUS[a.status].color);
    setClutter(desk, a.workload || 0);
    if (a.status === 'working' && a.phase === 'thinking') drawThought(desk.agent, a);
    // événements : fin de tâche, attente, tâches cochées
    const before = prevById.get(a.id);
    if (before && !firstLoad) {
      if (before.status !== 'waiting' && a.status === 'waiting') {
        if (isVisible(a)) ding();
        if (before.status === 'working') celebrate(desk, 90);
      }
      const done = (x) => (x.todos || []).filter((t) => t.status === 'completed').length;
      if (done(a) > done(before)) celebrate(desk, 40);
    }
    for (const act of a.actions) {
      const key = a.id + act.ts + act.verb + act.detail;
      if (!seenActions.has(key)) { seenActions.add(key); if (!firstLoad) pushFeed(a, `${act.verb} ${act.detail || ''}`); }
    }
    if (a.error && before && !before.error && !firstLoad) pushFeed(a, `⚠ ${a.error.verb} : ${a.error.text}`, true);
  }
  rooms.forEach((r) => drawRoomStats(r, lastStats?.projects?.[r.name]));
  drawStats(list, lastStats);
  drawBoard(list);
  renderStats(list);
  renderFilterOptions(list);
  renderRoster(list);
  if (openId) renderPanel(openId);
  firstLoad = false;
}

function removeAgent(desk) {
  const ag = desk.agent;
  ag.group.parent?.remove(ag.group); if (ag.spot) ag.spot.taken = null;
  for (const r of desk.robots) scene.remove(r.group);
  desk.robots = [];
  desk.agent = null; desk.data = null;
  desk.ring.material.opacity = 0; desk.storm.visible = false; desk.clutter.clear(); desk.clutterKey = '';
  drawScreen(desk); drawTerm(desk);
}
const agentById = (id) => assign.get(id)?.agent;

// =====================================================================
// Déplacements bureau <-> coin détente
// =====================================================================
function makeRoute(desk, spot) {
  const s0 = desk.seat, f = desk.back, sd = { x: Math.cos(desk.rot), z: -Math.sin(desk.rot) };
  const p1 = [s0.x + sd.x * 0.85, s0.z + sd.z * 0.85], p2 = [p1[0] + f.x * 0.8, p1[1] + f.z * 0.8];
  const pts = [[s0.x, s0.z], p1, p2, [HUB.x, HUB.z], ...spot.via, [spot.x, spot.z]]
    .map(([px, pz]) => ({ x: px, z: pz }));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  return { pts, cum, len: cum.at(-1) };
}
function routeAt(r, u, out) {
  let i = 1; while (i < r.pts.length - 1 && r.cum[i] < u) i++;
  const a = r.pts[i - 1], b = r.pts[i], seg = r.cum[i] - r.cum[i - 1] || 1, k = clamp((u - r.cum[i - 1]) / seg, 0, 1);
  out.x = a.x + (b.x - a.x) * k; out.z = a.z + (b.z - a.z) * k; out.dx = (b.x - a.x) / seg; out.dz = (b.z - a.z) / seg;
  return out;
}
function leaveDesk(desk, instant = false) {
  const ag = desk.agent, spot = LOUNGE.find((s) => !s.taken);
  if (!spot) return; // tout est pris : il dort à son bureau
  spot.taken = desk; ag.spot = spot; ag.route = makeRoute(desk, spot);
  scene.attach(ag.group); ag.place = 'route'; ag.dir = 1; ag.yaw = desk.rot + desk.chair.rotation.y;
  if (instant) { ag.u = ag.route.len; ag.yaw = spot.yaw; ag.sit = spot.pose === 'sit' ? 1 : 0; } else ag.u = 0;
  placeOnRoute(ag);
}
function backToChair(desk) {
  const ag = desk.agent;
  ag.spot.taken = null; ag.spot = null; ag.route = null; ag.place = 'desk'; ag.stayUntil = 0;
  desk.chair.add(ag.group); ag.group.position.set(0, 0, -0.05); ag.group.rotation.set(0, 0, 0);
}
const rp = {};
function placeOnRoute(ag) {
  routeAt(ag.route, ag.u, rp);
  const atSpot = ag.dir > 0 && ag.u >= ag.route.len;
  ag.group.position.set(rp.x, (1 - ag.sit) * 0.36 + ag.sit * (atSpot ? ag.spot.dy : 0), rp.z);
  ag.group.rotation.y = ag.yaw;
}
// d'une place du salon à une autre (imprimante, café, canapé…), en repassant par le carrefour
function startTransit(desk, next) {
  const ag = desk.agent, cur = ag.spot;
  const pts = [[cur.x, cur.z], ...[...cur.via].reverse(), [HUB.x, HUB.z], ...next.via, [next.x, next.z]].map(([x, z]) => ({ x, z }));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  next.taken = desk;
  ag.transit = { route: { pts, cum, len: cum.at(-1) }, u: 0, next, dy: cur.dy };
}
function updateMotion(desk, dt) {
  const ag = desk.agent, idle = desk.data.status === 'idle';
  if (ag.place === 'desk') {
    if (idle && Math.abs(desk.chair.rotation.y) < 0.15) leaveDesk(desk);
    if (ag.place === 'desk') return;
  }
  if (ag.transit) {
    const tr = ag.transit; let walking = 0;
    if (ag.sit > 0.02) ag.sit = Math.max(0, ag.sit - dt * 2.5);
    else { tr.u = Math.min(tr.route.len, tr.u + (idle ? 1.2 : 2.4) * dt); walking = 1; }
    routeAt(tr.route, tr.u, rp);
    if (walking) ag.yaw += angDiff(ag.yaw, Math.atan2(-rp.dx, -rp.dz)) * damp(7, dt);
    ag.walk += (walking - ag.walk) * damp(8, dt); ag.walkPh += dt * 8.5 * ag.walk;
    ag.group.position.set(rp.x, (1 - ag.sit) * 0.36 + ag.sit * tr.dy, rp.z); ag.group.rotation.y = ag.yaw;
    if (tr.u >= tr.route.len) { ag.spot.taken = null; ag.spot = tr.next; ag.route = makeRoute(desk, tr.next); ag.u = ag.route.len; ag.dir = 1; ag.transit = null; ag.stayUntil = 0; }
    return;
  }
  ag.dir = idle ? 1 : -1;
  const end = ag.dir > 0 ? ag.route.len : 0;
  let targetYaw = ag.yaw, targetWalk = 0;
  if (ag.u !== end) {
    if (ag.sit > 0.02) ag.sit = Math.max(0, ag.sit - dt * 2.5); // se lève d'abord
    else {
      ag.u = ag.dir > 0 ? Math.min(end, ag.u + 1.35 * dt) : Math.max(0, ag.u - 1.35 * dt);
      routeAt(ag.route, ag.u, rp);
      targetYaw = Math.atan2(-rp.dx * ag.dir, -rp.dz * ag.dir); targetWalk = 1;
    }
  } else {
    targetYaw = ag.dir > 0 ? ag.spot.yaw : desk.rot;
    if (Math.abs(angDiff(ag.yaw, targetYaw)) < 0.2) {
      const want = ag.dir < 0 || ag.spot.pose === 'sit' ? 1 : 0;
      ag.sit += Math.sign(want - ag.sit) * Math.min(Math.abs(want - ag.sit), dt * 2.2);
    }
    if (ag.dir > 0) { // au salon : de temps en temps il change de place
      const t = clock.elapsedTime;
      if (!ag.stayUntil) {
        ag.stayUntil = t + 40 + Math.random() * 110;
        const d = camera.position.distanceTo(ag.group.position);
        if (ag.spot.pose === 'coffee' && t > 6 && d < 10) sfx('brew', clamp(0.7 - d / 14, 0.08, 0.5)); // il se fait un café
        if (ag.spot.pose === 'print' && t > 6 && d < 10) sfx('print', clamp(0.7 - d / 14, 0.08, 0.5));
      } else if (t > ag.stayUntil) {
        const free = LOUNGE.filter((sp) => !sp.taken && sp !== ag.spot);
        if (free.length) startTransit(desk, free[Math.floor(Math.random() * free.length)]);
        ag.stayUntil = 0;
      }
    }
  }
  ag.yaw += angDiff(ag.yaw, targetYaw) * damp(7, dt);
  ag.walk += (targetWalk - ag.walk) * damp(8, dt);
  ag.walkPh += dt * 8.5 * ag.walk;
  placeOnRoute(ag);
  if (ag.dir < 0 && ag.u === 0 && ag.sit > 0.98 && Math.abs(angDiff(ag.yaw, desk.rot)) < 0.05) backToChair(desk);
}

// =====================================================================
// Sous-agents : petits robots qui font l'aller-retour à la bibliothèque
// =====================================================================
function makeRobot() {
  const g = new THREE.Group();
  box(0.2, 0.24, 0.16, bodyM, 0, 0.26, 0, g, 0.04);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 14, 10), skinM); head.position.y = 0.5; head.castShadow = true; g.add(head);
  for (const sx of [-0.035, 0.035]) { const e = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), eyeM); e.position.set(sx, 0.52, -0.09); g.add(e); }
  const ant = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), new THREE.MeshStandardMaterial({ color: CLAUDE, emissive: CLAUDE, emissiveIntensity: 1 })); ant.position.y = 0.64; g.add(ant);
  for (const sx of [-0.06, 0.06]) box(0.05, 0.14, 0.05, bodyM, sx, 0.07, 0, g);
  const book = box(0.14, 0.04, 0.1, mat(new THREE.Color().setHSL(Math.random(), 0.5, 0.5)), 0, 0.62, 0, g); book.visible = false;
  return { group: g, book };
}
function syncRobots(desk, n, visible) {
  n = Math.min(n, 5);
  while (desk.robots.length < n) {
    const r = makeRobot();
    const rs = LOUNGE.find((s) => s.pose === 'read');
    r.route = makeRoute(desk, { x: rs.x + Math.random() * 0.2, z: rs.z + (Math.random() - 0.5) * 0.6, via: rs.via });
    r.u = Math.random() * 1.5; r.dir = 1; r.wait = 0;
    scene.add(r.group); desk.robots.push(r);
  }
  while (desk.robots.length > n) scene.remove(desk.robots.pop().group);
  for (const r of desk.robots) r.group.visible = visible;
}
function updateRobots(desk, dt, t) {
  for (const r of desk.robots) {
    if (r.wait > 0) { r.wait -= dt; }
    else {
      r.u += r.dir * 2.4 * dt;
      if (r.u >= r.route.len) { r.u = r.route.len; r.dir = -1; r.wait = 1.2; r.book.visible = true; }
      else if (r.u <= 0.3) { r.u = 0.3; r.dir = 1; r.wait = 0.8; r.book.visible = false; }
    }
    routeAt(r.route, r.u, rp);
    r.group.position.set(rp.x, Math.abs(Math.sin(t * 12 + r.u)) * 0.04, rp.z);
    r.group.rotation.y = Math.atan2(-rp.dx * r.dir, -rp.dz * r.dir);
  }
}

// =====================================================================
// Effets : confettis
// =====================================================================
const CONF_N = 400;
const confetti = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.06, 0.035), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), CONF_N);
confetti.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
confetti.frustumCulled = false;
const confParts = Array.from({ length: CONF_N }, () => ({ life: 0, p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Euler(), w: new THREE.Vector3() }));
const confColors = ['#d97757', '#fbbf24', '#4ade80', '#60a5fa', '#f472b6', '#ffffff'].map((c) => new THREE.Color(c));
const m4 = new THREE.Matrix4(), zeroM = new THREE.Matrix4().makeScale(0, 0, 0);
for (let i = 0; i < CONF_N; i++) { confetti.setMatrixAt(i, zeroM); confetti.setColorAt(i, confColors[i % confColors.length]); }
scene.add(confetti);
let confNext = 0;
function celebrate(desk, n) {
  const ag = desk.agent; if (!ag) return;
  ag.celebrateUntil = clock.elapsedTime + 3;
  ag.group.getWorldPosition(v1); v1.y += 2.1;
  for (let k = 0; k < n; k++) {
    const c = confParts[confNext]; confNext = (confNext + 1) % CONF_N;
    c.life = 2.5 + Math.random(); c.p.copy(v1);
    c.v.set((Math.random() - 0.5) * 3, 2.5 + Math.random() * 2.5, (Math.random() - 0.5) * 3);
    c.r.set(Math.random() * 6, Math.random() * 6, 0); c.w.set((Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12, 0);
  }
}
function updateConfetti(dt) {
  for (let i = 0; i < CONF_N; i++) {
    const c = confParts[i];
    if (c.life <= 0) continue;
    c.life -= dt;
    c.v.y -= 5 * dt; c.v.multiplyScalar(1 - dt * 0.8);
    c.p.addScaledVector(c.v, dt);
    if (c.p.y > CEIL - 0.05) { c.p.y = CEIL - 0.05; c.v.y = -Math.abs(c.v.y) * 0.3; }
    if (c.p.y < 0.02) { c.p.y = 0.02; c.v.set(0, 0, 0); c.w.set(0, 0, 0); c.r.x = -Math.PI / 2; }
    c.r.x += c.w.x * dt; c.r.y += c.w.y * dt;
    confetti.setMatrixAt(i, c.life > 0 ? m4.makeRotationFromEuler(c.r).setPosition(c.p) : zeroM);
  }
  confetti.instanceMatrix.needsUpdate = true;
}

// =====================================================================
// Son : petit « ding » quand un agent lève la main
// =====================================================================
let muted = store.get('muted', false);
let audioCtx = null;
function renderMute() { $('mute').textContent = muted ? '🔕' : '🔔'; }
renderMute();
function unlockAudio() { try { audioCtx ||= new AudioContext(); audioCtx.resume(); } catch { /* pas d'audio */ } }
function ding() {
  if (muted || !audioCtx) return;
  [880, 1318.5].forEach((f, i) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'sine'; o.frequency.value = f;
    const t0 = audioCtx.currentTime + i * 0.13;
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(0.16, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.9);
    o.connect(g).connect(audioCtx.destination); o.start(t0); o.stop(t0 + 1);
  });
}
function toggleMute() { muted = !muted; store.set('muted', muted); renderMute(); unlockAudio(); if (!muted) ding(); }
$('mute').onclick = toggleMute;

// =====================================================================
// Filtres
// =====================================================================
const filters = { project: store.get('filterProject', ''), hideIdle: store.get('hideIdle', false) };
$('filter-idle').checked = filters.hideIdle;
const isVisible = (a) => (!filters.project || a.project === filters.project) && !(filters.hideIdle && a.status === 'idle');
function renderFilterOptions(list) {
  const sel = $('filter-project');
  const names = [...new Set(list.map((a) => a.project))].sort((a, b) => a.localeCompare(b));
  const key = names.join('|');
  if (sel.dataset.key === key) return; sel.dataset.key = key;
  sel.innerHTML = `<option value="">Tous les projets</option>` + names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  sel.value = names.includes(filters.project) ? filters.project : '';
}
$('filter-project').onchange = (e) => { filters.project = e.target.value; store.set('filterProject', filters.project); update(agentsData, lastStats); };
$('filter-idle').onchange = (e) => { filters.hideIdle = e.target.checked; store.set('hideIdle', filters.hideIdle); update(agentsData, lastStats); };

// =====================================================================
// Interface : compteurs, liste, fil d'activité, fiche
// =====================================================================
function renderStats(list) {
  const waitingN = list.filter((a) => a.status === 'waiting').length;
  document.title = (waitingN ? `(${waitingN}) ` : '') + 'Bureau des agents'; // pastille dans l'onglet
  for (const k of ['working', 'waiting', 'idle']) $('n-' + k).textContent = list.filter((a) => a.status === k).length;
}
function renderRoster(list) {
  const order = { working: 0, waiting: 1, idle: 2 };
  $('roster-list').innerHTML = list.filter(isVisible).sort((a, b) => order[a.status] - order[b.status]).map((a) => `
    <div class="row" data-id="${esc(a.id)}"><span class="dot ${a.status}"></span><div>
      <b>${esc(a.title)}</b><small><span class="proj" style="background:#${projColor(a.project).getHexString()}"></span>${esc(a.project)} · ${a.status === 'working' && a.current ? esc(a.current.verb + ' ' + (a.current.detail || '')) : esc(ago(a.lastActivity))}</small>
    </div></div>`).join('');
}
$('roster-list').addEventListener('click', (e) => {
  const row = e.target.closest('.row'); if (!row) return;
  goTo(row.dataset.id); openPanel(row.dataset.id);
});

const feedEl = $('feed');
function pushFeed(a, text, err = false) {
  if (!isVisible(a)) return;
  const el = document.createElement('div');
  if (err) el.className = 'err';
  el.innerHTML = `<span>${esc(a.project)}</span> · ${esc(text)}`;
  feedEl.append(el);
  while (feedEl.children.length > 5) feedEl.firstChild.remove();
}

let openId = null;
const panel = $('panel');
function openPanel(id) {
  openId = id; renderPanel(id); renderPanelActions(id);
  panel.classList.add('open'); if (document.pointerLockElement) document.exitPointerLock();
}
function closePanel() { openId = null; panel.classList.remove('open'); }
$('panel-close').onclick = closePanel;
function renderPanel(id) {
  const a = agentsData.find((x) => x.id === id);
  if (!a) { closePanel(); return; }
  const s = STATUS[a.status];
  const todos = a.todos || [];
  $('panel-body').innerHTML = `
    <span class="status-chip"><span class="dot ${a.status}"></span>${s.label}</span>
    <h2>${esc(a.title)}</h2>
    <div class="meta">${esc(a.cwd || a.project)}${a.branch ? ' · ⎇ ' + esc(a.branch) : ''}<br>${esc(a.model || '')} · dernière activité ${esc(ago(a.lastActivity))}${a.subagents ? ` · ${a.subagents} sous-agent(s) actif(s)` : ''}${a.workload ? ` · ${a.workload} actions aujourd'hui` : ''}</div>
    ${a.status === 'working' ? `<div class="now">${a.phase === 'thinking' ? '<b>Réfléchit</b> au résultat de sa dernière action' : `<b>${esc(a.current?.verb || '')}</b> ${esc(a.current?.detail || '')}`}</div>` : ''}
    ${a.error ? `<div class="err"><b>⚠ ${esc(a.error.verb)} a échoué</b> (${esc(hhmm(a.error.ts))})<br>${esc(a.error.text)}</div>` : ''}
    ${todos.length ? `<h4>Tâches (${todos.filter((t) => t.status === 'completed').length}/${todos.length})</h4><ul class="todos">${todos.map((t) => `<li class="${esc(t.status)}">${t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '▶' : '☐'} ${esc(t.status === 'in_progress' && t.active ? t.active : t.text)}</li>`).join('')}</ul>` : ''}
    ${a.lastPrompt ? `<h4>Ta dernière demande</h4><div class="quote">${esc(a.lastPrompt)}</div>` : ''}
    ${a.actions.length ? `<h4>Dernières actions</h4><ol>${[...a.actions].reverse().map((x) => `<li><time>${hhmm(x.ts)}</time><b>${esc(x.verb)}</b><span>${esc(x.detail || '')}</span></li>`).join('')}</ol>` : ''}
    ${a.lastText ? `<h4>Dernier message</h4><div class="quote">${esc(a.lastText)}</div>` : ''}`;
}
function renderPanelActions(id) {
  const a = agentsData.find((x) => x.id === id); if (!a) return;
  const inApp = a.entrypoint && a.entrypoint !== 'cli';
  if (a.source === 'cowork') { // Cowork tourne dans l'app Claude : on ne peut pas la reprendre au Terminal
    $('panel-actions').innerHTML = `<h4>Actions</h4><div class="btns"><button class="ghost" data-act="follow">🎥 Suivre</button><button class="ghost" data-act="screen">🖥 Voir son écran</button></div><div id="reply"><div class="note">Session Cowork : pour lui répondre, ouvre-la dans l'app Claude.</div><div class="msg"></div></div>`;
    return;
  }
  if (isRemote) { // depuis le téléphone : pas d'ouverture de Terminal à distance
    $('panel-actions').innerHTML = `<h4>Actions</h4><div class="btns"><button class="ghost" data-act="follow">🎥 Suivre</button><button class="ghost" data-act="screen">🖥 Voir son écran</button></div><div id="reply"><div class="note">Pour lui répondre, passe par l'ordinateur : l'ouverture du Terminal n'est pas possible depuis le wifi.</div><div class="msg"></div></div>`;
    return;
  }
  $('panel-actions').innerHTML = `
    <h4>Actions</h4>
    <div class="btns">
      <button class="ghost" data-act="follow">🎥 Suivre (F)</button>
      <button class="ghost" data-act="screen">🖥 Voir son écran (R)</button>
      <button class="ghost" data-act="open">⌨️ Ouvrir dans le Terminal</button>
      <button class="ghost" data-act="copy">📋 Copier la commande</button>
    </div>
    <div id="reply">
      <h4>Lui répondre</h4>
      <textarea placeholder="Ta réponse… (⌘ + Entrée pour envoyer)"></textarea>
      <div class="note">Ouvre une fenêtre Terminal avec <code>claude --resume</code> et ta réponse.${inApp ? ' ⚠ Cette session vient de l\'app Claude : si elle y est encore ouverte, réponds plutôt là-bas pour ne pas créer deux conversations parallèles.' : ''}</div>
      <button class="primary" data-act="send">Envoyer via le Terminal</button>
      <div class="msg"></div>
    </div>`;
}
$('panel-actions').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act; if (!act || !openId) return;
  const a = agentsData.find((x) => x.id === openId); if (!a) return;
  const msg = $('panel-actions').querySelector('.msg');
  if (act === 'follow') { closePanel(); setMode('follow', { id: a.id }); }
  if (act === 'screen') { closePanel(); setMode('screen', { id: a.id }); }
  if (act === 'copy') {
    const cmd = `cd '${(a.launchCwd || a.cwd || '').replace(/'/g, `'\\''`)}' && claude --resume ${a.id}`;
    try { await navigator.clipboard.writeText(cmd); msg.textContent = '✓ Commande copiée'; } catch { msg.textContent = cmd; }
  }
  if (act === 'open' || act === 'send') {
    const text = act === 'send' ? $('panel-actions').querySelector('textarea').value : '';
    if (act === 'send' && !text.trim()) { msg.textContent = 'Écris d\'abord ta réponse.'; return; }
    if (demo) { msg.textContent = 'Indisponible en mode démo.'; return; }
    msg.textContent = 'Ouverture du Terminal…';
    try {
      const r = await fetch('/api/resume', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN }, body: JSON.stringify({ id: a.id, text }) });
      const j = await r.json();
      msg.textContent = r.ok ? '✓ Session ouverte dans le Terminal' : `Échec : ${j.error}`;
      if (r.ok && act === 'send') $('panel-actions').querySelector('textarea').value = '';
    } catch (err) { msg.textContent = `Échec : ${err.message}`; }
  }
});
$('panel-actions').addEventListener('keydown', (e) => {
  e.stopPropagation(); // on tape du texte : pas de raccourcis
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('panel-actions').querySelector('[data-act=send]').click();
});

// =====================================================================
// Caméra : marche, ensemble, maquette, suivi, écran, visite
// =====================================================================
let mode = 'walk';
let followId = null, touring = false, tourNext = 0, tourIdx = 0;
const walkPose = { pos: camera.position.clone(), yaw, pitch };
const orbit = new OrbitControls(camera, canvasEl);
orbit.enabled = false; orbit.enableDamping = true;
let tween = null;
const lookCur = new THREE.Vector3();
const dummy = new THREE.PerspectiveCamera();
function quatLook(pos, target) { dummy.position.copy(pos); dummy.lookAt(target); return dummy.quaternion.clone(); }
function flyTo(pos, target, fov, dur, onDone, arc = false) {
  orbit.enabled = false;
  tween = { fp: camera.position.clone(), fq: camera.quaternion.clone(), ff: camera.fov, tp: pos.clone(), tq: quatLook(pos, target), tf: fov, t: 0, dur, onDone, arc: arc ? target.clone() : null };
  lookCur.copy(target);
}
function stepTween(dt) {
  if (!tween) return false;
  tween.t = Math.min(1, tween.t + dt / tween.dur);
  const e = tween.t < 0.5 ? 4 * tween.t ** 3 : 1 - (-2 * tween.t + 2) ** 3 / 2;
  if (tween.arc) { // tourne autour du point visé, à hauteur et distance interpolées
    const c = tween.arc, a0 = Math.atan2(tween.fp.x - c.x, tween.fp.z - c.z), a1 = a0 + angDiff(a0, Math.atan2(tween.tp.x - c.x, tween.tp.z - c.z));
    const r0 = Math.hypot(tween.fp.x - c.x, tween.fp.z - c.z), r1 = Math.hypot(tween.tp.x - c.x, tween.tp.z - c.z);
    const a = a0 + (a1 - a0) * e, r = r0 + (r1 - r0) * e;
    camera.position.set(c.x + Math.sin(a) * r, tween.fp.y + (tween.tp.y - tween.fp.y) * e, c.z + Math.cos(a) * r);
    camera.lookAt(c);
  } else {
    camera.position.lerpVectors(tween.fp, tween.tp, e);
    camera.quaternion.slerpQuaternions(tween.fq, tween.tq, e);
  }
  camera.fov = tween.ff + (tween.tf - tween.ff) * e; camera.updateProjectionMatrix();
  if (tween.t >= 1) { const cb = tween.onDone; tween = null; cb?.(); }
  return true;
}
const MODE_LABEL = { focus: 'Regarde', walk: 'Marche', overview: "Vue d'ensemble", iso: 'Maquette', follow: 'Suivi', screen: 'Écran', tour: 'Visite' };
function lookFromYawPitch(pos, y, p) { return v3.set(pos.x - Math.sin(y) * Math.cos(p), pos.y + Math.sin(p), pos.z - Math.cos(y) * Math.cos(p)); }
// Vue maquette : 4 angles (I pour tourner), on masque les deux murs côté caméra
const ISO_VIEWS = [
  { name: 'sud-est', dir: [0.8, 1.05, 1.0], hide: ['south', 'east'] },
  { name: 'sud-ouest', dir: [-0.8, 1.05, 1.0], hide: ['south', 'west'] },
  { name: 'nord-ouest', dir: [-0.8, 1.05, -1.0], hide: ['north', 'west'] },
  { name: 'nord-est', dir: [0.8, 1.05, -1.0], hide: ['north', 'east'] },
];
let isoView = 0, cutHide = [];
function applyCutaway() { for (const k of Object.keys(shellParts)) if (shellParts[k]) shellParts[k].visible = !cutHide.includes(k); }
function setMode(m, opts = {}) {
  if (mode === 'walk' && m !== 'walk') { walkPose.pos.copy(camera.position); walkPose.yaw = yaw; walkPose.pitch = pitch; }
  if (m !== 'follow' && m !== 'screen') touring = false;
  if (document.pointerLockElement && m !== 'walk') document.exitPointerLock();
  orbit.enabled = false;
  const wasIso = mode === 'iso' && m === 'iso';
  mode = m;
  const cx = (shellX0 + XE) / 2, cz = (ZN + shellZ1) / 2, width = ROOM_S;
  cutHide = m === 'overview' ? ['south', 'west', 'east', 'ceiling', 'upper'] : m === 'iso' ? [...ISO_VIEWS[isoView].hide, 'ceiling', 'upper'] : [];
  applyCutaway();
  if (m === 'walk') {
    flyTo(walkPose.pos, lookFromYawPitch(walkPose.pos, walkPose.yaw, walkPose.pitch), 70, 0.9, () => {
      yaw = walkPose.yaw; pitch = walkPose.pitch; camera.rotation.set(pitch, yaw, 0);
    });
  } else if (m === 'overview') {
    const target = new THREE.Vector3(cx, 0, cz);
    flyTo(v1.set(cx, Math.max(13, width * 1.25), cz + width * 0.85), target, 50, 1.1, () => {
      orbit.target.copy(target); orbit.enableRotate = true; orbit.mouseButtons.LEFT = THREE.MOUSE.ROTATE; orbit.maxPolarAngle = Math.PI / 2.1; orbit.enabled = true;
    });
  } else if (m === 'iso') {
    const target = new THREE.Vector3(cx, 0, cz);
    const dist = (width / (2 * Math.tan(THREE.MathUtils.degToRad(7)))) * 1.05;
    const dir = v3.set(...ISO_VIEWS[isoView].dir).normalize();
    flyTo(v1.copy(target).addScaledVector(dir, dist), target, 14, wasIso ? 1.0 : 1.3, () => {
      orbit.target.copy(target); orbit.enableRotate = false; orbit.mouseButtons.LEFT = THREE.MOUSE.PAN; orbit.screenSpacePanning = true; orbit.enabled = true;
    }, wasIso);
  } else if (m === 'focus') {
    followId = null; flyTo(opts.pos, opts.target, 55, 0.9);
  } else if (m === 'follow' || m === 'screen') {
    followId = opts.id; tween = null;
    const ag = agentById(followId); if (ag) lookCur.copy(ag.group.getWorldPosition(v1)).setY(1.3);
  }
  $('mode-chip').textContent = touring ? MODE_LABEL.tour : m === 'iso' ? `${MODE_LABEL.iso} · ${ISO_VIEWS[isoView].name}` : MODE_LABEL[m];
}
function toggleTour() {
  if (touring) { touring = false; setMode('walk'); return; }
  touring = true; tourNext = 0; tourIdx = 0;
  $('mode-chip').textContent = MODE_LABEL.tour;
}
function tourTick(t) {
  if (!touring || t < tourNext) return;
  const order = { working: 0, waiting: 1, idle: 2 };
  const pool = agentsData.filter((a) => isVisible(a) && a.status !== 'idle' && assign.get(a.id)).sort((a, b) => order[a.status] - order[b.status]);
  const list = pool.length ? pool : agentsData.filter((a) => isVisible(a) && assign.get(a.id));
  if (!list.length) return;
  const a = list[tourIdx++ % list.length];
  setMode('follow', { id: a.id }); touring = true; $('mode-chip').textContent = `${MODE_LABEL.tour} · ${a.project}`;
  tourNext = t + 10;
}
const followLook = new THREE.Vector3();
const clampIn = (v) => v.set(clamp(v.x, shellX0 + 0.3, XE - 0.3), clamp(v.y, 0.5, CEIL - 0.15), clamp(v.z, ZN + 0.3, shellZ1 - 0.3));
function updateFollowCam(dt) {
  const desk = assign.get(followId), ag = desk?.agent;
  if (!ag) { setMode('walk'); return; }
  ag.group.getWorldPosition(v1);
  ag.group.getWorldQuaternion(q1);
  const fwd = v2.set(0, 0, -1).applyQuaternion(q1).setY(0).normalize();
  let fov = 60;
  if (mode === 'screen' && ag.place === 'desk') {
    const m = desk.screen.getWorldPosition(v3);
    desk.group.localToWorld(v1.set(0, 1.32, 0.34)); // devant l'écran, entre l'agent et le moniteur
    lookCur.lerp(m, damp(6, dt)); fov = 45;
  } else {
    // par-dessus l'épaule droite
    lookCur.lerp(followLook.copy(v1).addScaledVector(fwd, 1.1).setY(1.25), damp(4, dt));
    v1.addScaledVector(fwd, -1.9).addScaledVector(v3.set(-fwd.z, 0, fwd.x), 0.55).setY(2.05);
  }
  camera.position.lerp(clampIn(v1), damp(3, dt));
  camera.lookAt(lookCur);
  camera.fov += (fov - camera.fov) * damp(3, dt); camera.updateProjectionMatrix();
}

function goTo(id) {
  const desk = assign.get(id); if (!desk) return;
  if (mode !== 'walk') { setMode('follow', { id }); return; }
  const ag = desk.agent;
  let tx, tz, ax, az;
  if (ag.place === 'desk') {
    const sd = { x: Math.cos(desk.rot), z: -Math.sin(desk.rot) };
    ax = desk.seat.x; az = desk.seat.z; tx = ax + desk.back.x * 1.4 + sd.x * 0.9; tz = az + desk.back.z * 1.4 + sd.z * 0.9;
  }
  else {
    ag.group.getWorldPosition(v1); ax = v1.x; az = v1.z;
    const fx = -Math.sin(ag.yaw), fz = -Math.cos(ag.yaw);
    search: for (const d of [2.2, 1.6, 2.8, 3.4]) for (const lat of [0, 0.8, -0.8, 1.5, -1.5]) {
      tx = ax + fx * d - fz * lat; tz = az + fz * d + fx * lat;
      if (!collides(tx, tz)) break search;
    }
  }
  backToOffice();
  const to = new THREE.Vector3(tx, 1.65, tz), target = new THREE.Vector3(ax, 1.3, az);
  flyTo(to, target, 70, 1.0, () => {
    yaw = Math.atan2(-(ax - tx), -(az - tz)); pitch = Math.atan2(1.3 - 1.65, Math.hypot(ax - tx, az - tz));
    camera.rotation.set(pitch, yaw, 0);
  });
  walkPose.pos.copy(to);
}

// Souris et clavier
const intro = $('intro');
function lock() { try { const p = canvasEl.requestPointerLock(); p?.catch?.(() => {}); } catch { /* pas de verrouillage */ } }
$('enter').onclick = () => { intro.remove(); unlockAudio(); if (!matchMedia('(pointer: coarse)').matches) lock(); };

let dragging = false, dragDist = 0;
// Tactile (téléphone, tablette) : pouce gauche pour marcher, glisser pour regarder, toucher pour agir
const joy = { id: null, x0: 0, y0: 0, f: 0, s: 0 };
let lookTouch = null, lastTouch = -1e9;
const joyEl = $('joy');
canvasEl.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  lastTouch = performance.now(); unlockAudio();
  if (mode === 'walk' && joy.id === null && e.clientX < innerWidth * 0.45 && e.clientY > innerHeight * 0.3) {
    Object.assign(joy, { id: e.pointerId, x0: e.clientX, y0: e.clientY, f: 0, s: 0 });
    joyEl.style.display = 'block'; joyEl.style.left = e.clientX + 'px'; joyEl.style.top = e.clientY + 'px'; joyEl.firstElementChild.style.transform = '';
  } else if (!lookTouch) lookTouch = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: 0, t0: performance.now() };
});
addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'touch') return;
  if (e.pointerId === joy.id) {
    let dx = e.clientX - joy.x0, dy = e.clientY - joy.y0; const l = Math.hypot(dx, dy), Rj = 50;
    if (l > Rj) { dx *= Rj / l; dy *= Rj / l; }
    joy.s = dx / Rj; joy.f = -dy / Rj; joyEl.firstElementChild.style.transform = `translate(${dx}px, ${dy}px)`;
  } else if (lookTouch && e.pointerId === lookTouch.id) {
    const dx = e.clientX - lookTouch.x, dy = e.clientY - lookTouch.y;
    lookTouch.x = e.clientX; lookTouch.y = e.clientY; lookTouch.moved += Math.abs(dx) + Math.abs(dy);
    if (mode === 'walk' && !tween) { yaw -= dx * 0.005; pitch = clamp(pitch - dy * 0.005, -1.45, 1.45); }
  }
});
function endTouch(e) {
  if (e.pointerType !== 'touch') return;
  lastTouch = performance.now();
  if (e.pointerId === joy.id) { joy.id = null; joy.f = joy.s = 0; joyEl.style.display = 'none'; return; }
  if (!lookTouch || e.pointerId !== lookTouch.id) return;
  const tap = lookTouch.moved < 12 && performance.now() - lookTouch.t0 < 400, { sx, sy } = lookTouch;
  lookTouch = null;
  if (!tap) return;
  const id = pickAt(sx, sy);
  if (id) openPanel(id); else if (mode === 'walk') pickInteract(sx, sy)?.act();
}
addEventListener('pointerup', endTouch); addEventListener('pointercancel', endTouch);
const fromTouch = () => performance.now() - lastTouch < 900; // ignore les faux clics de souris émis après un toucher

// barre tactile : vues et liste des agents
$('touchbar').addEventListener('click', (e) => {
  const v = e.target.closest('button')?.dataset.v; if (!v) return;
  if (v === 'roster') { $('roster').classList.toggle('show'); return; }
  $('roster').classList.remove('show');
  if (v === 'tour') toggleTour();
  else if (v === 'iso') { if (mode === 'iso') isoView = (isoView + 1) % 4; setMode('iso'); }
  else setMode(v);
});

canvasEl.addEventListener('mousedown', () => { if (fromTouch()) return; dragging = true; dragDist = 0; });
addEventListener('mouseup', (e) => {
  if (!dragging) return; dragging = false;
  if (e.target !== canvasEl || dragDist > 5) return;
  if (document.pointerLockElement) { if (aimed) openPanel(aimed); else if (aimedObj) aimedObj.act(); return; }
  const id = pickAt(e.clientX, e.clientY);
  if (id) { openPanel(id); return; }
  const obj = mode === 'walk' ? pickInteract(e.clientX, e.clientY) : null;
  if (obj) obj.act();
  else if (mode === 'walk' && !tween && !panel.classList.contains('open')) lock();
});
addEventListener('mousemove', (e) => {
  if (dragging) dragDist += Math.abs(e.movementX) + Math.abs(e.movementY);
  if (mode !== 'walk' || tween) return;
  const locked = document.pointerLockElement === canvasEl;
  if (!locked && !dragging) return;
  const k = locked ? 0.0022 : 0.004;
  yaw -= e.movementX * k; pitch = clamp(pitch - e.movementY * k, -1.45, 1.45);
});
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvasEl;
  $('crosshair').style.display = locked ? 'block' : 'none';
  if (!locked) $('hint').style.display = 'none';
});
const keys = new Set();
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  keys.add(e.code);
  const target = aimed || openId;
  switch (e.code) {
    case 'KeyE': if (aimed) openPanel(aimed); else if (aimedObj) aimedObj.act(); break;
    case 'Escape':
      if ($('report').classList.contains('open')) $('report').classList.remove('open');
      else if (panel.classList.contains('open')) closePanel();
      else if (mode !== 'walk') setMode('walk');
      break;
    case 'KeyV': setMode(mode === 'overview' ? 'walk' : 'overview'); break;
    case 'KeyI': if (mode === 'iso') isoView = (isoView + (e.shiftKey ? 3 : 1)) % 4; setMode('iso'); break; // réappuyer : angle suivant
    case 'KeyF': if (target) { closePanel(); setMode('follow', { id: target }); } break;
    case 'KeyR': if (target) { closePanel(); setMode('screen', { id: target }); } break;
    case 'KeyO': toggleTour(); break;
    case 'KeyT':
      if (!timeLapse) { lapseBase = currentHour(); lapseStart = performance.now(); }
      timeLapse = !timeLapse; lastTimeApply = -1; break;
    case 'KeyM': toggleMute(); break;
  }
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

const ray = new THREE.Raycaster(); const ndc = new THREE.Vector2();
function hitList() { return desks.filter((d) => d.agent && d.agent.group.visible).map((d) => d.agent.hit); }
function idForHit(obj) { for (const [id, d] of assign) if (d.agent?.hit === obj) return id; return null; }
function pickAt(x, y) {
  ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1); ray.setFromCamera(ndc, camera);
  const h = ray.intersectObjects(hitList(), false)[0]; return h ? idForHit(h.object) : null;
}
let aimed = null, aimedObj = null;
function firstHit(hits) {
  for (const h of hits) {
    const e = h.object.userData.interact;
    if (e) return h.distance <= e.range ? { obj: e } : null;
    const id = idForHit(h.object); if (id) return { id };
  }
  return null;
}
function updateAim() {
  aimed = null; aimedObj = null; const hint = $('hint');
  if (mode !== 'walk' || tween) { hint.style.display = 'none'; return; }
  ray.setFromCamera(ndc.set(0, 0), camera); ray.far = 7;
  const hit = firstHit(ray.intersectObjects([...hitList(), ...interactList()], false)); ray.far = Infinity;
  if (hit?.id) aimed = hit.id; else if (hit?.obj) aimedObj = hit.obj;
  const a = aimed && agentsData.find((x) => x.id === aimed);
  if (a) { hint.innerHTML = `<kbd>E</kbd> fiche · <kbd>F</kbd> suivre · <kbd>R</kbd> écran — ${esc(a.title)}`; hint.style.display = 'block'; }
  else if (aimedObj) { hint.innerHTML = `<kbd>E</kbd> ${esc(aimedObj.label())}`; hint.style.display = 'block'; }
  else hint.style.display = 'none';
}
function pickInteract(x, y) {
  ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1); ray.setFromCamera(ndc, camera);
  const h = ray.intersectObjects(interactList(), false)[0];
  return h && h.distance <= Math.max(4, h.object.userData.interact.range) ? h.object.userData.interact : null;
}

let walkT = 0;
function move(dt) {
  if (mode !== 'walk' || tween || panel.classList.contains('open')) return;
  let f = joy.f, s = joy.s; // manette tactile (analogique) + clavier
  if (keys.has('KeyW') || keys.has('ArrowUp')) f += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) f -= 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) s -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) s += 1;
  const moving = Math.abs(f) > 0.12 || Math.abs(s) > 0.12;
  if (seated) {
    if (moving) standUp();
    else { camera.rotation.set(pitch, yaw, 0); return; }
  }
  if (moving) {
    const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 6 : 3.2) * dt;
    const len = Math.max(1, Math.hypot(f, s)); // à fond au clavier, progressif à la manette
    const dx = ((-Math.sin(yaw) * f + Math.cos(yaw) * s) / len) * speed, dz = ((-Math.cos(yaw) * f - Math.sin(yaw) * s) / len) * speed;
    const p = camera.position;
    if (!collides(p.x + dx, p.z)) p.x += dx;
    if (!collides(p.x, p.z + dz)) p.z += dz;
    walkT += speed * 2.2;
  }
  camera.position.y = levelY() + 1.65 + (moving ? Math.sin(walkT) * 0.03 : 0);
  camera.rotation.set(pitch, yaw, 0);
  walkPose.pos.copy(camera.position); walkPose.yaw = yaw; walkPose.pitch = pitch;
}

// =====================================================================
// Interactions dans le bureau : porte, café, micro-ondes, lumière, stores,
// imprimante, distributeur, s'asseoir, regarder un écran
// =====================================================================
let interactables = [];
const staticInteract = [];
let interactMeshes = null;
function interact(obj, spec, isStatic = false) {
  const entry = { obj, range: 2.6, ...spec };
  obj.traverse((m) => { if (m.isMesh) m.userData.interact = entry; });
  (isStatic ? staticInteract : interactables).push(entry);
  interactMeshes = null;
  return entry;
}
function interactList() {
  if (!interactMeshes) {
    interactMeshes = [];
    for (const e of [...interactables, ...staticInteract]) e.obj.traverse((m) => { if (m.isMesh) interactMeshes.push(m); });
  }
  return interactMeshes;
}
function resetInteractables() { interactables = []; interactMeshes = null; }

let toastTimer = 0;
function toast(text, ms = 2800) {
  const el = $('toast'); el.textContent = text; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// petits bruitages synthétisés (pas de fichiers audio)
let noiseBuffer = null;
function getNoise() {
  if (!noiseBuffer) { noiseBuffer = audioCtx.createBuffer(1, audioCtx.sampleRate * 2, audioCtx.sampleRate); const d = noiseBuffer.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
  return noiseBuffer;
}
function sfx(kind, scale = 1) {
  if (muted || !audioCtx) return;
  const ac = audioCtx, t0 = ac.currentTime;
  getNoise();
  const env = (node, v, at, dur) => { const vol = v * scale; const g = ac.createGain(); g.gain.setValueAtTime(0, t0 + at); g.gain.linearRampToValueAtTime(vol, t0 + at + 0.02); g.gain.setValueAtTime(vol, t0 + at + Math.max(0.02, dur - 0.08)); g.gain.linearRampToValueAtTime(0, t0 + at + dur); node.connect(g).connect(ac.destination); };
  const tone = (f, dur, type = 'sine', vol = 0.1, at = 0) => { const o = ac.createOscillator(); o.type = type; o.frequency.value = f; env(o, vol, at, dur); o.start(t0 + at); o.stop(t0 + at + dur + 0.05); };
  const noise = (dur, vol, freq, q = 1, at = 0) => {
    const s = ac.createBufferSource(); s.buffer = noiseBuffer; s.loop = true;
    const f = ac.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    s.connect(f); env(f, vol, at, dur); s.start(t0 + at); s.stop(t0 + at + dur + 0.05);
  };
  switch (kind) {
    case 'click': tone(1900, 0.04, 'square', 0.04); break;
    case 'door': noise(0.45, 0.12, 350, 0.7); tone(85, 0.25, 'sine', 0.12, 0.3); break;
    case 'brew': noise(3.0, 0.07, 900, 0.5); tone(55, 3.0, 'sawtooth', 0.015); break;
    case 'hum': tone(110, 4, 'sawtooth', 0.02); noise(4, 0.02, 200, 0.5); break;
    case 'ding3': [0, 0.35, 0.7].forEach((a) => tone(1568, 0.45, 'sine', 0.12, a)); break;
    case 'print': for (let i = 0; i < 7; i++) noise(0.16, 0.09, 2200, 1.4, i * 0.28); tone(180, 2, 'triangle', 0.02); break;
    case 'zip': noise(0.55, 0.09, 3200, 0.4); break;
    case 'lift': tone(1319, 0.5, 'sine', 0.1); tone(1047, 0.8, 'sine', 0.1, 0.3); break;
    case 'liftmove': tone(80, 2.4, 'sawtooth', 0.025); noise(2.4, 0.04, 260, 0.5); break;
    case 'flush': noise(0.5, 0.12, 1400, 0.7); noise(2.2, 0.16, 420, 0.5, 0.3); noise(1.4, 0.06, 900, 0.8, 1.6); break;
    case 'tap': noise(1.2, 0.08, 2600, 0.6); break;
    case 'boxer': for (let i = 0; i < 3; i++) { tone(48 + i * 14, 0.9, 'sawtooth', 0.06, i * 0.55); noise(0.9, 0.08, 160, 0.8, i * 0.55); } break;
    case 'twin': for (let i = 0; i < 3; i++) { tone(70 + i * 22, 0.8, 'sawtooth', 0.045, i * 0.5); noise(0.8, 0.06, 240, 0.9, i * 0.5); } break;
    case 'dryer': noise(2.5, 0.12, 1800, 0.3); tone(140, 2.5, 'sawtooth', 0.015); break;
    case 'steps': for (let i = 0; i < 6; i++) noise(0.07, 0.14, 320 + (i % 2) * 90, 1.2, i * 0.2); break;
    case 'thunk': tone(70, 0.2, 'sine', 0.2); noise(0.15, 0.12, 600, 1); break;
  }
}

// ambiance sonore : pluie contre les vitres (plus forte près des fenêtres), claviers des agents au travail
let ambience = null;
function startAmbience() {
  if (!audioCtx || ambience) return;
  const ac = audioCtx, src = ac.createBufferSource(); src.buffer = getNoise(); src.loop = true;
  const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 900;
  const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 6500;
  const rain = ac.createGain(); rain.gain.value = 0;
  src.connect(hp).connect(lp).connect(rain).connect(ac.destination); src.start();
  ambience = { rain, nextKey: 0 };
}
function keyClick(vol) {
  const ac = audioCtx, t0 = ac.currentTime, src = ac.createBufferSource(); src.buffer = getNoise();
  const f = ac.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2200 + Math.random() * 2600; f.Q.value = 2.5;
  const g = ac.createGain(); g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime(0.09 * vol, t0 + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.035);
  src.connect(f).connect(g).connect(ac.destination); src.start(t0, Math.random()); src.stop(t0 + 0.05);
}
function updateAmbience(t) {
  if (audioCtx && !ambience) startAmbience();
  if (!ambience) return;
  const s3 = sky3(weather), inOffice = camera.position.z < shellZ1, close = mode !== 'overview' && mode !== 'iso';
  const near = clamp(1 - (camera.position.z - ZN) / 9, 0.15, 1) * (inOffice ? 1 : 0.25);
  const target = !muted && close && (s3.rain || s3.storm) ? 0.04 + 0.11 * near : 0;
  ambience.rain.gain.value += (target - ambience.rain.gain.value) * 0.05;
  if (t < ambience.nextKey) return;
  ambience.nextKey = t + 0.05 + Math.random() * 0.13;
  if (muted || !close) return;
  let best = Infinity, n = 0;
  for (const d of desks) if (d.agent && d.data.status === 'working' && d.agent.place === 'desk' && d.agent.group.visible && d.data.phase !== 'thinking') { n++; best = Math.min(best, camera.position.distanceTo(d.group.position)); }
  if (!n || Math.random() > Math.min(0.85, 0.3 + n * 0.12)) return;
  keyClick(clamp(1.15 - best / 9, 0.06, 1) * (inOffice ? 1 : 0.2));
}
// au café, les agents discutent
const CHAT = ['Tu as vu ce diff ?', 'Encore un café ?', 'Mes tests passent ✅', 'J\u2019attends ma review…', 'Trop de tokens ce matin', 'Qui a fini le café ?', 'On merge vendredi ?', 'Tu as vu la météo ?', 'Mon build est vert 🟢', 'Encore un bug de cache…'];
let nextChat = 8;
function chatTick(t) {
  if (t < nextChat) return; nextChat = t + 3 + Math.random() * 3.5;
  const talkers = desks.filter((d) => d.agent && d.agent.group.visible && d.agent.place !== 'desk' && !d.agent.transit && d.agent.spot?.pose === 'coffee' && d.agent.dir > 0 && d.agent.u >= d.agent.route.len);
  if (talkers.length < 2) return;
  const ag = talkers[Math.floor(Math.random() * talkers.length)].agent;
  ag.sayUntil = t + 2.6; drawBubble(ag, CHAT[Math.floor(Math.random() * CHAT.length)]);
}

// porte d'entrée (ouverte par défaut)
let door = null;
const doorIsOpen = () => !door || door.angle > 1.0;
function updateDoor(dt) {
  if (!door) return;
  const target = door.open ? 1.6 : 0;
  door.angle += (target - door.angle) * damp(5, dt);
  door.pivot.rotation.y = door.angle;
}

// ascenseur du couloir
let lift = null;
function callLift() {
  if (!lift || lift.callAt != null) return;
  lift.callAt = clock.elapsedTime; lift.dinged = false; lift.btnM.emissiveIntensity = 1.4;
  sfx('click'); toast('🛗 L’ascenseur arrive…');
}
function updateLift(t, dt) {
  if (!lift) return;
  const e = lift.callAt == null ? Infinity : t - lift.callAt;
  if (e > 2.5 && e < 99 && !lift.dinged) { lift.dinged = true; lift.btnM.emissiveIntensity = 0; sfx('lift'); }
  lift.open += ((e > 2.5 && e < 10 ? 1 : 0) - lift.open) * damp(4, dt);
  lift.leaves[0].position.x = -0.25 - lift.open * 0.5; lift.leaves[1].position.x = 0.25 + lift.open * 0.5;
  if (e > 12 && e < Infinity) lift.callAt = null;
}

// changer de niveau : fondu au noir, bruit de pas ou de cabine, arrivée devant la porte
let hall = null, traveling = false;
const fadeEl = document.createElement('div');
Object.assign(fadeEl.style, { position: 'fixed', inset: '0', background: '#000', opacity: '0', pointerEvents: 'none', transition: 'opacity .45s', zIndex: '40' });
document.body.appendChild(fadeEl);
function travel(to, spot, how) {
  if (traveling || seated) return;
  traveling = true; fadeEl.style.opacity = '1'; sfx(how);
  const from = level === 'rdc' ? 0 : CONFIG.etage, dest = to === 'rdc' ? 0 : CONFIG.etage;
  if (how === 'liftmove') { // l'afficheur défile pendant la descente ou la montée
    let n = from; const step = Math.sign(dest - from);
    const tick = setInterval(() => { if (n === dest) return clearInterval(tick); n += step; lift.show(n); }, 2000 / Math.max(1, Math.abs(dest - from)));
  }
  setTimeout(() => {
    level = to;
    const [x, z] = BLD.spots[spot];
    camera.position.set(x, levelY() + 1.65, z); yaw = 0; pitch = 0; camera.rotation.set(0, 0, 0);
    walkPose.pos.copy(camera.position); walkPose.yaw = 0; walkPose.pitch = 0;
    if (lift) {
      lift.group.position.y = level === 'rdc' ? BLD.hallY : 0;
      lift.show(level === 'rdc' ? 0 : CONFIG.etage);
      if (how === 'liftmove') { lift.open = 1; lift.callAt = clock.elapsedTime - 3; lift.dinged = true; sfx('lift'); }
    }
    fadeEl.style.opacity = '0'; traveling = false;
    toast(to === 'rdc' ? '🚪 Rez-de-chaussée : la sortie donne sur la rue' : to === 'toit' ? '🌤️ Toit-terrasse' : `🏢 Retour au ${floorName(CONFIG.etage)}`);
  }, how === 'liftmove' ? 2600 : 1300);
}
function rideLift() { lift.callAt = null; travel(level === 'rdc' ? 'bureau' : 'rdc', level === 'rdc' ? 'liftBureau' : 'liftRdc', 'liftmove'); }
function backToOffice() {
  if (level === 'bureau') return;
  level = 'bureau'; if (lift) { lift.group.position.y = 0; lift.show(CONFIG.etage); }
}
let wcSwing = null;
function updateHall(dt) { // portes qui s'ouvrent quand on approche : entrée du hall, toilettes
  if (wcSwing) {
    const near = level === 'bureau' && Math.hypot(camera.position.x - wcSwing.x, camera.position.z - wcSwing.z) < 2.2;
    wcSwing.open += ((near ? 1 : 0) - wcSwing.open) * damp(5, dt);
    wcSwing.pivot.rotation.y = -wcSwing.open * 1.5;
  }
  if (!hall) return;
  const near = level === 'rdc' && Math.hypot(camera.position.x - hall.x, camera.position.z - hall.z) < 3.5;
  hall.open += ((near ? 1 : 0) - hall.open) * damp(5, dt);
  hall.leaves[0].position.x = hall.x - 0.55 - hall.open * 1.05; hall.leaves[1].position.x = hall.x + 0.55 + hall.open * 1.05;
}

// lumière du bureau
let lightsOn = true;
function toggleLights() { lightsOn = !lightsOn; sfx('click'); lastTimeApply = -1; toast(lightsOn ? '💡 Lumière allumée' : '🌑 Lumière éteinte (les écrans éclairent encore)'); }

// café Nespresso
let coffee = null, coffeeCount = store.get('coffee-' + new Date().toDateString(), 0);
const steam = Array.from({ length: 14 }, () => {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
  s.scale.setScalar(0.06); s.visible = false; scene.add(s); s.userData.phase = Math.random(); return s;
});
function brewCoffee() {
  if (!coffee) return;
  if (coffee.busy) { toast('Patience, ça coule…'); return; }
  coffee.busy = true; coffee.steamUntil = clock.elapsedTime + 9; coffee.cup.visible = true; sfx('brew');
  toast('☕ Le café coule…', 3000);
  setTimeout(() => {
    coffee.busy = false; coffeeCount++; store.set('coffee-' + new Date().toDateString(), coffeeCount);
    toast(`☕ Café prêt ! (${coffeeCount} aujourd'hui)`);
    setTimeout(() => { if (coffee && !coffee.busy) coffee.cup.visible = false; }, 20000);
  }, 3100);
}
function updateSteam(t) {
  const on = coffee && t < coffee.steamUntil;
  steam.forEach((s) => {
    s.visible = !!on; if (!on) return;
    const k = (t * 0.5 + s.userData.phase) % 1;
    s.position.copy(coffee.steamAt).add(v1.set(Math.sin(k * 9 + s.userData.phase * 6) * 0.03, k * 0.35, 0));
    s.material.opacity = Math.sin(k * Math.PI) * 0.5; s.scale.setScalar(0.04 + k * 0.08);
  });
}

// micro-ondes
let microwave = null;
function heatMicrowave() {
  if (!microwave) return;
  if (microwave.busy) { toast('Ça tourne encore…'); return; }
  microwave.busy = true; sfx('hum'); toast('🍲 Micro-ondes lancé (4 s)');
  microwave.door.material.emissive.set(0xffc46b); microwave.door.material.emissiveIntensity = 1.2;
  setTimeout(() => { microwave.busy = false; microwave.door.material.emissiveIntensity = 0; sfx('ding3'); toast('Ding ! C’est chaud 🔥'); }, 4000);
}

// stores vénitiens, fenêtre par fenêtre
const blinds = [];
const blindPrefs = store.get('blinds', {});
function setBlind(b) {
  const n = Math.round(((2.55 - 0.95) * b.cover) / 0.028);
  b.mesh.count = n; b.bar.position.y = 2.55 - 0.08 - n * 0.028;
}
function toggleBlind(b) {
  b.cover = b.cover > 0.3 ? 0.08 : 0.9; setBlind(b); sfx('zip');
  blindPrefs[b.key] = b.cover; store.set('blinds', blindPrefs);
}

// imprimante : rapport du jour
let printer = null;
function printReport() {
  if (!printer) return;
  if (printer.t0) return;
  sfx('print'); printer.t0 = clock.elapsedTime; printer.sheet.visible = true; toast('🖨️ Impression du rapport du jour…', 2200);
  setTimeout(() => { printer.t0 = 0; printer.sheet.visible = false; openReport(); }, 2200);
}
function updatePrinter(t) {
  if (!printer?.t0) return;
  const k = clamp((t - printer.t0) / 2, 0, 1);
  printer.sheet.position.copy(printer.sheetFrom).addScaledVector(printer.sheetDir, k * 0.26);
}
function openReport() {
  const s = lastStats, list = agentsData;
  const counts = { working: 0, waiting: 0, idle: 0 }; list.forEach((a) => counts[a.status]++);
  const projects = [...new Set(list.map((a) => a.project))].sort().map((p) => ({ p, n: list.filter((a) => a.project === p).length, st: s?.projects?.[p] }));
  const date = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('report-body').innerHTML = `
    <h1>Rapport du jour</h1>
    <p class="sub">${esc(date)} · ${weather ? `${esc(weather.place)}, ${Math.round(weather.temp)} °C` : ''} · imprimé à ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</p>
    <div class="kpis">
      <div><b>${counts.working}</b>au travail</div><div><b>${counts.waiting}</b>t'attendent</div><div><b>${counts.idle}</b>en pause</div>
      <div><b>${s ? fmt(s.tokens.output) : '—'}</b>tokens générés</div><div><b>${s ? s.hours.reduce((a, b) => a + b, 0) : '—'}</b>actions</div><div><b>${coffeeCount}</b>cafés ☕</div>
    </div>
    <h2>Par projet</h2>
    <table><tr><th>Projet</th><th>Agents</th><th>Actions</th><th>Tokens</th><th>Fichier le plus modifié</th></tr>
    ${projects.map(({ p, n, st }) => `<tr><td>${esc(p)}</td><td>${n}</td><td>${st?.calls ?? 0}</td><td>${st ? fmt(st.tokens.output) : 0}</td><td>${esc(st?.files?.[0]?.[0] || '—')}</td></tr>`).join('')}</table>
    <h2>Agents</h2>
    <table><tr><th></th><th>Session</th><th>Projet</th><th>Dernière activité</th></tr>
    ${list.map((a) => `<tr><td>${a.status === 'working' ? '🟢' : a.status === 'waiting' ? '🟡' : '⚪'}</td><td>${esc(a.title)}</td><td>${esc(a.project)}</td><td>${esc(ago(a.lastActivity))}</td></tr>`).join('')}</table>
    ${s?.history?.length ? `<h2>Les ${s.history.length} derniers jours</h2><table><tr><th>Jour</th><th>Sessions</th><th>Actions</th><th>Réponses</th><th>Tokens générés</th></tr>
    ${[...s.history].reverse().map((d) => `<tr><td>${esc(new Date(d.date + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }))}</td><td>${d.sessions}</td><td>${d.calls}</td><td>${d.messages}</td><td>${fmt(d.output)}</td></tr>`).join('')}</table>` : ''}
    ${s?.tools?.length ? `<h2>Outils les plus utilisés</h2><p>${s.tools.map(([n, c]) => `${esc(n)} (${c})`).join(' · ')}</p>` : ''}`;
  $('report').classList.add('open');
  if (document.pointerLockElement) document.exitPointerLock();
}
$('report-close').onclick = () => $('report').classList.remove('open');
$('report-print').onclick = () => window.print();

// distributeur du couloir
const SNACKS = ['🍫 Un Twix tombe… et reste coincé.', '🥤 Un Coca bien frais. Santé !', '🍪 Des cookies. Les agents n’en veulent pas, ils préfèrent les tokens.', '🪙 « Monnaie insuffisante ». Classique.', '🥨 Des bretzels. Parfait pour une longue session.'];
function buySnack() { sfx('thunk'); toast(SNACKS[Math.floor(Math.random() * SNACKS.length)]); }

// s'asseoir sur le futon ou un fauteuil
let seated = null;
function sitDown() {
  const p = camera.position;
  const free = LOUNGE.filter((s) => s.pose === 'sit' && !s.taken).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
  if (!free || Math.hypot(free.x - p.x, free.z - p.z) > 4) { toast('Plus de place : les agents ont tout pris 😅'); return; }
  free.taken = 'toi'; seated = { spot: free, prev: p.clone() };
  const to = new THREE.Vector3(free.x, 1.15, free.z);
  const look = new THREE.Vector3(free.x - Math.sin(free.yaw) * 3, 1.05, free.z - Math.cos(free.yaw) * 3);
  flyTo(to, look, 70, 0.8, () => { yaw = free.yaw; pitch = -0.04; camera.rotation.set(pitch, yaw, 0); });
  toast('Tu es assis. Avance (Z / W) pour te relever.');
}
function sitAtDesk(desk) {
  if (desk.agent) { toast('Ce poste est à un agent 🙂'); return; }
  const p = camera.position, sy = desk.rot;
  seated = { spot: null, prev: p.clone() };
  const to = new THREE.Vector3(desk.seat.x, 1.2, desk.seat.z);
  flyTo(to, desk.screen.getWorldPosition(new THREE.Vector3()), 70, 0.8, () => { yaw = sy; pitch = -0.12; camera.rotation.set(pitch, yaw, 0); });
  toast('Tu es à un poste libre. Avance (Z / W) pour te relever.');
}
function standUp() {
  if (!seated) return;
  if (seated.spot?.taken === 'toi') seated.spot.taken = null;
  camera.position.copy(seated.prev); seated = null;
}

// regarder un écran ou le tableau de près
function focusOn(mesh, dist) {
  mesh.updateMatrixWorld(true);
  const c = mesh.getWorldPosition(new THREE.Vector3());
  const n = new THREE.Vector3(0, 0, 1).applyQuaternion(mesh.getWorldQuaternion(new THREE.Quaternion()));
  setMode('focus', { pos: c.clone().addScaledVector(n, dist), target: c });
}
interact(statsScreen, { label: () => 'Regarder le grand écran', act: () => focusOn(statsScreen, 2.1), range: 6 }, true);
interact(boardMesh, { label: () => 'Lire le tableau des tâches', act: () => focusOn(boardMesh, 1.9), range: 6 }, true);


// =====================================================================
// Mini-carte
// =====================================================================
const mm = $('minimap'), mctx = mm.getContext('2d');
let mmScale = 1, mmOx = 0, mmOy = 0;
function drawMinimap() {
  const W = mm.width, Hh = mm.height, S = ROOM_S, SH = S + 0.4 + CORW; // la pièce + le couloir
  mmScale = Math.min((W - 24) / S, (Hh - 24) / SH);
  mmOx = (W - S * mmScale) / 2 - shellX0 * mmScale; mmOy = (Hh - SH * mmScale) / 2 - ZN * mmScale;
  const X = (x) => mmOx + x * mmScale, Y = (z) => mmOy + z * mmScale;
  const rect = (x0, z0, x1, z1) => mctx.fillRect(X(Math.min(x0, x1)), Y(Math.min(z0, z1)), Math.abs(x1 - x0) * mmScale, Math.abs(z1 - z0) * mmScale);
  const E = XE, N = ZN, SZ = shellZ1;
  mctx.clearRect(0, 0, W, Hh);
  mctx.fillStyle = '#2b2d30'; rect(shellX0, N, E, SZ);
  mctx.fillStyle = '#55585c'; rect(shellX0, SZ + 0.2, E, SZ + 0.2 + CORW); // couloir
  mctx.fillStyle = doorIsOpen() ? '#55585c' : '#6b5a50'; rect(shellX0 + 1.2, SZ - 0.05, shellX0 + 2.1, SZ + 0.25);
  mctx.fillStyle = '#b3202a'; rect(shellX0 + 4.75, SZ + 0.2 + CORW - 0.8, shellX0 + 5.65, SZ + 0.2 + CORW - 0.1);
  mctx.fillStyle = '#8fb8dc'; rect(shellX0, N - 0.3, E, N); // fenêtres
  mctx.fillStyle = '#b98a52'; rect(shellX0 + 0.05, N, E - 3.3, N + 0.8); rect(shellX0, N + 0.85, shellX0 + 0.8, SZ - 2.2);
  if (layoutUsesSouth) rect(shellX0 + 3.5, SZ - 0.8, E - 4.5, SZ);
  for (const r of rooms) {
    const { rot, at } = SIDES[r.side], back = { x: Math.sin(rot), z: Math.cos(rot) };
    const p0 = at(r.a0), p1 = at(r.a1);
    mctx.fillStyle = `#${r.color.getHexString()}88`;
    rect(p0.x + back.x * 0.5, p0.z + back.z * 0.5, p1.x + back.x * 1.6, p1.z + back.z * 1.6);
    mctx.fillStyle = '#d9d2c9'; mctx.font = '600 13px -apple-system, sans-serif';
    const c = at((r.a0 + r.a1) / 2);
    mctx.save(); mctx.translate(X(c.x + back.x * 2.1), Y(c.z + back.z * 2.1)); if (r.side === 'W') mctx.rotate(-Math.PI / 2);
    mctx.textAlign = 'center'; mctx.fillText(fitText(mctx, r.name, Math.abs(r.a1 - r.a0) * mmScale), 0, 4); mctx.restore();
  }
  // salon, cuisine, pilier, bibliothèque, porte
  mctx.fillStyle = '#8f9294'; rect(E - 1.1, N + 3.0, E, N + 5.2);
  mctx.fillStyle = '#2f7a45'; rect(E - 3.75, N + 2.6, E - 2.85, N + 3.5); rect(E - 3.55, N + 4.9, E - 2.65, N + 5.8);
  mctx.fillStyle = '#a3a6a9'; rect(E - 0.6, SZ - 3.7, E, SZ - 0.8);
  mctx.fillStyle = '#eee'; rect(E - 2.52, SZ - 2.62, E - 2.08, SZ - 2.18);
  mctx.fillStyle = '#111'; rect(E - 3.25, SZ - 0.4, E - 0.55, SZ);
  for (const d of desks) {
    if (!d.agent || !d.agent.group.visible) continue;
    d.agent.group.getWorldPosition(v1);
    mctx.fillStyle = STATUS[d.data.status].color; mctx.beginPath(); mctx.arc(X(v1.x), Y(v1.z), 4.5, 0, 7); mctx.fill();
    if (mode !== 'walk' && followId === idOfDesk(d)) { mctx.strokeStyle = '#fff'; mctx.lineWidth = 2; mctx.stroke(); }
  }
  const p = camera.position; const cy = mode === 'walk' ? yaw : Math.atan2(-(lookCur.x - p.x), -(lookCur.z - p.z));
  mctx.save(); mctx.translate(X(clamp(p.x, shellX0, E)), Y(clamp(p.z, N, SZ + 0.2 + CORW))); mctx.rotate(-cy);
  mctx.fillStyle = '#f4efe8'; mctx.beginPath(); mctx.moveTo(0, -9); mctx.lineTo(6, 6); mctx.lineTo(0, 3); mctx.lineTo(-6, 6); mctx.closePath(); mctx.fill();
  mctx.restore();
}
const idOfDesk = (desk) => { for (const [id, d] of assign) if (d === desk) return id; return null; };
mm.addEventListener('click', (e) => {
  const r = mm.getBoundingClientRect();
  const x = ((e.clientX - r.left) * (mm.width / r.width) - mmOx) / mmScale, z = ((e.clientY - r.top) * (mm.height / r.height) - mmOy) / mmScale;
  // un agent sous le clic ? sinon on y marche
  for (const d of desks) {
    if (!d.agent || !d.agent.group.visible) continue;
    d.agent.group.getWorldPosition(v1);
    if (Math.hypot(v1.x - x, v1.z - z) < 0.8) { const id = idOfDesk(d); goTo(id); openPanel(id); return; }
  }
  backToOffice();
  if (collides(x, z)) return;
  walkPose.pos.set(x, 1.65, z);
  if (mode === 'walk') flyTo(walkPose.pos, lookFromYawPitch(walkPose.pos, yaw, pitch), 70, 0.8, () => camera.rotation.set(pitch, yaw, 0));
  else setMode('walk');
});

// =====================================================================
// Animation
// =====================================================================
const clock = new THREE.Clock();
let lastBlink = 0, blinkOn = true, lastIdleDraw = 0, lastMap = 0;
function activity(d) {
  if (d.status !== 'working') return d.status;
  if (d.phase === 'thinking') return 'think';
  const t = d.current?.tool || '';
  if (t === 'Read' || t === 'NotebookRead') return 'read';
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(t)) return 'edit';
  if (t === 'Bash') return 'bash';
  if (t === 'Grep' || t === 'Glob') return 'search';
  if (t === 'WebFetch' || t === 'WebSearch' || /browser|navigate|chrome|fetch|web/i.test(t)) return 'web';
  return 'type';
}

function animateAgent(desk, dt, t) {
  const ag = desk.agent, d = desk.data;
  const ph = t + ag.phase, st = d.status;
  const visible = isVisible(d);
  ag.group.visible = visible;
  desk.ring.visible = visible;
  const targetRot = st === 'waiting' && ag.place === 'desk' ? 2.4 : 0;
  desk.chair.rotation.y += (targetRot - desk.chair.rotation.y) * damp(3, dt);
  updateMotion(desk, dt);
  syncRobots(desk, d.subagents, visible);
  updateRobots(desk, dt, t);
  // nuage d'orage si la dernière commande a échoué
  const storm = desk.storm; storm.visible = visible && !!d.error && st === 'working';
  if (storm.visible) {
    storm.position.y = 2.05 + Math.sin(t * 1.3) * 0.03;
    storm.userData.drops.forEach((dr) => { const k = (t * 1.6 + dr.userData.phase) % 1; dr.position.y = -0.18 - k * 0.5; });
    const flash = Math.sin(t * 7.3 + desk.pos.x) > 0.97;
    storm.userData.bolt.visible = flash; storm.userData.cloudM.emissiveIntensity = flash ? 0.5 : 0;
  }
  if (!visible) return;

  const away = ag.place !== 'desk';
  const arrived = away && !ag.transit && ag.dir > 0 && ag.u >= ag.route.len && ag.walk < 0.1;
  const lounging = arrived && ag.sit > 0.9;
  const standing = arrived && ag.spot.pose !== 'sit';
  const celebrating = ag.celebrateUntil > t && !away;
  const act = activity(d);
  // jambes
  ag.legs.forEach(({ hip, knee }, i) => {
    const w = Math.sin(ag.walkPh + i * Math.PI) * ag.walk * (1 - ag.sit);
    hip.rotation.x = (ag.sit * Math.PI) / 2 + w * 0.55;
    knee.rotation.x = (-ag.sit * Math.PI) / 2 - Math.max(0, -w) * 0.9;
  });
  const [L, R] = ag.arms;
  let bookOn = false, loupeOn = false, cupOn = false, antenna = 0;
  ag.torso.position.y = 0.97;
  if (away && !lounging && !standing) { // en marche
    const w = Math.sin(ag.walkPh) * 0.5 * ag.walk;
    L.rotation.set(-w, 0, 0.1); R.rotation.set(w, 0, -0.1);
    ag.headPivot.rotation.set(0, 0, 0);
    ag.torso.position.y = 0.97 + Math.abs(Math.sin(ag.walkPh)) * 0.03 * ag.walk;
  } else if (lounging) {
    L.rotation.set(0.35, 0, 0.35); R.rotation.set(0.35, 0, -0.35);
    ag.headPivot.rotation.set(0.12 + Math.sin(ph * 1.1) * 0.04, 0, 0.35);
    ag.torso.position.y = 0.97 + Math.sin(ph * 1.1) * 0.012;
  } else if (standing && ag.spot.pose === 'coffee') {
    cupOn = true;
    L.rotation.set(0.1, 0, 0.1); R.rotation.set(1.35 + Math.max(0, Math.sin(ph * 0.8)) * 0.6, 0, 0.35);
    ag.headPivot.rotation.set(0.05, Math.sin(ph * 0.5) * 0.5, 0);
  } else if (standing && ag.spot.pose === 'window') {
    L.rotation.set(-0.35, 0, 0.18); R.rotation.set(-0.35, 0, -0.18); // mains dans le dos
    ag.headPivot.rotation.set(0.08, Math.sin(ph * 0.25) * 0.45, 0);
  } else if (standing && ag.spot.pose === 'print') {
    L.rotation.set(0.95 + Math.sin(ph * 2) * 0.1, 0, 0.1); R.rotation.set(0.95 + Math.sin(ph * 2 + 1) * 0.1, 0, -0.1); // il attend sa feuille
    ag.headPivot.rotation.set(-0.3, Math.sin(ph * 0.4) * 0.1, 0);
  } else if (standing) {
    bookOn = true;
    L.rotation.set(1.2, 0, -0.35); R.rotation.set(1.2, 0, 0.35);
    ag.headPivot.rotation.set(-0.3, Math.sin(ph * 0.3) * 0.15, 0);
  } else if (celebrating) {
    L.rotation.set(0, 0, -2.7 + Math.sin(ph * 10) * 0.25); R.rotation.set(0, 0, 2.7 + Math.sin(ph * 10 + 1) * 0.25);
    ag.headPivot.rotation.set(0.15, 0, Math.sin(ph * 6) * 0.15);
    ag.torso.position.y = 0.97 + Math.abs(Math.sin(ph * 8)) * 0.05;
  } else if (st === 'working') {
    const typing = (speed, amp) => {
      L.rotation.set(0.85 + Math.sin(ph * speed) * amp, 0, 0.12); R.rotation.set(0.85 + Math.sin(ph * speed + 2) * amp, 0, -0.12);
    };
    ag.torso.position.y = 0.97 + Math.sin(ph * 9) * 0.006;
    if (act === 'read') {
      bookOn = true;
      L.rotation.set(1.2, 0, -0.35); R.rotation.set(1.2, 0, 0.35);
      ag.headPivot.rotation.set(-0.3, 0, 0);
    } else if (act === 'search') {
      loupeOn = true;
      L.rotation.set(0.85 + Math.sin(ph * 6) * 0.05, 0, 0.12); R.rotation.set(1.45, 0, -0.1 + Math.sin(ph * 1.5) * 0.25);
      ag.headPivot.rotation.set(-0.12, Math.sin(ph * 1.5) * 0.15, 0);
    } else if (act === 'bash') {
      typing(10, 0.07);
      ag.headPivot.rotation.set(-0.05, -0.6 + Math.sin(ph * 0.8) * 0.05, 0);
    } else if (act === 'edit') {
      typing(26, 0.12);
      ag.headPivot.rotation.set(-0.1 + Math.sin(ph * 13) * 0.02, Math.sin(ph * 0.7) * 0.08, 0);
    } else if (act === 'think') {
      L.rotation.set(0.5, 0, 0.12); R.rotation.set(2.35, 0, -0.55);
      ag.headPivot.rotation.set(0.1, 0.15, 0.12 + Math.sin(ph * 0.8) * 0.05);
    } else {
      typing(18, 0.08);
      ag.headPivot.rotation.set(-0.08 + Math.sin(ph * 2) * 0.03, Math.sin(ph * 0.7) * 0.12, 0);
      if (act === 'web') antenna = 0.5 + Math.sin(ph * 12) * 0.5;
    }
  } else if (st === 'waiting') {
    L.rotation.set(0.3, 0, 0.15); R.rotation.set(0, 0, 2.5 + Math.sin(ph * 5) * 0.3);
    ag.headPivot.rotation.set(0.05, Math.sin(ph * 1.3) * 0.25, Math.sin(ph * 2.6) * 0.06);
  } else {
    L.rotation.set(0.5, 0, 0.12); R.rotation.set(0.5, 0, -0.12);
    ag.headPivot.rotation.set(-0.42 + Math.sin(ph * 1.2) * 0.04, 0, 0.12);
    ag.torso.position.y = 0.97 + Math.sin(ph * 1.2) * 0.012;
  }
  ag.book.visible = bookOn; ag.loupe.visible = loupeOn; ag.cup.visible = cupOn && !ag.rodTip;
  if (ag.rodTip) {
    ag.group.updateMatrixWorld(true);
    const tip = ag.rodTip.getWorldPosition(v2);
    const drop = v3.set(tip.x + Math.sin(ph * 1.7) * 0.05, Math.max(0.05, tip.y - 0.55 - Math.sin(ph * 2.3) * 0.04), tip.z + Math.cos(ph * 1.3) * 0.05);
    ag.group.worldToLocal(tip); ag.group.worldToLocal(drop);
    ag.lure.position.copy(drop); ag.lure.rotation.z = Math.sin(ph * 2) * 0.3;
    const pos = ag.line.geometry.attributes.position;
    pos.setXYZ(0, tip.x, tip.y, tip.z); pos.setXYZ(1, drop.x, drop.y + 0.05, drop.z); pos.needsUpdate = true;
  }
  if (bookOn) ag.pagePivot.rotation.y = -((ph * 0.7) % 1) * Math.PI;
  ag.antennaM.emissiveIntensity = antenna * 2.5;
  const sleeping = st === 'idle' && (!away || lounging);
  const closed = sleeping || Math.sin(ph * 0.9) > 0.985;
  ag.eyes.forEach((e) => (e.scale.y = closed ? 0.15 : 1));
  ag.bubble.visible = st === 'waiting' && !away && !celebrating;
  if (ag.bubble.visible) ag.bubble.position.y = 1.95 + Math.sin(ph * 3) * 0.04;
  ag.thoughtSprite.visible = (act === 'think' && !away) || (ag.sayUntil || 0) > t;
  if (ag.thoughtSprite.visible) ag.thoughtSprite.position.y = 1.95 + Math.sin(ph * 1.5) * 0.03;
  ag.zs.forEach((z) => {
    z.visible = sleeping;
    if (!sleeping) return;
    const k = (t * 0.35 + z.userData.phase) % 1;
    z.position.set(-0.1 + k * 0.4, 1.85 + k * 0.55, -0.1); z.material.opacity = Math.sin(k * Math.PI); z.scale.setScalar(0.15 + k * 0.2);
  });
  const dist = camera.position.distanceTo(ag.group.getWorldPosition(v1));
  const far = away ? 1.5 - dist / 5 : 1.6 - dist / 16; // au salon, on ne les lit que de près
  const inside = camera.position.z < shellZ1; // dans le couloir, pas d'étiquettes à travers les murs
  ag.label.material.opacity = mode === 'overview' || mode === 'iso' ? 1 : inside ? clamp(Math.min(far, (dist - 1.2) / 1.5), 0, 1) : 0;
  desk.ring.material.opacity = st === 'working' ? 0.55 + Math.sin(ph * 4) * 0.3 : 0.75;
}

function animate() {
  const dt = Math.min(clock.getDelta(), 0.05); const t = clock.elapsedTime;
  if (!stepTween(dt)) {
    if (mode === 'walk') move(dt);
    else if (mode === 'overview' || mode === 'iso') orbit.update();
    else if (mode !== 'debug' && mode !== 'focus') updateFollowCam(dt);
  }
  tourTick(t);
  if (timeLapse || t - lastTimeApply > 30) { applyTime(currentHour()); lastTimeApply = t; }
  if (t - lastBlink > 0.5) { lastBlink = t; blinkOn = !blinkOn; }
  const redrawIdle = t - lastIdleDraw > 0.1; if (redrawIdle) lastIdleDraw = t;
  for (const desk of desks) {
    if (!desk.agent) continue;
    animateAgent(desk, dt, t);
    const st = desk.data.status;
    if (st === 'working' && t - lastBlink < dt) drawScreen(desk, blinkOn);
    if (st === 'idle' && redrawIdle && desk.group.visible) drawScreen(desk);
  }
  updateConfetti(dt);
  updatePrecip(dt, t);
  updateDoor(dt); updateLift(t, dt); updateHall(dt); updateSteam(t); updatePrinter(t); updateAmbience(t); chatTick(t);
  hemi.intensity = (hemi.userData.base ?? hemi.intensity) + (t < flashUntil ? 2.5 : 0);
  updateAim();
  if (t - lastMap > 0.1) { drawMinimap(); lastMap = t; }
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight);
});

// =====================================================================
// Mode démo
// =====================================================================
let demoState = null;
function demoData() {
  const now = Date.now();
  const verbs = [['Read', 'Lit', 'App.tsx'], ['Edit', 'Modifie', 'server.js'], ['Bash', 'Terminal', 'npm test'], ['Grep', 'Cherche', 'useEffect'],
    ['Write', 'Écrit', 'README.md'], ['WebFetch', 'Web', 'docs.anthropic.com'], ['Agent', 'Délègue', 'Explorer le code'], ['Bash', 'Terminal', 'git status']];
  if (!demoState) {
    demoState = [
      ['Refonte du site vitrine', 'Atelier', 'working'], ['Migration base de données', 'Backend', 'working'],
      ['Corriger le bug de login', 'Appli mobile', 'waiting'], ['Écrire les tests e2e', 'Backend', 'working'],
      ['Audit SEO', 'Atelier', 'idle'], ['Script de déploiement', 'Infra', 'waiting'], ['Traduction EN', 'Atelier', 'idle'],
      ['Nouveau tableau de bord', 'Dashboard', 'working'], ['Optimiser les images', 'Appli mobile', 'idle'],
    ].map(([title, project, status], i) => ({
      id: 'demo' + i, title, project, status, cwd: '~/Dev/' + project, branch: 'main', model: 'claude-opus-5-5', entrypoint: 'cli',
      actions: [], lastText: "C'est fait ! J'ai appliqué les changements et tout passe. Tu veux que je pousse la branche ?",
      lastPrompt: "Peux-tu t'occuper de " + title.toLowerCase() + ' ?', subagents: i === 1 ? 2 : 0, workload: i * 60,
      todos: i % 2 ? [] : [{ text: 'Analyser le code existant', status: 'completed' }, { text: 'Implémenter la fonctionnalité', active: 'Implémentation en cours', status: 'in_progress' }, { text: 'Écrire les tests', status: 'pending' }],
    }));
  }
  for (const a of demoState) {
    if (Math.random() < 0.04) a.status = ['working', 'waiting', 'idle'][Math.floor(Math.random() * 3)];
    a.phase = a.status === 'working' ? (Math.random() < 0.2 ? 'thinking' : 'tool') : null;
    if (a.status === 'working' && Math.random() < 0.6) {
      const [tool, verb, detail] = verbs[Math.floor(Math.random() * verbs.length)];
      a.actions = [...a.actions, { ts: new Date().toISOString(), tool, verb, detail }].slice(-14);
      a.lastActivity = new Date().toISOString();
    }
    a.error = a.status === 'working' && Math.random() < 0.05 ? { ts: new Date().toISOString(), verb: 'Terminal', text: 'npm test: 2 tests en échec' } : a.error && Math.random() < 0.7 ? a.error : null;
    a.lastActivity ||= new Date(now - 600000).toISOString();
    a.current = a.status === 'working' ? a.actions.at(-1) || { verb: 'Réfléchit', detail: '' } : null;
  }
  return { agents: structuredClone(demoState), stats: { ready: true, tokens: { input: 12000, output: 845000, cacheRead: 32e6, cacheWrite: 1.2e6 }, messages: 412, sessions: 9,
    hours: [0, 0, 0, 0, 0, 0, 0, 0, 40, 120, 180, 90, 20, 60, 210, 260, 150, 80, 30, 0, 0, 0, 0, 0], tools: [['Bash', 320], ['Read', 210], ['Edit', 140], ['Grep', 60], ['Write', 25]],
    files: [['Atelier · index.html', 22], ['Backend · schema.sql', 14], ['Dashboard · App.tsx', 9]],
    projects: Object.fromEntries([...new Set(demoState.map((a) => a.project))].map((p, i) => [p, {
      tokens: { input: 2000, output: 90000 + i * 70000, cacheRead: 4e6 + i * 2e6, cacheWrite: 1e5 }, messages: 40 + i * 30, sessions: 1 + (i % 3),
      calls: 80 + i * 55, hours: Array.from({ length: 24 }, (_, h) => (h > 8 && h < 19 ? Math.round(Math.abs(Math.sin(h * (i + 1))) * 30) : 0)),
      tools: [['Bash', 40 + i * 10], ['Read', 30], ['Edit', 12 + i]], files: [['index.html', 9], ['app.css', 4]],
    }])) } };
}

applyTime(currentHour());
drawMeet();
poll();
setInterval(poll, 3000);
loadLongHistory(); setInterval(loadLongHistory, 5 * 60 * 1000);
animate();
// Outils de débogage : ?debug expose l'état dans la console
if (params.has('debug')) window.bureau = { camera, scene, setMode, flyTo, goTo, desks: () => desks, agents: () => agentsData, room: () => ({ x0: shellX0, z1: shellZ1, S: ROOM_S }), actions: () => [...interactables, ...staticInteract].map((e, i) => i + ' ' + e.label()), act: (i) => [...interactables, ...staticInteract][i].act(), look: (x, y, z, tx, ty, tz) => flyTo(new THREE.Vector3(x, y, z), new THREE.Vector3(tx, ty, tz), 70, 0.01, () => { mode = 'debug'; }) };
