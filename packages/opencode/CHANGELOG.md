# Changelog

## [8.0.2-beta.0](https://github.com/ZaxbyHub/opencode-swarm/compare/opencode-v8.0.1-beta.0...opencode-v8.0.2-beta.0) (2026-11-02)


### Bug Fixes

* **packaging,plugin,ci:** close swarm-pr-review findings on [#3163](https://github.com/ZaxbyHub/opencode-swarm/issues/3163) ([e4823b3](https://github.com/ZaxbyHub/opencode-swarm/commit/e4823b31cacb3e749bcd8f9610701e3432d23d00))
* **packaging,plugin:** publishable internal deps + dual-shape plugin export ([f72b4fd](https://github.com/ZaxbyHub/opencode-swarm/commit/f72b4fd1d458b50959febc3b081723cc0d613860))
* **packaging,plugin:** publishable internal deps + dual-shape plugin export (8.x next line) ([38b9d18](https://github.com/ZaxbyHub/opencode-swarm/commit/38b9d18645c76995f3e15f42c36a64faf2b0ff75))
* **pkg-audit,v2,ci:** close feedback-round gates (cargo fail-closed, Node legs, delta registrations) ([d55a364](https://github.com/ZaxbyHub/opencode-swarm/commit/d55a364c7ee260b81fd657c30f391602e79d471c))
* **release,ci:** close implementation-review findings F-1..F-5 ([27c0cd6](https://github.com/ZaxbyHub/opencode-swarm/commit/27c0cd6c218858004bb276477164b3e9c704951f))
* **release,ci:** close swarm-pr-review findings PRR-001..PRR-020 on the 8.x release pipeline ([7090a37](https://github.com/ZaxbyHub/opencode-swarm/commit/7090a3768fb21726d3d48dd000cf377f44c95862))
* **release,ci:** complete the 8.x release pipeline (closes [#3229](https://github.com/ZaxbyHub/opencode-swarm/issues/3229), closes [#3228](https://github.com/ZaxbyHub/opencode-swarm/issues/3228); heals [#3150](https://github.com/ZaxbyHub/opencode-swarm/issues/3150)/[#3151](https://github.com/ZaxbyHub/opencode-swarm/issues/3151)) ([91de43b](https://github.com/ZaxbyHub/opencode-swarm/commit/91de43b0069414a07d099e7d2e65e9afe5b2c958))
* **release,ci:** harden the 8.x publish path, port the fragment pipeline, and bound the healing-release changelog (issues [#3150](https://github.com/ZaxbyHub/opencode-swarm/issues/3150) [#3151](https://github.com/ZaxbyHub/opencode-swarm/issues/3151) [#3229](https://github.com/ZaxbyHub/opencode-swarm/issues/3229) [#3228](https://github.com/ZaxbyHub/opencode-swarm/issues/3228)) ([edb1a7f](https://github.com/ZaxbyHub/opencode-swarm/commit/edb1a7f1e73eb49b4cad610bc64ab243af48bd56))
* **release:** close final-critic round-4 items FC-10..FC-13 ([d1ee3fd](https://github.com/ZaxbyHub/opencode-swarm/commit/d1ee3fd5e160a98835b1b61c791a16d5b4b2b6a6))
* **release:** close reviewer round-6 items Z-F1..F3 (guard ancestry, fail-open paths, DELETED entries) ([198192a](https://github.com/ZaxbyHub/opencode-swarm/commit/198192aa82aabb115a967a1e3554b72e50793cad))
* **release:** close swarm-pr-review findings on the release-enablement PR ([ed555e9](https://github.com/ZaxbyHub/opencode-swarm/commit/ed555e9d426ef4269cc4df90f190503eb5ac2a12))
* **release:** enable the 8.x next-line healing release ([#3150](https://github.com/ZaxbyHub/opencode-swarm/issues/3150)) ([0a32845](https://github.com/ZaxbyHub/opencode-swarm/commit/0a32845a2e5ef630acd12e4a624d75ced975676e))
* **release:** enable the 8.x next-line healing release (issue [#3150](https://github.com/ZaxbyHub/opencode-swarm/issues/3150)) ([62f58e5](https://github.com/ZaxbyHub/opencode-swarm/commit/62f58e5e292c13c857ffbd659f081a4c274bbe71))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencode-swarm/core bumped from 8.0.0-beta.0 to 8.0.2-beta.0

## [8.0.1-beta.0](https://github.com/zaxbysauce/opencode-swarm/compare/v8.0.0-beta.0...v8.0.1-beta.0) (2026-03-16)


### Bug Fixes

* add diagnostic startup logging to plugin for beta regression debugging ([906b50d](https://github.com/zaxbysauce/opencode-swarm/commit/906b50d8df9d94fa9bcc360b4e4e04afcb9a1bb4))

## [8.0.0-beta.0](https://github.com/zaxbysauce/opencode-swarm/compare/v7.0.0-beta.0...v8.0.0-beta.0) (2026-03-16)


### ⚠ BREAKING CHANGES

* v7.0 monorepo extraction checkpoint (pre-QA)

### Features

* v7.0 monorepo extraction checkpoint (pre-QA) ([b9ea99a](https://github.com/zaxbysauce/opencode-swarm/commit/b9ea99a8d72931ee42e252bb5093060680f89d62))


### Bug Fixes

* handle no-coder QA chains in hotfix A ([97b52ae](https://github.com/zaxbysauce/opencode-swarm/commit/97b52ae3ed81791f0b403f038ecb9cfda50b4934))
* PR [#196](https://github.com/zaxbysauce/opencode-swarm/issues/196) v7.0 plan conformance patch ([376b127](https://github.com/zaxbysauce/opencode-swarm/commit/376b127304dc38ae648ec55453fafc269557968c))
* update biome.json includes for monorepo + auto-fix lint issues ([6fdebce](https://github.com/zaxbysauce/opencode-swarm/commit/6fdebce18933c9e36d991e5b7e516e0ba33a917d))
