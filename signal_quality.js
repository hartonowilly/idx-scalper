// ════════════════════════════════════════════════════════════
//  UJI KUALITAS SINYAL BELI — gaya user: "jual begitu naik +5%"
//  Ambil SINYAL BELI model produksi (backtestDecision) di data HARIAN LQ45.
//  Pemicu jual = harga MENYENTUH +5% (kapan pun, secepat apa pun). Pakai high
//  harian → menangkap "naik 5% walau sebentar di tengah hari".
//  Diukur: % sinyal yang menyentuh +5% vs BASE RATE (saham acak). Plus sisi bahaya:
//  yang TIDAK sampai +5% nasibnya bagaimana (drawdown), karena tak ada stop.
//
//  Jalankan:  node signal_quality.js   (cache: data/_signalq_lq45.json)
// ════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { backtestFactorScores, backtestDecision, BT_THRESHOLD } = require('./server');

const CACHE = path.join(__dirname, 'data', '_signalq_lq45.json');
const LQ45 = [
  'ACES','ADMR','ADRO','AKRA','AMMN','AMRT','ANTM','ARTO','ASII','BBCA','BBNI','BBRI',
  'BBTN','BMRI','BRIS','BREN','BRPT','CPIN','CTRA','ESSA','EXCL','GOTO','ICBP','INCO',
  'INDF','INKP','ISAT','ITMG','JSMR','KLBF','MAPA','MAPI','MBMA','MDKA','MEDC','PGAS',
  'PGEO','PTBA','SMGR','SMRA','TLKM','TOWR','TPIA','UNTR','UNVR',
];
const FROM = '2025-08-01';
const TARGET = 0.05;            // titik jual user = +5%
const FEE = 0.004;             // 0.4% pulang-pergi
const WINDOWS = [1, 3, 5, 10]; // sabar menahan maks berapa hari (1 = harus hari masuk)
const MIN_BARS = 60;

async function fetchDaily(sym) {
  const p1 = Math.floor(new Date(FROM).getTime() / 1000), p2 = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}.JK?period1=${p1}&period2=${p2}&interval=1d`;
  try {
    const r = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 });
    const res = r.data?.chart?.result?.[0]; const ts = res?.timestamp || [], q = res?.indicators?.quote?.[0] || {};
    const b = [];
    for (let i = 0; i < ts.length; i++) { if (q.close?.[i] == null || q.open?.[i] == null) continue; b.push({ open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 }); }
    return b;
  } catch { return []; }
}
async function loadData() {
  if (fs.existsSync(CACHE)) return JSON.parse(fs.readFileSync(CACHE, 'utf8')).bars;
  console.log(`🌐 Menarik riwayat harian LQ45 (Yahoo, sejak ${FROM})...`);
  const bars = {};
  for (const s of LQ45) { bars[s] = await fetchDaily(s); await new Promise(r => setTimeout(r, 100)); }
  fs.writeFileSync(CACHE, JSON.stringify({ fetchedAt: new Date().toISOString(), bars }, null, 0));
  return bars;
}

// Setelah beli di `entry`, dalam N hari ke depan (mulai bar es):
//  touched = high pernah ≥ +5% (user akan jual di situ)
//  theirNet = kalau touched → +5%−fee; kalau tidak → MTM di akhir jendela − fee
//  worstDD = penurunan terburuk (low terendah) selama menahan
function forward(bars, es, entry, N) {
  const last = Math.min(bars.length - 1, es + N - 1);
  let touched = false, minLow = entry;
  for (let j = es; j <= last; j++) {
    if (bars[j].high >= entry * (1 + TARGET)) touched = true;
    if (bars[j].low < minLow) minLow = bars[j].low;
  }
  const mtm = (bars[last].close - entry) / entry;
  const theirNet = (touched ? TARGET : mtm) - FEE;
  return { touched, theirNet, worstDD: (minLow - entry) / entry };
}

(async () => {
  const data = await loadData();
  const usable = Object.entries(data).filter(([, b]) => Array.isArray(b) && b.length >= MIN_BARS);
  console.log(`📊 ${usable.length} saham LQ45 · titik jual +${TARGET * 100}% · "jual begitu naik 5%, kapan pun"\n`);

  for (const N of WINDOWS) {
    let sN = 0, sTouch = 0, sNet = 0, sDDsum = 0, sLose = 0, sLoseDD = 0;
    let bN = 0, bTouch = 0, bNet = 0;
    for (const [, bars] of usable) {
      const closes = bars.map(b => b.close), highs = bars.map(b => b.high), lows = bars.map(b => b.low), vols = bars.map(b => b.volume);
      for (let i = MIN_BARS - 1; i < bars.length - 1 - N; i++) {
        const entry = bars[i + 1].open || closes[i];
        const f = forward(bars, i + 1, entry, N);
        bN++; if (f.touched) bTouch++; bNet += f.theirNet;
        const fsx = backtestFactorScores(closes, highs, lows, vols, i);
        if (backtestDecision(fsx, BT_THRESHOLD, null)) {
          sN++; if (f.touched) sTouch++; sNet += f.theirNet; sDDsum += f.worstDD;
          if (!f.touched) { sLose++; sLoseDD += f.worstDD; }
        }
      }
    }
    const pcv = (a, b) => b ? (a / b * 100).toFixed(1) + '%' : '—';
    const edge = (sTouch / (sN || 1)) - (bTouch / (bN || 1));
    console.log(`── Sabar menahan maks ${N} hari ──`);
    console.log(`  SINYAL BELI : ${sN} sinyal | sentuh +5%: ${pcv(sTouch, sN)} | rata² hasil(gaya jual-5%): ${(sNet / (sN || 1) * 100).toFixed(2)}%`);
    console.log(`  ACAK (base) : ${bN} hari   | sentuh +5%: ${pcv(bTouch, bN)} | rata² hasil: ${(bNet / (bN || 1) * 100).toFixed(2)}%`);
    console.log(`  → Sinyal ${edge > 0.02 ? 'LEBIH BAIK ✅' : edge < -0.02 ? 'LEBIH BURUK ❌' : 'SAMA SAJA 🟡'} (selisih sentuh +5%: ${(edge * 100).toFixed(1)} poin)`);
    console.log(`  ⚠️ Yang TIDAK sampai +5%: ${pcv(sLose, sN)} dari sinyal | rata² drawdown terburuknya: ${(sLoseDD / (sLose || 1) * 100).toFixed(1)}%\n`);
  }
  console.log('Kunci: "jual begitu +5%" memang sering kena (high harian), TAPI yang gagal +5% bisa nyangkut & turun dalam.');
  console.log('Tanpa STOP LOSS, kerugian dari yang gagal bisa menghapus semua untung +5%. Itu jebakan klasik.');
  console.log(`Periode: ${FROM}→sekarang (bear akhir-2025 + bounce). Hapus ${path.basename(CACHE)} utk tarik ulang.`);
  process.exit(0);
})();
