#!/usr/bin/env bash
# release-deploy.sh — deploy the Keylay app/relay to a tagged release.
# Run on the server:
#     sudo -u keylay bash release-deploy.sh v0.8.0
#
# ── Where the app lives (authoritative) ─────────────────────────────────────
#   /home/keylay/relay  is BOTH the git checkout of the relay repo AND what the
#   reverse proxy serves. The app lives here — not under public_html.
#   This box is in detached-HEAD / tag-deploy mode, so `git pull` FAILS here
#   ("You are not currently on a branch"); we fetch tags and check the tag out.
# ────────────────────────────────────────────────────────────────────────────
set -euo pipefail

TAG="${1:?usage: release-deploy.sh <tag>   e.g. release-deploy.sh v0.8.0}"
APP=/home/keylay/relay

[ -d "$APP/.git" ] || { echo "ERROR: $APP is not a git checkout" >&2; exit 1; }

cd "$APP"
echo "==> Fetching tags..."
git fetch --tags
echo "==> Checking out $TAG (this rewrites the served index.html on disk)..."
git checkout "$TAG"

# Restart ONLY when server.js or its deps changed this release. A client-only
# release (index.html only, e.g. v0.8.0) needs neither — the reverse proxy
# serves the new file from disk immediately. Uncomment if server.js changed:
#   npm install --omit=dev
#   pm2 restart keylay

# LEGACY / TO CONFIRM: earlier deploys also copied index.html into
# public_html/app/. The app is served from /home/keylay/relay, so this is only
# needed if something still serves that second copy. Confirm what the proxy
# serves; if nothing serves public_html/app/, delete this block. Until then it
# is left OFF so the two deploys stay in their own trees.
#   cp /home/keylay/relay/index.html /home/keylay/public_html/app/index.html

echo "==> App deploy complete. Verify from any machine:"
echo "    curl -s https://app.keylay.org/ | sha256sum   # must match the published hash for $TAG"
