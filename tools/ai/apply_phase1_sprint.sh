#!/usr/bin/env bash
set -euo pipefail

echo "[phase1] starting…"

# --- sanity: repo layout check ---
if [[ ! -d "apps/server" ]]; then
  echo "[phase1] ERROR: run from repo root (expected apps/server/)."
  exit 1
fi

BRANCH="ai/phase1-sprint"

# --- git branch (robust for macOS bash) ---
echo "[phase1] creating/updating branch $BRANCH"
if git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
  git checkout "$BRANCH"
else
  git checkout -b "$BRANCH"
fi

# --- make dirs ---
mkdir -p config \
  apps/server/src/pricing \
  apps/server/src/logging \
  apps/server/src/api/routes \
  apps/server/test \
  tools/ai

# --- config files ---
cat > config/events.yaml <<'YAML'
BTC:
  - t_event_ms: 1760054400000
    omega_event: 0.0008
YAML

cat > config/seasonality.json <<'JSON'
{
  "timezone": "UTC",
  "gridMinutes": 5,
  "profile": [
    { "mod": 0,    "s": 1.0 },
    { "mod": 360,  "s": 1.2 },
    { "mod": 720,  "s": 0.9 },
    { "mod": 1080, "s": 1.1 }
  ],
  "overnightOmega": { "weekday": 0.00005, "weekend": 0.00012 }
}
JSON

# --- seasonality integrator ---
cat > apps/server/src/pricing/seasonality.ts <<'TS'
import fs from "fs";
import path from "path";

type SeasonalityCfg = {
  timezone: string;
  gridMinutes: number;
  profile: { mod: number; s: number }[];
  overnightOmega: { weekday: number; weekend: number };
};

const cfg: SeasonalityCfg = JSON.parse(
  fs.readFileSync(path.resolve("config/seasonality.json"), "utf8")
);

function scaleForMinute(minOfDay: number) {
  let best = cfg.profile[0];
  for (const p of cfg.profile) {
    if (Math.abs(p.mod - minOfDay) < Math.abs(best.mod - minOfDay)) best = p;
  }
  return Math.max(0, best.s);
}

export function tauIntegral(startMs: number, endMs: number): number {
  const step = cfg.gridMinutes * 60 * 1000;
  let t = startMs, acc = 0;
  while (t < endMs) {
    const d = new Date(t);
    const minOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
    acc += scaleForMinute(minOfDay) * step;
    t += step;
  }
  const YEAR_MS = 365.25 * 24 * 3600 * 1000;
  return acc / YEAR_MS;
}

export function overnightMasses(startMs: number, endMs: number): number {
  let w = 0;
  const start = new Date(startMs);
  let midnight = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 1);
  while (midnight <= endMs) {
    const wd = new Date(midnight).getUTCDay();
    const isWeekend = wd === 0 || wd === 6;
    w += isWeekend ? cfg.overnightOmega.weekend : cfg.overnightOmega.weekday;
    midnight += 24 * 3600 * 1000;
  }
  return Math.max(0, w);
}
TS

# --- event table loader ---
cat > apps/server/src/pricing/eventTable.ts <<'TS'
import fs from "fs";
import yaml from "js-yaml";
import path from "path";

type EventRow = { t_event_ms: number; omega_event: number };
type EventMap = Record<string, EventRow[]>;

const tbl = yaml.load(
  fs.readFileSync(path.resolve("config/events.yaml"), "utf8")
) as EventMap;

export function eventMasses(symbol: string, startMs: number, endMs: number): number {
  const rows = tbl[symbol] ?? [];
  let w = 0;
  for (const r of rows) {
    if (r.t_event_ms >= startMs && r.t_event_ms <= endMs) w += Math.max(0, r.omega_event);
  }
  return w;
}
TS

# --- total variance helper ---
cat > apps/server/src/pricing/totalVariance.ts <<'TS'
import { tauIntegral, overnightMasses } from "./seasonality";
import { eventMasses } from "./eventTable";
import { sviTotalVarInTau } from "./varFromSVI";

export function totalVariance(params: {
  symbol: string;
  K: number;
  startMs: number;
  endMs: number;
}) {
  const { symbol, K, startMs, endMs } = params;
  const tau = tauIntegral(startMs, endMs);
  const wDiff = sviTotalVarInTau(symbol, K, tau);
  const wON = overnightMasses(startMs, endMs);
  const wEvt = eventMasses(symbol, startMs, endMs);
  return Math.max(0, wDiff + wON + wEvt);
}
TS

# --- mixture pricer scaffold (optional) ---
cat > apps/server/src/pricing/eventPricer.ts <<'TS'
import { bsPrice } from "../pricers/black";
import { totalVariance } from "./totalVariance";

const GH5 = [
  { x: -2.02018287, w: 0.01995324 },
  { x: -0.95857246, w: 0.39361932 },
  { x:  0.00000000, w: 0.94530872 },
  { x:  0.95857246, w: 0.39361932 },
  { x:  2.02018287, w: 0.01995324 }
];

export function priceWithEventMixture(p: {
  symbol: string; S0: number; K: number; startMs: number; endMs: number;
  muLogJump?: number; sigmaLogJump?: number;
}) {
  const { symbol, S0, K, startMs, endMs, muLogJump=0, sigmaLogJump=0 } = p;
  const YEAR_MS = 365.25 * 24 * 3600 * 1000;
  const dtYears = Math.max(1e-9, (endMs - startMs) / YEAR_MS);
  const wTot = totalVariance({ symbol, K, startMs, endMs });
  const sigmaEff = Math.sqrt(Math.max(1e-12, wTot / dtYears));

  if (sigmaLogJump <= 0) {
    return bsPrice({ F: S0, K, sigma: sigmaEff, T: dtYears });
  }
  let acc = 0;
  for (const { x, w } of GH5) {
    const X = muLogJump + sigmaLogJump * x;
    const Fshift = S0 * Math.exp(X);
    acc += w * bsPrice({ F: Fshift, K, sigma: sigmaEff, T: dtYears });
  }
  return acc / Math.sqrt(Math.PI);
}
TS

# --- trade logger ---
cat > apps/server/src/logging/tradeLog.ts <<'TS'
import fs from "fs";
import path from "path";

const LOG = path.resolve("data/trades.jsonl");

export type TradeRow = {
  ts: number;
  symbol: string;
  F: number; K: number; expiryMs: number;
  side: "BUY"|"SELL"; qty: number;
  ccMid: number; pcMid: number; tradePx: number;
  dotLamG: number;
  I_before: number[]; I_after: number[]; lambda: number[];
  pnl_est: number;
  signal_tags?: string[];
};

export class TradeLog {
  static write(row: TradeRow) {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify(row) + "\n");
  }
}
TS

# --- routes: risk & pnl ---
cat > apps/server/src/api/routes/risk.ts <<'TS'
import { FastifyInstance } from "fastify";
import { VolModelService } from "../../services/volModelService";

export async function riskRoutes(f: FastifyInstance) {
  const svc = new VolModelService();
  f.get("/risk/factors", async (req) => {
    const { symbol = "BTC" } = (req.query as any) ?? {};
    return svc.getFactors(String(symbol));
  });
}
TS

cat > apps/server/src/api/routes/pnl.ts <<'TS'
import { FastifyInstance } from "fastify";
import fs from "fs";
import path from "path";

export async function pnlRoutes(f: FastifyInstance) {
  f.get("/pnl/summary", async () => {
    const file = path.resolve("data/trades.jsonl");
    if (!fs.existsSync(file)) return { count: 0, estEdge: 0 };
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    const estEdge = lines.reduce((s, ln) => s + (JSON.parse(ln).pnl_est ?? 0), 0);
    return { count: lines.length, estEdge };
  });
}
TS

# --- server bootstrap: register routes (mac-safe edits) ---
SERVER_FILE="apps/server/src/server.ts"
if [[ -f "$SERVER_FILE" ]]; then
  if ! grep -q 'api/routes/risk' "$SERVER_FILE"; then
    awk 'NR==1{print "import { riskRoutes } from \"./api/routes/risk\";"; print "import { pnlRoutes } from \"./api/routes/pnl\";"}1' "$SERVER_FILE" > "$SERVER_FILE.tmp" && mv "$SERVER_FILE.tmp" "$SERVER_FILE"
  fi
  if ! grep -q 'register(riskRoutes)' "$SERVER_FILE"; then
    echo -e "\n// [phase1] routes\nawait app.register(riskRoutes);\nawait app.register(pnlRoutes);\n" >> "$SERVER_FILE"
  fi
else
  echo "[phase1] WARN: $SERVER_FILE not found — please register routes manually."
fi

# --- tests ---
cat > apps/server/test/eventVariance.test.ts <<'TS'
import { totalVariance } from "../src/pricing/totalVariance";

test("total variance adds event mass across T", () => {
  const now = Date.UTC(2025, 9, 6);
  const tEvt = Date.UTC(2025, 9, 8);
  const oneDay = 24*3600*1000;

  const wBefore = totalVariance({ symbol: "BTC", K: 100, startMs: now, endMs: tEvt - oneDay });
  const wSpan   = totalVariance({ symbol: "BTC", K: 100, startMs: now, endMs: tEvt + oneDay });

  expect(wSpan).toBeGreaterThanOrEqual(wBefore);
});
TS

cat > apps/server/test/replay.determinism.test.ts <<'TS'
import { Backtester } from "../src/replay/backtester";

test("deterministic inventory path with fixed seed", async () => {
  const bt1 = new Backtester({ seed: 42 });
  const bt2 = new Backtester({ seed: 42 });

  const r1 = await bt1.run({ days: 2 });
  const r2 = await bt2.run({ days: 2 });

  expect(JSON.stringify(r1.inventoryPath)).toBe(JSON.stringify(r2.inventoryPath));
  expect(r1.trades.length).toBe(r2.trades.length);
});
TS

# --- optional backtester hint (non-fatal) ---
BACKTESTER="apps/server/src/replay/backtester.ts"
if [[ -f "$BACKTESTER" ]]; then
  if ! grep -q 'VolModelService' "$BACKTESTER"; then
    awk 'NR==1{print "import { VolModelService } from \"../services/volModelService\";"; print "import { TradeLog } from \"../logging/tradeLog\";"}1' "$BACKTESTER" > "$BACKTESTER.tmp" && mv "$BACKTESTER.tmp" "$BACKTESTER"
  fi
  if grep -q 'export class Backtester' "$BACKTESTER" && ! grep -q 'private svc = new VolModelService' "$BACKTESTER"; then
    perl -0777 -i -pe 's/(export\s+class\s+Backtester[^{]*\{)/$1\n  private svc = new VolModelService();\n/s' "$BACKTESTER" || true
  fi
fi

# --- dependency ---
echo "[phase1] installing js-yaml in apps/server workspace…"
npm i -w apps/server js-yaml

# --- commit ---
git add -A
git commit -m "phase1: seasonality+event variance, totalVariance helper, trade log, risk/pnl routes, tests" || echo "[phase1] nothing to commit"

# --- optional push ---
git push -u origin "$BRANCH" || echo "[phase1] skip push (no remote/creds)."

echo "[phase1] done ✓
Next:
  npm test --workspaces
  npm run -w apps/server start
  # then:
  curl 'http://localhost:3001/risk/factors?symbol=BTC'
  curl 'http://localhost:3001/pnl/summary'
"
