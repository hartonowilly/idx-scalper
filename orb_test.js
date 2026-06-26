// ════════════════════════════════════════════════════════════
//  UJI LOGIKA ORB (Momentum Pagi) — inti: opening-range breakout
//  Entry: tembus opening high (09:00–09:30), ext <3%, RS ≥ +0.5% vs pasar,
//  volume bar ≥ 1.5× baseline. Exit: TP/SL ketat + time-stop 25 menit (5 bar).
//  Data: intraday 5-menit Stockbit (~7 hari terakhir yg ada). Faktor orderbook/
//  asing/spread/SMA tak ada di histori → diuji INTI ORB-nya saja (lebih permisif).
//  Pembanding: "entry pagi buta" (masuk di 09:30 tanpa filter) = base rate.
//
//  Jalankan:  node orb_test.js
// ════════════════════════════════════════════════════════════
const axios = require('axios');
const auth = require('./stockbit_auth');
const { StockbitProvider } = require('./idx_api_providers');

const BASE = 'https://exodus.stockbit.com';
const SYMBOLS = [
  'BBCA','BBRI','BMRI','BBNI','BBTN','BRIS','TLKM','ASII','ICBP','INDF','KLBF',
  'ANTM','ADRO','PTBA','ITMG','MDKA','INCO','UNTR','PGAS','SMGR','CPIN','AKRA',
  'GOTO','ARTO','ISAT','EXCL','MEDC','JSMR','TOWR','AMRT','ACES','MAPI','BREN','AMMN','TPIA',
];
const N_DAYS_TRY = 9, CONCURRENCY = 2, FEE = 0.004;
// Indeks bar 5-menit (asumsi bar[0] ≈ 09:00): opening range 09:00–09:30 = bar 0..5,
// jendela entry 09:30–10:30 = bar 6..18, time-stop 25 menit = 5 bar.
const OR_END = 6, ENTRY_END = 18, TIME_STOP = 5;
const MIN_RS = 0.5, MIN_VOL = 1.5, MAX_EXT = 3.0;

const prov = new StockbitProvider();
function headers() { return { 'Authorization': 'Bearer ' + auth.getAccessToken(), 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Origin': 'https://stockbit.com', 'Referer': 'https://stockbit.com/' }; }
function recentWeekdays(n) { const out = []; const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' })); while (out.length < n) { const w = d.getDay(); if (w !== 0 && w !== 6) out.push(d.toLocaleDateString('en-CA')); d.setDate(d.getDate() - 1); } return out; }
async function fetchDay(sym, date, retried = false) {
  try { const r = await axios.get(`${BASE}/order-trade/trade-book/chart?symbol=${sym}&time_interval=1m&date=${date}`, { headers: headers(), timeout: 12000 }); return prov._parseChart(r.data); }
  catch (e) { const st = e.response?.status; if ((st === 401 || st === 403) && !retried && auth.hasRefresh()) { const rr = await auth.refresh(); if (rr.ok) return fetchDay(sym, date, true); } return []; }
}
async function pool(tasks, lim) { let i = 0; async function w() { while (i < tasks.length) { const k = i++; await tasks[k](); } } await Promise.all(Array.from({ length: lim }, w)); }
function atrPctOf(bars, i) {
  const p = 14; if (i < p) return 0.01; let s = 0;
  for (let k = i - p + 1; k <= i; k++) s += Math.max(bars[k].high - bars[k].low, Math.abs(bars[k].high - bars[k - 1].close), Math.abs(bars[k].low - bars[k - 1].close));
  const atr = s / p; let pct = atr / bars[i].close; return Math.min(0.03, Math.max(0.004, pct || 0.01));
}
// Simulasi exit dari bar entry: TP/SL konservatif dalam `hold` bar, sisanya time-stop.
function simExit(bars, ei, entry, tp, sl, hold) {
  const last = Math.min(bars.length - 1, ei + hold);
  for (let j = ei + 1; j <= last; j++) {
    const tpHit = bars[j].high >= tp, slHit = bars[j].low <= sl;
    if (tpHit && slHit) return (sl - entry) / entry;
    if (tpHit) return (tp - entry) / entry;
    if (slHit) return (sl - entry) / entry;
  }
  return (bars[last].close - entry) / entry; // time-stop
}

(async () => {
  if (!auth.hasToken()) { console.log('❌ Token belum ada.'); process.exit(1); }
  const dates = recentWeekdays(N_DAYS_TRY);
  console.log(`🌐 Tarik intraday 5-menit: ${SYMBOLS.length} saham × ${dates.length} hari (lembut)...`);
  const perDate = {}; dates.forEach(d => perDate[d] = {});
  const jobs = []; for (const d of dates) for (const s of SYMBOLS) jobs.push({ d, s });
  await pool(jobs.map(({ d, s }) => async () => { const b = await fetchDay(s, d); if (b.length >= 25) perDate[d][s] = b; await new Promise(r => setTimeout(r, 220)); }), CONCURRENCY);
  const goodDates = dates.filter(d => Object.keys(perDate[d]).length >= 10);
  console.log(`✅ Hari berdata: ${goodDates.join(', ') || '(tak ada)'}\n`);
  if (!goodDates.length) { console.log('Tak ada data.'); process.exit(0); }

  let orb = [], blind = [];               // return bersih tiap trade (ORB design, time-stop 25')
  let orbClose = [], blindClose = [];     // return bila ditahan ke akhir hari
  for (const d of goodDates) {
    const syms = Object.keys(perDate[d]);
    const minLen = Math.min(...syms.map(s => perDate[d][s].length));
    if (minLen <= ENTRY_END + 2) continue;
    // rata-rata perubahan pasar per bar (utk RS)
    const mktCh = [];
    for (let i = 0; i < minLen; i++) { let sum = 0, n = 0; for (const s of syms) { const b = perDate[d][s]; const o = b[0].open || b[0].close; if (o > 0) { sum += (b[i].close - o) / o * 100; n++; } } mktCh[i] = n ? sum / n : 0; }

    for (const s of syms) {
      const b = perDate[d][s]; if (b.length <= ENTRY_END + 2) continue;
      const open0 = b[0].open || b[0].close;
      const orHigh = Math.max(...b.slice(0, OR_END).map(x => x.high));
      const orVol = b.slice(0, OR_END).reduce((a, x) => a + (x.volume || 0), 0) / OR_END || 1;

      // ── ENTRY ORB: bar pertama di jendela yg penuhi syarat ──
      let ei = -1;
      for (let i = OR_END; i <= ENTRY_END; i++) {
        const price = b[i].close;
        const ext = (price - orHigh) / orHigh * 100;
        const volR = (b[i].volume || 0) / orVol;
        const rs = (price - open0) / open0 * 100 - (mktCh[i] || 0);
        if (price > orHigh && ext <= MAX_EXT && volR >= MIN_VOL && rs >= MIN_RS) { ei = i; break; }
      }
      if (ei >= 0) {
        const entry = b[ei].close, ap = atrPctOf(b, ei);
        const tp = Math.max(entry * (1 + Math.max(ap * 1.5, 0.01)), orHigh * 1.01);
        const sl = Math.max(orHigh * 0.995, entry * (1 - ap));
        orb.push(simExit(b, ei, entry, tp, sl, TIME_STOP) - FEE);
        orbClose.push((b[b.length - 1].close - entry) / entry - FEE);
      }
      // ── BASE: entry "buta" di awal jendela (09:30) tanpa filter ──
      const bi = OR_END, be = b[bi].close, bap = atrPctOf(b, bi);
      const btp = be * (1 + Math.max(bap * 1.5, 0.01)), bsl = be * (1 - bap);
      blind.push(simExit(b, bi, be, btp, bsl, TIME_STOP) - FEE);
      blindClose.push((b[b.length - 1].close - be) / be - FEE);
    }
  }
  const stat = arr => { const n = arr.length; const w = arr.filter(x => x > 0).length; const avg = n ? arr.reduce((a, x) => a + x, 0) / n * 100 : 0; return { n, wr: n ? w / n * 100 : 0, avg }; };
  const oA = stat(orb), bA = stat(blind), oC = stat(orbClose), bC = stat(blindClose);
  const pc = x => (x >= 0 ? '+' : '') + x.toFixed(2);

  console.log('=== HASIL UJI ORB (sampel ' + goodDates.length + ' hari) ===');
  console.log('Exit ala ORB (TP/SL + time-stop 25 menit):');
  console.log(`  ORB (terfilter) : ${oA.n} trade | winRate ${oA.wr.toFixed(1)}% | avgNet ${pc(oA.avg)}%`);
  console.log(`  Entry pagi BUTA : ${bA.n} trade | winRate ${bA.wr.toFixed(1)}% | avgNet ${pc(bA.avg)}%`);
  console.log(`  → ORB ${oA.avg - bA.avg > 0.05 ? 'LEBIH BAIK ✅' : oA.avg - bA.avg < -0.05 ? 'LEBIH BURUK ❌' : 'SAMA SAJA 🟡'} (selisih avgNet ${pc(oA.avg - bA.avg)}%)`);
  console.log('\nBila ditahan sampai TUTUP (bukan 25 menit):');
  console.log(`  ORB (terfilter) : winRate ${oC.wr.toFixed(1)}% | avgNet ${pc(oC.avg)}%`);
  console.log(`  Entry pagi BUTA : winRate ${bC.wr.toFixed(1)}% | avgNet ${pc(bC.avg)}%`);
  console.log('\n⚠️ Catatan: sampel ~7 hari (Stockbit simpan intraday singkat) → SUGESTIF, belum definitif.');
  console.log('Faktor orderbook/asing/spread/SMA tak diuji (tak ada di histori) → ini menguji INTI ORB.');
  process.exit(0);
})();
