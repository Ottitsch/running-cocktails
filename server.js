const express = require('express');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

const WL_TRIP = 'https://www.wienerlinien.at/ogd_routing/XML_TRIP_REQUEST2';
const NOMINATIM = 'https://nominatim.openstreetmap.org';

app.use(express.json());
app.use(express.static('public'));

function httpsGet(url) {
  const opts = new URL(url);
  return new Promise((resolve, reject) => {
    https.get({
      hostname: opts.hostname,
      path: opts.pathname + opts.search,
      headers: { 'User-Agent': 'running-cocktails-app/1.0' }
    }, (res) => {
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

// ─── Geocoding endpoints ──────────────────────────────────────────────────────

app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Missing q parameter' });
  const url = `${NOMINATIM}/search?format=json&limit=6&countrycodes=at&viewbox=16.18,48.12,16.58,48.32&bounded=1&q=${encodeURIComponent(q)}`;
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

// ─── Schedule helpers ─────────────────────────────────────────────────────────

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseTripMinutes(body) {
  const trips = body?.trips;
  if (!trips) return null;
  const arr = Array.isArray(trips) ? trips : [trips];
  const durations = arr.map(t => {
    if (!t.duration) return null;
    const [h, m] = t.duration.split(':').map(Number);
    return (isNaN(h) || isNaN(m)) ? null : h * 60 + m;
  }).filter(n => n !== null);
  return durations.length ? Math.min(...durations) : null;
}

async function fetchTransitMinutes(fromLat, fromLon, toLat, toLon) {
  const url = `${WL_TRIP}?type_origin=coord&name_origin=${fromLon}:${fromLat}:WGS84` +
    `&type_destination=coord&name_destination=${toLon}:${toLat}:WGS84&outputFormat=JSON&ptOptionsActive=1`;
  try {
    const { body } = await httpsGet(url);
    return parseTripMinutes(body);
  } catch {
    return null;
  }
}

async function buildDistanceMatrix(points) {
  const pairs = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      pairs.push([points[i], points[j]]);
    }
  }

  const matrix = {};
  const CONCURRENCY = 5;

  for (let i = 0; i < pairs.length; i += CONCURRENCY) {
    const batch = pairs.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async ([a, b]) => {
      const minutes = await fetchTransitMinutes(a.lat, a.lon, b.lat, b.lon);
      const fallback = Math.round(haversineKm(a.lat, a.lon, b.lat, b.lon) * 4);
      const val = (minutes !== null && minutes > 0) ? minutes : fallback;
      matrix[`${a.id}->${b.id}`] = val;
      matrix[`${b.id}->${a.id}`] = val;
    }));
  }

  return matrix;
}

// ─── Scheduling algorithm ─────────────────────────────────────────────────────

function seenKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function getDist(matrix, fromId, toId) {
  if (fromId === toId) return 0;
  return matrix[`${fromId}->${toId}`] ?? Infinity;
}

function tryGenerateSchedule(ids, hosts, numRounds, maxGuests, distMatrix) {
  const schedule = [];
  const seenTogether = new Set();
  // prevHostId[id] = the host ID they were last at (initially their own ID = at home)
  const prevHostId = Object.fromEntries(ids.map(id => [id, id]));

  for (let r = 0; r < numRounds; r++) {
    const hostSet = new Set(hosts[r]);
    const groups = hosts[r].map(h => ({ host: h, guests: [] }));
    const nonHosts = ids.filter(id => !hostSet.has(id));

    shuffleArray(nonHosts);

    for (let ni = 0; ni < nonHosts.length; ni++) {
      const guest = nonHosts[ni];
      const remaining = nonHosts.length - ni; // including this one
      const emptyGroups = groups.filter(g => g.guests.length === 0);

      // If remaining guests ≤ empty groups, we must fill empty groups first
      // to guarantee every host gets at least 1 guest
      const mustFillEmpty = remaining <= emptyGroups.length;
      const candidates = mustFillEmpty ? emptyGroups : groups;

      const eligible = candidates.filter(g => {
        if (g.guests.length >= maxGuests) return false;
        if (seenTogether.has(seenKey(guest, g.host))) return false;
        for (const other of g.guests) {
          if (seenTogether.has(seenKey(guest, other))) return false;
        }
        return true;
      });

      if (eligible.length === 0) return null;

      // Pick group minimizing travel from previous location
      const prev = prevHostId[guest];
      let bestGroup = eligible[0];
      let bestDist = getDist(distMatrix, prev, eligible[0].host);
      for (let i = 1; i < eligible.length; i++) {
        const d = getDist(distMatrix, prev, eligible[i].host);
        if (d < bestDist) { bestDist = d; bestGroup = eligible[i]; }
      }
      bestGroup.guests.push(guest);
    }

    // Record meetings
    for (const g of groups) {
      const members = [g.host, ...g.guests];
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          seenTogether.add(seenKey(members[i], members[j]));
        }
      }
    }

    // Update positions
    for (const g of groups) {
      prevHostId[g.host] = g.host;
      for (const guest of g.guests) prevHostId[guest] = g.host;
    }

    schedule.push({ round: r + 1, groups });
  }

  return schedule;
}

function forceGenerateSchedule(ids, hosts, numRounds, maxGuests, distMatrix) {
  // Same as tryGenerateSchedule but relaxes uniqueness constraint when stuck
  const schedule = [];
  const seenTogether = new Set();
  const prevHostId = Object.fromEntries(ids.map(id => [id, id]));

  for (let r = 0; r < numRounds; r++) {
    const hostSet = new Set(hosts[r]);
    const groups = hosts[r].map(h => ({ host: h, guests: [] }));
    const nonHosts = ids.filter(id => !hostSet.has(id));

    for (let ni = 0; ni < nonHosts.length; ni++) {
      const guest = nonHosts[ni];
      const remaining = nonHosts.length - ni;
      const emptyGroups = groups.filter(g => g.guests.length === 0);
      const mustFillEmpty = remaining <= emptyGroups.length;
      const candidates = mustFillEmpty ? emptyGroups : groups;

      let eligible = candidates.filter(g => {
        if (g.guests.length >= maxGuests) return false;
        if (seenTogether.has(seenKey(guest, g.host))) return false;
        return g.guests.every(o => !seenTogether.has(seenKey(guest, o)));
      });
      if (eligible.length === 0) eligible = candidates.filter(g => g.guests.length < maxGuests);
      if (eligible.length === 0) eligible = candidates.length ? candidates : groups;

      const prev = prevHostId[guest];
      let best = eligible[0];
      let bestDist = getDist(distMatrix, prev, eligible[0].host);
      for (let i = 1; i < eligible.length; i++) {
        const d = getDist(distMatrix, prev, eligible[i].host);
        if (d < bestDist) { bestDist = d; best = eligible[i]; }
      }
      best.guests.push(guest);
    }

    for (const g of groups) {
      const members = [g.host, ...g.guests];
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) seenTogether.add(seenKey(members[i], members[j]));
      }
      prevHostId[g.host] = g.host;
      for (const guest of g.guests) prevHostId[guest] = g.host;
    }

    schedule.push({ round: r + 1, groups });
  }

  return schedule;
}

function improveSchedule(schedule, ids, distMatrix) {
  const numRounds = schedule.length;

  // Build prevHost[r][id] = host ID they're coming from at the start of round r
  const prevHost = Array.from({ length: numRounds + 1 }, () => ({}));
  ids.forEach(id => { prevHost[0][id] = id; });
  for (let r = 0; r < numRounds; r++) {
    for (const g of schedule[r].groups) {
      prevHost[r + 1][g.host] = g.host;
      for (const guest of g.guests) prevHost[r + 1][guest] = g.host;
    }
  }

  for (let r = 0; r < numRounds; r++) {
    // Pairs seen before this round
    const seenBefore = new Set();
    for (let rr = 0; rr < r; rr++) {
      for (const g of schedule[rr].groups) {
        const members = [g.host, ...g.guests];
        for (let i = 0; i < members.length; i++) {
          for (let j = i + 1; j < members.length; j++) seenBefore.add(seenKey(members[i], members[j]));
        }
      }
    }

    const groups = schedule[r].groups;

    for (let iter = 0; iter < 200; iter++) {
      if (groups.length < 2) break;
      const gi = Math.floor(Math.random() * groups.length);
      let gj;
      do { gj = Math.floor(Math.random() * groups.length); } while (gj === gi);

      const groupA = groups[gi], groupB = groups[gj];
      if (groupA.guests.length === 0 || groupB.guests.length === 0) continue;

      const aiIdx = Math.floor(Math.random() * groupA.guests.length);
      const biIdx = Math.floor(Math.random() * groupB.guests.length);
      const gA = groupA.guests[aiIdx], gB = groupB.guests[biIdx];

      const newBMembers = [groupB.host, ...groupB.guests.filter((_, i) => i !== biIdx)];
      const newAMembers = [groupA.host, ...groupA.guests.filter((_, i) => i !== aiIdx)];

      // Backward check: haven't met these people in previous rounds
      if (!newBMembers.every(m => !seenBefore.has(seenKey(gA, m)))) continue;
      if (!newAMembers.every(m => !seenBefore.has(seenKey(gB, m)))) continue;

      // Forward check: swapping must not cause collisions in future rounds.
      // After the swap, gA will have met newBMembers in round r, and gB will have
      // met newAMembers in round r. Verify neither appears with those people again.
      let forwardOk = true;
      for (let rr = r + 1; rr < numRounds && forwardOk; rr++) {
        for (const g of schedule[rr].groups) {
          const futureMembers = [g.host, ...g.guests];
          if (futureMembers.includes(gA) && newBMembers.some(m => futureMembers.includes(m))) {
            forwardOk = false; break;
          }
          if (futureMembers.includes(gB) && newAMembers.some(m => futureMembers.includes(m))) {
            forwardOk = false; break;
          }
        }
      }
      if (!forwardOk) continue;

      const prevA = prevHost[r][gA], prevB = prevHost[r][gB];
      const oldCost = getDist(distMatrix, prevA, groupA.host) + getDist(distMatrix, prevB, groupB.host);
      const newCost = getDist(distMatrix, prevA, groupB.host) + getDist(distMatrix, prevB, groupA.host);

      if (newCost < oldCost) {
        groupA.guests[aiIdx] = gB;
        groupB.guests[biIdx] = gA;
        prevHost[r + 1][gA] = groupB.host;
        prevHost[r + 1][gB] = groupA.host;
      }
    }
  }

  return schedule;
}

function generateSchedule(participants, numRounds, maxGuests, distMatrix) {
  const ids = participants.map(p => p.id);
  const shuffled = [...ids];
  const groupsPerRound = Math.ceil(ids.length / numRounds);

  for (let attempt = 0; attempt < 100; attempt++) {
    shuffleArray(shuffled);
    const hosts = Array.from({ length: numRounds }, (_, r) =>
      shuffled.slice(r * groupsPerRound, (r + 1) * groupsPerRound)
    );
    const result = tryGenerateSchedule(shuffled, hosts, numRounds, maxGuests, distMatrix);
    if (result) return improveSchedule(result, shuffled, distMatrix);
  }

  // Fallback: force a schedule even with repeated meetings
  const hosts = Array.from({ length: numRounds }, (_, r) =>
    ids.slice(r * groupsPerRound, (r + 1) * groupsPerRound)
  );
  return forceGenerateSchedule(ids, hosts, numRounds, maxGuests, distMatrix);
}

function validateSchedule(schedule, participantMap) {
  // Returns list of violation descriptions: pairs who appear together more than once
  const pairRounds = {}; // seenKey -> [round numbers]
  for (const { round, groups } of schedule) {
    for (const g of groups) {
      const members = [g.host, ...g.guests];
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const k = seenKey(members[i], members[j]);
          if (!pairRounds[k]) pairRounds[k] = [];
          pairRounds[k].push(round);
        }
      }
    }
  }
  const violations = [];
  for (const [k, rounds] of Object.entries(pairRounds)) {
    if (rounds.length > 1) {
      const [a, b] = k.split('|');
      violations.push({
        a: participantMap[a]?.name ?? a,
        b: participantMap[b]?.name ?? b,
        rounds,
      });
    }
  }
  return violations;
}

function buildJourneys(schedule, participants, goal) {
  const pMap = Object.fromEntries(participants.map(p => [p.id, p]));
  const journeys = Object.fromEntries(participants.map(p => [p.id, []]));

  for (const { round, groups } of schedule) {
    for (const g of groups) {
      const host = pMap[g.host];
      const loc = { name: host.name, lat: host.lat, lon: host.lon, hostId: g.host };
      journeys[g.host].push({ round, location: loc, isHost: true });
      for (const guestId of g.guests) {
        journeys[guestId].push({ round, location: loc, isHost: false });
      }
    }
  }

  const goalLoc = { name: goal.name, lat: goal.lat, lon: goal.lon, hostId: '__goal__' };
  participants.forEach(p => {
    journeys[p.id].push({ round: 'final', location: goalLoc, isHost: false });
  });

  return journeys;
}

// ─── Schedule endpoint ────────────────────────────────────────────────────────

app.post('/api/schedule', async (req, res) => {
  const { participants, numRounds, maxGuests, goal } = req.body;

  if (!participants || !Array.isArray(participants) || participants.length < 2) {
    return res.status(400).json({ error: 'Need at least 2 participants' });
  }
  if (!numRounds || numRounds < 2) {
    return res.status(400).json({ error: 'Need at least 2 rounds' });
  }
  if (!goal || goal.lat == null || goal.lon == null) {
    return res.status(400).json({ error: 'Missing goal location' });
  }
  if (participants.length < numRounds * 2) {
    return res.status(400).json({
      error: `Need at least ${numRounds * 2} participants for ${numRounds} rounds (min 2 per group)`
    });
  }

  try {
    const goalPoint = { id: '__goal__', lat: goal.lat, lon: goal.lon };
    const allPoints = [...participants, goalPoint];
    const distMatrix = await buildDistanceMatrix(allPoints);
    const schedule = generateSchedule(participants, numRounds, maxGuests || 3, distMatrix);
    const journeys = buildJourneys(schedule, participants, goal);
    const pMap = Object.fromEntries(participants.map(p => [p.id, p]));
    const violations = validateSchedule(schedule, pMap);

    res.json({ schedule, journeys, distanceMatrix: distMatrix, violations });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Running Cocktails app running at http://localhost:${PORT}`);
});
