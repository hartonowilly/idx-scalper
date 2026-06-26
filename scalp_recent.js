// ════════════════════════════════════════════════════════════
//  UJI SCALPING DI HARI-HARI RECOVERY TERAKHIR
//  Menarik intraday 5-menit beberapa hari bursa terakhir dari Stockbit,
//  lalu menjalankan MODEL SCALPING PRODUKSI (runStrategyOverHistory) per hari.
//  Dua angka: (a) "apa adanya program" (fill optimis, seperti skoring live),
//  (b) "jujur" (fill konservatif + time-stop akhir hari → tiap trade diselesaikan).
//
//  Jalankan:  node scalp_recent.js
// ════════════════════════════════════════════════════════════
const axios = require('axios');
const auth = require('./stockbit_auth');
const { StockbitProvider } = require('./idx_api_providers');
const { runStrategyOverHistory } = require('./server'); // server tidak menyala (require.main guard)

const BASE = 'https://exodus.stockbit.com';
const SYMBOLS = [
  'BBCA','BBRI','BMRI','BBNI','BBTN','BRIS','TLKM','ASII','ICBP','INDF','KLBF',
  'ANTM','ADRO','PTBA','ITMG','MDKA','INCO','UNTR','PGAS','SMGR','CPIN','AKRA',
  'GOTO','ARTO','ISAT','EXCL','MEDC','JSMR','TOWR','AMRT','ACES','MAPI','BREN','AMMN','TPIA',
];
const N_DAYS_TRY = 9;     // coba 9 hari bursa terakhir (yg terbaru kadang belum ada data)
const RECOVERY_DAYS = 3;  // fokus 3 hari TERBARU yang ada datanya
const CONCURRENCY = 2;    // lembut + jeda → endpoint throttle bila terlalu ramai

const prov = new StockbitProvider();
function headers() {
  return { 'Authorization': 'Bearer ' + auth.getAccessToken(), 'User-Agent': 'Mozilla/5.0',
    'Accept': 'application/json', 'Origin': 'https://stockbit.com', 'Referer': 'https://stockbit.com/' };
}
function recentWeekdays(n) {
  const out = [];
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
  while (out.length < n) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) out.push(d.toLocaleDateString('en-CA'));
    d.setDate(d.getDate() - 1);
  }
  return out; // baru → lama
}
async function fetchDay(symbol, date, retried = false) {
  try {
    const url = `${BASE}/order-trade/trade-book/chart?symbol=${symbol}&time_interval=1m&date=${date}`;
    const r = await axios.get(url, { headers: headers(), timeout: 12000 });
    return prov._parseChart(r.data); // candle 5-menit (logika produksi)
  } catch (e) {
    const st = e.response?.status;
    if ((st === 401 || st === 403) && !retried && auth.hasRefresh()) {
      const rr = await auth.refresh(); if (rr.ok) return fetchDay(symbol, date, true);
    }
    return [];
  }
}
async function pool(tasks, limit) {
  let i = 0;
  async function w() { while (i < tasks.length) { const k = i++; await tasks[k](); } }
  await Promise.all(Array.from({ length: limit }, w));
}
const pct = x => (x >= 0 ? '+' : '') + x.toFixed(2);

(async () => {
  if (!auth.hasToken()) { console.log('❌ Token Stockbit belum ada.'); process.exit(1); }
  const dates = recentWeekdays(N_DAYS_TRY);
  console.log(`🌐 Menarik intraday 5-menit: ${SYMBOLS.length} saham × ${dates.length} hari terakhir...`);

  // map per tanggal: Map(symbol → bars)
  const perDate = {};
  for (const d of dates) perDate[d] = new Map();
  const jobs = [];
  for (const d of dates) for (const s of SYMBOLS) jobs.push({ d, s });
  let done = 0;
  await pool(jobs.map(({ d, s }) => async () => {
    const bars = await fetchDay(s, d);
    done++;
    if (bars.length >= 25) perDate[d].set(s, bars);
    await new Promise(r => setTimeout(r, 220)); // jeda anti-throttle
  }), CONCURRENCY);

  console.log('Saham layak per tanggal: ' + dates.map(d => `${d.slice(5)}=${perDate[d].size}`).join('  '));
  // hari yang benar-benar punya data (≥10 saham layak)
  const goodDates = dates.filter(d => perDate[d].size >= 10);
  console.log(`✅ Hari dengan data lengkap: ${goodDates.join(', ') || '(tidak ada)'}\n`);
  if (!goodDates.length) { console.log('Tak ada data intraday memadai.'); process.exit(0); }

  const optimistic = { fill: 'optimistic' };               // seperti skoring program apa adanya
  const honest     = { fill: 'conservative', holdBars: 18 }; // tiap trade selesai (time-stop ~90 mnt)

  console.log('=== WIN RATE SCALPING PER HARI (model produksi) ===');
  console.log('tanggal      | saham | trades | winRate(apa-adanya) | winRate(jujur) | avgNet(jujur)');
  console.log('-------------|-------|--------|---------------------|----------------|-------------');
  for (const d of goodDates) {
    const o = runStrategyOverHistory(null, perDate[d], optimistic);
    const h = runStrategyOverHistory(null, perDate[d], honest);
    console.log(
      d + ' | ' + String(perDate[d].size).padStart(5) + ' | ' +
      String(h.trades).padStart(6) + ' | ' +
      (o.winRate.toFixed(1) + '%').padStart(19) + ' | ' +
      (h.winRate.toFixed(1) + '%').padStart(14) + ' | ' + pct(h.avgNet) + '%');
  }

  // Gabungan 3 hari terakhir (recovery)
  const recDates = goodDates.slice(0, RECOVERY_DAYS);
  const merged = new Map();
  recDates.forEach(d => perDate[d].forEach((bars, s) => merged.set(`${s}@${d}`, bars)));
  const O = runStrategyOverHistory(null, merged, optimistic);
  const H = runStrategyOverHistory(null, merged, honest);
  console.log(`\n=== GABUNGAN ${recDates.length} HARI RECOVERY (${recDates.join(', ')}) ===`);
  console.log(`Trade: ${H.trades}`);
  console.log(`Win rate "apa adanya program" (fill optimis): ${O.winRate.toFixed(1)}%  (avgNet ${pct(O.avgNet)}%)`);
  console.log(`Win rate JUJUR (tiap trade diselesaikan):     ${H.winRate.toFixed(1)}%  (avgNet ${pct(H.avgNet)}%, totalNet ${pct(H.totalNet)}%)`);
  console.log('\nCatatan: "apa adanya" membuang trade yg tak kena TP/SL → win rate terlihat lebih tinggi dari kenyataan.');
  process.exit(0);
})();
