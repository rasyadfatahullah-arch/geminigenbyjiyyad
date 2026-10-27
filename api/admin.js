'use strict';
const L = require('./_lib');

const HASH_RE = /^[a-f0-9]{16}$/;

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return L.send(res, 405, { ok: false, message: 'Method tidak diizinkan.' });

    const body = await L.readBody(req);
    const op = String(body.op || '');
    const kv = L.kv();
    const ih = L.ipHash(L.getIp(req));

    /* ---------- login ---------- */
    if (op === 'login') {
      if (!process.env.ADMIN_PASSWORD) {
        return L.send(res, 500, { ok: false, message: 'ADMIN_PASSWORD belum diatur di environment.' });
      }
      const n = await L.incrWithTtl(`gp:lg:${ih}`, 900);
      if (n > 8) return L.send(res, 429, { ok: false, message: 'Terlalu banyak percobaan login. Tunggu 15 menit.' });
      if (!L.safeEq(String(body.password || ''), process.env.ADMIN_PASSWORD)) {
        return L.send(res, 401, { ok: false, message: 'Password salah.' });
      }
      return L.send(res, 200, { ok: true, token: L.signToken(12 * 3600) });
    }

    /* ---------- semua op lain wajib token ---------- */
    const auth = String(req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!L.verifyToken(token)) return L.send(res, 401, { ok: false, code: 'AUTH', message: 'Sesi admin habis. Login ulang.' });

    const day = L.today();

    if (op === 'overview') {
      const [settings, bans, logsRaw, quotaRaw, send, ok, fail, todayOk] = await Promise.all([
        L.getSettings(),
        kv.smembers('gp:bans'),
        kv.lrange('gp:log', 0, 149),
        kv.get('gp:quota'),
        kv.get('gp:st:send'),
        kv.get('gp:st:ok'),
        kv.get('gp:st:fail'),
        kv.get(`gp:st:ok:${day}`),
      ]);
      const logs = logsRaw.map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
      let quota = null;
      try { quota = quotaRaw ? JSON.parse(quotaRaw) : null; } catch { /* abaikan */ }
      return L.send(res, 200, {
        ok: true,
        settings,
        bans,
        logs,
        quota,
        stats: { send: +send || 0, ok: +ok || 0, fail: +fail || 0, todayOk: +todayOk || 0 },
        storage: L.storageMode(),
        configured: !!L.cfg().key,
        tz: L.cfg().tz,
      });
    }

    if (op === 'saveSettings') {
      const limit = Math.floor(Number(body.dailyLimit));
      if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
        return L.send(res, 400, { ok: false, message: 'Limit harian harus 1–100.' });
      }
      const s = {
        dailyLimit: limit,
        maintenance: !!body.maintenance,
        announcement: String(body.announcement || '').slice(0, 200),
      };
      await L.saveSettings(s);
      return L.send(res, 200, { ok: true, settings: s });
    }

    if (op === 'ban' || op === 'unban' || op === 'resetUser') {
      const h = String(body.ih || '');
      if (!HASH_RE.test(h)) return L.send(res, 400, { ok: false, message: 'ID pengguna tidak valid.' });
      if (op === 'ban') await kv.sadd('gp:bans', h);
      if (op === 'unban') await kv.srem('gp:bans', h);
      if (op === 'resetUser') {
        await kv.del(`gp:use:${day}:${h}`);
        await kv.del(`gp:snd:${day}:${h}`);
      }
      return L.send(res, 200, { ok: true });
    }

    if (op === 'clearLogs') {
      await kv.del('gp:log');
      return L.send(res, 200, { ok: true });
    }

    return L.send(res, 400, { ok: false, message: 'Operasi tidak dikenal.' });
  } catch (e) {
    console.error('[admin]', e && e.message);
    return L.send(res, 500, { ok: false, message: 'Terjadi kesalahan di server.' });
  }
};
