# Gemini Plus Generator + Admin

Web generator Gemini Plus (kirim OTP → klaim) dengan panel admin. Limit **1× per hari** per pengunjung (dicek di server, bukan di browser).

- Halaman generator: `/`
- Panel admin: `/admin`
- Backend: Vercel serverless (`api/generate.js`, `api/admin.js`) — apikey hanya ada di server.

## Cara pasang (GitHub + Vercel)

1. Upload seluruh folder ini ke repo GitHub baru.
2. Di Vercel: **Add New → Project** → pilih repo itu → Deploy (tanpa build command).
3. Buka **Project → Settings → Environment Variables**, isi:

| Nama | Isi |
|---|---|
| `GEMINI_API_KEY` | apikey jerexd kamu |
| `ADMIN_PASSWORD` | password untuk `/admin` |
| `UPSTASH_REDIS_REST_URL` | dari database Upstash Redis |
| `UPSTASH_REDIS_REST_TOKEN` | dari database Upstash Redis |
| `ADMIN_SECRET`, `IP_SALT` (opsional) | teks acak panjang |
| `TZ_OFFSET_HOURS` (opsional) | `7` WIB (default), `8` WITA, `9` WIT |

4. Buat database gratis: **Vercel → Storage → Create → Upstash Redis**, lalu hubungkan ke project (variabel `KV_REST_API_URL` / `KV_REST_API_TOKEN` otomatis terbaca).
5. **Redeploy** supaya variabel terbaca.

> Tanpa Redis, limit disimpan di memori server dan bisa ter-reset sewaktu-waktu di Vercel. Admin akan melihat peringatan kuning soal ini.

## Cara kerja limit 1×/hari

- Pengunjung dikenali dari IP (disimpan sebagai hash, bukan IP asli).
- Jatah baru berkurang saat **klaim berhasil**; OTP salah/gagal tidak memotong jatah.
- Batas kirim OTP per hari = limit + 2, dan maksimal 5 salah OTP per sesi, supaya kuota API tidak dihabiskan.
- Reset otomatis tengah malam sesuai `TZ_OFFSET_HOURS`.

## Panel admin

Statistik, kuota API terakhir, ubah limit harian, pengumuman, mode maintenance, log aktivitas (termasuk hasil generate), reset jatah pengguna, blokir / buka blokir.

## Uji lokal

```bash
cp .env.example .env   # isi nilainya
node dev.js            # http://localhost:3000  (admin: /admin)
node test.js           # uji otomatis dengan API tiruan (tidak memakai kuota asli)
```
