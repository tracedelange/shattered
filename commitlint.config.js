// Conventional Commits, enforced locally via the .husky/commit-msg hook.
// The machine-readable `type:` prefix is what release-please reads to derive
// version bumps and changelog sections (.github/workflows/release.yml), so the
// type list here and the changelog-sections list in release-please-config.json
// must stay in sync.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // The default list plus `content` — world data (zones, mobs, abilities,
    // quests, prefabs, tilesets) is the bulk of this repo's history and is
    // neither a feature nor a chore. Generation-pipeline *code* is feat/fix;
    // the YAML/JSON it produces is content.
    'type-enum': [2, 'always', [
      'feat', 'fix', 'perf', 'refactor', 'content', 'docs', 'style',
      'test', 'build', 'ci', 'chore', 'revert',
    ]],
    // Off deliberately: this history capitalizes subjects ("Boss: The Cradle
    // Lich in a cellar under the starter village") and the spec doesn't care.
    // The type prefix is the part automation needs; case is style.
    'subject-case': [0],
  },
};
