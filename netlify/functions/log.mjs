// Overhead activity log: a Netlify Function that stores entries in Netlify Blobs.
//
//   POST /api/log   add an entry (sent by the app)
//     { type: "emergency" | "medical", label, flight: { hex, callsign, reg, aircraft,
//       squawk, alt, gs, track, lat, lon, from, to } }
//     { type: "error", source, message, version }
//   GET  /api/log?days=7   newest entries first (max 31 days, 500 entries)
//
// The timestamp is added here on the server, so every entry's time comes from one clock.
// Emergency and medical sightings are stored once per aircraft, per code, per day (UTC):
// if several people have the app open, the flight is logged once, at its first sighting.
// Every field is length-capped and type-checked, because anyone with the link can call this.

import { getStore } from "@netlify/blobs";

export const config = { path: "/api/log" };

const TYPES = new Set(["emergency", "medical", "error"]);
const MAX_BODY = 4000;      // bytes
const MAX_RESULTS = 500;
const clip = (v, n) => (v == null || v === "" ? null : String(v).slice(0, n));
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);
const safeKey = (s) => s.replace(/[^A-Za-z0-9/_\-.:]/g, "_");

export default async (req) => {
  const store = getStore({ name: "overhead-log", consistency: "strong" });

  if (req.method === "GET") {
    const url = new URL(req.url);
    const days = Math.min(31, Math.max(1, parseInt(url.searchParams.get("days") || "7", 10) || 7));
    const entries = [];
    for (let i = 0; i < days && entries.length < MAX_RESULTS; i++) {
      const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const { blobs } = await store.list({ prefix: day + "/" });
      for (const b of blobs) {
        const e = await store.get(b.key, { type: "json" });
        if (e) entries.push(e);
        if (entries.length >= MAX_RESULTS) break;
      }
    }
    entries.sort((a, b) => String(b.time).localeCompare(String(a.time)));
    return Response.json({ entries }, { headers: { "Cache-Control": "no-store" } });
  }

  if (req.method !== "POST") return new Response("Use GET or POST", { status: 405 });

  let body;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY) return new Response("Entry too large", { status: 413 });
    body = JSON.parse(text);
  } catch {
    return new Response("Body must be JSON", { status: 400 });
  }
  if (!body || !TYPES.has(body.type)) return new Response("Unknown entry type", { status: 400 });

  const time = new Date().toISOString();
  const day = time.slice(0, 10);
  let key, entry;

  if (body.type === "error") {
    entry = {
      type: "error", time,
      source: clip(body.source, 40),
      message: clip(body.message, 200),
      version: clip(body.version, 12),
    };
    key = `${day}/error/${time}-${Math.random().toString(36).slice(2, 8)}`;
  } else {
    const f = body.flight || {};
    entry = {
      type: body.type, time,
      label: clip(body.label, 40),
      callsign: clip(f.callsign, 12),
      reg: clip(f.reg, 12),
      hex: clip(f.hex, 8),
      aircraft: clip(f.aircraft, 60),
      squawk: clip(f.squawk, 4),
      alt: num(f.alt),
      speed_kt: num(f.gs),
      track: num(f.track),
      lat: num(f.lat),
      lon: num(f.lon),
      from: clip(f.from, 8),
      to: clip(f.to, 8),
    };
    if (!entry.hex || entry.hex.startsWith("~")) return new Response("Missing aircraft code", { status: 400 });
    key = `${day}/${body.type}/${entry.hex}-${entry.squawk || "none"}`;
    if (await store.getMetadata(safeKey(key))) return Response.json({ ok: true, duplicate: true });
  }

  await store.setJSON(safeKey(key), entry);
  return Response.json({ ok: true });
};
