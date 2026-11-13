// Shared by the log function (log.mjs) and the 5-minute watcher (watch.mjs), so both write
// the same entries, the same keys and the same weekly emergency tally.
//
// Storage (Netlify Blobs, store "overhead-log"):
//   YYYY-MM-DD/emergency/<hex>-<squawk>   one entry per aircraft, per code, per day (UTC);
//   YYYY-MM-DD/medical/<hex>-none         "count" goes up each time the watcher sees it again
//   YYYY-MM-DD/error/...                  failed data fetches
//   tally/week-<sunday>                   emergencies logged this week (see below)

import { getStore } from "@netlify/blobs";

// Weekly emergency cap: once this many emergency flights have been logged in a week, all
// emergency logging stops (no new entries, no count increases) until the week resets at
// midnight Sunday, Central time. Medical flights are not affected.
export const EMERGENCY_WEEKLY_LIMIT = 200;
export const WEEK_TZ = "America/Chicago";

export const logStore = () => getStore({ name: "overhead-log", consistency: "strong" });
export const clip = (v, n) => (v == null || v === "" ? null : String(v).slice(0, n));
export const num = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);
export const safeKey = (s) => s.replace(/[^A-Za-z0-9/_\-.:]/g, "_");

// date (YYYY-MM-DD) of the Sunday that started the current week, in Central time
export function weekStart(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: WEEK_TZ, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(now).map((p) => [p.type, p.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day - wd)).toISOString().slice(0, 10);
}

export async function readWeekTally(store) {
  const start = weekStart();
  const t = await store.get(`tally/week-${start}`, { type: "json" }).catch(() => null);
  const count = (t && t.count) || 0;
  return { start, count, limit: EMERGENCY_WEEKLY_LIMIT, paused: count >= EMERGENCY_WEEKLY_LIMIT };
}
export async function writeWeekTally(store, start, count) {
  await store.setJSON(`tally/week-${start}`, { count, updated: new Date().toISOString() });
}

// at most one error entry per source per hour, so an outage doesn't flood the log
export async function logHourlyError(store, source, message) {
  const time = new Date().toISOString();
  const key = safeKey(`${time.slice(0, 10)}/error/${source}-${time.slice(11, 13)}`);
  if (await store.getMetadata(key)) return;
  await store.setJSON(key, { type: "error", time, source: clip(source, 40), message: clip(message, 200), version: null });
}
