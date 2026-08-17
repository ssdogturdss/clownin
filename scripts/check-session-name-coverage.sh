#!/usr/bin/env bash
# =============================================================================
# Post-deploy health check: session name coverage
#
# Calls GET /api/admin/session-name-coverage and fails loudly if any sessions
# are unnamed — which means migration 0007_backfill_session_names.sql did not
# run or did not complete successfully.
#
# Required environment variables:
#   PRODUCTION_API_URL    Base URL of the production API server.
#                         Example: https://clownin.example.com
#   COVERAGE_CHECK_TOKEN  A signed admin JWT (Bearer token) for the production
#                         server.  Generate one by running the following on the
#                         production server (where JWT_SECRET is already set):
#
#                           node -e "
#                             const jwt = require('jsonwebtoken');
#                             console.log(jwt.sign(
#                               { userId: <admin_user_id>,
#                                 email: '<email>',
#                                 username: '<username>' },
#                               process.env.JWT_SECRET,
#                               { expiresIn: '90d' }
#                             ));
#                           "
#
#                         Store the output as a GitHub Actions secret named
#                         COVERAGE_CHECK_TOKEN and in /etc/clownin/app.env
#                         (or pass it to deploy/ubuntu/update.sh) for
#                         server-side post-deploy runs.
#
# Optional environment variables:
#   WAIT_SECONDS          Seconds to wait before hitting the endpoint (default: 15).
#                         Set to 0 when the caller already waited for readiness.
#   MAX_RETRIES           Number of curl attempts before giving up (default: 5).
#
# Exit codes:
#   0   All sessions have names — migration ran successfully.
#   1   One or more sessions are unnamed — migration may be missing or partial.
#   2   Configuration error, connectivity failure, bad HTTP status, or
#       unexpected response format — check itself could not complete reliably.
# =============================================================================

set -uo pipefail

# ── Validate required env vars ────────────────────────────────────────────────
if [[ -z "${PRODUCTION_API_URL:-}" ]]; then
  echo "[ERROR] PRODUCTION_API_URL must be set." >&2
  exit 2
fi
if [[ -z "${COVERAGE_CHECK_TOKEN:-}" ]]; then
  echo "[ERROR] COVERAGE_CHECK_TOKEN must be set." >&2
  exit 2
fi

WAIT_SECONDS="${WAIT_SECONDS:-15}"
MAX_RETRIES="${MAX_RETRIES:-5}"
MIGRATION_FILE="lib/db/migrations/0007_backfill_session_names.sql"

# ── Helpers ────────────────────────────────────────────────────────────────────
info()  { echo "[INFO]  $*"; }
ok()    { echo "[OK]    $*"; }

# ── Wait for the server to be ready ───────────────────────────────────────────
if [[ "$WAIT_SECONDS" -gt 0 ]]; then
  info "Waiting ${WAIT_SECONDS}s for the server to finish starting..."
  sleep "$WAIT_SECONDS"
fi

ENDPOINT="${PRODUCTION_API_URL%/}/api/admin/session-name-coverage"
info "Checking: $ENDPOINT"

# ── Fetch with retries ────────────────────────────────────────────────────────
# Use a temp file so we can capture both body and HTTP status without eval.
TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT

HTTP_STATUS=""
for attempt in $(seq 1 "$MAX_RETRIES"); do
  HTTP_STATUS=$(
    curl --silent --show-error \
         --max-time 30 \
         -H "Authorization: Bearer ${COVERAGE_CHECK_TOKEN}" \
         -o "$TMPFILE" \
         -w '%{http_code}' \
         "$ENDPOINT" 2>&1
  ) && break || {
    if [[ "$attempt" -lt "$MAX_RETRIES" ]]; then
      info "Attempt $attempt failed (curl error) — retrying in 10s..."
      sleep 10
    else
      echo "[ERROR] Could not reach $ENDPOINT after $MAX_RETRIES attempts." >&2
      exit 2
    fi
  }
done

BODY=$(cat "$TMPFILE")

# ── Check HTTP status ─────────────────────────────────────────────────────────
if [[ "$HTTP_STATUS" == "401" || "$HTTP_STATUS" == "403" ]]; then
  echo "[ERROR] HTTP $HTTP_STATUS — COVERAGE_CHECK_TOKEN is invalid, expired, or the" >&2
  echo "        user is not in ADMIN_USER_IDS on the production server." >&2
  echo "        Regenerate the token (see script header) and update the secret." >&2
  exit 2
fi

if [[ "$HTTP_STATUS" != "200" ]]; then
  echo "[ERROR] Unexpected HTTP status: $HTTP_STATUS" >&2
  echo "[ERROR] Response body: $BODY" >&2
  echo "[ERROR] Cannot determine migration status — the check itself failed." >&2
  exit 2
fi

# ── Parse and validate the JSON response ─────────────────────────────────────
# Require python3 or node; produce exit 2 (check broken) if neither is present.
if command -v python3 &>/dev/null; then
  PARSE_OUTPUT=$(python3 - "$BODY" <<'PYEOF'
import json, sys

body = sys.argv[1]
try:
    d = json.loads(body)
except json.JSONDecodeError as e:
    print(f"PARSE_ERROR: response is not valid JSON: {e}", file=sys.stderr)
    sys.exit(2)

for field in ("total", "named", "unnamed"):
    if field not in d:
        print(f"PARSE_ERROR: missing field '{field}' in response", file=sys.stderr)
        sys.exit(2)
    val = d[field]
    if not isinstance(val, int) or val < 0:
        print(f"PARSE_ERROR: field '{field}' must be a non-negative integer, got {val!r}", file=sys.stderr)
        sys.exit(2)

# Sanity: unnamed == total - named
expected_unnamed = d["total"] - d["named"]
if d["unnamed"] != expected_unnamed:
    print(
        f"PARSE_ERROR: unnamed={d['unnamed']} does not equal total-named={expected_unnamed}",
        file=sys.stderr,
    )
    sys.exit(2)

print(d["total"], d["named"], d["unnamed"])
PYEOF
  ) || {
    echo "[ERROR] Response payload validation failed — the check cannot be trusted." >&2
    echo "[ERROR] Raw response: $BODY" >&2
    exit 2
  }
elif command -v node &>/dev/null; then
  PARSE_OUTPUT=$(node -e "
const body = process.argv[1];
let d;
try { d = JSON.parse(body); } catch(e) {
  process.stderr.write('PARSE_ERROR: response is not valid JSON: ' + e.message + '\n');
  process.exit(2);
}
for (const f of ['total','named','unnamed']) {
  if (!(f in d)) { process.stderr.write('PARSE_ERROR: missing field ' + f + '\n'); process.exit(2); }
  if (!Number.isInteger(d[f]) || d[f] < 0) {
    process.stderr.write('PARSE_ERROR: field ' + f + ' must be a non-negative integer, got ' + d[f] + '\n');
    process.exit(2);
  }
}
if (d.unnamed !== d.total - d.named) {
  process.stderr.write('PARSE_ERROR: unnamed != total-named\n'); process.exit(2);
}
console.log(d.total, d.named, d.unnamed);
" "$BODY" 2>&1) || {
    echo "[ERROR] Response payload validation failed — the check cannot be trusted." >&2
    echo "[ERROR] Raw response: $BODY" >&2
    exit 2
  }
else
  echo "[ERROR] Neither python3 nor node is available to parse JSON." >&2
  exit 2
fi

read -r TOTAL NAMED UNNAMED <<< "$PARSE_OUTPUT"

info "Coverage: total=$TOTAL  named=$NAMED  unnamed=$UNNAMED"

# ── Evaluate result ───────────────────────────────────────────────────────────
if [[ "$UNNAMED" -gt 0 ]]; then
  echo "" >&2
  echo "══════════════════════════════════════════════════════════════" >&2
  echo "[ERROR] SESSION NAME COVERAGE CHECK FAILED" >&2
  echo "" >&2
  echo "  $UNNAMED of $TOTAL eligible sessions have no name." >&2
  echo "" >&2
  echo "  This means the following migration did not run or did not" >&2
  echo "  complete successfully on the production database:" >&2
  echo "" >&2
  echo "    $MIGRATION_FILE" >&2
  echo "" >&2
  echo "  To fix:" >&2
  echo "    1. Connect to the production database." >&2
  echo "    2. Run the SQL in $MIGRATION_FILE manually." >&2
  echo "    3. Re-run this check to confirm unnamed = 0." >&2
  echo "" >&2
  echo "══════════════════════════════════════════════════════════════" >&2
  exit 1
fi

ok "All $TOTAL sessions are named. Migration $MIGRATION_FILE is complete."
exit 0
