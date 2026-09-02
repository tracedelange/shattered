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

The release is **release-only** — it does not deploy. The Firebase client deploy
is still `scripts/deploy-client.sh` from a developer machine; wiring it to
releases needs a credential secret in CI and a job in that same workflow gated
on `release_created` (a release created with `GITHUB_TOKEN` doesn't trigger a
separate `release: published` workflow).
