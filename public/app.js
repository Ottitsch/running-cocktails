// ─── Constants ────────────────────────────────────────────────────────────────

const GROUP_COLORS = [
  '#e53935', '#1e88e5', '#43a047', '#fb8c00',
  '#8e24aa', '#00acc1', '#d81b60', '#6d4c41'
];

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  // Setup
  participants: [],  // [{id, name, lat, lon, marker}]
  goal: null,        // {name, lat, lon, marker}

  // Results
  schedule: null,
  journeys: null,
  distanceMatrix: null,
  violations: [],

  // Results UI
  activeRound: 0,          // index into schedule array
  activeParticipant: null, // id for journey view
  activeView: 'table',     // 'table' | 'journey'

  // Map layers to clean up
  mapLayers: [],
};

// ─── Map ──────────────────────────────────────────────────────────────────────

const map = L.map('map').setView([48.2082, 16.3738], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);
window.addEventListener('load', () => map.invalidateSize());

// ─── Map helpers ──────────────────────────────────────────────────────────────

function clearMapLayers() {
  state.mapLayers.forEach(l => map.removeLayer(l));
  state.mapLayers = [];
}

function addLayer(layer) {
  layer.addTo(map);
  state.mapLayers.push(layer);
  return layer;
}

function makeCircleIcon(color, size = 16, border = 'white') {
  return L.divIcon({
    className: '',
    html: `<div style="background:${color};width:${size}px;height:${size}px;border-radius:50%;border:2.5px solid ${border};box-shadow:0 1px 4px rgba(0,0,0,0.4)"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2 - 4]
  });
}

function makeHostIcon(color) {
  return L.divIcon({
    className: '',
    html: `<div style="background:${color};width:22px;height:22px;border-radius:4px;border:2.5px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;font-size:12px">🏠</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    popupAnchor: [0, -15]
  });
}

function makeGoalIcon() {
  return L.divIcon({
    className: '',
    html: `<div style="background:#f9a825;width:22px;height:22px;border-radius:50%;border:2.5px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;font-size:12px">⭐</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    popupAnchor: [0, -15]
  });
}

function makeNumberIcon(color, num) {
  return L.divIcon({
    className: '',
    html: `<div style="background:${color};width:24px;height:24px;border-radius:50%;border:2.5px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;color:white;font-size:11px;font-weight:700">${num}</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -16]
  });
}

function fitMapToMarkers(markers) {
  if (!markers.length) return;
  if (markers.length === 1) {
    map.setView([markers[0].getLatLng().lat, markers[0].getLatLng().lng], 14);
    return;
  }
  const group = L.featureGroup(markers);
  map.fitBounds(group.getBounds().pad(0.2));
}

// ─── Phase switching ──────────────────────────────────────────────────────────

function showPhase(phase) {
  document.getElementById('phase-setup').classList.toggle('hidden', phase !== 'setup');
  document.getElementById('phase-loading').classList.toggle('hidden', phase !== 'loading');
  document.getElementById('phase-results').classList.toggle('hidden', phase !== 'results');
}

// ─── Address search (shared) ──────────────────────────────────────────────────

async function searchAddresses(query) {
  const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error('Search failed');
  return res.json();
}

function parseAddressResults(data) {
  if (!Array.isArray(data)) return [];
  return data.map(r => ({
    name: r.display_name.split(',').slice(0, 2).join(',').trim(),
    fullName: r.display_name,
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
  })).filter(r => r.lat && r.lon);
}

function attachSearch(inputEl, dropdownEl, onSelect) {
  let timer = null;

  inputEl.addEventListener('input', () => {
    clearTimeout(timer);
    const q = inputEl.value.trim();
    if (q.length < 2) { hideDropdown(dropdownEl); return; }
    showDropdownItem(dropdownEl, 'loading', 'Searching…');
    timer = setTimeout(async () => {
      try {
        const results = parseAddressResults(await searchAddresses(q));
        if (!results.length) { showDropdownItem(dropdownEl, 'no-results', 'No addresses found'); return; }
        showDropdownResults(dropdownEl, results, onSelect);
      } catch {
        showDropdownItem(dropdownEl, 'no-results', 'Search error — try again');
      }
    }, 300);
  });

  inputEl.addEventListener('keydown', e => { if (e.key === 'Escape') hideDropdown(dropdownEl); });
  document.addEventListener('click', e => {
    if (!e.target.closest('.search-wrap') && e.target !== inputEl) hideDropdown(dropdownEl);
  });
}

function showDropdownResults(dropdown, results, onSelect) {
  dropdown.innerHTML = results.map((r, i) => `
    <li data-idx="${i}">
      <div class="stop-name">${r.name}</div>
      ${r.fullName !== r.name ? `<div class="stop-full">${r.fullName}</div>` : ''}
    </li>
  `).join('');
  dropdown.classList.remove('hidden');
  dropdown._results = results;

  dropdown.querySelectorAll('li[data-idx]').forEach(li => {
    li.addEventListener('click', () => {
      const r = dropdown._results[Number(li.dataset.idx)];
      onSelect(r);
      hideDropdown(dropdown);
    });
  });
}

function showDropdownItem(dropdown, cls, text) {
  dropdown.innerHTML = `<li class="${cls}">${text}</li>`;
  dropdown.classList.remove('hidden');
}

function hideDropdown(dropdown) {
  dropdown.classList.add('hidden');
  dropdown.innerHTML = '';
}

// ─── Setup: Goal ──────────────────────────────────────────────────────────────

const goalInput    = document.getElementById('goalInput');
const goalDropdown = document.getElementById('goalDropdown');
const goalSelected = document.getElementById('goalSelected');

attachSearch(goalInput, goalDropdown, r => {
  setGoal(r.name, r.lat, r.lon);
  goalInput.value = '';
});

function setGoal(name, lat, lon) {
  if (state.goal?.marker) map.removeLayer(state.goal.marker);

  const marker = L.marker([lat, lon], { icon: makeGoalIcon() })
    .bindPopup(`<strong>Final: ${name}</strong>`);
  marker.addTo(map);

  state.goal = { name, lat, lon, marker };

  goalSelected.textContent = `⭐ ${name}`;
  goalSelected.classList.remove('hidden');
  goalSelected.onclick = () => {
    map.removeLayer(state.goal.marker);
    state.goal = null;
    goalSelected.classList.add('hidden');
  };

  fitSetupMap();
}

// ─── Setup: Pin on map ────────────────────────────────────────────────────────

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

  pinMode = false;
  pinBtn.classList.remove('active');
  pinBtn.textContent = '+ Pin on map';
  document.body.classList.remove('pin-mode');

  const { lat, lng: lon } = e.latlng;
  const typedName = participantName.value.trim();
  const name = typedName || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;

  addParticipant(name, lat, lon);
  participantName.value = '';

  // If no name was typed, reverse geocode in the background to get a real address
  if (!typedName) {
    try {
      const res = await fetch(`/api/reverse?lat=${lat}&lon=${lon}`);
      if (res.ok) {
        const data = await res.json();
        const addrName = data.display_name?.split(',').slice(0, 2).join(',').trim();
        if (addrName) {
          const p = state.participants.find(p => p.lat === lat && p.lon === lon);
          if (p) {
            p.name = addrName;
            p.marker.setPopupContent(`<strong>${addrName}</strong>`);
            renderParticipantsList();
          }
        }
      }
    } catch { /* keep the coordinate label */ }
  }
});

// ─── Setup: Participants ──────────────────────────────────────────────────────

const participantName = document.getElementById('participantName');
const participantAddr = document.getElementById('participantAddr');
const addrDropdown    = document.getElementById('addrDropdown');

attachSearch(participantAddr, addrDropdown, r => {
  const name = participantName.value.trim() || r.name;
  addParticipant(name, r.lat, r.lon);
  participantName.value = '';
  participantAddr.value = '';
});

function addParticipant(name, lat, lon) {
  const id = crypto.randomUUID();
  const marker = L.marker([lat, lon], { icon: makeCircleIcon('#9aa0a6') })
    .bindPopup(`<strong>${name}</strong>`);
  marker.addTo(map);

  state.participants.push({ id, name, lat, lon, marker });
  renderParticipantsList();
  fitSetupMap();
}

function removeParticipant(id) {
  const idx = state.participants.findIndex(p => p.id === id);
  if (idx === -1) return;
  map.removeLayer(state.participants[idx].marker);
  state.participants.splice(idx, 1);
  renderParticipantsList();
  fitSetupMap();
}

function renderParticipantsList() {
  const list = document.getElementById('participantsList');
  const count = document.getElementById('participantCount');
  count.textContent = state.participants.length > 0 ? `(${state.participants.length})` : '';

  if (state.participants.length === 0) {
    list.innerHTML = '<li class="empty-hint">Add participants to get started.</li>';
    return;
  }

  list.innerHTML = state.participants.map(p => `
    <li class="item">
      <div class="item-dot" style="background:#9aa0a6"></div>
      <span class="item-name" title="${p.name}">${p.name}</span>
      <span class="item-addr" title="${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}">${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}</span>
      <button class="btn-remove" onclick="removeParticipant('${p.id}')" title="Remove">×</button>
    </li>
  `).join('');
}

// ─── Import / Export participants ─────────────────────────────────────────────

function escapeCSV(val) {
  const s = String(val);
  return (s.includes(',') || s.includes('"') || s.includes('\n'))
    ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCSV(content, filename) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

document.getElementById('exportParticipantsBtn').addEventListener('click', () => {
  if (!state.participants.length) return;
  const rows = ['Name,Latitude,Longitude',
    ...state.participants.map(p => `${escapeCSV(p.name)},${p.lat},${p.lon}`)
  ];
  downloadCSV(rows.join('\n'), 'participants.csv');
});

document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('importFile').click();
});

document.getElementById('importFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const parsed = parseParticipantCSV(ev.target.result);
      if (!parsed.length) throw new Error('No valid rows found.');
      parsed.forEach(p => addParticipant(p.name, p.lat, p.lon));
    } catch (err) {
      alert('Import failed: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = ''; // allow re-importing same file
});

function parseParticipantCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error('CSV must have a header row and at least one data row.');
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const nameIdx = headers.indexOf('name');
  const latIdx  = headers.findIndex(h => h === 'latitude' || h === 'lat');
  const lonIdx  = headers.findIndex(h => h === 'longitude' || h === 'lon');
  if (nameIdx === -1 || latIdx === -1 || lonIdx === -1) {
    throw new Error('CSV must have columns: Name, Latitude (or Lat), Longitude (or Lon).');
  }
  return lines.slice(1)
    .filter(l => l.trim())
    .map(line => {
      const cols = splitCSVLine(line);
      return { name: cols[nameIdx]?.trim(), lat: parseFloat(cols[latIdx]), lon: parseFloat(cols[lonIdx]) };
    })
    .filter(p => p.name && !isNaN(p.lat) && !isNaN(p.lon));
}

function splitCSVLine(line) {
  // Handles quoted fields with embedded commas
  const cols = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      cols.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  cols.push(cur);
  return cols;
}

// ─── Export schedule ──────────────────────────────────────────────────────────

document.getElementById('exportScheduleBtn').addEventListener('click', () => {
  if (!state.schedule) return;
  downloadCSV(generateScheduleCSV(), 'running-cocktails-schedule.csv');
});

function generateScheduleCSV() {
  const pMap = Object.fromEntries(state.participants.map(p => [p.id, p]));
  const rows = ['Round,Group,Role,Name,Latitude,Longitude'];

  for (const { round, groups } of state.schedule) {
    groups.forEach((g, gi) => {
      const groupLabel = String.fromCharCode(65 + gi);
      const host = pMap[g.host];
      rows.push([round, groupLabel, 'Host', escapeCSV(host.name), host.lat, host.lon].join(','));
      for (const guestId of g.guests) {
        const guest = pMap[guestId];
        rows.push([round, groupLabel, 'Guest', escapeCSV(guest.name), guest.lat, guest.lon].join(','));
      }
    });
  }

  rows.push(''); // blank separator
  state.participants.forEach(p => {
    rows.push(['Final', 'All', 'Attendee', escapeCSV(p.name), state.goal.lat, state.goal.lon].join(','));
  });

  return rows.join('\n');
}

function fitSetupMap() {
  const markers = state.participants.map(p => p.marker);
  if (state.goal) markers.push(state.goal.marker);
  fitMapToMarkers(markers);
}

// ─── Calculate ────────────────────────────────────────────────────────────────

document.getElementById('calculateBtn').addEventListener('click', async () => {
  const numRounds = parseInt(document.getElementById('numRounds').value, 10);
  const maxGuests = parseInt(document.getElementById('maxGuests').value, 10);
  const errEl = document.getElementById('setupError');

  errEl.classList.add('hidden');

  if (state.participants.length < 4) {
    errEl.textContent = 'Add at least 4 participants.';
    errEl.classList.remove('hidden');
    return;
  }
  if (!state.goal) {
    errEl.textContent = 'Set a final meetup location.';
    errEl.classList.remove('hidden');
    return;
  }
  if (state.participants.length < numRounds * 2) {
    errEl.textContent = `Need at least ${numRounds * 2} participants for ${numRounds} rounds.`;
    errEl.classList.remove('hidden');
    return;
  }

  const total = state.participants.length;
  const pairs = total * (total + 1) / 2; // including goal
  document.getElementById('loadingMsg').textContent =
    `Fetching ${pairs} transit times for ${total} participants…`;

  showPhase('loading');

  try {
    const body = {
      participants: state.participants.map(({ id, name, lat, lon }) => ({ id, name, lat, lon })),
      numRounds,
      maxGuests,
      goal: { name: state.goal.name, lat: state.goal.lat, lon: state.goal.lon },
    };

    const res = await fetch('/api/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Server error');
    }

    const data = await res.json();
    state.schedule = data.schedule;
    state.journeys = data.journeys;
    state.distanceMatrix = data.distanceMatrix;
    state.violations = data.violations || [];
    state.activeRound = 0;
    state.activeParticipant = null;
    state.activeView = 'table';

    // Hide setup markers
    state.participants.forEach(p => map.removeLayer(p.marker));
    if (state.goal?.marker) map.removeLayer(state.goal.marker);

    showPhase('results');
    initResultsView();

  } catch (e) {
    showPhase('setup');
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
    // Restore setup markers
    state.participants.forEach(p => p.marker.addTo(map));
    if (state.goal?.marker) state.goal.marker.addTo(map);
  }
});

// ─── Back button ──────────────────────────────────────────────────────────────

document.getElementById('backBtn').addEventListener('click', () => {
  clearMapLayers();
  state.schedule = null;
  state.journeys = null;
  state.distanceMatrix = null;

  // Restore setup markers
  state.participants.forEach(p => p.marker.addTo(map));
  if (state.goal?.marker) state.goal.marker.addTo(map);
  fitSetupMap();
  showPhase('setup');
});

// ─── Results: view toggle ─────────────────────────────────────────────────────

document.getElementById('viewTable').addEventListener('click', () => {
  state.activeView = 'table';
  document.getElementById('viewTable').classList.add('active');
  document.getElementById('viewJourney').classList.remove('active');
  document.getElementById('table-view').classList.remove('hidden');
  document.getElementById('journey-view').classList.add('hidden');
  renderRoundOnMap(state.activeRound);
});

document.getElementById('viewJourney').addEventListener('click', () => {
  state.activeView = 'journey';
  document.getElementById('viewJourney').classList.add('active');
  document.getElementById('viewTable').classList.remove('active');
  document.getElementById('journey-view').classList.remove('hidden');
  document.getElementById('table-view').classList.add('hidden');
  clearMapLayers();
  if (state.activeParticipant) renderJourneyOnMap(state.activeParticipant);
  else renderAllParticipantsOnMap();
});

// ─── Results: initialise ──────────────────────────────────────────────────────

function initResultsView() {
  renderViolationBanner();
  renderRoundTabs();
  renderGroupCards(state.activeRound);
  renderRoundOnMap(state.activeRound);
  renderJourneyList();
  document.getElementById('journeyDetail').classList.add('hidden');

  // Reset toggle
  document.getElementById('viewTable').classList.add('active');
  document.getElementById('viewJourney').classList.remove('active');
  document.getElementById('table-view').classList.remove('hidden');
  document.getElementById('journey-view').classList.add('hidden');
}

function renderViolationBanner() {
  const el = document.getElementById('violationBanner');
  const v = state.violations;
  if (!v || v.length === 0) {
    el.innerHTML = '<span class="banner-ok">✓ No repeat meetings — all constraints satisfied</span>';
    el.className = 'violation-banner ok';
  } else {
    const details = v.map(vi =>
      `${vi.a} &amp; ${vi.b} (rounds ${vi.rounds.join(' + ')})`
    ).join('<br>');
    el.innerHTML = `<strong>⚠ ${v.length} repeat meeting${v.length > 1 ? 's' : ''} — group size may be too large for these settings</strong><br><small>${details}</small>`;
    el.className = 'violation-banner warn';
  }
}

// ─── Results: Schedule (table) view ──────────────────────────────────────────

function renderRoundTabs() {
  const tabs = document.getElementById('roundTabs');
  const rounds = state.schedule.map(r => r.round);
  tabs.innerHTML = [...rounds, 'Final'].map((r, i) => `
    <button class="round-tab ${i === state.activeRound ? 'active' : ''}"
            onclick="selectRound(${i})">${r === 'final' || r === 'Final' ? 'Final' : `Round ${r}`}</button>
  `).join('');
}

function selectRound(idx) {
  state.activeRound = idx;
  document.querySelectorAll('.round-tab').forEach((el, i) => el.classList.toggle('active', i === idx));
  renderGroupCards(idx);
  renderRoundOnMap(idx);
}

// Travel time helpers for the results views

function travelTimeToRound(participantId, roundIdx) {
  if (!state.journeys || !state.distanceMatrix) return null;
  const journey = state.journeys[participantId];
  if (!journey || roundIdx >= journey.length) return null;
  const prevId = roundIdx === 0 ? participantId : journey[roundIdx - 1].location.hostId;
  const currId = journey[roundIdx].location.hostId;
  return getDist(state.distanceMatrix, prevId, currId);
}

function totalTravelTime(participantId) {
  if (!state.journeys || !state.distanceMatrix) return null;
  const journey = state.journeys[participantId];
  if (!journey) return null;
  let total = 0, prevId = participantId;
  for (const j of journey) {
    const d = getDist(state.distanceMatrix, prevId, j.location.hostId);
    if (d != null) total += d;
    prevId = j.location.hostId;
  }
  return total;
}

function travelColor(min) {
  if (min == null) return '#9aa0a6';
  if (min <= 15) return '#43a047';
  if (min <= 30) return '#fb8c00';
  return '#e53935';
}

function memberRow(name, travelMin, isHost) {
  const badge = (travelMin == null || travelMin === 0)
    ? `<span class="travel-badge" style="background:#9aa0a6">${isHost ? 'home' : '0 min'}</span>`
    : `<span class="travel-badge" style="background:${travelColor(travelMin)}">${formatMin(travelMin)}</span>`;
  const roleTag = isHost ? `<span class="role-tag host-tag">host</span>` : '';
  return `
    <div class="group-member-row">
      <span class="member-icon">${isHost ? '🏠' : '👤'}</span>
      <span class="member-name">${name}</span>
      ${badge}
      ${roleTag}
    </div>
  `;
}

function renderGroupCards(roundIdx) {
  const container = document.getElementById('groupCards');
  const pMap = Object.fromEntries(state.participants.map(p => [p.id, p]));
  // journey index for the final tab is schedule.length (last journey entry per participant)
  const journeyIdx = roundIdx; // aligns: round 0 → journey[0], final → journey[numRounds]

  // Last tab = Final
  if (roundIdx === state.schedule.length) {
    const rows = state.participants.map(p => {
      const t = travelTimeToRound(p.id, journeyIdx);
      return memberRow(p.name, t, false);
    }).join('');
    container.innerHTML = `
      <div class="group-card" style="border-left-color:#f9a825">
        <div class="group-card-title" style="color:#f9a825">⭐ Final — ${state.goal.name}</div>
        ${rows}
      </div>
    `;
    return;
  }

  const { groups } = state.schedule[roundIdx];
  container.innerHTML = groups.map((g, gi) => {
    const color = GROUP_COLORS[gi % GROUP_COLORS.length];
    const host = pMap[g.host];
    const hostTravel = travelTimeToRound(g.host, journeyIdx);
    const guestRows = g.guests.map(id => {
      const p = pMap[id];
      return memberRow(p?.name ?? id, travelTimeToRound(id, journeyIdx), false);
    }).join('');
    return `
      <div class="group-card" style="border-left-color:${color}">
        <div class="group-card-title" style="color:${color}">Group ${String.fromCharCode(65 + gi)}</div>
        ${memberRow(host?.name ?? g.host, hostTravel, true)}
        ${guestRows}
      </div>
    `;
  }).join('');
}

// ─── Results: Journey view ────────────────────────────────────────────────────

function renderJourneyList() {
  const list = document.getElementById('journeyList');
  list.innerHTML = state.participants.map(p => {
    const total = totalTravelTime(p.id);
    return `
      <li class="item journey-item ${state.activeParticipant === p.id ? 'active' : ''}"
          onclick="selectParticipant('${p.id}')">
        <div class="item-dot" style="background:${travelColor(total)}"></div>
        <span class="item-name">${p.name}</span>
        <span class="travel-badge" style="background:${travelColor(total)}">${formatMin(total)}</span>
      </li>
    `;
  }).join('');
}

function selectParticipant(id) {
  state.activeParticipant = id;
  renderJourneyList();
  renderJourneyDetail(id);
  renderJourneyOnMap(id);
}

function formatMin(min) {
  if (min == null || min === Infinity) return '?';
  const h = Math.floor(min / 60), m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m} min`;
}

function renderJourneyDetail(participantId) {
  const detail = document.getElementById('journeyDetail');
  const journey = state.journeys[participantId];
  const pMap = Object.fromEntries(state.participants.map(p => [p.id, p]));
  const p = pMap[participantId];
  const dm = state.distanceMatrix;

  if (!journey) { detail.classList.add('hidden'); return; }

  // Build stops: home, then each round location, then goal
  // Each stop (except home) shows travel time from the previous stop
  const stops = [{ label: `${p.name} (home)`, minutes: null, isHost: false, isFinal: false }];

  let prevId = participantId;
  for (const j of journey) {
    const curId = j.location.hostId;
    const d = getDist(dm, prevId, curId);
    const isFinal = j.round === 'final';
    const roundLabel = isFinal ? `Final: ${j.location.name}` : `Round ${j.round}: ${j.location.name}`;
    stops.push({ label: roundLabel, minutes: d, isHost: j.isHost, isFinal });
    prevId = curId;
  }

  const totalMin = stops.slice(1).reduce((s, st) => s + (st.minutes ?? 0), 0);

  detail.classList.remove('hidden');
  detail.innerHTML = `
    <div class="journey-detail-title">${p.name}'s journey</div>
    <div class="journey-legs">
      ${stops.map((stop, i) => {
        const color = stop.isFinal ? '#f9a825' : i === 0 ? '#9aa0a6' : '#1a73e8';
        const icon = i === 0 ? '🏠' : stop.isFinal ? '⭐' : i;
        return `
          <div class="journey-leg">
            <div class="leg-stop">
              <div class="leg-number" style="background:${color}">${icon}</div>
              <div class="leg-info">
                <div class="leg-dest">${stop.label}${stop.isHost ? ' <span class="role-tag host-tag">host</span>' : ''}</div>
                <div class="leg-time">${stop.minutes !== null ? formatMin(stop.minutes) + ' from previous' : 'Starting point'}</div>
              </div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
    <div class="journey-total">Total travel: <strong>${formatMin(totalMin)}</strong></div>
  `;
}

function getDist(dm, fromId, toId) {
  if (!dm || fromId === toId) return 0;
  return dm[`${fromId}->${toId}`] ?? null;
}

// ─── Map rendering: round ─────────────────────────────────────────────────────

function renderRoundOnMap(roundIdx) {
  clearMapLayers();
  const pMap = Object.fromEntries(state.participants.map(p => [p.id, p]));

  // Final round: show all at goal
  if (roundIdx === state.schedule.length) {
    const goalM = addLayer(L.marker([state.goal.lat, state.goal.lon], { icon: makeGoalIcon() })
      .bindPopup(`<strong>⭐ Final: ${state.goal.name}</strong>`));
    state.participants.forEach(p => {
      addLayer(L.marker([p.lat, p.lon], { icon: makeCircleIcon('#f9a825', 14) })
        .bindPopup(`<strong>${p.name}</strong><br>Going to final`));
      addLayer(L.polyline([[p.lat, p.lon], [state.goal.lat, state.goal.lon]], {
        color: '#f9a825', weight: 2, opacity: 0.5, dashArray: '4,4'
      }));
    });
    fitMapToMarkers([goalM]);
    return;
  }

  const { groups } = state.schedule[roundIdx];
  const allMarkers = [];

  groups.forEach((g, gi) => {
    const color = GROUP_COLORS[gi % GROUP_COLORS.length];
    const host = pMap[g.host];
    if (!host) return;

    const hostM = addLayer(L.marker([host.lat, host.lon], { icon: makeHostIcon(color) })
      .bindPopup(`<strong>${host.name}</strong><br>Host – Group ${String.fromCharCode(65 + gi)}`));
    allMarkers.push(hostM);

    g.guests.forEach(gid => {
      const guest = pMap[gid];
      if (!guest) return;
      const guestM = addLayer(L.marker([guest.lat, guest.lon], { icon: makeCircleIcon(color) })
        .bindPopup(`<strong>${guest.name}</strong><br>Guest at ${host.name}'s place`));
      allMarkers.push(guestM);

      addLayer(L.polyline([[guest.lat, guest.lon], [host.lat, host.lon]], {
        color, weight: 2, opacity: 0.6, dashArray: '4,4'
      }));
    });
  });

  if (allMarkers.length) fitMapToMarkers(allMarkers);
}

// ─── Map rendering: journey ───────────────────────────────────────────────────

function renderAllParticipantsOnMap() {
  clearMapLayers();
  const markers = state.participants.map(p => {
    return addLayer(L.marker([p.lat, p.lon], { icon: makeCircleIcon('#1a73e8') })
      .bindPopup(`<strong>${p.name}</strong>`));
  });
  if (state.goal) {
    addLayer(L.marker([state.goal.lat, state.goal.lon], { icon: makeGoalIcon() })
      .bindPopup(`<strong>⭐ ${state.goal.name}</strong>`));
  }
  fitMapToMarkers(markers);
}

function renderJourneyOnMap(participantId) {
  clearMapLayers();
  const journey = state.journeys[participantId];
  const pMap = Object.fromEntries(state.participants.map(p => [p.id, p]));
  const p = pMap[participantId];
  if (!p || !journey) return;

  const stops = [
    { lat: p.lat, lon: p.lon, label: `${p.name}'s home`, num: '🏠' },
    ...journey.map((j, i) => ({
      lat: j.location.lat,
      lon: j.location.lon,
      label: j.round === 'final'
        ? `⭐ Final: ${j.location.name}`
        : `Round ${j.round}: ${j.location.name}${j.isHost ? ' (host)' : ''}`,
      num: j.round === 'final' ? '⭐' : i + 1,
    }))
  ];

  const latlngs = stops.map(s => [s.lat, s.lon]);
  addLayer(L.polyline(latlngs, { color: '#1a73e8', weight: 3, opacity: 0.8 }));

  const markers = stops.map(s => {
    const isGoal = s.num === '⭐';
    const color = isGoal ? '#f9a825' : '#1a73e8';
    const icon = typeof s.num === 'number'
      ? makeNumberIcon(color, s.num)
      : makeGoalIcon();
    return addLayer(L.marker([s.lat, s.lon], { icon }).bindPopup(`<strong>${s.label}</strong>`));
  });

  fitMapToMarkers(markers);
}
