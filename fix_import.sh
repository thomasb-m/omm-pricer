#!/bin/bash
# Backup first
cp apps/server/src/volModels/integratedSmileModel.ts apps/server/src/volModels/integratedSmileModel.ts.backup

# Use awk to safely replace just line 13
awk 'NR==13 {print "import { DeltaConventions } from '\''./pricing/blackScholes'\'';"; print "import { black76Greeks } from '\''../risk/index'\'';"; next} {print}' \
  apps/server/src/volModels/integratedSmileModel.ts.backup > apps/server/src/volModels/integratedSmileModel.ts

echo "✅ Fixed import. Original saved as .backup"
