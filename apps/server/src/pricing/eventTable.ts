import fs from "fs";
import path from "path";
import * as yaml from "js-yaml";

type EventRow = { t_event_ms: number; omega_event: number };
type EventMap = Record<string, EventRow[]>;

const cfgPath = path.join(__dirname, "..", "..", "..", "..", "config", "events.yaml");

if (!fs.existsSync(cfgPath)) {
  throw new Error(`[eventTable] Missing config at ${cfgPath}`);
}

let tbl: EventMap = {};
try {
  const raw = fs.readFileSync(cfgPath, "utf8");
  const parsed = yaml.load(raw);
  if (parsed && typeof parsed === "object") {
    tbl = parsed as EventMap;
  }
} catch (e) {
  throw new Error(`[eventTable] Failed to load ${cfgPath}: ${(e as Error).message}`);
}

export function eventMasses(symbol: string, startMs: number, endMs: number): number {
  if (endMs <= startMs) return 0;
  const rows = tbl[symbol] ?? [];
  let w = 0;

  for (const r of rows) {
    if (!Number.isFinite(r.t_event_ms) || !Number.isFinite(r.omega_event)) continue;
    if (r.t_event_ms >= startMs && r.t_event_ms <= endMs) {
      w += Math.max(0, r.omega_event);
    }
  }
  return w;
}
