#!/bin/sh
# Bind-mounting ./web over /app hides the image's node_modules. Install into the
# named volume the first time this container starts, then run next dev.
set -eu
if [ ! -f node_modules/next/package.json ]; then
  echo "web: installing dependencies into the container volume..."
  if [ -f package-lock.json ]; then
    npm ci --no-audit --no-fund --ignore-scripts
  else
    npm install --no-audit --no-fund --ignore-scripts
  fi
fi
exec npx next dev --hostname 0.0.0.0 --port 3000
