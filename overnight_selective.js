// ════════════════════════════════════════════════════════════
//  OVERNIGHT SELEKTIF: apakah saham ber-SINYAL naik semalam lebih dari rata²?
//  Bandingkan return (close[H] → open[H+1]) untuk:
//    - SEMUA saham (baseline)
//    - sinyal KUAT/momentum (close>SMA20 & SMA20>SMA50 & RSI 50–70) ≈ sinyal BELI dashboard
//    - sinyal DIP (RSI<28 & turun 2 hari) ≈ tab Swing
//  Data 5thn LQ45 (cache _ma_lq45.json). Fee 0,4% PP.
//  Jalankan:  node overnight_selective.js
// ════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const { calculateSimpleRSI, calculateSMA } = require('./server');

const CACHE = path.join(__dirname, 'data', '_ma_lq45.json');
if (!fs.existsSync(CACHE)) { console.log('❌ Cache _ma_lq45.json belum ada. Jalankan dulu: node ma_filter_test.js'); process.exit(1); }
const data = JSON.parse(fs.readFileSync(CACHE, 'utf8')).bars;
const FEE = 0.4;

const acc = () => ({ n: 0, gross: 0, net: 0, wGross: 0, wNet: 0 });
const add = (a, g) => { a.n++; a.gross += g; a.net += (g - FEE); if (g > 0) a.wGross++; if (g - FEE > 0) a.wNet++; };

const ALL = acc(), STRONG = acc(), DIP = acc();
for (const bars of Object.values(data)) {
  if (!Array.isArray(bars) || bars.length < 60) continue;
  const c = bars.map(b => b.close);
  for (let i = 50; i < bars.length - 1; i++) {
    const o1 = bars[i + 1].open, ci = c[i];
    if (!(ci > 0) || !(o1 > 0)) continue;
    const night = (o1 - ci) / ci * 100;              // % gerakan semalam
    add(ALL, night);
    const sub = c.slice(0, i + 1);
    const rsi = calculateSimpleRSI(sub), sma20 = calculateSMA(sub, 20), sma50 = calculateSMA(sub, 50);
    if (ci > sma20 && sma20 > sma50 && rsi >= 50 && rsi <= 70) add(STRONG, night); // momentum/uptrend
    if (rsi < 28 && c[i] < c[i - 1] && c[i - 1] < c[i - 2]) add(DIP, night);         // beli dip
  }
}
const f = x => (x >= 0 ? '+' : '') + x.toFixed(3);
const row = (label, g) => g.n ? `${label.padEnd(22)} | ${String(g.n).padStart(6)} | ${f(g.gross / g.n).padStart(8)}% | ${f(g.net / g.n).padStart(8)}% | ${(g.wNet / g.n * 100).toFixed(1).padStart(5)}%` : `${label.padEnd(22)} | 0`;

console.log(`\n📊 LQ45 5thn · return semalam (close→open besok) · fee ${FEE}% PP\n`);
console.log('kelompok               |  malam | grossAVG | net AVG  | win%net');
console.log('-----------------------|--------|----------|----------|--------');
console.log(row('SEMUA (baseline)', ALL));
console.log(row('Sinyal KUAT/momentum', STRONG));
console.log(row('Sinyal DIP (RSI<28)', DIP));
console.log(`\nFee semalam = ${FEE}%. Supaya untung, grossAVG harus > ${FEE}%.`);
console.log('Kalau grossAVG sinyal tidak jauh di atas baseline & < 0,4% → seleksi TIDAK menyelamatkan overnight.');
process.exit(0);
