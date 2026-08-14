#!/usr/bin/env bash
#
# Keylay release script
#
# Usage:  tools/release.sh <version>          e.g.  tools/release.sh 0.7.1
#
# Run from anywhere inside the app repo. Works in Git Bash on Windows,
# Linux, and macOS. Requires: git, sed, sha256sum, awk.
#
# What it does, in order:
#   1. Preflight: inside repo, CHANGELOG has a "## [<version>]" entry,
#      PLANNED_FEATURES.md matches the project-root mirror (aborts if diverged).
#   2. Bumps the version in package.json, the index.html footer, and the
#      index.html console banner.
#   3. Stamps the CHANGELOG entry: "— Unreleased" becomes "— <today>".
#   4. Shows you the full diff summary and asks for confirmation.
#   5. Commits everything and creates a tag: GPG-SIGNED if git has a
#      signing key configured (git config user.signingkey), annotated
#      otherwise. The tag message embeds the SHA-256 of index.html and
#      server.js, so a signed tag also signs the release hashes.
#   6. Inserts a release row (version, date, commit, hashes) into
#      ../website/verify.html at the RELEASES:INSERT marker.
#   7. Prints the fingerprints and the remaining manual steps.
#
# It does NOT push, deploy, or upload the website. See RELEASING.md.

set -euo pipefail

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

VER="${1:-}"
[ -n "$VER" ] || die "usage: tools/release.sh <version>   e.g. tools/release.sh 0.7.1"
printf '%s' "$VER" | grep -Eq '^[0-9]+\.[0-9]+(\.[0-9]+)?$' \
  || die "version must look like 0.7.1 (no leading 'v')"

TAG="v$VER"
DATE="$(date +%Y-%m-%d)"

# --- Locate directories (script lives in <app>/tools/) -----------------------
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJ_DIR="$(cd "$APP_DIR/.." && pwd)"
WEBSITE_DIR="$PROJ_DIR/website"
cd "$APP_DIR"

# --- Preflight ---------------------------------------------------------------
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not inside a git repo"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || printf 'WARNING: releasing from branch "%s", not main\n' "$BRANCH"

git rev-parse "$TAG" >/dev/null 2>&1 && die "tag $TAG already exists"

grep -q "^## \[$VER\]" CHANGELOG.md \
  || die "CHANGELOG.md has no \"## [$VER]\" entry — write the changelog first"

# Roadmap-consistency reminder. The repo's PLANNED_FEATURES.md is the public
# plan; the project-root copy is private working notes and never ships. The
# three PUBLIC surfaces — repo plan, README Roadmap, keylay.org status section —
# are what reviewers diff against each other.
printf 'REMINDER: cross-check the public roadmap trio before tagging:\n'
printf '  PLANNED_FEATURES.md <-> README.md Roadmap <-> keylay.org status section\n\n'

# --- Version bumps -----------------------------------------------------------
# package.json  ("version": "x.y.z")
sed -i -E "s/(\"version\"[[:space:]]*:[[:space:]]*\")[0-9]+(\.[0-9]+)*(\")/\1$VER\3/" package.json
grep -q "\"version\": \"$VER\"" package.json || die "package.json version bump failed"

# index.html footer ("vX.Y ·") and console banner ("Keylay vX.Y").
# Patterns require a dot in the version so strings like "Keylay v1" (protocol
# target in comments) are never touched.
sed -i -E "s/v[0-9]+(\.[0-9]+)+ ·/v$VER ·/" index.html
sed -i -E "/Keylay v[0-9]+\.[0-9]+/ s/Keylay v[0-9]+(\.[0-9]+)+/Keylay v$VER/g" index.html
grep -q "v$VER ·" index.html || die "index.html footer version bump failed"

# CHANGELOG: stamp the release date on this version only.
# (Matches the whole heading line to sidestep the em-dash byte sequence;
# only lines still marked Unreleased are rewritten.)
if grep -q "^## \[$VER\].*Unreleased" CHANGELOG.md; then
  sed -i -E "s/^## \[$VER\].*Unreleased.*/## [$VER] \xe2\x80\x94 $DATE/" CHANGELOG.md
  grep -q "^## \[$VER\]" CHANGELOG.md || die "CHANGELOG date stamp failed"
else
  printf 'NOTE: CHANGELOG entry for %s was not marked "Unreleased"; date not stamped.\n' "$VER"
fi

# --- Confirm -----------------------------------------------------------------
printf '\nAbout to commit ALL of the following as release %s:\n\n' "$TAG"
git status --short
printf '\n'
read -r -p "Proceed with commit + tag $TAG? [y/N] " REPLY
case "$REPLY" in [yY]*) ;; *) die "aborted — working tree left as-is (version bumps applied, not committed)";; esac

# --- Commit ------------------------------------------------------------------
git add -A
git commit -m "Release $TAG"
COMMIT="$(git rev-parse HEAD)"

# --- Hashes (of the exact committed files) -----------------------------------
H_INDEX="$(sha256sum index.html | awk '{print $1}')"
H_SERVER="$(sha256sum server.js  | awk '{print $1}')"

# --- Tag (signed if a signing key is configured) -----------------------------
TAG_MSG="Keylay $TAG ($DATE)
commit: $COMMIT
SHA-256 index.html: $H_INDEX
SHA-256 server.js:  $H_SERVER"

if [ -n "$(git config user.signingkey || true)" ]; then
  git tag -s "$TAG" -m "$TAG_MSG"
  TAG_KIND="GPG-signed"
else
  git tag -a "$TAG" -m "$TAG_MSG"
  TAG_KIND="annotated (NOT signed — configure git config user.signingkey to sign)"
fi

# --- Update website verify page ----------------------------------------------
VERIFY="$WEBSITE_DIR/verify.html"
if [ -f "$VERIFY" ]; then
  # Drop the "no releases yet" placeholder row, if still present
  sed -i '/id="no-releases"/d' "$VERIFY"
  ROW="          <tr>\\
            <td>$TAG</td>\\
            <td>$DATE</td>\\
            <td class=\"mono\">${COMMIT}</td>\\
            <td class=\"mono hash\">$H_INDEX</td>\\
            <td class=\"mono hash\">$H_SERVER</td>\\
          </tr>"
  sed -i "/<!-- RELEASES:INSERT -->/a\\
$ROW" "$VERIFY"
  VERIFY_STATUS="row added to website/verify.html — upload it to keylay.org"
else
  VERIFY_STATUS="website/verify.html not found — record the hashes manually"
fi

# --- Summary -----------------------------------------------------------------
printf '\n================ RELEASE %s ================\n' "$TAG"
printf 'commit:              %s\n' "$COMMIT"
printf 'tag:                 %s (%s)\n' "$TAG" "$TAG_KIND"
printf 'SHA-256 index.html:  %s\n' "$H_INDEX"
printf 'SHA-256 server.js:   %s\n' "$H_SERVER"
printf 'verify page:         %s\n' "$VERIFY_STATUS"
printf '\nNext steps (see RELEASING.md):\n'
printf '  1. git push origin %s --follow-tags\n' "$BRANCH"
printf '  2. Deploy (tag-checkout — "git pull" fails on the server, it is detached-HEAD):\n'
printf '       ssh <server>\n'
printf '       sudo -u keylay git -C /home/keylay/relay fetch --tags\n'
printf '       sudo -u keylay git -C /home/keylay/relay checkout %s\n' "$TAG"
printf '       sudo systemctl restart keylay      # ONLY if server.js changed this release\n'
printf '  3. Verify the live app serves the exact release:\n'
printf '       curl -s https://app.keylay.org/ | sha256sum   # must print %s\n' "$H_INDEX"
printf '  4. Upload website/verify.html (and any changed pages) to keylay.org\n'
printf '  5. Publish the note below to Nostr (Keylay npub) and X — do this AFTER step 3 passes.\n'
printf '\n---------------- copy/paste: Nostr + X release note ----------------\n'
printf 'Keylay %s released.\n' "$TAG"
printf 'commit %s\n' "$COMMIT"
printf 'SHA-256 index.html: %s\n' "$H_INDEX"
printf 'Verify: https://keylay.org/verify.html — instructions included. Run it locally, trust no host.\n'
printf -- '--------------------------------------------------------------------\n'
