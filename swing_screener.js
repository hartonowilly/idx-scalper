// ════════════════════════════════════════════════════════════
//  SCREENER SWING HARIAN — "Beli Dip" (mean-reversion, tahan 1–3 hari)
//  Logika tervalidasi lintas 4 periode recovery (lihat swing_validate.js):
//    ENTRY  : RSI(14) < 28  DAN  harga turun 2 hari beruntun
//    EXIT   : TP = 3×ATR, SL = 2×ATR, tahan maksimal 3 hari
//  Edge kecil (~+0.2–0.3%/trade) & HANYA andal saat pasar recovery/naik —
//  user yang memutuskan ON/OFF berdasarkan kondisi IHSG.
//
//  Sumber data harian: Yahoo Finance (.JK) sekarang; bar harian Stockbit
//  ditumpuk diam-diam (recordStockbitDaily) agar bisa mandiri ke depan.
// ════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { roundToIDXPriceRules } = require('./idx_api_providers');
const auth = require('./stockbit_auth');

const RSI_PERIOD = 14, ATR_PERIOD = 14;
const RSI_MAX = 28;          // ambang oversold
const TP_ATR = 3.0, SL_ATR = 2.0, MAX_HOLD = 3;
const MIN_BARS = 20;         // minimal bar harian agar RSI valid
const SCAN_LIMIT = 70;       // batasi jumlah saham yang ditarik dari Yahoo
const YAHOO_CACHE = path.join(__dirname, 'data', 'daily_bars_yahoo.json');
const SB_DAILY = path.join(__dirname, 'data', 'daily_bars_stockbit.json');

function todayWib() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }); }

// ── Indikator (memakai bar TERBARU, konsisten dgn server.js yang sudah difix) ──
function rsi(closes, period = RSI_PERIOD) {
  if (closes.length < period + 1) return 50;
  let g = 0, l = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch > 0) g += ch; else l += Math.abs(ch);
  }
  const ag = g / period, al = l / period;
  if (al === 0) return ag === 0 ? 50 : 100;
  return Math.min(100, Math.max(0, 100 - 100 / (1 + ag / al)));
}
function atr(highs, lows, closes, period = ATR_PERIOD) {
  if (highs.length < period + 1) return (closes[closes.length - 1] || 0) * 0.02;
  let s = 0;
  for (let i = highs.length - period; i < highs.length; i++) {
    s += Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }
  return s / period;
}

// ── Sumber data harian: Yahoo (cache 1× per hari bursa) ──
async function fetchYahooDaily(symbol) {
  const p1 = Math.floor(Date.now() / 1000) - 400 * 24 * 3600; // ~400 hari (cukup utk MA200)
  const p2 = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.JK?period1=${p1}&period2=${p2}&interval=1d`;
  const r = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 });
  const res = r.data?.chart?.result?.[0];
  const ts = res?.timestamp || [], q = res?.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close?.[i] == null || q.open?.[i] == null) continue;
    bars.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
      open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 });
  }
  return bars;
}

async function ensureYahooBars(symbols) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(YAHOO_CACHE, 'utf8')); } catch { /* baru */ }
  const fresh = cache.date === todayWib() && cache.bars;
  if (fresh) return cache.bars;

  const bars = {};
  const list = symbols.slice(0, SCAN_LIMIT);
  for (const s of list) {
    try { bars[s] = await fetchYahooDaily(s); } catch { bars[s] = []; }
    await new Promise(r => setTimeout(r, 120));
  }
  try {
    fs.mkdirSync(path.dirname(YAHOO_CACHE), { recursive: true });
    fs.writeFileSync(YAHOO_CACHE, JSON.stringify({ date: todayWib(), fetchedAt: new Date().toISOString(), bars }, null, 0));
  } catch { /* abaikan */ }
  return bars;
}

// ── Bar harian Stockbit: tumpuk 1 bar/hari/saham dari cache live (untuk masa depan) ──
// stockArray = Array<{symbol, price/close, high, low, open, volume}> dari stockCache.
function recordStockbitDaily(stockArray) {
  let store = {};
  try { store = JSON.parse(fs.readFileSync(SB_DAILY, 'utf8')).bars || {}; } catch { /* baru */ }
  const date = todayWib();
  let added = 0;
  for (const s of (stockArray || [])) {
    const sym = s.symbol; if (!sym) continue;
    const close = s.price || s.close; if (!close) continue;
    store[sym] = store[sym] || [];
    const last = store[sym][store[sym].length - 1];
    if (last && last.date === date) {               // perbarui bar hari ini (belum tutup)
      last.high = Math.max(last.high, s.high || close);
      last.low = Math.min(last.low, s.low || close);
      last.close = close; last.volume = s.volume || last.volume;
    } else {
      store[sym].push({ date, open: s.open || close, high: s.high || close, low: s.low || close, close, volume: s.volume || 0 });
      added++;
    }
    if (store[sym].length > 260) store[sym] = store[sym].slice(-260); // simpan ~1 tahun
  }
  try {
    fs.mkdirSync(path.dirname(SB_DAILY), { recursive: true });
    fs.writeFileSync(SB_DAILY, JSON.stringify({ savedAt: new Date().toISOString(), bars: store }, null, 0));
  } catch { /* abaikan */ }
  return added;
}
function loadStockbitDaily() {
  try { return JSON.parse(fs.readFileSync(SB_DAILY, 'utf8')).bars || {}; } catch { return {}; }
}

// Pita Bollinger bawah (SMA20 − 2·std) pada indeks `end`. −Infinity jika data kurang.
function lowerBollinger(closes, end) {
  const start = end - 19; if (start < 0) return -Infinity;
  let sum = 0; for (let k = start; k <= end; k++) sum += closes[k];
  const mean = sum / 20;
  let v = 0; for (let k = start; k <= end; k++) v += (closes[k] - mean) ** 2;
  return mean - 2 * Math.sqrt(v / 20);
}

// ── Inti: hitung kandidat "beli dip" dari peta bar harian ──
// Sinyal = #dip (RSI<28 + turun 2hr) ATAU #Bollinger (close < pita bawah) — keduanya
// "beli kelemahan" yang terbukti ber-edge.
function scoreCandidate(symbol, bars, source) {
  if (!Array.isArray(bars) || bars.length < MIN_BARS) return null;
  const closes = bars.map(b => b.close), highs = bars.map(b => b.high), lows = bars.map(b => b.low);
  const n = closes.length;
  const r = rsi(closes);
  const down2 = closes[n - 1] < closes[n - 2] && closes[n - 2] < closes[n - 3];
  const dipSig = r < RSI_MAX && down2;
  const bollSig = closes[n - 1] < lowerBollinger(closes, n - 1);
  if (!(dipSig || bollSig)) return null;

  const lastClose = closes[n - 1];
  let atrPct = atr(highs, lows, closes) / lastClose;
  atrPct = Math.min(0.06, Math.max(0.01, atrPct));
  const tp = roundToIDXPriceRules(lastClose * (1 + TP_ATR * atrPct));
  const sl = roundToIDXPriceRules(lastClose * (1 - SL_ATR * atrPct));
  // % perubahan 2 hari terakhir (kedalaman dip)
  const drop2 = closes[n - 3] > 0 ? (closes[n - 1] - closes[n - 3]) / closes[n - 3] * 100 : 0;
  return {
    symbol, source, lastClose, rsi: +r.toFixed(1), drop2: +drop2.toFixed(2),
    atrPct: +(atrPct * 100).toFixed(2), entryRef: lastClose,
    takeProfit: tp, stopLoss: sl,
    tpPct: +((tp - lastClose) / lastClose * 100).toFixed(2),
    slPct: +((lastClose - sl) / lastClose * 100).toFixed(2),
    trigger: dipSig ? (bollSig ? 'RSI<28 + Bollinger' : 'RSI<28 + turun 2hr') : 'Tembus Bollinger bawah',
    asOf: bars[n - 1].date, maxHoldDays: MAX_HOLD,
  };
}

// ── PAPER-TRADING OTOMATIS (deterministik dari bar harian) ──
// Menjalankan strategi yang SAMA ke depan pada riwayat harian: tiap sinyal dicatat
// sebagai 1 trade (entry di open H+1, exit TP/SL atau time-stop hari ke-3). Tidak perlu
// state tersimpan — track record dihitung ulang dari data, auto-update tiap hari.
const FEE = 0.004; // 0.4% pulang-pergi

function simulateSeries(symbol, bars, source) {
  const closes = bars.map(b => b.close), highs = bars.map(b => b.high), lows = bars.map(b => b.low);
  const n = bars.length, closed = [], open = [];
  for (let i = MIN_BARS - 1; i < n - 1; i++) {
    const sub = closes.slice(0, i + 1);
    const r = rsi(sub);
    const dipSig = r < RSI_MAX && closes[i] < closes[i - 1] && closes[i - 1] < closes[i - 2];
    const bollSig = closes[i] < lowerBollinger(closes, i);
    if (!(dipSig || bollSig)) continue;

    const entry = bars[i + 1].open || closes[i + 1];
    let atrPct = atr(highs.slice(0, i + 1), lows.slice(0, i + 1), sub) / entry;
    atrPct = Math.min(0.06, Math.max(0.01, atrPct));
    const tp = entry * (1 + TP_ATR * atrPct), sl = entry * (1 - SL_ATR * atrPct);
    const last = Math.min(n - 1, i + MAX_HOLD);

    let frac = null, type = null, exitIdx = null;
    for (let j = i + 1; j <= last; j++) {
      const hitTP = highs[j] >= tp, hitSL = lows[j] <= sl;
      if (hitTP && hitSL) { frac = -SL_ATR * atrPct; type = 'SL'; exitIdx = j; break; }
      if (hitTP) { frac = TP_ATR * atrPct; type = 'TP'; exitIdx = j; break; }
      if (hitSL) { frac = -SL_ATR * atrPct; type = 'SL'; exitIdx = j; break; }
    }
    const trade = {
      symbol, source, signalDate: bars[i].date, entryDate: bars[i + 1].date,
      entry, takeProfit: Math.round(tp), stopLoss: Math.round(sl),
    };
    if (frac !== null) {                       // kena TP/SL
      trade.exitDate = bars[exitIdx].date; trade.netPct = +(frac * 100 - FEE * 100).toFixed(2);
      trade.type = type; trade.heldDays = exitIdx - (i + 1);
      closed.push(trade);
    } else if (i + MAX_HOLD <= n - 1) {        // habis 3 hari → time-stop (mark-to-market)
      const f = (closes[last] - entry) / entry;
      trade.exitDate = bars[last].date; trade.netPct = +(f * 100 - FEE * 100).toFixed(2);
      trade.type = 'TIME'; trade.heldDays = last - (i + 1);
      closed.push(trade);
    } else {                                   // masih berjalan (belum cukup bar ke depan)
      const cur = closes[n - 1];
      trade.current = cur; trade.unrealPct = +((cur - entry) / entry * 100).toFixed(2);
      trade.heldDays = (n - 1) - (i + 1);
      open.push(trade);
    }
    i += 1; // jangan entry beruntun di hari berdekatan
  }
  return { closed, open };
}

function computeSwingPaper(merged) {
  let closed = [], open = [];
  for (const [sym, { bars, source }] of Object.entries(merged)) {
    const r = simulateSeries(sym, bars, source);
    closed = closed.concat(r.closed); open = open.concat(r.open);
  }
  const wins = closed.filter(t => t.netPct > 0);
  const grossWin = wins.reduce((a, t) => a + t.netPct, 0);
  const grossLoss = closed.filter(t => t.netPct <= 0).reduce((a, t) => a + Math.abs(t.netPct), 0);
  const totalNet = closed.reduce((a, t) => a + t.netPct, 0);
  const stats = {
    trades: closed.length,
    wins: wins.length,
    losses: closed.length - wins.length,
    winRate: closed.length ? +(wins.length / closed.length * 100).toFixed(1) : 0,
    avgNet: closed.length ? +(totalNet / closed.length).toFixed(3) : 0,
    totalNet: +totalNet.toFixed(2),
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? 99 : 0),
    tp: closed.filter(t => t.type === 'TP').length,
    sl: closed.filter(t => t.type === 'SL').length,
    time: closed.filter(t => t.type === 'TIME').length,
  };
  closed.sort((a, b) => (b.exitDate || '').localeCompare(a.exitDate || ''));
  open.sort((a, b) => (b.signalDate || '').localeCompare(a.signalDate || ''));
  return { stats, recent: closed.slice(0, 30), open };
}

// Orkestrasi: Yahoo sebagai sumber utama; pakai bar Stockbit bila sudah cukup panjang.
// opts: { coreSet: Set<simbol LQ45 inti>, lq45Only: bool } — strategi paling andal di LQ45.
async function getSwingCandidates(symbols, opts = {}) {
  const coreSet = opts.coreSet instanceof Set ? opts.coreSet : new Set(opts.coreSet || []);
  const lq45Only = !!opts.lq45Only;
  const yahoo = await ensureYahooBars(symbols); // selalu fetch penuh → cache harian konsisten
  const sb = loadStockbitDaily();
  const merged = {}, scanned = [];
  for (const sym of symbols.slice(0, SCAN_LIMIT)) {
    if (lq45Only && coreSet.size && !coreSet.has(sym)) continue; // saring movers spekulatif
    let bars = yahoo[sym], source = 'yahoo';
    if (Array.isArray(sb[sym]) && sb[sym].length >= 60) { bars = sb[sym]; source = 'stockbit'; } // mandiri bila cukup
    if (!Array.isArray(bars) || bars.length < MIN_BARS) continue;
    merged[sym] = { bars, source }; scanned.push(sym);
  }
  const candidates = [];
  for (const sym of scanned) {
    const c = scoreCandidate(sym, merged[sym].bars, merged[sym].source);
    if (c) { c.core = coreSet.has(sym); candidates.push(c); } // tandai saham LQ45 inti
  }
  candidates.sort((a, b) => a.rsi - b.rsi); // paling oversold di atas

  const paper = computeSwingPaper(merged);
  return {
    asOf: todayWib(),
    lq45Only,
    strategy: 'Beli Dip (RSI<28 + turun 2 hari) · TP 3×ATR / SL 2×ATR · tahan ≤3 hari',
    primarySource: candidates.some(c => c.source === 'stockbit') ? 'stockbit+yahoo' : 'yahoo',
    scanned: scanned.length,
    count: candidates.length,
    candidates,
    paper,
    note: 'Edge kecil & hanya andal saat pasar recovery/naik. Paper-trade dulu. Entry di OPEN besok.',
  };
}

// ── Penutupan harian dari STOCKBIT (endpoint charts/daily) — utk MA50/MA200 ──
// Catatan: endpoint ini hanya beri harga CLOSE (open/high/low/volume kosong),
// jadi cukup untuk MA/RSI tapi tidak untuk ATR/TP-SL (itu tetap pakai Yahoo).
const SB_CLOSES_CACHE = path.join(__dirname, 'data', 'daily_closes_stockbit.json');
async function fetchSbDailyCloses(symbol, retried = false) {
  try {
    const url = `https://exodus.stockbit.com/charts/${symbol}/daily?timeframe=1y`;
    const r = await axios.get(url, { headers: {
      'Authorization': 'Bearer ' + auth.getAccessToken(), 'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json', 'Origin': 'https://stockbit.com', 'Referer': 'https://stockbit.com/',
    }, timeout: 15000 });
    const d = r.data?.data ?? r.data;
    const arr = Array.isArray(d?.prices) ? d.prices : [];
    return arr.map(p => ({ date: p.formatted_date || '', close: parseFloat(p.value) || 0 })).filter(b => b.close > 0);
  } catch (e) {
    const st = e.response?.status;
    if ((st === 401 || st === 403) && !retried && auth.hasRefresh && auth.hasRefresh()) {
      const rr = await auth.refresh(); if (rr.ok) return fetchSbDailyCloses(symbol, true);
    }
    return [];
  }
}
async function ensureSbDaily(symbols) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(SB_CLOSES_CACHE, 'utf8')); } catch { /* baru */ }
  if (cache.date === todayWib() && cache.bars) return cache.bars;
  if (!(auth.hasToken && auth.hasToken())) return {};
  const bars = {};
  for (const s of symbols.slice(0, SCAN_LIMIT)) {
    bars[s] = await fetchSbDailyCloses(s);
    await new Promise(r => setTimeout(r, 180)); // lembut → hindari throttle Stockbit
  }
  try {
    fs.mkdirSync(path.dirname(SB_CLOSES_CACHE), { recursive: true });
    fs.writeFileSync(SB_CLOSES_CACHE, JSON.stringify({ date: todayWib(), fetchedAt: new Date().toISOString(), bars }, null, 0));
  } catch { /* abaikan */ }
  return bars;
}

// ── Tren jangka panjang MA50/MA200 (golden cross) — Stockbit primary, Yahoo fallback ──
function smaLast(arr, p) { if (arr.length < p) return 0; let s = 0; for (let i = arr.length - p; i < arr.length; i++) s += arr[i]; return s / p; }
async function getTrendMap(symbols) {
  const sbDaily = await ensureSbDaily(symbols);  // Stockbit close harian (sumber utama)
  let yahoo = null;                              // Yahoo hanya bila Stockbit kurang
  const trend = {};
  let usedSb = 0, usedYh = 0;
  for (const sym of symbols.slice(0, SCAN_LIMIT)) {
    let closes = null, source = null;
    if (Array.isArray(sbDaily[sym]) && sbDaily[sym].length >= 200) {
      closes = sbDaily[sym].map(b => b.close); source = 'stockbit'; usedSb++;
    } else {
      if (!yahoo) yahoo = await ensureYahooBars(symbols);
      const yb = yahoo[sym];
      if (Array.isArray(yb) && yb.length >= 50) { closes = yb.map(b => b.close); source = 'yahoo'; usedYh++; }
    }
    if (!closes) continue;
    const ma50 = smaLast(closes, 50), ma200 = smaLast(closes, 200), price = closes[closes.length - 1];
    trend[sym] = {
      ma50: Math.round(ma50), ma200: Math.round(ma200), price: Math.round(price), source,
      hasMa200: ma200 > 0,
      golden: ma50 > 0 && ma200 > 0 && ma50 > ma200,      // MA50 > MA200 = uptrend jangka panjang
      aboveMa200: ma200 > 0 && price > ma200,
    };
  }
  return {
    asOf: todayWib(),
    source: usedSb ? (usedYh ? 'stockbit+yahoo' : 'stockbit') : (usedYh ? 'yahoo' : 'none'),
    trend,
  };
}

module.exports = { getSwingCandidates, computeSwingPaper, getTrendMap, recordStockbitDaily, loadStockbitDaily };
