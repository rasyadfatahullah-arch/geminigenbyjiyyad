'use strict';
const crypto = require('crypto');
const L = require('./_lib');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return L.send(res, 405, { ok: false, message: 'Method tidak diizinkan.' });

    const body = await L.readBody(req);
    const action = String(body.action || '');
    const ip = L.getIp(req);
    const ih = L.ipHash(ip);
    const kv = L.kv();
    const S = await L.getSettings();
    const day = L.today();
    const usedKey = `gp:use:${day}:${ih}`;
    const sendKey = `gp:snd:${day}:${ih}`;

    const used = Math.max(0, Number((await kv.get(usedKey)) || 0));
    const banned = (await kv.smembers('gp:bans')).includes(ih);
    const info = {
      limit: S.dailyLimit,
      used,
      remaining: Math.max(0, S.dailyLimit - used),
      resetIn: L.secondsToReset(),
      maintenance: S.maintenance,
      announcement: S.announcement,
    };

    if (action === 'status') return L.send(res, 200, { ok: true, banned, ...info });
    if (banned) return L.send(res, 403, { ok: false, message: 'Akses kamu diblokir oleh admin.', ...info });
    if (S.maintenance) return L.send(res, 503, { ok: false, message: 'Generator sedang maintenance. Coba lagi nanti.', ...info });

    /* ---------- 1) kirim OTP ---------- */
    if (action === 'send') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!L.validEmail(email)) return L.send(res, 400, { ok: false, message: 'Format email tidak valid.', ...info });
      if (used >= S.dailyLimit) {
        return L.send(res, 429, { ok: false, message: 'Jatah hari ini sudah terpakai. Coba lagi besok.', ...info });
      }
      const sends = await L.incrWithTtl(sendKey, 172800);
      if (sends > S.dailyLimit + 2) {
        return L.send(res, 429, { ok: false, message: 'Terlalu banyak percobaan kirim OTP hari ini.', ...info });
      }

      const r = await L.upstream({ action: 'send', email });
      await L.stat('send');
      if (!r.ok) {
        await L.addLog({ type: 'send', ok: false, email, ip: L.maskIp(ip), ih, msg: (r.json && r.json.message) || r.message });
        if (r.config) return L.send(res, 500, { ok: false, message: r.message });
        const code = r.json && r.json.statusCode >= 400 && r.json.statusCode < 500 ? 400 : 502;
        return L.send(res, code, { ok: false, message: (r.json && r.json.message) || r.message || 'Gagal mengirim OTP.', ...info });
      }

      const d = r.json.data || {};
      if (d.quota_remaining !== undefined) {
        await kv.set('gp:quota', JSON.stringify({ remaining: d.quota_remaining, total: d.quota_total, t: Date.now() }));
      }
      const sid = crypto.randomUUID();
      await kv.set(`gp:sess:${sid}`, JSON.stringify({ email, ih, up: d.sessionId || '' }), 900);
      await L.addLog({ type: 'send', ok: true, email, ip: L.maskIp(ip), ih, msg: 'OTP terkirim' });
      return L.send(res, 200, {
        ok: true,
        sessionId: sid,
        email,
        message: r.json.message || 'Kode OTP berhasil dikirim.',
        ...info,
      });
    }

    /* ---------- 2) klaim dengan OTP ---------- */
    if (action === 'claim') {
      const sid = String(body.sessionId || '');
      const otp = String(body.otp || '').trim();
      if (!/^\d{6}$/.test(otp)) return L.send(res, 400, { ok: false, message: 'OTP harus 6 digit angka.', ...info });

      const raw = sid ? await kv.get(`gp:sess:${sid}`) : null;
      if (!raw) return L.send(res, 410, { ok: false, code: 'SESSION', message: 'Sesi habis. Kirim OTP ulang.', ...info });
      const ses = JSON.parse(raw);
      if (ses.ih !== ih) return L.send(res, 403, { ok: false, code: 'SESSION', message: 'Sesi tidak cocok.', ...info });

      const tries = await L.incrWithTtl(`gp:sess:${sid}:t`, 900);
      if (tries > 5) {
        await kv.del(`gp:sess:${sid}`);
        return L.send(res, 429, { ok: false, code: 'SESSION', message: 'Terlalu banyak salah OTP. Kirim OTP ulang.', ...info });
      }

      // reservasi jatah dulu supaya klaim paralel tidak lolos dua kali
      const n = await kv.incr(usedKey);
      if (n === 1) await kv.expire(usedKey, 172800);
      if (n > S.dailyLimit) {
        await kv.decr(usedKey);
        return L.send(res, 429, { ok: false, message: 'Jatah hari ini sudah terpakai. Coba lagi besok.', ...info, used: S.dailyLimit, remaining: 0 });
      }

      const r = await L.upstream({ action: 'claim', email: ses.email, otp, sessionId: ses.up });
      if (!r.ok) {
        await kv.decr(usedKey); // gagal -> jatah dikembalikan
        await L.stat('fail');
        const msg = (r.json && r.json.message) || r.message || 'OTP salah atau kedaluwarsa.';
        await L.addLog({ type: 'claim', ok: false, email: ses.email, ip: L.maskIp(ip), ih, msg });
        return L.send(res, 400, { ok: false, message: msg, triesLeft: Math.max(0, 5 - tries), ...info });
      }

      await kv.del(`gp:sess:${sid}`);
      await L.stat('ok');
      const data = r.json.data === undefined ? null : r.json.data;
      await L.addLog({
        type: 'claim', ok: true, email: ses.email, ip: L.maskIp(ip), ih,
        msg: r.json.message || 'Berhasil',
        result: JSON.stringify(data).slice(0, 800),
      });
      return L.send(res, 200, {
        ok: true,
        message: r.json.message || 'Berhasil!',
        email: ses.email,
        data,
        ...info,
        used: n,
        remaining: Math.max(0, S.dailyLimit - n),
      });
    }

    return L.send(res, 400, { ok: false, message: 'Aksi tidak dikenal.' });
  } catch (e) {
    console.error('[generate]', e && e.message);
    return L.send(res, 500, { ok: false, message: 'Terjadi kesalahan di server.' });
  }
};
