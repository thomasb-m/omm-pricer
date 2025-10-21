#!/usr/bin/env bash
set -euo pipefail
# COMMIT: rest/edge+bucket: guard edge calc; widen delta bands so ATM maps to 'atm'

# Guard edge in REST payload (always pcMid - ccMid)
perl -0777 -i -pe 's/edge:\s*q\.edge,?/edge: \((q\.pcMid ?? q\.mid) - (q\.ccMid ?? q\.mid),/;' apps/server/src/quoteEngine.ts

# Widen bucket delta thresholds
perl -0777 -i -pe "
  s/if \(delta >= 0\.45 && delta <= 0\.55\) return 'atm';/if (delta >= 0.40 && delta <= 0.60) return 'atm';/;
  s/if \(delta >= 0\.20 && delta <= 0\.30\) return 'rr25';/if (delta >= 0.18 && delta <= 0.32) return 'rr25';/;
  s/if \(delta >= 0\.08 && delta <= 0\.12\) return 'rr10';/if (delta >= 0.06 && delta <= 0.14) return 'rr10';/;
" apps/server/src/volModels/pricing/blackScholes.ts

git add apps/server/src/quoteEngine.ts apps/server/src/volModels/pricing/blackScholes.ts
