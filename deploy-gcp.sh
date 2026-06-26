#!/usr/bin/env bash
# ============================================================
#  IDX Scalper — Setup OTOMATIS di VM Linux (Debian/Ubuntu, mis. Google Cloud e2-micro)
#  Memasang: Node.js 20 + pm2 + cloudflared, lalu menjalankan app + HTTPS tunnel.
#  Cara pakai (dari DALAM folder app):   bash deploy-gcp.sh
# ============================================================
set -e
cd "$(dirname "$0")"
echo "════════════ IDX Scalper — Setup VM ════════════"

# 1) Node.js LTS (v20)
if ! command -v node >/dev/null 2>&1; then
  echo "▶ Memasang Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "✔ Node $(node -v)"

# 2) pm2 (penjaga proses — auto-restart & auto-boot)
command -v pm2 >/dev/null 2>&1 || { echo "▶ Memasang pm2..."; sudo npm install -g pm2; }
echo "✔ pm2 $(pm2 -v)"

# 3) cloudflared (HTTPS tunnel gratis — tak perlu buka firewall)
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "▶ Memasang cloudflared..."
  ARCH=$(dpkg --print-architecture)   # amd64 atau arm64
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}" -o /tmp/cloudflared
  sudo install -m 0755 /tmp/cloudflared /usr/local/bin/cloudflared
  rm -f /tmp/cloudflared
fi
echo "✔ cloudflared terpasang"

# 4) Dependency app
echo "▶ npm install (mohon tunggu)..."
npm install --omit=dev

# 5) File .env — PASSWORD dashboard WAJIB kuat (bukan 'scalper123')
if [ ! -f .env ]; then
  echo ""
  read -rp "▶ Set DASHBOARD_PASSWORD (password kuat untuk login): " DPASS
  if [ -z "$DPASS" ] || [ "$DPASS" = "scalper123" ]; then
    echo "❌ Password kosong/default tidak diizinkan. Jalankan ulang skrip."; exit 1
  fi
  printf "PORT=3001\nDASHBOARD_PASSWORD=%s\nNODE_ENV=production\n" "$DPASS" > .env
  echo "✔ .env dibuat"
else
  echo "✔ .env sudah ada (dipakai apa adanya)"
fi

# 6) Jalankan app dengan pm2 + auto-start saat reboot
echo "▶ Menjalankan app..."
pm2 start ecosystem.config.js 2>/dev/null || pm2 restart idx-scalper
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u "$USER" --hp "$HOME" 2>/dev/null | grep -E '^sudo ' | bash || true

# 7) HTTPS tunnel (cloudflared di bawah pm2 → persisten, tahan SSH ditutup)
echo "▶ Menyalakan HTTPS tunnel..."
pm2 delete tunnel >/dev/null 2>&1 || true
pm2 start cloudflared --name tunnel -- tunnel --url http://localhost:3001
pm2 save
sleep 9
URL=$(pm2 logs tunnel --lines 80 --nostream 2>/dev/null | grep -oE 'https://[a-z0-9.-]+\.trycloudflare\.com' | head -1)

echo ""
echo "════════════════════════════════════════════════"
if [ -n "$URL" ]; then
  echo "✅ DASHBOARD ONLINE — akses dari mana saja:"
  echo "   $URL"
else
  echo "⏳ URL belum muncul. Tunggu 10 detik lalu jalankan:"
  echo "   pm2 logs tunnel --lines 40 | grep trycloudflare"
fi
echo "════════════════════════════════════════════════"
echo "• Login pakai password yang kamu set tadi."
echo "• Lalu klik tombol 'Token Stockbit' → masukkan token (pakai akun TANPA dana)."
echo "• Cek status:  pm2 status        Lihat log:  pm2 logs idx-scalper"
echo "• Catatan: URL trycloudflare BERUBAH tiap tunnel restart. Mau URL TETAP? minta aku pandu 'named tunnel'."
