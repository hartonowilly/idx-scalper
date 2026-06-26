// ════════════════════════════════════════════════════════════
//  APAKAH FILTER MA50/MA200 MEMBANTU? — uji di sinyal beli program
//  Bandingkan return (beli→tahan 10 hari) sinyal beli PRODUKSI:
//   - tanpa filter
//   - + price > MA200            (saham di atas tren jangka panjang)
//   - + MA50 > MA200             (golden cross / regime naik)
//   - + price > MA50 > MA200     (uptrend sejajar penuh)
//  Data ~5 tahun LQ45 (cukup utk MA200, mencakup naik-turun penuh).
//  Jalankan:  node ma_filter_test.js
// ════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { backtestFactorScores, backtestDecision, BT_THRESHOLD, calculateSMA } = require('./server');

const CACHE = path.join(__dirname, 'data', '_ma_lq45.json');
const LQ45 = [
  'ACES','ADMR','ADRO','AKRA','AMMN','AMRT','ANTM','ARTO','ASII','BBCA','BBNI','BBRI',
  'BBTN','BMRI','BRIS','BREN','BRPT','CPIN','CTRA','ESSA','EXCL','GOTO','ICBP','INCO',
  'INDF','INKP','ISAT','ITMG','JSMR','KLBF','MAPA','MAPI','MBMA','MDKA','MEDC','PGAS',
  'PGEO','PTBA','SMGR','SMRA','TLKM','TOWR','TPIA','UNTR','UNVR',
];
const FROM = '2021-01-01', FEE = 0.004, HOLD = 10, START = 200; // perlu 200 bar utk MA200

async function fetchDaily(sym) {
  const p1 = Math.floor(new Date(FROM).getTime() / 1000), p2 = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}.JK?period1=${p1}&period2=${p2}&interval=1d`;
  try {
    const r = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 20000 });
    const res = r.data?.chart?.result?.[0]; const ts = res?.timestamp || [], q = res?.indicators?.quote?.[0] || {};
    const b = [];
    for (let i = 0; i < ts.length; i++) { if (q.close?.[i] == null || q.open?.[i] == null) continue; b.push({ open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 }); }
    return b;
  } catch { return []; }
}
async function loadData() {
  if (fs.existsSync(CACHE)) return JSON.parse(fs.readFileSync(CACHE, 'utf8')).bars;
  console.log(`🌐 Menarik ~5 tahun harian LQ45 (Yahoo, sejak ${FROM})...`);
  const bars = {};
  for (const s of LQ45) { bars[s] = await fetchDaily(s); await new Promise(r => setTimeout(r, 110)); }
  fs.writeFileSync(CACHE, JSON.stringify({ fetchedAt: new Date().toISOString(), bars }, null, 0));
  return bars;
}

const acc = () => ({ n: 0, w: 0, ret: 0 });
const add = (a, r) => { a.n++; if (r > 0) a.w++; a.ret += r; };
const fmt = a => a.n ? `${String(a.n).padStart(5)} | ${(a.w / a.n * 100).toFixed(1).padStart(5)}% | ${(a.ret / a.n * 100 >= 0 ? '+' : '') + (a.ret / a.n * 100).toFixed(2)}%` : '    0 |     — |     —';

(async () => {
  const data = await loadData();
  const usable = Object.values(data).filter(b => Array.isArray(b) && b.length >= START + HOLD + 5);
  const totBars = usable.reduce((a, b) => a + b.length, 0);
  console.log(`📊 ${usable.length} saham · ${totBars} bar harian (~5thn) · beli→tahan ${HOLD} hari · fee 0.4%\n`);

  const G = { sig: acc(), sigMa200: acc(), sigGolden: acc(), sigFull: acc(), base: acc() };
  for (const bars of usable) {
    const closes = bars.map(b => b.close), highs = bars.map(b => b.high), lows = bars.map(b => b.low), vols = bars.map(b => b.volume);
    for (let i = START; i < bars.length - 1 - HOLD; i++) {
      const entry = bars[i + 1].open || closes[i];
      const r = (closes[i + HOLD] - entry) / entry - FEE;
      add(G.base, r);
      const fsx = backtestFactorScores(closes, highs, lows, vols, i);
      if (!backtestDecision(fsx, BT_THRESHOLD, null)) continue;
      add(G.sig, r);
      const sub = closes.slice(0, i + 1);
      const ma50 = calculateSMA(sub, 50), ma200 = calculateSMA(sub, 200), price = closes[i];
      if (price > ma200) add(G.sigMa200, r);
      if (ma50 > ma200) add(G.sigGolden, r);
      if (price > ma50 && ma50 > ma200) add(G.sigFull, r);
    }
  }
  console.log('saringan                          |     n | win%  | rata²return(10hr)');
  console.log('----------------------------------|-------|-------|------------------');
  console.log(`Acak (semua hari)                 | ${fmt(G.base)}`);
  console.log(`Sinyal beli (tanpa filter MA)     | ${fmt(G.sig)}`);
  console.log(`Sinyal + price > MA200            | ${fmt(G.sigMa200)}`);
  console.log(`Sinyal + MA50 > MA200 (golden)    | ${fmt(G.sigGolden)}`);
  console.log(`Sinyal + price>MA50>MA200 (penuh) | ${fmt(G.sigFull)}`);
  console.log('\nKalau baris berfilter MA return-nya LEBIH TINGGI dari "tanpa filter" → MA50/MA200 MEMBANTU.');
  console.log('Periode 2021–2026 mencakup bull 21/22, koreksi, rally 24, crash 25, bounce 26 (siklus penuh).');
  process.exit(0);
})();
