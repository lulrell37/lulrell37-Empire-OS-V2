#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Keep the Expo app's Replit/npm install from creating a root package-lock;
# GitHub Actions and EAS continue to use their existing Yarn build path.
npm install --package-lock=false --no-audit --no-fund --yes

# The backend has its own committed lockfile and is deployed independently.
npm ci --prefix server --no-audit --no-fund
