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

## Releases and deploys

One pipeline, in `.github/workflows/release.yml`, in this order:

1. A push to `main` runs release-please, which keeps a standing **release PR**
   accumulating `CHANGELOG.md` entries and the `package.json` bump derived from
   the Conventional Commit types since the last release.
2. Merging that PR makes release-please tag the version and create the GitHub
   release.
3. That sets `release_created`, which gates the `deploy` job: build the client
   and deploy it to the live channel of the `iron-broth` Firebase Hosting site.

**A merge to `main` does not reach players — a release does.** Only code with a
version and a changelog entry ships, and the old double deploy is gone (every
merge used to deploy, then the release-PR merge deployed the identical bundle
again).

The deploy must be a job in that workflow, gated on `release_created`. A
separate workflow keyed on `release: published` never fires, because a release
created with `GITHUB_TOKEN` doesn't trigger other workflows.

Two consequences worth knowing:

- **A release only happens for releasable commit types.** `feat`, `fix`, `perf`,
  `content` and breaking changes bump the version; `docs`, `chore`, `ci`,
  `style`, `test`, `build` do not. So a client-affecting change committed as
  `chore:` will never ship — pick the type that matches the change.
- **There is no CI path to deploy without a release.** That's deliberate. For an
  urgent or off-cycle push, `scripts/deploy-client.sh` still builds and deploys
  from a developer machine.

Nothing is published to npm (`private: true`); the version's consumers are the
git tag, the release page, and the changelog.

While the version is below 1.0.0, a breaking change bumps the minor
(`0.1.0` → `0.2.0`) rather than going to 1.0.0, and `feat` bumps the minor too.

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

`firebase init hosting:github` also regenerates two hosting workflows — a
push-to-main deploy and a per-PR preview — neither of which builds first, even
though `firebase.json`'s public dir (`client/dist`) is a gitignored build
artifact. As generated they publish an empty directory over the live site.
**Delete both after any CLI re-run.**

## Known CI gap: release PRs

release-please computes the release correctly and pushes its
`release-please--branches--main--components--mmo` branch, then fails to open the
PR with *"GitHub Actions is not permitted to create or approve pull requests."*
That is a repo setting, not a workflow bug. Two ways to close it:

- Settings → Actions → General → Workflow permissions → allow GitHub Actions to
  create and approve pull requests. One click, but it also lets any workflow
  *approve* PRs, which loosens a review gate.
- Give the release job a fine-grained PAT (contents + pull-requests write) as
  `token:` instead of the default `GITHUB_TOKEN`. Keeps the approval gate intact
  at the cost of a credential to rotate.

**This now blocks deploys, not just releases.** Since the deploy job is gated on
a release being created, and a release is created by merging the release PR, an
unopenable release PR means nothing ships through CI at all. Until one of the
two fixes above is in place, cut a release by merging
`release-please--branches--main--components--mmo` by hand (or opening its PR
yourself) — or deploy out of band with `scripts/deploy-client.sh`.
