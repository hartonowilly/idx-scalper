# 📈 Indonesia Stock Scalper (Stockbit)

Dashboard web real-time untuk scalping saham IDX. Memantau saham-saham paling likuid
di Bursa Efek Indonesia, menghitung sinyal teknikal scalping (RSI, SMA, volume spike),
dan menampilkan rekomendasi BELI dengan harga masuk, target (TP), dan cut loss (SL).

**Sumber data: Stockbit saja** (real-time harga + volume + data asing). Tidak memakai
Yahoo Finance / IDX Official / Twelve Data lagi.

---

## 🚀 Cara Menjalankan

### Prasyarat
- Node.js 16+

### Langkah
```bash
npm install
node server.js
```
Buka `http://localhost:3001` di browser.

### Login data (wajib, sekali saja)
Dashboard butuh token Stockbit untuk mengambil data. Klik tombol **🔑 Token Stockbit**
di kanan atas, lalu ikuti panduan di **[PANDUAN_TOKEN_STOCKBIT.md](PANDUAN_TOKEN_STOCKBIT.md)**.
Singkatnya: login di stockbit.com → F12 → Cookies → copy isi cookie `credential storage`
→ paste di modal. Token diperpanjang otomatis (tidak perlu login ulang tiap hari).

---

## 🧠 Logika Scalping

- **Hanya BELI** (retail IDX tidak bisa short).
- **Entry**: momentum + volume spike (RSI 45–70, harga > SMA20, SMA5 > SMA20).
- **Take Profit**: +1.0%  •  **Cut Loss**: −0.5%.
- **Filter keras**: skip saham yang sudah naik >7% (risiko ARA), turun < −5%
  (falling knife), atau RSI > 72 (overbought).
- **Anti-gorengan** (default ON): saham non-LQ45 di bawah Rp200, mid-cap tipis,
  spike volume, retail frenzy, dan pump tanpa asing — dikecualikan dari BELI &
  watchlist Movers (Papan Utama saja). Blocklist manual: `data/gorengan_blocklist.json`.
- **TP/SL dinamis** mengikuti volatilitas (ATR), Risk/Reward ~2:1 — tidak dipatok 1%.
- **Confidence kontinu 0–100%** dari gabungan volume, momentum, RSI, tren, & aliran asing.
- Riwayat candle (RSI/SMA) di-**seed dari Stockbit** saat start, lalu di-update live
  dan disimpan ke `data/price_history.json` (tahan restart).

---

## 📂 Struktur Proyek

| File | Fungsi |
|------|--------|
| `server.js` | Backend Express + Socket.IO, update data berkala, analisis sinyal |
| `gorengan_filter.js` | Heuristik saring saham rawan gorengan (non-LQ45, spike, frenzy) |
| `idx_api_providers.js` | Pengambil data dari Stockbit + util harga IDX |
| `stockbit_auth.js` | Manajemen token Stockbit (simpan, auto-refresh) |
| `public/index.html` | Dashboard web (UI) |
| `data/stockbit_token.json` | Token tersimpan (jangan dibagikan) |
| `data/stock_cache.json` | Cache data terakhir (untuk tampilan saat pasar tutup) |
| `data/price_history.json` | Riwayat candle untuk RSI/SMA (tahan restart) |

---

## 📡 API Endpoints

| Method | Endpoint | Fungsi |
|--------|----------|--------|
| GET  | `/api/stocks` | Semua data saham terpantau |
| GET  | `/api/recommendations` | Rekomendasi BELI (confidence > 40%) |
| GET  | `/api/stockbit/status` | Status token Stockbit |
| POST | `/api/stockbit/token` | Set token (`raw` = isi cookie credential storage) |
| POST | `/api/stockbit/refresh` | Paksa refresh access token |

WebSocket: `initialData` (load awal), `stockUpdate` (update real-time).

---

## 🕐 Jam Pasar
- Aktif: Senin–Jumat, 09:00–15:00 WIB (Asia/Jakarta).
- Update tiap 10 menit saat jam pasar, 20 menit di luar jam pasar (hemat resource).

---

## ⚠️ Disclaimer
Alat ini untuk edukasi & informasi. Trading saham berisiko tinggi. Selalu lakukan
riset sendiri dan gunakan manajemen risiko. Jangan investasi melebihi kemampuanmu.
Disarankan memakai akun Stockbit khusus (tanpa dana) untuk token dashboard ini.
