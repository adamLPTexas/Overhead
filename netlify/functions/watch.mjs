// Overhead watcher: a Netlify Scheduled Function that checks the sky every 3 minutes, on
// Netlify's servers, so emergency and medical flights get logged even when no one has the
// app open. It writes to the same log as the app (netlify/functions/log.mjs), using the same
// entry format and the same key, so a flight seen by both the watcher and an open app is
// still logged only once per aircraft, per code, per day (UTC).
//
// Where to watch comes from the site's environment variables (Netlify: Site configuration →
// Environment variables), so your location is never in the code or on GitHub:
//   OVERHEAD_LAT        latitude,  e.g. 32.95
//   OVERHEAD_LON        longitude, e.g. -96.85
//   OVERHEAD_RADIUS_MI  optional, miles around that point to watch (default 15, max 250)
// Without OVERHEAD_LAT and OVERHEAD_LON the watcher does nothing.
//
// Same rules as the app: squawk 7700 / 7600 / 7500 or an emergency status = emergency;
// "lifeguard" status = medical; planes whose owners opted out of tracking (LADD / PIA) are
// skipped. Free Netlify functions get 10 seconds per run, so every lookup has a short timeout.

import { getStore } from "@netlify/blobs";

export const config = { schedule: "*/3 * * * *" }; // every 3 minutes (UTC clock)

const EMERGENCY_SQUAWKS = { "7700": "EMERGENCY", "7600": "RADIO FAILURE", "7500": "HIJACK" };
const EMERGENCY_TYPES = { general: "EMERGENCY", minfuel: "MINIMUM FUEL", nordo: "RADIO FAILURE", unlawful: "HIJACK", downed: "AIRCRAFT DOWN", reserved: "EMERGENCY" };
const PRIVACY_FLAGS = 4 | 8; // PIA | LADD
const UA = { "User-Agent": "Overhead watcher (wtfisoverheadme.netlify.app)" };

const clip = (v, n) => (v == null || v === "" ? null : String(v).slice(0, n));
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);
const safeKey = (s) => s.replace(/[^A-Za-z0-9/_\-.:]/g, "_");

function emergencyOf(a) {
  if (a.squawk && EMERGENCY_SQUAWKS[a.squawk]) return `${EMERGENCY_SQUAWKS[a.squawk]} · ${a.squawk}`;
  if (a.emergency && EMERGENCY_TYPES[a.emergency]) return EMERGENCY_TYPES[a.emergency];
  return null;
}

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

export default async () => {
  const lat = parseFloat(process.env.OVERHEAD_LAT), lon = parseFloat(process.env.OVERHEAD_LON);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    console.log("watcher: OVERHEAD_LAT / OVERHEAD_LON not set, nothing to do");
    return;
  }
  const miles = Math.min(250, Math.max(1, parseFloat(process.env.OVERHEAD_RADIUS_MI) || 15));
  const nm = Math.ceil(miles / 1.15078);
  const store = getStore({ name: "overhead-log", consistency: "strong" });

  let ac;
  try {
    const j = await getJson(`https://api.adsb.lol/v2/point/${lat.toFixed(4)}/${lon.toFixed(4)}/${nm}`, 6000);
    ac = j.ac || j.aircraft || [];
  } catch (e) {
    // at most one watcher error entry per hour, so an outage doesn't flood the log
    const time = new Date().toISOString();
    const key = safeKey(`${time.slice(0, 10)}/error/watcher-${time.slice(11, 13)}`);
    if (!(await store.getMetadata(key))) {
      await store.setJSON(key, { type: "error", time, source: "watcher", message: clip(e.message, 200), version: null });
    }
    console.log("watcher: adsb.lol failed:", e.message);
    return;
  }

  const hits = ac.filter((a) => a.hex && !String(a.hex).startsWith("~") && !(((a.dbFlags | 0) & PRIVACY_FLAGS) !== 0))
    .map((a) => ({ a, emer: emergencyOf(a), medical: a.emergency === "lifeguard" }))
    .filter((h) => h.emer || h.medical);

  let added = 0;
  for (const { a, emer } of hits) {
    const type = emer ? "emergency" : "medical";
    const day = new Date().toISOString().slice(0, 10);
    const key = safeKey(`${day}/${type}/${clip(a.hex, 8)}-${clip(a.squawk, 4) || "none"}`);
    if (await store.getMetadata(key)) continue; // already logged today (by the watcher or the app)
    const callsign = (a.flight || "").trim();
    const route = await routeFor(callsign);
    const alt = a.alt_baro === "ground" ? 0 : (a.alt_baro ?? a.alt_geom ?? null);
    await store.setJSON(key, {
      type, time: new Date().toISOString(),
      label: clip(emer || "MEDICAL", 40),
      callsign: clip(callsign, 12),
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
      via: "watcher",
    });
    added++;
  }
  console.log(`watcher: ${ac.length} aircraft within ${miles} mi, ${hits.length} emergency/medical, ${added} newly logged`);
};
