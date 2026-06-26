// ================================================================
//  IDX Market Data — SUMBER TUNGGAL: Stockbit
//  Real-time harga + volume + data asing (foreign buy/sell).
//  Tidak ada Yahoo Finance / IDX Official / Twelve Data lagi.
//
//  Token Stockbit dikelola lewat UI dashboard (tombol "Token Stockbit")
//  dan disimpan di data/stockbit_token.json. Dengan refresh token,
//  access token diperpanjang otomatis (lihat stockbit_auth.js).
// ================================================================

const axios = require('axios');
const stockbitAuth = require('./stockbit_auth');

// ── Utilitas harga IDX (fraksi harga BEI) ───────────────────
function roundToIDXPriceRules(price) {
  if (price >= 50   && price <= 200)  return Math.round(price);
  if (price > 200   && price <= 500)  return Math.round(price / 2)  * 2;
  if (price > 500   && price <= 2000) return Math.round(price / 5)  * 5;
  if (price > 2000  && price <= 5000) return Math.round(price / 10) * 10;
  if (price > 5000)                   return Math.round(price / 25) * 25;
  return Math.round(price);
}

function makeResult(symbol, raw, vol, high, low, open, source) {
  const price  = roundToIDXPriceRules(raw.price);
  const prev   = roundToIDXPriceRules(raw.prev  || price);
  const change = price - prev;
  const changePct = prev > 0 ? (change / prev) * 100 : 0;
  return {
    symbol, price, change, changePercent: changePct,
    volume: vol || 0,
    high:   roundToIDXPriceRules(high  || price),
    low:    roundToIDXPriceRules(low   || price),
    open:   roundToIDXPriceRules(open  || price),
    timestamp: new Date().toISOString(),
    source,
  };
}

// ────────────────────────────────────────────────────────────
//  Stockbit  (exodus.stockbit.com) — butuh token login
//  Real-time IDX + volume + data asing inline
// ────────────────────────────────────────────────────────────
class StockbitProvider {
  constructor() {
    this.name    = 'Stockbit';
    this.base    = 'https://exodus.stockbit.com';
    this.timeout = 12000;
    this._chartInterval = null; // interval chart yang terbukti bekerja (auto-deteksi)
  }

  _hasToken() {
    return stockbitAuth.hasToken();
  }

  _headers() {
    return {
      'Authorization': `Bearer ${stockbitAuth.getAccessToken()}`,
      'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept':        'application/json',
      'Origin':        'https://stockbit.com',
      'Referer':       'https://stockbit.com/',
    };
  }

  // Ambil nilai dari struktur Stockbit. Menangani:
  //  { raw: { value: "123" } }  (orderbook)
  //  { raw: "123" }             (trade-book chart)
  //  { value: "123" } / "123" / 123
  static val(o) {
    if (o == null) return 0;
    if (typeof o === 'object') {
      if (o.raw != null) {
        if (typeof o.raw === 'object' && o.raw.value != null) return parseFloat(o.raw.value) || 0;
        return parseFloat(o.raw) || 0;
      }
      if (o.value != null) return StockbitProvider.val(o.value);
    }
    return parseFloat(o) || 0;
  }

  async fetchStockData(symbol, _retried = false) {
    if (!this._hasToken()) return null;
    try {
      const url  = `${this.base}/company-price-feed/v3/orderbook/companies/${symbol}`;
      const resp = await axios.get(url, { headers: this._headers(), timeout: this.timeout });
      const d    = resp.data?.data || resp.data;
      if (!d) return null;

      const V     = StockbitProvider.val;
      const close = V(d.lastprice) || V(d.close);
      if (!close || close <= 0) return null;

      const prev   = V(d.previous) || close;
      const open   = V(d.open) || close;
      const high   = V(d.high) || close;
      const low    = V(d.low)  || close;
      const volume = V(d.volume);

      const result = makeResult(symbol, { price: close, prev }, volume, high, low, open, this.name);

      // Data tambahan Stockbit
      result.value      = V(d.value);       // nilai transaksi (IDR)
      result.frequency  = V(d.frequency);
      result.foreignBuy  = V(d.fbuy);
      result.foreignSell = V(d.fsell);
      result.foreignNet  = V(d.fnet) || (V(d.fbuy) - V(d.fsell));
      result.hasForeign  = !!d.has_foreign_bs;
      result.name        = d.name || symbol;
      result.ara         = V(d.ara);
      result.arb         = V(d.arb);

      // Order book imbalance: total volume antrian beli (bid) vs jual (offer/ask).
      // Defensif terhadap variasi struktur respons Stockbit.
      const ob   = d.orderbook || d.order_book || d;
      const bids = ob.bid || ob.bids || ob.buy  || [];
      const asks = ob.offer || ob.ask || ob.asks || ob.sell || [];
      const sumLevelVol = arr => Array.isArray(arr)
        ? arr.reduce((s, lv) => s + V(lv.volume ?? lv.lot ?? lv.qty ?? lv.quantity ?? lv.amount), 0)
        : 0;
      result.bidVolume = V(d.bidvol ?? d.bid_volume ?? d.total_bid) || sumLevelVol(bids);
      result.askVolume = V(d.offervol ?? d.ask_volume ?? d.offer_volume ?? d.total_offer) || sumLevelVol(asks);

      // Harga terbaik bid/ask (untuk hitung spread). Bid biasanya urut tinggi→rendah,
      // ask rendah→tinggi, jadi level teratas = harga terbaik. Defensif bila kosong.
      const topPrice = arr => (Array.isArray(arr) && arr.length)
        ? V(arr[0].price ?? arr[0].pricevalue ?? arr[0].p ?? arr[0]) : 0;
      result.bestBid = V(d.bestbid ?? d.best_bid ?? d.bid) || topPrice(bids);
      result.bestAsk = V(d.bestoffer ?? d.best_offer ?? d.best_ask ?? d.offer ?? d.ask) || topPrice(asks);

      console.log(`✅ ${this.name} OK: ${symbol} Rp${close} (${V(d.percentage_change)}%) fnet=${result.foreignNet}`);
      return result;
    } catch (e) {
      const st = e.response?.status;
      // Token kedaluwarsa → coba refresh sekali lalu ulang
      if ((st === 401 || st === 403) && !_retried && stockbitAuth.hasRefresh()) {
        const r = await stockbitAuth.refresh();
        if (r.ok) return this.fetchStockData(symbol, true);
      }
      console.error(`❌ ${this.name} ${symbol}: ${st || ''} ${e.message}`);
      return null;
    }
  }

  // Ambil riwayat candle (OHLCV) dari Stockbit untuk seed RSI/SMA.
  // Auto-deteksi nilai time_interval yang didukung lalu di-cache.
  async fetchChart(symbol) {
    if (!this._hasToken()) return [];
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }); // YYYY-MM-DD
    const candidates = this._chartInterval
      ? [this._chartInterval]
      : ['1m', '5m', '15m', '1h', '1d'];

    for (const itv of candidates) {
      try {
        const url  = `${this.base}/order-trade/trade-book/chart` +
                     `?symbol=${symbol}&time_interval=${encodeURIComponent(itv)}&date=${today}`;
        const resp = await axios.get(url, { headers: this._headers(), timeout: this.timeout });
        const bars = this._parseChart(resp.data);
        if (bars.length) {
          if (!this._chartInterval) {
            this._chartInterval = itv;
            console.log(`📈 Stockbit chart: interval '${itv}' OK (${bars.length} candle/saham)`);
          }
          return bars;
        }
      } catch (e) {
        const st = e.response?.status;
        // token kedaluwarsa → refresh sekali
        if ((st === 401 || st === 403) && stockbitAuth.hasRefresh()) {
          const r = await stockbitAuth.refresh();
          if (!r.ok) break;
        }
      }
    }
    return [];
  }

  // Ambil daftar saham paling aktif (Movers) dari Stockbit untuk auto-watchlist.
  // moverType: 'TOP_VALUE' | 'TOP_VOLUME' | 'TOP_FREQUENCY' | 'TOP_GAINER' | 'NET_FOREIGN_BUY' ...
  // opts.mainBoardOnly = true → hanya Papan Utama (saring Papan Pengembangan/Akselerasi)
  async fetchMarketMover(moverType = 'TOP_VALUE', _retried = false, opts = {}) {
    if (!this._hasToken()) return [];
    // Anti-gorengan: default hanya Papan Utama + Ekonomi Baru (GoTo/tech besar yg sah).
    // Papan Pengembangan & Akselerasi (sarang gorengan) sengaja dikecualikan.
    const boards = opts.mainBoardOnly
      ? ['FILTER_STOCKS_TYPE_MAIN_BOARD']
      : ['FILTER_STOCKS_TYPE_MAIN_BOARD', 'FILTER_STOCKS_TYPE_NEW_ECONOMY_BOARD'];
    const qs  = `mover_type=MOVER_TYPE_${moverType}&` + boards.map(b => `filter_stocks=${b}`).join('&');
    const url = `${this.base}/order-trade/market-mover?${qs}`;
    try {
      const resp = await axios.get(url, { headers: this._headers(), timeout: this.timeout });
      const list = resp.data?.data?.mover_list || [];
      const V = StockbitProvider.val;
      return list.map(m => {
        const ie = m.iepiev_detail || {};
        return {
          symbol:     m.stock_detail?.code,
          price:      V(m.price),
          changePct:  V(m.change?.percentage),
          value:      V(m.value),
          volume:     V(m.volume),
          frequency:  V(m.frequency),
          foreignBuy: V(m.net_foreign_buy),
          // IEP/IEV = indikasi pra-pembukaan (tersedia walau belum ada transaksi)
          iep:           V(ie.iep),               // indicative equilibrium price (harga indikasi buka)
          iepChangePrev: V(ie.iep_change_prev),   // % indikasi vs penutupan kemarin
          iev:           V(ie.iev),               // indicative equilibrium volume
          ieval:         V(ie.ieval),             // indicative value (Rp)
        };
      }).filter(m => m.symbol);
    } catch (e) {
      const st = e.response?.status;
      if ((st === 401 || st === 403) && !_retried && stockbitAuth.hasRefresh()) {
        const r = await stockbitAuth.refresh();
        if (r.ok) return this.fetchMarketMover(moverType, true);
      }
      console.error(`❌ ${this.name} market-mover ${moverType}: ${st || ''} ${e.message}`);
      return [];
    }
  }

  _parseChart(payload) {
    const d = payload?.data ?? payload;
    if (!d) return [];
    const V = StockbitProvider.val;

    // ── Format trade-book Stockbit: ada array "prices" (harga per menit) ──
    // Tidak ada OHLC eksplisit, jadi kita susun candle dari harga per menit.
    if (Array.isArray(d.prices) && d.prices.length) {
      const prices = d.prices;
      const buy    = Array.isArray(d.buy)  ? d.buy  : [];
      const sell   = Array.isArray(d.sell) ? d.sell : [];

      // Volume per menit dari kumulatif lot (buy+sell), 1 lot = 100 lembar.
      const perMinVol = [];
      let prevCum = 0;
      for (let i = 0; i < prices.length; i++) {
        const cum   = (V(buy[i]?.lot) || 0) + (V(sell[i]?.lot) || 0);
        const delta = i === 0 ? cum : cum - prevCum;
        perMinVol.push(Math.max(0, delta) * 100);
        prevCum = cum;
      }

      const minuteBars = prices
        .map((p, i) => ({ time: p.time, close: V(p.value), volume: perMinVol[i] }))
        .filter(b => b.close > 0);

      // Resample ke candle 5 menit agar SMA/RSI lebih bermakna untuk scalping.
      const BUCKET = 5;
      const bars = [];
      for (let i = 0; i < minuteBars.length; i += BUCKET) {
        const chunk  = minuteBars.slice(i, i + BUCKET);
        if (!chunk.length) continue;
        const closes = chunk.map(c => c.close);
        bars.push({
          date:   chunk[chunk.length - 1].time,
          open:   chunk[0].close,
          high:   Math.max(...closes),
          low:    Math.min(...closes),
          close:  chunk[chunk.length - 1].close,
          volume: chunk.reduce((a, c) => a + (c.volume || 0), 0),
        });
      }
      return bars;
    }

    // ── Fallback: format OHLC array generik ──
    let arr = Array.isArray(d)
      ? d
      : (d.chart || d.charts || d.candles || d.ohlc || d.items || d.bars || []);
    if (!Array.isArray(arr)) arr = [];
    return arr.map(c => ({
      date:   c.timestamp ?? c.time ?? c.date ?? c.t ?? '',
      open:   V(c.open  ?? c.o),
      high:   V(c.high  ?? c.h),
      low:    V(c.low   ?? c.l),
      close:  V(c.close ?? c.c ?? c.price ?? c.lastprice),
      volume: V(c.volume ?? c.v ?? c.vol),
    })).filter(b => b.close > 0);
  }
}

// ────────────────────────────────────────────────────────────
//  Data Aggregator — hanya Stockbit
// ────────────────────────────────────────────────────────────
class MultiProviderDataAggregator {
  constructor() {
    this.stockbit     = new StockbitProvider();
    this.cache        = new Map();
    this.cacheTimeout = 30000; // 30 detik
  }

  validate(data) {
    if (!data?.price || !data?.symbol) return false;
    const p = data.price;
    if (p < 50 || p > 200000) return false;
    return true;
  }

  _setCache(symbol, data) {
    this.cache.set(symbol, { data, ts: Date.now() });
  }

  // ── Fetch SEMUA saham sekaligus (dipakai oleh updateStockData) ──
  async fetchAllBatch(symbols) {
    const results = {};

    if (!this.stockbit._hasToken()) {
      console.log('⚠️ Token Stockbit belum ada — buka dashboard → tombol "Token Stockbit" untuk login.');
      return results;
    }

    console.log(`🔄 Stockbit: fetch ${symbols.length} saham...`);
    // Batasi konkurensi (chunk) agar tidak kena rate-limit saat watchlist besar.
    const CHUNK = 12;
    for (let i = 0; i < symbols.length; i += CHUNK) {
      const slice = symbols.slice(i, i + CHUNK);
      await Promise.all(slice.map(async sym => {
        try {
          const d = await this.stockbit.fetchStockData(sym);
          if (d && this.validate(d)) { results[sym] = d; this._setCache(sym, d); }
        } catch {}
      }));
      if (i + CHUNK < symbols.length) await new Promise(r => setTimeout(r, 150));
    }

    const ok      = Object.keys(results).length;
    const failed  = symbols.filter(s => !results[s]);
    console.log(`✅ Batch selesai: ${ok}/${symbols.length} berhasil${failed.length ? ` | Gagal: ${failed.join(', ')}` : ''}`);
    return results;
  }

  // ── Fetch 1 saham (pakai cache) ──
  async fetchStockData(symbol) {
    const cached = this.cache.get(symbol);
    if (cached && (Date.now() - cached.ts) < this.cacheTimeout) return cached.data;

    try {
      const d = await this.stockbit.fetchStockData(symbol);
      if (d && this.validate(d)) { this._setCache(symbol, d); return d; }
    } catch {}

    return null;
  }

  // Riwayat candle dari Stockbit (untuk seed RSI/SMA)
  async fetchChart(symbol) {
    return this.stockbit.fetchChart(symbol);
  }

  // Daftar saham paling aktif (Movers) untuk auto-watchlist dinamis
  async fetchMarketMover(moverType) {
    return this.stockbit.fetchMarketMover(moverType);
  }
}

module.exports = { MultiProviderDataAggregator, StockbitProvider, roundToIDXPriceRules };
