// ════════════════════════════════════════════════════════════
//  UJI "BANDAR" (proksi akumulasi) vs MOMENTUM vs DIP — forward 5 hari
//  Data asing/broker historis TIDAK tersedia → "bandar" diproksikan dari yang
//  teramati: LONJAKAN VOLUME (≥2× rata²) + harga ditutup KUAT (di 40% atas range)
//  + hari naik = ciri akumulasi uang besar.
//  Entry open[H+1], exit close[H+5], fee 0,4% PP. Data 5thn LQ45 (_ma_lq45.json).
//  Jalankan:  node bandar_test.js
// ════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const { calculateSimpleRSI, calculateSMA } = require('./server');

const CACHE = path.join(__dirname, 'data', '_ma_lq45.json');
if (!fs.existsSync(CACHE)) { console.log('❌ Jalankan dulu: node ma_filter_test.js'); process.exit(1); }
const data = JSON.parse(fs.readFileSync(CACHE, 'utf8')).bars;
const FEE = 0.4, HOLD = 5;

const acc = () => ({ n: 0, net: 0, win: 0 });
function add(a, entry, exit) { const r = (exit - entry) / entry * 100 - FEE; a.n++; a.net += r; if (r > 0) a.win++; }

const ALL = acc(), MOM = acc(), DIP = acc(), BANDAR = acc();
for (const bars of Object.values(data)) {
  if (!Array.isArray(bars) || bars.length < 60) continue;
  const c = bars.map(b => b.close), h = bars.map(b => b.high), l = bars.map(b => b.low), v = bars.map(b => b.volume || 0);
  for (let i = 50; i < bars.length - 1 - HOLD; i++) {
    const entry = bars[i + 1].open, exit = c[i + HOLD];
    if (!(entry > 0) || !(exit > 0)) continue;
    add(ALL, entry, exit);
    const sub = c.slice(0, i + 1);
    const rsi = calculateSimpleRSI(sub), sma20 = calculateSMA(sub, 20), sma50 = calculateSMA(sub, 50);
    if (c[i] > sma20 && sma20 > sma50 && rsi >= 50 && rsi <= 70) add(MOM, entry, exit);
    if (rsi < 28 && c[i] < c[i - 1] && c[i - 1] < c[i - 2]) add(DIP, entry, exit);
    // Proksi BANDAR: volume ≥2× rata²20 + tutup di 40% atas range + hari naik
    const avgVol = v.slice(i - 20, i).reduce((a, b) => a + b, 0) / 20;
    const rng = h[i] - l[i];
    const closeStrong = rng > 0 ? (c[i] - l[i]) / rng >= 0.6 : false;
    if (avgVol > 0 && v[i] >= 2 * avgVol && closeStrong && c[i] > c[i - 1]) add(BANDAR, entry, exit);
  }
}
const f = x => (x >= 0 ? '+' : '') + x.toFixed(3);
const row = (label, g) => g.n ? `${label.padEnd(24)} | ${String(g.n).padStart(6)} | ${f(g.net / g.n).padStart(8)}% | ${(g.win / g.n * 100).toFixed(1).padStart(5)}%` : `${label.padEnd(24)} | 0`;

console.log(`\n📊 LQ45 5thn · beli→tahan ${HOLD} hari · fee ${FEE}% PP · vs baseline\n`);
console.log('sinyal                   |   n    | net/trade| win%');
console.log('-------------------------|--------|----------|-----');
console.log(row('SEMUA (baseline)', ALL));
console.log(row('Momentum (uptrend)', MOM));
console.log(row('Dip (RSI<28)', DIP));
console.log(row('BANDAR (akumulasi vol)', BANDAR));
console.log('\nedge = net sinyal − net baseline. Periode 5thn termasuk crash 2025 → absolut bisa negatif;');
console.log('yang penting: apakah "bandar/akumulasi" MENGALAHKAN baseline & sinyal lain?');
process.exit(0);
