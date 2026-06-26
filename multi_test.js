// ════════════════════════════════════════════════════════════
//  UJI 4 TEKNIK: (1) dip+regime  (2) jarak-dari-MA  (3) Bollinger bawah  (4) Relative Strength
//  Data harian LQ45 + IHSG (Yahoo, ~5thn, bertanggal). Entry open[H+1], exit close[H+5], fee 0,4%.
//  Jalankan:  node multi_test.js   (cache data/_multi_lq45.json)
// ════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { calculateSimpleRSI, calculateSMA } = require('./server');

const CACHE = path.join(__dirname, 'data', '_multi_lq45.json');
const FROM = '2021-01-01', FEE = 0.4, HOLD = 5;
const LQ45 = ['ACES','ADMR','ADRO','AKRA','AMMN','AMRT','ANTM','ARTO','ASII','BBCA','BBNI','BBRI','BBTN','BMRI','BRIS','BREN','BRPT','CPIN','CTRA','ESSA','EXCL','GOTO','ICBP','INCO','INDF','INKP','ISAT','ITMG','JSMR','KLBF','MAPA','MAPI','MBMA','MDKA','MEDC','PGAS','PGEO','PTBA','SMGR','SMRA','TLKM','TOWR','TPIA','UNTR','UNVR'];

async function fetchY(sym, ohlc) {
  const p1 = Math.floor(new Date(FROM).getTime()/1000), p2 = Math.floor(Date.now()/1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?period1=${p1}&period2=${p2}&interval=1d`;
  try {
    const r = await axios.get(url, { headers:{'User-Agent':'Mozilla/5.0'}, timeout:20000 });
    const res = r.data?.chart?.result?.[0]; const ts = res?.timestamp||[], q = res?.indicators?.quote?.[0]||{};
    const b=[];
    for (let i=0;i<ts.length;i++){ if(q.close?.[i]==null||q.open?.[i]==null)continue;
      const d={ date:new Date(ts[i]*1000).toISOString().slice(0,10), close:q.close[i] };
      if(ohlc){ d.open=q.open[i]; d.high=q.high[i]; d.low=q.low[i]; }
      b.push(d);
    } return b;
  } catch { return []; }
}
async function load() {
  if (fs.existsSync(CACHE)) return JSON.parse(fs.readFileSync(CACHE,'utf8'));
  console.log('🌐 Menarik IHSG + 45 LQ45 (bertanggal)...');
  const ihsg = await fetchY('%5EJKSE', false);
  const stocks = {};
  for (const s of LQ45){ stocks[s] = await fetchY(s+'.JK', true); await new Promise(r=>setTimeout(r,110)); }
  const out = { ihsg, stocks };
  fs.writeFileSync(CACHE, JSON.stringify(out,null,0));
  return out;
}
const acc = () => ({ n:0, net:0, win:0 });
const add = (a, entry, exit) => { const r=(exit-entry)/entry*100 - FEE; a.n++; a.net+=r; if(r>0)a.win++; };

(async () => {
  const { ihsg, stocks } = await load();
  // peta IHSG per tanggal: ma50, ret20, di atas MA50?
  const ic = ihsg.map(b=>b.close), iMap = {};
  for (let j=0;j<ihsg.length;j++){
    const ma50 = j>=50 ? calculateSMA(ic.slice(0,j+1),50) : 0;
    const ret20 = j>=20 ? (ic[j]-ic[j-20])/ic[j-20]*100 : null;
    iMap[ihsg[j].date] = { close:ic[j], aboveMa50: ma50>0 && ic[j]>ma50, ret20 };
  }
  const B=acc(), DIPR=acc(), DIST=acc(), BOLL=acc(), RS=acc();
  for (const bars of Object.values(stocks)){
    if(!Array.isArray(bars)||bars.length<60) continue;
    const c=bars.map(b=>b.close);
    for (let i=50;i<bars.length-1-HOLD;i++){
      const entry=bars[i+1].open, exit=c[i+HOLD];
      if(!(entry>0)||!(exit>0)) continue;
      add(B, entry, exit);
      const sub=c.slice(0,i+1);
      const rsi=calculateSimpleRSI(sub), sma20=calculateSMA(sub,20);
      // std20 utk Bollinger
      const w=c.slice(i-19,i+1); const mean=w.reduce((a,b)=>a+b,0)/20;
      const std=Math.sqrt(w.reduce((a,b)=>a+(b-mean)**2,0)/20);
      const ret20s = (c[i]-c[i-20])/c[i-20]*100;
      const ih = iMap[bars[i].date];
      const dip = rsi<28 && c[i]<c[i-1] && c[i-1]<c[i-2];
      // 1) dip + regime (IHSG di atas MA50)
      if(dip && ih && ih.aboveMa50) add(DIPR, entry, exit);
      // 2) jarak dari MA: ≥6% di bawah SMA20 (ekstrem teregang)
      if(sma20>0 && c[i] <= sma20*0.94) add(DIST, entry, exit);
      // 3) Bollinger bawah: close < SMA20 − 2·std
      if(std>0 && c[i] < sma20 - 2*std) add(BOLL, entry, exit);
      // 4) Relative Strength: outperform IHSG ≥ +5% dlm 20 hari & naik
      if(ih && ih.ret20!=null && (ret20s - ih.ret20) >= 5 && ret20s>0) add(RS, entry, exit);
    }
  }
  const f=x=>(x>=0?'+':'')+x.toFixed(3);
  const row=(lbl,g)=> g.n ? `${lbl.padEnd(26)} | ${String(g.n).padStart(6)} | ${f(g.net/g.n).padStart(8)}% | ${(g.win/g.n*100).toFixed(1).padStart(5)}% | ${f(g.net/g.n - B.net/B.n).padStart(7)}` : `${lbl.padEnd(26)} | 0`;
  console.log(`\n📊 LQ45 5thn · tahan ${HOLD} hari · fee ${FEE}% PP\n`);
  console.log('teknik                     |   n    | net/trade| win%  | edge*');
  console.log('---------------------------|--------|----------|-------|------');
  console.log(row('SEMUA (baseline)', B));
  console.log(row('1) Dip + regime IHSG>MA50', DIPR));
  console.log(row('2) Jarak dari MA (≤−6%)', DIST));
  console.log(row('3) Bollinger bawah', BOLL));
  console.log(row('4) Relative Strength', RS));
  console.log('\n*edge = net/trade − baseline. Positif & > baseline = teknik menambah nilai.');
  console.log('Periode 5thn termasuk crash 2025 → absolut bisa negatif; fokus ke EDGE relatif & win%.');
  process.exit(0);
})();
