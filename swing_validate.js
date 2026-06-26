// ════════════════════════════════════════════════════════════
//  VALIDASI LOGIKA "BELI DIP" DI BANYAK PERIODE RECOVERY/BULL
//  Tujuan: cari varian entry mean-reversion yang KONSISTEN cuan saat pasar naik
//  (bukan kebetulan satu periode). Exit dipatok sama (TP3×ATR/SL2×ATR, tahan 3 hari)
//  agar yang dibandingkan murni LOGIKA ENTRY. Data harian Yahoo (.JK) utk riset.
//
//  Jalankan:  node swing_validate.js
// ════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { calculateSimpleRSI, calculateSMA, calculateSimpleATR } = require('./server');

const FEE = 0.004, MAX_HOLD = 3, MIN_BARS = 55;
const SYMBOLS = [
  'BBCA','BBRI','BMRI','BBNI','BBTN','BRIS','TLKM','ASII','ICBP','INDF','KLBF','UNVR',
  'ANTM','ADRO','PTBA','ITMG','MDKA','INCO','UNTR','PGAS','SMGR','CPIN','AKRA',
  'GOTO','ARTO','ISAT','EXCL','MEDC','JSMR','TOWR','AMRT','ACES','MAPI','CTRA','SMRA',
];
// Periode recovery/bull IDX untuk uji ketahanan (out-of-sample antar periode).
const PERIODS = [
  { tag: 'COVID-recovery 20/21', from: '2020-05-01', to: '2021-02-01' },
  { tag: 'Commodity-bull 21/22',  from: '2021-06-01', to: '2022-06-01' },
  { tag: 'Grind-up 23',           from: '2023-03-01', to: '2024-01-01' },
  { tag: 'Rally-ATH 24',          from: '2024-06-01', to: '2024-10-01' },
];

async function fetchYahoo(sym, from, to) {
  const p1 = Math.floor(new Date(from).getTime() / 1000), p2 = Math.floor(new Date(to).getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}.JK?period1=${p1}&period2=${p2}&interval=1d`;
  try {
    const r = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 });
    const res = r.data?.chart?.result?.[0]; const ts = res?.timestamp || [], q = res?.indicators?.quote?.[0] || {};
    const bars = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.close?.[i] == null || q.open?.[i] == null) continue;
      bars.push({ open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i] });
    }
    return bars;
  } catch { return []; }
}
async function loadPeriod(p) {
  const cache = path.join(__dirname, 'data', `_val_${p.from}_${p.to}.json`);
  if (fs.existsSync(cache)) return new Map(Object.entries(JSON.parse(fs.readFileSync(cache, 'utf8'))));
  const bySym = {};
  for (const s of SYMBOLS) { bySym[s] = await fetchYahoo(s, p.from, p.to); await new Promise(r => setTimeout(r, 100)); }
  fs.writeFileSync(cache, JSON.stringify(bySym, null, 0));
  return new Map(Object.entries(bySym));
}

// ── Varian entry "beli dip" (diputuskan akhir hari i; entry open H+1) ──
const VARIANTS = {
  'MR1 RSI<28 & turun 2hr':            (c, i, x) => x.rsi < 28 && i >= 2 && c[i] < c[i-1] && c[i-1] < c[i-2],
  'MR2 = MR1 & close>SMA50 (uptrend)': (c, i, x) => x.rsi < 28 && i >= 2 && c[i] < c[i-1] && c[i-1] < c[i-2] && x.sma50 > 0 && c[i] > x.sma50,
  'MR3 RSI<30 & turun 3hr':            (c, i, x) => x.rsi < 30 && i >= 3 && c[i] < c[i-1] && c[i-1] < c[i-2] && c[i-2] < c[i-3],
  'MR4 RSI<32 & >SMA50 & <SMA20':      (c, i, x) => x.rsi < 32 && x.sma50 > 0 && c[i] > x.sma50 && x.sma20 > 0 && c[i] < x.sma20,
  'MR5 = MR1 & close>SMA20':           (c, i, x) => x.rsi < 28 && i >= 2 && c[i] < c[i-1] && c[i-1] < c[i-2] && x.sma20 > 0 && c[i] > x.sma20,
};

function simulate(bars, rule) {
  const c = bars.map(b => b.close), h = bars.map(b => b.high), l = bars.map(b => b.low);
  let trades = 0, wins = 0, totalNet = 0;
  for (let i = MIN_BARS - 1; i < bars.length - 1; i++) {
    const sub = c.slice(0, i + 1);
    const x = { rsi: calculateSimpleRSI(sub), sma20: calculateSMA(sub, 20), sma50: calculateSMA(sub, 50) };
    if (!rule(c, i, x)) continue;
    const entry = bars[i + 1].open || c[i];
    let atr = calculateSimpleATR(h.slice(0, i + 1), l.slice(0, i + 1), sub);
    let atrPct = (entry > 0 && atr > 0) ? atr / entry : 0.02;
    atrPct = Math.min(0.06, Math.max(0.01, atrPct));
    const tpPct = 3.0 * atrPct, slPct = 2.0 * atrPct; // geometri pemenang
    const tp = entry * (1 + tpPct), sl = entry * (1 - slPct);
    let outcome = null;
    const last = Math.min(bars.length - 1, i + MAX_HOLD);
    for (let j = i + 1; j <= last; j++) {
      const hitTP = h[j] >= tp, hitSL = l[j] <= sl;
      if (hitTP && hitSL) { outcome = -slPct; break; }
      if (hitTP) { outcome = tpPct; break; }
      if (hitSL) { outcome = -slPct; break; }
    }
    if (outcome === null) outcome = (c[last] - entry) / entry;
    trades++; const net = outcome * 100 - FEE * 100; totalNet += net; if (net > 0) wins++;
    i += 1;
  }
  return { trades, wins, totalNet };
}
function run(map, rule) {
  let T = 0, W = 0, N = 0;
  for (const bars of map.values()) { if (!Array.isArray(bars) || bars.length < MIN_BARS + 1) continue;
    const r = simulate(bars, rule); T += r.trades; W += r.wins; N += r.totalNet; }
  return { trades: T, winRate: T ? W / T * 100 : 0, avgNet: T ? N / T : 0 };
}
function regime(map) {
  let sum = 0, n = 0;
  for (const b of map.values()) { if (!Array.isArray(b) || b.length < MIN_BARS) continue; sum += (b[b.length-1].close - b[0].close) / b[0].close * 100; n++; }
  return n ? sum / n : 0;
}
const f = x => (x >= 0 ? '+' : '') + x.toFixed(2);

(async () => {
  const maps = [];
  for (const p of PERIODS) { console.log(`🌐 ${p.tag} (${p.from}→${p.to})...`); maps.push(await loadPeriod(p)); }
  console.log('\nRegime tiap periode (rata-rata buy&hold):');
  PERIODS.forEach((p, k) => console.log(`  ${p.tag.padEnd(22)} ${f(regime(maps[k]))}%`));

  console.log('\n=== avgNet/trade per varian × periode (exit TP3×/SL2×ATR, tahan 3hr) ===');
  console.log('varian                              | ' + PERIODS.map(p => p.tag.split(' ')[0].padStart(8)).join(' | ') + ' |  RATA²');
  console.log('-'.repeat(38) + '-|-' + PERIODS.map(() => '--------').join('-|-') + '-|-------');
  for (const [name, fn] of Object.entries(VARIANTS)) {
    const cells = [], avgs = [];
    for (const m of maps) { const r = run(m, fn); cells.push((f(r.avgNet) + '%').padStart(8)); avgs.push(r.avgNet); }
    const mean = avgs.reduce((a, b) => a + b, 0) / avgs.length;
    const tag = mean > 0.05 ? '🟢' : mean > -0.02 ? '🟡' : '🔴';
    console.log(name.padEnd(35) + ' | ' + cells.join(' | ') + ' | ' + (f(mean) + '%').padStart(6) + ' ' + tag);
  }
  console.log('\nTrades per varian (periode pertama → keempat):');
  for (const [name, fn] of Object.entries(VARIANTS)) {
    console.log('  ' + name.padEnd(35) + maps.map(m => String(run(m, fn).trades).padStart(5)).join(''));
  }
  console.log('\nVarian CUAN konsisten di banyak periode = kandidat layak diimplementasikan.');
  process.exit(0);
})();
