// ════════════════════════════════════════════════════════════
//  UJI STRATEGI "BELI CLOSE → JUAL OPEN BESOK" (overnight effect)
//  Return tiap malam = (open[H+1] − close[H]) / close[H]. Net = gross − fee 0,4% PP.
//  Data harian LQ45 (Yahoo .JK, ~5 tahun) — dipisah per tahun untuk lihat regime.
//  Jalankan:  node overnight_test.js
// ════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CACHE = path.join(__dirname, 'data', '_overnight_lq45.json');
const FEE = 0.4; // % pulang-pergi (Stockbit)
const FROM = '2021-01-01';
const LQ45 = [
  'ACES','ADMR','ADRO','AKRA','AMMN','AMRT','ANTM','ARTO','ASII','BBCA','BBNI','BBRI',
  'BBTN','BMRI','BRIS','BREN','BRPT','CPIN','CTRA','ESSA','EXCL','GOTO','ICBP','INCO',
  'INDF','INKP','ISAT','ITMG','JSMR','KLBF','MAPA','MAPI','MBMA','MDKA','MEDC','PGAS',
  'PGEO','PTBA','SMGR','SMRA','TLKM','TOWR','TPIA','UNTR','UNVR',
];
async function fetchDaily(sym) {
  const p1 = Math.floor(new Date(FROM).getTime() / 1000), p2 = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}.JK?period1=${p1}&period2=${p2}&interval=1d`;
  try {
    const r = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 20000 });
    const res = r.data?.chart?.result?.[0]; const ts = res?.timestamp || [], q = res?.indicators?.quote?.[0] || {};
    const b = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.close?.[i] == null || q.open?.[i] == null) continue;
      b.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), open: q.open[i], close: q.close[i] });
    }
    return b;
  } catch { return []; }
}
async function load() {
  if (fs.existsSync(CACHE)) return JSON.parse(fs.readFileSync(CACHE, 'utf8')).bars;
  console.log(`🌐 Menarik LQ45 harian (Yahoo, sejak ${FROM})...`);
  const bars = {};
  for (const s of LQ45) { bars[s] = await fetchDaily(s); await new Promise(r => setTimeout(r, 110)); }
  fs.writeFileSync(CACHE, JSON.stringify({ fetchedAt: new Date().toISOString(), bars }, null, 0));
  return bars;
}

(async () => {
  const data = await load();
  const all = { n: 0, gross: 0, net: 0, wGross: 0, wNet: 0 };
  const byYear = {};
  for (const bars of Object.values(data)) {
    if (!Array.isArray(bars)) continue;
    for (let i = 0; i < bars.length - 1; i++) {
      const c = bars[i].close, o = bars[i + 1].open;
      if (!(c > 0) || !(o > 0)) continue;
      const gross = (o - c) / c * 100;       // % gerakan semalam
      const net = gross - FEE;               // setelah fee 0,4% PP
      const yr = bars[i].date.slice(0, 4);
      byYear[yr] = byYear[yr] || { n: 0, gross: 0, net: 0, wGross: 0, wNet: 0 };
      for (const g of [all, byYear[yr]]) { g.n++; g.gross += gross; g.net += net; if (gross > 0) g.wGross++; if (net > 0) g.wNet++; }
    }
  }
  const f = x => (x >= 0 ? '+' : '') + x.toFixed(3);
  const row = (label, g) => `${label.padEnd(10)} | ${String(g.n).padStart(6)} | ${f(g.gross / g.n).padStart(8)}% | ${(g.wGross / g.n * 100).toFixed(1).padStart(5)}% | ${f(g.net / g.n).padStart(8)}% | ${(g.wNet / g.n * 100).toFixed(1).padStart(5)}%`;

  console.log(`\n📊 ${Object.keys(data).length} saham LQ45 · "beli close → jual open besok" · fee ${FEE}% PP\n`);
  console.log('periode    |  malam | grossAVG | win%gr | net AVG  | win%net');
  console.log('-----------|--------|----------|--------|----------|--------');
  console.log(row('SEMUA', all));
  for (const yr of Object.keys(byYear).sort()) console.log(row(yr, byYear[yr]));

  const grossAvg = all.gross / all.n, netAvg = all.net / all.n;
  console.log(`\nGerakan semalam rata² (gross): ${f(grossAvg)}% — itu KECIL, fee 0,4% jauh lebih besar.`);
  console.log(`Net per malam: ${f(netAvg)}%. Kalau dilakukan tiap hari (~240 malam/thn): ${(netAvg * 240).toFixed(0)}%/tahun dari biaya saja.`);
  process.exit(0);
})();
