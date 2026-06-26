require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
const crypto = require('crypto');
const path = require('path');
const fs   = require('fs');
const { MultiProviderDataAggregator } = require('./idx_api_providers');
const stockbitAuth = require('./stockbit_auth');
const swingScreener = require('./swing_screener');
const gorenganFilter = require('./gorengan_filter');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3001;
const CACHE_FILE = path.join(__dirname, 'data', 'stock_cache.json');

app.use(express.json({ limit: '1mb' }));

// ════════════════════════════════════════════════════════════
//  AUTENTIKASI — lindungi dashboard sebelum dipublik online.
//  Set password lewat env DASHBOARD_PASSWORD (default: 'scalper123').
//  Sesi disimpan di cookie httpOnly bertanda-tangan HMAC.
// ════════════════════════════════════════════════════════════
const DASH_PASSWORD = process.env.DASHBOARD_PASSWORD || 'scalper123';
const COOKIE_NAME   = 'sb_auth';
const SECRET_FILE   = path.join(__dirname, 'data', 'session_secret');

function getSessionSecret() {
  try {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, 'utf8').trim();
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, s);
    return s;
  } catch { return 'fallback-secret-please-set-DASHBOARD_PASSWORD'; }
}
const SESSION_SECRET = getSessionSecret();
const AUTH_TOKEN = crypto.createHmac('sha256', SESSION_SECRET).update('dashboard:' + DASH_PASSWORD).digest('hex');

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function isAuthed(req) {
  return parseCookies(req.headers.cookie)[COOKIE_NAME] === AUTH_TOKEN;
}

// Halaman & endpoint login (publik, sebelum gate)
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (password && password === DASH_PASSWORD) {
    res.setHeader('Set-Cookie',
      `${COOKIE_NAME}=${AUTH_TOKEN}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`);
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, error: 'Password salah' });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

// Gate: semua selain login butuh sesi valid
app.use((req, res, next) => {
  if (isAuthed(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'unauthorized' });
  return res.redirect('/login');
});

// Socket.io juga digate (cegah ambil data tanpa login)
io.use((socket, next) => {
  const token = parseCookies(socket.handshake.headers.cookie)[COOKIE_NAME];
  if (token === AUTH_TOKEN) return next();
  next(new Error('unauthorized'));
});

// Serve static files (hanya setelah lolos gate)
app.use(express.static(path.join(__dirname, 'public')));

// Stock data cache
const stockCache = new Map();
const recommendations = new Map();
const signalTimestamps = new Map();
const SIGNAL_PERSISTENCE = 300000;

// Initialize multi-provider aggregator
const dataAggregator = new MultiProviderDataAggregator();

// ── Persist cache ke file ────────────────────────────────────
function saveCacheToFile() {
  try {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    const obj = {};
    stockCache.forEach((v, k) => { obj[k] = v; });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ savedAt: new Date().toISOString(), stocks: obj }, null, 2));
  } catch (e) { /* silent */ }
}

function loadCacheFromFile() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const raw   = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const saved = raw.stocks || {};
    let count   = 0;
    for (const [sym, data] of Object.entries(saved)) {
      stockCache.set(sym, { ...data, fromCache: true, cacheDate: raw.savedAt });
      count++;
    }
    if (count > 0) console.log(`📂 Cache dimuat dari file: ${count} saham (terakhir: ${raw.savedAt})`);
  } catch (e) { console.log('⚠️ Tidak bisa baca cache file:', e.message); }
}

// Hitung ulang RSI/SMA/sinyal dari cache (tanpa fetch Stockbit) — dipakai setelah restart / ganti mode
function rebuildRecommendationsFromCache() {
  computeMarketRegime();
  let n = 0;
  for (const [symbol, data] of stockCache.entries()) {
    if (!data?.price) continue;
    try {
      const sd = { ...data };
      if ((!sd.historical || sd.historical.length < 5) && priceHistory.has(symbol)) {
        sd.historical = priceHistory.get(symbol);
      }
      const openingRange = morningMomentumEnabled ? (openingRanges.get(symbol) || null) : null;
      const a = performTechnicalAnalysis(sd, {
        regimeMultiplier: regimeMultiplier(),
        buyThreshold: buyThreshold(),
        openingRange,
      });
      recommendations.set(symbol, a);
      n++;
    } catch { /* abaikan per-saham */ }
  }
  if (n) console.log(`🔄 Analisis dihitung ulang dari cache: ${n} saham`);
  return n;
}

// Push analisis terbaru ke semua client (setelah toggle mode / rebuild)
function pushAllAnalysisToClients() {
  for (const [symbol, data] of stockCache.entries()) {
    const a = recommendations.get(symbol);
    if (!a) continue;
    io.emit('stockUpdate', { symbol, data, analysis: a });
  }
}

// Muat cache saat startup
loadCacheFromFile();

// ════════════════════════════════════════════════════════════
//  PAPER-TRADING / PELACAK SINYAL (simulasi, tanpa uang asli)
//  Saat sinyal BELI muncul → buka "posisi kertas". Lalu dipantau:
//  kena Target (TP) = menang, kena Cut Loss (SL) = kalah, atau
//  ditahan terlalu lama → ditutup di harga berjalan (TIME).
//  Hasilnya dipakai menghitung win-rate & rata-rata profit bersih.
// ════════════════════════════════════════════════════════════
const TRADES_FILE = path.join(__dirname, 'data', 'trades.json');
const openPositions = new Map();   // symbol -> posisi terbuka
let tradeHistory = [];             // posisi yang sudah ditutup (terbaru di depan)
const MAX_TRADE_HISTORY = 500;
const PAPER_HOLD_MS = 10 * 24 * 60 * 60 * 1000; // BELI-TAHAN: maks ~10 hari (bukan scalp 90 menit)

function saveTrades() {
  try {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    const open = {};
    openPositions.forEach((v, k) => { open[k] = v; });
    fs.writeFileSync(TRADES_FILE, JSON.stringify({ savedAt: new Date().toISOString(), open, history: tradeHistory }, null, 2));
  } catch { /* abaikan */ }
}
function loadTrades() {
  try {
    if (!fs.existsSync(TRADES_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
    tradeHistory = Array.isArray(raw.history) ? raw.history : [];
    for (const [k, v] of Object.entries(raw.open || {})) openPositions.set(k, v);
    console.log(`📈 Riwayat paper-trading dimuat: ${tradeHistory.length} selesai, ${openPositions.size} posisi terbuka.`);
  } catch { /* abaikan */ }
}

function openPaperPosition(symbol, a) {
  if (openPositions.has(symbol)) return;
  if (!a || a.signal !== 'BUY' || !a.takeProfit || !a.stopLoss || !a.currentPrice) return;
  openPositions.set(symbol, {
    symbol,
    entry:      a.currentPrice,
    takeProfit: a.takeProfit,
    stopLoss:   a.stopLoss,
    tpPct:      a.tpPct,
    slPct:      a.slPct,
    feePct:     a.feePct != null ? a.feePct : 0.4,
    confidence: a.confidence,
    openedAt:   new Date().toISOString(),
    openedMs:   Date.now(),
    morningMode: a.strategy === 'morning_momentum' || a.indicators?.morningMode,
    openingHigh: a.indicators?.openingHigh || 0,
    holdMs:     (a.strategy === 'morning_momentum') ? MORNING_HOLD_MS : PAPER_HOLD_MS,
  });
  saveTrades();
  io.emit('tradesUpdated');
  console.log(`📝 Paper-trade DIBUKA ${symbol} @ ${a.currentPrice} (TP ${a.takeProfit} / SL ${a.stopLoss})`);
}

function closePaperPosition(symbol, exitPrice, outcome) {
  const pos = openPositions.get(symbol);
  if (!pos) return;
  openPositions.delete(symbol);
  const grossPct = pos.entry > 0 ? (exitPrice - pos.entry) / pos.entry * 100 : 0;
  const netPct   = grossPct - (pos.feePct || 0.4);
  tradeHistory.unshift({
    ...pos,
    exit:     exitPrice,
    outcome,                 // 'TP' | 'SL' | 'TIME'
    grossPct,
    netPct,
    closedAt: new Date().toISOString(),
    heldMin:  Math.round((Date.now() - (pos.openedMs || Date.now())) / 60000),
  });
  if (tradeHistory.length > MAX_TRADE_HISTORY) tradeHistory = tradeHistory.slice(0, MAX_TRADE_HISTORY);
  // Cooldown setelah cut loss (kalah) agar tidak langsung masuk lagi (anti "gergaji")
  if (outcome === 'SL') cooldownUntil.set(symbol, Date.now() + COOLDOWN_MS);
  saveTrades();
  io.emit('tradesUpdated');
  console.log(`📝 Paper-trade DITUTUP ${symbol} @ ${exitPrice} → ${outcome} (net ${netPct.toFixed(2)}%)`);
}

// Periksa posisi terbuka: trailing stop, lalu TP/SL/exit-dinamis/timeout
function checkPaperExits(symbol, price, high, low, exitSig) {
  const pos = openPositions.get(symbol);
  if (!pos || !price) return;
  // FIX: pakai HARGA SAAT INI, bukan high/low HARIAN. High/low harian mencakup gerakan
  // SEBELUM entry → bikin posisi tertutup seketika ("ditahan 1 menit"). Dicek tiap update.
  // Jangan cek exit di siklus posisi baru dibuka (beri waktu bergerak).
  if (Date.now() - (pos.openedMs || 0) < 30000) return; // <30 dtk sejak buka → tunggu

  // Trailing stop: setelah untung ≥ 1R, naikkan SL untuk mengunci profit (min. breakeven)
  pos.peak = Math.max(pos.peak || pos.entry, price);
  const oneR = pos.entry - pos.stopLoss;
  if (oneR > 0 && pos.peak >= pos.entry + oneR) {
    const trailSL = Math.max(pos.entry, roundToIDXPriceRules(pos.peak - oneR));
    if (trailSL > pos.stopLoss) { pos.stopLoss = trailSL; pos.trailed = true; saveTrades(); }
  }

  if (price >= pos.takeProfit)                      return closePaperPosition(symbol, pos.takeProfit, 'TP');
  if (price <= pos.stopLoss)                        return closePaperPosition(symbol, pos.stopLoss, pos.trailed ? 'TRAIL' : 'SL');
  // Morning ORB invalidation: harga kembali di bawah opening high
  if (pos.morningMode && pos.openingHigh > 0 && price < pos.openingHigh * 0.998) {
    return closePaperPosition(symbol, price, 'ORB_FAIL');
  }
  if (exitSig && exitSig.exit)                      return closePaperPosition(symbol, price, 'EXIT');
  const holdLimit = pos.holdMs || PAPER_HOLD_MS;
  if (Date.now() - (pos.openedMs || 0) > holdLimit) return closePaperPosition(symbol, price, 'TIME');
}

function computeTradeStats() {
  const n      = tradeHistory.length;
  const wins   = tradeHistory.filter(t => t.netPct > 0).length;
  const losses = n - wins;
  const totalNet = tradeHistory.reduce((s, t) => s + (t.netPct || 0), 0);
  const grossWin  = tradeHistory.filter(t => t.netPct > 0).reduce((s, t) => s + t.netPct, 0);
  const grossLoss = tradeHistory.filter(t => t.netPct <= 0).reduce((s, t) => s + t.netPct, 0);
  return {
    total: n,
    wins, losses,
    winRate: n ? wins / n * 100 : 0,
    avgNet:  n ? totalNet / n : 0,
    totalNet,
    tpHits:    tradeHistory.filter(t => t.outcome === 'TP').length,
    slHits:    tradeHistory.filter(t => t.outcome === 'SL').length,
    trailHits: tradeHistory.filter(t => t.outcome === 'TRAIL').length,
    exitHits:  tradeHistory.filter(t => t.outcome === 'EXIT').length,
    timeHits:  tradeHistory.filter(t => t.outcome === 'TIME').length,
    profitFactor: grossLoss < 0 ? grossWin / Math.abs(grossLoss) : (grossWin > 0 ? 99 : 0),
    open: openPositions.size,
  };
}

loadTrades();

// ════════════════════════════════════════════════════════════
//  FILTER & LOGIKA SCALPING TAMBAHAN
// ════════════════════════════════════════════════════════════

// ── Kondisi pasar (proxy IHSG via breadth saham yang dipantau) ──
// Kalau mayoritas saham turun, jangan agresif beli (lawan arus = risiko tinggi).
let marketRegime = { state: 'unknown', risk: false, breadthUp: 0, avgChange: 0, count: 0 };
function computeMarketRegime() {
  const arr = Array.from(stockCache.values()).filter(s => typeof s.changePercent === 'number');
  if (arr.length < 10) { marketRegime = { state: 'unknown', risk: false, breadthUp: 0, avgChange: 0, count: arr.length }; return; }
  const up = arr.filter(s => s.changePercent > 0).length;
  const breadthUp = up / arr.length * 100;
  const avgChange = arr.reduce((a, s) => a + (s.changePercent || 0), 0) / arr.length;
  let state = 'neutral';
  if (breadthUp >= 58 && avgChange > 0.15)      state = 'bullish';
  else if (breadthUp <= 42 || avgChange < -0.4) state = 'bearish';
  marketRegime = { state, risk: state === 'bearish', breadthUp, avgChange, count: arr.length };
}
// Pengali confidence sesuai kondisi pasar
function regimeMultiplier() {
  if (marketRegime.state === 'bearish') return 0.65;
  if (marketRegime.state === 'bullish') return 1.05;
  return 1.0;
}

// ── Ambang keyakinan ADAPTIF dari hasil paper-trading ──
// Strategi belajar dari hasilnya: kalau win-rate rendah, perketat; kalau tinggi, longgarkan.
function buyThreshold() {
  const st = computeTradeStats();
  let thr = 0.5;
  if (st.total >= 20) {
    if      (st.winRate < 40) thr = 0.62;
    else if (st.winRate < 50) thr = 0.56;
    else if (st.winRate > 68) thr = 0.45;
    else if (st.winRate > 58) thr = 0.48;
  }
  return thr;
}

// ── Cooldown setelah kena Cut Loss (hindari "kena gergaji" berulang) ──
const cooldownUntil = new Map();          // symbol -> timestamp boleh masuk lagi
const COOLDOWN_MS = 30 * 60 * 1000;       // 30 menit

// ── Jelang penutupan: jangan buka posisi scalp baru (tak sempat keluar) ──
const NO_ENTRY_AFTER = 14.5;              // 14:30 WIB (pasar tutup ~15:00)
function wibHourDecimal() {
  const wib = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
  return wib.getHours() + wib.getMinutes() / 60;
}
function todayWibStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
}

// ════════════════════════════════════════════════════════════
//  MORNING MOMENTUM MODE — ORB (Opening Range Breakout) pagi
//  Entry hanya 09:15–10:30 WIB. Di luar itu: tidak ada BELI baru.
// ════════════════════════════════════════════════════════════
const ORB_BUILD_START  = 9.0;    // 09:00 — mulai catat range
const ORB_BUILD_END    = 9.5;    // 09:30 — range selesai
const ORB_ENTRY_START  = 9.25;  // 09:15 — window entry
const ORB_ENTRY_END    = 10.5;   // 10:30 — tutup entry
const ORB_MAX_EXT_PCT  = 3.0;    // maks % di atas opening high (anti-chase)
const ORB_MIN_RS       = 0.5;    // outperform pasar (proxy IHSG) min 0.5%
const ORB_MIN_VOL      = 1.5;    // volume vs rata-rata min 1.5×
const MORNING_HOLD_MS  = 25 * 60 * 1000; // time stop posisi pagi: 25 menit

const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');
let morningMomentumEnabled = process.env.MORNING_MOMENTUM === '1'; // default OFF (ORB tak ber-edge & intraday; gaya beli-tahan lebih cocok)
const excludeGorenganEnabled = true; // PERMANEN — filter anti-gorengan selalu aktif (tak bisa dimatikan)
// Biaya transaksi (persen) — bisa disetel via UI/settings sesuai broker. Default Stockbit.
let feeBuyPct  = parseFloat(process.env.FEE_BUY_PCT)  || 0.15;
let feeSellPct = parseFloat(process.env.FEE_SELL_PCT) || 0.25;

function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (typeof raw.morningMomentum === 'boolean') morningMomentumEnabled = raw.morningMomentum;
    if (typeof raw.feeBuyPct  === 'number' && raw.feeBuyPct  >= 0) feeBuyPct  = raw.feeBuyPct;
    if (typeof raw.feeSellPct === 'number' && raw.feeSellPct >= 0) feeSellPct = raw.feeSellPct;
    // excludeGorengan: filter anti-gorengan sekarang PERMANEN, abaikan setelan tersimpan
  } catch { /* abaikan */ }
}
function saveSettings() {
  try {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
      morningMomentum: morningMomentumEnabled,
      excludeGorengan: excludeGorenganEnabled,
      feeBuyPct, feeSellPct,
    }, null, 2));
  } catch { /* abaikan */ }
}
loadSettings();

// Opening range per saham per hari: { date, high, low, ready, avgVol }
const openingRanges = new Map();

function updateOpeningRange(symbol, stockData) {
  const hr    = wibHourDecimal();
  const today = todayWibStr();
  let or = openingRanges.get(symbol);
  if (!or || or.date !== today) {
    or = { date: today, high: 0, low: Infinity, volSamples: [], ready: false };
  }
  const p = stockData.price;
  const h = stockData.high || p;
  const l = stockData.low  || p;

  if (hr >= ORB_BUILD_START && hr < ORB_BUILD_END) {
    or.high = Math.max(or.high, h, p);
    or.low  = Math.min(or.low, l, p);
    or.volSamples.push(stockData.volume || 0);
  } else if (hr >= ORB_BUILD_END && or.high > 0 && isFinite(or.low)) {
    or.ready = true;
    if (or.volSamples.length) {
      or.avgVol = or.volSamples.reduce((a, b) => a + b, 0) / or.volSamples.length;
    }
  }
  openingRanges.set(symbol, or);
  return or;
}

function getMorningPhase() {
  const hr = wibHourDecimal();
  if (isWeekend()) return 'weekend';
  if (hr < ORB_BUILD_START) return 'preopen';
  if (hr < ORB_ENTRY_START) return 'building';  // 09:00–09:15 — kumpul range, belum entry
  if (hr < ORB_ENTRY_END)   return 'entry';     // 09:15–10:30 — window ORB breakout
  if (hr < 12)              return 'midday';
  return 'afternoon';
}

// Analisis khusus Morning Momentum (ORB + RS + volume pembukaan)
function performMorningMomentumAnalysis(stockData, ctx = {}) {
  const { historical } = stockData;
  const currentPrice = stockData.price;
  const closes  = (historical || []).map(d => d.close).filter(c => c > 0);
  const highs   = (historical || []).map(d => d.high || d.close).filter(c => c > 0);
  const lows    = (historical || []).map(d => d.low  || d.close).filter(c => c > 0);
  const volumes = (historical || []).map(d => d.volume).filter(v => v > 0);

  const currentRSI   = calculateSimpleRSI(closes);
  const currentSMA20 = calculateSMA(closes, 20);
  const currentSMA50 = calculateSMA(closes, 50);
  const emaEntry     = scoreEmaEntry(closes, currentPrice);
  const smaTrendOk   = smaTrendFilterOk(currentPrice, currentSMA20, currentSMA50);
  const avgVolume    = volumes.length >= 5
    ? volumes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, volumes.length) : 0;
  const volumeRatio  = avgVolume > 0 ? (stockData.volume || 0) / avgVolume : 0;
  const liquidity    = checkLiquidity(stockData, historical || []);
  const foreignNet   = stockData.foreignNet || 0;
  const ch           = stockData.changePercent || 0;
  const phase        = getMorningPhase();

  const atr  = calculateSimpleATR(highs, lows, closes);
  let atrPct = (currentPrice > 0 && isFinite(atr) && atr > 0) ? atr / currentPrice : 0.01;
  atrPct = Math.min(0.03, Math.max(0.004, atrPct));

  // Filter keras
  if (currentPrice < 100) return mmHold('Harga < Rp100 (saham receh) — tidak layak trading', 0, currentPrice, currentRSI, currentSMA20, currentSMA50, volumeRatio, liquidity, atrPct, ctx);
  if ((stockData.foreignBuy || 0) === 0 && (stockData.foreignSell || 0) === 0 && (stockData.foreignNet || 0) === 0) return mmHold('Tanpa aktivitas asing — ciri saham gorengan', 0, currentPrice, currentRSI, currentSMA20, currentSMA50, volumeRatio, liquidity, atrPct, ctx);
  {
    const gr = gorenganCheck(stockData.symbol, stockData, volumeRatio);
    if (gr.excluded) return mmHold(gr.reason, 0, currentPrice, currentRSI, currentSMA20, currentSMA50, volumeRatio, liquidity, atrPct, ctx);
  }
  if (ch > 7)  return mmHold('Sudah naik ' + ch.toFixed(1) + '% — berisiko ARA', 0, currentPrice, currentRSI, currentSMA20, currentSMA50, volumeRatio, liquidity, atrPct, ctx);
  if (ch < -5) return mmHold('Turun ' + ch.toFixed(1) + '% — falling knife', 0, currentPrice, currentRSI, currentSMA20, currentSMA50, volumeRatio, liquidity, atrPct, ctx);
  if (currentRSI > 75) return mmHold('RSI overbought (' + currentRSI.toFixed(0) + ')', 0, currentPrice, currentRSI, currentSMA20, currentSMA50, volumeRatio, liquidity, atrPct, ctx);

  const or = ctx.openingRange || { high: 0, low: 0, ready: false };
  const openingHigh = or.high || 0;
  const openingLow  = or.low  || 0;

  // Di luar window entry → tidak ada BELI baru
  if (phase === 'preopen' || phase === 'weekend') {
    return mmHold('Di luar sesi — mode momentum pagi', 0, currentPrice, currentRSI, currentSMA20, currentSMA50, volumeRatio, liquidity, atrPct, ctx, or);
  }
  if (phase === 'building') {
    return mmHold('Membangun opening range (09:00–09:15) — entry mulai 09:15', 0.1, currentPrice, currentRSI, currentSMA20, currentSMA50, volumeRatio, liquidity, atrPct, ctx, or);
  }
  if (phase === 'midday' || phase === 'afternoon') {
    return mmHold('Window momentum pagi tutup (10:30) — tidak ada entry baru', 0, currentPrice, currentRSI, currentSMA20, currentSMA50, volumeRatio, liquidity, atrPct, ctx, or);
  }

  if (!or.ready || openingHigh <= 0) {
    return mmHold('Menunggu opening range selesai (s/d 09:30)', 0.15, currentPrice, currentRSI, currentSMA20, currentSMA50, volumeRatio, liquidity, atrPct, ctx, or);
  }

  // VWAP
  let vwap = 0, pv = 0, vv = 0;
  for (const b of (historical || [])) {
    const v = b.volume || 0;
    const typical = ((b.high || b.close) + (b.low || b.close) + b.close) / 3;
    if (v > 0 && typical > 0) { pv += typical * v; vv += v; }
  }
  vwap = vv > 0 ? pv / vv : 0;

  const bidVol = stockData.bidVolume || 0, askVol = stockData.askVolume || 0;
  const obTotal = bidVol + askVol;
  const obImb   = obTotal > 0 ? bidVol / obTotal : 0.5;
  const bestBid = stockData.bestBid || 0, bestAsk = stockData.bestAsk || 0;
  const spreadPct = (bestBid > 0 && bestAsk > 0 && currentPrice > 0 && bestAsk >= bestBid)
    ? (bestAsk - bestBid) / currentPrice * 100 : 0;

  // ── Faktor ORB ──
  const orbBreakout = currentPrice > openingHigh;
  const extPct = openingHigh > 0 ? (currentPrice - openingHigh) / openingHigh * 100 : 0;
  const tooExtended = extPct > ORB_MAX_EXT_PCT;
  const relStrength = ch - (marketRegime.avgChange || 0);
  const rsOK = relStrength >= ORB_MIN_RS;
  const volOK = volumeRatio >= ORB_MIN_VOL;

  const factors = [];
  let confidence = 0;

  // ORB breakout — 30%
  let fOrb = 0;
  if (orbBreakout && !tooExtended) { fOrb = 1.0; factors.push('ORB breakout > ' + Math.round(openingHigh)); }
  else if (orbBreakout && tooExtended) { fOrb = 0.2; factors.push('ORB breakout (extended +' + extPct.toFixed(1) + '%)'); }
  else if (currentPrice >= openingHigh * 0.998) { fOrb = 0.4; factors.push('Mendekati opening high'); }
  confidence += 0.30 * fOrb;

  // Volume — 25%
  let fVol = volumeRatio >= 2.5 ? 1.0 : volumeRatio >= ORB_MIN_VOL ? 0.75 : volumeRatio >= 1.2 ? 0.4 : 0.1;
  confidence += 0.25 * fVol;
  if (volumeRatio >= ORB_MIN_VOL) factors.push('Volume ' + volumeRatio.toFixed(1) + 'x');

  // Relative strength vs pasar — 20%
  let fRs = relStrength >= 1.5 ? 1.0 : relStrength >= ORB_MIN_RS ? 0.8 : relStrength >= 0.2 ? 0.4 : 0.1;
  confidence += 0.20 * fRs;
  if (rsOK) factors.push('RS +' + relStrength.toFixed(2) + '% vs pasar');

  // Foreign — 10%
  let fFor = foreignNet > 0 ? 1.0 : foreignNet < 0 ? 0.0 : 0.4;
  confidence += 0.10 * fFor;
  if (foreignNet > 0) factors.push('Asing net beli');

  // Order book — 10%
  let fOb = obTotal > 0 ? (obImb >= 0.60 ? 1.0 : obImb >= 0.52 ? 0.6 : 0.3) : 0.4;
  confidence += 0.10 * fOb;
  if (obImb >= 0.60) factors.push('Bid > Ask');

  // VWAP — 5%
  let fVwap = vwap > 0 && currentPrice > vwap ? 1.0 : 0.2;
  confidence += 0.05 * fVwap;
  if (fVwap >= 1) factors.push('Di atas VWAP');

  // EMA9/20 konfirmasi entry — 8%
  const fEma = emaEntry.score;
  confidence += 0.08 * fEma;
  if (emaEntry.label) factors.push(emaEntry.label);

  confidence = Math.max(0, Math.min(1, confidence));
  const regimeMult = ctx.regimeMultiplier != null ? ctx.regimeMultiplier : 1;
  if (regimeMult !== 1) {
    confidence = Math.max(0, Math.min(1, confidence * regimeMult));
    if (regimeMult < 1) factors.push('Pasar lemah ⚠️');
  }

  // TP/SL khusus momentum pagi: SL di bawah opening high, TP dekat +1%
  const FEE_RT_PCT = feeBuyPct + feeSellPct, MIN_NET_PCT = 0.6; // ikut fee konfigurabel
  const slPctRaw = atrPct;
  const tpPctRaw = Math.max(atrPct * 1.5, (FEE_RT_PCT + MIN_NET_PCT) / 100, 0.008);
  const slFromOrb = openingHigh > 0 ? roundToIDXPriceRules(openingHigh * 0.995) : 0;
  const slFromAtr = roundToIDXPriceRules(currentPrice * (1 - slPctRaw));
  const stopLoss  = roundToIDXPriceRules(Math.max(slFromOrb, slFromAtr)); // SL lebih ketat (lebih dekat)
  const takeProfit = roundToIDXPriceRules(Math.max(
    currentPrice * (1 + tpPctRaw),
    openingHigh * 1.01
  ));
  const realTpPct = currentPrice > 0 ? (takeProfit - currentPrice) / currentPrice * 100 : 0;
  const realSlPct = currentPrice > 0 ? (currentPrice - stopLoss) / currentPrice * 100 : 0;
  const costs    = calculateTransactionCosts(currentPrice, takeProfit);
  const feePct   = costs.costPercentage;
  const netTpPct = realTpPct - feePct;
  const buyThr   = ctx.buyThreshold != null ? ctx.buyThreshold : 0.45;
  const MAX_SPREAD = 0.5;
  const spreadOK = !(spreadPct > MAX_SPREAD);

  const indicators = {
    rsi: currentRSI, sma20: currentSMA20, sma50: currentSMA50, volumeRatio, atr, vwap,
    ema9: emaEntry.ema9, ema20: emaEntry.ema20, emaSignal: emaEntry.label, smaTrendOk,
    openingHigh, openingLow, orbBreakout, relStrength, spreadPct, obImbalance: obImb,
    morningMode: true, phase,
  };

  const emaOk = emaEntry.score >= 0.55;
  const isBuy = orbBreakout && !tooExtended && rsOK && volOK
    && confidence >= buyThr && liquidity.isLiquid && netTpPct >= 0.4 && spreadOK
    && stopLoss < currentPrice && smaTrendOk && emaOk;

  if (isBuy) {
    return {
      signal: 'BUY', confidence,
      reason: '🌅 ' + (factors.slice(0, 5).join(' | ') || 'ORB momentum pagi'),
      currentPrice, stopLoss, takeProfit,
      tpPct: realTpPct, slPct: realSlPct, netTpPct, netSlPct: realSlPct + feePct, feePct,
      breakEvenPrice: costs.breakEvenPrice,
      riskReward: realSlPct > 0 ? realTpPct / realSlPct : 0,
      netRR: realSlPct > 0 ? netTpPct / (realSlPct + feePct) : 0,
      atrPct: atrPct * 100, buyThreshold: buyThr, liquidity,
      transactionCosts: costs, indicators, strategy: 'morning_momentum',
    };
  }

  const why = tooExtended ? 'Terlalu extended (+' + extPct.toFixed(1) + '% di atas opening high)'
    : !orbBreakout ? 'Belum tembus opening high Rp' + Math.round(openingHigh)
    : !smaTrendOk ? 'Di bawah SMA20 / SMA20≤SMA50 — tren belum mendukung'
    : !emaOk ? 'EMA entry lemah (perlu pullback/momentum EMA9/20)'
    : !rsOK ? 'RS lemah (+' + relStrength.toFixed(2) + '% vs pasar, min +' + ORB_MIN_RS + '%)'
    : !volOK ? 'Volume kurang (' + volumeRatio.toFixed(1) + 'x, min ' + ORB_MIN_VOL + 'x)'
    : !spreadOK ? 'Spread terlalu lebar (' + spreadPct.toFixed(2) + '%)'
    : !liquidity.isLiquid ? 'Likuiditas kurang'
    : netTpPct < 0.4 ? 'Untung bersih < 0.4% (setelah fee)'
    : 'Confidence ' + Math.round(confidence * 100) + '% — belum cukup (ambang ' + Math.round(buyThr * 100) + '%)';

  const hold = mmHold(why, confidence, currentPrice, currentRSI, currentSMA20, currentSMA50, volumeRatio, liquidity, atrPct, ctx, or, indicators);
  hold.strategy = 'morning_momentum';
  return hold;
}

function mmHold(reason, confidence, price, rsi, sma20, sma50, volRatio, liquidity, atrPct, ctx, or, indicators) {
  const slPctRaw = atrPct;
  const stopLoss   = roundToIDXPriceRules(price * (1 - slPctRaw));
  const takeProfit = roundToIDXPriceRules(price * (1 + slPctRaw * 1.5));
  const ind = indicators || {
    rsi, sma20, sma50, volumeRatio: volRatio,
    ema9: 0, ema20: 0, smaTrendOk: smaTrendFilterOk(price, sma20, sma50),
    openingHigh: or?.high || 0, openingLow: or?.low || 0,
    morningMode: true, phase: getMorningPhase(),
  };
  return {
    signal: 'HOLD', confidence, reason,
    currentPrice: price, stopLoss, takeProfit,
    tpPct: price > 0 ? (takeProfit - price) / price * 100 : 0,
    slPct: price > 0 ? (price - stopLoss) / price * 100 : 0,
    riskReward: 1.5, atrPct: atrPct * 100, liquidity,
    transactionCosts: calculateTransactionCosts(price, takeProfit),
    indicators: ind,
    buyThreshold: ctx.buyThreshold != null ? ctx.buyThreshold : 0.45,
  };
}

// ── Sinyal KELUAR/JUAL dinamis untuk posisi berjalan ──
// Dipakai untuk menutup paper-position lebih awal & memberi peringatan di UI.
function computeExitSignal(stockData, analysis) {
  const ind = analysis?.indicators || {};
  const price = stockData.price;
  const reasons = [];
  // Morning ORB: gagal jika kembali di bawah opening high
  if (ind.openingHigh > 0 && price < ind.openingHigh * 0.998) {
    reasons.push('Gagal ORB (di bawah opening high)');
  }
  if (ind.rsi >= 74)                                   reasons.push('RSI jenuh beli (>74)');
  if (ind.vwap > 0 && price < ind.vwap)                reasons.push('Tembus bawah VWAP');
  if (ind.ema9 > 0 && price < ind.ema9 * 0.998)        reasons.push('Tembus bawah EMA9');
  else if (ind.sma20 > 0 && price < ind.sma20)         reasons.push('Tembus bawah SMA20');
  if ((stockData.changePercent || 0) <= -1.5)          reasons.push('Momentum berbalik turun');
  return { exit: reasons.length > 0, reasons };
}

// ── BACKTEST RINGAN ──────────────────────────────────────────
// Jalankan strategi pada riwayat harga intraday yang sudah terkumpul (priceHistory).
// Catatan: ini ESTIMASI dari candle 5-menit, bukan data tick penuh.
// ════════════════════════════════════════════════════════════
//  SCORING KIT — SATU SUMBER KEBENARAN (live = backtest = ablation)
//  Bobot & skor faktor dipakai performTechnicalAnalysis() DAN
//  runBacktest()/runAblation(), supaya backtest menguji model yang
//  SAMA dengan yang dipakai produksi (bukan aturan terpisah).
// ════════════════════════════════════════════════════════════
const FACTOR_WEIGHTS = {
  vol:      0.20, // konfirmasi volume (independen)
  mom:      0.15, // momentum % perubahan
  rsi:      0.15, // oscillator (zona ideal 52–66)
  sma:      0.08, // filter arah SMA20/50
  ema:      0.17, // timing entry EMA9/20 (pullback/momentum)
  vwap:     0.10, // lokasi harga vs VWAP intraday
  breakout: 0.08, // tembus high intraday
  ob:       0.07, // order book imbalance (independen) — tak ada di histori
  foreign:  0.05, // aliran asing (independen) — tak ada di histori
};
const FACTOR_WEIGHT_TOTAL = Object.values(FACTOR_WEIGHTS).reduce((a, b) => a + b, 0);

// Skor per-faktor (0..1). Murni & deterministik agar live identik dgn backtest.
function scoreVolumeFactor(volumeRatio, hasAvg) {
  if (!hasAvg) return 0.3;                 // data historis belum cukup → netral
  if (volumeRatio >= 2.5) return 1.0;
  if (volumeRatio >= 1.8) return 0.8;
  if (volumeRatio >= 1.3) return 0.55;
  if (volumeRatio >= 1.0) return 0.3;
  return 0.1;
}
function scoreMomentumFactor(ch) {
  let f = 0;
  if      (ch >= 0.3 && ch <= 3) f = 1 - Math.abs(ch - 1.2) / 3;
  else if (ch > 3 && ch <= 5)    f = 0.5;
  else if (ch >= 0 && ch < 0.3)  f = 0.3;
  return Math.max(0, Math.min(1, f));
}
function scoreRsiFactor(rsi) {
  if (rsi >= 52 && rsi <= 66) return 1.0;
  if (rsi >= 45 && rsi <= 70) return 0.6;
  if (rsi > 40  && rsi < 74)  return 0.3;
  return 0;
}
function scoreSmaFactor(price, sma20, sma50) {
  if (smaTrendFilterOk(price, sma20, sma50)) return 1.0;
  if (sma20 > 0 && price > sma20) return 0.4;
  return 0;
}
function scoreVwapFactor(price, vwap) {
  if (vwap <= 0) return 0.4;               // netral jika data volume belum cukup
  return price > vwap ? 1.0 : 0.15;
}
function scoreBreakoutFactor(price, intradayHigh) {
  if (intradayHigh <= 0) return 0;
  if (price >= intradayHigh) return 1.0;
  if (price >= intradayHigh * 0.995) return 0.5;
  return 0;
}

// Gabungkan skor faktor → confidence (0..1). `disabled` = faktor yang dimatikan
// (ablation); bobotnya diredistribusi agar skala confidence tetap sebanding.
function combineConfidence(scores, disabled) {
  let total = 0, sum = 0;
  for (const k of Object.keys(FACTOR_WEIGHTS)) {
    if (disabled === k) continue;
    total += FACTOR_WEIGHTS[k];
    sum   += FACTOR_WEIGHTS[k] * (scores[k] || 0);
  }
  const scaled = total > 0 ? sum * (FACTOR_WEIGHT_TOTAL / total) : 0;
  return Math.max(0, Math.min(1, scaled));
}

// ════════════════════════════════════════════════════════════
//  BACKTEST & ABLATION — menguji MODEL PRODUKSI di histori harga
// ════════════════════════════════════════════════════════════
const BT_THRESHOLD = 0.5;   // ambang confidence (sama dgn default produksi)
const BT_FEE       = 0.004; // biaya pulang-pergi 0.4%

// Hitung skor semua faktor untuk satu bar i (memakai kit yang sama dgn live).
// Catatan keterbatasan histori: momentum diaproksimasi antar-bar (produksi pakai
// %change harian), serta orderbook & aliran asing netral (tak terekam di histori).
function backtestFactorScores(closes, highs, lows, vols, i) {
  const price = closes[i];
  const sub   = closes.slice(0, i + 1);
  const rsi   = calculateSimpleRSI(sub);
  const sma20 = calculateSMA(sub, 20);
  const sma50 = calculateSMA(sub, 50);
  const ema   = scoreEmaEntry(sub, price);
  const avgVol = vols.slice(Math.max(0, i - 20), i).reduce((a, b) => a + b, 0) / Math.min(20, i || 1);
  const volumeRatio = avgVol > 0 ? vols[i] / avgVol : 0;
  const ch = closes[i - 1] > 0 ? (price - closes[i - 1]) / closes[i - 1] * 100 : 0;

  let pv = 0, vv = 0;
  for (let k = 0; k <= i; k++) {
    const v = vols[k] || 0;
    const typ = ((highs[k] || closes[k]) + (lows[k] || closes[k]) + closes[k]) / 3;
    if (v > 0 && typ > 0) { pv += typ * v; vv += v; }
  }
  const vwap = vv > 0 ? pv / vv : 0;
  const priorHighs   = highs.slice(0, i);
  const intradayHigh = priorHighs.length ? Math.max(...priorHighs) : 0;

  return {
    price, rsi, ch,
    smaTrendOk: smaTrendFilterOk(price, sma20, sma50),
    emaOk: ema.score >= 0.55,
    scores: {
      vol:      scoreVolumeFactor(volumeRatio, avgVol > 0),
      mom:      scoreMomentumFactor(ch),
      rsi:      scoreRsiFactor(rsi),
      sma:      scoreSmaFactor(price, sma20, sma50),
      ema:      ema.score,
      vwap:     scoreVwapFactor(price, vwap),
      breakout: scoreBreakoutFactor(price, intradayHigh),
      ob:       0.4, // netral — tak ada orderbook di histori
      foreign:  0.4, // netral — tak ada aliran asing di histori
    },
  };
}

// Keputusan BELI untuk satu bar, meniru gate produksi. Saat faktor 'sma'/'ema'
// diablasi, gerbangnya ikut dilepas (faktor benar-benar dimatikan).
function backtestDecision(fs, threshold, disabled) {
  if (fs.ch > 7 || fs.ch < -5 || fs.rsi > 72) return false;       // filter keras (selalu)
  if (disabled !== 'sma' && !fs.smaTrendOk) return false;          // gate arah
  if (disabled !== 'ema' && !fs.emaOk)       return false;          // gate timing EMA
  return combineConfidence(fs.scores, disabled) >= threshold;
}

// Jalankan strategi di seluruh histori. `disabled` = faktor diablasi (atau null).
// `data` = Map(simbol→bars); default histori live, tapi bisa disuntik data lain
// (mis. intraday 5-menit segar dari Stockbit untuk ablation yang lebih sahih).
// `exit` = geometri keluar (default = produksi: TP 2×ATR, SL 1×ATR, lantai TP 1%,
// fill optimis, tahan sampai TP/SL). Bisa di-override untuk sweep TP/SL:
//   { tpAtr, slAtr, tpFloor, holdBars, fill: 'optimistic'|'conservative' }
function runStrategyOverHistory(disabled, data = priceHistory, exit = null) {
  const cfg = Object.assign(
    { tpAtr: 2, slAtr: 1, tpFloor: 0.01, holdBars: 0, fill: 'optimistic' },
    exit || {}
  );
  let trades = 0, wins = 0, totalNet = 0;
  const symbols = [];
  for (const [sym, bars] of data.entries()) {
    if (!Array.isArray(bars) || bars.length < 25) continue;
    symbols.push(sym);
    const closes = bars.map(b => b.close).filter(c => c > 0);
    const highs  = bars.map(b => b.high || b.close);
    const lows   = bars.map(b => b.low  || b.close);
    const vols   = bars.map(b => b.volume || 0);
    for (let i = 20; i < bars.length - 1; i++) {
      const price = closes[i];
      if (!price) continue;
      const fs = backtestFactorScores(closes, highs, lows, vols, i);
      if (!backtestDecision(fs, BT_THRESHOLD, disabled)) continue;

      // TP/SL DINAMIS berbasis ATR — sama dengan produksi
      let atr = calculateSimpleATR(highs.slice(0, i + 1), lows.slice(0, i + 1), closes.slice(0, i + 1));
      let atrPct = (price > 0 && isFinite(atr) && atr > 0) ? atr / price : 0.01;
      atrPct = Math.min(0.03, Math.max(0.004, atrPct));
      const tpPct = Math.max(atrPct * cfg.tpAtr, cfg.tpFloor || 0), slPct = atrPct * cfg.slAtr;
      const tpPrice = price * (1 + tpPct), slPrice = price * (1 - slPct);

      let outcome = null;
      const lastBar = cfg.holdBars > 0 ? Math.min(bars.length, i + 1 + cfg.holdBars) : bars.length;
      for (let j = i + 1; j < lastBar; j++) {
        const hi = bars[j].high || bars[j].close, lo = bars[j].low || bars[j].close;
        const hitTP = hi >= tpPrice, hitSL = lo <= slPrice;
        // Bila satu candle menyentuh TP & SL sekaligus: optimis→TP, konservatif→SL.
        if (hitTP && hitSL) { outcome = cfg.fill === 'conservative' ? -slPct : tpPct; break; }
        if (hitTP) { outcome = tpPct; break; }
        if (hitSL) { outcome = -slPct; break; }
      }
      // Time stop: belum kena TP/SL sampai batas tahan → keluar di harga close terakhir
      if (outcome === null && cfg.holdBars > 0 && lastBar - 1 > i) {
        const exitClose = bars[lastBar - 1].close || price;
        outcome = price > 0 ? (exitClose - price) / price : 0;
      }
      if (outcome === null) continue;
      trades++;
      const net = outcome * 100 - BT_FEE * 100;
      totalNet += net;
      if (net > 0) wins++;
      i += 1; // hindari sinyal beruntun di bar berdekatan
    }
  }
  return {
    trades, wins, losses: trades - wins,
    winRate: trades ? wins / trades * 100 : 0,
    avgNet:  trades ? totalNet / trades : 0,
    totalNet, symbols: symbols.length,
  };
}

function runBacktest(data) {
  const r = runStrategyOverHistory(null, data);
  return {
    ...r,
    threshold: BT_THRESHOLD,
    note: 'Meniru model produksi (FACTOR_WEIGHTS) pada histori 5-menit. Momentum diaproksimasi antar-bar; orderbook & aliran asing netral (tak ada di histori).',
  };
}

// Leave-one-out ablation: matikan tiap faktor, ukur dampak ke win-rate & net.
// Δ negatif (winRate/avgNet turun) = faktor BERGUNA. Δ≈0 = redundan (kandidat
// dibuang). Δ positif (membaik) = faktor justru MERUGIKAN.
function runAblation(data) {
  const base = runStrategyOverHistory(null, data);
  const ABLATABLE = ['vol', 'mom', 'rsi', 'sma', 'ema', 'vwap', 'breakout'];
  const ablation = ABLATABLE.map(f => {
    const r = runStrategyOverHistory(f, data);
    return {
      factor: f, weight: FACTOR_WEIGHTS[f],
      trades: r.trades, winRate: r.winRate, avgNet: r.avgNet,
      dTrades:  r.trades  - base.trades,
      dWinRate: r.winRate - base.winRate,
      dAvgNet:  r.avgNet  - base.avgNet,
    };
  });
  return {
    baseline: {
      trades: base.trades, wins: base.wins, winRate: base.winRate,
      avgNet: base.avgNet, totalNet: base.totalNet, symbols: base.symbols,
    },
    ablation,
    notExercised: ['ob', 'foreign'], // konstan di histori → ablation tak bermakna
    note: 'Leave-one-out (bobot diredistribusi). Δ negatif winRate/avgNet = faktor BERGUNA. Δ≈0 = redundan. Δ positif = faktor MERUGIKAN.',
  };
}

// Saham IDX paling likuid (LQ45 + populer) untuk scalping (~45 saham)
// Saham inti = konstituen LQ45 (45 saham paling likuid di BEI).
// Ini selalu dipantau; sisanya ditambah otomatis dari Movers Stockbit (watchlist dinamis).
// Catatan: keanggotaan LQ45 ditinjau IDX tiap 6 bulan — sesuaikan bila ada perubahan.
const STOCK_SYMBOLS = [
  'ACES', 'ADMR', 'ADRO', 'AKRA', 'AMMN', 'AMRT', 'ANTM', 'ARTO', 'ASII',
  'BBCA', 'BBNI', 'BBRI', 'BBTN', 'BMRI', 'BRIS', 'BREN', 'BRPT',
  'CPIN', 'CTRA', 'ESSA', 'EXCL', 'GOTO', 'ICBP', 'INCO', 'INDF', 'INKP',
  'ISAT', 'ITMG', 'JSMR', 'KLBF', 'MAPA', 'MAPI', 'MBMA', 'MDKA', 'MEDC',
  'PGAS', 'PGEO', 'PTBA', 'SMGR', 'SMRA', 'TLKM', 'TOWR', 'TPIA', 'UNTR', 'UNVR',
];
const CORE_SET = new Set(STOCK_SYMBOLS);

function gorenganCheck(symbol, stockData, volumeRatio = 0) {
  return gorenganFilter.assessGorenganRisk(symbol, {
    ...stockData,
    volumeRatio: volumeRatio || stockData.volumeRatio || 0,
  }, {
    isCore: CORE_SET.has(symbol),
    enabled: excludeGorenganEnabled,
  });
}

// Watchlist AKTIF = saham inti (statis di atas) + saham "Movers" dinamis dari Stockbit.
// Diperbarui otomatis tiap pagi & tiap jam saat pasar buka, jadi bot mencari peluang
// dari SELURUH bursa (bukan cuma daftar tetap), tapi tetap fokus ke yang likuid.
let activeSymbols = [...STOCK_SYMBOLS];
let lastWatchlistRefresh = null; // ISO timestamp terakhir watchlist dinamis disusun
const MAX_WATCHLIST = 150;       // batas saham yang dipantau (jaga performa & rate-limit)
const MIN_MOVER_VALUE = 1e10;    // nilai transaksi minimal Rp10 miliar (anti-gorengan: uang kecil tak bisa gerakkan)

// ── Watchlist MANUAL (favorit) — selalu dipantau, tahan restart ──
const MANUAL_FILE = path.join(__dirname, 'data', 'watchlist_manual.json');
let manualSymbols = [];
function loadManualWatchlist() {
  try {
    if (!fs.existsSync(MANUAL_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(MANUAL_FILE, 'utf8'));
    if (Array.isArray(raw.symbols)) manualSymbols = raw.symbols;
  } catch { /* abaikan */ }
}
function saveManualWatchlist() {
  try {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    fs.writeFileSync(MANUAL_FILE, JSON.stringify({ savedAt: new Date().toISOString(), symbols: manualSymbols }, null, 2));
  } catch { /* abaikan */ }
}
loadManualWatchlist();

async function refreshDynamicWatchlist() {
  if (!dataAggregator.stockbit || !dataAggregator.stockbit._hasToken()) return;
  try {
    // Tarik beberapa kategori Movers — saham yang muncul di sini = yang benar-benar diperdagangkan hari ini
    const types = ['TOP_VALUE', 'TOP_VOLUME', 'TOP_FREQUENCY', 'NET_FOREIGN_BUY'];
    const lists = await Promise.all(types.map(t => dataAggregator.fetchMarketMover(t, false, { mainBoardOnly: true })));

    // Gabung & dedupe, simpan nilai transaksi tertinggi sebagai skor likuiditas
    const byValue = new Map();
    let skippedGorengan = 0;
    for (const list of lists) {
      for (const m of list) {
        if (!m.symbol || m.price < 100 || m.value < MIN_MOVER_VALUE) continue; // skip receh (<Rp100)
        const gr = gorenganFilter.assessGorenganRisk(m.symbol, {
          price: m.price,
          changePct: m.changePct,
          value: m.value,
          frequency: m.frequency,
          foreignNet: m.foreignBuy || 0,
        }, { isCore: CORE_SET.has(m.symbol), enabled: excludeGorenganEnabled });
        if (gr.excluded) { skippedGorengan++; continue; }
        if (!byValue.has(m.symbol) || byValue.get(m.symbol) < m.value) byValue.set(m.symbol, m.value);
      }
    }

    // Saham manual (favorit) + inti selalu ikut, lalu isi sisanya dengan mover teratas
    const movers   = [...byValue.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
    const seen     = new Set();
    const combined = [];
    for (const s of [...manualSymbols, ...STOCK_SYMBOLS, ...movers]) {
      if (seen.has(s)) continue;
      seen.add(s);
      combined.push(s);
      if (combined.length >= MAX_WATCHLIST) break;
    }

    const core = new Set([...manualSymbols, ...STOCK_SYMBOLS]);
    const fromMovers = combined.filter(s => !core.has(s)).length;
    activeSymbols = combined;
    lastWatchlistRefresh = new Date().toISOString();

    // Buang saham yang tidak lagi di watchlist dari semua cache agar jumlah konsisten
    const active = new Set(activeSymbols);
    for (const m of [stockCache, recommendations, historicalDataCache, priceHistory, signalTimestamps]) {
      for (const key of m.keys()) if (!active.has(key)) m.delete(key);
    }
    saveCacheToFile();
    savePriceHistory();
    io.emit('watchlistChanged', { symbols: activeSymbols });

    console.log(`🔎 Watchlist dinamis: ${activeSymbols.length} saham dipantau (${fromMovers} dari Movers Stockbit hari ini${skippedGorengan ? `, ${skippedGorengan} gorengan disaring` : ''}).`);
  } catch (e) {
    console.error('Gagal memperbarui watchlist dinamis:', e.message);
  }
}

// (fetchStockData dipindah ke dalam updateStockData menggunakan batch)
// Data harga + volume + asing semuanya dari Stockbit (lihat idx_api_providers.js).
// History dibangun rolling dari data live (priceHistory) — tidak perlu endpoint historis.


// Analisis teknikal scalping IDX
// - Hanya BUY (IDX retail tidak bisa short)
// - Entry berdasarkan momentum + volume spike + trend + aliran asing
// - TP/SL DINAMIS mengikuti volatilitas (ATR), bukan dipatok 1%
// - Confidence kontinu 0–100% (bukan skor diskrit)
function performTechnicalAnalysis(stockData, ctx = {}) {
  const phase = getMorningPhase();
  // ORB hanya jalan saat window entry 09:15–10:30. Di luar itu pakai analisis standar.
  if (morningMomentumEnabled && !isWeekend() && phase === 'entry') {
    return performMorningMomentumAnalysis(stockData, ctx);
  }

  const { historical } = stockData;
  const currentPrice = stockData.price;

  const closes  = (historical || []).map(d => d.close).filter(c => c > 0);
  const highs   = (historical || []).map(d => d.high || d.close).filter(c => c > 0);
  const lows    = (historical || []).map(d => d.low  || d.close).filter(c => c > 0);
  const volumes = (historical || []).map(d => d.volume).filter(v => v > 0);

  const currentRSI   = calculateSimpleRSI(closes);
  const currentSMA20 = calculateSMA(closes, 20);
  const currentSMA50 = calculateSMA(closes, 50);
  const emaEntry     = scoreEmaEntry(closes, currentPrice);
  const smaTrendOk   = smaTrendFilterOk(currentPrice, currentSMA20, currentSMA50);
  const avgVolume    = volumes.length >= 5
    ? volumes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, volumes.length)
    : 0;
  const volumeRatio  = avgVolume > 0 ? (stockData.volume || 0) / avgVolume : 0;
  const liquidity    = checkLiquidity(stockData, historical || []);
  const foreignNet   = stockData.foreignNet || 0;
  const ch           = stockData.changePercent || 0;

  // Volatilitas → ATR untuk TP/SL dinamis (dibatasi 0.4%–3% agar wajar)
  const atr  = calculateSimpleATR(highs, lows, closes);
  let atrPct = (currentPrice > 0 && isFinite(atr) && atr > 0) ? atr / currentPrice : 0.01;
  atrPct = Math.min(0.03, Math.max(0.004, atrPct));

  // ── FILTER KERAS ─────────────────────────────────────────────
  if (currentPrice < 100) { // saham receh (< Rp100) — spread lebar, rawan manipulasi
    return buildResult('HOLD', 0, 'Harga < Rp100 (saham receh) — tidak layak trading',
      currentPrice, currentRSI, currentSMA20, currentSMA50, volumeRatio, liquidity, atrPct);
  }
  // Anti-gorengan: nol aktivitas asing = ciri saham digoreng retail (asing menghindarinya)
  if ((stockData.foreignBuy || 0) === 0 && (stockData.foreignSell || 0) === 0 && (stockData.foreignNet || 0) === 0) {
    return buildResult('HOLD', 0, 'Tanpa aktivitas asing — ciri saham gorengan',
      currentPrice, currentRSI, currentSMA20, currentSMA50, volumeRatio, liquidity, atrPct);
  }
  {
    const gr = gorenganCheck(stockData.symbol, stockData, volumeRatio);
    if (gr.excluded) {
      return buildResult('HOLD', 0, gr.reason,
        currentPrice, currentRSI, currentSMA20, currentSMA50, volumeRatio, liquidity, atrPct);
    }
  }
  if (ch > 7) {
    return buildResult('HOLD', 0, `Sudah naik ${ch.toFixed(1)}% — berisiko ARA`,
      currentPrice, currentRSI, currentSMA20, currentSMA50, volumeRatio, liquidity, atrPct);
  }
  if (ch < -5) {
    return buildResult('HOLD', 0, `Turun ${ch.toFixed(1)}% — falling knife`,
      currentPrice, currentRSI, currentSMA20, currentSMA50, volumeRatio, liquidity, atrPct);
  }
  if (currentRSI > 72) {
    return buildResult('HOLD', 0, `RSI overbought (${currentRSI.toFixed(0)}) — terlambat masuk`,
      currentPrice, currentRSI, currentSMA20, currentSMA50, volumeRatio, liquidity, atrPct);
  }

  // ── INDIKATOR TAMBAHAN (VWAP, breakout, order book) ──────────
  // VWAP = harga rata-rata tertimbang volume sepanjang sesi (patokan "wajar" intraday)
  let vwap = 0;
  {
    let pv = 0, vv = 0;
    for (const b of (historical || [])) {
      const v = b.volume || 0;
      const typical = ((b.high || b.close) + (b.low || b.close) + b.close) / 3;
      if (v > 0 && typical > 0) { pv += typical * v; vv += v; }
    }
    vwap = vv > 0 ? pv / vv : 0;
  }

  // Breakout: harga menembus tertinggi intraday sebelumnya
  const priorHighs   = highs.length > 1 ? highs.slice(0, -1) : highs;
  const intradayHigh = priorHighs.length ? Math.max(...priorHighs) : 0;

  // Order book imbalance: porsi volume antrian beli (bid) vs total
  const bidVol  = stockData.bidVolume || 0;
  const askVol  = stockData.askVolume || 0;
  const obTotal = bidVol + askVol;
  const obImb   = obTotal > 0 ? bidVol / obTotal : 0.5; // 0.5 = netral / tak ada data

  // Spread bid-ask (%). Spread lebar = sulit cuan scalping (slippage). 0 = tak ada data.
  const bestBid = stockData.bestBid || 0;
  const bestAsk = stockData.bestAsk || 0;
  const spreadPct = (bestBid > 0 && bestAsk > 0 && currentPrice > 0 && bestAsk >= bestBid)
    ? (bestAsk - bestBid) / currentPrice * 100 : 0;

  // ── CONFIDENCE BERBOBOT (0..1) — pilar terpusat di FACTOR_WEIGHTS ──
  // Skor tiap faktor memakai scorer murni yang sama persis dengan backtest,
  // jadi rekomendasi live & hasil runBacktest()/runAblation() konsisten.
  const W = FACTOR_WEIGHTS;
  const factors = [];
  let confidence = 0;

  // 1. Volume spike (independen — paling penting untuk scalping)
  const fVol = scoreVolumeFactor(volumeRatio, avgVolume > 0);
  confidence += W.vol * fVol;
  if (fVol >= 0.55) factors.push(`Volume ${volumeRatio.toFixed(1)}x`);

  // 2. Momentum (ideal sekitar +1.2%)
  const fMom = scoreMomentumFactor(ch);
  confidence += W.mom * fMom;
  if (ch >= 0.3) factors.push(`Momentum +${ch.toFixed(2)}%`);

  // 3. RSI (ideal 52–66)
  const fRsi = scoreRsiFactor(currentRSI);
  confidence += W.rsi * fRsi;
  if (fRsi >= 0.6) factors.push(`RSI ${currentRSI.toFixed(0)}`);

  // 4. SMA trend FILTER (gate arah — bukan entry trigger)
  const fSma = scoreSmaFactor(currentPrice, currentSMA20, currentSMA50);
  confidence += W.sma * fSma;
  if (fSma >= 1.0) factors.push('Uptrend SMA (filter)');

  // 5. EMA9/20 entry timing (pullback bounce / momentum)
  const fEma = emaEntry.score;
  confidence += W.ema * fEma;
  if (emaEntry.label) factors.push(emaEntry.label);

  // 6. VWAP (harga di atas VWAP = kuat)
  const fVwap = scoreVwapFactor(currentPrice, vwap);
  confidence += W.vwap * fVwap;
  if (fVwap >= 1.0) factors.push('Di atas VWAP');

  // 7. Breakout high intraday
  const fBreak = scoreBreakoutFactor(currentPrice, intradayHigh);
  confidence += W.breakout * fBreak;
  if (fBreak >= 1.0) factors.push('Breakout high');

  // 8. Order book imbalance (independen)
  let fOb = 0.4; // netral jika tak ada data orderbook
  if (obTotal > 0) {
    if      (obImb >= 0.60) { fOb = 1.0; factors.push('Bid > Ask (tekanan beli)'); }
    else if (obImb >= 0.52)   fOb = 0.6;
    else if (obImb >= 0.45)   fOb = 0.35;
    else                      fOb = 0.1;
  }
  confidence += W.ob * fOb;

  // 9. Aliran asing (independen)
  let fFor = 0.4;
  if      (foreignNet > 0) { fFor = 1.0; factors.push('Asing net beli'); }
  else if (foreignNet < 0) { fFor = 0.0; }
  confidence += W.foreign * fFor;

  confidence = Math.max(0, Math.min(1, confidence));

  // Dampening sesuai kondisi pasar (breadth IHSG). Pasar lemah → turunkan keyakinan.
  const regimeMult = ctx.regimeMultiplier != null ? ctx.regimeMultiplier : 1;
  if (regimeMult !== 1) {
    confidence = Math.max(0, Math.min(1, confidence * regimeMult));
    if (regimeMult < 1) factors.push('Pasar lemah ⚠️');
  }

  // ── TP/SL DINAMIS (berbasis ATR) + SADAR BIAYA TRANSAKSI ─────
  // Biaya pulang-pergi IDX ≈ 0.44%. TP wajib menutup fee + untung bersih,
  // supaya rekomendasi tidak "menang di layar tapi rugi di rekening".
  // BELI-TAHAN (5–10 hari): TP/SL LEBAR supaya pemenang dibiarkan lari & tak ter-churn
  // oleh noise harian (sweep membuktikan churn TP/SL ketat = rugi). Exit utama =
  // time-stop ~10 hari (PAPER_HOLD_MS). SL hanya untuk memotong kerugian besar.
  const slPctRaw = Math.max(atrPct * 2.5, 0.035);  // SL ≥ 3.5% (potong rugi besar saja)
  const tpPctRaw = Math.max(atrPct * 4,   0.06);   // TP ≥ 6% (biarkan pemenang lari)

  const stopLoss   = roundToIDXPriceRules(currentPrice * (1 - slPctRaw));
  const takeProfit = roundToIDXPriceRules(currentPrice * (1 + tpPctRaw));
  const realTpPct  = currentPrice > 0 ? (takeProfit - currentPrice) / currentPrice * 100 : 0;
  const realSlPct  = currentPrice > 0 ? (currentPrice - stopLoss)   / currentPrice * 100 : 0;
  const costs      = calculateTransactionCosts(currentPrice, takeProfit);
  const feePct     = costs.costPercentage;        // % biaya pulang-pergi aktual
  const netTpPct   = realTpPct - feePct;          // untung BERSIH bila kena TP
  const netSlPct   = realSlPct + feePct;          // rugi BERSIH bila kena SL
  const netRR      = netSlPct > 0 ? netTpPct / netSlPct : 0;

  // ── KEPUTUSAN ─────────────────────────────────────────────────
  // Ambang keyakinan ADAPTIF (default 0.5; disetel dari hasil paper-trading).
  // Selain net profit > 0, untung bersih harus layak (≥ 0.4%) & spread tidak lebar.
  const buyThr   = ctx.buyThreshold != null ? ctx.buyThreshold : 0.5;
  const MAX_SPREAD = 0.5;                 // spread maksimal 0.5% (di atas itu boros slippage)
  const spreadOK = !(spreadPct > MAX_SPREAD);
  const emaOk = emaEntry.score >= 0.55; // minimal momentum/pullback EMA layak
  const isBuy = confidence >= buyThr && liquidity.isLiquid && netTpPct >= 0.4 && spreadOK
    && smaTrendOk && emaOk;

  const indicators = {
    rsi: currentRSI, sma20: currentSMA20, sma50: currentSMA50,
    ema9: emaEntry.ema9, ema20: emaEntry.ema20, emaSignal: emaEntry.label,
    volumeRatio, atr, vwap, intradayHigh, obImbalance: obImb, spreadPct, smaTrendOk,
  };

  if (isBuy) {
    // Momentum pagi ON tapi di luar 09:15–10:30 → indikator tetap tampil, BELI diblokir
    if (morningMomentumEnabled && !isWeekend() && phase !== 'entry') {
      const hold = buildResult('HOLD', confidence,
        `Momentum pagi ON — entry hanya 09:15–10:30 · ${factors.slice(0, 3).join(' | ') || 'kondisi bagus'}`,
        currentPrice, currentRSI, currentSMA20, currentSMA50, volumeRatio, liquidity, atrPct);
      hold.indicators = { ...indicators, morningMode: true, phase };
      hold.buyThreshold = buyThr;
      hold.strategy = 'morning_momentum';
      return hold;
    }
    return {
      signal: 'BUY',
      confidence,
      reason: factors.slice(0, 6).join(' | ') || 'Sinyal momentum',
      currentPrice, stopLoss, takeProfit,
      tpPct: realTpPct, slPct: realSlPct,
      netTpPct, netSlPct, feePct,
      breakEvenPrice: costs.breakEvenPrice,
      riskReward: realSlPct > 0 ? realTpPct / realSlPct : 0,
      netRR,
      atrPct: atrPct * 100,
      buyThreshold: buyThr,
      liquidity,
      transactionCosts: costs,
      indicators,
      strategy: 'beli_tahan',
      holdDays: '5–10',   // horizon yang divalidasi: tahan beberapa hari, jangan jual cepat
    };
  }

  const why = !spreadOK ? `Spread terlalu lebar (${spreadPct.toFixed(2)}%)`
    : !smaTrendOk ? 'Di bawah SMA20 / SMA20≤SMA50 — tren belum mendukung'
    : !emaOk ? `EMA entry lemah (perlu pullback/momentum EMA9/20)`
    : confidence < buyThr ? `Confidence ${Math.round(confidence * 100)}% — belum cukup yakin (ambang ${Math.round(buyThr*100)}%)`
    : !liquidity.isLiquid ? 'Likuiditas kurang'
    : `Untung bersih < 0.4% (setelah fee ${feePct.toFixed(2)}%)`;
  const hold = buildResult('HOLD', confidence, why,
    currentPrice, currentRSI, currentSMA20, currentSMA50, volumeRatio, liquidity, atrPct);
  hold.indicators = { ...indicators };
  hold.buyThreshold = buyThr;
  return hold;
}

function buildResult(signal, confidence, reason, price, rsi, sma20, sma50, volRatio, liquidity, atrPct = 0.01, closes = []) {
  const stopLoss   = roundToIDXPriceRules(price * (1 - atrPct));
  const takeProfit = roundToIDXPriceRules(price * (1 + atrPct * 2));
  const emaEntry   = closes.length ? scoreEmaEntry(closes, price) : { ema9: 0, ema20: 0, label: null };
  return {
    signal, confidence, reason,
    currentPrice: price,
    stopLoss, takeProfit,
    tpPct: price > 0 ? (takeProfit - price) / price * 100 : 0,
    slPct: price > 0 ? (price - stopLoss)   / price * 100 : 0,
    riskReward: 2,
    atrPct: atrPct * 100,
    liquidity,
    transactionCosts: calculateTransactionCosts(price, takeProfit),
    indicators: {
      rsi, sma20, sma50, volumeRatio: volRatio,
      ema9: emaEntry.ema9, ema20: emaEntry.ema20,
      smaTrendOk: smaTrendFilterOk(price, sma20, sma50),
    },
  };
}

// Simple RSI calculation
function calculateSimpleRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;

  // FIX: pakai `period` perubahan harga TERBARU (bukan bar paling awal).
  // Sebelumnya loop 1..period membaca 15 bar pertama → RSI macet pada data lama.
  const start = closes.length - period;
  for (let i = start; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100; // tak ada penurunan → jenuh beli
  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));

  return Math.min(100, Math.max(0, rsi));
}

// Simple Moving Average
function calculateSMA(closes, period) {
  if (closes.length < period) return closes[closes.length - 1] || 0;
  const sum = closes.slice(-period).reduce((a, b) => a + b, 0);
  return sum / period;
}

// Exponential Moving Average — lebih responsif untuk timing entry scalping
function calculateEMA(closes, period) {
  if (!closes.length) return 0;
  if (closes.length < period) return calculateSMA(closes, closes.length);
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

// Skor entry EMA9/20: pullback bounce & momentum (timing entry)
function scoreEmaEntry(closes, price) {
  const ema9  = calculateEMA(closes, 9);
  const ema20 = calculateEMA(closes, 20);
  if (!ema9 || !ema20) return { score: 0.2, label: null, ema9, ema20 };

  const prevClose = closes.length >= 2 ? closes[closes.length - 2] : price;
  const prevEma9  = closes.length >= 10 ? calculateEMA(closes.slice(0, -1), 9) : ema9;
  const aligned   = ema9 > ema20 && price > ema20;
  const touchedEma9 = prevClose <= ema9 * 1.008 && prevClose >= ema9 * 0.985;
  const bouncing  = price > prevClose && price >= ema9 * 0.998;
  const ema9Rising = ema9 >= prevEma9 * 0.9995;

  let score = 0.1, label = null;
  if (aligned && touchedEma9 && bouncing)       { score = 1.0;  label = 'EMA9 pullback bounce'; }
  else if (aligned && ema9Rising && price > ema9) { score = 0.85; label = 'EMA9/20 momentum'; }
  else if (price > ema20 && ema9 > ema20)       { score = 0.65; label = 'Di atas EMA20'; }
  else if (price > ema9)                        { score = 0.35; }
  return { score, label, ema9, ema20 };
}

// Filter tren SMA (gate arah — bukan trigger entry)
function smaTrendFilterOk(price, sma20, sma50) {
  if (!sma20 || price <= sma20) return false;
  if (sma50 > 0 && sma20 <= sma50) return false;
  return true;
}

// Simple Bollinger Bands
function calculateBollingerBands(closes, period = 20, stdDev = 2) {
  if (closes.length < period) return { upper: 0, middle: 0, lower: 0 };
  
  const sma = calculateSMA(closes, period);
  const recentCloses = closes.slice(-period);
  
  const variance = recentCloses.reduce((sum, price) => {
    return sum + Math.pow(price - sma, 2);
  }, 0) / period;
  
  const stdDeviation = Math.sqrt(variance);
  
  return {
    upper: sma + (stdDeviation * stdDev),
    middle: sma,
    lower: sma - (stdDeviation * stdDev)
  };
}

// Simple ATR calculation
function calculateSimpleATR(highs, lows, closes, period = 14) {
  if (highs.length < period + 1) return closes[closes.length - 1] * 0.02;

  let trSum = 0;

  // FIX: pakai `period` bar TERBARU (bukan bar paling awal). Sebelumnya loop
  // 1..period membaca 15 bar pertama → ATR (ukuran TP/SL) macet pada volatilitas lama.
  const start = highs.length - period;
  for (let i = start; i < highs.length; i++) {
    const high = highs[i];
    const low = lows[i];
    const prevClose = closes[i - 1];

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );

    trSum += tr;
  }

  return trSum / period;
}

// IDX Price Fraction Rules (BEI/IDX Regulation)
function roundToIDXPriceRules(price) {
  if (price >= 50 && price <= 200) {
    // Rp1 increments for Rp50-Rp200 range
    return Math.round(price);
  } else if (price > 200 && price <= 500) {
    // Rp2 increments for Rp200-Rp500 range
    return Math.round(price / 2) * 2;
  } else if (price > 500 && price <= 2000) {
    // Rp5 increments for Rp500-Rp2000 range
    return Math.round(price / 5) * 5;
  } else if (price > 2000 && price <= 5000) {
    // Rp10 increments for Rp2000-Rp5000 range
    return Math.round(price / 10) * 10;
  } else if (price > 5000) {
    // Rp25 increments for above Rp5000
    return Math.round(price / 25) * 25;
  }
  return Math.round(price);
}

// Transaction cost calculation for IDX
// Biaya transaksi RESMI Stockbit Sekuritas (sumber: help.stockbit.com, 2026).
// Fee sudah ALL-IN: termasuk biaya broker, levy BEI/KPEI/KSEI 0,043%,
// PPN broker, dan PPh final 0,1% (di sisi jual).
function calculateTransactionCosts(buyPrice, sellPrice, quantity = 100) {
  const buyCost  = buyPrice  * quantity * (feeBuyPct  / 100); // fee beli (%) → fraksi
  const sellCost = sellPrice * quantity * (feeSellPct / 100); // fee jual (%) → fraksi

  const totalCost = buyCost + sellCost;
  const costPercentage = (totalCost / (buyPrice * quantity)) * 100;
  
  return {
    buyCost,
    sellCost,
    totalCost,
    costPercentage,
    netProfit: (sellPrice - buyPrice) * quantity - totalCost,
    breakEvenPrice: buyPrice + (totalCost / quantity)
  };
}

// Check stock liquidity based on volume and price movement
function checkLiquidity(stockData, historicalData) {
  const avgVolume = historicalData.slice(-20).reduce((sum, d) => sum + (d.volume || 0), 0) / 20;
  const currentVolume = stockData.volume || 0;
  const volumeRatio = currentVolume / avgVolume;
  
  // Liquidity scoring
  let liquidityScore = 0;
  let liquidityReasons = [];
  
  // Volume criteria
  if (avgVolume > 10000000) { // > 10M shares/day
    liquidityScore += 0.4;
    liquidityReasons.push('High average volume');
  } else if (avgVolume > 5000000) { // > 5M shares/day
    liquidityScore += 0.3;
    liquidityReasons.push('Medium average volume');
  } else if (avgVolume > 1000000) { // > 1M shares/day
    liquidityScore += 0.2;
    liquidityReasons.push('Low average volume');
  } else {
    liquidityReasons.push('Very low average volume');
  }
  
  // Current volume ratio
  if (volumeRatio > 2.0) {
    liquidityScore += 0.3;
    liquidityReasons.push('Very high current volume');
  } else if (volumeRatio > 1.5) {
    liquidityScore += 0.2;
    liquidityReasons.push('Above average current volume');
  } else if (volumeRatio > 1.0) {
    liquidityScore += 0.1;
    liquidityReasons.push('Normal current volume');
  }
  
  // Price range (avoid very low price stocks that may be illiquid)
  if (stockData.price >= 200 && stockData.price <= 5000) {
    liquidityScore += 0.3;
    liquidityReasons.push('Optimal price range');
  } else if (stockData.price < 50) {
    liquidityReasons.push('Very low price - potential liquidity issue');
  }
  
  return {
    score: liquidityScore,
    isLiquid: liquidityScore >= 0.5,
    reasons: liquidityReasons,
    avgVolume,
    currentVolume,
    volumeRatio
  };
}

// Check if market is open
function isMarketOpen() {
  const now = new Date();
  const day = now.getDay(); // 0 = Sunday, 6 = Saturday
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const currentTime = hours + minutes / 60;
  
  // Market hours: Monday-Friday, 09:00-15:00 WIB
  const isWeekday = day >= 1 && day <= 5;
  const isMarketHours = currentTime >= 9 && currentTime < 15;
  
  return isWeekday && isMarketHours;
}

// Cache for historical data to prevent regeneration
const historicalDataCache = new Map();

// Update stock data and emit real-time updates
// Deteksi akhir pekan
function isWeekend() {
  const wib = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
  return wib.getDay() === 0 || wib.getDay() === 6;
}

// Throttle update saat akhir pekan — max 1x per jam
let lastWeekendUpdate = 0;

// Rolling price history per simbol (untuk RSI/SMA timeframe scalping)
const priceHistory = new Map();
const MAX_HISTORY  = 60;
const PRICE_HISTORY_FILE = path.join(__dirname, 'data', 'price_history.json');

// Simpan riwayat harga ke disk supaya RSI/SMA tidak hilang saat server restart
function savePriceHistory() {
  try {
    const obj = {};
    for (const [sym, arr] of priceHistory.entries()) obj[sym] = arr;
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    fs.writeFileSync(PRICE_HISTORY_FILE, JSON.stringify({ savedAt: new Date().toISOString(), history: obj }));
  } catch (e) { /* abaikan */ }
}

function loadPriceHistory() {
  try {
    if (!fs.existsSync(PRICE_HISTORY_FILE)) return;
    const raw  = JSON.parse(fs.readFileSync(PRICE_HISTORY_FILE, 'utf8'));
    const hist = raw.history || {};
    let n = 0;
    for (const [sym, arr] of Object.entries(hist)) {
      if (Array.isArray(arr) && arr.length) { priceHistory.set(sym, arr.slice(-MAX_HISTORY)); n++; }
    }
    if (n) console.log(`📈 Riwayat harga dimuat dari file: ${n} saham (RSI/SMA langsung siap)`);
  } catch (e) { /* abaikan */ }
}

// Seed riwayat dari Stockbit agar RSI/SMA langsung akurat (tidak menunggu terkumpul)
let seedingInProgress = false;
async function seedHistoryFromStockbit() {
  if (seedingInProgress) return;
  if (!dataAggregator.stockbit || !dataAggregator.stockbit._hasToken()) return;
  seedingInProgress = true;
  console.log('📈 Mengambil riwayat awal dari Stockbit (seed RSI/SMA)...');
  let seeded = 0;
  try {
    for (const symbol of activeSymbols) {
      try {
        const bars = await dataAggregator.fetchChart(symbol);
        // Selalu utamakan candle dari Stockbit (bukan akumulasi sendiri).
        // Hanya overwrite jika dapat cukup candle untuk RSI/SMA.
        if (bars && bars.length >= 10) {
          priceHistory.set(symbol, bars.slice(-MAX_HISTORY));
          seeded++;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 120));
    }
  } finally {
    seedingInProgress = false;
  }
  if (seeded > 0) {
    console.log(`📈 Seed selesai: ${seeded} saham terisi dari Stockbit.`);
    savePriceHistory();
  } else {
    console.log('📈 Seed: belum ada candle dari Stockbit (endpoint chart mungkin beda format).');
  }
}

function pushHistory(symbol, bar) {
  if (!priceHistory.has(symbol)) priceHistory.set(symbol, []);
  const arr = priceHistory.get(symbol);
  // Hindari duplikat jika harga & volume sama persis (update tanpa perubahan)
  const last = arr[arr.length - 1];
  if (!last || last.close !== bar.close || last.volume !== bar.volume) {
    arr.push(bar);
    if (arr.length > MAX_HISTORY) arr.shift();
  }
  return arr;
}

async function updateStockData() {
  const marketOpen = isMarketOpen();
  const weekend    = isWeekend();

  // Saat akhir pekan: batasi update 1x per jam agar tidak spam error
  if (weekend && !marketOpen) {
    const msSince = Date.now() - lastWeekendUpdate;
    if (lastWeekendUpdate > 0 && msSince < 3600000) {
      console.log(`⏸ Akhir pekan — skip update (berikutnya dalam ${Math.round((3600000-msSince)/60000)} mnt)`);
      return;
    }
    lastWeekendUpdate = Date.now();
    console.log('📅 Akhir pekan — mengambil data terakhir dari provider...');
  } else {
    console.log(`Updating stock data... Market ${marketOpen ? 'OPEN' : 'CLOSED'}`);
  }

  try {
    // Fetch semua saham sekaligus via batch (hemat request, hindari 429)
    const batchResults = await dataAggregator.fetchAllBatch(activeSymbols);

    // Konteks per-siklus: kondisi pasar (breadth), ambang adaptif, jelang tutup
    computeMarketRegime();
    const regMult     = regimeMultiplier();
    const buyThr      = buyThreshold();
    const lateSession = marketOpen && wibHourDecimal() >= NO_ENTRY_AFTER;
    io.emit('marketRegime', { regime: marketRegime, buyThreshold: buyThr });
    io.emit('morningMode', {
      enabled: morningMomentumEnabled,
      phase: getMorningPhase(),
      entryWindow: '09:15–10:30',
      rangeWindow: '09:00–09:30',
    });

    for (const symbol of activeSymbols) {
      try {
        // Ambil dari batch result, lalu tambahkan historical + foreign flow
        const rawStock = batchResults[symbol];
        if (!rawStock) {
          console.log(`⚠️ No data for ${symbol} - skipped`);
          continue;
        }

        // Bangun history rolling dari data live (timeframe scalping)
        const historicalData = pushHistory(symbol, {
          date:   new Date().toISOString(),
          open:   rawStock.open  || rawStock.price,
          high:   rawStock.high  || rawStock.price,
          low:    rawStock.low   || rawStock.price,
          close:  rawStock.price,
          volume: rawStock.volume || 0,
        });

        // Stockbit sudah menyertakan data asing inline
        const stockData = {
          ...rawStock,
          historical:  historicalData,
          foreignBuy:  rawStock.foreignBuy  || 0,
          foreignSell: rawStock.foreignSell || 0,
          foreignNet:  rawStock.foreignNet  || 0,
          timestamp:   new Date().toISOString(),
        };

        // Skip jika semua provider gagal (misal: pasar tutup & tidak ada API key)
        if (!stockData) {
          console.log(`⚠️ No data for ${symbol} - skipped`);
          continue;
        }

        // Cache historical data saat pasar tutup supaya tidak hilang
        if (!marketOpen && !historicalDataCache.has(symbol) && stockData.historical) {
          historicalDataCache.set(symbol, stockData.historical);
        }
        if (!marketOpen && historicalDataCache.has(symbol)) {
          stockData.historical = historicalDataCache.get(symbol);
        }

        const openingRange = morningMomentumEnabled ? updateOpeningRange(symbol, stockData) : null;
        const analysis = performTechnicalAnalysis(stockData, {
          regimeMultiplier: regMult,
          buyThreshold: buyThr,
          openingRange,
        });

        // Guard entri: jelang tutup atau masih cooldown setelah cut loss → jangan beli baru
        if (analysis.signal === 'BUY') {
          const cd = cooldownUntil.get(symbol);
          if (lateSession) {
            analysis.signal = 'HOLD';
            analysis.reason = 'Jelang penutupan — hindari buka posisi baru';
          } else if (cd && Date.now() < cd) {
            analysis.signal = 'HOLD';
            analysis.reason = `Cooldown pasca cut loss (s/d ${new Date(cd).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })})`;
          }
        }

        // Sinyal keluar/jual dinamis (untuk peringatan & exit posisi berjalan)
        const exitSig = computeExitSignal(stockData, analysis);

        // Signal lock: tahan sinyal BUY/SELL selama beberapa menit agar tidak berubah-ubah
        let finalAnalysis = analysis;
        const now = Date.now();
        const lockedSignal = signalTimestamps.get(symbol);

        if (lockedSignal) {
          const timeSinceLock = now - lockedSignal.time;
          if (timeSinceLock < SIGNAL_PERSISTENCE) {
            finalAnalysis = {
              ...analysis,
              signal: lockedSignal.signal,
              reason: `${analysis.reason} (LOCKED: ${lockedSignal.signal} for 5min)`,
              lockedUntil: new Date(lockedSignal.time + SIGNAL_PERSISTENCE).toLocaleTimeString('id-ID'),
              stopLoss: lockedSignal.stopLoss,
              takeProfit: lockedSignal.takeProfit
            };
          } else {
            signalTimestamps.delete(symbol);
          }
        }

        // Sinyal baru BUY/SELL → kunci (hanya saat pasar buka)
        if (analysis.signal !== 'HOLD' && !lockedSignal && marketOpen) {
          signalTimestamps.set(symbol, {
            time: now,
            signal: analysis.signal,
            stopLoss: analysis.stopLoss,
            takeProfit: analysis.takeProfit
          });
          finalAnalysis.lockedUntil = new Date(now + SIGNAL_PERSISTENCE).toLocaleTimeString('id-ID');
          console.log(`🔒 ${symbol}: ${analysis.signal} (yakin ${Math.round(analysis.confidence * 100)}%) — terkunci s/d ${finalAnalysis.lockedUntil}`);
          // Sinyal BELI baru → buka posisi paper-trading (simulasi)
          if (analysis.signal === 'BUY') openPaperPosition(symbol, analysis);
        } else if (analysis.signal !== 'HOLD' && !lockedSignal && !marketOpen) {
          const existingSignal = signalTimestamps.get(symbol);
          if (existingSignal) {
            finalAnalysis = {
              ...analysis,
              signal: existingSignal.signal,
              reason: `${analysis.reason} (PRESERVED: ${existingSignal.signal})`,
              lockedUntil: new Date(existingSignal.time + SIGNAL_PERSISTENCE).toLocaleTimeString('id-ID'),
              stopLoss: existingSignal.stopLoss,
              takeProfit: existingSignal.takeProfit
            };
          }
        }

        // Sertakan sinyal keluar agar UI bisa memberi peringatan "JUAL"
        finalAnalysis.exitSignal = exitSig;

        stockCache.set(symbol, stockData);
        recommendations.set(symbol, finalAnalysis);

        // Pantau posisi paper-trading: TP/SL/trailing/exit pakai high/low candle terakhir
        if (marketOpen) {
          checkPaperExits(
            symbol,
            stockData.price,
            rawStock.high || stockData.price,
            rawStock.low  || stockData.price,
            exitSig
          );
        }

        io.emit('stockUpdate', {
          symbol,
          data: stockData,
          analysis: finalAnalysis
        });
      } catch (error) {
        console.error(`Error updating ${symbol}:`, error.message);
      }
    }
    
    const ok = activeSymbols.filter(s => stockCache.has(s)).length;
    console.log(`Stock data update completed: ${ok}/${activeSymbols.length} saham`);
    if (ok > 0) { saveCacheToFile(); savePriceHistory(); }
  } catch (error) {
    console.error('Error in stock data update:', error.message);
  }
}

// WebSocket connection
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  // Convert stockCache to proper format with symbols + analisis terlampir
  const stocksArray = Array.from(stockCache.entries()).map(([symbol, data]) => ({
    symbol,
    ...data,
    analysis: recommendations.get(symbol) || null,
  }));

  console.log(`📊 Mengirim data awal: ${stocksArray.length} saham`);

  socket.emit('initialData', { stocks: stocksArray });
  socket.emit('morningMode', {
    enabled: morningMomentumEnabled,
    phase: getMorningPhase(),
    entryWindow: '09:15–10:30',
    rangeWindow: '09:00–09:30',
  });
  console.log('Sent cached data to new client (no Stockbit fetch on connect)');
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Cek & refresh token Stockbit tiap 15 menit (jika ada refresh token)
cron.schedule('*/15 * * * *', async () => {
  if (stockbitAuth.hasRefresh()) {
    await stockbitAuth.ensureFresh(30); // refresh jika < 30 menit lagi
  }
}, { timezone: 'Asia/Jakarta' });

// Bangun ulang watchlist dinamis tiap pagi (08:50 WIB, hari kerja) sebelum pasar buka,
// lalu seed riwayat untuk saham baru. Jadi tiap hari bot mengejar mover terbaru.
cron.schedule('50 8 * * 1-5', async () => {
  console.log('🌅 Menyusun watchlist hari ini dari Movers Stockbit...');
  await refreshDynamicWatchlist();
  await seedHistoryFromStockbit();
}, { timezone: 'Asia/Jakarta' });

// ════════════════════════════════════════════════════════════
//  JADWAL UPDATE DATA (hemat kuota — semua waktu WIB)
//  • Jam pasar 09:00–15:59  → tiap 5 menit (responsif untuk scalping)
//  • Sesi penutupan 16:00–16:59 → tiap 20 menit (kunci harga closing & asing)
//  • Malam–dini hari 17:00–08:29 → TIDAK ada permintaan ke Stockbit
//    (harga sudah final; dashboard pakai data cache)
//  • Pagi 08:30 & 08:45 → "pemanasan" sebelum pasar buka
//  Hasilnya: dari penutupan sampai 08:30 pagi, server berhenti
//  menarik data — jauh lebih hemat dibanding tiap 20 menit semalaman.
// ════════════════════════════════════════════════════════════
console.log('✅ Jadwal hemat: update hanya jam pasar + penutupan + pemanasan pagi.');

// 1) Jam pasar: tiap 5 menit (09:00–15:59) — responsif untuk scalping
cron.schedule('*/5 * 9-15 * * 1-5', () => {
  console.log('🔄 Update jam pasar (tiap 5 menit)');
  updateStockData();
}, { scheduled: true, timezone: 'Asia/Jakarta' });

// 2) Penutupan: tiap 20 menit selama jam 16:00 (16:00, 16:20, 16:40)
//    untuk mengunci harga closing final + aliran asing pasca-penutupan.
cron.schedule('0,20,40 16 * * 1-5', async () => {
  console.log('🔚 Update penutupan (kunci harga closing)');
  await updateStockData();
  // Tumpuk 1 bar harian Stockbit (harga closing) → riwayat harian mandiri ke depan
  try {
    const n = swingScreener.recordStockbitDaily(Array.from(stockCache.values()));
    if (n) console.log(`🗓️ Bar harian Stockbit dicatat: +${n} saham (untuk screener swing)`);
  } catch (e) { /* abaikan */ }
}, { scheduled: true, timezone: 'Asia/Jakarta' });

// 3) Pemanasan pagi sebelum buka: 08:30 & 08:45 (pasar buka 09:00)
cron.schedule('30,45 8 * * 1-5', () => {
  console.log('🌅 Pemanasan pagi sebelum pasar buka');
  updateStockData();
}, { scheduled: true, timezone: 'Asia/Jakarta' });

// Catatan: 17:00–08:29 WIB sengaja TIDAK dijadwalkan update apa pun.

// API Routes
app.get('/api/stocks', (req, res) => {
  res.json(Array.from(stockCache.values()));
});

app.get('/api/recommendations', (req, res) => {
  const recs = Array.from(recommendations.values())
    .filter(r => r.signal === 'BUY' && r.confidence >= 0.5)
    .sort((a, b) => b.confidence - a.confidence);
  
  res.json(recs);
});

// ── Stockbit token: status, simpan, refresh manual ──────────
app.get('/api/stockbit/status', (req, res) => {
  res.json(stockbitAuth.status());
});

app.post('/api/stockbit/token', async (req, res) => {
  const { access, refresh, raw } = req.body || {};
  try {
    if (raw && raw.trim()) {
      // Mode mudah: paste seluruh isi cookie "credential storage" / token apa pun
      await stockbitAuth.setFromRaw(raw);
    } else if (access || refresh) {
      stockbitAuth.setTokens({ access, refresh });
      if (!access && refresh) {
        const r = await stockbitAuth.refresh();
        if (!r.ok) return res.json({ ok: false, error: r.error, status: stockbitAuth.status() });
      }
    } else {
      return res.status(400).json({ ok: false, error: 'Kirim "raw" (isi cookie credential storage) atau access/refresh token' });
    }

    res.json({ ok: true, status: stockbitAuth.status() });
    // Setelah token masuk: bangun watchlist dinamis → seed riwayat → update
    refreshDynamicWatchlist()
      .then(() => seedHistoryFromStockbit())
      .finally(() => updateStockData().catch(() => {}));
  } catch (e) {
    res.json({ ok: false, error: e.message, status: stockbitAuth.status() });
  }
});

app.post('/api/stockbit/refresh', async (req, res) => {
  const r = await stockbitAuth.refresh();
  res.json({ ...r, status: stockbitAuth.status() });
});

// Endpoint foreign flow — top net beli/jual asing
app.get('/api/foreign-flow', (req, res) => {
  const flows = Array.from(stockCache.entries())
    .map(([symbol, data]) => ({
      symbol,
      price:       data.price,
      foreignBuy:  data.foreignBuy  || 0,
      foreignSell: data.foreignSell || 0,
      foreignNet:  data.foreignNet  || 0,
    }))
    .filter(d => d.foreignBuy > 0 || d.foreignSell > 0)
    .sort((a, b) => b.foreignNet - a.foreignNet);
  res.json(flows);
});

// Status watchlist aktif (jumlah saham + waktu terakhir disusun)
app.get('/api/watchlist', (req, res) => {
  const core = new Set([...manualSymbols, ...STOCK_SYMBOLS]);
  res.json({
    count: activeSymbols.length,
    core: STOCK_SYMBOLS.length,
    fromMovers: activeSymbols.filter(s => !core.has(s)).length,
    manual: manualSymbols,
    lastRefresh: lastWatchlistRefresh,
    symbols: activeSymbols,
  });
});

// Kondisi pasar (breadth proxy IHSG) + ambang adaptif saat ini
app.get('/api/market', (req, res) => {
  res.json({ regime: marketRegime, buyThreshold: buyThreshold() });
});

// Morning Momentum Mode — status & toggle
app.get('/api/settings/morning-mode', (req, res) => {
  res.json({
    enabled: morningMomentumEnabled,
    phase: getMorningPhase(),
    entryWindow: '09:15–10:30',
    rangeWindow: '09:00–09:30',
    orbMinRs: ORB_MIN_RS,
    orbMinVol: ORB_MIN_VOL,
  });
});
app.post('/api/settings/morning-mode', (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'Kirim { enabled: true/false }' });
  }
  morningMomentumEnabled = enabled;
  saveSettings();
  computeMarketRegime();
  const rebuilt = rebuildRecommendationsFromCache();
  pushAllAnalysisToClients();
  console.log(`🌅 Morning Momentum ${enabled ? 'ON' : 'OFF'} — ${rebuilt} saham dianalisis ulang`);
  const payload = {
    enabled: morningMomentumEnabled,
    phase: getMorningPhase(),
    entryWindow: '09:15–10:30',
    rangeWindow: '09:00–09:30',
  };
  io.emit('morningMode', payload);
  res.json({ ok: true, ...payload });
});

// Biaya transaksi (fee) — bisa disetel sesuai broker
app.get('/api/settings/fees', (req, res) => {
  res.json({ feeBuyPct, feeSellPct, roundTripPct: feeBuyPct + feeSellPct });
});
app.post('/api/settings/fees', (req, res) => {
  const b = parseFloat((req.body || {}).feeBuyPct);
  const s = parseFloat((req.body || {}).feeSellPct);
  if (!(b >= 0 && b <= 5) || !(s >= 0 && s <= 5)) {
    return res.status(400).json({ ok: false, error: 'Fee harus 0–5% (mis. beli 0.15, jual 0.25)' });
  }
  feeBuyPct = b; feeSellPct = s;
  saveSettings();
  rebuildRecommendationsFromCache(); // untung-bersih & ambang berubah → hitung ulang
  pushAllAnalysisToClients();
  console.log(`💰 Fee disetel: beli ${b}% / jual ${s}% (PP ${(b + s).toFixed(2)}%)`);
  res.json({ ok: true, feeBuyPct, feeSellPct, roundTripPct: b + s });
});

// Filter anti-gorengan — status & toggle
app.get('/api/settings/gorengan-filter', (req, res) => {
  res.json({
    enabled: excludeGorenganEnabled,
    blocklist: gorenganFilter.getBlocklist(),
    rules: gorenganFilter.RULES,
  });
});
app.post('/api/settings/gorengan-filter', (req, res) => {
  // Filter anti-gorengan kini PERMANEN — tidak bisa dimatikan.
  res.json({ ok: true, enabled: true, permanent: true, blocklist: gorenganFilter.getBlocklist() });
});
app.post('/api/gorengan/blocklist/add', (req, res) => {
  const sym = String((req.body || {}).symbol || '').trim().toUpperCase();
  if (!/^[A-Z]{2,5}$/.test(sym)) return res.status(400).json({ ok: false, error: 'Kode saham tidak valid' });
  gorenganFilter.addToBlocklist(sym);
  rebuildRecommendationsFromCache();
  pushAllAnalysisToClients();
  res.json({ ok: true, blocklist: gorenganFilter.getBlocklist() });
});
app.post('/api/gorengan/blocklist/remove', (req, res) => {
  const sym = String((req.body || {}).symbol || '').trim().toUpperCase();
  gorenganFilter.removeFromBlocklist(sym);
  rebuildRecommendationsFromCache();
  pushAllAnalysisToClients();
  res.json({ ok: true, blocklist: gorenganFilter.getBlocklist() });
});

// Tambah saham ke watchlist manual (favorit) — selalu dipantau
app.post('/api/watchlist/add', async (req, res) => {
  const sym = String((req.body || {}).symbol || '').trim().toUpperCase();
  if (!/^[A-Z]{2,5}$/.test(sym)) return res.status(400).json({ ok: false, error: 'Kode saham tidak valid' });
  if (!manualSymbols.includes(sym)) { manualSymbols.push(sym); saveManualWatchlist(); }
  if (!activeSymbols.includes(sym)) {
    activeSymbols.unshift(sym);
    io.emit('watchlistChanged', { symbols: activeSymbols });
  }
  res.json({ ok: true, manual: manualSymbols, count: activeSymbols.length });
  // Ambil datanya segera (di luar siklus) supaya langsung muncul
  try {
    const d = await dataAggregator.fetchStockData(sym);
    if (d) {
      const hist = pushHistory(sym, { date: new Date().toISOString(), open: d.open || d.price, high: d.high || d.price, low: d.low || d.price, close: d.price, volume: d.volume || 0 });
      const sd = { ...d, historical: hist, timestamp: new Date().toISOString() };
      const a = performTechnicalAnalysis(sd, { regimeMultiplier: regimeMultiplier(), buyThreshold: buyThreshold() });
      stockCache.set(sym, sd); recommendations.set(sym, a);
      io.emit('stockUpdate', { symbol: sym, data: sd, analysis: a });
    }
  } catch { /* abaikan */ }
});

// Hapus saham dari watchlist manual
app.post('/api/watchlist/remove', (req, res) => {
  const sym = String((req.body || {}).symbol || '').trim().toUpperCase();
  manualSymbols = manualSymbols.filter(s => s !== sym);
  saveManualWatchlist();
  // Hapus dari active hanya bila bukan saham inti LQ45
  if (!STOCK_SYMBOLS.includes(sym)) {
    activeSymbols = activeSymbols.filter(s => s !== sym);
    for (const m of [stockCache, recommendations, historicalDataCache, priceHistory, signalTimestamps]) m.delete(sym);
    io.emit('watchlistChanged', { symbols: activeSymbols });
  }
  res.json({ ok: true, manual: manualSymbols, count: activeSymbols.length });
});

// Ekspor riwayat paper-trading ke CSV
app.get('/api/performance/csv', (req, res) => {
  const head = ['symbol', 'outcome', 'entry', 'exit', 'grossPct', 'netPct', 'heldMin', 'confidence', 'openedAt', 'closedAt'];
  const rows = tradeHistory.map(t => [
    t.symbol, t.outcome, t.entry, t.exit,
    (t.grossPct || 0).toFixed(2), (t.netPct || 0).toFixed(2), t.heldMin,
    Math.round((t.confidence || 0) * 100) + '%', t.openedAt, t.closedAt,
  ].join(','));
  const csv = [head.join(','), ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="riwayat-trade-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(csv);
});

// Backtest ringan: jalankan strategi pada riwayat harga intraday yang terkumpul
app.get('/api/backtest', (req, res) => {
  res.json(runBacktest());
});

// Ablation test: matikan tiap faktor satu per satu, lihat dampaknya ke win-rate.
// Bukti empiris faktor mana yang berguna vs redundan vs merugikan.
app.get('/api/ablation', (req, res) => {
  res.json(runAblation());
});

// Screener Swing Harian "Beli Dip" (RSI<28 + turun 2 hari, tahan ≤3 hari).
// Data harian dari Yahoo (cache 1×/hari); bar Stockbit dipakai bila sudah cukup.
app.get('/api/swing', async (req, res) => {
  try {
    const symbols = [...new Set([...manualSymbols, ...activeSymbols])];
    const data = await swingScreener.getSwingCandidates(symbols, {
      coreSet: new Set(STOCK_SYMBOLS),       // LQ45 inti (statis)
      lq45Only: req.query.lq45 === '1',
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message, candidates: [] });
  }
});

// IHSG — nilai REAL-TIME dari Stockbit (sama dgn app Stockbit), Yahoo sbg fallback.
let _ihsgCache = { ts: 0, data: null };
const _sma = (a, p) => { if (a.length < p) return 0; let s = 0; for (let i = a.length - p; i < a.length; i++) s += a[i]; return s / p; };

async function _ihsgFromStockbit() {
  const headers = {
    'Authorization': 'Bearer ' + stockbitAuth.getAccessToken(), 'User-Agent': 'Mozilla/5.0',
    'Accept': 'application/json', 'Origin': 'https://stockbit.com', 'Referer': 'https://stockbit.com/',
  };
  // Nilai MENTAH (tanpa roundToIDXPriceRules — pembulatan tick saham merusak perubahan indeks)
  const V = o => {
    if (o == null) return 0;
    if (typeof o === 'object') {
      if (o.raw != null) return (typeof o.raw === 'object' && o.raw.value != null) ? parseFloat(o.raw.value) || 0 : parseFloat(o.raw) || 0;
      if (o.value != null) return parseFloat(o.value) || 0;
    }
    return parseFloat(o) || 0;
  };
  const or = await axios.get('https://exodus.stockbit.com/company-price-feed/v3/orderbook/companies/IHSG', { headers, timeout: 12000 });
  const d = or.data?.data ?? or.data;
  const value = V(d.lastprice) || V(d.close);
  if (!value) throw new Error('no IHSG quote');
  const prev = V(d.previous) || value;
  let closes = [];
  try {
    const dr = await axios.get('https://exodus.stockbit.com/charts/IHSG/daily?timeframe=1y', { headers, timeout: 12000 });
    closes = ((dr.data?.data ?? dr.data)?.prices || []).map(p => parseFloat(p.value) || 0).filter(c => c > 0);
  } catch { /* MA opsional */ }
  const ma50 = _sma(closes, 50), ma200 = _sma(closes, 200);
  return {
    value, prevClose: prev,
    change: V(d.change) || (value - prev),
    changePct: V(d.percentage_change) || (prev ? (value - prev) / prev * 100 : 0),
    high: V(d.high), low: V(d.low), open: V(d.open),
    ma50: Math.round(ma50), ma200: Math.round(ma200),
    golden: ma50 > 0 && ma200 > 0 && ma50 > ma200,
    aboveMa200: ma200 > 0 && value > ma200,
    points: closes.slice(-90), source: 'stockbit', asOf: new Date().toISOString(),
  };
}
async function _ihsgFromYahoo() {
  const r = await axios.get('https://query1.finance.yahoo.com/v8/finance/chart/%5EJKSE?interval=5m&range=1d',
    { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 12000 });
  const r0 = r.data?.chart?.result?.[0]; const m = r0?.meta || {}; const q = r0?.indicators?.quote?.[0] || {};
  const points = (q.close || []).filter(c => c != null);
  const value = m.regularMarketPrice || points[points.length - 1] || 0;
  const prev = m.chartPreviousClose || 0;
  let ma50 = 0, ma200 = 0;
  try {
    const dr = await axios.get('https://query1.finance.yahoo.com/v8/finance/chart/%5EJKSE?interval=1d&range=1y', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 12000 });
    const dc = (dr.data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || []).filter(c => c != null);
    ma50 = _sma(dc, 50); ma200 = _sma(dc, 200);
  } catch { /* opsional */ }
  return {
    value, prevClose: prev, change: value - prev, changePct: prev ? (value - prev) / prev * 100 : 0,
    high: m.regularMarketDayHigh || 0, low: m.regularMarketDayLow || 0, open: (q.open || []).filter(o => o != null)[0] || 0,
    ma50: Math.round(ma50), ma200: Math.round(ma200),
    golden: ma50 > 0 && ma200 > 0 && ma50 > ma200, aboveMa200: ma200 > 0 && value > ma200,
    points, source: 'yahoo', asOf: new Date().toISOString(),
  };
}
app.get('/api/ihsg', async (req, res) => {
  try {
    if (_ihsgCache.data && Date.now() - _ihsgCache.ts < 60000) return res.json(_ihsgCache.data);
    let data;
    try { data = await _ihsgFromStockbit(); }      // utama: real-time, sama dgn app Stockbit
    catch { data = await _ihsgFromYahoo(); }        // cadangan
    _ihsgCache = { ts: Date.now(), data };
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message, points: [] });
  }
});

// Tren jangka panjang MA50/MA200 (golden cross) per saham — filter keamanan beli-tahan.
app.get('/api/trend', async (req, res) => {
  try {
    const symbols = [...new Set([...manualSymbols, ...activeSymbols])];
    res.json(await swingScreener.getTrendMap(symbols));
  } catch (e) {
    res.status(500).json({ error: e.message, trend: {} });
  }
});

// Susun ulang watchlist dinamis dari Movers Stockbit (dipicu tombol di dashboard)
app.post('/api/watchlist/refresh', async (req, res) => {
  if (!stockbitAuth.hasToken()) {
    return res.status(400).json({ ok: false, error: 'Token Stockbit belum ada.' });
  }
  try {
    await refreshDynamicWatchlist();
    res.json({ ok: true, count: activeSymbols.length, symbols: activeSymbols });
    // Seed riwayat saham baru + update di latar belakang
    seedHistoryFromStockbit().finally(() => updateStockData().catch(() => {}));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Performa paper-trading: statistik + posisi terbuka + riwayat ──
app.get('/api/performance', (req, res) => {
  const open = Array.from(openPositions.values()).map(p => {
    const cur = (stockCache.get(p.symbol) || {}).price || p.entry;
    const unrealPct = p.entry > 0 ? (cur - p.entry) / p.entry * 100 : 0;
    return { ...p, current: cur, unrealPct };
  });
  res.json({ stats: computeTradeStats(), open, history: tradeHistory.slice(0, 100) });
});

// Reset semua catatan paper-trading
app.post('/api/performance/reset', (req, res) => {
  openPositions.clear();
  tradeHistory = [];
  saveTrades();
  io.emit('tradesUpdated');
  res.json({ ok: true });
});

// ── Pra-pembukaan: saham paling aktif (saat sesi pra-buka, harga = indikasi/IEP) ──
app.get('/api/preopening', async (req, res) => {
  if (!stockbitAuth.hasToken()) {
    return res.status(400).json({ ok: false, error: 'Token Stockbit belum ada.' });
  }
  try {
    const movers = await dataAggregator.fetchMarketMover('TOP_VALUE');
    // Pakai nilai INDIKASI (ieval) ATAU nilai transaksi → tetap terisi saat pra-pembukaan
    // (sebelum pasar buka belum ada transaksi, tapi IEP/indikasi sudah tersedia).
    const clean = (movers || [])
      .filter(m => m.symbol && (m.iep || m.price) >= 100 && ((m.value || 0) >= 1e9 || (m.ieval || 0) >= 1e9))
      .sort((a, b) => ((b.ieval || b.value || 0) - (a.ieval || a.value || 0)));
    res.json({ ok: true, at: new Date().toISOString(), movers: clean });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Manual update endpoint
app.post('/api/stocks/update', async (req, res) => {
  console.log('🔄 Manual stock update triggered via API');
  try {
    await updateStockData();
    res.json({ success: true, message: 'Stock data updated successfully' });
  } catch (error) {
    console.error('Manual update failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start server — hanya saat dijalankan langsung (`node server.js`).
// Saat di-`require` (mis. skrip ablation/backtest offline) server TIDAK menyala.
if (require.main === module) server.listen(PORT, () => {
  console.log(`Indonesia Stock Scalper running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser`);
  console.log('🔐 Login dashboard AKTIF.' +
    (DASH_PASSWORD === 'scalper123'
      ? ' ⚠️ Password masih default "scalper123" — set env DASHBOARD_PASSWORD sebelum dipublik!'
      : ' Password kustom terpasang.'));
  console.log(morningMomentumEnabled
    ? '🌅 Morning Momentum Mode AKTIF — ORB entry 09:15–10:30 WIB'
    : '📊 Mode standar (scalping seharian) — set MORNING_MOMENTUM=1 atau toggle UI untuk ORB pagi');

  // Muat riwayat harga tersimpan → RSI/SMA tidak hilang saat restart
  loadPriceHistory();
  computeMarketRegime();
  rebuildRecommendationsFromCache();

  // Sumber data: Stockbit (pakai token login). IDX dimatikan (selalu 403 di localhost).
  const sb = stockbitAuth.status();
  if (sb.hasAccess || sb.hasRefresh) {
    console.log('📊 Sumber data: Stockbit (token aktif). Mengambil data awal...');
    // Bangun watchlist dinamis (Movers) → seed riwayat → update pertama
    refreshDynamicWatchlist()
      .then(() => seedHistoryFromStockbit())
      .finally(() => updateStockData());
    return;
  } else {
    console.log('⚠️ Token Stockbit belum ada — buka http://localhost:' + PORT + ' → tombol "Token Stockbit" untuk login.');
  }

  updateStockData();
});

// Diekspor untuk skrip offline (ablation/backtest) tanpa menyalakan server.
module.exports = {
  loadPriceHistory, runBacktest, runAblation, runStrategyOverHistory,
  // indikator (RSI/ATR sudah diperbaiki ke bar terbaru) untuk skrip riset lain
  calculateSimpleRSI, calculateSMA, calculateEMA, calculateSimpleATR,
  // keputusan beli produksi (untuk uji kualitas sinyal di timeframe lain)
  backtestFactorScores, backtestDecision, combineConfidence, FACTOR_WEIGHTS, BT_THRESHOLD,
};
