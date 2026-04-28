// DroneTogs self-contained local server.
// Run: npm install && npm start
// Open: http://localhost:3000

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';
import { promisify } from 'util';

const gunzip = promisify(zlib.gunzip);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

const METAR_CACHE_URL = 'https://aviationweather.gov/data/cache/metars.cache.csv.gz';
const TAF_CACHE_URL = 'https://aviationweather.gov/data/cache/tafs.cache.xml.gz';
const memCache = new Map();

function haversineMi(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function csvParse(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else {
      if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (c !== '\r') cell += c;
    }
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

function num(v) {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function xmlDecode(s = '') {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function tag(block, name) {
  const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i');
  const m = block.match(re);
  return m ? xmlDecode(m[1].trim()) : '';
}

async function fetchMaybeGzip(url, ttlMs) {
  const now = Date.now();
  const hit = memCache.get(url);
  if (hit && hit.expires > now) return hit.text;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: '*/*',
        'User-Agent': 'DroneTogs local weather cache contact: www.dronetogs.com'
      }
    });
    if (!r.ok) throw new Error(`NOAA cache HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const text = (buf[0] === 0x1f && buf[1] === 0x8b) ? (await gunzip(buf)).toString('utf8') : buf.toString('utf8');
    memCache.set(url, { text, expires: now + ttlMs });
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function getMetars() {
  const text = await fetchMaybeGzip(METAR_CACHE_URL, 60_000);
  const rows = csvParse(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map(h => String(h).trim());
  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));
  const val = (r, ...names) => {
    for (const n of names) if (idx[n] !== undefined) return r[idx[n]] || '';
    return '';
  };
  return rows.slice(1).map(r => {
    const cover = val(r, 'sky_cover');
    const base = num(val(r, 'cloud_base_ft_agl'));
    const clouds = cover ? [{ cover, base }] : [];
    return {
      icaoId: val(r, 'station_id', 'icaoId'),
      rawOb: val(r, 'raw_text', 'rawOb'),
      reportTime: val(r, 'observation_time', 'reportTime'),
      lat: num(val(r, 'latitude', 'lat')),
      lon: num(val(r, 'longitude', 'lon')),
      temp: num(val(r, 'temp_c', 'temp')),
      dewp: num(val(r, 'dewpoint_c', 'dewp')),
      wdir: val(r, 'wind_dir_degrees', 'wdir'),
      wspd: num(val(r, 'wind_speed_kt', 'wspd')),
      wgst: num(val(r, 'wind_gust_kt', 'wgst')),
      visib: val(r, 'visibility_statute_mi', 'visib'),
      altim: val(r, 'altim_in_hg', 'altim'),
      clouds,
      fltCat: val(r, 'flight_category', 'fltCat'),
      name: ''
    };
  }).filter(m => m.icaoId && m.rawOb && Number.isFinite(m.lat) && Number.isFinite(m.lon));
}

async function getTafs() {
  const text = await fetchMaybeGzip(TAF_CACHE_URL, 10 * 60_000);
  const blocks = [...text.matchAll(/<TAF>([\s\S]*?)<\/TAF>/gi)].map(m => m[1]);
  return blocks.map(b => ({
    icaoId: tag(b, 'station_id'),
    rawTAF: tag(b, 'raw_text'),
    reportTime: tag(b, 'issue_time'),
    lat: num(tag(b, 'latitude')),
    lon: num(tag(b, 'longitude')),
    name: ''
  })).filter(t => t.icaoId && t.rawTAF && Number.isFinite(t.lat) && Number.isFinite(t.lon));
}

function nearest(items, lat, lon, limit, maxMiles) {
  return items
    .map(item => ({ ...item, _dist: haversineMi(lat, lon, item.lat, item.lon) }))
    .filter(item => item._dist <= maxMiles)
    .sort((a, b) => a._dist - b._dist)
    .slice(0, limit);
}

app.get('/api/nearby', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const lat = Number.parseFloat(req.query.lat);
  const lon = Number.parseFloat(req.query.lon);
  const metarLimit = Math.min(Number.parseInt(req.query.metars || '5', 10), 10);
  const tafLimit = Math.min(Number.parseInt(req.query.tafs || '5', 10), 10);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'Missing or invalid lat/lon' });

  try {
    const [metars, tafs] = await Promise.all([getMetars(), getTafs()]);
    res.setHeader('Cache-Control', 'public, max-age=30');
    return res.json({
      metars: nearest(metars, lat, lon, metarLimit, 700),
      tafs: nearest(tafs, lat, lon, tafLimit, 900)
    });
  } catch (err) {
    return res.status(502).json({ error: err?.message || 'Unable to fetch NOAA cache files' });
  }
});

app.get('/api/weather', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const raw = req.query.url;
  if (!raw) return res.status(400).send('Missing url parameter');
  let target;
  try {
    target = new URL(Array.isArray(raw) ? raw[0] : raw);
    if (target.protocol !== 'https:') throw new Error('Only HTTPS is allowed');
    if (target.hostname !== 'aviationweather.gov') throw new Error('Only aviationweather.gov allowed');
    if (!target.pathname.startsWith('/api/data/')) throw new Error('Only /api/data endpoints are allowed');
  } catch (err) {
    return res.status(400).send(err.message || 'Invalid url parameter');
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const upstream = await fetch(target.toString(), {
      signal: controller.signal,
      headers: {
        Accept: 'application/json,text/plain,*/*',
        'User-Agent': 'DroneTogs weather proxy contact: www.dronetogs.com'
      }
    });
    clearTimeout(timer);
    const text = await upstream.text();
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', target.pathname.includes('/taf') ? 'public, max-age=900' : 'public, max-age=180');
    return res.status(upstream.status).send(text);
  } catch (err) {
    return res.status(502).send(err?.message || 'Weather proxy failed');
  }
});
app.use(express.static(__dirname, { extensions: ['html'] }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => {
  console.log(`DroneTogs running at http://localhost:${PORT}`);
  console.log('Test: http://localhost:' + PORT + '/api/nearby?lat=40.6413&lon=-73.7781');
});
