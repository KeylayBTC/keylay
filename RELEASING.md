# Releasing Keylay

The release process exists to make one guarantee checkable by strangers: **the code running at `app.keylay.org` is byte-identical to a tagged, hash-published commit in this repo.** Everything below serves that guarantee.

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

Deploy the relay/app (serves both `index.html` and the websocket):

```bash
ssh <server>
cd /var/keylay && git pull
sudo systemctl restart keylay && systemctl status keylay
```

Verify the live app is the release, from any machine:

```bash
curl -s https://app.keylay.org/ | sha256sum
# must equal the published SHA-256 of index.html — if it doesn't, STOP:
# either the deploy didn't land or something in the path is rewriting HTML
```

> A hash mismatch with a correct deploy means a proxy/CDN is transforming the HTML (minification, script injection, email obfuscation). Those features must stay off for app.keylay.org — the whole verification story depends on byte-identical serving.

Upload `website/verify.html` (and any other changed site pages) to keylay.org.

**Publish the fingerprint out-of-band.** Post to Nostr and X, e.g.:

> Keylay v0.7.1 released.
> commit `<full commit hash>`
> SHA-256 index.html: `<hash>`
> Verify: https://keylay.org/verify.html — instructions included. Run it locally, trust no host.

The Nostr note is the one that matters; link it from verify.html afterward so site visitors can hop to the independently-signed copy.

## What a user verifies, end to end

```bash
git clone https://github.com/keylaybtc/keylay && cd keylay
git checkout v0.7.1
git tag -v v0.7.1                      # if signed: checks GPG signature + shows embedded hashes
sha256sum index.html                   # equals the hash on verify.html and the Nostr note
curl -s https://app.keylay.org/ | sha256sum   # equals the same — hosted app is the tagged code
```

Any mismatch anywhere in that chain is a red flag, and that's the point.
