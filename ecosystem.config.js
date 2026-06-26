// Konfigurasi PM2 — menjaga app tetap hidup & auto-restart.
// Jalankan:  pm2 start ecosystem.config.js
module.exports = {
  apps: [{
    name: 'idx-scalper',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '400M',
    env: {
      NODE_ENV: 'production',
      // PORT & DASHBOARD_PASSWORD diambil dari file .env (lihat .env.example)
    },
  }],
};
