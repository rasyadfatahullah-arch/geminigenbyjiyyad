'use strict';
// Uji end-to-end dengan API tiruan (tidak memanggil API asli, tidak memakai kuota).
const http = require('http');
const assert = require('assert');

process.env.GEMINI_API_KEY = 'TESTKEY123';
process.env.ADMIN_PASSWORD = 'rahasia';
process.env.GEMINI_API_BASE = 'http://127.0.0.1:4099/mock';

// API tiruan: meniru format respons asli
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const q = Object.fromEntries(u.searchParams);
  res.setHeader('content-type', 'application/json');
  if (q.apikey !== 'TESTKEY123') return res.end(JSON.stringify({ statusCode: 401, status: false, message: 'apikey salah' }));
  if (q.action === 'send') {
    return res.end(JSON.stringify({
      statusCode: 200, status: true, action: 'send',
      message: `Kode OTP berhasil dikirim ke ${q.email}!`,
      data: { email: q.email, sessionId: 'up-sess-1', quota_remaining: 4, quota_total: 5 },
    }));
  }
  if (q.action === 'claim') {
    if (q.otp !== '123456' || q.sessionId !== 'up-sess-1') return res.end(JSON.stringify({ statusCode: 400, status: false, message: 'OTP salah' }));
    return res.end(JSON.stringify({ statusCode: 200, status: true, message: 'Gemini Plus aktif!', data: { email: q.email, link: 'https://example.com/redeem', echo: q.apikey } }));
  }
  res.end(JSON.stringify({ statusCode: 400, status: false, message: 'action?' }));
});

(async () => {
  await new Promise((r) => mock.listen(4099, r));
  const app = await require('./dev').start(0);
  const base = 'http://127.0.0.1:' + app.address().port;
  const post = async (p, body, headers = {}) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { s: r.status, j: await r.json() };
  };
  const g = (b) => post('/api/generate', b);
  let n = 0;
  const ok = (name) => console.log(`  ✓ ${++n}. ${name}`);

  let r = await g({ action: 'status' });
  assert(r.j.ok && r.j.limit === 1 && r.j.used === 0 && r.j.remaining === 1); ok('status awal: jatah 1, terpakai 0');

  r = await g({ action: 'send', email: 'bukan-email' });
  assert(r.s === 400); ok('email tidak valid ditolak');

  r = await g({ action: 'send', email: 'Tes@Gmail.com' });
  assert(r.s === 200 && r.j.sessionId && r.j.email === 'tes@gmail.com'); ok('kirim OTP berhasil');
  const sid = r.j.sessionId;
  assert(!JSON.stringify(r.j).includes('up-sess-1')); ok('sessionId upstream tidak bocor ke klien');

  r = await g({ action: 'claim', sessionId: sid, otp: '000000' });
  assert(r.s === 400 && r.j.triesLeft === 4); ok('OTP salah ditolak, jatah dikembalikan');
  r = await g({ action: 'status' });
  assert(r.j.used === 0); ok('jatah tidak berkurang setelah gagal');

  r = await g({ action: 'claim', sessionId: sid, otp: '12ab56' });
  assert(r.s === 400); ok('OTP non-angka ditolak');

  r = await g({ action: 'claim', sessionId: sid, otp: '123456' });
  assert(r.s === 200 && r.j.ok && r.j.data.link === 'https://example.com/redeem' && r.j.remaining === 0); ok('klaim berhasil -> jatah habis');
  assert(!JSON.stringify(r.j).includes('TESTKEY123')); ok('apikey tidak pernah bocor di respons');

  r = await g({ action: 'send', email: 'lain@gmail.com' });
  assert(r.s === 429); ok('kirim OTP lagi di hari sama -> 429 (limit 1x/hari)');

  r = await g({ action: 'claim', sessionId: sid, otp: '123456' });
  assert(r.s === 410); ok('sesi lama tidak bisa dipakai ulang');

  // admin
  r = await post('/api/admin', { op: 'login', password: 'salah' });
  assert(r.s === 401); ok('login admin salah ditolak');
  r = await post('/api/admin', { op: 'overview' });
  assert(r.s === 401); ok('overview tanpa token ditolak');
  r = await post('/api/admin', { op: 'login', password: 'rahasia' });
  assert(r.s === 200 && r.j.token); ok('login admin benar');
  const H = { authorization: 'Bearer ' + r.j.token };

  r = await post('/api/admin', { op: 'overview' }, H);
  assert(r.j.ok && r.j.stats.ok === 1 && r.j.stats.todayOk === 1 && r.j.logs.length >= 3 && r.j.quota.remaining === 4); ok('overview: statistik, log, kuota API');
  const ih = r.j.logs.find((l) => l.type === 'claim' && l.ok).ih;
  assert(r.j.logs.find((l) => l.result)); ok('hasil generate tersimpan di log admin');

  r = await post('/api/admin', { op: 'resetUser', ih }, H);
  assert(r.j.ok);
  r = await g({ action: 'status' });
  assert(r.j.used === 0 && r.j.remaining === 1); ok('admin bisa reset jatah pengguna');

  r = await post('/api/admin', { op: 'saveSettings', dailyLimit: 3, maintenance: false, announcement: 'Halo' }, H);
  assert(r.j.ok);
  r = await g({ action: 'status' });
  assert(r.j.limit === 3 && r.j.announcement === 'Halo'); ok('admin bisa ubah limit & pengumuman');
  r = await post('/api/admin', { op: 'saveSettings', dailyLimit: 0 }, H);
  assert(r.s === 400); ok('limit tidak valid ditolak');
  await post('/api/admin', { op: 'saveSettings', dailyLimit: 1, maintenance: true, announcement: '' }, H);
  r = await g({ action: 'send', email: 'a@gmail.com' });
  assert(r.s === 503); ok('mode maintenance memblokir generator');
  await post('/api/admin', { op: 'saveSettings', dailyLimit: 1, maintenance: false, announcement: '' }, H);

  await post('/api/admin', { op: 'ban', ih }, H);
  r = await g({ action: 'send', email: 'a@gmail.com' });
  assert(r.s === 403); ok('pengguna yang diblokir ditolak');
  await post('/api/admin', { op: 'unban', ih }, H);
  r = await g({ action: 'send', email: 'a@gmail.com' });
  assert(r.s === 200); ok('unban mengembalikan akses');

  r = await post('/api/admin', { op: 'ban', ih: '../../x' }, H);
  assert(r.s === 400); ok('input ban tidak valid ditolak');

  console.log(`\nSemua ${n} uji lulus ✅`);
  app.close(); mock.close(); process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
