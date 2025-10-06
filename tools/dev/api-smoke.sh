#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-http://localhost:3001}"
echo "=== SMOKE against ${BASE} ==="

echo "-> /health"
curl -s "$BASE/health" | jq . || curl -s "$BASE/health"

echo "-> ATM quote (14d, C 100k, IV=0.31)"
EXP=$(node -e 'console.log(Date.now()+14*24*3600*1000)')
node -e "
const u=${EXP:-Date.now()+14*24*3600*1000};
fetch('${BASE:-http://localhost:3001}/quote',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({symbol:'BTC',strike:100000,expiryMs:u,optionType:'C',marketIV:0.31})})
.then(r=>r.json()).then(x=>{console.log(x); if(x.pcMid!=null&&x.ccMid!=null) console.log('edge_check', x.pcMid - x.ccMid);});
"

echo "-> Execute BUY 50x 90k P (we SELL)"
node -e "
const e=Date.now()+14*24*3600*1000;
fetch('${BASE:-http://localhost:3001}/quote',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({symbol:'BTC',strike:90000,expiryMs:e,optionType:'P',marketIV:0.31})})
.then(r=>r.json())
.then(q=>fetch('${BASE:-http://localhost:3001}/trade/execute',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({symbol:'BTC',strike:90000,expiryMs:e,optionType:'P',side:'BUY',size:50,price:q.ask})}))
.then(r=>r.json()).then(x=>console.log(x));
"

echo "-> /inventory (smile)"
curl -s "$BASE/inventory?symbol=BTC" | jq . || curl -s "$BASE/inventory?symbol=BTC"

echo "-> /risk/factors (factor space)"
curl -s "$BASE/risk/factors?symbol=BTC" | jq . || curl -s "$BASE/risk/factors?symbol=BTC"

echo '=== done ==='
