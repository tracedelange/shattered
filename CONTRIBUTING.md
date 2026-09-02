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

## Merging

**Squash merge only** — merge commits and rebase merges are disabled on the
repo. release-please assumes a linear history: a merge commit carries the
conventional subject in its *body* while the branch commit carries it as its
*subject*, so it parses both and every change lands in the changelog twice
(googleapis/release-please#2476).

The consequence is that **the PR title becomes the commit subject on `main`**,
so the PR title is what has to be a valid Conventional Commit — the commit-msg
hook governs your local commits, not what the squash produces. Titles are not
linted; that one is on you.

Repo settings pair with this: squash title from `PR_TITLE`, squash body from
`COMMIT_MESSAGES`, so a detailed commit body written on the branch survives into
`main` rather than being replaced by the PR description.

## Deploys

**Merge to `main` is live.** `.github/workflows/deploy.yml` builds the client and
deploys it to the live channel of the `iron-broth` Firebase Hosting site on every
push to `main`, and on demand from the Actions tab. Versioning is not a gate —
see below. `scripts/deploy-client.sh` does the same two steps from a developer
machine for an off-cycle push.

The one push it skips is release-please's own `chore(main): release X.Y.Z`
commit, which changes only the changelog, version and manifest — the built
bundle is byte-identical to what is already live, since vite doesn't embed the
version. That's a commit-subject match rather than a paths filter on purpose: a
paths filter over `package.json` would also swallow dependency bumps, which do
need shipping.

`VITE_SERVER_URL` is baked into the bundle at **build** time, so pointing the
client at a different game server means a redeploy, not a config change. CI
reads it from an optional repo variable of the same name and otherwise uses the
URL `scripts/deploy-client.sh` hardcodes:

```bash
gh variable set VITE_SERVER_URL --body https://soup.graphon.io
```

Auth is the `FIREBASE_SERVICE_ACCOUNT_IRON_BROTH` secret, created by
`firebase init hosting:github` along with the service account behind it. The
name is the CLI's convention (`FIREBASE_SERVICE_ACCOUNT_<PROJECT>`).

`firebase init hosting:github` also regenerates two hosting workflows of its own
— a push-to-main deploy and a per-PR preview — neither of which builds first,
even though `firebase.json`'s public dir (`client/dist`) is a gitignored build
artifact. As generated they publish an empty directory over the live site.
**Delete both after any CLI re-run;** `deploy.yml` is the one that should exist.

## Versioning and changelog

`.github/workflows/release.yml` runs release-please on every push to `main`,
**decoupled from deploying**. It maintains one standing release PR that
accumulates `CHANGELOG.md` entries and the `package.json` bump derived from the
Conventional Commit types since the last release. Merge that PR whenever you
want to stamp a version: it tags `v<version>` and creates the GitHub release.

It's one long-lived PR, not one per merge, and it doesn't recurse — the release
PR's own commit is `chore(main): release X.Y.Z`, and `chore` isn't a releasable
type, so the next run finds nothing to release and opens nothing.

Only `feat`, `fix`, `perf`, `content` and breaking changes move the version;
`docs`, `chore`, `ci`, `style`, `test` and `build` don't. That affects the
version and the notes only — every merge deploys regardless.

Nothing is published to npm (`private: true`); the version's consumers are the
git tag, the release page, and the changelog. While the version is below 1.0.0,
a breaking change bumps the minor (`0.1.0` → `0.2.0`), and `feat` bumps the
minor too.

## Known CI gap: release PRs

release-please computes the release correctly and pushes its
`release-please--branches--main--components--mmo` branch, then fails to open the
PR with *"GitHub Actions is not permitted to create or approve pull requests."*
That is a repo setting, not a workflow bug. The workflow reads
`token: ${{ secrets.RELEASE_PLEASE_TOKEN || github.token }}`, so either fix
works with no further edit:

- **A PAT.** Mint a fine-grained token with contents + pull-requests write on
  this repo, then `gh secret set RELEASE_PLEASE_TOKEN`. Keeps the approval gate
  intact; costs a credential to rotate.
- **The repo toggle.** Settings → Actions → General → Workflow permissions →
  allow GitHub Actions to create and approve pull requests, and leave the secret
  unset so the `github.token` fallback applies. One click, but it also lets any
  workflow *approve* PRs, which loosens the review gate.

This blocks versioning only — deploys are independent, so code still ships on
merge while this is outstanding. Until one of the two fixes above is in place,
stamp a version by merging
`release-please--branches--main--components--mmo` by hand, or opening its PR
yourself.
