# Running Cocktails Planner

A web app for planning **Running Cocktails** (progressive dinner) events. Built for the WU Supply Chain Management Board.

Instead of scheduling groups by hand, the app automatically generates an optimised round assignment that minimises transit travel between rounds while ensuring no two participants ever end up in the same group twice.

---

## Game Rules

| Rule | Details |
|------|---------|
| Each participant hosts exactly once | Hosting slots are distributed evenly across all rounds |
| No repeated meetings | No two participants share a group in more than one round (enforced; violations reported if unavoidable) |
| Host must have guests | Every host is guaranteed at least 1 guest |
| Group size cap | Configurable maximum guests per host (default: 3) |
| Final round | All participants meet at a shared goal location (repeat meetings are allowed here) |

---

## Features

- **Participant management**: add by address search, map click/pin, or CSV import
- **Transit-optimised scheduling**: uses the Wiener Linien public transit API to calculate real travel times between all participant pairs, then minimises total travel across rounds
- **Constraint satisfaction**: greedy scheduler with 100 shuffle-based retries; local search improvement with full backward + forward constraint checking
- **Violation indicator**: results screen shows a green/red banner confirming whether all "no repeat meeting" constraints were satisfied
- **Schedule view**: round-by-round group cards with per-participant colour-coded travel time badges (green ≤15 min, orange ≤30 min, red >30 min)
- **Journey view**: per-participant route through all rounds, with travel time per leg and total
- **Map visualisation**: interactive Leaflet map; schedule view shows group colour-coding per round, journey view traces an individual's route
- **Import / Export**: participants as CSV; full schedule as CSV

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express |
| Geocoding | Nominatim (OpenStreetMap) |
| Transit routing | Wiener Linien OGD API |
| Maps | Leaflet.js + OpenStreetMap tiles |
| Frontend | Vanilla JS / HTML / CSS (no build step) |

---

## Getting Started

**Prerequisites:** Node.js 18+

```bash
# Install dependencies
npm install

# Start (production)
npm start

# Start with auto-reload on file changes
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Usage

### 1. Setup

1. Set **Rounds** (N) and **Max guests per host** (Y) in the Event Config section.
   - Recommended: group size = N (e.g. 12 participants, 4 rounds, groups of 4)
   - Minimum participants: `N × 2`
2. Set a **Final meetup location** by searching for an address.
3. Add **participants** in one of three ways:
   - Search for an address and select from the dropdown
   - Type a name, then click **+ Pin on map** and click the map
   - Click **Import** to load a CSV file (see format below)
4. Click **Calculate Routes**.

### 2. Results: Schedule view

- Round tabs across the top; click to switch rounds (including Final).
- Each group card lists host and guests with a travel-time badge showing how long each person needs to travel to reach that location.
- A banner at the top confirms constraint satisfaction (green) or reports any forced repeat meetings (red).

### 3. Results: Journeys view

- Click a participant to highlight their full route: Home → Round 1 → Round 2 → ... → Final.
- Travel time for each leg is shown, along with the total.
- The map traces their route as a numbered polyline.

### 4. Export

- **Participants**: click **Export** in the setup panel to download `participants.csv`.
- **Schedule**: click **Export** in the results toolbar to download `running-cocktails-schedule.csv`.

---

## CSV Formats

### Participant import / export

```csv
Name,Latitude,Longitude
Alice,48.2082,16.3738
Bob,48.2155,16.3601
```

Header names are case-insensitive; `Lat` / `Lon` are accepted as short forms.

### Schedule export

```csv
Round,Group,Role,Name,Latitude,Longitude
1,A,Host,Alice,48.2082,16.3738
1,A,Guest,Bob,48.2155,16.3601
1,B,Host,Carol,48.1990,16.3820
...
Final,All,Attendee,Alice,48.2150,16.3580
```

---

## Scheduling Algorithm

1. **Distance matrix**: transit times for all participant pairs (including the goal location) are fetched from the Wiener Linien API in batches of 5 concurrent requests. Straight-line distance (Haversine x 4 min/km) is used as a fallback if a transit call fails.

2. **Greedy schedule generation**: hosts are assigned evenly across rounds. Guests are assigned round-by-round:
   - Guests that must fill an empty group (to guarantee every host has at least 1 guest) are placed there first.
   - Among valid placements, the one minimising transit time from the participant's previous location is chosen.
   - Up to 100 random shuffles are attempted to find a fully constraint-satisfying solution.

3. **Local search improvement**: 200 random guest-swap attempts per round. A swap is accepted only if:
   - Neither guest has met the other's new groupmates in any previous round (backward check).
   - Neither guest will meet those same groupmates again in any future round (forward check).
   - Total travel distance for the round decreases.

4. **Forced fallback**: if no valid schedule is found after 100 attempts (which can happen for mathematically impossible configurations), a best-effort schedule is generated with constraint relaxation. Any repeat meetings are reported in the violation banner.

---

## Constraints and Known Limitations

- The "no repeat meetings" constraint is equivalent to the **Social Golfer Problem**, which is NP-hard. For typical event sizes (12-30 participants, 3-4 rounds) the greedy + local search approach works well. For unusual configurations the fallback may produce a small number of violations.
- Participants must be in the **Vienna area**. The address search and transit API are both bounded to Vienna.
- Transit time calculation requires O(n^2) API calls. For 20 participants this is around 210 calls at 5 concurrent, taking roughly 40 seconds. A loading screen is shown during this step.
- For a perfectly even schedule, the number of participants should be divisible by the number of rounds.
