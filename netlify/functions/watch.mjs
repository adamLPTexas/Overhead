// Overhead watcher: a Netlify Scheduled Function that runs every 3 minutes on Netlify's
// servers, so emergency and medical flights are logged even when no one has the app open.
//
// Each run makes two kinds of checks:
//   Emergencies, worldwide: every aircraft adsb.lol can see squawking 7700 (emergency),
//     7600 (radio failure) or 7500 (hijack). No location needed.
//   Medical flights, regional: every aircraft within 200 nm of downtown Dallas, checked for
//     the "lifeguard" (medical) status. adsb.lol can't filter by that status worldwide, so
//     this needs an area. Emergencies that only set a status (e.g. minimum fuel) without
//     changing their squawk code are caught here too, within the same area.
//   The centre can be moved with the site's environment variables OVERHEAD_LAT / OVERHEAD_LON
//   (Netlify: Site configuration → Environment variables); downtown Dallas is the default.
//
// Every sighting lands in the same log as the app (see ../shared/log-store.mjs): a flight
// gets one entry per code per day, and its "count" goes up each time a later run sees it
// again. Emergencies also count toward the weekly cap (EMERGENCY_WEEKLY_LIMIT, 200); once
// it's reached, emergency logging stops until midnight Sunday, Central time.
// Planes whose owners opted out of tracking (LADD / PIA) are skipped, as in the app.
// Free Netlify functions get 10 seconds per run, so every lookup has a short timeout.

import { logStore, safeKey, clip, num, readWeekTally, writeWeekTally, logHourlyError } from "../shared/log-store.mjs";

export const config = { schedule: "*/3 * * * *" }; // every 3 minutes

const DEFAULT_CENTER = { lat: 32.7767, lon: -96.797 }; // downtown Dallas
const MEDICAL_RADIUS_NM = 200;
const EMERGENCY_CODES = ["7700", "7600", "7500"];
const MAX_ROUTE_LOOKUPS = 8; // per run, to stay inside the 10-second limit

const EMERGENCY_SQUAWKS = { "7700": "EMERGENCY", "7600": "RADIO FAILURE", "7500": "HIJACK" };
const EMERGENCY_TYPES = { general: "EMERGENCY", minfuel: "MINIMUM FUEL", nordo: "RADIO FAILURE", unlawful: "HIJACK", downed: "AIRCRAFT DOWN", reserved: "EMERGENCY" };
const PRIVACY_FLAGS = 4 | 8; // PIA | LADD
const UA = { "User-Agent": "Overhead watcher (wtfisoverheadme.netlify.app)" };

function emergencyOf(a) {
  if (a.squawk && EMERGENCY_SQUAWKS[a.squawk]) return `${EMERGENCY_SQUAWKS[a.squawk]} · ${a.squawk}`;
  if (a.emergency && EMERGENCY_TYPES[a.emergency]) return EMERGENCY_TYPES[a.emergency];
  return null;
}
const trackable = (a) => a && a.hex && !String(a.hex).startsWith("~") && ((a.dbFlags | 0) & PRIVACY_FLAGS) === 0;

async function getJson(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { headers: UA, signal: ctl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

// route by callsign from adsbdb, same source as the app; null if unknown or slow
async function routeFor(callsign) {
  if (!callsign) return null;
  try {
    const j = await getJson(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`, 2500);
    const fr = j && j.response && j.response.flightroute;
    if (!fr) return null;
    return [fr.origin && (fr.origin.iata_code || fr.origin.icao_code), fr.destination && (fr.destination.iata_code || fr.destination.icao_code)];
  } catch { return null; }
}

function buildEntry(h, route, time) {
  const a = h.a;
  const alt = a.alt_baro === "ground" ? 0 : (a.alt_baro ?? a.alt_geom ?? null);
  return {
    type: h.type, time, last: time, count: 1, via: "watcher",
    label: clip(h.emer || "MEDICAL", 40),
    callsign: clip(h.callsign, 12),
    reg: clip(a.r, 12),
    hex: clip(a.hex, 8),
    aircraft: clip(a.desc || a.t, 60),
    squawk: clip(a.squawk, 4),
    alt: num(alt),
    speed_kt: num(a.gs),
    track: num(a.track ?? a.true_heading),
    lat: num(a.lat),
    lon: num(a.lon),
    from: clip(route && route[0], 8),
    to: clip(route && route[1], 8),
  };
}

export default async () => {
  const store = logStore();
  const lat = parseFloat(process.env.OVERHEAD_LAT), lon = parseFloat(process.env.OVERHEAD_LON);
  const center = Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : DEFAULT_CENTER;

  const [area, ...squawks] = await Promise.allSettled([
    getJson(`https://api.adsb.lol/v2/point/${center.lat.toFixed(4)}/${center.lon.toFixed(4)}/${MEDICAL_RADIUS_NM}`, 7000),
    ...EMERGENCY_CODES.map((c) => getJson(`https://api.adsb.lol/v2/sqk/${c}`, 7000)),
  ]);
  const failed = [area, ...squawks].filter((r) => r.status === "rejected");
  if (failed.length) await logHourlyError(store, "watcher", `adsb.lol: ${failed.length} of 4 lookups failed (${failed[0].reason && failed[0].reason.message})`).catch(() => {});

  // everything worth logging this run, one per aircraft
  const hits = new Map();
  const add = (a, emer, medical) => {
    if (!trackable(a) || hits.has(a.hex) || !(emer || medical)) return;
    hits.set(a.hex, { a, emer, type: emer ? "emergency" : "medical", callsign: (a.flight || "").trim() });
  };
  for (const r of squawks) if (r.status === "fulfilled") for (const a of r.value.ac || []) add(a, emergencyOf(a), false);
  if (area.status === "fulfilled") for (const a of area.value.ac || []) add(a, emergencyOf(a), a.emergency === "lifeguard");

  const time = new Date().toISOString();
  const day = time.slice(0, 10);
  const tally = await readWeekTally(store);
  // weekly cap reached: emergencies are not logged at all until the week resets
  const items = [...hits.values()]
    .filter((h) => h.type === "medical" || !tally.paused)
    .map((h) => ({ ...h, key: safeKey(`${day}/${h.type}/${clip(h.a.hex, 8)}-${clip(h.a.squawk, 4) || "none"}`) }));

  const existing = await Promise.all(items.map((h) => store.get(h.key, { type: "json" }).catch(() => null)));
  const repeats = [], fresh = [];
  items.forEach((h, i) => (existing[i] ? repeats.push([h, existing[i]]) : fresh.push(h)));

  // seen again: count goes up
  await Promise.all(repeats.map(([h, e]) => store.setJSON(h.key, { ...e, count: (e.count || 1) + 1, last: time })));

  // first sighting today: new entry (emergencies only while the week has room)
  const room = Math.max(0, tally.limit - tally.count);
  const newEmer = fresh.filter((h) => h.type === "emergency").slice(0, room);
  const toAdd = newEmer.concat(fresh.filter((h) => h.type === "medical"));
  const routes = await Promise.all(toAdd.map((h, i) => (i < MAX_ROUTE_LOOKUPS ? routeFor(h.callsign) : null)));
  await Promise.all(toAdd.map((h, i) => store.setJSON(h.key, buildEntry(h, routes[i], time))));
  if (newEmer.length) await writeWeekTally(store, tally.start, tally.count + newEmer.length);

  const nEmer = [...hits.values()].filter((h) => h.type === "emergency").length;
  console.log(`watcher: ${nEmer} emergencies worldwide, ${hits.size - nEmer} medical near ${center.lat},${center.lon}; ` +
    `${toAdd.length} new, ${repeats.length} counted again; week of ${tally.start}: ` +
    `${tally.count + newEmer.length}/${tally.limit} emergencies${tally.paused ? " (cap reached, emergencies paused)" : ""}`);
};
