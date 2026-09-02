# Changelog

## [0.2.0](https://github.com/tracedelange/silicon-soup/compare/v0.1.0...v0.2.0) (2026-09-02)


### Features

* add overwrite/if_region/edge placement options to stamp and spawn types ([8a70b1f](https://github.com/tracedelange/silicon-soup/commit/8a70b1ffd6af4f9b8a6f18f9799cd5f78917d4b2))
* biome defaultPostOps/defaultSpawns, overwrite biome mode, stamp edge/if_region guards ([23b15cb](https://github.com/tracedelange/silicon-soup/commit/23b15cbaae31943325eb693dfb693c6eca60bf3b))
* mob schema validation, post-op repair pass, seed+size retry, portal stamp prompt rules ([0179d73](https://github.com/tracedelange/silicon-soup/commit/0179d7311fb113fb8b3b6590b777f85c682972bb))
* move XP table to shared constants and wire to client ([fb9509a](https://github.com/tracedelange/silicon-soup/commit/fb9509aceba67a3b241a659a3ffd508deec61bd7))


### Bug fixes

* death respawn, zone-scoped boardId, portal synthesis, if_region spawn guard ([71b5267](https://github.com/tracedelange/silicon-soup/commit/71b5267d5c36a13fb2e2662646efa863bd6211b9))
* Decouple deploying from releasing — merge to main ships ([2d4b322](https://github.com/tracedelange/silicon-soup/commit/2d4b3224be5a426be3f7d0a3b8f9ef017db14295))
* Deploy on release instead of on every push to main ([7ac6bb4](https://github.com/tracedelange/silicon-soup/commit/7ac6bb460051fb147c0da2faca1bcc7aa91a770c))
* Drop the PR preview channel workflow ([a19a005](https://github.com/tracedelange/silicon-soup/commit/a19a005bf312bb777ecdbffd779b6de6cdfd1169))
* Merge to main ships; versioning runs alongside it ([0c62101](https://github.com/tracedelange/silicon-soup/commit/0c621019e9d761a1f6f808844c41b540c15deabf))
* Repair the Firebase deploy after firebase init hosting:github ([2df505c](https://github.com/tracedelange/silicon-soup/commit/2df505caca0cf0740d073103f11a602b87221c78))
* Repair the Firebase deploy after firebase init hosting:github ([02823e2](https://github.com/tracedelange/silicon-soup/commit/02823e2fd379fc4ab3a20b6946146bcc63120f50))
* sewer grate finds open ground (random_free) instead of overwriting market center ([c415366](https://github.com/tracedelange/silicon-soup/commit/c415366853bbf27b480067d1e810ae64f5dbdf38))
* shuffle random_free candidates using seeded RNG instead of scan order ([a6a1c5c](https://github.com/tracedelange/silicon-soup/commit/a6a1c5c3c262fb2a0e5cd9bca0ad5c7474e3c23e))
* use bb.subRng (not bb.rng) for random_free shuffle ([865c98c](https://github.com/tracedelange/silicon-soup/commit/865c98cf04bf88be854330052aaa7350c07a5fd2))


### World content

* elemental weapon brands and resistance affixes ([1d7a8ed](https://github.com/tracedelange/silicon-soup/commit/1d7a8ed43e94ee42840e83d7891d925dc4389f84))
* new mob abilities + ability design docs ([0dc1448](https://github.com/tracedelange/silicon-soup/commit/0dc1448753590f0074cc666728be36ee1926e6de))
* new mobs across the role taxonomy + sprites ([9196668](https://github.com/tracedelange/silicon-soup/commit/919666858125b08fd229f7a415099ff088f1c259))
