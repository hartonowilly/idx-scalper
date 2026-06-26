// ════════════════════════════════════════════════════════════
//  SWING HARIAN (tahan 1–3 hari) — apakah ADA edge?
//  Riwayat candle HARIAN dari Yahoo Finance (IDX = kode.JK) — hanya untuk
//  RISET/BACKTEST. Data LIVE program tetap dari Stockbit.
//  Metodologi jujur: entry di OPEN hari berikutnya (tanpa lookahead), tiap trade
//  diselesaikan (TP/SL atau mark-to-market di hari ke-3), fill konservatif, fee 0.4%.
//
//  Jalankan:  node swing_daily.js   (cache: data/_swing_yahoo.json, hapus utk tarik ulang)
// ════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { calculateSimpleRSI, calculateSMA, calculateSimpleATR } = require('./server');

const FROM = process.env.FROM || '2025-08-01';
const TO   = process.env.TO   || new Date().toISOString().slice(0, 10);
const CACHE = path.join(__dirname, 'data', `_swing_yahoo_${FROM}_${TO}.json`);
const SYMBOLS = [
  'BBCA','BBRI','BMRI','BBNI','BBTN','BRIS','TLKM','ASII','ICBP','INDF','KLBF','UNVR',
  'ANTM','ADRO','PTBA','ITMG','MDKA','INCO','UNTR','PGAS','SMGR','CPIN','AKRA',
  'GOTO','ARTO','ISAT','EXCL','MEDC','JSMR','TOWR','AMRT','ACES','MAPI','CTRA','SMRA',
];
const FEE = 0.004;     // 0.4% pulang-pergi
const MAX_HOLD = 3;    // tahan maksimal 3 hari
const MIN_BARS = 55;   // perlu ≥55 bar utk SMA50 + ruang backtest

async function fetchYahoo(sym) {
  const p1 = Math.floor(new Date(FROM).getTime() / 1000), p2 = Math.floor(new Date(TO).getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}.JK?period1=${p1}&period2=${p2}&interval=1d`;
  try {
    const r = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 });
    const res = r.data?.chart?.result?.[0];
    const ts = res?.timestamp || [], q = res?.indicators?.quote?.[0] || {};
    const bars = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.close?.[i] == null || q.open?.[i] == null) continue; // buang bar belum lengkap
      bars.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
        open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 });
    }
    return bars;
  } catch (e) { return []; }
}
async function buildDaily() {
  if (fs.existsSync(CACHE)) {
    const raw = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    const map = new Map(Object.entries(raw.bars));
    console.log(`📦 Cache: ${map.size} saham (riwayat harian Yahoo) dari ${raw.fetchedAt}\n`);
    return map;
  }
  console.log(`🌐 Menarik riwayat harian dari Yahoo: ${SYMBOLS.length} saham (sejak ${FROM})...`);
  const bySym = {};
  for (const s of SYMBOLS) { bySym[s] = await fetchYahoo(s); await new Promise(r => setTimeout(r, 120)); }
  fs.writeFileSync(CACHE, JSON.stringify({ fetchedAt: new Date().toISOString(), bars: bySym }, null, 0));
  const kept = Object.values(bySym).filter(a => a.length >= MIN_BARS).length;
  console.log(`✅ Selesai: ${kept}/${SYMBOLS.length} saham punya ≥${MIN_BARS} bar harian.\n`);
  return new Map(Object.entries(bySym));
}

// ── Hipotesis entry (diputuskan di akhir hari i; entry di OPEN hari i+1) ──
const RULES = {
  'breakout20 (high20 & >SMA20)':        (c, i, x) => x.sma20 > 0 && c[i] > x.sma20 && c[i] >= Math.max(...c.slice(Math.max(0, i - 19), i + 1)),
  'momentum (SMA20>SMA50 & RSI50-70)':   (c, i, x) => x.sma20 > x.sma50 && x.sma50 > 0 && c[i] > x.sma20 && x.rsi >= 50 && x.rsi <= 70,
  'pullback uptrend (>SMA50 & RSI<45)':  (c, i, x) => x.sma50 > 0 && c[i] > x.sma50 && x.rsi < 45,
  'mean-rev oversold (RSI<32)':          (c, i, x) => x.rsi < 32,
  'mean-rev kuat (RSI<28 & turun 2hr)':  (c, i, x) => x.rsi < 28 && i >= 2 && c[i] < c[i - 1] && c[i - 1] < c[i - 2],
};

function simulate(bars, entryRule, geom) {
  const c = bars.map(b => b.close), h = bars.map(b => b.high), l = bars.map(b => b.low);
  let trades = 0, wins = 0, totalNet = 0;
  for (let i = MIN_BARS - 1; i < bars.length - 1; i++) {
    const sub = c.slice(0, i + 1);
    const x = { rsi: calculateSimpleRSI(sub), sma20: calculateSMA(sub, 20), sma50: calculateSMA(sub, 50) };
    if (!entryRule(c, i, x)) continue;

    const entry = bars[i + 1].open || c[i];
    let atr = calculateSimpleATR(h.slice(0, i + 1), l.slice(0, i + 1), sub);
    let atrPct = (entry > 0 && atr > 0) ? atr / entry : 0.02;
    atrPct = Math.min(0.06, Math.max(0.01, atrPct));
    const tpPct = geom.fixed ? geom.tp : geom.tpAtr * atrPct;
    const slPct = geom.fixed ? geom.sl : geom.slAtr * atrPct;
    const tpPrice = entry * (1 + tpPct), slPrice = entry * (1 - slPct);

    let outcome = null;
    const lastDay = Math.min(bars.length - 1, i + MAX_HOLD);
    for (let j = i + 1; j <= lastDay; j++) {
      const hitTP = h[j] >= tpPrice, hitSL = l[j] <= slPrice;
      if (hitTP && hitSL) { outcome = -slPct; break; }   // konservatif: anggap SL
      if (hitTP) { outcome = tpPct; break; }
      if (hitSL) { outcome = -slPct; break; }
    }
    if (outcome === null) outcome = (c[lastDay] - entry) / entry; // mark-to-market hari ke-3
    trades++;
    const net = outcome * 100 - FEE * 100;
    totalNet += net;
    if (net > 0) wins++;
    i += 1;
  }
  return { trades, wins, totalNet };
}
function run(map, rule, geom) {
  let T = 0, W = 0, N = 0;
  for (const bars of map.values()) {
    if (!Array.isArray(bars) || bars.length < MIN_BARS + 1) continue;
    const r = simulate(bars, rule, geom); T += r.trades; W += r.wins; N += r.totalNet;
  }
  return { trades: T, winRate: T ? W / T * 100 : 0, avgNet: T ? N / T : 0, totalNet: N };
}
const pct = x => (x >= 0 ? '+' : '') + x.toFixed(2);
const verdict = a => a > 0.05 ? '🟢 CUAN' : a > -0.05 ? '🟡 impas' : '🔴 rugi';

(async () => {
  const map = await buildDaily();
  const usable = Array.from(map.values()).filter(a => Array.isArray(a) && a.length >= MIN_BARS);
  const totBars = usable.reduce((a, b) => a + b.length, 0);
  console.log(`📊 ${usable.length} saham layak, ${totBars} bar harian · tahan maks ${MAX_HOLD} hari · fee 0.4% · entry di open H+1\n`);

  console.log('=== HIPOTESIS ENTRY (TP 2×ATR / SL 1.5×ATR, tahan 3 hari) ===');
  console.log('entry rule                            | trades | winRate |  avgNet | totalNet | vonis');
  console.log('--------------------------------------|--------|---------|---------|----------|------');
  const ranked = [];
  for (const [name, fn] of Object.entries(RULES)) {
    const r = run(map, fn, { tpAtr: 2.0, slAtr: 1.5 });
    ranked.push([name, fn, r]);
    console.log(name.padEnd(37) + ' | ' + String(r.trades).padStart(6) + ' | ' +
      (r.winRate.toFixed(1) + '%').padStart(7) + ' | ' + (pct(r.avgNet) + '%').padStart(7) + ' | ' +
      (pct(r.totalNet) + '%').padStart(8) + ' | ' + verdict(r.avgNet));
  }
  ranked.sort((a, b) => b[2].avgNet - a[2].avgNet);
  const [bestName, bestFn] = ranked[0];

  console.log(`\n=== SWEEP TP/SL pada entry terbaik: "${bestName}" ===`);
  const GEOS = [
    { label: 'TP2.0/SL1.5 ATR', tpAtr: 2.0, slAtr: 1.5 },
    { label: 'TP1.5/SL1.0 ATR', tpAtr: 1.5, slAtr: 1.0 },
    { label: 'TP3.0/SL2.0 ATR', tpAtr: 3.0, slAtr: 2.0 },
    { label: 'TP+3% / SL-2%', fixed: true, tp: 0.03, sl: 0.02 },
    { label: 'TP+4% / SL-3%', fixed: true, tp: 0.04, sl: 0.03 },
    { label: 'TP+5% / SL-3%', fixed: true, tp: 0.05, sl: 0.03 },
    { label: 'TP+2% / SL-2%', fixed: true, tp: 0.02, sl: 0.02 },
  ];
  console.log('geometri          | trades | winRate |  avgNet | totalNet | vonis');
  console.log('------------------|--------|---------|---------|----------|------');
  for (const g of GEOS) {
    const r = run(map, bestFn, g);
    console.log(g.label.padEnd(17) + ' | ' + String(r.trades).padStart(6) + ' | ' +
      (r.winRate.toFixed(1) + '%').padStart(7) + ' | ' + (pct(r.avgNet) + '%').padStart(7) + ' | ' +
      (pct(r.totalNet) + '%').padStart(8) + ' | ' + verdict(r.avgNet));
  }
  console.log('\navgNet = untung BERSIH rata-rata per trade (sudah dikurangi fee 0.4%).');
  console.log('Catatan: periode data ini (2025-08→2026-06) — perhatikan apakah pasar sedang tren turun.');
  process.exit(0);
})();
