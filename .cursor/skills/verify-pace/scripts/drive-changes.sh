#!/usr/bin/env bash
# Doctor, drive Session dock Changes, clean up, confirm evidence survived.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$ROOT"

export PATH="${HOME}/.bun/bin:${PATH}"

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
EVIDENCE="${PACE_VERIFY_EVIDENCE:-$ROOT/.cursor/skills/verify-pace/runs/$RUN_ID}"
mkdir -p "$EVIDENCE"
export PACE_VERIFY_EVIDENCE="$EVIDENCE"

node "$ROOT/.cursor/skills/verify-pace/scripts/doctor.mjs" | tee "$EVIDENCE/doctor.json"
if ! grep -q '"ok": true' "$EVIDENCE/doctor.json"; then
  echo "doctor failed; not launching" >&2
  exit 1
fi

status=0
cleanup() {
  node "$ROOT/.cursor/skills/verify-pace/scripts/cleanup.mjs" --evidence "$EVIDENCE" || true
}
trap cleanup EXIT

PLAYWRIGHT="$ROOT/node_modules/.bin/playwright"
if [[ "$(uname -s)" == "Linux" ]]; then
  export PACE_E2E_ELECTRON_ARGS="${PACE_E2E_ELECTRON_ARGS:---ozone-platform=x11}"
  if command -v xvfb-run >/dev/null 2>&1; then
    env -u WAYLAND_DISPLAY xvfb-run -a -s "-screen 0 1920x1080x24" \
      "$PLAYWRIGHT" test --config "$ROOT/.cursor/skills/verify-pace/drive/playwright.config.ts" \
      || status=$?
  else
    "$PLAYWRIGHT" test --config "$ROOT/.cursor/skills/verify-pace/drive/playwright.config.ts" \
      || status=$?
  fi
else
  "$PLAYWRIGHT" test --config "$ROOT/.cursor/skills/verify-pace/drive/playwright.config.ts" \
    || status=$?
fi

if [[ "$status" -ne 0 ]]; then
  echo "drive failed with status $status" >&2
  exit "$status"
fi

test -s "$EVIDENCE/changes.png"
test -s "$EVIDENCE/changes.aria.yml"
test -s "$EVIDENCE/checkout-app.ts"
grep -q 'export const state = "after"' "$EVIDENCE/checkout-app.ts"
grep -q 'session-dock-changes' "$EVIDENCE/result.txt"

if [[ -f "$EVIDENCE/instance.json" ]]; then
  TEST_ROOT="$(node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(j.testRoot||"")' "$EVIDENCE/instance.json")"
  if [[ -n "$TEST_ROOT" && -d "$TEST_ROOT" ]]; then
    echo "temp root still exists after cleanup: $TEST_ROOT" >&2
    exit 1
  fi
fi

echo "evidence survived at $EVIDENCE"
