# Releasing Keylay

The release process exists to make one guarantee checkable by strangers: **the code running at `app.keylay.org` is byte-identical to a tagged, hash-published commit in this repo.** Everything below serves that guarantee.

## Quick checklist (the whole release in one place)

Do these in order. Each step is expanded in the sections below; this list exists so you don't have to hold the details in your head between releases.

1. **Changelog.** Add a `## [X.Y.Z] — Unreleased` entry to `CHANGELOG.md` covering everything shipping. Fastest path: ask Claude to draft it from the diff since the last tag (`git diff v<last-tag> HEAD`), then review and tighten. A script can't do this well — it can list changed files but not judge which changes matter or why — but a model reading the diff produces a solid first draft, turning this from a blank page into a review.
2. **Test.** Main workflow on two real devices, 3× including one reconnect; run the `tests/` suite if set up.
3. **Tag it** — bumps versions, stamps the changelog, commits, signs the tag, writes the hash row into `website/verify.html`:
   ```bash
   tools/release.sh X.Y.Z
   ```
   When it finishes it PRINTS the `SHA-256 index.html` and a ready-to-post **Nostr/X note** with the values filled in. Copy both — you need them in steps 6 and 8.
4. **Push:**
   ```bash
   git push origin main --follow-tags
   ```
5. **Deploy** (tag-checkout on the server — `git pull` will NOT work there, see the Deploy section):
   ```bash
   ssh <server>
   sudo -u keylay git -C /home/keylay/relay fetch --tags
   sudo -u keylay git -C /home/keylay/relay checkout vX.Y.Z
   sudo systemctl restart keylay        # ONLY if server.js changed this release
   ```
6. **Verify live == release:**
   ```bash
   curl -s https://app.keylay.org/ | sha256sum   # must equal the SHA-256 index.html from step 3
   ```
7. **Upload the site:** `website/verify.html` (plus any other changed pages) to keylay.org.
8. **Publish the hash out-of-band** — post the Nostr/X note from step 3 (release.sh printed it filled in) from the Keylay npub. This is the step that makes the release independently verifiable; do not skip it.
9. **Reconcile the security page** if this release fixed or opened any findings (see the website reconciliation doc).

## Why hashes are published, and where

The relay never sees plaintext, so the remaining trust surface is code delivery: GitHub (the repo and the account controlling it) and the app server. A hash published only on GitHub is circular — whoever can tamper with a release can tamper with the hash next to it. So each release's fingerprint is published on channels with different failure modes:

1. **The git tag itself** — the tag message embeds the SHA-256 of `index.html` and `server.js`. If the tag is GPG-signed, the hashes are signed.
2. **keylay.org/verify.html** — different hosting and credentials than GitHub.
3. **Nostr** — a note from the Keylay npub. This is the strongest channel: it is signed by a key only you hold, replicated across relays you don't control, and independent of both GitHub and your web host.
4. **X** — weakest (platform-controlled), but adds one more place an attacker must simultaneously falsify.

An attacker must now compromise all channels at once, or serve a targeted per-load swap — which is exactly what the README tells high-threat users to defeat by running a verified local copy.

## One-time setup (recommended): tag signing

```bash
gpg --full-generate-key                      # RSA 4096 or Ed25519, contact@keylay.org
gpg --list-secret-keys --keyid-format=long   # note the key ID after rsa4096/ or ed25519/
git config --global user.signingkey <KEYID>
gpg --armor --export <KEYID> > keylay-signing-key.asc   # upload to keylay.org
```

Publish the key's fingerprint (`gpg --fingerprint <KEYID>`) on verify.html and in a Nostr note. Once the key exists, `tools/release.sh` signs tags automatically; until then it creates annotated (unsigned) tags and says so.

## Per-release process

**Before running the script:**

1. All changes for the release are in the working tree, tested end-to-end (two browsers, real relay round-trip; run the Playwright tests).
2. `CHANGELOG.md` has a `## [X.Y.Z] — Unreleased` entry covering everything shipping.
3. `PLANNED_FEATURES.md` (the repo copy) is the **public plan** — written for readers. The project-root copy is private working notes and never ships; move ideas from notes to plan by rewriting them in public register, not by copying.
4. Cross-check the public roadmap trio once per release: `PLANNED_FEATURES.md` ↔ README Roadmap ↔ keylay.org status section. These have drifted before; reviewers diff them.

**Run it:**

```bash
tools/release.sh 0.7.1
```

The script bumps versions (package.json, index.html footer, console banner), stamps the changelog date, shows you `git status` and asks before committing, commits everything, tags (signed if configured, hashes embedded in the tag message), and inserts the release row into `../website/verify.html`.

**After the script:**

```bash
git push origin main --follow-tags
```

Deploy. On the server, the static `index.html` is served from **`/home/keylay/relay`**, and this box deploys by checking out the release **tag** — it runs in detached-HEAD / tag-deploy mode, so **`git pull` will fail there** ("You are not currently on a branch"). Fetch the new tag and check it out:

```bash
ssh <server>
sudo -u keylay git -C /home/keylay/relay fetch --tags
sudo -u keylay git -C /home/keylay/relay checkout v<version>   # e.g. v0.8.0 — this is what rewrites index.html on disk
```

The static file is served by the reverse proxy reading from disk, so the checkout alone publishes the new `index.html` — no restart needed for a client-only release. Restart the relay **only when `server.js` changed** this release (restarting drops any live sessions):

```bash
sudo systemctl restart keylay && systemctl status keylay   # only if server.js changed
```

Verify the live app is the release, from any machine:

```bash
curl -s https://app.keylay.org/ | sha256sum
# must equal the published SHA-256 of index.html — if it doesn't, STOP:
# either the deploy didn't land or something in the path is rewriting HTML
```

> A hash mismatch with a correct deploy means a proxy/CDN is transforming the HTML (minification, script injection, email obfuscation). Those features must stay off for app.keylay.org — the whole verification story depends on byte-identical serving.

Upload `website/verify.html` (and any other changed site pages) to keylay.org.

**Publish the fingerprint out-of-band.** This is not optional — it is the channel independent of both GitHub and the web host, so it is what actually lets a stranger detect a swapped release. `tools/release.sh` prints this note with the version, commit, and hash already filled in; copy it straight from the terminal. Post it to Nostr (from the Keylay npub) and to X:

> Keylay v<version> released.
> commit `<full commit hash>`
> SHA-256 index.html: `<hash>`
> Verify: https://keylay.org/verify.html — instructions included. Run it locally, trust no host.

The Nostr note is the one that matters; link it from verify.html afterward so site visitors can hop to the independently-signed copy. Post it **after** the live hash check in step 6 passes, so the hash you broadcast is provably what is being served.

## What a user verifies, end to end

```bash
git clone https://github.com/keylaybtc/keylay && cd keylay
git checkout v0.7.1
git tag -v v0.7.1                      # if signed: checks GPG signature + shows embedded hashes
sha256sum index.html                   # equals the hash on verify.html and the Nostr note
curl -s https://app.keylay.org/ | sha256sum   # equals the same — hosted app is the tagged code
```

Any mismatch anywhere in that chain is a red flag, and that's the point.
