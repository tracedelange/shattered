# Contributing

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/), enforced locally
by a `commit-msg` hook (husky + commitlint). `npm install` installs the hook via
the `prepare` script; there is no CI check yet, so the hook is bypassable
(`--no-verify`, or a stale `node_modules`) — see below.

```
<type>(<optional scope>): <subject>
```

Types: `feat`, `fix`, `perf`, `refactor`, `content`, `docs`, `style`, `test`,
`build`, `ci`, `chore`, `revert`.

`content` is the one non-standard type, and it carries most of this repo's
history: world data (zones, mobs, abilities, quests, prefabs, tilesets) is
neither a feature nor a chore. Generation-pipeline *code* is `feat`/`fix`; the
YAML/JSON it emits is `content`.

Subject case is deliberately unenforced — `feat: Mob leash and reset` is fine.
A breaking change is a `!` after the type (`feat!:`) or a `BREAKING CHANGE:`
footer.

```bash
echo "feat(ai): Mob leash and reset" | npx commitlint   # check a message by hand
```

## Releases

`.github/workflows/release.yml` runs release-please on every push to `main`. It
keeps a standing release PR that accumulates `CHANGELOG.md` entries and the
`package.json` bump derived from the commit types since the last release;
merging that PR tags and cuts the GitHub release. Nothing is published to npm
(`private: true`).

While the version is below 1.0.0, a breaking change bumps the minor
(`0.1.0` → `0.2.0`) rather than going to 1.0.0, and `feat` bumps the minor too.

Releasing and deploying are separate: the release workflow only versions and
tags. See below for the deploy.

## Deploying the client

`.github/workflows/deploy.yml` builds `client/dist` and deploys it to Firebase
Hosting (project and site `iron-broth`) on every push to `main` — including
release-PR merges, since those are pushes to `main` — and on demand from the
Actions tab. `scripts/deploy-client.sh` still works and does the same two steps
from a developer machine.

`VITE_SERVER_URL` is baked into the bundle at **build** time, so pointing the
client at a different game server means a redeploy, not a config change. CI
reads it from the optional repo variable of the same name and otherwise uses the
URL `scripts/deploy-client.sh` hardcodes:

```bash
gh variable set VITE_SERVER_URL --body https://soup.graphon.io
```

### One-time credential setup

The deploy needs a `FIREBASE_SERVICE_ACCOUNT` secret holding a service account's
full JSON key. The easy path provisions the account, grants it the roles the
deploy action needs, and sets the secret for you:

```bash
firebase init hosting:github    # answer no to overwriting workflow files
```

Manually instead, from an account with owner on the project:

```bash
gcloud iam service-accounts create github-deploy --project iron-broth
gcloud projects add-iam-policy-binding iron-broth \
  --member serviceAccount:github-deploy@iron-broth.iam.gserviceaccount.com \
  --role roles/firebasehosting.admin
gcloud iam service-accounts keys create ./gh-deploy.json \
  --iam-account github-deploy@iron-broth.iam.gserviceaccount.com
gh secret set FIREBASE_SERVICE_ACCOUNT < ./gh-deploy.json
rm ./gh-deploy.json      # the secret is the only copy that should survive
```

If the deploy then fails reading the project's web config, the action's README
also asks for the API Keys Viewer role (`roles/serviceusage.apiKeysViewer`) —
`firebase init hosting:github` grants whatever the current action needs, which
is why it's the recommended path.
