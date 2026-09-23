#!/usr/bin/env bash
# deploy-website.sh — publish the keylay.org website.
# Run on the server as the keylay user:
#     sudo -u keylay bash deploy-website.sh
#
# ── Deploy topology (authoritative — do not guess) ──────────────────────────
#   App (relay + served index.html):  /home/keylay/relay          ← deployed by
#                                       release-deploy.sh, NOT here.
#   Website repo:                      /home/keylay/keylay-website (github KeylayBTC/website.git)
#   Web root:                          /home/keylay/public_html
#
# The website and the app own SEPARATE trees. This script mirrors the website
# repo into the web root with `rsync --delete`, so it MUST NOT touch /app/ —
# hence `--exclude /app/`. It shows a dry-run and asks before deleting anything,
# so a mistake can't silently remove files.
# ────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SRC=/home/keylay/keylay-website
WEBROOT=/home/keylay/public_html

# -a archive, --delete mirror, exclude git plumbing and the app tree.
RSYNC_OPTS=(-a --delete --exclude '.git' --exclude '.gitignore' --exclude '/app/')

[ -d "$SRC/.git" ] || { echo "ERROR: $SRC is not a git checkout" >&2; exit 1; }
[ -d "$WEBROOT" ]   || { echo "ERROR: web root $WEBROOT does not exist" >&2; exit 1; }

cd "$SRC"
echo "==> Pulling latest website from git..."
git pull --ff-only

echo
echo "==> DRY RUN — what would change in $WEBROOT (nothing is written yet):"
rsync "${RSYNC_OPTS[@]}" --dry-run --itemize-changes "$SRC"/ "$WEBROOT"/

echo
echo "Lines above beginning with 'deleting' are files that would be REMOVED."
echo "There must be NOTHING under app/. If anything else there matters, stop."
read -r -p "Proceed with the real sync? [y/N] " reply
case "$reply" in
  [yY]|[yY][eE][sS]) ;;
  *) echo "Aborted — nothing was written."; exit 1 ;;
esac

echo "==> Syncing for real..."
rsync "${RSYNC_OPTS[@]}" "$SRC"/ "$WEBROOT"/
echo "==> Website deploy complete."

echo
echo "==> Verify from any machine:"
echo "    curl -s https://keylay.org/security.html | grep -c 'Open items'       # expect 1"
echo "    curl -s https://keylay.org/security.html | grep -c 'No open issues'   # expect 0"
echo "    curl -s https://app.keylay.org/ | sha256sum                           # app must be UNCHANGED"
