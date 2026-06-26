# Cara Deploy / Update ke Server (VM Google Cloud)

Catatan ringkas untuk update web setelah ada perubahan kode.

---

## Alur singkat (kode → GitHub → server)

```
Komputer (edit kode)  →  push ke GitHub  →  server tarik (git pull)  →  restart
```

---

## 1. Di komputer — kirim perubahan ke GitHub

Lewat **GitHub Desktop**: tulis pesan commit → **Commit to main** → **Push origin**.

Atau lewat terminal di folder proyek:

```bash
git add -A
git commit -m "deskripsi perubahan"
git push
```

---

## 2. Di server VM — tarik & restart

Buka **Google Cloud Console → Compute Engine → VM instances → tombol SSH**, lalu:

```bash
cd ~/idx-scalper
git pull
pm2 restart idx-scalper
```

Selesai. Web langsung memakai kode terbaru.

> 🔒 **Aman:** `git pull` **tidak menyentuh** file `.env` (password) dan folder `data/`
> (token Stockbit, session, cache) karena keduanya di-ignore git. Yang berubah hanya kode.

---

## Pertama kali saja (kalau server belum terhubung git)

Hanya dijalankan **sekali** jika `git pull` error `command not found` atau folder belum terhubung:

```bash
sudo apt-get update && sudo apt-get install -y git
cd ~/idx-scalper
git init
git remote add origin https://github.com/hartonowilly/idx-scalper.git
git fetch origin
git reset --hard origin/main
git branch -M main
git branch --set-upstream-to=origin/main main
pm2 restart idx-scalper
```

Setelah ini, cukup pakai **Langkah 2** untuk update berikutnya.

---

## Perintah pm2 yang sering dipakai

| Tujuan | Perintah |
|---|---|
| Lihat status app | `pm2 status` |
| Lihat log (error/aktivitas) | `pm2 logs idx-scalper` |
| Restart app | `pm2 restart idx-scalper` |
| Restart tunnel (URL web) | `pm2 restart tunnel` |
| Lihat URL web (cloudflared) | `pm2 logs tunnel --lines 40 \| grep trycloudflare` |

---

## Setelah deploy — checklist

- [ ] Buka web, pastikan tampilan baru muncul (header ringkas, 1 jam)
- [ ] Login dengan password dashboard
- [ ] Klik **🔑 Token Stockbit** → paste token baru bila banner merah "Token kedaluwarsa" muncul
