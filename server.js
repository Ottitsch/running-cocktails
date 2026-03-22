const express = require('express');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

const WL_TRIP = 'https://www.wienerlinien.at/ogd_routing/XML_TRIP_REQUEST2';
const NOMINATIM = 'https://nominatim.openstreetmap.org';

function httpsGet(url, headers = {}) {
  const opts = new URL(url);
  return new Promise((resolve, reject) => {
    https.get({ hostname: opts.hostname, path: opts.pathname + opts.search, headers: { 'User-Agent': 'vienna-routing-app/1.0', ...headers } }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data.slice(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

app.use(express.static('public'));

// Address search via Nominatim (Vienna area)
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Missing q parameter' });

  // viewbox covers Greater Vienna; bounded=1 keeps results inside it
  const url = `${NOMINATIM}/search?format=json&limit=6&countrycodes=at&viewbox=16.18,48.12,16.58,48.32&bounded=1&q=${encodeURIComponent(q)}`;
  try {
    const { status, body } = await httpsGet(url);
    res.status(status).json(body);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/trip', async (req, res) => {
  const { origin, destination, originLat, originLon, destLat, destLon } = req.query;

  const originPart = origin
    ? `type_origin=stopID&name_origin=${encodeURIComponent(origin)}`
    : `type_origin=coord&name_origin=${originLon}:${originLat}:WGS84`;

  const destPart = destination
    ? `type_destination=stopID&name_destination=${encodeURIComponent(destination)}`
    : `type_destination=coord&name_destination=${destLon}:${destLat}:WGS84`;

  if (!origin && (!originLat || !originLon)) {
    return res.status(400).json({ error: 'Missing origin' });
  }
  if (!destination && (!destLat || !destLon)) {
    return res.status(400).json({ error: 'Missing destination' });
  }

  const url = `${WL_TRIP}?${originPart}&${destPart}&outputFormat=JSON&ptOptionsActive=1`;
  try {
    const { status, body } = await httpsGet(url);
    res.status(status).json(body);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/reverse', async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'Missing lat/lon' });

  const url = `${NOMINATIM}/reverse?format=json&lat=${lat}&lon=${lon}&zoom=16&addressdetails=0`;
  try {
    const { status, body } = await httpsGet(url);
    res.status(status).json(body);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Vienna routing app running at http://localhost:${PORT}`);
});
