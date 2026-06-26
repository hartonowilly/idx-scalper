// ════════════════════════════════════════════════════════════
//  TES SCREENER MURNI: beli pick → TAHAN N hari → jual di close (tanpa TP/SL churn)
//  Menjawab: "apakah saham yang disaring program naik lebih sering/lebih tinggi
//  dari acak bila dibeli & ditahan beberapa hari?" Diuji di pasar NAIK & RECENT.
//  Jalankan:  node screener_holdtest.js
// ════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const { backtestFactorScores, backtestDecision, BT_THRESHOLD } = require('./server');

const FEE = 0.004, MIN_BARS = 60;
const HOLDS = [3, 5, 10];

function load(file, key) {
  const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', file), 'utf8'));
  return key ? j[key] : j;
}
function test(barsObj, N) {
  const usable = Object.values(barsObj).filter(b => Array.isArray(b) && b.length >= MIN_BARS);
  let sN = 0, sW = 0, sRet = 0, bN = 0, bW = 0, bRet = 0;
  for (const bars of usable) {
    const closes = bars.map(b => b.close), highs = bars.map(b => b.high), lows = bars.map(b => b.low), vols = bars.map(b => b.volume);
    for (let i = MIN_BARS - 1; i < bars.length - 1 - N; i++) {
      const entry = bars[i + 1].open || closes[i];
      const exit = closes[i + N];                 // jual di penutupan hari ke-N
      const r = (exit - entry) / entry - FEE;
      bN++; if (r > 0) bW++; bRet += r;
      const fsx = backtestFactorScores(closes, highs, lows, vols, i);
      if (backtestDecision(fsx, BT_THRESHOLD, null)) { sN++; if (r > 0) sW++; sRet += r; }
    }
  }
  return { sN, sWR: sN ? sW / sN * 100 : 0, sAvg: sN ? sRet / sN * 100 : 0, bWR: bN ? bW / bN * 100 : 0, bAvg: bN ? bRet / bN * 100 : 0 };
}
function show(tag, barsObj) {
  console.log(`\n═══ ${tag} ═══`);
  console.log('tahan | SINYAL: naik% / rata²ret | ACAK: naik% / rata²ret | edge ret');
  for (const N of HOLDS) {
    const r = test(barsObj, N);
    const edge = r.sAvg - r.bAvg;
    const v = edge > 0.1 ? '🟢' : edge > 0 ? '🟡' : '🔴';
    console.log(`${String(N).padStart(2)} hr | ${r.sWR.toFixed(1)}% / ${(r.sAvg >= 0 ? '+' : '') + r.sAvg.toFixed(2)}%` +
      `     | ${r.bWR.toFixed(1)}% / ${(r.bAvg >= 0 ? '+' : '') + r.bAvg.toFixed(2)}%` +
      `   | ${(edge >= 0 ? '+' : '') + edge.toFixed(2)}% ${v}`);
  }
}
(async () => {
  const bull = load('_ss_2021-06-01_2022-06-01.json');
  const recent = load('_signalq_lq45.json', 'bars');
  show('PASAR NAIK 2021–2022 (rata² saham +24.6%)', bull);
  show('RECENT 2025-08→skrg (bear + bounce)', recent);
  console.log('\nnaik% = % pick yg untung (beli→tahan→jual di close). edge = rata²ret sinyal − acak.');
  console.log('Kalau di PASAR NAIK sinyal "naik%" & "ret" > acak → screener BERGUNA utk beli-tahan.');
  process.exit(0);
})();
