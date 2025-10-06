#!/usr/bin/env bash
set -euo pipefail
# COMMIT: fix(volModel): add marketIV fallback for ccMid/pcMid mids

perl -0777 -i -pe 's|// 4\) CC price via Black-76[\s\S]*?if \(!midIsSane\(pcMid\)\) pcMid = Math\.max\(0, forward \* pcIV \* Math\.sqrt\(T\) \* 0\.4\);|// 4) CC price via Black-76 (no proxy mids)
let ccVar = safe\(SVI\.w\(surface\.cc, k\), tiny\);
ccVar = Math\.max\(ccVar, tiny\);

let ccIV = safe\(Math\.sqrt\(ccVar \/ T\), 1e-8\);
ccIV = Math\.max\(ccIV, 1e-8\);

let ccG = black76Greeks\(forward, strike, T, ccIV, isCall, 1\.0\);
let ccMid = safe\(ccG\.price, 0\);

// 5) PC price via Black-76 (inventory-adjusted SVI)
let pcVar = safe\(SVI\.w\(surface\.pc, k\), tiny\);
pcVar = Math\.max\(pcVar, tiny\);

let pcIV = safe\(Math\.sqrt\(pcVar \/ T\), 1e-8\);
pcIV = Math\.max\(pcIV, 1e-8\);

let pcG = black76Greeks\(forward, strike, T, pcIV, isCall, 1\.0\);
let pcMid = safe\(pcG\.price, 0\);

// --- Fallback if mids collapsed to ~0 (e.g., SVI mapping oddities) ---
const ivFallback = Number\.isFinite\(marketIV\) \? \(marketIV as number\) : 0\.35;
if \(ccMid <= 1e-12\) \{
  ccG = black76Greeks\(forward, strike, T, ivFallback, isCall, 1\.0\);
  ccMid = Math\.max\(0, ccG\.price\);
  ccIV = ivFallback;
\}
if \(pcMid <= 1e-12\) \{
  pcG = black76Greeks\(forward, strike, T, ivFallback, isCall, 1\.0\);
  pcMid = Math\.max\(0, pcG\.price\);
  pcIV = ivFallback;
\}

// sanity clamps: non-negative, finite, bounded
const midIsSane = \(p: number\) =>
  Number\.isFinite\(p\) && p >= 0 && p <= Math\.max\(forward, strike\) \* 2;

if \(!midIsSane\(ccMid\)\) ccMid = Math\.max\(0, forward \* ccIV \* Math\.sqrt\(T\) \* 0\.4\);
if \(!midIsSane\(pcMid\)\) pcMid = Math\.max\(0, forward \* pcIV \* Math\.sqrt\(T\) \* 0\.4\);|s' apps/server/src/volModels/integratedSmileModel.ts

git add apps/server/src/volModels/integratedSmileModel.ts
