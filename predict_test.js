// ════════════════════════════════════════════════════════════
//  "APAKAH PROGRAM BISA MEMPREDIKSI SAHAM NAIK?" — sweep target untung
//  Untuk tiap target (jual saat +T%) dgn stop -2%, dlm jendela 5 hari:
//   - Win rate: % saham yg KENA target sebelum stop  (tebakan "naik" yg benar)
//   - Net rata²: untung bersih per trade (sudah fee 0.4%)
//   - Dibandingkan BASE RATE (saham acak) → apakah sinyal MENAMBAH nilai?
//  Sinyal beli = model produksi (backtestDecision) di data harian LQ45.
//
//  Jalankan:  node predict_test.js   (pakai cache data/_signalq_lq45.json)
// ════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const { backtestFactorScores, backtestDecision, BT_THRESHOLD } = require('./server');

const CACHE = path.join(__dirname, 'data', '_signalq_lq45.json');
if (!fs.existsSync(CACHE)) { console.log('❌ Cache belum ada. Jalankan dulu: node signal_quality.js'); process.exit(1); }
const data = JSON.parse(fs.readFileSync(CACHE, 'utf8')).bars;
const usable = Object.entries(data).filter(([, b]) => Array.isArray(b) && b.length >= 60);

const FEE = 0.004, STOP = 0.02, WINDOW = 5, MIN_BARS = 60;
const TARGETS = [0.015, 0.02, 0.03, 0.05];

// Beli di entry; jual saat kena +T (menang) atau -STOP (kalah); kalau tak keduanya
// dlm WINDOW hari → jual di harga penutupan akhir jendela (mark-to-market).
function sim(bars, es, entry, T) {
  const last = Math.min(bars.length - 1, es + WINDOW - 1);
  const tp = entry * (1 + T), sl = entry * (1 - STOP);
  for (let j = es; j <= last; j++) {
    const tpHit = bars[j].high >= tp, slHit = bars[j].low <= sl;
    if (tpHit && slHit) return -STOP - FEE;       // konservatif: anggap stop
    if (tpHit) return T - FEE;
    if (slHit) return -STOP - FEE;
  }
  return (bars[last].close - entry) / entry - FEE;
}

console.log(`📊 ${usable.length} saham LQ45 · stop -${STOP * 100}% · jendela ${WINDOW} hari · periode 2025-08→skrg (bear+bounce)\n`);
console.log('target |   SINYAL BELI program    |      ACAK (base)        | sinyal menang?');
console.log('jual   | winRate |  net/trade     | winRate |  net/trade    |');
console.log('-------|---------|----------------|---------|---------------|---------------');
for (const T of TARGETS) {
  let sN = 0, sW = 0, sNet = 0, bN = 0, bW = 0, bNet = 0;
  for (const [, bars] of usable) {
    const closes = bars.map(b => b.close), highs = bars.map(b => b.high), lows = bars.map(b => b.low), vols = bars.map(b => b.volume);
    for (let i = MIN_BARS - 1; i < bars.length - 1 - WINDOW; i++) {
      const entry = bars[i + 1].open || closes[i];
      const r = sim(bars, i + 1, entry, T);
      bN++; if (r > 0) bW++; bNet += r;
      const fsx = backtestFactorScores(closes, highs, lows, vols, i);
      if (backtestDecision(fsx, BT_THRESHOLD, null)) { sN++; if (r > 0) sW++; sNet += r; }
    }
  }
  const sWR = sN ? sW / sN * 100 : 0, bWR = bN ? bW / bN * 100 : 0;
  const sAvg = sN ? sNet / sN * 100 : 0, bAvg = bN ? bNet / bN * 100 : 0;
  const verdict = (sAvg - bAvg > 0.05 && sAvg > 0) ? '🟢 lebih baik & cuan'
    : sAvg - bAvg > 0.05 ? '🟡 lebih baik tp msh rugi'
    : Math.abs(sAvg - bAvg) <= 0.05 ? '🟡 sama spt acak' : '🔴 lebih buruk';
  console.log(
    '+' + (T * 100).toFixed(1) + '% | ' +
    (sWR.toFixed(1) + '%').padStart(7) + ' | ' + ((sAvg >= 0 ? '+' : '') + sAvg.toFixed(2) + '%').padStart(14) + ' | ' +
    (bWR.toFixed(1) + '%').padStart(7) + ' | ' + ((bAvg >= 0 ? '+' : '') + bAvg.toFixed(2) + '%').padStart(13) + ' | ' + verdict);
}
console.log('\nwinRate = % tebakan beli yang KENA target sebelum stop (prediksi "naik" yang benar).');
console.log('Kalau kolom SINYAL tidak jauh di atas ACAK → program belum benar2 "memprediksi", baru sedikit memiringkan peluang.');
console.log('Catatan: periode ini bear-dominated; di pasar naik angka absolut membaik, selisih sinyal-vs-acak yang penting.');
process.exit(0);
