'use strict';
const crypto = require('crypto');

/* ---------- config (dibaca dari environment) ---------- */
const cfg = () => ({
  base: process.env.GEMINI_API_BASE || 'https://api.jerexd.my.id/api/google/gemini-plus',
  key: process.env.GEMINI_API_KEY || '',
  tz: Number(process.env.TZ_OFFSET_HOURS || 7), // 7 = WIB, 8 = WITA, 9 = WIT
  salt: process.env.IP_SALT || 'gemini-plus-gen',
  upUrl: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '',
  upToken: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '',
});

/* ---------- storage: Upstash Redis (permanen) atau memori (cadangan / dev) ---------- */
const mem = global.__gpMem || (global.__gpMem = new Map());
const memGet = (k) => {
  const e = mem.get(k);
  if (!e) return undefined;
  if (e.x && e.x < Date.now()) { mem.delete(k); return undefined; }
  return e;
};
const memKV = {
  async get(k) { const e = memGet(k); return e ? e.v : null; },
  async set(k, v, ex) { mem.set(k, { v: String(v), x: ex ? Date.now() + ex * 1000 : 0 }); },
  async incr(k) { const e = memGet(k); const n = (e ? Number(e.v) : 0) + 1; mem.set(k, { v: String(n), x: e ? e.x : 0 }); return n; },
  async decr(k) { const e = memGet(k); const n = (e ? Number(e.v) : 0) - 1; mem.set(k, { v: String(n), x: e ? e.x : 0 }); return n; },
  async expire(k, s) { const e = memGet(k); if (e) e.x = Date.now() + s * 1000; },
  async del(k) { mem.delete(k); },
  async lpush(k, v) { const e = memGet(k); const a = e ? e.v : []; a.unshift(v); mem.set(k, { v: a, x: 0 }); },
  async ltrim(k, s, t) { const e = memGet(k); if (e) e.v = e.v.slice(s, t + 1); },
  async lrange(k, s, t) { const e = memGet(k); return e ? e.v.slice(s, t + 1) : []; },
  async sadd(k, v) { const e = memGet(k); const a = e ? e.v : []; if (!a.includes(v)) a.push(v); mem.set(k, { v: a, x: 0 }); },
  async srem(k, v) { const e = memGet(k); if (e) e.v = e.v.filter((x) => x !== v); },
  async smembers(k) { const e = memGet(k); return e ? e.v.slice() : []; },
};

async function up(args) {
  const c = cfg();
  const r = await fetch(c.upUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.upToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const j = await r.json();
  if (j.error) throw new Error('Storage: ' + j.error);
  return j.result;
}
const upKV = {
  get: (k) => up(['GET', k]),
  set: (k, v, ex) => (ex ? up(['SET', k, String(v), 'EX', ex]) : up(['SET', k, String(v)])),
  incr: (k) => up(['INCR', k]),
  decr: (k) => up(['DECR', k]),
  expire: (k, s) => up(['EXPIRE', k, s]),
  del: (k) => up(['DEL', k]),
  lpush: (k, v) => up(['LPUSH', k, v]),
  ltrim: (k, s, t) => up(['LTRIM', k, s, t]),
  lrange: (k, s, t) => up(['LRANGE', k, s, t]),
  sadd: (k, v) => up(['SADD', k, v]),
  srem: (k, v) => up(['SREM', k, v]),
  smembers: (k) => up(['SMEMBERS', k]),
};

const kv = () => (cfg().upUrl && cfg().upToken ? upKV : memKV);
const storageMode = () => (cfg().upUrl && cfg().upToken ? 'redis' : 'memory');

async function incrWithTtl(key, ttl) {
  const s = kv();
  const n = await s.incr(key);
  if (n === 1) await s.expire(key, ttl);
  return n;
}

/* ---------- waktu ---------- */
function today() {
  return new Date(Date.now() + cfg().tz * 3600e3).toISOString().slice(0, 10);
}
function secondsToReset() {
  const now = Date.now() + cfg().tz * 3600e3;
  const next = (Math.floor(now / 86400000) + 1) * 86400000;
  return Math.max(1, Math.ceil((next - now) / 1000));
}

/* ---------- request helpers ---------- */
function getIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || String(req.headers['x-real-ip'] || '') || (req.socket && req.socket.remoteAddress) || '0.0.0.0';
}
const ipHash = (ip) => crypto.createHash('sha256').update(cfg().salt + '|' + ip).digest('hex').slice(0, 16);
function maskIp(ip) {
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + ':…';
  const p = ip.split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}.•.•` : ip;
}

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 20000) break;
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

const validEmail = (e) => e.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

/* ---------- pengaturan & log ---------- */
const DEFAULTS = { dailyLimit: 1, maintenance: false, announcement: '' };
async function getSettings() {
  const raw = await kv().get('gp:settings');
  let s = {};
  try { s = raw ? JSON.parse(raw) : {}; } catch { s = {}; }
  return { ...DEFAULTS, ...s };
}
async function saveSettings(s) {
  await kv().set('gp:settings', JSON.stringify(s));
}
async function addLog(entry) {
  try {
    const s = kv();
    await s.lpush('gp:log', JSON.stringify({ t: Date.now(), ...entry }));
    await s.ltrim('gp:log', 0, 499);
  } catch { /* log bersifat opsional */ }
}
async function stat(name) {
  try {
    const s = kv();
    await s.incr('gp:st:' + name);
    if (name === 'ok') await incrWithTtl(`gp:st:ok:${today()}`, 172800);
  } catch { /* abaikan */ }
}

/* ---------- API upstream ---------- */
function scrub(obj) {
  const k = cfg().key;
  if (!k) return obj;
  try { return JSON.parse(JSON.stringify(obj).split(k).join('***')); } catch { return obj; }
}

async function upstream(params) {
  const c = cfg();
  if (!c.key) return { ok: false, config: true, message: 'Server belum dikonfigurasi (GEMINI_API_KEY kosong).' };
  const u = new URL(c.base);
  u.searchParams.set('apikey', c.key);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(u, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* bukan JSON */ }
    if (!j) return { ok: false, message: 'Respons API tidak valid. Coba lagi nanti.' };
    j = scrub(j);
    const ok = j.status === true && (j.statusCode === undefined || j.statusCode < 400);
    return { ok, json: j };
  } catch (e) {
    return { ok: false, message: e.name === 'AbortError' ? 'API terlalu lama merespons, coba lagi.' : 'Gagal menghubungi API.' };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- auth admin ---------- */
const secret = () => process.env.ADMIN_SECRET || process.env.ADMIN_PASSWORD || '';
function safeEq(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function signToken(ttlSec) {
  const p = Buffer.from(JSON.stringify({ exp: Date.now() + ttlSec * 1000 })).toString('base64url');
  const s = crypto.createHmac('sha256', secret()).update(p).digest('base64url');
  return p + '.' + s;
}
function verifyToken(t) {
  if (!t || !process.env.ADMIN_PASSWORD) return false;
  const [p, s] = String(t).split('.');
  if (!p || !s) return false;
  const e = crypto.createHmac('sha256', secret()).update(p).digest('base64url');
  if (!safeEq(s, e)) return false;
  try { return JSON.parse(Buffer.from(p, 'base64url').toString()).exp > Date.now(); } catch { return false; }
}

module.exports = {
  cfg, kv, storageMode, incrWithTtl, today, secondsToReset, getIp, ipHash, maskIp, send, readBody,
  validEmail, getSettings, saveSettings, addLog, stat, upstream, scrub, safeEq, signToken, verifyToken,
};
