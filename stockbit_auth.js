// ================================================================
//  Stockbit Auth Manager
//  - Simpan access + refresh token ke file (data/stockbit_token.json)
//  - Auto-refresh access token via POST /login/refresh (Bearer refresh)
//  - Tidak menyimpan password (Stockbit blokir login otomatis)
// ================================================================

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const TOKEN_FILE  = path.join(__dirname, 'data', 'stockbit_token.json');
const REFRESH_URL = 'https://exodus.stockbit.com/login/refresh';

const HEADERS_BASE = {
  'X-Platform': 'web',
  'Accept': 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0',
  'Origin': 'https://stockbit.com',
  'Referer': 'https://stockbit.com/',
};

let _access  = '';
let _refresh = '';
let _refreshing = null; // promise lock agar tidak refresh berbarengan

// ── Persist ──────────────────────────────────────────────────
function _save() {
  try {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ access: _access, refresh: _refresh, updatedAt: new Date().toISOString() }, null, 2));
  } catch (e) { console.error('⚠️ Gagal simpan token:', e.message); }
}

function load() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const d = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      _access  = d.access  || '';
      _refresh = d.refresh || '';
      if (_access || _refresh) console.log('🔑 Token Stockbit dimuat dari file.');
    }
  } catch (e) { console.error('⚠️ Gagal baca token file:', e.message); }
}

// ── JWT helpers ──────────────────────────────────────────────
function _decodeExp(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString('utf8'));
    return payload.exp ? payload.exp * 1000 : 0; // ms
  } catch { return 0; }
}

function _tokenType(jwt) {
  // refresh token Stockbit punya "ver"/type berbeda; kita cek lewat error endpoint.
  // Di sini cukup cek apakah string JWT valid.
  return jwt && jwt.split('.').length === 3;
}

// ── Public API ───────────────────────────────────────────────
function setTokens({ access, refresh }) {
  if (access  !== undefined) _access  = (access  || '').trim();
  if (refresh !== undefined) _refresh = (refresh || '').trim();
  _save();
}

// Ekstrak access + refresh dari berbagai bentuk input yang di-paste user:
//  1. Isi cookie "credential storage" (URL-encoded JSON)
//  2. JSON mentah { state: { access:{token}, refresh:{token} } }
//  3. JSON { access:{token}, refresh:{token} }
//  4. Token JWT tunggal (eyJ...) → dideteksi sebagai access/refresh via payload
// Mengembalikan { access, refresh } atau melempar Error bila gagal.
function parseCredential(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('Input kosong');
  let text = raw.trim();

  // Kasus 4: token JWT tunggal
  if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(text)) {
    const isRefresh = _isRefreshJwt(text);
    return isRefresh ? { refresh: text } : { access: text };
  }

  // Coba URL-decode (cookie credential storage biasanya ter-encode %22 dst)
  let obj = null;
  for (const candidate of [text, _tryDecode(text)]) {
    if (!candidate) continue;
    try { obj = JSON.parse(candidate); break; } catch { /* lanjut */ }
  }
  if (!obj) throw new Error('Format tidak dikenali. Paste isi cookie "credential storage" atau refresh token (eyJ...).');

  const state  = obj.state || obj;
  const access  = state.access?.token  || state.access  || state.access_token  || '';
  const refresh = state.refresh?.token || state.refresh || state.refresh_token || '';
  if (!access && !refresh) throw new Error('Tidak menemukan access/refresh token di dalam data.');
  return { access, refresh };
}

function _tryDecode(s) {
  try { return decodeURIComponent(s); } catch { return null; }
}

function _isRefreshJwt(jwt) {
  try {
    const p = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString('utf8'));
    const d = p.data || p;
    return (d.typ === 'refresh') || (p.is_refresh === 'true') || (p.typ === 'refresh');
  } catch { return false; }
}

// Set token dari blob mentah lalu (jika perlu) refresh untuk dapat access
async function setFromRaw(raw) {
  const parsed = parseCredential(raw);
  setTokens(parsed);
  // Jika hanya refresh token → tukar jadi access token
  if (!parsed.access && parsed.refresh) {
    const r = await refresh();
    if (!r.ok) throw new Error('Refresh token diterima tapi gagal menukar access token: ' + (r.error || ''));
  }
  return { gotAccess: !!getAccessToken(), gotRefresh: hasRefresh() };
}

function getAccessToken() { return _access; }
function hasToken()       { return !!_access; }
function hasRefresh()     { return !!_refresh; }

function status() {
  const exp = _access ? _decodeExp(_access) : 0;
  const msLeft = exp - Date.now();
  return {
    hasAccess:  !!_access,
    hasRefresh: !!_refresh,
    accessExpiresAt: exp ? new Date(exp).toISOString() : null,
    minutesLeft: exp ? Math.round(msLeft / 60000) : null,
    expired: exp ? msLeft <= 0 : !_access,
  };
}

// Refresh access token pakai refresh token (Bearer)
async function refresh() {
  if (!_refresh) return { ok: false, error: 'Tidak ada refresh token' };
  if (_refreshing) return _refreshing;

  _refreshing = (async () => {
    try {
      const resp = await axios.post(REFRESH_URL, {}, {
        headers: { ...HEADERS_BASE, 'Authorization': `Bearer ${_refresh}` },
        timeout: 12000,
      });
      // Respon bisa: { data: { access: {token}, refresh: {token} } } atau bentuk lain
      const body = resp.data?.data || resp.data || {};
      const newAccess  = body.access?.token  || body.access  || body.token || body.access_token;
      const newRefresh = body.refresh?.token || body.refresh || body.refresh_token;

      if (!newAccess) return { ok: false, error: 'Respon refresh tidak berisi access token', raw: body };

      _access = newAccess;
      if (newRefresh) _refresh = newRefresh; // refresh token bisa ikut diperbarui (rotation)
      _save();
      console.log('🔄 Token Stockbit di-refresh otomatis. Berlaku sampai', status().accessExpiresAt);
      return { ok: true };
    } catch (e) {
      const msg = e.response?.data?.message || e.message;
      console.error('❌ Refresh token gagal:', e.response?.status, msg);
      return { ok: false, error: msg, status: e.response?.status };
    } finally {
      _refreshing = null;
    }
  })();

  return _refreshing;
}

// Pastikan token masih valid; refresh jika < bufferMin menit lagi
async function ensureFresh(bufferMin = 30) {
  if (!_access && _refresh) return refresh();
  const exp = _decodeExp(_access);
  if (!exp) return { ok: !!_access };
  const msLeft = exp - Date.now();
  if (msLeft < bufferMin * 60000 && _refresh) {
    return refresh();
  }
  return { ok: true };
}

load();

module.exports = { load, setTokens, setFromRaw, parseCredential, getAccessToken, hasToken, hasRefresh, status, refresh, ensureFresh };
