#!/usr/bin/env bash
# Rolo auto-deploy (DEPLOY.md "Automatic updates").
#
# Runs on the server from cron every few minutes. Nothing happens unless
# origin/main has moved past what is checked out; then it fast-forwards,
# rebuilds the container and checks the app answers. "git push" from any
# machine is the whole deploy — the server never needs an SSH login for a
# routine update.
#
# Install once on the server (see DEPLOY.md):
#   (crontab -l 2>/dev/null; echo "*/5 * * * * $HOME/rolo/scripts/autodeploy.sh") | crontab -
#
# Everything it does is appended to autodeploy.log next to the repo; run it
# by hand to see the same lines on the terminal.

set -euo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$REPO/autodeploy.log"
BRANCH="${ROLO_DEPLOY_BRANCH:-main}"
PORT="${ROLO_PORT:-3000}"
DOCKER="${ROLO_DOCKER:-docker}"
# The commit that is actually live, and how often the latest one has failed
# to go live. Kept apart from git's HEAD so a build that broke halfway is
# retried, not mistaken for done.
DEPLOYED="$REPO/.autodeploy.deployed"
FAILED="$REPO/.autodeploy.failed"
MAX_ATTEMPTS=3

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"; }

cd "$REPO"

# One deploy at a time: a build that outlasts the cron interval must not be
# started twice on top of itself. Child commands get the descriptor closed
# (9>&-) so nothing they leave running keeps the lock after this exits.
exec 9>"$REPO/.autodeploy.lock"
if ! flock -n 9; then
  exit 0
fi

git fetch -q origin "$BRANCH"
remote_rev="$(git rev-parse "origin/$BRANCH")"
# First run after install: whatever is checked out is what is running.
deployed_rev="$(cat "$DEPLOYED" 2>/dev/null || git rev-parse HEAD)"
if [ "$remote_rev" = "$deployed_rev" ]; then
  exit 0
fi

attempts=0
if [ -f "$FAILED" ]; then
  read -r failed_rev failed_count <"$FAILED"
  if [ "$failed_rev" = "$remote_rev" ]; then
    attempts="$failed_count"
    if [ "$attempts" -ge "$MAX_ATTEMPTS" ]; then
      exit 0 # already gave up on this commit (logged below); the next push resets
    fi
  fi
fi

fail() {
  attempts=$((attempts + 1))
  printf '%s %s\n' "$remote_rev" "$attempts" >"$FAILED"
  log "ERROR: $*"
  if [ "$attempts" -ge "$MAX_ATTEMPTS" ]; then
    log "giving up on ${remote_rev:0:7} after $attempts attempts — fix it and push, or run this script by hand"
  fi
  exit 1
}

log "deploying ${deployed_rev:0:7} -> ${remote_rev:0:7} ($(git log -1 --format=%s "$remote_rev")) attempt $((attempts + 1))"

# Fast-forward only. A server checkout has no edits of its own, so anything
# that stops a fast-forward is worth a human look rather than a force.
if [ "$(git rev-parse HEAD)" != "$remote_rev" ]; then
  if ! git merge -q --ff-only "origin/$BRANCH" 2>>"$LOG"; then
    fail "cannot fast-forward — the checkout has local changes or diverged. Fix by hand: git status"
  fi
fi

if ! "$DOCKER" compose up -d --build >>"$LOG" 2>&1 9>&-; then
  fail "docker compose up failed — see the lines above"
fi
# Old images pile up on a small disk; keep only what the running container uses.
"$DOCKER" image prune -f >/dev/null 2>&1 9>&- || true

# The app answers on the login page (no cookie needed) once the new
# container is up; give it a minute.
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/login" || true)"
  if [ "$code" = "200" ]; then
    printf '%s\n' "$remote_rev" >"$DEPLOYED"
    rm -f "$FAILED"
    log "live at ${remote_rev:0:7}"
    exit 0
  fi
  sleep 2
done
fail "container rebuilt but http://localhost:$PORT/login is not answering (last status: ${code:-none}) — docker compose logs rolo"
