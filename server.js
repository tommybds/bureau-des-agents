#!/usr/bin/env node
// Bureau 3D des agents Claude — serveur local sans dépendance.
// Lit les transcripts de ~/.claude/projects et les expose sur /api/agents.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 4317;
const LAN = process.env.LAN === '1'; // accès depuis le téléphone sur le wifi (désactivé par défaut)
const HOST = LAN ? '0.0.0.0' : '127.0.0.1';
const PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
// sessions Cowork de l'app Claude : même format, rangées session par session dans le dossier de l'app
const APP_DIR = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : process.platform === 'win32' ? process.env.APPDATA || '' : path.join(os.homedir(), '.config');
const COWORK_DIR = process.env.COWORK === 'off' ? null : process.env.COWORK_DIR || path.join(APP_DIR, 'Claude', 'local-agent-mode-sessions');
const WINDOW_HOURS = Number(process.env.WINDOW_HOURS) || 12; // sessions actives dans les N dernières heures
const MAX_AGENTS = 40;
const TAIL_BYTES = 400 * 1024;
const TOKEN = crypto.randomBytes(16).toString('hex'); // protège /api/resume des autres sites
const ALLOWED_HOSTS = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];

// Météo en direct (Open-Meteo, gratuit, sans clé) : WEATHER=off pour couper
// Réglages facultatifs : config.json (voir config.example.json). Sans ce fichier, le bureau est neutre et sans météo.
let config = {};
try { config = JSON.parse(fs.readFileSync(process.env.CONFIG_FILE || path.join(__dirname, 'config.json'), 'utf8')); } catch (err) {
  if (err.code !== 'ENOENT') console.warn('  ⚠️  config.json illisible :', err.message);
}
const lieu = config.lieu || {};
const num = (...v) => v.map(Number).find((x) => Number.isFinite(x) && x !== 0);
const PLACE = { name: process.env.WEATHER_PLACE || lieu.nom || '', lat: num(process.env.WEATHER_LAT, lieu.latitude), lon: num(process.env.WEATHER_LON, lieu.longitude) };
const HAS_PLACE = Number.isFinite(PLACE.lat) && Number.isFinite(PLACE.lon);
const clientConfig = { // ce que la page a besoin de connaître
  decor: config.decor === 'mon-bureau' ? 'mon-bureau' : 'neutre',
  costumes: config.costumes && typeof config.costumes === 'object' ? config.costumes : {},
  fenetres: ['est', 'sud', 'ouest', 'nord'].includes(lieu.fenetres) ? lieu.fenetres : 'sud',
};
// "batiment": { "etage": 4, "etages": 5 } : notre étage et le nombre d'étages au-dessus du rez-de-chaussée
const floorNum = (v, d) => (Number.isInteger(v) && v >= 0 && v <= 40 ? v : d);
clientConfig.etage = floorNum(config.batiment?.etage, 3);
clientConfig.etages = Math.max(clientConfig.etage, floorNum(config.batiment?.etages, clientConfig.etage));
let weather = null;
async function fetchWeather() {
  if (process.env.WEATHER === 'off' || !HAS_PLACE) return; // pas de lieu configuré : pas de météo
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${PLACE.lat}&longitude=${PLACE.lon}`
    + '&current=temperature_2m,weather_code,cloud_cover,precipitation,wind_speed_10m,is_day'
    + '&daily=sunrise,sunset&timezone=auto&forecast_days=1';
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const c = j.current || {};
    weather = {
      place: PLACE.name, temp: c.temperature_2m, code: c.weather_code, cloud: c.cloud_cover, precip: c.precipitation,
      wind: c.wind_speed_10m, isDay: c.is_day, sunrise: j.daily?.sunrise?.[0], sunset: j.daily?.sunset?.[0], at: c.time,
    };
  } catch (err) {
    console.warn('  ⚠️  météo indisponible :', err.message);
  }
}

// Coût estimé au tarif public de l'API (dollars par million de tokens). Un abonnement Claude ne facture pas ainsi.
// Lecture de cache ≈ 1/10 du prix d'entrée (sauf tarif publié), écriture de cache ≈ 1,25 ×.
const PRICES = [
  ['claude-fable-5-1', { in: 10, out: 50, read: 0.25 }], ['claude-mythos-5-1', { in: 10, out: 50, read: 0.25 }],
  ['claude-fable-5', { in: 10, out: 50 }], ['claude-mythos-5', { in: 10, out: 50 }],
  ['claude-opus-5-5', { in: 4, out: 20, read: 0.2 }],
  ['claude-opus-5', { in: 5, out: 25 }], ['claude-opus-4', { in: 5, out: 25 }],
  ['claude-sonnet-5-5', { in: 2, out: 10, read: 0.2 }], ['claude-sonnet-5', { in: 2, out: 10 }],
  ['claude-sonnet-4', { in: 3, out: 15 }], ['claude-haiku-4-5', { in: 1, out: 5 }],
];
const DEFAULT_PRICE = { in: 4, out: 20, read: 0.2 }; // modèle inconnu : tarif Opus 5.5
// config.json peut corriger ou compléter les tarifs : "tarifs": { "claude-opus-5-5": { "in": 4, "out": 20, "read": 0.2 } }
for (const [id, p] of Object.entries(config.tarifs || {})) if (p && Number.isFinite(p.in) && Number.isFinite(p.out)) PRICES.unshift([id, p]);
function priceFor(model) {
  const p = PRICES.find(([id]) => String(model || '').startsWith(id))?.[1] || DEFAULT_PRICE;
  return { in: p.in, out: p.out, read: p.read ?? p.in * 0.1, write: p.in * 1.25 };
}
// Conversion en euros : taux BCE du jour (frankfurter.app), sinon EUR_PER_USD, sinon 0,92 par défaut
let fx = { eurPerUsd: Number(process.env.EUR_PER_USD) || 0.92, live: false };
async function fetchFx() {
  if (process.env.EUR_PER_USD || process.env.WEATHER === 'off') return;
  try {
    const r = await fetch('https://api.frankfurter.app/latest?from=USD&to=EUR', { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    if (j?.rates?.EUR > 0) fx = { eurPerUsd: j.rates.EUR, live: true, date: j.date };
  } catch { /* on garde le taux par défaut */ }
}

const clip = (s, n) => {
  if (!s) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

// ---------------------------------------------------------------------------
// Lecture incrémentale de tous les transcripts récents : stats du jour + tâches
// ---------------------------------------------------------------------------
const scanState = new Map(); // fichier -> { offset, rest, seen, tasks, taskSeq, todos, todoMode }
const days = new Map();      // 'YYYY-MM-DD' -> stats
let scanReady = false;
let scanning = false;

const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const newBucket = () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, messages: 0, cost: 0, activeMs: 0, tools: {}, files: {}, hours: Array(24).fill(0), sessions: new Set() });
const newDay = () => ({ ...newBucket(), projects: {} });
function dayStats(k) {
  let s = days.get(k);
  if (!s) { s = newDay(); days.set(k, s); }
  return s;
}

// Historique jour par jour, gardé dans data/stats-history.json.
// Les jours jusqu'à `through` sont définitifs ; hier et aujourd'hui sont recalculés à chaque démarrage.
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS) || 14; // affichés sur les écrans
const BACKFILL_DAYS = Number(process.env.HISTORY_BACKFILL) || 400; // reconstitués tant que les transcripts existent encore
const KEEP_DAYS = 800;                                        // conservés dans le fichier, même après suppression des transcripts
const HISTORY_VERSION = 2;                                    // v2 : coût et temps actif
const HISTORY_FILE = path.join(__dirname, 'data', 'stats-history.json');
let history = { v: HISTORY_VERSION, through: null, days: {} };
try {
  const saved = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  if (saved.v === HISTORY_VERSION) history = { through: null, days: {}, ...saved }; // sinon on reconstitue
} catch { /* premier lancement */ }
const dayStart = (daysAgo) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - daysAgo); return d.getTime(); };
const frozenThrough = history.through;
// Les jours archivés vont de `from` à `through`. On recalcule ce qui suit, et ce qui précède si on veut remonter plus loin.
const archivedFrom = frozenThrough ? history.from || Object.keys(history.days).sort()[0] || frozenThrough : null;
const wantFromKey = dayKey(dayStart(BACKFILL_DAYS - 1));
const needOlder = !frozenThrough || wantFromKey < archivedFrom;
const scanFrom = needOlder
  ? dayStart(BACKFILL_DAYS - 1)
  : Math.min(Date.parse(frozenThrough + 'T00:00:00') + 86400000, dayStart(1));
const scanFromKey = dayKey(scanFrom);
const counted = (k) => k >= scanFromKey && !(frozenThrough && k >= archivedFrom && k <= frozenThrough);
const SCRATCH = newDay(); // reçoit les lignes des jours qu'on ne compte pas

const topN = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
function summarize(d) {
  const calls = d.hours.reduce((a, b) => a + b, 0);
  return {
    tokens: d.tokens, messages: d.messages, calls, sessions: d.sessions.size, cost: d.cost, activeMs: d.activeMs, hours: d.hours, tools: topN(d.tools, 10), files: topN(d.files, 10),
    projects: Object.fromEntries(Object.entries(d.projects).map(([n, p]) => [n, { output: p.tokens.output, messages: p.messages, calls: p.hours.reduce((a, b) => a + b, 0), sessions: p.sessions.size, cost: p.cost, activeMs: p.activeMs }])),
  };
}
let lastSaved = '', lastSaveAt = 0;
function saveHistory() {
  if (!scanReady || Date.now() - lastSaveAt < 60000) return; // au plus une écriture par minute
  lastSaveAt = Date.now();
  const from = [archivedFrom, scanFromKey].filter(Boolean).sort()[0];
  const out = { v: HISTORY_VERSION, from, through: dayKey(dayStart(2)), days: {} };
  const keep = dayKey(dayStart(KEEP_DAYS));
  for (const [k, v] of Object.entries(history.days)) if (k >= keep) out.days[k] = v;
  for (const [k, d] of days) out.days[k] = summarize(d);
  const txt = JSON.stringify(out);
  if (txt === lastSaved) return;
  try { fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true }); fs.writeFileSync(HISTORY_FILE, txt); lastSaved = txt; } catch (err) { console.warn('historique', err.message); }
}
// tokens générés par projet et par jour, sur la même période
function projectHistory() {
  const out = {};
  for (let i = HISTORY_DAYS - 1, col = 0; i >= 0; i--, col++) {
    const k = dayKey(dayStart(i));
    const d = days.has(k) ? summarize(days.get(k)) : history.days[k];
    for (const [name, p] of Object.entries(d?.projects || {})) (out[name] ||= Array(HISTORY_DAYS).fill(0))[col] = p.output || 0;
  }
  return out;
}
function historyList(n = HISTORY_DAYS, withProjects = false) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const k = dayKey(dayStart(i));
    const d = days.has(k) ? summarize(days.get(k)) : history.days[k];
    const row = { date: k, output: d?.tokens.output || 0, input: (d?.tokens.input || 0) + (d?.tokens.cacheWrite || 0), cacheRead: d?.tokens.cacheRead || 0, messages: d?.messages || 0, calls: d?.calls || 0, sessions: d?.sessions || 0, cost: d?.cost || 0, activeMs: d?.activeMs || 0 };
    if (withProjects) row.projects = d?.projects || {};
    out.push(row);
  }
  return out;
}
// Frise du jour : périodes de travail de chaque session (suite de réponses espacées de moins de 5 min)
function timelineToday() {
  const k = dayKey(Date.now()), out = [];
  for (const st of scanState.values()) {
    const w = st.work?.[k];
    if (!w?.length || st.meta?.sub) continue;
    out.push({ id: st.meta.sessionId, project: st.meta.project, title: lastAgents.get(st.meta.sessionId)?.title || null, intervals: w });
  }
  return out.sort((a, b) => a.intervals[0][0] - b.intervals[0][0]);
}
const toolLabel = (name) => (name.startsWith('mcp__') ? name.split('__').at(-1) : name);

function processLine(st, line, meta) {
  if (!line.includes('"type":"assistant"')) return; // filtre rapide avant JSON.parse
  let e;
  try { e = JSON.parse(line); } catch { return; }
  if (e.type !== 'assistant' || !e.message || !e.timestamp) return;
  const msg = e.message;
  const dk0 = dayKey(e.timestamp);
  const s = counted(dk0) ? dayStats(dk0) : SCRATCH; // les jours déjà archivés ou trop anciens ne sont pas recomptés
  s.sessions.add(meta.sessionId);
  const ps = (s.projects[meta.project] ||= newBucket());
  ps.sessions.add(meta.sessionId);
  const price = priceFor(msg.model);
  const hasTool = (msg.content || []).some((c) => c.type === 'tool_use');
  if (!meta.sub && !e.isSidechain) { // temps de travail : réponses espacées de moins de 5 minutes
    const ts = Date.parse(e.timestamp), gap = ts - st.lastTs;
    const list = (st.work[dk0] ||= []), last = list.at(-1);
    if (last && gap >= 0 && gap <= 5 * 60000) {
      last[1] = ts; last[2] = hasTool ? 0 : 1; // 1 = fin de tour (il attend une réponse)
      s.activeMs += gap; ps.activeMs += gap;
    } else list.push([ts, ts, hasTool ? 0 : 1]);
    st.lastTs = ts;
  }
  const u = msg.usage;
  if (msg.id && u) {
    // une même réponse est répartie sur plusieurs lignes : on ne compte que l'écart
    const prev = st.seen.get(msg.id);
    if (!prev) {
      for (const x of [s, ps]) {
        x.messages++;
        x.tokens.input += u.input_tokens || 0;
        x.tokens.cacheRead += u.cache_read_input_tokens || 0;
        x.tokens.cacheWrite += u.cache_creation_input_tokens || 0;
        x.tokens.output += u.output_tokens || 0;
        x.cost += ((u.input_tokens || 0) * price.in + (u.cache_read_input_tokens || 0) * price.read + (u.cache_creation_input_tokens || 0) * price.write + (u.output_tokens || 0) * price.out) / 1e6;
      }
      st.seen.set(msg.id, u.output_tokens || 0);
    } else if ((u.output_tokens || 0) > prev) {
      s.tokens.output += u.output_tokens - prev;
      ps.tokens.output += u.output_tokens - prev;
      const more = ((u.output_tokens - prev) * price.out) / 1e6; s.cost += more; ps.cost += more;
      st.seen.set(msg.id, u.output_tokens);
    }
  }
  const hour = new Date(e.timestamp).getHours();
  for (const c of msg.content || []) {
    if (c.type !== 'tool_use') continue;
    const name = toolLabel(c.name);
    s.tools[name] = (s.tools[name] || 0) + 1;
    s.hours[hour]++;
    ps.tools[name] = (ps.tools[name] || 0) + 1;
    ps.hours[hour]++;
    const dk = dayKey(e.timestamp); st.calls[dk] = (st.calls[dk] || 0) + 1;
    if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(c.name)) {
      const fp = c.input?.file_path || c.input?.notebook_path;
      if (fp) {
        const k = `${meta.project} · ${path.basename(fp)}`; s.files[k] = (s.files[k] || 0) + 1;
        ps.files[path.basename(fp)] = (ps.files[path.basename(fp)] || 0) + 1;
      }
    }
    if (meta.sub || e.isSidechain) continue;
    const inp = c.input || {};
    if (c.name === 'TaskCreate') {
      st.tasks.set(String(++st.taskSeq), { text: inp.subject || '', active: inp.activeForm || '', status: 'pending' });
      st.todoMode = 'tasks';
    } else if (c.name === 'TaskUpdate' && inp.taskId) {
      const t = st.tasks.get(String(inp.taskId));
      if (t) {
        if (inp.status === 'deleted') st.tasks.delete(String(inp.taskId));
        else {
          if (inp.status) t.status = inp.status;
          if (inp.subject) t.text = inp.subject;
          if (inp.activeForm) t.active = inp.activeForm;
        }
      }
    } else if (c.name === 'TodoWrite' && Array.isArray(inp.todos)) {
      st.todos = inp.todos.map((t) => ({ text: t.content || '', active: t.activeForm || '', status: t.status || 'pending' }));
      st.todoMode = 'todowrite';
    }
  }
}

const CHUNK = 16 * 1024 * 1024;
async function scanFile(file, meta) {
  let st = scanState.get(file);
  let size;
  try { size = fs.statSync(file).size; } catch { return; }
  if (!st || size < st.offset) {
    st = { offset: 0, rest: Buffer.alloc(0), seen: new Map(), tasks: new Map(), taskSeq: 0, todos: [], todoMode: null, calls: {}, lastTs: 0, work: {}, meta };
    scanState.set(file, st);
  }
  if (st.offset >= size) return;
  const fd = fs.openSync(file, 'r');
  try {
    while (st.offset < size) {
      const len = Math.min(CHUNK, size - st.offset);
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, st.offset);
      st.offset += len;
      const data = st.rest.length ? Buffer.concat([st.rest, buf]) : buf;
      const nl = data.lastIndexOf(10);
      if (nl === -1) { st.rest = Buffer.from(data); continue; }
      st.rest = Buffer.from(data.subarray(nl + 1));
      for (const line of data.toString('utf8', 0, nl).split('\n')) processLine(st, line, meta);
      await new Promise(setImmediate); // ne bloque pas le serveur pendant le premier passage
    }
  } finally {
    fs.closeSync(fd);
  }
}

function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }

async function scanAll() {
  if (scanning) return;
  scanning = true;
  try {
    const cutoff = Math.min(scanFrom, Date.now() - WINDOW_HOURS * 3600 * 1000);
    for (const dir of projectDirs()) {
      for (const f of safeReaddir(dir)) {
        const fp = path.join(dir, f);
        if (f.endsWith('.jsonl')) {
          if (mtime(fp) >= cutoff) await scanFile(fp, { sessionId: f.slice(0, -6), project: headInfo(fp).project, sub: false });
        } else {
          const subDir = path.join(fp, 'subagents');
          for (const sf of safeReaddir(subDir)) {
            const sfp = path.join(subDir, sf);
            if (sf.endsWith('.jsonl') && mtime(sfp) >= scanFrom) {
              await scanFile(sfp, { sessionId: f, project: headInfo(path.join(dir, f + '.jsonl')).project, sub: true });
            }
          }
        }
      }
    }
    scanReady = true;
    saveHistory();
  } catch (err) {
    console.warn('scan', err.message);
  } finally {
    scanning = false;
  }
}
function safeReaddir(d) { try { return fs.readdirSync(d); } catch { return []; } }
// tous les dossiers de transcripts : ceux de Claude Code, puis ceux de chaque session Cowork
function projectDirs() {
  const out = safeReaddir(PROJECTS_DIR).map((d) => path.join(PROJECTS_DIR, d));
  if (COWORK_DIR) for (const a of safeReaddir(COWORK_DIR)) for (const b of safeReaddir(path.join(COWORK_DIR, a))) for (const s of safeReaddir(path.join(COWORK_DIR, a, b))) {
    if (!s.startsWith('local_') || s.endsWith('.json')) continue;
    const pd = path.join(COWORK_DIR, a, b, s, '.claude', 'projects');
    for (const d of safeReaddir(pd)) out.push(path.join(pd, d));
  }
  return out;
}
// fiche de la session Cowork (titre donné par l'app, dossiers choisis), à côté de son dossier
const coworkCache = new Map();
function coworkInfo(file) {
  if (!COWORK_DIR || !file.startsWith(COWORK_DIR)) return null;
  const i = file.indexOf(`${path.sep}.claude${path.sep}projects${path.sep}`);
  if (i < 0) return null;
  const meta = file.slice(0, i) + '.json', mt = mtime(meta), c = coworkCache.get(meta);
  if (c && c.mt === mt) return c.info;
  let info = { title: null, project: 'Cowork' };
  try {
    const o = JSON.parse(fs.readFileSync(meta, 'utf8'));
    const folder = (o.userSelectedFolders || []).map((f) => (typeof f === 'string' ? f : f?.path)).find(Boolean);
    info = { title: typeof o.title === 'string' ? o.title : null, project: folder ? path.basename(folder) : 'Cowork' };
  } catch { /* fiche absente : valeurs par défaut */ }
  coworkCache.set(meta, { mt, info });
  return info;
}
function mtime(f) { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }

function todayStats() {
  const s = days.get(dayKey(Date.now())) || dayStats(dayKey(Date.now()));
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
  return {
    ready: scanReady, tokens: s.tokens, messages: s.messages, sessions: s.sessions.size, cost: s.cost, activeMs: s.activeMs, fx,
    hours: s.hours, tools: top(s.tools, 7), files: top(s.files, 6), history: historyList(), projectHistory: projectHistory(), timeline: timelineToday(),
    projects: Object.fromEntries(Object.entries(s.projects).map(([name, p]) => [name, {
      tokens: p.tokens, messages: p.messages, sessions: p.sessions.size, calls: p.hours.reduce((a, b) => a + b, 0), cost: p.cost, activeMs: p.activeMs,
      hours: p.hours, tools: top(p.tools, 4), files: top(p.files, 3),
    }])),
  };
}

// ---------------------------------------------------------------------------
// Infos de début de session (projet d'origine, heure de départ)
// ---------------------------------------------------------------------------
const headCache = new Map();
function projectFromCwd(cwd) {
  if (!cwd) return null;
  if (cwd.includes('scratch-workspaces')) return 'Brouillons';
  const base = cwd.split('/.claude/worktrees/')[0].replace(/\/+$/, '');
  if (base === os.homedir()) return 'Accueil';
  return path.basename(base);
}
function headInfo(file) {
  const c = headCache.get(file);
  if (c) return c;
  const info = { cwd: null, start: null, project: null };
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(512 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const l of buf.toString('utf8', 0, n).split('\n')) {
      if (info.cwd && info.start) break;
      let e;
      try { e = JSON.parse(l); } catch { continue; }
      if (!info.cwd && e.cwd) info.cwd = e.cwd;
      if (!info.start && e.timestamp && (e.type === 'user' || e.type === 'assistant')) info.start = e.timestamp;
    }
  } catch { /* ignore */ }
  info.project = coworkInfo(file)?.project || projectFromCwd(info.cwd) || path.basename(path.dirname(file)).replace(/^-Users-[^-]+-/, '');
  if (info.cwd) headCache.set(file, info); // on réessaiera si le début n'est pas encore écrit
  return info;
}

// ---------------------------------------------------------------------------
// État de chaque agent (fin du transcript)
// ---------------------------------------------------------------------------
const titleCache = new Map();

function readTail(file, size) {
  const start = Math.max(0, size - TAIL_BYTES);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let lines = buf.toString('utf8').split('\n');
    if (start > 0) lines = lines.slice(1);
    const out = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      try { out.push(JSON.parse(l)); } catch { /* ligne partielle */ }
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

function findTitle(file, size, tailEntries) {
  for (let i = tailEntries.length - 1; i >= 0; i--) {
    const e = tailEntries[i];
    if (e.type === 'custom-title' && e.customTitle) return e.customTitle;
    if (e.type === 'agent-name' && e.agentName) return e.agentName;
    if (e.type === 'summary' && e.summary) return e.summary;
  }
  const cw = coworkInfo(file);
  if (cw?.title) return cw.title;
  for (let i = tailEntries.length - 1; i >= 0; i--) if (tailEntries[i].type === 'ai-title' && tailEntries[i].aiTitle) return tailEntries[i].aiTitle;
  const cached = titleCache.get(file);
  if (cached && cached.size === size) return cached.title;
  let title = null;
  if (size < 60 * 1024 * 1024) {
    const txt = fs.readFileSync(file, 'utf8');
    const re = /"(?:customTitle|agentName)":"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = re.exec(txt))) title = JSON.parse(`"${m[1]}"`);
  }
  titleCache.set(file, { size, title });
  return title;
}

function describeTool(name, input = {}) {
  const base = (p) => (p ? path.basename(String(p)) : '');
  switch (name) {
    case 'Bash': return { verb: 'Terminal', detail: input.description || input.command };
    case 'Read': return { verb: 'Lit', detail: base(input.file_path) };
    case 'Edit': case 'MultiEdit': return { verb: 'Modifie', detail: base(input.file_path) };
    case 'Write': return { verb: 'Écrit', detail: base(input.file_path) };
    case 'NotebookEdit': return { verb: 'Notebook', detail: base(input.notebook_path) };
    case 'Grep': return { verb: 'Cherche', detail: input.pattern };
    case 'Glob': return { verb: 'Liste', detail: input.pattern };
    case 'WebFetch': return { verb: 'Web', detail: input.url };
    case 'WebSearch': return { verb: 'Recherche', detail: input.query };
    case 'Agent': case 'Task': return { verb: 'Délègue', detail: input.description };
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': return { verb: 'Planifie', detail: input.subject || '' };
    case 'Skill': return { verb: 'Skill', detail: input.skill };
    case 'AskUserQuestion': return { verb: 'Question', detail: input.questions?.[0]?.question };
    default: {
      if (name.startsWith('mcp__')) return { verb: name.split('__').at(-1).replace(/_/g, ' '), detail: '' };
      return { verb: name, detail: '' };
    }
  }
}

const resultText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').join(' ') : '');

function analyze(file, stat) {
  const entries = readTail(file, stat.size);
  const sessionId = path.basename(file, '.jsonl');
  const head = headInfo(file);
  let cwd = null, model = null, lastTs = null, lastMsg = null, lastText = null, lastPrompt = null, branch = null, entrypoint = null;
  let lastError = null;
  const actions = [];
  const toolNames = new Map();

  for (const e of entries) {
    if (e.cwd) cwd = e.cwd;
    if (e.gitBranch) branch = e.gitBranch;
    if (e.entrypoint) entrypoint = e.entrypoint;
    if (e.type === 'last-prompt' && e.lastPrompt) lastPrompt = e.lastPrompt;
    if (e.timestamp && (e.type === 'user' || e.type === 'assistant')) lastTs = e.timestamp;
    if (e.isSidechain) continue;
    if (e.type === 'assistant' && e.message) {
      lastMsg = e;
      if (e.message.model && !e.message.model.startsWith('<')) model = e.message.model;
      for (const c of e.message.content || []) {
        if (c.type === 'tool_use') {
          const d = describeTool(c.name, c.input);
          toolNames.set(c.id, d);
          actions.push({ ts: e.timestamp, tool: c.name, verb: d.verb, detail: clip(d.detail, 90) });
        } else if (c.type === 'text' && c.text?.trim()) {
          lastText = c.text;
        }
      }
    } else if (e.type === 'user' && e.message) {
      lastMsg = e;
      const c = e.message.content;
      if (typeof c === 'string' && !c.startsWith('<')) lastPrompt = c;
      else if (Array.isArray(c)) {
        const t = c.find((x) => x.type === 'text' && x.text && !x.text.startsWith('<'));
        if (t) lastPrompt = t.text;
        for (const r of c) {
          if (r.type === 'tool_result' && r.is_error) {
            const d = toolNames.get(r.tool_use_id);
            lastError = { ts: e.timestamp, verb: d?.verb || 'Outil', text: clip(resultText(r.content), 140) };
          }
        }
      }
    }
  }

  const title = findTitle(file, stat.size, entries);
  // le mtime bouge aussi quand l'app réécrit des métadonnées : on se fie aux horodatages des messages
  const lastTime = lastTs ? Date.parse(lastTs) : stat.mtimeMs;
  const age = (Date.now() - lastTime) / 1000;

  let status = 'idle';
  let phase = null;
  if (lastMsg) {
    const content = lastMsg.message.content;
    const isToolUse = lastMsg.type === 'assistant' && Array.isArray(content) && content.some((c) => c.type === 'tool_use');
    const isAsk = isToolUse && content.some((c) => c.type === 'tool_use' && c.name === 'AskUserQuestion');
    const endTurn = lastMsg.type === 'assistant' && !isToolUse;
    if (isAsk && age < 3600) status = 'waiting';
    else if (endTurn) status = age < 45 * 60 ? 'waiting' : 'idle';
    else if (isToolUse) { status = age < 15 * 60 ? 'working' : 'idle'; phase = 'tool'; }
    else { status = age < 5 * 60 ? 'working' : 'idle'; phase = 'thinking'; } // il vient de recevoir un résultat
  }

  let subagents = 0;
  const subDir = path.join(path.dirname(file), sessionId, 'subagents');
  for (const f of safeReaddir(subDir)) {
    if (f.endsWith('.jsonl') && Date.now() - mtime(path.join(subDir, f)) < 90 * 1000) subagents++;
  }

  const sc = scanState.get(file);
  let todos = [];
  if (sc) todos = sc.todoMode === 'todowrite' ? sc.todos : [...sc.tasks.values()];

  const current = status === 'working' ? actions.at(-1) || { verb: 'Réfléchit', detail: '' } : null;
  return {
    id: sessionId,
    title: clip(title || lastPrompt || head.project, 60),
    project: head.project,
    cwd: cwd || head.cwd,
    launchCwd: head.cwd,
    branch,
    model,
    entrypoint,
    source: coworkInfo(file) ? 'cowork' : 'code',
    status,
    phase: status === 'working' ? phase : null,
    age: Math.round(age),
    lastActivity: new Date(lastTime).toISOString(),
    sessionStart: head.start,
    current,
    error: lastError && Date.now() - Date.parse(lastError.ts) < 120 * 1000 ? lastError : null,
    subagents: status === 'working' ? subagents : 0,
    actions: actions.slice(-14),
    workload: sc?.calls[dayKey(Date.now())] || 0, // appels d'outils aujourd'hui
    todos: todos.slice(0, 20).map((t) => ({ text: clip(t.text, 90), active: clip(t.active, 90), status: t.status })),
    lastText: clip(lastText, 400),
    lastPrompt: clip(lastPrompt, 240),
  };
}

let lastAgents = new Map();
function collectAgents() {
  const cutoff = Date.now() - WINDOW_HOURS * 3600 * 1000;
  const files = [];
  for (const full of projectDirs()) {
    for (const f of safeReaddir(full)) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(full, f);
      try {
        const st = fs.statSync(fp);
        if (st.mtimeMs >= cutoff && st.size > 0) files.push({ fp, st });
      } catch { /* ignore */ }
    }
  }
  files.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  const agents = [];
  for (const { fp, st } of files.slice(0, MAX_AGENTS * 2)) {
    try {
      const a = analyze(fp, st);
      if (a.age <= WINDOW_HOURS * 3600) agents.push(a); // fichier touché récemment mais conversation ancienne : on ignore
    } catch (err) { console.warn('skip', fp, err.message); }
  }
  const out = agents.sort((x, y) => x.age - y.age).slice(0, MAX_AGENTS);
  lastAgents = new Map(out.map((a) => [a.id, a]));
  return out;
}

// ---------------------------------------------------------------------------
// Reprendre une session dans le Terminal (avec un message optionnel)
// ---------------------------------------------------------------------------
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
function resumeInTerminal(id, text) {
  if (process.platform !== 'darwin') throw new Error('ouverture du Terminal disponible sur macOS uniquement : copie la commande à la place');
  const a = lastAgents.get(id);
  if (!a) throw new Error('session inconnue');
  if (a.source === 'cowork') throw new Error('session Cowork : réponds-lui dans l’app Claude');
  const cwd = a.launchCwd || a.cwd;
  if (!cwd || !fs.existsSync(cwd)) throw new Error('dossier introuvable');
  let cmd = `cd ${sq(cwd)} && claude --resume ${id}`;
  if (text && text.trim()) {
    const tmp = path.join(os.tmpdir(), `agents3d-${crypto.randomBytes(6).toString('hex')}.txt`);
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    cmd = `cd ${sq(cwd)} && msg="$(cat ${sq(tmp)})" && rm -f ${sq(tmp)} && claude --resume ${id} "$msg"`;
  }
  spawn('osascript', [
    '-e', 'on run argv',
    '-e', 'tell application "Terminal" to do script (item 1 of argv)',
    '-e', 'tell application "Terminal" to activate',
    '-e', 'end run', cmd,
  ], { stdio: 'ignore', detached: true }).unref();
}

// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

// Accès wifi : une clé secrète, gardée dans data/lan-key.txt, à ouvrir une fois depuis le téléphone
let LAN_KEY = null;
if (LAN) {
  const kf = path.join(__dirname, 'data', 'lan-key.txt');
  try { LAN_KEY = fs.readFileSync(kf, 'utf8').trim(); } catch { /* à créer */ }
  if (!/^[0-9a-f]{24}$/.test(LAN_KEY || '')) { LAN_KEY = crypto.randomBytes(12).toString('hex'); fs.mkdirSync(path.dirname(kf), { recursive: true }); fs.writeFileSync(kf, LAN_KEY, { mode: 0o600 }); }
}
const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const sameKey = (a) => { const x = Buffer.from(String(a || '')), y = Buffer.from(LAN_KEY || ''); return x.length === y.length && y.length > 0 && crypto.timingSafeEqual(x, y); };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  const local = isLoopback(req);
  if (local) {
    if (!ALLOWED_HOSTS.includes(req.headers.host)) { res.writeHead(403); return res.end(); } // anti DNS-rebinding
  } else {
    if (!LAN) { res.writeHead(403); return res.end(); }
    const cookie = /(?:^|;\s*)bk=([0-9a-f]+)/.exec(req.headers.cookie || '')?.[1];
    if (sameKey(url.searchParams.get('k'))) { // premier passage : on pose le cookie et on nettoie l'adresse
      res.writeHead(302, { 'Set-Cookie': `bk=${LAN_KEY}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`, Location: url.pathname });
      return res.end();
    }
    if (!sameKey(cookie)) { res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Accès refusé : ouvre le lien complet affiché au démarrage du serveur.'); }
  }

  if (url.pathname === '/api/agents') {
    return json(res, 200, { now: new Date().toISOString(), agents: collectAgents(), stats: todayStats(), weather, remote: !local, config: clientConfig });
  }
  if (url.pathname === '/api/history') {
    const n = Math.min(KEEP_DAYS, Math.max(1, Number(url.searchParams.get('days')) || 90));
    return json(res, 200, { days: historyList(n, true), fx });
  }

  if (url.pathname === '/api/resume' && req.method === 'POST') {
    const origin = req.headers.origin;
    if (!local) return json(res, 403, { error: 'réservé à cet ordinateur' }); // jamais depuis le wifi
    if (!ALLOWED_HOSTS.some((h) => origin === `http://${h}`) || req.headers['x-token'] !== TOKEN) return json(res, 403, { error: 'refusé' });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', () => {
      try {
        const { id, text } = JSON.parse(body);
        if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('id invalide');
        resumeInTerminal(id, typeof text === 'string' ? text.slice(0, 8000) : '');
        json(res, 200, { ok: true });
      } catch (err) { json(res, 400, { error: err.message }); }
    });
    return;
  }

  const rel = url.pathname === '/' ? 'index.html' : url.pathname === '/dashboard' ? 'dashboard.html' : url.pathname.slice(1);
  const pub = path.join(__dirname, 'public');
  const file = path.join(pub, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(pub)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('404'); }
    if (file.endsWith('.html')) data = data.toString().replace('__TOKEN__', local ? TOKEN : '');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(PORT, HOST, () => {
  console.log(`\n  🏢  Bureau des agents : http://localhost:${PORT}\n  📂  Source : ${PROJECTS_DIR}${COWORK_DIR && fs.existsSync(COWORK_DIR) ? ' + sessions Cowork' : ''} (sessions des ${WINDOW_HOURS} dernières heures)\n`);
  const t0 = Date.now();
  scanAll().then(() => console.log(`  📊  Historique lu en ${((Date.now() - t0) / 1000).toFixed(1)} s (depuis le ${scanFromKey}${frozenThrough ? ', archives jusqu\u2019au ' + frozenThrough : ''})`));
  setInterval(scanAll, 4000);
  fetchWeather(); setInterval(fetchWeather, 10 * 60 * 1000);
  fetchFx(); setInterval(fetchFx, 12 * 3600 * 1000);
  console.log(`  📊  Tableau de bord : http://localhost:${PORT}/dashboard`);
  if (LAN) {
    // L'adresse à donner au téléphone est celle du réseau par lequel le Mac sort (wifi ou câble),
    // pas celles des réseaux virtuels (machines virtuelles, conteneurs) qui ne sont pas joignables de l'extérieur.
    const show = (ip) => console.log(`  📱  Depuis le téléphone (même wifi) : http://${ip}:${PORT}/?k=${LAN_KEY}\n      ou le tableau de bord : http://${ip}:${PORT}/dashboard?k=${LAN_KEY}`);
    const probe = require('dgram').createSocket('udp4');
    const fallback = () => {
      const all = Object.entries(os.networkInterfaces()).flatMap(([name, list]) => (list || []).filter((i) => i.family === 'IPv4' && !i.internal).map((i) => ({ name, ip: i.address })));
      const real = all.filter((i) => /^(en|eth|wl)/.test(name(i))); // interfaces physiques
      (real.length ? real : all).forEach((i) => show(i.ip));
      if (!all.length) console.log('  📱  Aucun réseau trouvé : le Mac est-il connecté au wifi ?');
    };
    const name = (i) => i.name;
    probe.on('error', () => { try { probe.close(); } catch { /* déjà fermé */ } fallback(); });
    probe.connect(53, '1.1.1.1', () => { // aucun paquet n'est envoyé : on lit juste l'adresse locale choisie par le système
      const ip = probe.address().address; probe.close();
      if (ip && ip !== '0.0.0.0') show(ip); else fallback();
    });
  }
});
