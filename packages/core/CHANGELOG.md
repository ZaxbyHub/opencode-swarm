# Changelog

## [9.0.0-beta.0](https://github.com/ZaxbyHub/opencode-swarm/compare/v8.0.0-beta.0...v9.0.0-beta.0) (2026-10-09)


### ⚠ BREAKING CHANGES

* package restructured into @opencode-swarm/* scoped packages
* v7.0 monorepo extraction checkpoint (pre-QA)

### Features

* extract core into monorepo, add Claude Code adapter, add telemetry package ([98b0201](https://github.com/ZaxbyHub/opencode-swarm/commit/98b020168298679467bce6d5d20ce1fbdf62c06b))
* v7.0 monorepo extraction checkpoint (pre-QA) ([b9ea99a](https://github.com/ZaxbyHub/opencode-swarm/commit/b9ea99a8d72931ee42e252bb5093060680f89d62))


### Bug Fixes

* handle no-coder QA chains in hotfix A ([97b52ae](https://github.com/ZaxbyHub/opencode-swarm/commit/97b52ae3ed81791f0b403f038ecb9cfda50b4934))
* normalize namespaced evidence guard tools ([2f826d0](https://github.com/ZaxbyHub/opencode-swarm/commit/2f826d0f634b3f605d1bb82375afecac43664b34))
* **packaging,plugin,ci:** close swarm-pr-review findings on [#3163](https://github.com/ZaxbyHub/opencode-swarm/issues/3163) ([e4823b3](https://github.com/ZaxbyHub/opencode-swarm/commit/e4823b31cacb3e749bcd8f9610701e3432d23d00))
* **packaging,plugin:** publishable internal deps + dual-shape plugin export ([f72b4fd](https://github.com/ZaxbyHub/opencode-swarm/commit/f72b4fd1d458b50959febc3b081723cc0d613860))
* **packaging,plugin:** publishable internal deps + dual-shape plugin export (8.x next line) ([38b9d18](https://github.com/ZaxbyHub/opencode-swarm/commit/38b9d18645c76995f3e15f42c36a64faf2b0ff75))
* **pkg-audit,v2,ci:** close feedback-round gates (cargo fail-closed, Node legs, delta registrations) ([d55a364](https://github.com/ZaxbyHub/opencode-swarm/commit/d55a364c7ee260b81fd657c30f391602e79d471c))
* **pkg-audit:** deterministic fail-closed regression suite via _internals DI seam ([d29c9bb](https://github.com/ZaxbyHub/opencode-swarm/commit/d29c9bb5a853fc3e2f7f5446526446a19198f362))
* PR [#196](https://github.com/ZaxbyHub/opencode-swarm/issues/196) v7.0 plan conformance patch ([376b127](https://github.com/ZaxbyHub/opencode-swarm/commit/376b127304dc38ae648ec55453fafc269557968c))
* resolve claude-code npm distribution issues ([288ac87](https://github.com/ZaxbyHub/opencode-swarm/commit/288ac874b753ff4ca0cc149d5b9775a495597f14))
* update biome.json includes for monorepo + auto-fix lint issues ([6fdebce](https://github.com/ZaxbyHub/opencode-swarm/commit/6fdebce18933c9e36d991e5b7e516e0ba33a917d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencode-swarm/telemetry bumped from 8.0.0-beta.0 to 9.0.0-beta.0

## [8.0.0-beta.0](https://github.com/zaxbysauce/opencode-swarm/compare/v7.0.0-beta.0...v8.0.0-beta.0) (2026-03-16)


### ⚠ BREAKING CHANGES

* package restructured into @opencode-swarm/* scoped packages
* v7.0 monorepo extraction checkpoint (pre-QA)

### Features

* extract core into monorepo, add Claude Code adapter, add telemetry package ([98b0201](https://github.com/zaxbysauce/opencode-swarm/commit/98b020168298679467bce6d5d20ce1fbdf62c06b))
* v7.0 monorepo extraction checkpoint (pre-QA) ([b9ea99a](https://github.com/zaxbysauce/opencode-swarm/commit/b9ea99a8d72931ee42e252bb5093060680f89d62))


### Bug Fixes

* handle no-coder QA chains in hotfix A ([97b52ae](https://github.com/zaxbysauce/opencode-swarm/commit/97b52ae3ed81791f0b403f038ecb9cfda50b4934))
* normalize namespaced evidence guard tools ([2f826d0](https://github.com/zaxbysauce/opencode-swarm/commit/2f826d0f634b3f605d1bb82375afecac43664b34))
* PR [#196](https://github.com/zaxbysauce/opencode-swarm/issues/196) v7.0 plan conformance patch ([376b127](https://github.com/zaxbysauce/opencode-swarm/commit/376b127304dc38ae648ec55453fafc269557968c))
* resolve claude-code npm distribution issues ([288ac87](https://github.com/zaxbysauce/opencode-swarm/commit/288ac874b753ff4ca0cc149d5b9775a495597f14))
* update biome.json includes for monorepo + auto-fix lint issues ([6fdebce](https://github.com/zaxbysauce/opencode-swarm/commit/6fdebce18933c9e36d991e5b7e516e0ba33a917d))
