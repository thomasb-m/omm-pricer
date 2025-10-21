import fs from "fs";
import path from "path";

function minuteOfDayInTZ(tMs: number, timeZone: string): number {
  const d = new Date(tMs);
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).formatToParts(d);

  const hh = Number(parts.find(p => p.type === "hour")?.value ?? "0");
  const mm = Number(parts.find(p => p.type === "minute")?.value ?? "0");
  return hh * 60 + mm;
}

type SeasonalityCfg = {
  timezone: string;
  gridMinutes: number;
  profile: { mod: number; s: number }[];
  overnightOmega: { weekday: number; weekend: number };
};

const cfgPath = path.join(__dirname, "..", "..", "..", "..", "config", "seasonality.json");

if (!fs.existsSync(cfgPath)) {
  throw new Error(`[seasonality] Missing config at ${cfgPath}`);
}

let cfg: SeasonalityCfg;
try {
  cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
} catch (e) {
  throw new Error(`[seasonality] Failed to parse ${cfgPath}: ${(e as Error).message}`);
}

function scaleForMinute(minOfDay: number): number {
  let best = cfg.profile[0];
  let bestDist = Math.abs(cfg.profile[0].mod - minOfDay);
  for (let i = 1; i < cfg.profile.length; i++) {
    const p = cfg.profile[i];
    const dist = Math.abs(p.mod - minOfDay);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  return Math.max(0, best.s);
}

export function tauIntegral(startMs: number, endMs: number): number {
  if (endMs <= startMs) return 0;

  const step = Math.max(1, Math.floor(cfg.gridMinutes)) * 60 * 1000;
  let t = startMs;
  let acc = 0;

  while (t < endMs) {
    const tNext = Math.min(t + step, endMs);
    const minOfDay = minuteOfDayInTZ(t, cfg.timezone);
    const s = scaleForMinute(minOfDay);
    acc += s * (tNext - t);
    t = tNext;
  }

  const YEAR_MS = 365.25 * 24 * 3600 * 1000;
  return acc / YEAR_MS;
}

export function overnightMasses(startMs: number, endMs: number): number {
  if (endMs <= startMs) return 0;
  
  let w = 0;
  const d0 = new Date(startMs);
  let day = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate() + 1);
  
  while (day < endMs) {
    const weekday = new Date(day).getUTCDay();
    const isWeekend = weekday === 0 || weekday === 6;
    w += isWeekend ? cfg.overnightOmega.weekend : cfg.overnightOmega.weekday;
    day += 24 * 3600 * 1000;
  }
  
  return Math.max(0, w);
}
