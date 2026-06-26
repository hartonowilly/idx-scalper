// ════════════════════════════════════════════════════════════
//  SWEEP TP/SL — cari geometri keluar yang tidak rugi
//  Memakai data intraday 5-menit ter-cache (data/_ablation_intraday.json)
//  dan model entry PENUH (9 faktor) yang sama dengan produksi.
//  Fill KONSERVATIF: bila 1 candle menyentuh TP & SL sekaligus → dihitung SL.
//
//  Jalankan:  node sweep_tpsl.js   (jalankan ablation_stockbit.js dulu utk isi cache)
// ════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const { runStrategyOverHistory } = require('./server'); // server tidak menyala (require.main guard)

const CACHE = path.join(__dirname, 'data', '_ablation_intraday.json');
if (!fs.existsSync(CACHE)) {
  console.log('❌ Cache belum ada. Jalankan dulu: node ablation_stockbit.js');
  process.exit(1);
}
const raw = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
const data = new Map(Object.entries(raw.series));
const totalBars = Array.from(data.values()).reduce((a, b) => a + b.length, 0);
console.log(`📊 Dataset: ${data.size} seri (saham×hari), ${totalBars} candle 5-menit  [fetch ${raw.fetchedAt}]`);
console.log('   Fill konservatif (TP & SL kena bareng → SL) · biaya 0.4% PP\n');

// Geometri yang diuji. ATR-multiple untuk TP & SL; holdBars = time-stop (1 bar = 5 menit).
const CONFIGS = [
  { label: 'TP2.0 / SL1.0  (sekarang)',    tpAtr: 2.0, slAtr: 1.0, tpFloor: 0.01 },
  { label: 'TP1.5 / SL1.0',                tpAtr: 1.5, slAtr: 1.0, tpFloor: 0 },
  { label: 'TP1.0 / SL1.0  (1:1)',         tpAtr: 1.0, slAtr: 1.0, tpFloor: 0 },
  { label: 'TP0.8 / SL1.0  (TP ketat)',    tpAtr: 0.8, slAtr: 1.0, tpFloor: 0 },
  { label: 'TP0.6 / SL0.6  (scalp ketat)', tpAtr: 0.6, slAtr: 0.6, tpFloor: 0 },
  { label: 'TP1.0 / SL1.5',                tpAtr: 1.0, slAtr: 1.5, tpFloor: 0 },
  { label: 'TP1.0 / SL2.0',                tpAtr: 1.0, slAtr: 2.0, tpFloor: 0 },
  { label: 'TP1.5 / SL2.0',                tpAtr: 1.5, slAtr: 2.0, tpFloor: 0 },
  { label: 'TP2.0 / SL3.0',                tpAtr: 2.0, slAtr: 3.0, tpFloor: 0 },
  { label: 'TP1.0 / SL1.0 + stop 6bar',    tpAtr: 1.0, slAtr: 1.0, tpFloor: 0, holdBars: 6 },
  { label: 'TP1.5 / SL1.0 + stop 6bar',    tpAtr: 1.5, slAtr: 1.0, tpFloor: 0, holdBars: 6 },
  { label: 'TP1.0 / SL1.0 + stop 12bar',   tpAtr: 1.0, slAtr: 1.0, tpFloor: 0, holdBars: 12 },
  { label: 'TP2.0 / SL1.0 + stop 12bar',   tpAtr: 2.0, slAtr: 1.0, tpFloor: 0, holdBars: 12 },
];

const pct = x => (x >= 0 ? '+' : '') + x.toFixed(2);

const rows = CONFIGS.map(c => {
  const r = runStrategyOverHistory(null, data, Object.assign({ fill: 'conservative' }, c));
  return { label: c.label, ...r };
});
// Urutkan terbaik (avgNet) di atas
rows.sort((a, b) => b.avgNet - a.avgNet);

console.log('geometri                    | trades | winRate |  avgNet | totalNet | verdict');
console.log('----------------------------|--------|---------|---------|----------|--------');
for (const r of rows) {
  const v = r.avgNet > 0.02 ? '🟢 CUAN' : r.avgNet > -0.02 ? '🟡 impas' : '🔴 rugi';
  console.log(
    r.label.padEnd(27) + ' | ' +
    String(r.trades).padStart(6) + ' | ' +
    (r.winRate.toFixed(1) + '%').padStart(7) + ' | ' +
    (pct(r.avgNet) + '%').padStart(7) + ' | ' +
    (pct(r.totalNet) + '%').padStart(8) + ' | ' + v
  );
}
console.log('\navgNet = untung BERSIH rata-rata per trade (sudah dikurangi fee 0.4%).');
console.log('Yang dicari: avgNet ≥ 0 dengan jumlah trade memadai.');
process.exit(0);
