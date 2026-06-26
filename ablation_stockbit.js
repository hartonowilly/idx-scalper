// ════════════════════════════════════════════════════════════
//  ABLATION DI DATA INTRADAY STOCKBIT (5-menit, multi-hari)
//  Menarik candle 5-menit asli beberapa hari ke belakang dari Stockbit,
//  memperlakukan tiap (saham × hari) sebagai seri terpisah (VWAP/high reset
//  harian), lalu menjalankan leave-one-out ablation pada MODEL PRODUKSI.
//
//  Jalankan:  node ablation_stockbit.js
//  Hasil mentah di-cache ke data/_ablation_intraday.json (hapus utk tarik ulang).
// ════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const auth = require('./stockbit_auth');
const { StockbitProvider } = require('./idx_api_providers');
const { runBacktest, runAblation } = require('./server'); // server tidak menyala (require.main guard)

const BASE = 'https://exodus.stockbit.com';
const CACHE = path.join(__dirname, 'data', '_ablation_intraday.json');

// Saham likuid representatif (LQ45 inti) — cukup untuk ablation yang bermakna.
const SYMBOLS = [
  'BBCA','BBRI','BMRI','BBNI','TLKM','ASII','UNVR','ICBP','INDF','KLBF',
  'ANTM','ADRO','PTBA','ITMG','MDKA','INCO','UNTR','PGAS','SMGR','CPIN',
  'AKRA','GOTO','ARTO','BRIS','ISAT','EXCL','MEDC','INKP','JSMR','TPIA',
  'AMRT','ACES','MAPI','TOWR','BREN',
];
const N_TRADING_DAYS = 8;   // berapa hari bursa ke belakang
const MIN_BARS = 25;        // minimal candle/hari agar layak di-backtest
const CONCURRENCY = 6;      // request paralel maks (sopan ke rate-limit)

function recentWeekdays(n) {
  const out = [];
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
  d.setDate(d.getDate() - 1); // mulai dari kemarin (hari ini sering belum lengkap)
  while (out.length < n + 4) {  // ambil lebih, nanti tersaring oleh hari libur (0 candle)
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) out.push(d.toLocaleDateString('en-CA'));
    d.setDate(d.getDate() - 1);
  }
  return out;
}

function headers() {
  return {
    'Authorization': 'Bearer ' + auth.getAccessToken(),
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'application/json', 'Origin': 'https://stockbit.com', 'Referer': 'https://stockbit.com/',
  };
}

const prov = new StockbitProvider();

async function fetchDay(symbol, date, retried = false) {
  try {
    const url = `${BASE}/order-trade/trade-book/chart?symbol=${symbol}&time_interval=1m&date=${date}`;
    const r = await axios.get(url, { headers: headers(), timeout: 12000 });
    return prov._parseChart(r.data); // resample ke candle 5-menit (logika produksi)
  } catch (e) {
    const st = e.response?.status;
    if ((st === 401 || st === 403) && !retried && auth.hasRefresh()) {
      const rr = await auth.refresh();
      if (rr.ok) return fetchDay(symbol, date, true);
    }
    return [];
  }
}

// Pool sederhana dengan batas konkurensi.
async function pool(tasks, limit) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

async function buildDataMap() {
  if (fs.existsSync(CACHE)) {
    const raw = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    const map = new Map(Object.entries(raw.series));
    console.log(`📦 Cache dipakai: ${map.size} seri (saham×hari) dari ${raw.fetchedAt}`);
    console.log('   (hapus data/_ablation_intraday.json untuk tarik ulang dari Stockbit)\n');
    return map;
  }

  const dates = recentWeekdays(N_TRADING_DAYS);
  console.log(`🌐 Menarik intraday 5-menit dari Stockbit: ${SYMBOLS.length} saham × ${dates.length} kandidat hari...`);
  const jobs = [];
  for (const sym of SYMBOLS) for (const date of dates) jobs.push({ sym, date });

  const series = {};
  let done = 0, kept = 0;
  const tasks = jobs.map(({ sym, date }) => async () => {
    const bars = await fetchDay(sym, date);
    done++;
    if (bars.length >= MIN_BARS) { series[`${sym}@${date}`] = bars; kept++; }
    if (done % 40 === 0) console.log(`   ...${done}/${jobs.length} request (terkumpul ${kept} seri)`);
  });
  await pool(tasks, CONCURRENCY);

  fs.writeFileSync(CACHE, JSON.stringify({ fetchedAt: new Date().toISOString(), series }, null, 0));
  console.log(`✅ Selesai: ${kept} seri layak (≥${MIN_BARS} candle) tersimpan ke cache.\n`);
  return new Map(Object.entries(series));
}

function pct(x) { return (x >= 0 ? '+' : '') + x.toFixed(2); }

(async () => {
  if (!auth.hasToken()) { console.log('❌ Token Stockbit belum ada.'); process.exit(1); }
  const map = await buildDataMap();
  if (!map.size) { console.log('❌ Tidak ada data terkumpul.'); process.exit(1); }

  const totalBars = Array.from(map.values()).reduce((a, b) => a + b.length, 0);
  console.log(`📊 Dataset: ${map.size} seri (saham×hari), ${totalBars} candle 5-menit asli\n`);

  const bt = runBacktest(map);
  console.log('=== BASELINE (model penuh, 9 faktor) ===');
  console.log(`trades=${bt.trades}  winRate=${bt.winRate.toFixed(1)}%  avgNet=${pct(bt.avgNet)}%  totalNet=${pct(bt.totalNet)}%\n`);

  const ab = runAblation(map);
  console.log('=== ABLATION (leave-one-out) ===');
  console.log('Δ negatif winRate/avgNet = faktor BERGUNA · Δ≈0 = redundan · Δ positif = MERUGIKAN\n');
  console.log('faktor    | bobot | trades | winRate |  avgNet | ΔwinRate | ΔavgNet | Δtrades | vonis');
  console.log('----------|-------|--------|---------|---------|----------|---------|---------|------');
  for (const r of ab.ablation) {
    const verdict = (r.dWinRate <= -1.5 || r.dAvgNet <= -0.03) ? '🟢 berguna'
      : (r.dWinRate >= 1.5 || r.dAvgNet >= 0.03) ? '🔴 merugikan'
      : '🟡 redundan';
    console.log(
      r.factor.padEnd(9) + ' | ' +
      r.weight.toFixed(2).padStart(5) + ' | ' +
      String(r.trades).padStart(6) + ' | ' +
      (r.winRate.toFixed(1) + '%').padStart(7) + ' | ' +
      (pct(r.avgNet) + '%').padStart(7) + ' | ' +
      pct(r.dWinRate).padStart(8) + ' | ' +
      pct(r.dAvgNet).padStart(7) + ' | ' +
      (r.dTrades >= 0 ? '+' : '') + String(r.dTrades).padStart(r.dTrades >= 0 ? 6 : 7) + ' | ' +
      verdict
    );
  }
  console.log('\nTak diuji (konstan di histori, butuh data orderbook/asing live):', ab.notExercised.join(', '));
  process.exit(0);
})();
