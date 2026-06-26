# Panduan Login Stockbit (Token) — Copy-Paste untuk Akun Mana Saja

Dashboard scalper mengambil data harga real-time dari **Stockbit**. Karena Stockbit
memblokir login otomatis (username/password), kita pakai cara resmi & aman:
**tempel token sesi** dari browser. Cukup **satu kali paste**, lalu program
memperpanjang sesi otomatis — **tidak perlu login ulang tiap hari**.

> Bisa pakai **akun Stockbit siapa saja**. Disarankan pakai akun khusus tanpa dana
> di dalamnya (akun "scalper") demi keamanan.

---

## Cara Tercepat (rekomendasi)

1. **Jalankan server**
   ```bash
   node server.js
   ```
   Buka `http://localhost:3001` di browser.

2. **Login Stockbit di browser**
   Buka [https://stockbit.com](https://stockbit.com) (Chrome/Firefox), login dengan akunmu.

3. **Buka Developer Tools** → tekan **F12**.
   - **Chrome/Edge:** tab **Application**
   - **Firefox:** tab **Storage**

4. **Masuk ke Cookies**
   Di panel kiri, buka **Cookies** → klik **`https://stockbit.com`**.

5. **Ambil cookie `credential storage`**
   Cari baris dengan nama **`credential storage`**.
   Klik baris itu, lalu **copy seluruh isi kolom Value**. Nilainya panjang dan
   diawali seperti:
   ```
   {%22state%22:{%22access%22:{%22token%22:%22eyJ...
   ```

6. **Tempel ke dashboard**
   - Di dashboard, klik tombol **🔑 Token Stockbit** (kanan atas).
   - Tempel teks tadi ke kotak **"Paste isi cookie credential storage"**.
   - Klik **Simpan & Aktifkan**.

   Program otomatis mengekstrak **access token** dan **refresh token** dari teks itu.
   Selesai — data harga akan mulai masuk dalam beberapa detik.

---

## Kenapa cara ini?

- **Access token** Stockbit hanya berlaku ±24 jam.
- **Refresh token** berlaku ±7 hari dan dipakai program untuk membuat access token
  baru otomatis (cek tiap 15 menit & saat token mau habis).
- Jadi selama refresh token masih hidup (≤7 hari), kamu **tidak perlu paste lagi**.
  Kalau sudah lewat 7 hari, cukup ulangi langkah di atas sekali lagi.

---

## Pilihan lain (kalau tidak mau paste seluruh cookie)

Kotak yang sama juga menerima:
- **Hanya refresh token** (string `eyJ...` dari `state.refresh.token`) — program akan
  langsung menukarnya menjadi access token.
- **Hanya access token** (string `eyJ...` dari `state.access.token`) — aktif cepat,
  tapi akan kedaluwarsa ±24 jam dan perlu paste ulang (tidak auto-perpanjang).

---

## Penting / Troubleshooting

- ❌ **Jangan** pakai `eipoRefreshToken` dari **Local Storage** — itu token untuk fitur
  **e-IPO**, bukan sesi utama, dan akan ditolak.
- Kalau muncul "Gagal / token tidak valid": pastikan kamu mengcopy **value cookie
  `credential storage`** (bukan nama cookie, bukan local storage).
- Status token bisa dicek kapan saja di banner & modal (Access: ada/kosong,
  Refresh: ada/auto-perpanjang, sisa menit).
- Token disimpan lokal di file `data/stockbit_token.json` (jangan dibagikan ke siapa pun).

---

## Cara cek status via API (opsional)

```bash
# Lihat status token
curl http://localhost:3001/api/stockbit/status

# Set token dari blob credential storage
curl -X POST http://localhost:3001/api/stockbit/token \
  -H "Content-Type: application/json" \
  -d "{\"raw\": \"<isi cookie credential storage>\"}"

# Paksa refresh sekarang
curl -X POST http://localhost:3001/api/stockbit/refresh
```
