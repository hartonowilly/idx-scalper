/**
 * Filter anti-gorengan — saham spekulatif / rawan pump-dump dikecualikan
 * dari sinyal BELI dan watchlist dinamis (movers non-LQ45).
 *
 * Saham inti LQ45 dipercaya lebih likuid & institusional; aturan ketat
 * hanya untuk saham di luar daftar inti (+ blocklist manual).
 */
const path = require('path');
const fs   = require('fs');

const BLOCKLIST_FILE = path.join(__dirname, 'data', 'gorengan_blocklist.json');

// Ambang heuristik (disesuaikan untuk scalping IDX)
const RULES = {
  MIN_PRICE_NON_CORE: 200,       // non-LQ45: di bawah Rp200 = zona gorengan
  MID_PRICE_MAX: 500,            // Rp200–499 butuh nilai transaksi lebih besar
  MIN_VALUE_NON_CORE: 10e9,      // Rp10 miliar (non-core, harga >= Rp500)
  MIN_VALUE_MID_PRICE: 15e9,     // Rp15 miliar (non-core, harga Rp200–499)
  SPIKE_CHANGE: 5,               // naik >= 5% + volume spike
  SPIKE_VOL_RATIO: 2.5,
  FRENZY_CHANGE: 3,              // naik >= 3% + transaksi kecil-kecilan
  MIN_AVG_TRADE_IDR: 25e6,       // rata-rata nilai per frekuensi < Rp25 juta
  PUMP_NO_FOREIGN: 4,            // pump tanpa asing + nilai tipis
  PUMP_MAX_VALUE: 20e9,
};

let blocklist = new Set();

function loadBlocklist() {
  try {
    if (!fs.existsSync(BLOCKLIST_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(BLOCKLIST_FILE, 'utf8'));
    if (Array.isArray(raw.symbols)) blocklist = new Set(raw.symbols.map(s => String(s).toUpperCase()));
  } catch { /* abaikan */ }
}

function saveBlocklist() {
  try {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    fs.writeFileSync(BLOCKLIST_FILE, JSON.stringify({
      savedAt: new Date().toISOString(),
      note: 'Tambah kode saham yang ingin selalu diblokir dari sinyal BELI',
      symbols: [...blocklist].sort(),
    }, null, 2));
  } catch { /* abaikan */ }
}

loadBlocklist();

/**
 * @param {string} symbol
 * @param {object} data - price, changePercent|changePct, value, frequency, volumeRatio, foreignNet, hasForeign
 * @param {{ isCore?: boolean, enabled?: boolean }} opts
 * @returns {{ excluded: boolean, reason?: string, flags?: string[] }}
 */
function assessGorenganRisk(symbol, data = {}, opts = {}) {
  const { isCore = false, enabled = true } = opts;
  if (!enabled) return { excluded: false };

  const sym = String(symbol || '').toUpperCase();
  if (!sym) return { excluded: false };

  if (blocklist.has(sym)) {
    return { excluded: true, reason: 'Daftar blok gorengan — dikecualikan', flags: ['blocklist'] };
  }

  // LQ45 / saham inti: tetap dipantau, kecuali blocklist
  if (isCore) return { excluded: false };

  const price = Number(data.price) || 0;
  const ch    = Number(data.changePercent ?? data.changePct ?? 0);
  const value = Number(data.value) || 0;
  const freq  = Number(data.frequency) || 0;
  const volRatio = Number(data.volumeRatio) || 0;
  const foreignNet = Number(data.foreignNet ?? 0);

  const flags = [];

  if (price > 0 && price < RULES.MIN_PRICE_NON_CORE) {
    return {
      excluded: true,
      reason: `Harga Rp${Math.round(price)} (< Rp200, bukan LQ45) — zona rawan gorengan`,
      flags: ['low_price'],
    };
  }

  if (value > 0) {
    if (price >= RULES.MIN_PRICE_NON_CORE && price < RULES.MID_PRICE_MAX && value < RULES.MIN_VALUE_MID_PRICE) {
      return {
        excluded: true,
        reason: `Mid-cap tipis (Rp${Math.round(price)}, nilai Rp${(value / 1e9).toFixed(1)} miliar) — rawan gorengan`,
        flags: ['thin_midcap'],
      };
    }
    if (value < RULES.MIN_VALUE_NON_CORE) {
      return {
        excluded: true,
        reason: `Nilai transaksi rendah (Rp${(value / 1e9).toFixed(1)} miliar) — min Rp10 miliar untuk non-LQ45`,
        flags: ['low_value'],
      };
    }
  }

  if (ch >= RULES.SPIKE_CHANGE && volRatio >= RULES.SPIKE_VOL_RATIO) {
    flags.push('volume_spike');
    return {
      excluded: true,
      reason: `Spike gorengan (+${ch.toFixed(1)}%, volume ${volRatio.toFixed(1)}×) — chase berbahaya`,
      flags,
    };
  }

  if (freq > 0 && value > 0 && ch >= RULES.FRENZY_CHANGE) {
    const avgTrade = value / freq;
    if (avgTrade < RULES.MIN_AVG_TRADE_IDR) {
      flags.push('retail_frenzy');
      return {
        excluded: true,
        reason: `Retail frenzy (avg Rp${Math.round(avgTrade / 1e6)}M/transaksi, +${ch.toFixed(1)}%)`,
        flags,
      };
    }
  }

  if (ch >= RULES.PUMP_NO_FOREIGN && foreignNet <= 0 && value > 0 && value < RULES.PUMP_MAX_VALUE) {
    flags.push('pump_no_foreign');
    return {
      excluded: true,
      reason: `Pump tanpa asing (+${ch.toFixed(1)}%, asing net ≤ 0, nilai tipis)`,
      flags,
    };
  }

  return { excluded: false, flags };
}

function addToBlocklist(symbol) {
  const sym = String(symbol || '').toUpperCase();
  if (!/^[A-Z]{2,5}$/.test(sym)) return false;
  blocklist.add(sym);
  saveBlocklist();
  return true;
}

function removeFromBlocklist(symbol) {
  blocklist.delete(String(symbol || '').toUpperCase());
  saveBlocklist();
}

module.exports = {
  RULES,
  assessGorenganRisk,
  loadBlocklist,
  saveBlocklist,
  addToBlocklist,
  removeFromBlocklist,
  getBlocklist: () => [...blocklist].sort(),
};
