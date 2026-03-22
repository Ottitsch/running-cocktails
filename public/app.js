// ─── State ───────────────────────────────────────────────────────────────────

const state = {
  locations: [],   // [{ id, label, stopId, lat, lon, marker }]
  selectedId: null,
  travelTimes: {}  // "originId->destId": { minutes, fetching, error }
};

// ─── Map ─────────────────────────────────────────────────────────────────────

const map = L.map('map').setView([48.2082, 16.3738], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);
window.addEventListener('load', () => map.invalidateSize());

// ─── Utility: coordinates ─────────────────────────────────────────────────────

function mercatorToWgs84(x, y) {
  const lon = (x / 20037508.34) * 180;
  const lat = (Math.atan(Math.exp((y / 20037508.34) * Math.PI)) * 360 / Math.PI) - 90;
  return { lat, lon };
}

function parseCoords(coordsString) {
  if (!coordsString) return null;
  const parts = coordsString.split(',');
  const [x, y] = parts.map(Number);
  if (isNaN(x) || isNaN(y)) return null;

  if (Math.abs(x) > 10_000_000) {
    // WGS84 scaled by 1e7
    return { lon: x / 1e7, lat: y / 1e7 };
  } else if (Math.abs(x) > 100_000) {
    // Web Mercator (EPSG:3857)
    return mercatorToWgs84(x, y);
  } else {
    // Raw degrees (lon:lat)
    return { lon: x, lat: y };
  }
}

// ─── Utility: duration ────────────────────────────────────────────────────────

function parseDurationStr(str) {
  if (!str) return null;
  const [h, m] = str.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

function bestTripMinutes(trips) {
  if (!trips) return null;
  const arr = Array.isArray(trips) ? trips : [trips];
  const durations = arr.map(t => parseDurationStr(t.duration)).filter(n => n !== null);
  return durations.length ? Math.min(...durations) : null;
}

// ─── Utility: colors ─────────────────────────────────────────────────────────

function minutesToColor(minutes, maxMinutes) {
  if (maxMinutes === 0) return '#34a853';
  const ratio = Math.min(minutes / maxMinutes, 1);
  const r = Math.round(ratio * 220 + (1 - ratio) * 30);
  const g = Math.round(ratio * 60 + (1 - ratio) * 160);
  const b = 50;
  return `rgb(${r},${g},${b})`;
}

function makeMarkerIcon(color) {
  return L.divIcon({
    className: '',
    html: `<div style="background:${color};width:18px;height:18px;border-radius:50%;border:2.5px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.35)"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    popupAnchor: [0, -14]
  });
}

// ─── API calls ────────────────────────────────────────────────────────────────

async function searchAddresses(query) {
  const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error('Search failed');
  return res.json();
}

async function fetchTrip(origin, dest) {
  // origin/dest: { stopId, lat, lon }
  const params = new URLSearchParams();
  if (origin.stopId) {
    params.set('origin', origin.stopId);
  } else {
    params.set('originLat', origin.lat);
    params.set('originLon', origin.lon);
  }
  if (dest.stopId) {
    params.set('destination', dest.stopId);
  } else {
    params.set('destLat', dest.lat);
    params.set('destLon', dest.lon);
  }
  const res = await fetch(`/api/trip?${params}`);
  if (!res.ok) throw new Error('Trip request failed');
  return res.json();
}

async function reverseGeocode(lat, lon) {
  try {
    const res = await fetch(`/api/reverse?lat=${lat}&lon=${lon}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.display_name?.split(',').slice(0, 2).join(',').trim() || null;
  } catch {
    return null;
  }
}

// ─── Parse API responses ──────────────────────────────────────────────────────

function parseAddressResults(results) {
  // Nominatim returns an array of results
  if (!Array.isArray(results)) return [];
  return results.map(r => ({
    name: r.display_name.split(',').slice(0, 2).join(',').trim(),
    fullName: r.display_name,
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon)
  })).filter(r => r.lat && r.lon);
}

function parseTripMinutes(data) {
  const trips = data?.trips;
  if (!trips) return null;
  return bestTripMinutes(trips);
}

// ─── Location management ──────────────────────────────────────────────────────

function addLocation(stop) {
  const id = crypto.randomUUID();
  const marker = L.marker([stop.lat, stop.lon], {
    icon: makeMarkerIcon('#9aa0a6')
  }).addTo(map);
  marker.bindPopup(`<strong>${stop.name}</strong>`);

  // Always use coordinates for routing (no stopId) so walking time is included
  const loc = { id, label: stop.name, stopId: null, lat: stop.lat, lon: stop.lon, marker };
  state.locations.push(loc);

  renderLocationsList();
  updateLocationCount();

  // If there's an active origin, fetch trip to this new location
  if (state.selectedId && state.selectedId !== id) {
    fetchTravelTime(state.selectedId, id);
  }

  // Fit map to all markers
  fitMapToLocations();
}

function removeLocation(id) {
  const idx = state.locations.findIndex(l => l.id === id);
  if (idx === -1) return;

  // Remove marker from map
  state.locations[idx].marker.remove();
  state.locations.splice(idx, 1);

  // Clear cached times involving this location
  for (const key of Object.keys(state.travelTimes)) {
    if (key.includes(id)) delete state.travelTimes[key];
  }

  if (state.selectedId === id) {
    state.selectedId = null;
  }

  renderLocationsList();
  renderResults();
  updateLocationCount();
  updateMapMarkers();

  if (state.locations.length > 0) fitMapToLocations();
}

function selectOrigin(id) {
  state.selectedId = id;
  renderLocationsList();
  renderResults();
  updateMapMarkers();

  const destinations = state.locations.filter(l => l.id !== id);
  destinations.forEach(dest => fetchTravelTime(id, dest.id));
}

async function fetchTravelTime(originId, destId) {
  const key = `${originId}->${destId}`;
  if (state.travelTimes[key]?.minutes !== undefined) {
    renderResults();
    updateMapMarkers();
    return;
  }

  state.travelTimes[key] = { fetching: true };
  renderResults();

  try {
    const origin = state.locations.find(l => l.id === originId);
    const dest   = state.locations.find(l => l.id === destId);
    if (!origin || !dest) return;

    const data = await fetchTrip(origin, dest);
    const minutes = parseTripMinutes(data);
    state.travelTimes[key] = { minutes, fetching: false };
  } catch {
    state.travelTimes[key] = { error: true, fetching: false };
  }

  renderResults();
  updateMapMarkers();
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function renderLocationsList() {
  const list = document.getElementById('locationsList');
  if (state.locations.length === 0) {
    list.innerHTML = '<li class="empty-hint">Add at least two locations to compare travel times.</li>';
    return;
  }

  list.innerHTML = state.locations.map(loc => {
    const isOrigin = loc.id === state.selectedId;
    return `
      <li class="location-item ${isOrigin ? 'is-origin' : ''}" data-id="${loc.id}">
        <div class="location-dot" style="background:${isOrigin ? '#1a73e8' : '#9aa0a6'}"></div>
        <span class="location-name" title="${loc.label}">${loc.label}</span>
        <button class="btn-origin" onclick="selectOrigin('${loc.id}')">
          ${isOrigin ? 'Origin' : 'Set origin'}
        </button>
        <button class="btn-remove" onclick="removeLocation('${loc.id}')" title="Remove">×</button>
      </li>
    `;
  }).join('');
}

function renderResults() {
  const section = document.getElementById('resultsSection');
  const list    = document.getElementById('resultsList');
  const originNameEl = document.getElementById('originName');

  if (!state.selectedId) {
    section.style.display = 'none';
    return;
  }

  const origin = state.locations.find(l => l.id === state.selectedId);
  if (!origin) { section.style.display = 'none'; return; }

  const destinations = state.locations.filter(l => l.id !== state.selectedId);
  if (destinations.length === 0) { section.style.display = 'none'; return; }

  section.style.display = 'block';
  originNameEl.textContent = origin.label;

  // Sort: resolved times first (ascending), then loading, then errors
  const withTimes = destinations.map(dest => {
    const key = `${state.selectedId}->${dest.id}`;
    return { dest, entry: state.travelTimes[key] || {} };
  });

  withTimes.sort((a, b) => {
    const am = a.entry.minutes;
    const bm = b.entry.minutes;
    if (am !== undefined && bm !== undefined) return am - bm;
    if (am !== undefined) return -1;
    if (bm !== undefined) return 1;
    return 0;
  });

  const maxMinutes = Math.max(
    ...withTimes.map(x => x.entry.minutes).filter(m => m !== undefined && m !== null),
    1
  );

  list.innerHTML = withTimes.map(({ dest, entry }) => {
    let timeLabel, barWidth, barColor;

    if (entry.fetching) {
      timeLabel = `<span class="result-time loading">loading...</span>`;
      barWidth = 0;
      barColor = '#e8eaed';
    } else if (entry.error || entry.minutes === null || entry.minutes === undefined) {
      timeLabel = `<span class="result-time error">No route</span>`;
      barWidth = 0;
      barColor = '#e8eaed';
    } else {
      const m = entry.minutes;
      const h = Math.floor(m / 60);
      const min = m % 60;
      const label = h > 0 ? `${h}h ${min}m` : `${min} min`;
      timeLabel = `<span class="result-time">${label}</span>`;
      barWidth = Math.max((m / maxMinutes) * 100, 3);
      barColor = minutesToColor(m, maxMinutes);
    }

    return `
      <li class="result-item">
        <div class="result-header">
          <span class="result-dest" title="${dest.label}">${dest.label}</span>
          ${timeLabel}
        </div>
        <div class="bar-track">
          <div class="bar-fill" style="width:${barWidth}%;background:${barColor}"></div>
        </div>
      </li>
    `;
  }).join('');
}

function updateMapMarkers() {
  if (!state.selectedId) {
    // All gray
    state.locations.forEach(loc => {
      loc.marker.setIcon(makeMarkerIcon('#9aa0a6'));
      loc.marker.setPopupContent(`<strong>${loc.label}</strong>`);
    });
    return;
  }

  const origin = state.locations.find(l => l.id === state.selectedId);
  if (origin) {
    origin.marker.setIcon(makeMarkerIcon('#1a73e8'));
    origin.marker.setPopupContent(`<strong>${origin.label}</strong><br><em>Origin</em>`);
  }

  const destinations = state.locations.filter(l => l.id !== state.selectedId);
  const resolvedMinutes = destinations
    .map(d => state.travelTimes[`${state.selectedId}->${d.id}`]?.minutes)
    .filter(m => m !== undefined && m !== null);
  const maxMinutes = resolvedMinutes.length ? Math.max(...resolvedMinutes, 1) : 60;

  destinations.forEach(dest => {
    const entry = state.travelTimes[`${state.selectedId}->${dest.id}`] || {};
    let color = '#9aa0a6';
    let popupExtra = '';

    if (entry.fetching) {
      color = '#fbbc04';
      popupExtra = '<br><em>Loading...</em>';
    } else if (entry.minutes !== undefined && entry.minutes !== null) {
      color = minutesToColor(entry.minutes, maxMinutes);
      const h = Math.floor(entry.minutes / 60);
      const m = entry.minutes % 60;
      const label = h > 0 ? `${h}h ${m}m` : `${m} min`;
      popupExtra = `<br>${label} from ${origin?.label ?? 'origin'}`;
    } else if (entry.error) {
      color = '#c5221f';
      popupExtra = '<br><em>No route found</em>';
    }

    dest.marker.setIcon(makeMarkerIcon(color));
    dest.marker.setPopupContent(`<strong>${dest.label}</strong>${popupExtra}`);
  });
}

function updateLocationCount() {
  const el = document.getElementById('locationCount');
  el.textContent = state.locations.length > 0 ? `(${state.locations.length})` : '';
}

function fitMapToLocations() {
  if (state.locations.length === 0) return;
  if (state.locations.length === 1) {
    map.setView([state.locations[0].lat, state.locations[0].lon], 14);
    return;
  }
  const group = L.featureGroup(state.locations.map(l => l.marker));
  map.fitBounds(group.getBounds().pad(0.2));
}

// ─── Search UI ────────────────────────────────────────────────────────────────

const searchInput    = document.getElementById('searchInput');
const searchDropdown = document.getElementById('searchDropdown');

let searchTimer = null;

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) {
    hideDropdown();
    return;
  }
  showDropdownItem('loading', 'Searching...');
  searchTimer = setTimeout(() => runSearch(q), 300);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideDropdown();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-wrap')) hideDropdown();
});

async function runSearch(q) {
  try {
    const data = await searchAddresses(q);
    const results = parseAddressResults(data);
    if (results.length === 0) {
      showDropdownItem('no-results', 'No addresses found');
      return;
    }
    showDropdownResults(results);
  } catch {
    showDropdownItem('no-results', 'Search error — try again');
  }
}

function showDropdownResults(results) {
  searchDropdown.innerHTML = results.map((r, i) => `
    <li data-idx="${i}">
      <div class="stop-name">${r.name}</div>
      ${r.fullName !== r.name ? `<div class="stop-full">${r.fullName}</div>` : ''}
    </li>
  `).join('');
  searchDropdown.classList.remove('hidden');

  // Store results on the dropdown for click handling
  searchDropdown._results = results;

  searchDropdown.querySelectorAll('li[data-idx]').forEach(li => {
    li.addEventListener('click', () => {
      const idx = Number(li.dataset.idx);
      const stop = searchDropdown._results[idx];
      if (stop.lat && stop.lon) {
        addLocation(stop);
        searchInput.value = '';
        hideDropdown();
      }
    });
  });
}

function showDropdownItem(cls, text) {
  searchDropdown.innerHTML = `<li class="${cls}">${text}</li>`;
  searchDropdown.classList.remove('hidden');
}

function hideDropdown() {
  searchDropdown.classList.add('hidden');
  searchDropdown.innerHTML = '';
}

// ─── Pin mode (click on map to add arbitrary location) ────────────────────────

let pinMode = false;
const pinBtn = document.getElementById('pinBtn');

pinBtn.addEventListener('click', () => {
  pinMode = !pinMode;
  pinBtn.classList.toggle('active', pinMode);
  pinBtn.textContent = pinMode ? '× Cancel pinning' : '+ Pin on map';
  document.body.classList.toggle('pin-mode', pinMode);
});

map.on('click', async (e) => {
  if (!pinMode) return;

  // Exit pin mode immediately so the user knows the click was registered
  pinMode = false;
  pinBtn.classList.remove('active');
  pinBtn.textContent = '+ Pin on map';
  document.body.classList.remove('pin-mode');

  const { lat, lng: lon } = e.latlng;

  // Add a temporary placeholder location while we reverse geocode
  const id = crypto.randomUUID();
  const marker = L.marker([lat, lon], {
    icon: makeMarkerIcon('#9aa0a6')
  }).addTo(map);
  marker.bindPopup('<em>Loading name...</em>');

  const placeholderLabel = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  const loc = { id, label: placeholderLabel, stopId: null, lat, lon, marker };
  state.locations.push(loc);
  renderLocationsList();
  updateLocationCount();
  fitMapToLocations();

  // Reverse geocode in the background to get a real name
  const name = await reverseGeocode(lat, lon);
  if (name) {
    loc.label = name;
    marker.setPopupContent(`<strong>${name}</strong>`);
    renderLocationsList();
    renderResults();
    updateMapMarkers();
  } else {
    marker.setPopupContent(`<strong>${placeholderLabel}</strong>`);
  }

  // If there's an active origin, fetch travel time to this new location
  if (state.selectedId && state.selectedId !== id) {
    fetchTravelTime(state.selectedId, id);
  }
});
