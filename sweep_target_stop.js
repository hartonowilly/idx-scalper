// ════════════════════════════════════════════════════════════
//  SWEEP TARGET (TP) × STOP (SL) — cari aturan exit terbaik utk edge sinyal
//  Sinyal beli = model produksi (backtestDecision), data harian LQ45.
//  Diuji di DUA regime: pasar NAIK (2021-06→2022-06) & RECENT (bear+bounce).
//  Tiap kombinasi: net/trade sinyal vs base (acak), jendela 10 hari, fee 0.4%.
//
//  Jalankan:  node sweep_target_stop.js
// ════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { backtestFactorScores, backtestDecision, BT_THRESHOLD } = require('./server');

const LQ45 = [
  'ACES','ADMR','ADRO','AKRA','AMMN','AMRT','ANTM','ARTO','ASII','BBCA','BBNI','BBRI',
  'BBTN','BMRI','BRIS','BREN','BRPT','CPIN','CTRA','ESSA','EXCL','GOTO','ICBP','INCO',
  'INDF','INKP','ISAT','ITMG','JSMR','KLBF','MAPA','MAPI','MBMA','MDKA','MEDC','PGAS',
  'PGEO','PTBA','SMGR','SMRA','TLKM','TOWR','TPIA','UNTR','UNVR',
];
const FEE = 0.004, WINDOW = 10, MIN_BARS = 60;
const TPS = [0.015, 0.02, 0.03, 0.04, 0.05];
const SLS = [0.01, 0.015, 0.02, 0.03];

async function fetchDaily(sym, from, to) {
  const p1 = Math.floor(new Date(from).getTime() / 1000), p2 = Math.floor(new Date(to).getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}.JK?period1=${p1}&period2=${p2}&interval=1d`;
  try {
    const r = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 });
    const res = r.data?.chart?.result?.[0]; const ts = res?.timestamp || [], q = res?.indicators?.quote?.[0] || {};
    const b = [];
    for (let i = 0; i < ts.length; i++) { if (q.close?.[i] == null || q.open?.[i] == null) continue; b.push({ open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 }); }
    return b;
  } catch { return []; }
}
async function loadPeriod(tag, from, to) {
  const cache = path.join(__dirname, 'data', `_ss_${from}_${to}.json`);
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  console.log(`🌐 ${tag}: menarik LQ45 (${from}→${to})...`);
  const bars = {};
  for (const s of LQ45) { bars[s] = await fetchDaily(s, from, to); await new Promise(r => setTimeout(r, 90)); }
  fs.writeFileSync(cache, JSON.stringify(bars, null, 0));
  return bars;
}

function sim(bars, es, entry, T, S) {
  const last = Math.min(bars.length - 1, es + WINDOW - 1);
  const tp = entry * (1 + T), sl = entry * (1 - S);
  for (let j = es; j <= last; j++) {
    const tpHit = bars[j].high >= tp, slHit = bars[j].low <= sl;
    if (tpHit && slHit) return -S - FEE;
    if (tpHit) return T - FEE;
    if (slHit) return -S - FEE;
  }
  return (bars[last].close - entry) / entry - FEE;
}

function grid(barsObj) {
  const usable = Object.values(barsObj).filter(b => Array.isArray(b) && b.length >= MIN_BARS);
  // precompute sinyal beli per (saham, i) sekali
  const signals = usable.map(bars => {
    const closes = bars.map(b => b.close), highs = bars.map(b => b.high), lows = bars.map(b => b.low), vols = bars.map(b => b.volume);
    const buys = [];
    for (let i = MIN_BARS - 1; i < bars.length - 1 - WINDOW; i++) {
      const fsx = backtestFactorScores(closes, highs, lows, vols, i);
      buys.push(backtestDecision(fsx, BT_THRESHOLD, null));
    }
    return { bars, buys };
  });
  const out = {};
  for (const T of TPS) for (const S of SLS) {
    let sN = 0, sW = 0, sNet = 0, bN = 0, bNet = 0;
    for (const { bars, buys } of signals) {
      let k = 0;
      for (let i = MIN_BARS - 1; i < bars.length - 1 - WINDOW; i++, k++) {
        const entry = bars[i + 1].open || bars[i].close;
        const r = sim(bars, i + 1, entry, T, S);
        bN++; bNet += r;
        if (buys[k]) { sN++; if (r > 0) sW++; sNet += r; }
      }
    }
    out[`${T}|${S}`] = { sN, sWR: sN ? sW / sN * 100 : 0, sAvg: sN ? sNet / sN * 100 : 0, bAvg: bN ? bNet / bN * 100 : 0 };
  }
  return out;
}

function show(tag, g) {
  console.log(`\n═══ ${tag} ═══`);
  console.log('net/trade SINYAL (%) — baris=target TP, kolom=stop SL:');
  console.log('  TP\\SL  | ' + SLS.map(s => ('-' + (s * 100) + '%').padStart(7)).join(' | '));
  let best = null;
  for (const T of TPS) {
    const cells = SLS.map(S => {
      const c = g[`${T}|${S}`]; const v = c.sAvg;
      if (!best || v > best.v) best = { v, T, S, c };
      return ((v >= 0 ? '+' : '') + v.toFixed(2)).padStart(7);
    });
    console.log('  +' + (T * 100).toFixed(1) + '% | ' + cells.join(' | '));
  }
  const b = best.c;
  console.log(`  ★ Terbaik: TP +${best.T * 100}% / SL -${best.S * 100}% → net ${(best.v >= 0 ? '+' : '') + best.v.toFixed(2)}%/trade · winRate ${b.sWR.toFixed(1)}% · base(acak) ${(b.bAvg >= 0 ? '+' : '') + b.bAvg.toFixed(2)}% · edge ${((best.v - b.bAvg) >= 0 ? '+' : '') + (best.v - b.bAvg).toFixed(2)}%`);
}

(async () => {
  const bull = await loadPeriod('Pasar NAIK 21/22', '2021-06-01', '2022-06-01');
  let recent;
  const rc = path.join(__dirname, 'data', '_signalq_lq45.json');
  if (fs.existsSync(rc)) recent = JSON.parse(fs.readFileSync(rc, 'utf8')).bars;
  else recent = await loadPeriod('Recent', '2025-08-01', new Date().toISOString().slice(0, 10));

  show('PASAR NAIK (2021-06→2022-06, regime +24.6%)', grid(bull));
  show('RECENT (2025-08→skrg, bear+bounce)', grid(recent));
  console.log('\nFokus baris "PASAR NAIK" — itu kondisi saat kamu menyalakan program. Cari net/trade tertinggi.');
  console.log('Edge = net sinyal − net acak. Edge positif = sinyal menambah nilai di kombinasi itu.');
  process.exit(0);
})();
