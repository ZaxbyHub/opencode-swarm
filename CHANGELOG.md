# Changelog

## [7.17.0](https://github.com/zaxbysauce/opencode-swarm/compare/v7.16.0...v7.17.0) (2026-05-11)


### Features

* **lang:** language-agnostic plugin via LanguageBackend dispatch ([#825](https://github.com/zaxbysauce/opencode-swarm/issues/825)) ([95c8861](https://github.com/zaxbysauce/opencode-swarm/commit/95c886143a14184c7b9d6980cc0f0edb40b52f84))

## [7.16.0](https://github.com/zaxbysauce/opencode-swarm/compare/v7.15.0...v7.16.0) (2026-05-11)


### Features

* **close:** add skill review on finalize ([#821](https://github.com/zaxbysauce/opencode-swarm/issues/821)) ([1aa0eba](https://github.com/zaxbysauce/opencode-swarm/commit/1aa0eba71d77e930f30d58a319250527e4947939))

## [7.15.0](https://github.com/zaxbysauce/opencode-swarm/compare/v7.14.0...v7.15.0) (2026-05-11)


### Features

* **turbo:** add Lean Turbo parallel lane execution strategy ([#820](https://github.com/zaxbysauce/opencode-swarm/issues/820)) ([#820](https://github.com/zaxbysauce/opencode-swarm/issues/820)) ([ecdafc0](https://github.com/zaxbysauce/opencode-swarm/commit/ecdafc0a8e64cc56b898d0d7a80131ed7fda28b5))

## [7.14.0](https://github.com/zaxbysauce/opencode-swarm/compare/v7.13.2...v7.14.0) (2026-05-10)


### Features

* **commands:** add /swarm deep-dive read-only audit command ([#816](https://github.com/zaxbysauce/opencode-swarm/issues/816)) ([2d37304](https://github.com/zaxbysauce/opencode-swarm/commit/2d373044317e45f6eee0b9b94203281027d89048))

## [7.13.2](https://github.com/zaxbysauce/opencode-swarm/compare/v7.13.1...v7.13.2) (2026-05-10)


### Bug Fixes

* **doc-scan:** replace blocking readdirSync with async pruning walk to prevent event-loop hang ([#814](https://github.com/zaxbysauce/opencode-swarm/issues/814)) ([4268c2d](https://github.com/zaxbysauce/opencode-swarm/commit/4268c2dda0244ba7f99cfd6fbf56b18cc6d7b575))

## [7.13.1](https://github.com/zaxbysauce/opencode-swarm/compare/v7.13.0...v7.13.1) (2026-05-10)


### Bug Fixes

* **install:** write minimal project config instead of DEFAULT_AGENT_CONFIGS ([#811](https://github.com/zaxbysauce/opencode-swarm/issues/811)) ([8534996](https://github.com/zaxbysauce/opencode-swarm/commit/8534996749f62ebdcb6ee61b8ceb67c6faf88ac4)), closes [#797](https://github.com/zaxbysauce/opencode-swarm/issues/797)

## [7.13.0](https://github.com/zaxbysauce/opencode-swarm/compare/v7.12.0...v7.13.0) (2026-05-10)


### Features

* canonical command renames, command-name registry, and phase-council mutation_gap emission ([#807](https://github.com/zaxbysauce/opencode-swarm/issues/807)) ([e9bd5af](https://github.com/zaxbysauce/opencode-swarm/commit/e9bd5af3c08cba94cf49e3e726f8edda0c6a8238))

## [7.12.0](https://github.com/zaxbysauce/opencode-swarm/compare/v7.11.1...v7.12.0) (2026-05-10)


### Features

* **guardrails:** add three-tier error classification for provider error resilience (closes [#756](https://github.com/zaxbysauce/opencode-swarm/issues/756)) ([4d3691b](https://github.com/zaxbysauce/opencode-swarm/commit/4d3691b8ec70318161d40d62a4ad6a227480aef9))

## [7.11.1](https://github.com/zaxbysauce/opencode-swarm/compare/v7.11.0...v7.11.1) (2026-05-09)


### Bug Fixes

* **architect:** harden anti-rationalization against time-pressure self-coding patterns ([#804](https://github.com/zaxbysauce/opencode-swarm/issues/804)) ([7d968f3](https://github.com/zaxbysauce/opencode-swarm/commit/7d968f36d06ee0c09558deb198bd7d32d06d5fdc))

## [7.11.0](https://github.com/zaxbysauce/opencode-swarm/compare/v7.10.0...v7.11.0) (2026-05-08)


### Features

* **knowledge:** actionable directives, skill compiler, real-LLM skill_improver, spec_writer (closes [#629](https://github.com/zaxbysauce/opencode-swarm/issues/629)) ([#799](https://github.com/zaxbysauce/opencode-swarm/issues/799)) ([6e68db1](https://github.com/zaxbysauce/opencode-swarm/commit/6e68db1599879e7b160e93d85e4166e9481451dc))

## [7.10.0](https://github.com/zaxbysauce/opencode-swarm/compare/v7.9.0...v7.10.0) (2026-05-08)


### Features

* **close:** full artifact cleanup, aggressive git reset, and hive promotion ([#800](https://github.com/zaxbysauce/opencode-swarm/issues/800)) ([02dae18](https://github.com/zaxbysauce/opencode-swarm/commit/02dae1812d0521b28831bb1fa8e7ff46e1044b4b))

## [7.9.0](https://github.com/zaxbysauce/opencode-swarm/compare/v7.8.1...v7.9.0) (2026-05-08)


### Features

* **commands:** audit remediation — registration, UX, error handling, and observability ([#796](https://github.com/zaxbysauce/opencode-swarm/issues/796)) ([9d2d194](https://github.com/zaxbysauce/opencode-swarm/commit/9d2d194eb425966e35c2d35dce9b8f8f9191246a))

## [7.8.1](https://github.com/zaxbysauce/opencode-swarm/compare/v7.8.0...v7.8.1) (2026-05-08)


### Bug Fixes

* **curator:** suppress unhandled NotFoundError when curator LLM times out ([#793](https://github.com/zaxbysauce/opencode-swarm/issues/793)) ([44058bd](https://github.com/zaxbysauce/opencode-swarm/commit/44058bde3b224012f029d97e890a3015357ddf68))
* **lang:** prevent concurrent Parser.init() calls with promise memoization ([#794](https://github.com/zaxbysauce/opencode-swarm/issues/794)) ([d05065e](https://github.com/zaxbysauce/opencode-swarm/commit/d05065e8e182d15f3ce15720d548914055058bd7))

## [7.8.0](https://github.com/zaxbysauce/opencode-swarm/compare/v7.7.0...v7.8.0) (2026-05-07)


### Features

* **full-auto:** v2 autonomy control plane with deterministic policy + critic oversight ([#789](https://github.com/zaxbysauce/opencode-swarm/issues/789)) ([1255264](https://github.com/zaxbysauce/opencode-swarm/commit/12552648b4527c13029a80fe849c807462549908))

## [7.7.0](https://github.com/zaxbysauce/opencode-swarm/compare/v7.6.1...v7.7.0) (2026-05-07)


### Features

* **qa-gate:** add final_council gate + derivePlanId utility + dead code removal ([#786](https://github.com/zaxbysauce/opencode-swarm/issues/786)) ([669fcbd](https://github.com/zaxbysauce/opencode-swarm/commit/669fcbdeecd4164e103eb97b7e0beac6535cd6db))


### Bug Fixes

* **gate:** evidence-incomplete no longer hard-blocks task completion when session state confirms gates passed ([#780](https://github.com/zaxbysauce/opencode-swarm/issues/780)) ([7d7d3e1](https://github.com/zaxbysauce/opencode-swarm/commit/7d7d3e19190866d391dcaebcd5b10ca52c530261))

## [7.6.1](https://github.com/zaxbysauce/opencode-swarm/compare/v7.6.0...v7.6.1) (2026-05-07)


### Bug Fixes

* **gate:** evidence-incomplete no longer hard-blocks task completion when session state confirms gates passed ([#780](https://github.com/zaxbysauce/opencode-swarm/issues/780)) ([7d7d3e1](https://github.com/zaxbysauce/opencode-swarm/commit/7d7d3e19190866d391dcaebcd5b10ca52c530261))
* **tools:** add stdin:ignore to all diff tool execFileSync calls (Invariant [#3](https://github.com/zaxbysauce/opencode-swarm/issues/3)) ([#784](https://github.com/zaxbysauce/opencode-swarm/issues/784)) ([3b6c873](https://github.com/zaxbysauce/opencode-swarm/commit/3b6c8732e6d9018d40e304ee5300db54943a86c3))

## [7.6.0](https://github.com/zaxbysauce/opencode-swarm/compare/v7.5.4...v7.6.0) (2026-05-07)


### Features

* **agents:** propagate project skills from architect to subagents ([#778](https://github.com/zaxbysauce/opencode-swarm/issues/778)) ([05b6984](https://github.com/zaxbysauce/opencode-swarm/commit/05b6984e740a9cc1f0f557c0c250fabd40ef9625))

## [7.5.4](https://github.com/zaxbysauce/opencode-swarm/compare/v7.5.3...v7.5.4) (2026-05-06)


### Bug Fixes

* **delegation-gate:** stop internal warn messages leaking into chat stream ([#776](https://github.com/zaxbysauce/opencode-swarm/issues/776)) ([d40015c](https://github.com/zaxbysauce/opencode-swarm/commit/d40015cfb625e0b68bddd8cae99fc7f8aa11f9ee))

## [7.5.3](https://github.com/zaxbysauce/opencode-swarm/compare/v7.5.2...v7.5.3) (2026-05-06)


### Bug Fixes

* **agents:** preserve 3-segment model IDs (lmstudio/qwen/model-name) ([#772](https://github.com/zaxbysauce/opencode-swarm/issues/772)) ([8664008](https://github.com/zaxbysauce/opencode-swarm/commit/86640080d0e2572ee140831707e0d9e1cbb14358))

## [7.5.2](https://github.com/zaxbysauce/opencode-swarm/compare/v7.5.1...v7.5.2) (2026-05-06)


### Bug Fixes

* **testing:** eliminate mock.module cross-test contamination and register submit_phase_council_verdicts tool ([#769](https://github.com/zaxbysauce/opencode-swarm/issues/769)) ([2106c19](https://github.com/zaxbysauce/opencode-swarm/commit/2106c19f1458da4ffc30dff261010941238b3cea))

## [7.5.1](https://github.com/zaxbysauce/opencode-swarm/compare/v7.5.0...v7.5.1) (2026-05-06)


### Bug Fixes

* **guardrails:** allow test_engineer, docs, and designer to write to nested directories at any depth ([#768](https://github.com/zaxbysauce/opencode-swarm/issues/768)) ([1fdeaed](https://github.com/zaxbysauce/opencode-swarm/commit/1fdeaedb2b33e9dbb75f51a2a9a62048483ad352))

## [7.5.0](https://github.com/zaxbysauce/opencode-swarm/compare/v7.4.3...v7.5.0) (2026-05-05)


### Features

* repo graph post-hardening improvements (module split, symlink safety, concurrency, escalation) ([#754](https://github.com/zaxbysauce/opencode-swarm/issues/754)) ([3713d05](https://github.com/zaxbysauce/opencode-swarm/commit/3713d05b58d9321bd5a2f7223a9105ec8fe08034))

## [7.4.3](https://github.com/zaxbysauce/opencode-swarm/compare/v7.4.2...v7.4.3) (2026-05-04)


### Bug Fixes

* **plan-sync:** ← CURRENT marker in extractIncompleteTasksFromPlan + refresh rehydration cache after compaction ([#751](https://github.com/zaxbysauce/opencode-swarm/issues/751)) ([dbcd0be](https://github.com/zaxbysauce/opencode-swarm/commit/dbcd0be55279e278aaf8bbe21e9ccb38462d283f))

## [7.4.2](https://github.com/zaxbysauce/opencode-swarm/compare/v7.4.1...v7.4.2) (2026-05-03)


### Bug Fixes

* **test-quality:** address PR [#732](https://github.com/zaxbysauce/opencode-swarm/issues/732) follow-up — temp leaks, missing coverage, parallelization, docs ([#749](https://github.com/zaxbysauce/opencode-swarm/issues/749)) ([86ee386](https://github.com/zaxbysauce/opencode-swarm/commit/86ee38691fbcb3423028b4c2aa5921141b5de4e3))

## [7.4.1](https://github.com/zaxbysauce/opencode-swarm/compare/v7.4.0...v7.4.1) (2026-05-03)


### Bug Fixes

* **cc-command-intercept:** hard-block /checkpoint like /reset and /clear ([#747](https://github.com/zaxbysauce/opencode-swarm/issues/747)) ([0cece27](https://github.com/zaxbysauce/opencode-swarm/commit/0cece277ff4e8367866e33939352067b8bce83e8))

## [7.4.0](https://github.com/zaxbysauce/opencode-swarm/compare/v7.3.7...v7.4.0) (2026-05-03)


### Features

* add three-layer swarm command conflict prevention system ([563f314](https://github.com/zaxbysauce/opencode-swarm/commit/563f31474804b03f8611c3538f02f7fb7ef9a8b4))
* add three-layer swarm command conflict prevention system ([522e67c](https://github.com/zaxbysauce/opencode-swarm/commit/522e67ce877b12ef5adc46c47f5bab70260de473))


### Bug Fixes

* **cc-command-intercept:** fix tautological assertion; add /checkpoint test coverage ([f30a4cf](https://github.com/zaxbysauce/opencode-swarm/commit/f30a4cff9ce19abc914001c1fcc86ea6e6a6f821))
* **ci:** remove push trigger to prevent dual workflow runs and stale checks ([ae53078](https://github.com/zaxbysauce/opencode-swarm/commit/ae53078be719ffe125205bf9630c03d8b83d37d3))

## [Unreleased]

### Features

* **conflict-registry:** add pure-data module mapping 9 swarm commands to their CC built-in counterparts with severity ratings (CRITICAL/HIGH/MEDIUM); commands with conflicts display a ⚠️ warning in `/swarm help` output
* **ci-gate:** add `src/commands/conflict-registry.test.ts` CI gate that prevents new CRITICAL conflicts from being merged without explicit acknowledgment in the test allow-list
* **constants:** add `CLAUDE_CODE_NATIVE_COMMANDS` frozen set (115 CC built-in commands) to `src/config/constants.ts` for runtime intercept hook; includes `freezeSet()` helper that throws on mutation attempts

### Changed

* **registry:** add optional `clashesWithNativeCcCommand` field to `CommandEntry` type; populated on 9 commands (`plan`, `reset`, `checkpoint`, `status`, `agents`, `config`, `export`, `doctor`, `history`)
* **index:** `buildHelpText()` now renders a ⚠️ conflict warning line for every command that has `clashesWithNativeCcCommand` set

## [7.3.5](https://github.com/zaxbysauce/opencode-swarm/compare/v7.3.4...v7.3.5) (2026-05-03)


### Bug Fixes

* **agents:** restore multi-swarm primary architects after v7.3.x regression ([#737](https://github.com/zaxbysauce/opencode-swarm/issues/737)) ([0c8d94e](https://github.com/zaxbysauce/opencode-swarm/commit/0c8d94e2cbd40ceb72b2f3a7210e2ce028f5bccf))

## [7.3.4](https://github.com/zaxbysauce/opencode-swarm/compare/v7.3.3...v7.3.4) (2026-05-02)


### Bug Fixes

* **plugin-init:** bound ensureSwarmGitExcluded to prevent cross-platform load hang ([#735](https://github.com/zaxbysauce/opencode-swarm/issues/735)) ([8672cb1](https://github.com/zaxbysauce/opencode-swarm/commit/8672cb155648a628b23ce9edeffa9544b0898587))

## [7.3.3](https://github.com/zaxbysauce/opencode-swarm/compare/v7.3.2...v7.3.3) (2026-05-01)


### Bug Fixes

* **git-hygiene:** auto-protect .swarm/ from Git pollution before any write ([#732](https://github.com/zaxbysauce/opencode-swarm/issues/732)) ([17fc49f](https://github.com/zaxbysauce/opencode-swarm/commit/17fc49f585931256654bdbb506b3f50b4891e673))

## [7.3.2](https://github.com/zaxbysauce/opencode-swarm/compare/v7.3.1...v7.3.2) (2026-05-01)


### Bug Fixes

* **council:** make council additive at phase-level, never suppress per-task Stage B gates ([#728](https://github.com/zaxbysauce/opencode-swarm/issues/728)) ([aa96c74](https://github.com/zaxbysauce/opencode-swarm/commit/aa96c7487e5d80b4fd1cd709bc141ecbad50e4a8))

## [7.3.1](https://github.com/zaxbysauce/opencode-swarm/compare/v7.3.0...v7.3.1) (2026-05-01)


### Bug Fixes

* reduce false telemetry failures and mirrored state spam ([#727](https://github.com/zaxbysauce/opencode-swarm/issues/727)) ([079d8cc](https://github.com/zaxbysauce/opencode-swarm/commit/079d8cc0d312f6c78e8f41ed26775804e25102e0))

## [7.3.0](https://github.com/zaxbysauce/opencode-swarm/compare/v7.2.0...v7.3.0) (2026-05-01)


### Features

* add first-run UX, categorized help, and deprecation aliases ([#723](https://github.com/zaxbysauce/opencode-swarm/issues/723)) ([0e2ed93](https://github.com/zaxbysauce/opencode-swarm/commit/0e2ed930f7050dfb979995139ee1129a32a9a264))

## [7.2.0](https://github.com/zaxbysauce/opencode-swarm/compare/v7.1.1...v7.2.0) (2026-05-01)


### Features

* **config:** auto-create .opencode/opencode-swarm.json on plugin init ([#657](https://github.com/zaxbysauce/opencode-swarm/issues/657)) ([#719](https://github.com/zaxbysauce/opencode-swarm/issues/719)) ([6c60d4d](https://github.com/zaxbysauce/opencode-swarm/commit/6c60d4df5ef486ce11aa89c4f4124c2aa2e93cec))

## [7.1.1](https://github.com/zaxbysauce/opencode-swarm/compare/v7.1.0...v7.1.1) (2026-04-30)


### Bug Fixes

* suppress knowledge-injector headroom warning from chat UI ([#715](https://github.com/zaxbysauce/opencode-swarm/issues/715)) ([db63336](https://github.com/zaxbysauce/opencode-swarm/commit/db633360573e34d0698d77702fb0a7bacb8aacd0))

## [7.1.0](https://github.com/zaxbysauce/opencode-swarm/compare/v7.0.3...v7.1.0) (2026-04-30)


### Features

* **agents:** add mandatory reuse scan and duplicate prevention gate ([#712](https://github.com/zaxbysauce/opencode-swarm/issues/712)) ([733681f](https://github.com/zaxbysauce/opencode-swarm/commit/733681f23e1e81e55d6d293846d63f27ab9c1934))

## [7.0.3](https://github.com/zaxbysauce/opencode-swarm/compare/v7.0.2...v7.0.3) (2026-04-30)


### Bug Fixes

* **#704:** unblock OpenCode Desktop plugin init across macOS/Linux/Windows ([#707](https://github.com/zaxbysauce/opencode-swarm/issues/707)) ([68cb660](https://github.com/zaxbysauce/opencode-swarm/commit/68cb66023ba02a48558ef1a9780a89d373b77924))

## [7.0.2](https://github.com/zaxbysauce/opencode-swarm/compare/v7.0.1...v7.0.2) (2026-04-30)


### Bug Fixes

* **council:** replace council_member/moderator with role-framed dispatch + architect synthesis ([#703](https://github.com/zaxbysauce/opencode-swarm/issues/703)) ([f800c1a](https://github.com/zaxbysauce/opencode-swarm/commit/f800c1aa12dc6359ab945fcc0c49c7ab9f77249b))

## [7.0.1](https://github.com/zaxbysauce/opencode-swarm/compare/v7.0.0...v7.0.1) (2026-04-30)


### Bug Fixes

* **#583,#698:** confine SWARM_PLAN to .swarm/, prevent spiral commits, fix update across platforms ([#700](https://github.com/zaxbysauce/opencode-swarm/issues/700)) ([c371c26](https://github.com/zaxbysauce/opencode-swarm/commit/c371c26f9b4976fe1a87cb24739ffd60fd156123))

## [7.0.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.86.14...v7.0.0) (2026-04-29)


### ⚠ BREAKING CHANGES

* council_mode semantics rewritten — Stage B (reviewer + test_engineer) now always runs per-task regardless of council_mode setting; council convenes at phase_complete for holistic phase-level review only. Users with council_mode enabled will see both per-task gates AND phase-level council where previously council replaced per-task gates.

### Features

* Swarm Plugin Enhancements v7.0.0 ([#697](https://github.com/zaxbysauce/opencode-swarm/issues/697)) ([6563271](https://github.com/zaxbysauce/opencode-swarm/commit/65632712a4f326ea363c92baa05441a83e105f89))

## [6.86.14](https://github.com/zaxbysauce/opencode-swarm/compare/v6.86.13...v6.86.14) (2026-04-29)


### Bug Fixes

* **guardrails:** enforce continuation on transient LLM errors (issue [#691](https://github.com/zaxbysauce/opencode-swarm/issues/691)) ([#694](https://github.com/zaxbysauce/opencode-swarm/issues/694)) ([89b479f](https://github.com/zaxbysauce/opencode-swarm/commit/89b479f5669d318c5add8f6056e9d0427a8d2f16))

## [6.86.13](https://github.com/zaxbysauce/opencode-swarm/compare/v6.86.12...v6.86.13) (2026-04-29)


### Bug Fixes

* **#686,#687:** default quiet mode and eliminate empty checkpoint commits ([#689](https://github.com/zaxbysauce/opencode-swarm/issues/689)) ([90ae113](https://github.com/zaxbysauce/opencode-swarm/commit/90ae1131542e4399646c1e18c66a4a2622d07bd9))
* **skills:** harden swarm-pr-review with anti-self-review gate, council opt-in guard, and pre-synthesis checkpoint ([3f2766e](https://github.com/zaxbysauce/opencode-swarm/commit/3f2766e0b981dcd7c83604daaabfd28b326fff9c))

## [6.86.12](https://github.com/zaxbysauce/opencode-swarm/compare/v6.86.11...v6.86.12) (2026-04-29)


### Bug Fixes

* **knowledge:** repair hive promotion path, align todo category, fix list/quarantine ergonomics ([#685](https://github.com/zaxbysauce/opencode-swarm/issues/685)) ([0f2aaa3](https://github.com/zaxbysauce/opencode-swarm/commit/0f2aaa3e8eb677dfbe0bc25288cf11bb7527c5da))

## [6.86.11](https://github.com/zaxbysauce/opencode-swarm/compare/v6.86.10...v6.86.11) (2026-04-29)


### Bug Fixes

* **tui:** eliminate per-agent advisory spam from fallback_models warning ([#683](https://github.com/zaxbysauce/opencode-swarm/issues/683)) ([6e8f4c9](https://github.com/zaxbysauce/opencode-swarm/commit/6e8f4c9268a2115840e38f5db5fd13cc9677f407))

## [6.86.10](https://github.com/zaxbysauce/opencode-swarm/compare/v6.86.9...v6.86.10) (2026-04-28)


### Bug Fixes

* **hooks:** route unguarded console output through debug-gated logger to suppress chat area noise ([#681](https://github.com/zaxbysauce/opencode-swarm/issues/681)) ([7b555e0](https://github.com/zaxbysauce/opencode-swarm/commit/7b555e00352d3ab77e9413e80d61e88615a6de53))

## [6.86.9](https://github.com/zaxbysauce/opencode-swarm/compare/v6.86.8...v6.86.9) (2026-04-28)


### Bug Fixes

* **plugin:** migrate to v1 export shape for OpenCode plugin loader compatibility ([#675](https://github.com/zaxbysauce/opencode-swarm/issues/675)) ([#679](https://github.com/zaxbysauce/opencode-swarm/issues/679)) ([d696631](https://github.com/zaxbysauce/opencode-swarm/commit/d696631e49e77b5fd81dd3478a22b6d3e126030d))

## [6.86.8](https://github.com/zaxbysauce/opencode-swarm/compare/v6.86.7...v6.86.8) (2026-04-28)


### Bug Fixes

* **plugin:** make bundle portable to Node ESM hosts + cache refresh ([#675](https://github.com/zaxbysauce/opencode-swarm/issues/675)) ([#676](https://github.com/zaxbysauce/opencode-swarm/issues/676)) ([db9b5e2](https://github.com/zaxbysauce/opencode-swarm/commit/db9b5e2ca750f201690aa25411c663a4c8e3dddf))

## [6.86.7](https://github.com/zaxbysauce/opencode-swarm/compare/v6.86.6...v6.86.7) (2026-04-28)


### Bug Fixes

* **council:** close 4 council bypass paths via rename + quorum gate + quorumSize docs ([#673](https://github.com/zaxbysauce/opencode-swarm/issues/673)) ([fa4f9ff](https://github.com/zaxbysauce/opencode-swarm/commit/fa4f9ffbf140a19501d9d987e5350473c5e2d7fc))

## [6.86.6](https://github.com/zaxbysauce/opencode-swarm/compare/v6.86.5...v6.86.6) (2026-04-28)


### Bug Fixes

* version flag, startup noise, README, agent listing, checkpoint cleanup, and CI fixes ([#669](https://github.com/zaxbysauce/opencode-swarm/issues/669)) ([0de72a5](https://github.com/zaxbysauce/opencode-swarm/commit/0de72a532f6c640d8c67d5ad5f682f7ae0395ed2))

## [6.86.5](https://github.com/zaxbysauce/opencode-swarm/compare/v6.86.4...v6.86.5) (2026-04-27)


### Bug Fixes

* **mutation:** extract JSON from LLM responses containing markdown or prose preamble ([#664](https://github.com/zaxbysauce/opencode-swarm/issues/664)) ([1793cf6](https://github.com/zaxbysauce/opencode-swarm/commit/1793cf6a9f11d878e7104e83b616cc0349c9d686))

## [6.86.4](https://github.com/zaxbysauce/opencode-swarm/compare/v6.86.3...v6.86.4) (2026-04-27)


### Bug Fixes

* **plan:** resolve ledger corruption handling and rollback ledger bypass audit findings ([#659](https://github.com/zaxbysauce/opencode-swarm/issues/659)) ([afce191](https://github.com/zaxbysauce/opencode-swarm/commit/afce1914557bab11349a0c6b81d74d7dc676e4af))

## [6.86.3](https://github.com/zaxbysauce/opencode-swarm/compare/v6.86.2...v6.86.3) (2026-04-27)


### Bug Fixes

* **plan:** bridge in-memory task state to plan.json so plan.md updates ([#654](https://github.com/zaxbysauce/opencode-swarm/issues/654)) ([ad45a99](https://github.com/zaxbysauce/opencode-swarm/commit/ad45a99b8ed1ae8db7c3dd1fc9583d095be2c168))

## [6.86.2](https://github.com/zaxbysauce/opencode-swarm/compare/v6.86.1...v6.86.2) (2026-04-27)


### Bug Fixes

* **ci:** make Windows bun test runner resilient to process crashes ([a9abbed](https://github.com/zaxbysauce/opencode-swarm/commit/a9abbedda696b26dfdb0779986d92c6b6a145a22))
* **ci:** replace $() command substitution in run steps to pass security scan ([7aa8d8a](https://github.com/zaxbysauce/opencode-swarm/commit/7aa8d8adcd284ecf1ef3faa6daa92436fc828a92))

## [6.86.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.86.0...v6.86.1) (2026-04-27)


### Bug Fixes

* **agents:** strip designer from architect prompt when ui_review is disabled ([#651](https://github.com/zaxbysauce/opencode-swarm/issues/651)) ([3ee7242](https://github.com/zaxbysauce/opencode-swarm/commit/3ee724283e6c178e0f1fd999bf98971d989e9ff8))

## [6.86.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.85.4...v6.86.0) (2026-04-27)


### Features

* **config:** add variant field with backward-compatible auto-split ([035c4c3](https://github.com/zaxbysauce/opencode-swarm/commit/035c4c352da42adacef0474bf29cbc0028e7ef3f))

## [6.85.4](https://github.com/zaxbysauce/opencode-swarm/compare/v6.85.3...v6.85.4) (2026-04-27)


### Bug Fixes

* **knowledge:** consolidate hive promoter, add dedup to knowledge_add, fix injector budget default ([#641](https://github.com/zaxbysauce/opencode-swarm/issues/641)) ([446ac98](https://github.com/zaxbysauce/opencode-swarm/commit/446ac982f7d084fa2c56080fda1a10370942c7d2))

## [6.85.3](https://github.com/zaxbysauce/opencode-swarm/compare/v6.85.2...v6.85.3) (2026-04-26)


### Bug Fixes

* **grammar:** correct WASM grammar path for CLI bundle and fix C# grammarId ([#640](https://github.com/zaxbysauce/opencode-swarm/issues/640)) ([2d95f22](https://github.com/zaxbysauce/opencode-swarm/commit/2d95f223b2ece7c344301e57309a7aa0614fff57))

## [6.85.2](https://github.com/zaxbysauce/opencode-swarm/compare/v6.85.1...v6.85.2) (2026-04-26)


### Bug Fixes

* suppress repo-graph diagnostic messages from chat output ([#638](https://github.com/zaxbysauce/opencode-swarm/issues/638)) ([ad4c4b6](https://github.com/zaxbysauce/opencode-swarm/commit/ad4c4b6249fd86b3607e01c3f3182a6f40c16e9d))

## [6.85.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.85.0...v6.85.1) (2026-04-26)


### Bug Fixes

* **system-transform:** collapse output.system to single entry for Qwen3.6/Gemma compatibility ([#628](https://github.com/zaxbysauce/opencode-swarm/issues/628)) ([c8ad147](https://github.com/zaxbysauce/opencode-swarm/commit/c8ad147eee344368244a27c12c09f7a94cb80b6e))

## [6.85.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.84.7...v6.85.0) (2026-04-26)


### Features

* **onboarding:** improve onboarding with autonomous planning, web app example, and config auto-discovery ([#624](https://github.com/zaxbysauce/opencode-swarm/issues/624)) ([ae81b22](https://github.com/zaxbysauce/opencode-swarm/commit/ae81b22aa613e17a3e3b1bd46ddbec93f0d446df))

## [6.84.7](https://github.com/zaxbysauce/opencode-swarm/compare/v6.84.6...v6.84.7) (2026-04-26)


### Bug Fixes

* commit since tag v6.84.6 and correctly produce a 6.84.7 patch release. ([10dbe86](https://github.com/zaxbysauce/opencode-swarm/commit/10dbe86cb788b2422c17aae9e677a4154359543c))
* **guardrails:** redact opencode key variants and warn on missing .swarm gitignore ([#620](https://github.com/zaxbysauce/opencode-swarm/issues/620)) ([bb9804d](https://github.com/zaxbysauce/opencode-swarm/commit/bb9804d7c5c060882beeafd1dca7930fbd554a07))
* revert manifest to 6.84.6 so release-please calculates correct 6.84.7 ([10dbe86](https://github.com/zaxbysauce/opencode-swarm/commit/10dbe86cb788b2422c17aae9e677a4154359543c))

## [6.84.6](https://github.com/zaxbysauce/opencode-swarm/compare/v6.84.5...v6.84.6) (2026-04-26)


### Bug Fixes

* replace unavailable default models and add fallback protection ([#617](https://github.com/zaxbysauce/opencode-swarm/issues/617)) ([bbe05f0](https://github.com/zaxbysauce/opencode-swarm/commit/bbe05f0a86d27873e567de9bbdc7bc9404fe027b))

## [6.84.5](https://github.com/zaxbysauce/opencode-swarm/compare/v6.84.4...v6.84.5) (2026-04-25)


### Bug Fixes

* **repo-graph:** prevent first-initialization error on new workspaces ([#614](https://github.com/zaxbysauce/opencode-swarm/issues/614)) ([2b13a00](https://github.com/zaxbysauce/opencode-swarm/commit/2b13a00f994aa7312187c2222b7a48502da08bd5)), closes [#585](https://github.com/zaxbysauce/opencode-swarm/issues/585)

## [6.84.4](https://github.com/zaxbysauce/opencode-swarm/compare/v6.84.3...v6.84.4) (2026-04-25)


### Bug Fixes

* **council:** checkCouncilGate blocks completion when council_mode=false ([#612](https://github.com/zaxbysauce/opencode-swarm/issues/612)) ([f760956](https://github.com/zaxbysauce/opencode-swarm/commit/f7609560fd239cb2d229ec2445a769a58b2f7d04))

## [6.84.3](https://github.com/zaxbysauce/opencode-swarm/compare/v6.84.2...v6.84.3) (2026-04-25)


### Bug Fixes

* add 'diagnosis' as alias for 'diagnose' command (issue [#588](https://github.com/zaxbysauce/opencode-swarm/issues/588)) ([#610](https://github.com/zaxbysauce/opencode-swarm/issues/610)) ([8a45fd6](https://github.com/zaxbysauce/opencode-swarm/commit/8a45fd6e5394c68b5bdd516d4e1f133323b0541f))

## [6.84.2](https://github.com/zaxbysauce/opencode-swarm/compare/v6.84.1...v6.84.2) (2026-04-24)


### Bug Fixes

* **install:** clear opencode runtime plugin cache on install ([#601](https://github.com/zaxbysauce/opencode-swarm/issues/601)) ([383d155](https://github.com/zaxbysauce/opencode-swarm/commit/383d1559d6d2f6ddd4e40902b1b9f35232656ae6))

## [6.84.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.84.0...v6.84.1) (2026-04-24)


### Bug Fixes

* **guardrails:** skip transient api errors from circuit breaker while fallback available ([#599](https://github.com/zaxbysauce/opencode-swarm/issues/599)) ([bdf2c7c](https://github.com/zaxbysauce/opencode-swarm/commit/bdf2c7c38cd42987eb00f8d9c3a53cb07459a931))

## [6.84.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.83.0...v6.84.0) (2026-04-24)


### Features

* **council:** add General Council Mode and harden QA gate selection ([#590](https://github.com/zaxbysauce/opencode-swarm/issues/590)) ([4f61090](https://github.com/zaxbysauce/opencode-swarm/commit/4f61090d7cbe39c05e87819e8bdc10e6c9b0b497))

## [6.83.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.82.2...v6.83.0) (2026-04-24)


### Features

* **agents:** add get_approved_plan to critic with baseline comparison mandate ([#582](https://github.com/zaxbysauce/opencode-swarm/issues/582)) ([6ec5b70](https://github.com/zaxbysauce/opencode-swarm/commit/6ec5b704488226f81004ceefc13d56c74008ae98))

## [6.82.2](https://github.com/zaxbysauce/opencode-swarm/compare/v6.82.1...v6.82.2) (2026-04-24)


### Bug Fixes

* **swarm-dirs:** prevent .swarm directories from being created in project sub-folders ([#577](https://github.com/zaxbysauce/opencode-swarm/issues/577)) ([#579](https://github.com/zaxbysauce/opencode-swarm/issues/579)) ([e8f0f88](https://github.com/zaxbysauce/opencode-swarm/commit/e8f0f88edbf9fca54a58fa410a7a006009f79a41))

## [6.82.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.82.0...v6.82.1) (2026-04-23)


### Bug Fixes

* **architect:** remove stale plan.md structural-write permission ([#574](https://github.com/zaxbysauce/opencode-swarm/issues/574)) ([#576](https://github.com/zaxbysauce/opencode-swarm/issues/576)) ([974070c](https://github.com/zaxbysauce/opencode-swarm/commit/974070ce295e3fc4e33bb4e3f4a108948bf79c97))

## [6.82.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.81.1...v6.82.0) (2026-04-23)


### Features

* **mutation-gate:** add mutation-testing-backed test quality gate ([#569](https://github.com/zaxbysauce/opencode-swarm/issues/569)) ([3e5059d](https://github.com/zaxbysauce/opencode-swarm/commit/3e5059d105ad74ccf21c5ab106d8349135763625))

## [Unreleased]

### Features

* **mutation:** add LLM-driven mutation patch generator (`src/mutation/generator.ts`) — generates 5–10 patches per function across 6 mutation types (off-by-one, null substitution, operator swap, guard removal, branch swap, side-effect deletion) using an ephemeral LLM session; gracefully returns `[]` on any failure

### Architecture

* **qa-gate-profile:** add `mutation_test: boolean` to `QaGates` interface (`src/db/qa-gate-profile.ts`); default `false` (opt-in per project); listed alongside the other 7 gates in `DEFAULT_QA_GATES`; consumed by Gate 4 enforcement in `phase_complete`
* **tools:** add two architect-only tools for mutation-testing-backed QA gates:
  - `generate_mutants` (`src/tools/generate-mutants.ts`) — accepts `files: string[]`, calls `generateMutants()` with ToolContext, returns patches for direct consumption by the `mutation_test` tool; emits `SKIP` verdict on LLM failure rather than throwing
  - `write_mutation_evidence` (`src/tools/write-mutation-evidence.ts`) — writes phase-close mutation gate results atomically to `.swarm/evidence/{phase}/mutation-gate.json`; accepts verdict (PASS/WARN/FAIL/SKIP), kill rate metrics, and optional survived mutant details; normalised uppercase-to-lowercase before persisting
* **evidence:** add `mutation-gate` evidence type — phase-level artifact containing verdict, killRate, adjustedKillRate, summary, and survivedMutants; read by the `mutation_test` phase gate (Gate 4) in `phase_complete`
* **phase-complete:** add Gate 4 mutation gate enforcement — reads `.swarm/evidence/{phase}/mutation-gate.json` when `mutation_test` is enabled in the QA gate profile; `fail` verdict blocks `phase_complete`; `warn` verdict allows advancement with a warning; `pass`/`skip` allow advancement; automatically bypassed in turbo mode alongside Gates 1–3

## [6.81.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.81.0...v6.81.1) (2026-04-23)


### Bug Fixes

* **cli:** prevent install() from firing when cli/index is imported by tests ([#572](https://github.com/zaxbysauce/opencode-swarm/issues/572)) ([10d0721](https://github.com/zaxbysauce/opencode-swarm/commit/10d07215ab59d519082c8bce6c7467a99eed0cb8))

## [6.81.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.80.2...v6.81.0) (2026-04-22)


### Features

* **prm:** Implement Process Reward Model for live trajectory course-correction ([#562](https://github.com/zaxbysauce/opencode-swarm/issues/562)) ([544634e](https://github.com/zaxbysauce/opencode-swarm/commit/544634e9105d08ee58e7880a31c8ec595f6eabf0))

## [6.80.2](https://github.com/zaxbysauce/opencode-swarm/compare/v6.80.1...v6.80.2) (2026-04-22)


### Bug Fixes

* **spiral-detection:** eliminate repeated checkpoint: spiral-unknown-xxxx commits (issue [#564](https://github.com/zaxbysauce/opencode-swarm/issues/564)) ([#565](https://github.com/zaxbysauce/opencode-swarm/issues/565)) ([791da0c](https://github.com/zaxbysauce/opencode-swarm/commit/791da0c748948f89eccf6e9f901945d7b6533867))

## [6.80.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.80.0...v6.80.1) (2026-04-22)


### Bug Fixes

* **guardrails:** exempt opencode native agents from swarm guardrails (issue [#559](https://github.com/zaxbysauce/opencode-swarm/issues/559)) ([#561](https://github.com/zaxbysauce/opencode-swarm/issues/561)) ([d5adf41](https://github.com/zaxbysauce/opencode-swarm/commit/d5adf41e81afcac4af1fa9b7c3b5d5e985d441d0))

## [6.80.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.79.0...v6.80.0) (2026-04-20)


### Features

* **diff:** AST semantic diff summary pipeline with remediation fixes ([#557](https://github.com/zaxbysauce/opencode-swarm/issues/557)) ([c740998](https://github.com/zaxbysauce/opencode-swarm/commit/c7409987707de48759a57b9cb46edc9560cc31b6))

## [Unreleased]

### Features

* **lang/registry:** expand language coverage from 6 to 20 (java, c, cpp, csharp, ruby, swift, kotlin, dart, css, bash, powershell, ini, regex, tsx); TypeScript split to .ts-only with separate TSX entry; commentNodes verified against tree-sitter grammars ([#PH2](https://github.com/zaxbysauce/opencode-swarm/issues/PH2))
* **diff/ast-diff:** add 13 tree-sitter query patterns for java, c, cpp, csharp, ruby, php, swift, kotlin, dart, css, bash, powershell, tsx; expand extractSignature() with lookup table for 15 languages; add rename detection to compareSymbols() with conservative thresholds; add 'renamed' change type and renamedFrom field to ASTChange
* **diff/semantic-classifier:** add 'renamed' to ClassifiedChange.changeType union; add renamedFrom field; guard renamed function classification as Critical
* **diff/semantic-classifier:** add optional `consumersCount` field to `ClassifiedChange` — blast radius indicator (number of files importing the changed file); `classifyChanges()` now accepts optional `fileConsumers?: Record<string, number>` parameter; field only set when file key exists in the map
* **diff/summary-generator:** `generateSummaryMarkdown()` renders consumers count inline with singular/plural grammar: "(N consumers)" or "(1 consumer)"
* **hooks/semantic-diff-injection (NEW):** `buildSemanticDiffBlock(directory, changedFiles, maxFiles=10)` — end-to-end pipeline: computes AST diffs for changed files, builds `fileConsumers` from repo graph, classifies changes with `consumersCount`, generates markdown summary; fully error-resilient (never throws, returns `null` on any failure); uses `cat-file -e` to check for untracked files; relativizes absolute paths for graph lookup
* **hooks/system-enhancer:** injects `buildSemanticDiffBlock` output into reviewer context (after blast radius in reviewer section); derived from `reviewerSession?.declaredCoderScope`; capped at 10 files; silent failure (no errors emitted)
* **agents/reviewer:** added "## SEMANTIC DIFF SUMMARY — INTERPRETATION" section to reviewer prompt: risk-based priority ranking (Critical → High → Medium → Low), blast radius interpretation ("(N consumers)" indicator), guard function vigilance guidance (GUARD_REMOVED escalation), and explicit DO NOT guidance to prevent over-reliance on the summary

### Bug Fixes

* **diff/ast-diff:** fix rename detection preventing false DELETED+NEW pairs when functions are renamed with matching signatures; guard function renames classified as Critical (not hidden as Medium refactor)

## [6.79.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.78.0...v6.79.0) (2026-04-20)


### Features

* **state:** rehydrate council verdicts from disk evidence on session restart ([#554](https://github.com/zaxbysauce/opencode-swarm/issues/554)) ([9948f11](https://github.com/zaxbysauce/opencode-swarm/commit/9948f116d39434780efeeb7fd8314c222facf6d4))

## [6.78.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.77.0...v6.78.0) (2026-04-19)


### Features

* **parallelization:** mark pr 3 release as v6.78.0 ([#552](https://github.com/zaxbysauce/opencode-swarm/issues/552)) ([69c6450](https://github.com/zaxbysauce/opencode-swarm/commit/69c64508c02e6ae3466e415f4205511b868376bb))
* **parallelization:** pr 3 — lockable execution_profile, ledger events, and fail-closed enforcement ([#550](https://github.com/zaxbysauce/opencode-swarm/issues/550)) ([2f02e47](https://github.com/zaxbysauce/opencode-swarm/commit/2f02e47a2a1379b35b19785566fa2006367ae675))

## [6.77.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.76.0...v6.77.0) (2026-04-19)


### Features

* **parallelization:** pr 2 — stage b order-independent barrier and bounded concurrency ([#548](https://github.com/zaxbysauce/opencode-swarm/issues/548)) ([2f2fd48](https://github.com/zaxbysauce/opencode-swarm/commit/2f2fd486e4c8fee3998963ef9ce62d854856dbd2))
* **parallelization:** pr 3 — lockable execution_profile, ledger events, and fail-closed enforcement ([#550](https://github.com/zaxbysauce/opencode-swarm/issues/550)) ([2f02e47](https://github.com/zaxbysauce/opencode-swarm/commit/2f02e47a2a1379b35b19785566fa2006367ae675))

## [6.76.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.75.0...v6.76.0) (2026-04-19)


### Features

* **test-runner:** widen convention test resolution and add explicit targeting limits ([#546](https://github.com/zaxbysauce/opencode-swarm/issues/546)) ([7718053](https://github.com/zaxbysauce/opencode-swarm/commit/7718053ff76f18ab309f11c78ca6ab1d1cbe0955))

## [6.75.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.74.1...v6.75.0) (2026-04-18)


### Features

* **parallel:** pr 1 — dark foundation for stacked parallelization ([#540](https://github.com/zaxbysauce/opencode-swarm/issues/540)) ([8fc1cdb](https://github.com/zaxbysauce/opencode-swarm/commit/8fc1cdbaabbc03677d199521049f0428bd326fcc))

## [6.74.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.74.0...v6.74.1) (2026-04-18)


### Bug Fixes

* **repo-graph:** drop import specifiers with control chars to prevent graph build failure ([#538](https://github.com/zaxbysauce/opencode-swarm/issues/538)) ([d6c7ea5](https://github.com/zaxbysauce/opencode-swarm/commit/d6c7ea5adecdc1957843083c7a1c72d8ae05ff95))

## [6.74.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.73.1...v6.74.0) (2026-04-18)


### Features

* **sast:** phase-scoped baseline diffing so only new findings fail ([#535](https://github.com/zaxbysauce/opencode-swarm/issues/535)) ([145b736](https://github.com/zaxbysauce/opencode-swarm/commit/145b73670d5b60725900ef80456859544b47f0db))

## [6.73.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.73.0...v6.73.1) (2026-04-18)


### Bug Fixes

* update_task_status silently fails to downgrade completed tasks; add reset_statuses to save_plan ([#533](https://github.com/zaxbysauce/opencode-swarm/issues/533)) ([3657f30](https://github.com/zaxbysauce/opencode-swarm/commit/3657f3045827b4d9b156fe76929e0c575e5c6e67))

## [6.73.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.72.1...v6.73.0) (2026-04-17)


### Features

* **architect:** add critic_hallucination_verifier and phase_complete Gate 3 enforcement for hallucination_guard QA gate ([#531](https://github.com/zaxbysauce/opencode-swarm/issues/531)) ([109a7b0](https://github.com/zaxbysauce/opencode-swarm/commit/109a7b09afb7bb7c5229c31b78bdce486c6ed327))

## [6.72.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.72.0...v6.72.1) (2026-04-17)


### Bug Fixes

* **architect:** add declare_scope reminders at every coder delegation site ([#526](https://github.com/zaxbysauce/opencode-swarm/issues/526)) ([0e71cf0](https://github.com/zaxbysauce/opencode-swarm/commit/0e71cf0ea8bc0f9be71495aecfe91ba368097008))
* **delegation-gate, architect, state:** resolve three wiring gaps in council mode ([#487](https://github.com/zaxbysauce/opencode-swarm/issues/487)) ([#530](https://github.com/zaxbysauce/opencode-swarm/issues/530)) ([54cd413](https://github.com/zaxbysauce/opencode-swarm/commit/54cd4133b3602693284f314d666996c57622098e))

## [6.72.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.71.1...v6.72.0) (2026-04-17)


### Features

* **knowledge:** add N-phase TTL decay and TODO stale-entry sweep ([#524](https://github.com/zaxbysauce/opencode-swarm/issues/524)) ([b89f875](https://github.com/zaxbysauce/opencode-swarm/commit/b89f875fdea504cb34880fe0f03479f431782d50))

## [6.71.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.71.0...v6.71.1) (2026-04-16)


### Bug Fixes

* **scope:** persist declared scope across process boundaries ([#521](https://github.com/zaxbysauce/opencode-swarm/issues/521)) ([dc61b64](https://github.com/zaxbysauce/opencode-swarm/commit/dc61b64e62248df8a8ababa28658505213b71ce7))

## [6.71.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.70.0...v6.71.0) (2026-04-16)


### Features

* **security:** interpreter gating + redacted shell audit log ([#503](https://github.com/zaxbysauce/opencode-swarm/issues/503)) ([ece213b](https://github.com/zaxbysauce/opencode-swarm/commit/ece213bfffdbf9091ffb34377b509d0d5a06a518))

## [6.70.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.69.0...v6.70.0) (2026-04-16)


### Features

* **guardrails:** transparent write authority + lstat symlink guard + universal deny prefixes ([#501](https://github.com/zaxbysauce/opencode-swarm/issues/501)) ([c884a33](https://github.com/zaxbysauce/opencode-swarm/commit/c884a330ce8434859daabb6133d7a3737e024178))

## [6.69.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.68.1...v6.69.0) (2026-04-16)


### Features

* **security:** cross-platform destructive command guardrails ([#499](https://github.com/zaxbysauce/opencode-swarm/issues/499)) ([68289bf](https://github.com/zaxbysauce/opencode-swarm/commit/68289bf283e726165c4ebf542b3d6593a092f64a))

## [6.68.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.68.0...v6.68.1) (2026-04-15)


### Bug Fixes

* **mutation,tools,commands:** resolve council audit findings — equivalence detection, command templates, kill rate fix, validation hardening ([#497](https://github.com/zaxbysauce/opencode-swarm/issues/497)) ([e3c61da](https://github.com/zaxbysauce/opencode-swarm/commit/e3c61da2269151e1231e92c28496bf18f82d79ca))

## [6.68.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.67.1...v6.68.0) (2026-04-13)


### Features

* **swarm:** add SQLite constraint store, QA gate profiles, and MODE: BRAINSTORM ([#485](https://github.com/zaxbysauce/opencode-swarm/issues/485)) ([12185c8](https://github.com/zaxbysauce/opencode-swarm/commit/12185c8e718c2e8c38a58083f31ee7c581655463))

## [6.67.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.67.0...v6.67.1) (2026-04-13)


### Bug Fixes

* **plugin-council:** register council tools and harden same-class silent-failure paths ([#483](https://github.com/zaxbysauce/opencode-swarm/issues/483)) ([cf2fca7](https://github.com/zaxbysauce/opencode-swarm/commit/cf2fca75b8f1a22346ddb96d90ff4473e1f93e2c))

## [6.67.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.66.0...v6.67.0) (2026-04-13)


### Features

* **council:** harden evidence writer and add round-history audit logging ([#481](https://github.com/zaxbysauce/opencode-swarm/issues/481)) ([f65ff7a](https://github.com/zaxbysauce/opencode-swarm/commit/f65ff7a95b24ee91c10e1fb9283333a0a54fb412)), closes [#478](https://github.com/zaxbysauce/opencode-swarm/issues/478)

## [6.66.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.65.0...v6.66.0) (2026-04-13)


### Features

* **council:** add Work Complete Council verification gate (convene_council tool) ([#477](https://github.com/zaxbysauce/opencode-swarm/issues/477)) ([62faff3](https://github.com/zaxbysauce/opencode-swarm/commit/62faff3e5e8f132b3200b6275480621a64729145))

## [6.65.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.64.0...v6.65.0) (2026-04-13)


### Features

* **repo-graph:** add workspace dependency graph with hook wiring and hardening ([#475](https://github.com/zaxbysauce/opencode-swarm/issues/475)) ([14bfefe](https://github.com/zaxbysauce/opencode-swarm/commit/14bfefe5649d15071c203215cffc90c1ad58d29b))

## [6.64.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.63.0...v6.64.0) (2026-04-12)


### Features

* **graph:** repo map / code graph for structural awareness ([#469](https://github.com/zaxbysauce/opencode-swarm/issues/469)) ([c17e0d5](https://github.com/zaxbysauce/opencode-swarm/commit/c17e0d515e109ab5cb4b429a2459bdcdbe617434))

## [6.63.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.62.0...v6.63.0) (2026-04-11)


### Features

* **plan:** wire crash-safe ledger, typed concurrency errors, and task-id validator consolidation ([#467](https://github.com/zaxbysauce/opencode-swarm/issues/467)) ([e9a96eb](https://github.com/zaxbysauce/opencode-swarm/commit/e9a96eb9eaf1972c9be8ed1ec30b08252502a13a))

## [6.62.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.61.0...v6.62.0) (2026-04-11)


### Features

* **critic:** expose loadLastApprovedPlan as get_approved_plan tool for drift comparison ([#458](https://github.com/zaxbysauce/opencode-swarm/issues/458)) ([68402ab](https://github.com/zaxbysauce/opencode-swarm/commit/68402ab1da38b556b45108f1041342fbe4fa779a))

## [6.61.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.60.1...v6.61.0) (2026-04-11)


### Features

* **registry:** add command documentation discoverability with structured metadata ([#455](https://github.com/zaxbysauce/opencode-swarm/issues/455)) ([9c2cb2f](https://github.com/zaxbysauce/opencode-swarm/commit/9c2cb2fe7bb2b6deceb575867218e8bebeb93570))

## [6.60.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.60.0...v6.60.1) (2026-04-10)


### Bug Fixes

* **guardrails:** resolve 6 non-blocking gaps from post-merge review ([#453](https://github.com/zaxbysauce/opencode-swarm/issues/453)) ([b201954](https://github.com/zaxbysauce/opencode-swarm/commit/b201954a58c93bb89dfdee252958403b3a9dcd92))

## [6.60.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.59.0...v6.60.0) (2026-04-09)


### Features

* add ci-fixer agent for staged CI failure remediation ([5eed865](https://github.com/zaxbysauce/opencode-swarm/commit/5eed865cc013d2d5d7a64f9083fc510086128272))

## [6.59.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.58.0...v6.59.0) (2026-04-09)


### Features

* **agents:** add state-of-the-art PR review agent ([6107ce1](https://github.com/zaxbysauce/opencode-swarm/commit/6107ce100d0493ff01a49ab80b3cd0d075f4fdf4))
* **explorer:** complete role hardening and fix 15 stale test failures ([5b87ee3](https://github.com/zaxbysauce/opencode-swarm/commit/5b87ee35ca6839774b349649a26eb437b6551360))
* **explorer:** complete role hardening and fix 15 stale test failures ([#447](https://github.com/zaxbysauce/opencode-swarm/issues/447)) ([1dc73a3](https://github.com/zaxbysauce/opencode-swarm/commit/1dc73a31174c5fb2fd6e0a1236ca547d0d2ecce6))


### Bug Fixes

* **close,plan:** harden Step 4b recovery and close-time ledger cleanup ([#446](https://github.com/zaxbysauce/opencode-swarm/issues/446)) ([721fe1a](https://github.com/zaxbysauce/opencode-swarm/commit/721fe1a50aa940a5f6b3c043db9e20dd21e8b673))

## [6.58.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.57.0...v6.58.0) (2026-04-08)


### Features

* **architect:** add structured spec format with RFC 2119 keywords and requirement coverage tracking ([#440](https://github.com/zaxbysauce/opencode-swarm/issues/440)) ([8f821a6](https://github.com/zaxbysauce/opencode-swarm/commit/8f821a6e9546a0be677456107a9b9a46ae49e688))

## [6.57.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.56.0...v6.57.0) (2026-04-08)


### Features

* **authority:** add glob pattern support and enhanced file authority rules ([#437](https://github.com/zaxbysauce/opencode-swarm/issues/437)) ([312d64a](https://github.com/zaxbysauce/opencode-swarm/commit/312d64a26610ad75d2da82f39a1b6c0f5edd6803))

## [6.56.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.55.0...v6.56.0) (2026-04-08)


### Features

* **reliability:** implement [#401](https://github.com/zaxbysauce/opencode-swarm/issues/401) reliability backlog + [#398](https://github.com/zaxbysauce/opencode-swarm/issues/398) environment profiling ([#435](https://github.com/zaxbysauce/opencode-swarm/issues/435)) ([2dc8bf2](https://github.com/zaxbysauce/opencode-swarm/commit/2dc8bf2ead9f73ccd98927294e2e28eaf8c1faf2))

## [6.55.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.54.0...v6.55.0) (2026-04-08)


### Features

* **conflict-resolution:** add conflict resolution mechanisms (Issue [#414](https://github.com/zaxbysauce/opencode-swarm/issues/414)) ([#433](https://github.com/zaxbysauce/opencode-swarm/issues/433)) ([c5759bd](https://github.com/zaxbysauce/opencode-swarm/commit/c5759bdb399f6a7f902fa30b40debac8c469fa38))

## [6.54.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.53.7...v6.54.0) (2026-04-07)


### Features

* **php:** content-based Larastan detection in getLaravelCommandOverlay ([#431](https://github.com/zaxbysauce/opencode-swarm/issues/431)) ([10f6b9b](https://github.com/zaxbysauce/opencode-swarm/commit/10f6b9b251229b42c89740032fdbc52e3bb7e312))

## [6.53.7](https://github.com/zaxbysauce/opencode-swarm/compare/v6.53.6...v6.53.7) (2026-04-07)


### Bug Fixes

* **security:** strip invisible unicode format chars before dangerous command pattern matching ([#429](https://github.com/zaxbysauce/opencode-swarm/issues/429)) ([70cb47c](https://github.com/zaxbysauce/opencode-swarm/commit/70cb47c7ca0e7682a74de216fa1f3da2aec00fdf))

## [6.53.6](https://github.com/zaxbysauce/opencode-swarm/compare/v6.53.5...v6.53.6) (2026-04-07)


### Bug Fixes

* **curator:** guard null knowledge config ([#425](https://github.com/zaxbysauce/opencode-swarm/issues/425)) ([1abb0bf](https://github.com/zaxbysauce/opencode-swarm/commit/1abb0bf3ba3466420664bc2cf00d8b326c63dbdc))

## [6.53.5](https://github.com/zaxbysauce/opencode-swarm/compare/v6.53.4...v6.53.5) (2026-04-07)


### Bug Fixes

* resolve four verified defects in swarm plugin commands ([#423](https://github.com/zaxbysauce/opencode-swarm/issues/423)) ([5cb73f1](https://github.com/zaxbysauce/opencode-swarm/commit/5cb73f18fab5b0506b210414b2abd7b68dc4b1a2))

## [6.53.4](https://github.com/zaxbysauce/opencode-swarm/compare/v6.53.3...v6.53.4) (2026-04-07)


### Bug Fixes

* **plan:** preserve ledger during identity change ([#421](https://github.com/zaxbysauce/opencode-swarm/issues/421)) ([d4a3a75](https://github.com/zaxbysauce/opencode-swarm/commit/d4a3a75c752d2589d1cfc783417a68d2644e7d2d))

## [6.53.3](https://github.com/zaxbysauce/opencode-swarm/compare/v6.53.2...v6.53.3) (2026-04-06)


### Bug Fixes

* **commands:** add config-doctor and evidence-summary shortcut aliases, fix tests and lint ([#419](https://github.com/zaxbysauce/opencode-swarm/issues/419)) ([377ed19](https://github.com/zaxbysauce/opencode-swarm/commit/377ed198850670bc87e654c89e48ffce882d552f))

## [6.53.2](https://github.com/zaxbysauce/opencode-swarm/compare/v6.53.1...v6.53.2) (2026-04-06)


### Bug Fixes

* **build:** rebuild dist files to include full-auto command registration ([735add6](https://github.com/zaxbysauce/opencode-swarm/commit/735add6c452fc918710873cacf9b813023b44fd2))

## [6.53.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.53.0...v6.53.1) (2026-04-06)


### Bug Fixes

* **ci:** add timeout, bun cache, and skip tsc in publish-npm job ([9440aa1](https://github.com/zaxbysauce/opencode-swarm/commit/9440aa1f899c4cf1b99ddb28063435d6250dd03d))

## [6.53.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.52.0...v6.53.0) (2026-04-06)


### Features

* **full-auto:** add /swarm full-auto per-session toggle command and fix TUI registration ([#415](https://github.com/zaxbysauce/opencode-swarm/issues/415)) ([160fbe0](https://github.com/zaxbysauce/opencode-swarm/commit/160fbe0b2e359341423bf6636756b7e93e37ccc6))

## [6.52.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.51.0...v6.52.0) (2026-04-06)


### Features

* add /swarm full-auto per-session toggle command ([#412](https://github.com/zaxbysauce/opencode-swarm/issues/412)) ([98422a7](https://github.com/zaxbysauce/opencode-swarm/commit/98422a7b91a2535791f18eb99158bc6256895e45))

## [6.51.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.50.0...v6.51.0) (2026-04-06)


### Features

* add full-auto mode for autonomous swarm operation ([#410](https://github.com/zaxbysauce/opencode-swarm/issues/410)) ([0500ece](https://github.com/zaxbysauce/opencode-swarm/commit/0500ecea4c5b12726ed522cf23fdf325937f9356))

## [6.50.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.49.0...v6.50.0) (2026-04-05)


### Features

* knowledge system + plan sync overhaul ([#408](https://github.com/zaxbysauce/opencode-swarm/issues/408)) ([9b860bb](https://github.com/zaxbysauce/opencode-swarm/commit/9b860bb7f58e0faa219917b1e93979ba7b9be2d0))

## [6.49.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.48.0...v6.49.0) (2026-04-05)


### Features

* **php:** add PHP first-class support and Laravel baseline detection ([#405](https://github.com/zaxbysauce/opencode-swarm/issues/405)) ([e7fc761](https://github.com/zaxbysauce/opencode-swarm/commit/e7fc761d54f9d3c4b6870d5c67cbfc93a827c051))

## [6.48.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.47.2...v6.48.0) (2026-04-04)


### Features

* **tools:** tool audit, regression sweep fixes, concurrent write safety, and doctor expansion ([#399](https://github.com/zaxbysauce/opencode-swarm/issues/399)) ([ac90de7](https://github.com/zaxbysauce/opencode-swarm/commit/ac90de7afeb451574e462a13675d0ea990bba08f))


## [Unreleased]

### Features

* **php:** PHP profile extended with complete command surface: Composer install/build, PHPUnit + Pest detection (Pest at priority 1), PHPStan static analysis (phpstan.neon priority 1, phpstan.neon.dist priority 2), Pint/PHP-CS-Fixer lint (Pint priority 3, PHP-CS-Fixer priority 4)
* **php:** PHP package manager (Composer) is now a first-class build ecosystem detected by the swarm (`composer.lock` detection, `php-composer` ecosystem entry in discovery)
* **php:** `composer audit --locked --format=json` wired through the `pkg_audit` tool pipeline with structured JSON output and correct exit-code semantics (0=clean, 1=vulnerabilities, 2=abandoned packages only)
* **laravel:** add deterministic Laravel framework detection via `src/lang/framework-detector.ts` � multi-signal logic requires 2-of-3 signals (artisan file, laravel/framework dep, config/app.php)
* **laravel:** `getLaravelCommandOverlay()` returns `php artisan test`, Pint/PHP-CS-Fixer lint, PHPStan static analysis, and `composer audit --locked --format=json` when Laravel is detected
* **laravel:** three new Laravel-specific SAST rules in `src/sast/rules/php.ts`: `sast/php-laravel-sql-injection` (high), `sast/php-laravel-mass-assignment` (medium), `sast/php-laravel-destructive-migration` (medium)
* **laravel:** `.blade.php` files explicitly included in `placeholder_scan` and `todo_extract` SUPPORTED_EXTENSIONS
* **laravel:** `test_engineer` agents now receive Laravel-specific test guidance via `buildLanguageTestConstraints()` (feature vs unit tests, Pest/PHPUnit coexistence, `.env.testing`)
* **ci:** add dedicated `php-validation` job to CI pipeline (`.github/workflows/ci.yml`) � runs on every push via `shivammathur/setup-php` action with PHP 8.2 and Composer, validates PHP/Laravel command-selection behavior before smoke tests run
* **ci:** `smoke` job in CI now depends on `php-validation` � PHP validation is a required predecessor gate blocking the smoke test run
* **tests:** add `tests/integration/php-command-selection.test.ts` with 20 fixture-driven integration tests covering command selection for PHPUnit-only, Pest-only, and mixed Pest/PHPUnit project configurations
* **php:** PHP profile `testConstraints` in `src/lang/profiles.ts` extended from 5 to 8 entries � added `.env.testing` coverage, `php artisan config:clear` guidance, and parallel database worker test guidance for Laravel projects
* **doctor:** add `/swarm doctor tools` subcommand with three checks: (1) tool registration coherence � every TOOL_NAMES entry has a key in the plugin's tool: {} block in src/index.ts, (2) AGENT_TOOL_MAP alignment � tools assigned to agents are registered in the plugin, (3) Class 3 binary readiness � external lint binaries (ruff, cargo, golangci-lint, mvn, gradle, dotnet, swift, swiftlint, dart, flutter, eslint) available on PATH
* **explorer:** Phase 2 hardening — explorer is now strictly factual/observational
  - Added `COMPLEXITY INDICATORS` (cyclomatic complexity, deep nesting, large files, inheritance/type hierarchies), `OBSERVED CHANGES` (what changed in referenced files), `CONSUMERS_AFFECTED` (integration impact), `RELEVANT CONSTRAINTS` (architectural patterns, conventions), and `FOLLOW-UP CANDIDATE AREAS` (observable conditions for later review)
  - Renamed `RISKS` → `COMPLEXITY INDICATORS` and `RUNTIME/BEHAVIORAL CONCERNS`
  - Removed judgmental language: `VERDICT`, `REVIEW NEEDED`, `MIGRATION_NEEDED`, `dead`, `missing` labels
  - `VERDICT` → `COMPATIBILITY SIGNALS` (COMPATIBLE/INCOMPATIBLE/UNCERTAIN); `MIGRATION_NEEDED` → `MIGRATION_SURFACE`
  - Curator prompts recast: `KNOWLEDGE_UPDATES` → `OBSERVATIONS`; all directive language replaced with observational language
  - Added concrete examples to all OUTPUT FORMAT sections
  - `createExplorerAgent` description updated to reflect broader scope (identifies areas where specialized domain knowledge may be beneficial)
* **concurrency:** add file locking for concurrent write safety
  - `update_task_status` acquires a **hard lock** on `plan.json` before writing — lock losers return `success: false` with `recovery_guidance: "retry"` and the write is blocked
  - `phase_complete` acquires an **advisory lock** on `events.jsonl` before appending — if the lock is unavailable, a warning is added and the write proceeds unconditionally (duplicate concurrent appends are possible but do not corrupt the append-only log)
  - Lock implementation uses `proper-lockfile` with `retries: 0` (fail-fast)

### Tests

* **tests:** add 14 tests in `tests/unit/config/schema.test.ts` covering `full_auto` config schema validation (defaults, invalid `escalation_mode`, out-of-range `max_interactions_per_phase`, partial overrides, and snapshot)
* **tests:** add 4 tests in `tests/unit/agents/critic.test.ts` covering `createCriticAutonomousOversightAgent` (creation, model fallbacks, autonomous mode activation)
* **tests:** add `tests/unit/hooks/full-auto-intercept.test.ts` with 32 unit tests covering intercept detection logic for the full-auto mode hook
* **tests:** add `tests/unit/hooks/full-auto-intercept.adversarial.test.ts` with 38 adversarial tests covering edge cases, concurrent execution, and error paths in full-auto intercept detection
* **tests:** add `tests/integration/full-auto-mode.test.ts` with 15 integration tests covering end-to-end full-auto mode scenarios
* **tests:** fix pre-existing snapshot test in `tests/unit/config/schema.test.ts` to include `full_auto` defaults

### Documentation

* **docs:** add [v6.49.0 release notes](docs/releases/v6.49.0.md) with PHP first-class support scope, Laravel baseline command/tool/scanner inventory, and explicit deferral list
* **docs:** add [PHP/Laravel practical guide](docs/php-laravel.md) covering generic Composer project detection, Laravel detection and command override, Pest/PHPUnit coexistence, Composer audit output, and Blade/Eloquent SAST coverage summary

## [6.47.2](https://github.com/zaxbysauce/opencode-swarm/compare/v6.47.1...v6.47.2) (2026-04-04)


### Bug Fixes

* **curator:** add validation gate to new-entry loop and strict entry_id in curator_analyze ([#390](https://github.com/zaxbysauce/opencode-swarm/issues/390)) ([f636d68](https://github.com/zaxbysauce/opencode-swarm/commit/f636d68e7007350e3dd85777a2638f69e93264c8))

## [6.47.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.47.0...v6.47.1) (2026-04-03)


### Bug Fixes

* **plan:** resolve PlanSyncWorker aggressive revert and ledger identity bugs ([#388](https://github.com/zaxbysauce/opencode-swarm/issues/388)) ([d1772ef](https://github.com/zaxbysauce/opencode-swarm/commit/d1772ef21d7f24701ff7ac4ac911a1547174b63c))

## [6.47.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.46.0...v6.47.0) (2026-04-03)


### Features

* **close:** align /swarm close with full session close-out workflow ([73bba56](https://github.com/zaxbysauce/opencode-swarm/commit/73bba5658626123fb9245c82726202e196a277c7))
* **close:** align /swarm close with full session close-out workflow ([#387](https://github.com/zaxbysauce/opencode-swarm/issues/387)) ([509b9be](https://github.com/zaxbysauce/opencode-swarm/commit/509b9bebd921dac0619cf2bbea9111a928c81bde))

## [6.46.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.45.1...v6.46.0) (2026-04-03)


### Features

* **authority:** add configurable per-agent file write authority rules ([#378](https://github.com/zaxbysauce/opencode-swarm/issues/378)) ([070fd44](https://github.com/zaxbysauce/opencode-swarm/commit/070fd44013ad47b554de8f85ed925689784b5564))

## [6.45.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.45.0...v6.45.1) (2026-04-02)


### Bug Fixes

* **curator:** fix LLM hallucinated entry_id causing silent data loss ([#379](https://github.com/zaxbysauce/opencode-swarm/issues/379)) ([aaf7166](https://github.com/zaxbysauce/opencode-swarm/commit/aaf71668d6fc3a899800679055bef1ea1a07e2e5))

## [6.45.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.44.3...v6.45.0) (2026-04-02)


### Features

* **swarm:** add search, suggest_patch, batch_symbols tools and test drift detection ([#376](https://github.com/zaxbysauce/opencode-swarm/issues/376)) ([c611044](https://github.com/zaxbysauce/opencode-swarm/commit/c61104429b1ec37bbf3cebf597eae21ea5d25791))

## [6.44.3](https://github.com/zaxbysauce/opencode-swarm/compare/v6.44.2...v6.44.3) (2026-04-02)


### Bug Fixes

* **tests:** resolve CI test failures on macOS, ubuntu, and Windows ([#374](https://github.com/zaxbysauce/opencode-swarm/issues/374)) ([5300213](https://github.com/zaxbysauce/opencode-swarm/commit/5300213a5905f1f19cbc49bbdf12245c040d78ee))

## [6.44.2](https://github.com/zaxbysauce/opencode-swarm/compare/v6.44.1...v6.44.2) (2026-04-02)


### Bug Fixes

* **ci:** remove continue-on-error and resolve 50+ pre-existing test failures ([#372](https://github.com/zaxbysauce/opencode-swarm/issues/372)) ([9ced9e6](https://github.com/zaxbysauce/opencode-swarm/commit/9ced9e6a6d7d9d10431627cd83887eacc4ed2fe0))

## [6.44.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.44.0...v6.44.1) (2026-04-01)


### Bug Fixes

* **ci:** resolve 22 integration test failures and add per-file subprocess isolation ([#370](https://github.com/zaxbysauce/opencode-swarm/issues/370)) ([aefd95f](https://github.com/zaxbysauce/opencode-swarm/commit/aefd95f2d4ce9100f361892fabea69ec4512ff34))

## [6.44.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.43.2...v6.44.0) (2026-04-01)


### Features

* **plan:** add durable ledger, capability source-of-truth, and verification hardening ([#368](https://github.com/zaxbysauce/opencode-swarm/issues/368)) ([806c9d2](https://github.com/zaxbysauce/opencode-swarm/commit/806c9d275914d3ca888af1779a46d55f4d5acba4))

## [6.43.2](https://github.com/zaxbysauce/opencode-swarm/compare/v6.43.1...v6.43.2) (2026-04-01)


### Bug Fixes

* **curator:** prevent re-trigger loop, session leak, and task counting bug ([#366](https://github.com/zaxbysauce/opencode-swarm/issues/366)) ([871c657](https://github.com/zaxbysauce/opencode-swarm/commit/871c65761c32d860bfe3e4476c665da38cc223d8))

## [6.43.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.43.0...v6.43.1) (2026-04-01)


### Bug Fixes

* **curator:** resolve model via explorer agent, not own DEFAULT_MODELS entry ([#363](https://github.com/zaxbysauce/opencode-swarm/issues/363)) ([7c5b66c](https://github.com/zaxbysauce/opencode-swarm/commit/7c5b66ce792dc8ee95f645b1240b830678e17235))

## [6.43.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.42.1...v6.43.0) (2026-04-01)


### Features

* **curator:** register curator as named swarm agent pair (fixes TUI crash) ([#360](https://github.com/zaxbysauce/opencode-swarm/issues/360)) ([6a5a5e0](https://github.com/zaxbysauce/opencode-swarm/commit/6a5a5e0b2a73174c2361816a3fefb4df4f404aef))

## [6.42.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.42.0...v6.42.1) (2026-03-31)


### Bug Fixes

* **curator:** remove agent field from ephemeral session prompt to prevent crash ([#358](https://github.com/zaxbysauce/opencode-swarm/issues/358)) ([9899978](https://github.com/zaxbysauce/opencode-swarm/commit/9899978207b777168c0541ed20a035cea6e71915))

## [6.42.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.41.4...v6.42.0) (2026-03-31)


### Features

* **curator:** wire llm delegation to explorer-as-curator agent ([#356](https://github.com/zaxbysauce/opencode-swarm/issues/356)) ([5f42c85](https://github.com/zaxbysauce/opencode-swarm/commit/5f42c853b82d8187cfdd160da4d4660c31a5437c))

## [6.41.4](https://github.com/zaxbysauce/opencode-swarm/compare/v6.41.3...v6.41.4) (2026-03-31)


### Bug Fixes

* **knowledge:** fix dark matter pipeline G�� scope filter, npmi threshold, retroactive repair ([#354](https://github.com/zaxbysauce/opencode-swarm/issues/354)) ([1fdd5de](https://github.com/zaxbysauce/opencode-swarm/commit/1fdd5de5e609d5cd5fa769156961e44b93b9f7d9))

## [6.41.3](https://github.com/zaxbysauce/opencode-swarm/compare/v6.41.2...v6.41.3) (2026-03-31)


### Bug Fixes

* **swarm:** resolve .swarm/ paths from working_directory, fix test_runner crash and pipe deadlocks ([#352](https://github.com/zaxbysauce/opencode-swarm/issues/352)) ([931c80a](https://github.com/zaxbysauce/opencode-swarm/commit/931c80abb4b1564a38901961139dfd2f3838dbda))

## [6.41.2](https://github.com/zaxbysauce/opencode-swarm/compare/v6.41.1...v6.41.2) (2026-03-30)


### Bug Fixes

* **swarm:** resolve Kimi K2 save_plan loop, completion_verify research task blocking, and files_touched path traversal ([#350](https://github.com/zaxbysauce/opencode-swarm/issues/350)) ([e093792](https://github.com/zaxbysauce/opencode-swarm/commit/e093792b8cd3a209110051a677f6a71d6d5bdaa9))

## [6.41.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.41.0...v6.41.1) (2026-03-30)


### Bug Fixes

* **guardrails:** normalize absolute paths in file authority and scope checks ([#259](https://github.com/zaxbysauce/opencode-swarm/issues/259)) ([#348](https://github.com/zaxbysauce/opencode-swarm/issues/348)) ([94b06d1](https://github.com/zaxbysauce/opencode-swarm/commit/94b06d1aaf6220f30d74b35c512eff6f14cb95a1))
* **tests:** resolve 6 pre-existing tech debt test failures from v6.23-v6.40 ([#346](https://github.com/zaxbysauce/opencode-swarm/issues/346)) ([c93c24c](https://github.com/zaxbysauce/opencode-swarm/commit/c93c24c0b0f20d7e2d7ad349e904f5deb2c1cb28))

## [6.41.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.40.8...v6.41.0) (2026-03-30)


### Features

* **swarm:** v6.41.0 dark matter pipeline, /swarm close, writeDriftEvidence tool ([#343](https://github.com/zaxbysauce/opencode-swarm/issues/343)) ([b324ce1](https://github.com/zaxbysauce/opencode-swarm/commit/b324ce176b172eb5920d1008b1ebfa2f8b8da0d3))


### Bug Fixes

* **swarm:** address 16 QA findings in v6.41.0 ([#345](https://github.com/zaxbysauce/opencode-swarm/issues/345)) ([628624f](https://github.com/zaxbysauce/opencode-swarm/commit/628624f57b5caad7db1551faaebe62dae4307da2))

## [Unreleased]

### Features

- **dark-matter:** Add dark matter detection pipeline during DISCOVER mode
  - `co_change_analyzer` tool registered for co-change analysis
  - Automatic scan during system enhancement with git history analysis
  - Auto-generates knowledge entries from dark matter results (category: architecture)
  - Architect guidance to check co-change partners after declare_scope

- **commands:** Add `/swarm close` command for idempotent project close
  - Writes retrospectives for in-progress phases
  - Curates lessons via curateAndStoreSwarm
  - Sets closed status on non-completed phases/tasks
  - Archives evidence and writes close-summary.md
  - Clears agentSessions and delegationChains

- **session:** Reset-session now cleans session directory contents
  - After deleting state.json, cleans all files in .swarm/session/ except state.json

- **phase:** Wire endAgentSession at phase boundaries
  - Calls endAgentSession for sessions no longer active after phase transition

- **commands:** Add 8 missing commands to /swarm help text
  - turbo, write-retro, reset-session, simulate, promote, checkpoint, config-doctor, evidence-summary

- **tools:** Add `write_drift_evidence` tool for persisting drift verification evidence
  - Accepts phase number, verdict (APPROVED/NEEDS_REVISION), and summary from architect
  - Normalizes verdict: APPROVED G�� approved, NEEDS_REVISION G�� rejected
  - Writes gate-contract formatted evidence to `.swarm/evidence/{phase}/drift-verifier.json`
  - Called after critic_drift_verifier delegation to persist verification results

## [6.40.8](https://github.com/zaxbysauce/opencode-swarm/compare/v6.40.7...v6.40.8) (2026-03-30)


### Bug Fixes

* **delegation-gate:** detect and reset stale coder_delegated state from prior sessions ([#341](https://github.com/zaxbysauce/opencode-swarm/issues/341)) ([bfe1303](https://github.com/zaxbysauce/opencode-swarm/commit/bfe130305385047306f013921124a57d3e67c170))

## [6.40.7](https://github.com/zaxbysauce/opencode-swarm/compare/v6.40.6...v6.40.7) (2026-03-30)


### Bug Fixes

* **lang:** use web-tree-sitter WASM binary instead of @vscode/tree-sitter-wasm ([#339](https://github.com/zaxbysauce/opencode-swarm/issues/339)) ([a844bf2](https://github.com/zaxbysauce/opencode-swarm/commit/a844bf2529b38e643a0c5e6155d54334547c233b))

## [6.40.6](https://github.com/zaxbysauce/opencode-swarm/compare/v6.40.5...v6.40.6) (2026-03-30)


### Bug Fixes

* **lang:** resolve WASM asset path resolution for bundled npm installs ([#337](https://github.com/zaxbysauce/opencode-swarm/issues/337)) ([05c0135](https://github.com/zaxbysauce/opencode-swarm/commit/05c01352c3b155a1f7793dfae633d07abcb4387e))

## [6.40.5](https://github.com/zaxbysauce/opencode-swarm/compare/v6.40.4...v6.40.5) (2026-03-30)


### Bug Fixes

* **sast:** skip coder rejection for pre-existing SAST findings on unchanged lines ([#335](https://github.com/zaxbysauce/opencode-swarm/issues/335)) ([7a7f68a](https://github.com/zaxbysauce/opencode-swarm/commit/7a7f68a36d7f188a5bd1c372553489ba59dc42af))

## [6.40.4](https://github.com/zaxbysauce/opencode-swarm/compare/v6.40.3...v6.40.4) (2026-03-30)


### Bug Fixes

* **state:** prevent evidence rehydration from downgrading workflow state ([#333](https://github.com/zaxbysauce/opencode-swarm/issues/333)) ([d879aeb](https://github.com/zaxbysauce/opencode-swarm/commit/d879aebf3e5d5d4a98788a5473f78fd3b0f00752))

## [6.40.3](https://github.com/zaxbysauce/opencode-swarm/compare/v6.40.2...v6.40.3) (2026-03-29)


### Bug Fixes

* **ci:** isolate mock.module to prevent --smol cache poisoning ([#331](https://github.com/zaxbysauce/opencode-swarm/issues/331)) ([767a756](https://github.com/zaxbysauce/opencode-swarm/commit/767a75657f28764aa9ee38afdd16943a05cc4efc))

## [6.40.2](https://github.com/zaxbysauce/opencode-swarm/compare/v6.40.1...v6.40.2) (2026-03-29)


### Bug Fixes

* **session:** align writeSnapshot error logging with OPENCODE_SWARM_DEBUG flag ([#327](https://github.com/zaxbysauce/opencode-swarm/issues/327)) ([9458022](https://github.com/zaxbysauce/opencode-swarm/commit/945802203dbc596a914385abb96933048b86fca7))

## [6.40.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.40.0...v6.40.1) (2026-03-29)


### Bug Fixes

* **ci:** preserve release-please markers when updating PR body ([#323](https://github.com/zaxbysauce/opencode-swarm/issues/323)) ([7c4309d](https://github.com/zaxbysauce/opencode-swarm/commit/7c4309dd249c3c54ff5ff8ee4700a4efe103d182))

## [6.40.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.39.0...v6.40.0) (2026-03-29)


### Features

* **swarm:** resolve remaining QA findings G�� service layer fixes, config wiring, test improvements, and hardening ([#320](https://github.com/zaxbysauce/opencode-swarm/issues/320)) ([93253b1](https://github.com/zaxbysauce/opencode-swarm/commit/93253b14a83f566f3109dceb981fb5d6001d9e2b))

## [6.39.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.38.0...v6.39.0) (2026-03-29)


### Features

* **swarm:** fix tool registry coherence G�� complete tool-names, AGENT_TOOL_MAP, doc_scan wiring, and path-security consolidation ([#317](https://github.com/zaxbysauce/opencode-swarm/issues/317)) ([aa30a93](https://github.com/zaxbysauce/opencode-swarm/commit/aa30a93b5b4f35832a073a6a54287ce7e2f62d8b))

## [6.38.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.37.0...v6.38.0) (2026-03-29)


### Features

* **swarm:** wire dead infrastructure G�� curator LLM delegation, automation manager, AST diff, adversarial detector, compaction service, parallel framework ([#315](https://github.com/zaxbysauce/opencode-swarm/issues/315)) ([d043c76](https://github.com/zaxbysauce/opencode-swarm/commit/d043c76d080223eeb035c8c73846612910716a36))

## [6.37.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.36.0...v6.37.0) (2026-03-28)


### Features

* **swarm:** fix trust-critical findings G�� secretscan regex, evidence rehydration, model fallback, reviewer gate, architect tools ([#313](https://github.com/zaxbysauce/opencode-swarm/issues/313)) ([bcb5600](https://github.com/zaxbysauce/opencode-swarm/commit/bcb5600db2d73dc7be71d096b10f09a702a752d5))

## [6.36.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.35.4...v6.36.0) (2026-03-28)


### Features

* **swarm:** add critic drift verifier, fix curator pipeline, and sanitize stack traces ([227bcb5](https://github.com/zaxbysauce/opencode-swarm/commit/227bcb5bd9d671a828a9669c4c2cf1253fc47955))
* **swarm:** add critic drift verifier, fix curator pipeline, and sanitize stack traces ([#311](https://github.com/zaxbysauce/opencode-swarm/issues/311)) ([978c6f9](https://github.com/zaxbysauce/opencode-swarm/commit/978c6f9c5fd9e71a1c3a530e9dd487ad124ac11c))

## [6.35.4](https://github.com/zaxbysauce/opencode-swarm/compare/v6.35.3...v6.35.4) (2026-03-28)


### Bug Fixes

* **knowledge:** register doc tools, fix injector no-plan and first-call skip, add scope filter, and prevent pipeline stall ([#306](https://github.com/zaxbysauce/opencode-swarm/issues/306)) ([6e423dc](https://github.com/zaxbysauce/opencode-swarm/commit/6e423dce16d266f5616634b1189b596ef383d683))

## [6.35.3](https://github.com/zaxbysauce/opencode-swarm/compare/v6.35.2...v6.35.3) (2026-03-27)


### Bug Fixes

* **tests:** resolve 48 broken unit test assertions across 16 files in tools test suite ([#302](https://github.com/zaxbysauce/opencode-swarm/issues/302)) ([efcecc3](https://github.com/zaxbysauce/opencode-swarm/commit/efcecc31a70e102064826df3e93a9968cae72253))

## [6.35.2](https://github.com/zaxbysauce/opencode-swarm/compare/v6.35.1...v6.35.2) (2026-03-27)


### Bug Fixes

* drift evidence write, gate fallback, runaway output detector, and eliminate critic_drift_verifier agent ([#298](https://github.com/zaxbysauce/opencode-swarm/issues/298)) ([ba04892](https://github.com/zaxbysauce/opencode-swarm/commit/ba04892f45f5da3df7de7df0516fb348053e9811))

## [6.35.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.35.0...v6.35.1) (2026-03-26)


### Bug Fixes

* **telemetry:** resolve actual primary model name in modelFallback events ([2d12a58](https://github.com/zaxbysauce/opencode-swarm/commit/2d12a58b83c4884f5554e3905ad09b3ac83066e3))

## [6.35.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.34.0...v6.35.0) (2026-03-26)


### Features

* **swarm:** modernize agent prompts, deduplicate path security, and fix evidence pipeline ([#295](https://github.com/zaxbysauce/opencode-swarm/issues/295)) ([9d4f47d](https://github.com/zaxbysauce/opencode-swarm/commit/9d4f47d86c870de1b175aefc15b32d78d6c77473))

## [6.34.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.33.9...v6.34.0) (2026-03-26)


### Features

* **swarm:** add critic phase drift gate, deterministic completion-verify, and telemetry emitter ([#293](https://github.com/zaxbysauce/opencode-swarm/issues/293)) ([5d17521](https://github.com/zaxbysauce/opencode-swarm/commit/5d175219a2fb00f016fe62018c9363c9c09923b4))

## [6.33.9](https://github.com/zaxbysauce/opencode-swarm/compare/v6.33.8...v6.33.9) (2026-03-26)


### Bug Fixes

* remove hook chain timeout, restore correct Task handoff order, and async evidence rename ([1784a20](https://github.com/zaxbysauce/opencode-swarm/commit/1784a2021d9b00f8e6d8da9da2ed42b5c20964e2))

## [6.33.8](https://github.com/zaxbysauce/opencode-swarm/compare/v6.33.7...v6.33.8) (2026-03-26)


### Bug Fixes

* **session:** gate all diagnostic logging behind DEBUG_SWARM env var ([#287](https://github.com/zaxbysauce/opencode-swarm/issues/287)) ([a70bf04](https://github.com/zaxbysauce/opencode-swarm/commit/a70bf0428a19ea7a7eae3fbd81d28d67316defdc))

## [6.33.7](https://github.com/zaxbysauce/opencode-swarm/compare/v6.33.6...v6.33.7) (2026-03-26)


### Bug Fixes

* **session:** prevent session freeze by moving task handoff before hooks and adding timeout protection ([#285](https://github.com/zaxbysauce/opencode-swarm/issues/285)) ([7156cff](https://github.com/zaxbysauce/opencode-swarm/commit/7156cff19f4fcca3979acd4bd468af0e01d2054d))

## [6.33.6](https://github.com/zaxbysauce/opencode-swarm/compare/v6.33.5...v6.33.6) (2026-03-26)


### Bug Fixes

* prevent stale delegation reversion from hijacking active sub-agents ([2d24070](https://github.com/zaxbysauce/opencode-swarm/commit/2d24070ac3912842b523bd0de81fcddf201807c5))

## [6.33.5](https://github.com/zaxbysauce/opencode-swarm/compare/v6.33.4...v6.33.5) (2026-03-26)


### Bug Fixes

* **rehydration:** reset InvocationWindow counters and flags on startup ([#282](https://github.com/zaxbysauce/opencode-swarm/issues/282)) ([28e8a5a](https://github.com/zaxbysauce/opencode-swarm/commit/28e8a5a4e027bb0e5fc3fb860852f4514af0cf93))

## [6.33.4](https://github.com/zaxbysauce/opencode-swarm/compare/v6.33.3...v6.33.4) (2026-03-25)


### Bug Fixes

* prevent session eviction of rehydrated sessions on startup ([#280](https://github.com/zaxbysauce/opencode-swarm/issues/280)) ([12059af](https://github.com/zaxbysauce/opencode-swarm/commit/12059afb547abf5e7ae2fb390bad0fba4a79b712))

## [6.33.3](https://github.com/zaxbysauce/opencode-swarm/compare/v6.33.2...v6.33.3) (2026-03-25)


### Bug Fixes

* **session:** resolve typecheck errors and add snapshot schema version bump ([#278](https://github.com/zaxbysauce/opencode-swarm/issues/278)) ([12186d9](https://github.com/zaxbysauce/opencode-swarm/commit/12186d9ceba3c675c2e953cbd529ce8458413c87))

## [6.33.2](https://github.com/zaxbysauce/opencode-swarm/compare/v6.33.1...v6.33.2) (2026-03-25)


### Bug Fixes

* cleanup and hardening for v6.33.2 ([#276](https://github.com/zaxbysauce/opencode-swarm/issues/276)) ([ef59816](https://github.com/zaxbysauce/opencode-swarm/commit/ef59816cc142b3fe070fa694a7760d3f8644bc50))

## [Unreleased]

### Features

* **model-fallback:** add automatic fallback model detection for transient model failures (rate limit, 429, 503, timeout, overloaded, model not found). Agent config accepts optional `fallback_models` array (max 3) per agent. Guardrails injects MODEL FALLBACK advisory and tracks `model_fallback_index` + `modelFallbackExhausted` state. Resets on successful execution.
* **retrospective:** add `error_taxonomy` field to `RetrospectiveEvidenceSchema` G�� auto-classifies phase failures as `planning_error`, `interface_mismatch`, `logic_error`, `scope_creep`, or `gate_evasion` by scanning evidence bundles for the phase's tasks
* **doc-scan:** add two-pass documentation discovery G�� `doc_scan` (Pass 1) scans project docs and builds index manifest at `.swarm/doc-manifest.json` with mtime-based caching; `doc_extract` (Pass 2) scores docs against task context using Jaccard bigram similarity, extracts actionable constraints (MUST/SHOULD/DO NOT patterns), deduplicates via `findNearDuplicate`, and writes to `.swarm/knowledge.jsonl` as SwarmKnowledgeEntry objects
* **bounded-coder-revisions:** add `max_coder_revisions` config (default 5) to limit how many times a coder can be retried on a single task. When the limit is hit, a `CODER REVISION LIMIT` advisory is injected. State tracked via `coderRevisions` and `revisionLimitHit` in `AgentSessionState`, serialized/deserialized in session snapshots.
* **secretscan-evidence:** add `SecretscanEvidenceSchema` to evidence system with `findings_count`, `scan_directory`, `files_scanned`, `skipped_files` fields. `pre_check_batch` now persists secretscan results to evidence bundle after each scan. `check_gate_status` scans EvidenceBundle for secretscan entries and reports BLOCKED status if secrets were found. Add `isSecretscanEvidence` type guard for type-safe narrowing.

## [6.33.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.33.0...v6.33.1) (2026-03-25)


### Bug Fixes

* v6.33.1 stabilization G�� CRIT-1/2/3 bug fixes, session stability, stale state recovery, performance modes ([4bf5141](https://github.com/zaxbysauce/opencode-swarm/commit/4bf5141a809ab1dbd044a5d924359b5925b0b9c6))
* v6.33.1 stabilization G�� critical bug fixes, session stability, stale state recovery ([#273](https://github.com/zaxbysauce/opencode-swarm/issues/273)) ([d849378](https://github.com/zaxbysauce/opencode-swarm/commit/d84937889f48bfaaae901585cd024da3b4f8aaa4))

## [6.33.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.32.4...v6.33.0) (2026-03-25)


### Features

* phase-complete atomic staging, trajectory logging, and test isolation fixes ([#269](https://github.com/zaxbysauce/opencode-swarm/issues/269)) ([ddf0055](https://github.com/zaxbysauce/opencode-swarm/commit/ddf0055f177f12f558a094810e937a70803e40c7))

## [6.32.4](https://github.com/zaxbysauce/opencode-swarm/compare/v6.32.3...v6.32.4) (2026-03-24)


### Bug Fixes

* **test:** align test assertions with actual source behavior ([#266](https://github.com/zaxbysauce/opencode-swarm/issues/266)) ([fecd742](https://github.com/zaxbysauce/opencode-swarm/commit/fecd7421c1c59d7c6be87d67ee2882031f7f4868))

## [6.32.3](https://github.com/zaxbysauce/opencode-swarm/compare/v6.32.2...v6.32.3) (2026-03-24)


### Bug Fixes

* address 5 critical QA findings G�� lockfile safety, loop cap, temp file predictability, language ID whitelist, delegation path validation ([#264](https://github.com/zaxbysauce/opencode-swarm/issues/264)) ([18f73c3](https://github.com/zaxbysauce/opencode-swarm/commit/18f73c34149a4b30309eb65e7921290fdd8a7372))

## [6.32.2](https://github.com/zaxbysauce/opencode-swarm/compare/v6.32.1...v6.32.2) (2026-03-24)


### Bug Fixes

* **ci:** split hooks tests into 6 isolated groups to prevent vi.mock contamination ([#262](https://github.com/zaxbysauce/opencode-swarm/issues/262)) ([cedfbf4](https://github.com/zaxbysauce/opencode-swarm/commit/cedfbf4161cfe191758cd74eb56489f6634b3ddf))

## [6.32.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.32.0...v6.32.1) (2026-03-23)


### Bug Fixes

* **test:** update stale assertions and broken mocks across hooks, commands, and config tests ([#260](https://github.com/zaxbysauce/opencode-swarm/issues/260)) ([5e4bfa0](https://github.com/zaxbysauce/opencode-swarm/commit/5e4bfa0a37dd2315e668bb021913b09a87474c05))

## [6.32.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.31.4...v6.32.0) (2026-03-23)


### Features

* add truncation expansion, compaction hints, prompt hardening, and regression sweep ([#251](https://github.com/zaxbysauce/opencode-swarm/issues/251)) ([2f7e689](https://github.com/zaxbysauce/opencode-swarm/commit/2f7e68933b9574bd1f444fa7bf9a965c6ad0fff7))

## [6.31.4](https://github.com/zaxbysauce/opencode-swarm/compare/v6.31.3...v6.31.4) (2026-03-23)


### Bug Fixes

* **ci:** isolate cli tests from commands and remove hanging circular-mock test ([#254](https://github.com/zaxbysauce/opencode-swarm/issues/254)) ([c5c471f](https://github.com/zaxbysauce/opencode-swarm/commit/c5c471f7dc4cb099df52287f1f98e6980908ddb0))

## [6.31.3](https://github.com/zaxbysauce/opencode-swarm/compare/v6.31.2...v6.31.3) (2026-03-22)


### Bug Fixes

* **plan:** allow update_task_status to override completed statuses ([#246](https://github.com/zaxbysauce/opencode-swarm/issues/246)) ([81dc5d2](https://github.com/zaxbysauce/opencode-swarm/commit/81dc5d22f935fdf6942ea1026e18702426671f52))

## [6.31.2](https://github.com/zaxbysauce/opencode-swarm/compare/v6.31.1...v6.31.2) (2026-03-22)


### Bug Fixes

* **ci:** resolve OOM hang and remove unused knowledge tool interfaces ([#244](https://github.com/zaxbysauce/opencode-swarm/issues/244)) ([f170325](https://github.com/zaxbysauce/opencode-swarm/commit/f170325fc3d98b412815d4a91d83bf3718d12df5))

## [6.31.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.31.0...v6.31.1) (2026-03-21)


### Bug Fixes

* **dist:** rebuild stale v6.31.0 bundle missing self-review and knowledge tools ([#242](https://github.com/zaxbysauce/opencode-swarm/issues/242)) ([3a528c8](https://github.com/zaxbysauce/opencode-swarm/commit/3a528c815be2962d7da1975c442ee26aa2a127d1))

## [6.31.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.30.2...v6.31.0) (2026-03-21)


### Features

* process.cwd cleanup, curator wiring, watchdog pattern, self-review, and knowledge tools ([#239](https://github.com/zaxbysauce/opencode-swarm/issues/239)) ([573e2a0](https://github.com/zaxbysauce/opencode-swarm/commit/573e2a09c85ee97df52649e057686f49bf43db50))

## [6.30.2](https://github.com/zaxbysauce/opencode-swarm/compare/v6.30.1...v6.30.2) (2026-03-21)


### Bug Fixes

* **cli:** replace diverged dispatch switches with unified command registry ([#237](https://github.com/zaxbysauce/opencode-swarm/issues/237)) ([9773939](https://github.com/zaxbysauce/opencode-swarm/commit/97739390110a321818d2872e319a86554cf0969c))

## [6.30.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.30.0...v6.30.1) (2026-03-21)


### Bug Fixes

* cap spawnAsync output, lockfile PM detection, Windows .cmd spawn, curator config, advisory queue drain, and rehydration race guard ([#231](https://github.com/zaxbysauce/opencode-swarm/issues/231)) ([bdb0f16](https://github.com/zaxbysauce/opencode-swarm/commit/bdb0f16eae94dd03fccac8a8de9720d98ba9eca4))

## [6.30.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.29.7...v6.30.0) (2026-03-20)


### Features

* add Curator background analysis system with phase-level drift detection and knowledge injection ([8cf8d07](https://github.com/zaxbysauce/opencode-swarm/commit/8cf8d07ed8383948288fed53b31c6c0d0f8dfc91))
* add next pre-release pipeline for v7.0 beta testing ([a35ebb4](https://github.com/zaxbysauce/opencode-swarm/commit/a35ebb477acd08baadf19437995a97aafbaf93f9))
* **agents:** add defensive coding rules and error handling to coder (C1, C2, X3, X4) ([cbb2220](https://github.com/zaxbysauce/opencode-swarm/commit/cbb22202ecd289b824335abb6d99aacc66ffa87c))
* **agents:** add differential review focus and structured reasoning to reviewer (R1, R2, X3, X4) ([45e9069](https://github.com/zaxbysauce/opencode-swarm/commit/45e9069f90609787d36a7e089e7f3b5a1dd8cde2))
* **agents:** add documentation scope rules to docs (D1, X3, X4) ([e39d22b](https://github.com/zaxbysauce/opencode-swarm/commit/e39d22b9a16e57289a08b3288f5e8f573453f738))
* **agents:** add research protocol and confidence calibration to sme (S1, X3, X4) ([b1f250d](https://github.com/zaxbysauce/opencode-swarm/commit/b1f250d00ba31f20d9265a2a0dad2f9c949c5d3c))
* **agents:** add structured codebase analysis protocol to explorer (E1, X3, X4) ([b2d346c](https://github.com/zaxbysauce/opencode-swarm/commit/b2d346c8867a62e891d63d54768be29bba6a0b31))
* **agents:** complete audit phase 4-6 G�� remaining 13 deferred items ([d4001fa](https://github.com/zaxbysauce/opencode-swarm/commit/d4001fa0e07d94f429e59a3003078826bc052c66))
* **agents:** complete audit phase 4-6 G�� remaining 13 deferred items ([d60f3e2](https://github.com/zaxbysauce/opencode-swarm/commit/d60f3e2e0b176c52a8182b1c09d0ae66abdd8ce9))
* **agents:** overhaul test-engineer prompt (T1-T4, X3, X4) ([b830f91](https://github.com/zaxbysauce/opencode-swarm/commit/b830f91ae2b82833607274227484b42977ab2293))
* **gate-enforcement:** add per-task state machine, scope declaration, and hard blocks ([a1ab8ad](https://github.com/zaxbysauce/opencode-swarm/commit/a1ab8adb8378b3402c97184328e61442fd80774f))
* **gate-enforcement:** per-task state machine, scope declaration, and hard blocks (v6.21) ([90324cf](https://github.com/zaxbysauce/opencode-swarm/commit/90324cf53a88a7ad0132f9d8786b084d3e95e035))
* implement glob/path exclude patterns and .secretscanignore support for secretscan ([4271898](https://github.com/zaxbysauce/opencode-swarm/commit/42718983db6f6bed160990a52c0906c3ac886da3))
* implement session durability and Turbo Mode controls (v6.26) ([a87eb95](https://github.com/zaxbysauce/opencode-swarm/commit/a87eb95065985e82f9a158e24cd64dc6dc2902df))
* **secretscan:** glob/path exclude patterns and .secretscanignore support ([4a3a91a](https://github.com/zaxbysauce/opencode-swarm/commit/4a3a91a613710a599831b1f159bf62ece963c957))
* self-correcting workflow hooks, context compaction, and tech debt cleanup ([#212](https://github.com/zaxbysauce/opencode-swarm/issues/212)) ([8fd18c9](https://github.com/zaxbysauce/opencode-swarm/commit/8fd18c9f69d7d37016bab300814f825784db3f1a))
* session durability and Turbo Mode controls (v6.26) ([9d7eb32](https://github.com/zaxbysauce/opencode-swarm/commit/9d7eb32f0a69c06e5566d75c4620c023d7a71cfd))
* **v6.20:** add AST diffing, parallelism framework, PR gate, checkpoint extension, agent output, skill versioning, and context efficiency ([f13ea28](https://github.com/zaxbysauce/opencode-swarm/commit/f13ea285cb862dc0e5dae5e641b560bd5c0ffac5))
* **v6.20:** AST diffing, parallelism framework, PR gate, checkpoint extension, agent output, skill versioning ([d6acce7](https://github.com/zaxbysauce/opencode-swarm/commit/d6acce7dd3fe559e74fc0abde479f39e4678be8f))


### Bug Fixes

* add {{AGENT_PREFIX}} to remaining bare architect reference in FOR tag example ([6545fe0](https://github.com/zaxbysauce/opencode-swarm/commit/6545fe080cd302d5a189aff9439e68e71964863b))
* add handoff command, run memory service, and context budget guard ([efa334c](https://github.com/zaxbysauce/opencode-swarm/commit/efa334cd2e6435eda93176f3f3325a6e1d21d895))
* add handoff command, run memory, and context budget guard ([1118edb](https://github.com/zaxbysauce/opencode-swarm/commit/1118edbac57535eb83552251adb8eddffc264cca))
* **agents:** align prompt contracts with audit intent ([1999097](https://github.com/zaxbysauce/opencode-swarm/commit/19990975925bf61facb448b0b24472e09df870f4))
* **agents:** escape backticks in coder and docs template literals ([2f4faf4](https://github.com/zaxbysauce/opencode-swarm/commit/2f4faf4f8522f77c9d84ea83aca52c5d176bfeac))
* align agent prompt contracts and tests ([c5a906e](https://github.com/zaxbysauce/opencode-swarm/commit/c5a906e9c33d3e4a37aa4f515a55ee14e6cfea4f))
* align gate evidence fixes with tracked dist output ([cb1405a](https://github.com/zaxbysauce/opencode-swarm/commit/cb1405ade97705b86a1664ea019502760507ad3e))
* align prompt drift contracts and tests ([3d94e0f](https://github.com/zaxbysauce/opencode-swarm/commit/3d94e0fce3fc3e2b8668a48ab190f6012ef9faca))
* align tests with wired detectors and hardened interactive safety gates ([5c9701e](https://github.com/zaxbysauce/opencode-swarm/commit/5c9701e8793bd0d807be27d2623c155851dd67ab))
* **architect:** tier QA gates to reduce low-risk churn ([5e38b05](https://github.com/zaxbysauce/opencode-swarm/commit/5e38b05a492c72b823abf17874a155c9d74618aa))
* **build:** remove misplaced src test artifact breaking declarations ([3bee31e](https://github.com/zaxbysauce/opencode-swarm/commit/3bee31ea841b6af5773478f2c514892666be10bb))
* centralize regex safety with escapeRegex/simpleGlobToRegex utilities ([2139031](https://github.com/zaxbysauce/opencode-swarm/commit/2139031404d2573d92b631408df5be66042d488b))
* centralize regex safety with escapeRegex/simpleGlobToRegex utilities ([efd034d](https://github.com/zaxbysauce/opencode-swarm/commit/efd034dd13eada386e15a3d259a37fa4269ec235))
* **ci:** remove native tree-sitter devDeps that compiled from source on Windows ([9138137](https://github.com/zaxbysauce/opencode-swarm/commit/9138137309f81ae2ac4c2287f7da436d4f5446a7))
* clean up remaining workflow tech debt ([5b8cabc](https://github.com/zaxbysauce/opencode-swarm/commit/5b8cabc5f605d5764ca3faff27066a028f173f72))
* clean up remaining workflow tech debt ([e052c3d](https://github.com/zaxbysauce/opencode-swarm/commit/e052c3d51f121202b45350dd7c43ecd6dd35761b))
* code review group A G�� JSON safety, regex escaping, directory threading ([590df9a](https://github.com/zaxbysauce/opencode-swarm/commit/590df9a4ca8bb0811ea0396691b4cb28a9598e57))
* complete remaining workflow reliability hotfixes ([a88d0a8](https://github.com/zaxbysauce/opencode-swarm/commit/a88d0a8970663bc3e787f9cd04098dd06d91197c))
* complete remaining workflow reliability hotfixes ([d76fa58](https://github.com/zaxbysauce/opencode-swarm/commit/d76fa586bd5c846a4d823ce3d2999edaaa78f225))
* correct broken anchor in docs/configuration.md ([40daacc](https://github.com/zaxbysauce/opencode-swarm/commit/40daaccd0a63ab81d876613e07a9c26f84af0b60))
* correct broken anchor in docs/configuration.md to #configuration-reference ([169b4c7](https://github.com/zaxbysauce/opencode-swarm/commit/169b4c756e50d1d794e44de92cdd7d4a7183bff3))
* delegation-gate fallback evidence writes use process.cwd() instead of directory ([b163737](https://github.com/zaxbysauce/opencode-swarm/commit/b16373712cefa323c760aa0d368d3c44dc519af2))
* **dist:** rebuild dist after lint fixes ([fb5be58](https://github.com/zaxbysauce/opencode-swarm/commit/fb5be5821387815798f99744a35cc0cfc168b4e8))
* **dist:** rebuild dist artifacts for cwd fixes and delegation-gate additions ([6ed7a5b](https://github.com/zaxbysauce/opencode-swarm/commit/6ed7a5b9169f0130997bac6cbcf90a48c4064cbd))
* **dist:** rebuild dist artifacts for update_task_status and write_retro tool additions ([03eb93a](https://github.com/zaxbysauce/opencode-swarm/commit/03eb93ac5bb5ef096bcb3a339cfb3351358abb27))
* eliminate rehydration race and evidence/snapshot merge conflict ([#225](https://github.com/zaxbysauce/opencode-swarm/issues/225)) ([92a1cf4](https://github.com/zaxbysauce/opencode-swarm/commit/92a1cf40fcb3e59528271704f82b2d082b29e53b))
* expose update_task_status and write_retro tools, repair retro compatibility ([ec96421](https://github.com/zaxbysauce/opencode-swarm/commit/ec964215369bae5226e2c0cbb0abf46fce37e485))
* gate warn() behind DEBUG and block direct plan.md writes ([4763f25](https://github.com/zaxbysauce/opencode-swarm/commit/4763f25f29405930b2fe91ecfe7e6f44dc7f98f9))
* gate warn() behind DEBUG and block direct plan.md writes ([36897b1](https://github.com/zaxbysauce/opencode-swarm/commit/36897b1236994a2ac0013b299679ee787606114e))
* harden evidence guard G�� case-insensitive, length-bound, double-slash safe ([3873a21](https://github.com/zaxbysauce/opencode-swarm/commit/3873a21f17783462014099e311a92bd82159713f))
* harden interactive test runner safety gates ([0a1e66e](https://github.com/zaxbysauce/opencode-swarm/commit/0a1e66e232a6895cc8dc3d49fa811c9588d5c731))
* harden interactive test runner safety gates ([3b489f4](https://github.com/zaxbysauce/opencode-swarm/commit/3b489f46e248bcc4dccd78cf6d62395a63a34718))
* harden JSON.parse, escape regex injection, thread directory into pipeline-tracker ([20b1163](https://github.com/zaxbysauce/opencode-swarm/commit/20b1163f1ca0925ef53aec65018545b7af9d2974))
* harden phase_complete agent aggregation and warnings ([cd5b202](https://github.com/zaxbysauce/opencode-swarm/commit/cd5b20257addf7019226764358810a6a10fdf73e))
* harden pre_check_batch, diff, glob, placeholder-scan, and sast-scan ([11c40f5](https://github.com/zaxbysauce/opencode-swarm/commit/11c40f5a1d4886a9c88c2403b563a74c6a5a8dda))
* honor qa_gates reviewer override in catastrophic phase checks ([17d2e79](https://github.com/zaxbysauce/opencode-swarm/commit/17d2e793dd9e62736d2b2d9c7697fa7eb6c79626))
* honor reviewer qa override in catastrophic checks ([c46b3da](https://github.com/zaxbysauce/opencode-swarm/commit/c46b3daa853049a6d2f0c3128e36e28c6fda0a6f))
* **hotfix-78:** summarization verification, gate-state wiring, and plan-state guard hardening ([1bc62e8](https://github.com/zaxbysauce/opencode-swarm/commit/1bc62e8993c2307e35bcd00dc836e531f044de63))
* **hotfix-78:** summarization verification, gate-state wiring, and plan-state guard hardening ([a42f4f1](https://github.com/zaxbysauce/opencode-swarm/commit/a42f4f1298b04518f1be8d7ca23825f201b518b7))
* implement issues [#145](https://github.com/zaxbysauce/opencode-swarm/issues/145) and [#146](https://github.com/zaxbysauce/opencode-swarm/issues/146) task/phase status handling ([e62749e](https://github.com/zaxbysauce/opencode-swarm/commit/e62749e8739faacbd66f935a83f609c4f6436649))
* **issue-124:** checkReviewerGate skips corrupt sessions; fix mock leakage in phase-monitor tests ([dc1da81](https://github.com/zaxbysauce/opencode-swarm/commit/dc1da8126aa4b3f53f528330404b48a3f728c68f))
* language-agnostic portability for incremental-verify and slop-detector hooks (v6.29.2) ([#216](https://github.com/zaxbysauce/opencode-swarm/issues/216)) ([d2e5335](https://github.com/zaxbysauce/opencode-swarm/commit/d2e5335fe211d19236dcc854d2ff13570c8ca567))
* **lint:** remove CI-blocking biome errors in hooks ([3e8fe80](https://github.com/zaxbysauce/opencode-swarm/commit/3e8fe80bad25c2c4df6758c98798b7b4ac45ebe7))
* **lint:** replace control character regex literal with RegExp constructor to fix noControlCharactersInRegex CI error ([0673429](https://github.com/zaxbysauce/opencode-swarm/commit/0673429f3247dfee94f4e0a8c7194bc06264ced1))
* **lint:** resolve 5 biome errors introduced by Phase 1-4 hardening ([9dacdf3](https://github.com/zaxbysauce/opencode-swarm/commit/9dacdf360db80c4fb0e4bfd4e42d6dbde6ceb701))
* **lint:** resolve biome lint errors to unblock CI ([1aefafb](https://github.com/zaxbysauce/opencode-swarm/commit/1aefafb7ef46dbc84cd23c028fac6591a31c1fa0))
* move violation warnings to system messages and suppress repeated self-coding alerts ([e1d55b9](https://github.com/zaxbysauce/opencode-swarm/commit/e1d55b9303c7fd6e12b8f1d8ad46ef26aa51a50b))
* normalize bare agent name references in prompts to use {{AGENT_PREFIX}} ([efeb4bf](https://github.com/zaxbysauce/opencode-swarm/commit/efeb4bf099409151fa80ccadf1f319ceb8ce1eea))
* normalize prefixed agent names in isAgentDelegation to unblock QA gates for non-default swarms ([4ec0fc6](https://github.com/zaxbysauce/opencode-swarm/commit/4ec0fc6cd24cdca2ae32472ddec132e2b4c0263d))
* normalize subagent_type with stripKnownSwarmPrefix in isAgentDelegation to support prefixed agents like mega_reviewer/mega_test_engineer ([44eb706](https://github.com/zaxbysauce/opencode-swarm/commit/44eb706aa48107d86f3c2ec1d63a12d52d75ca9f))
* normalize task handoff and clarify architect setup ([c4c5cbb](https://github.com/zaxbysauce/opencode-swarm/commit/c4c5cbb8f127008823471055df9749cee9a202c3))
* normalize task tool name for architect handoff ([c832728](https://github.com/zaxbysauce/opencode-swarm/commit/c832728e533854d7da7e615692254e92913f4a6b))
* pass explicit directories to delegation gate tests ([3a798d4](https://github.com/zaxbysauce/opencode-swarm/commit/3a798d477f8d7f4fd2674867e1f6aca2e61ee203))
* pass explicit directories to delegation gate tests ([6d722bb](https://github.com/zaxbysauce/opencode-swarm/commit/6d722bb5c79a837a77ed4025a48b7a9c8343e121))
* persist phaseAgentsDispatched across session restarts for phase_complete ([9b8d53e](https://github.com/zaxbysauce/opencode-swarm/commit/9b8d53ead540dacad19b2edccf6b41b4276f2926))
* persist phaseAgentsDispatched across session restarts for phase_complete ([bb1e068](https://github.com/zaxbysauce/opencode-swarm/commit/bb1e0688116fea45068f217da127c3ff8ed8e0d8))
* persist taskWorkflowStates in session snapshots and reconcile states from plan (Issue [#81](https://github.com/zaxbysauce/opencode-swarm/issues/81)) ([d5c3637](https://github.com/zaxbysauce/opencode-swarm/commit/d5c36376dee5d0db5bf19d6047f3bad346f086dd))
* phase completion reliability and workspace validation hardening ([4051d14](https://github.com/zaxbysauce/opencode-swarm/commit/4051d14b71d5f5cce5b8f479c534eac8817d436a))
* phase completion reliability and workspace validation hardening ([600e9bb](https://github.com/zaxbysauce/opencode-swarm/commit/600e9bb158e98f30e375ce784271f561492bcf98))
* phase_complete updates plan.json on success and adds completed-task fallback for agent requirements ([07c001d](https://github.com/zaxbysauce/opencode-swarm/commit/07c001d470152de7743ebd4bd8dc1d3f99af645b))
* phase_complete updates plan.json on success and adds completed-task fallback for agent requirements ([14888eb](https://github.com/zaxbysauce/opencode-swarm/commit/14888ebfc54d734e6f35ee114ae6b8efedc76401))
* plumb ToolContext.sessionID into phase_complete to fix cross-session tracking ([be22929](https://github.com/zaxbysauce/opencode-swarm/commit/be22929273309b22876e6d612263bb007ebce4d3))
* plumb ToolContext.sessionID into phase_complete to fix cross-session tracking ([e7f898e](https://github.com/zaxbysauce/opencode-swarm/commit/e7f898e1f43cbd83f20b9511a9afec88489dda26)), closes [#89](https://github.com/zaxbysauce/opencode-swarm/issues/89)
* prefer local node_modules/.bin over global npx for linter detection ([#209](https://github.com/zaxbysauce/opencode-swarm/issues/209)) ([9799dca](https://github.com/zaxbysauce/opencode-swarm/commit/9799dcae85ac0549b88efa7ab79fbf3300451b18))
* read subagent_type from input.args in tool.execute.after hook ([87a0b1f](https://github.com/zaxbysauce/opencode-swarm/commit/87a0b1f406a2db367e5c04783534be812f11c62a))
* read subagent_type from input.args in tool.execute.after hook ([045c69d](https://github.com/zaxbysauce/opencode-swarm/commit/045c69d5ed2c7046963b25f2a1f28fd57f452803))
* reconcile evidence handling and contain test scope ([cea26ec](https://github.com/zaxbysauce/opencode-swarm/commit/cea26ec1aa5754d5a8b213d4c13a05fd658978b7))
* reconcile evidence handling and contain test scope ([8ebf15a](https://github.com/zaxbysauce/opencode-swarm/commit/8ebf15a4e84685feda136dce66421c9c6076683a))
* record explorer and sme gate evidence ([f3e60de](https://github.com/zaxbysauce/opencode-swarm/commit/f3e60de2a096450d6302b2a19a68180b8a500c08))
* record explorer and sme gate evidence ([833cced](https://github.com/zaxbysauce/opencode-swarm/commit/833cced7a61a1fb5cba004a8cbcef1dbff4b4c81))
* recover task state from delegation chains before gate check ([a6e3574](https://github.com/zaxbysauce/opencode-swarm/commit/a6e3574048996b4b60aa285692ddb064bfb76390))
* regression sweep gate, test task dedup, gated full-suite, and curator wiring ([#220](https://github.com/zaxbysauce/opencode-swarm/issues/220)) ([6dc331d](https://github.com/zaxbysauce/opencode-swarm/commit/6dc331d63ad3dba7387510db5f6c89ec50f0fad5))
* **release:** realign release-please baseline to v6.19.0 ([02c505a](https://github.com/zaxbysauce/opencode-swarm/commit/02c505a0aa73aca0c9a96c288f04dc6d3cbdedf2))
* remove debug console.log, fix advanceTaskState guard, move batch warnings to system messages ([8f38933](https://github.com/zaxbysauce/opencode-swarm/commit/8f38933575b4ae809e9aa15477b55aa20df860cd))
* remove platform guard from Windows device path check in declare-scope ([10f1b1f](https://github.com/zaxbysauce/opencode-swarm/commit/10f1b1f71f0efb149cf0ed54948288fb46170cbb))
* remove platform guard from Windows device path check in declare-scope ([8aef2c6](https://github.com/zaxbysauce/opencode-swarm/commit/8aef2c6e5379f02a121664e6c2a01ebd4f054377))
* remove redundant reconcileTaskStatesFromPlan causing startup throw-loop in v6.29.6 ([#227](https://github.com/zaxbysauce/opencode-swarm/issues/227)) ([f6ddf69](https://github.com/zaxbysauce/opencode-swarm/commit/f6ddf6906de614769956c6b87ed51f224dbefc1b))
* replace bare reviewer/test_engineer agent name references with {{AGENT_PREFIX}} in architect prompt ([e34fdab](https://github.com/zaxbysauce/opencode-swarm/commit/e34fdab4719289bb6e9731ea532de2394a707852))
* resolve .swarm output dir against project root in sbom_generate ([af49bd5](https://github.com/zaxbysauce/opencode-swarm/commit/af49bd5c4cbaeef8700c2aa5783fdad02409c86d))
* resolve .swarm output directory against project root in sbom-generate ([4e5a210](https://github.com/zaxbysauce/opencode-swarm/commit/4e5a210185577f46d65177f05de31f84069e75f4))
* resolve 26 test failures from knowledge system audit ([5bda121](https://github.com/zaxbysauce/opencode-swarm/commit/5bda12182a1210de2f4b9c8c796c728d50f7d9e6))
* resolve all 26 test failures in knowledge system audit ([ae49bc0](https://github.com/zaxbysauce/opencode-swarm/commit/ae49bc04f4bf219275c4801bfb92dccd07eaf962))
* resolve all biome lint errors to restore CI green ([2b19afc](https://github.com/zaxbysauce/opencode-swarm/commit/2b19afcbc1e8b1c8628a50ba6bd89a328b2150a5))
* resolve biome lint errors in regex utility and phase-complete ([bc2a2ac](https://github.com/zaxbysauce/opencode-swarm/commit/bc2a2acfb555e7bf16a0f8072a6cac71fde2295d))
* resolve CI typecheck failure G�� scope afterCoder in delegation-gate ([1f1c6bf](https://github.com/zaxbysauce/opencode-swarm/commit/1f1c6bf028a30be039bc2ec6f8b4c48b2c080ade))
* resolve path before isSourceCodePath check, fix test gate setup ([d16df29](https://github.com/zaxbysauce/opencode-swarm/commit/d16df2936a0cdc63713ada655c5189d92d368157))
* resolve path before isSourceCodePath check, fix test gate setup ([d498cc0](https://github.com/zaxbysauce/opencode-swarm/commit/d498cc0c171fb19796dadc8cea482824540829d5))
* resolve phase_complete fallback regressions affecting task status flow ([f908425](https://github.com/zaxbysauce/opencode-swarm/commit/f908425906e02c8d2fa8378fad8ec14e97a1091a))
* resolve TypeScript CI failures ([e752163](https://github.com/zaxbysauce/opencode-swarm/commit/e75216340ceeb42374a5f628c3370cd1d277a39b))
* resolve v6.29.4 startup regression in knowledge-injector and phaGǪ ([#223](https://github.com/zaxbysauce/opencode-swarm/issues/223)) ([03c16bc](https://github.com/zaxbysauce/opencode-swarm/commit/03c16bcdf5e30179eda20eef403426dc18be7026))
* restore architect delegation and add gate status tool ([2223d95](https://github.com/zaxbysauce/opencode-swarm/commit/2223d954b635c769e3e1ecf3ba35f78b16f04a8e))
* restore architect delegation and add gate status tool ([ef8bcb2](https://github.com/zaxbysauce/opencode-swarm/commit/ef8bcb2e1d1ade91b704f1ba26779ac557de714f))
* restore architect delegation and add gate status tool ([8a655ea](https://github.com/zaxbysauce/opencode-swarm/commit/8a655ea7328da6acfd617b5b690000e182666604))
* restore delegation-gate task advancement after task calls ([04c5212](https://github.com/zaxbysauce/opencode-swarm/commit/04c521267daf9fd2bcabcdc7d6a7017d3738d860))
* restore delegation-gate task advancement after task calls ([8894427](https://github.com/zaxbysauce/opencode-swarm/commit/8894427e230d742d3b895a70ead027c4b53d1348))
* restore evidence compatibility and stale workflow expectation ([f91e69e](https://github.com/zaxbysauce/opencode-swarm/commit/f91e69eb1e49b53406699b0b936c023bac84b64a))
* restore evidence compatibility and stale workflow expectation ([2d91300](https://github.com/zaxbysauce/opencode-swarm/commit/2d91300ea733f5c04ae0281c40f7d27a72e116fb))
* restore evidence ID compatibility ([7c71e9a](https://github.com/zaxbysauce/opencode-swarm/commit/7c71e9acf5f6c0871262c0088bf792af7bccdc45))
* restore release-please trigger after non-conventional merge ([00302b3](https://github.com/zaxbysauce/opencode-swarm/commit/00302b34deef33b536de547df726094e1fc9fc5d))
* restore release-please trigger with conventional commit guidance ([4caa55b](https://github.com/zaxbysauce/opencode-swarm/commit/4caa55b7ba489bf73d67e9996a1722582f4f1f06))
* revert monorepo config, broaden evidence guardrail, prefer directArgs task_id, relax task granularity ([#208](https://github.com/zaxbysauce/opencode-swarm/issues/208)) ([c9b8e9a](https://github.com/zaxbysauce/opencode-swarm/commit/c9b8e9a78da54b24f8742a0e67104cee4cb32e15))
* route advisory hook messages into LLM context via pendingAdvisoryMessages queue ([#214](https://github.com/zaxbysauce/opencode-swarm/issues/214)) ([48fcb0d](https://github.com/zaxbysauce/opencode-swarm/commit/48fcb0d75310e4978c632c2141161faac8b8541d))
* seed task workflow state in new sessions during cross-session propagation ([1b49604](https://github.com/zaxbysauce/opencode-swarm/commit/1b496042b581634adc53a0bcbaf7b4e9e99a4cee))
* seed task workflow state in new sessions during cross-session propagation ([2c51514](https://github.com/zaxbysauce/opencode-swarm/commit/2c5151477866411e0dfb461b71d234a50d893f15))
* silent catch blocks in delegation-gate now log warnings; gate heuristic checks on coder delegation; fix [ ] sanitization ([b28dae1](https://github.com/zaxbysauce/opencode-swarm/commit/b28dae1e860a0f25b44181b0019aaae59b7169fe))
* state machine never advances on default config and CLI writes wrong config file ([#81](https://github.com/zaxbysauce/opencode-swarm/issues/81) [#84](https://github.com/zaxbysauce/opencode-swarm/issues/84)) ([ac8dffa](https://github.com/zaxbysauce/opencode-swarm/commit/ac8dffaaf6fb7c94675fa22621125cc420c20c57))
* state machine never advances on default config and CLI writes wrong config file ([#81](https://github.com/zaxbysauce/opencode-swarm/issues/81) [#84](https://github.com/zaxbysauce/opencode-swarm/issues/84)) ([9023b40](https://github.com/zaxbysauce/opencode-swarm/commit/9023b406527469672c644bb39610dae1e4fcd8e7))
* suppress repeated violation warnings and route all guardrail guidance to system messages ([9500d72](https://github.com/zaxbysauce/opencode-swarm/commit/9500d729353984d8732cb6f029216ec4fe626f38))
* surface Curator status in diagnose and docs ([#218](https://github.com/zaxbysauce/opencode-swarm/issues/218)) ([7729ffe](https://github.com/zaxbysauce/opencode-swarm/commit/7729ffecf14637d8c3cf5a56f139208c630e620e))
* sync active task identity for durable evidence ([f2f7291](https://github.com/zaxbysauce/opencode-swarm/commit/f2f729195b66bdaa0fedf200c0d45dc6078b953c))
* sync active task identity for durable evidence ([058e036](https://github.com/zaxbysauce/opencode-swarm/commit/058e0366769a85ac27a1d29596ca23ca9838afc6))
* test isolation - use DI for curator runner, loosen drift path traversal assertion ([e334e7d](https://github.com/zaxbysauce/opencode-swarm/commit/e334e7d461ad322b13d03765bf5c9531981b70c5))
* **tests:** always write explicit curator config in test helper to prevent user config leak ([d0543f4](https://github.com/zaxbysauce/opencode-swarm/commit/d0543f457488d59e42cdbd7dc6aa6562584603f2))
* **tests:** always write explicit curator config to prevent user config leak ([1e6a571](https://github.com/zaxbysauce/opencode-swarm/commit/1e6a571a009b3cd82d1ecb31a1c29b8024842e5b))
* **tests:** correct phase_complete adversarial test expectations for RETROSPECTIVE_MISSING behavior ([bc0383f](https://github.com/zaxbysauce/opencode-swarm/commit/bc0383ff14577e4f4fd18152d001c6c41c5500bf))
* **tests:** replace .resolves.not.toThrow() with Bun-compatible await pattern ([dd31ca5](https://github.com/zaxbysauce/opencode-swarm/commit/dd31ca5ee5b45489ef9ab0f09380a601d9dd737c))
* **tests:** replace .resolves.not.toThrow() with Bun-compatible await pattern ([d98173d](https://github.com/zaxbysauce/opencode-swarm/commit/d98173d99892f390b68e4cdae98bd7fbdac1cac7))
* tool hardening and Windows CI native-dep removal ([e6155e0](https://github.com/zaxbysauce/opencode-swarm/commit/e6155e09bed9705c1970c6b0d61b16ef6b24d804))
* tool-based task gate evidence store (Issue [#146](https://github.com/zaxbysauce/opencode-swarm/issues/146)) ([c2a34c2](https://github.com/zaxbysauce/opencode-swarm/commit/c2a34c213afdb67067656b91354bae62d4eda57e))
* tool-based task gate evidence store (Issues [#146](https://github.com/zaxbysauce/opencode-swarm/issues/146), [#145](https://github.com/zaxbysauce/opencode-swarm/issues/145)) ([37cedaf](https://github.com/zaxbysauce/opencode-swarm/commit/37cedafc091ab9839ad222f6d4c52031829b0f92))
* **tools:** expose update_task_status and write_retro, repair retro compatibility, harden architect prompt ([694dd16](https://github.com/zaxbysauce/opencode-swarm/commit/694dd1656bd34dc5ffbfac71c0587bd898c6b9a0))
* update test expectations to match wired detectors and hardened safety guards ([6f50f6e](https://github.com/zaxbysauce/opencode-swarm/commit/6f50f6e3246c2a5555ee65e74ec757f1da0b600b))
* use directory instead of process.cwd() in delegation-gate fallback evidence path ([3aef904](https://github.com/zaxbysauce/opencode-swarm/commit/3aef904459c470bbfe30c6e873ef03a50b3474cf))
* use dynamic agent prefix in system-enhancer injected prompt text ([1873088](https://github.com/zaxbysauce/opencode-swarm/commit/187308862fc99897e8515e786e332e63baaf7d94))
* use workspace directory as cwd for all subprocess calls ([5e24335](https://github.com/zaxbysauce/opencode-swarm/commit/5e243354e3f7828c7537e9d69b4e65261025173e))
* use workspace directory as cwd for all subprocess calls ([3d855b6](https://github.com/zaxbysauce/opencode-swarm/commit/3d855b6f012c49543b86a40509cb749de63cbfcb))
* widen gate recovery scan for pure-verification and code-organization tasks ([865a8cf](https://github.com/zaxbysauce/opencode-swarm/commit/865a8cfa33d4b610d2b0da79cab10460039783b9))


### Reverts

* undo direct push of architect delegation and gate status hotfix ([326b323](https://github.com/zaxbysauce/opencode-swarm/commit/326b323eab6b60e9c23d5fbf34fb338b72ca0553))

## [6.29.7](https://github.com/zaxbysauce/opencode-swarm/compare/v6.29.6...v6.29.7) (2026-03-20)


### Bug Fixes

* remove redundant reconcileTaskStatesFromPlan causing startup throw-loop in v6.29.6 ([#227](https://github.com/zaxbysauce/opencode-swarm/issues/227)) ([f6ddf69](https://github.com/zaxbysauce/opencode-swarm/commit/f6ddf6906de614769956c6b87ed51f224dbefc1b))

## [6.29.6](https://github.com/zaxbysauce/opencode-swarm/compare/v6.29.5...v6.29.6) (2026-03-20)


### Bug Fixes

* eliminate rehydration race and evidence/snapshot merge conflict ([#225](https://github.com/zaxbysauce/opencode-swarm/issues/225)) ([92a1cf4](https://github.com/zaxbysauce/opencode-swarm/commit/92a1cf40fcb3e59528271704f82b2d082b29e53b))

## [6.29.5](https://github.com/zaxbysauce/opencode-swarm/compare/v6.29.4...v6.29.5) (2026-03-20)


### Bug Fixes

* resolve v6.29.4 startup regression in knowledge-injector and phaGǪ ([#223](https://github.com/zaxbysauce/opencode-swarm/issues/223)) ([03c16bc](https://github.com/zaxbysauce/opencode-swarm/commit/03c16bcdf5e30179eda20eef403426dc18be7026))

## [6.29.4](https://github.com/zaxbysauce/opencode-swarm/compare/v6.29.3...v6.29.4) (2026-03-20)


### Bug Fixes

* regression sweep gate, test task dedup, gated full-suite, and curator wiring ([#220](https://github.com/zaxbysauce/opencode-swarm/issues/220)) ([6dc331d](https://github.com/zaxbysauce/opencode-swarm/commit/6dc331d63ad3dba7387510db5f6c89ec50f0fad5))

## [6.29.3](https://github.com/zaxbysauce/opencode-swarm/compare/v6.29.2...v6.29.3) (2026-03-19)


### Bug Fixes

* surface Curator status in diagnose and docs ([#218](https://github.com/zaxbysauce/opencode-swarm/issues/218)) ([7729ffe](https://github.com/zaxbysauce/opencode-swarm/commit/7729ffecf14637d8c3cf5a56f139208c630e620e))

## [6.29.2](https://github.com/zaxbysauce/opencode-swarm/compare/v6.29.1...v6.29.2) (2026-03-19)

### Features

* multi-language incremental-verify with Go/Rust/C#/Python detection, spawnAsync portability, slop-detector hardening, evidence phase_number fix ([#215](https://github.com/zaxbysauce/opencode-swarm/issues/215)) ([4f59ac4](https://github.com/zaxbysauce/opencode-swarm/commit/4f59ac4a1fc4ec5df7d81f15c0ba1c93d7c5b3f8))

### Bug Fixes

* evidence-schema phase_number minimum from 0 to 1 G�� Phase 0 never valid ([4f59ac4](https://github.com/zaxbysauce/opencode-swarm/commit/4f59ac4a1fc4ec5df7d81f15c0ba1c93d7c5b3f8))
* language-agnostic portability for incremental-verify and slop-detector hooks (v6.29.2) ([#216](https://github.com/zaxbysauce/opencode-swarm/issues/216)) ([d2e5335](https://github.com/zaxbysauce/opencode-swarm/commit/d2e5335fe211d19236dcc854d2ff13570c8ca567))

## [6.29.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.29.0...v6.29.1) (2026-03-19)


### Bug Fixes

* route advisory hook messages into LLM context via pendingAdvisoryMessages queue ([#214](https://github.com/zaxbysauce/opencode-swarm/issues/214)) ([48fcb0d](https://github.com/zaxbysauce/opencode-swarm/commit/48fcb0d75310e4978c632c2141161faac8b8541d))

## [6.29.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.28.1...v6.29.0) (2026-03-19)


### Features

* self-correcting workflow hooks, context compaction, and tech debt cleanup ([#212](https://github.com/zaxbysauce/opencode-swarm/issues/212)) ([8fd18c9](https://github.com/zaxbysauce/opencode-swarm/commit/8fd18c9f69d7d37016bab300814f825784db3f1a))

## [6.28.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.28.0...v6.28.1) (2026-03-18)


### Bug Fixes

* prefer local node_modules/.bin over global npx for linter detection ([#209](https://github.com/zaxbysauce/opencode-swarm/issues/209)) ([9799dca](https://github.com/zaxbysauce/opencode-swarm/commit/9799dcae85ac0549b88efa7ab79fbf3300451b18))

## [6.28.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.27.1...v6.28.0) (2026-03-17)


### Features

* add next pre-release pipeline for v7.0 beta testing ([a35ebb4](https://github.com/zaxbysauce/opencode-swarm/commit/a35ebb477acd08baadf19437995a97aafbaf93f9))


### Bug Fixes

* harden evidence guard G�� case-insensitive, length-bound, double-slash safe ([3873a21](https://github.com/zaxbysauce/opencode-swarm/commit/3873a21f17783462014099e311a92bd82159713f))
* revert monorepo config, broaden evidence guardrail, prefer directArgs task_id, relax task granularity ([#208](https://github.com/zaxbysauce/opencode-swarm/issues/208)) ([c9b8e9a](https://github.com/zaxbysauce/opencode-swarm/commit/c9b8e9a78da54b24f8742a0e67104cee4cb32e15))

## [6.27.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.27.0...v6.27.1) (2026-03-15)


### Bug Fixes

* widen gate recovery scan for pure-verification and code-organization tasks ([865a8cf](https://github.com/zaxbysauce/opencode-swarm/commit/865a8cfa33d4b610d2b0da79cab10460039783b9))

## [6.27.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.26.0...v6.27.0) (2026-03-14)


### Features

* add Curator background analysis system with phase-level drift detection and knowledge injection ([8cf8d07](https://github.com/zaxbysauce/opencode-swarm/commit/8cf8d07ed8383948288fed53b31c6c0d0f8dfc91))
* **agents:** add defensive coding rules and error handling to coder (C1, C2, X3, X4) ([cbb2220](https://github.com/zaxbysauce/opencode-swarm/commit/cbb22202ecd289b824335abb6d99aacc66ffa87c))
* **agents:** add differential review focus and structured reasoning to reviewer (R1, R2, X3, X4) ([45e9069](https://github.com/zaxbysauce/opencode-swarm/commit/45e9069f90609787d36a7e089e7f3b5a1dd8cde2))
* **agents:** add documentation scope rules to docs (D1, X3, X4) ([e39d22b](https://github.com/zaxbysauce/opencode-swarm/commit/e39d22b9a16e57289a08b3288f5e8f573453f738))
* **agents:** add research protocol and confidence calibration to sme (S1, X3, X4) ([b1f250d](https://github.com/zaxbysauce/opencode-swarm/commit/b1f250d00ba31f20d9265a2a0dad2f9c949c5d3c))
* **agents:** add structured codebase analysis protocol to explorer (E1, X3, X4) ([b2d346c](https://github.com/zaxbysauce/opencode-swarm/commit/b2d346c8867a62e891d63d54768be29bba6a0b31))
* **agents:** complete audit phase 4-6 G�� remaining 13 deferred items ([d4001fa](https://github.com/zaxbysauce/opencode-swarm/commit/d4001fa0e07d94f429e59a3003078826bc052c66))
* **agents:** complete audit phase 4-6 G�� remaining 13 deferred items ([d60f3e2](https://github.com/zaxbysauce/opencode-swarm/commit/d60f3e2e0b176c52a8182b1c09d0ae66abdd8ce9))
* **agents:** overhaul test-engineer prompt (T1-T4, X3, X4) ([b830f91](https://github.com/zaxbysauce/opencode-swarm/commit/b830f91ae2b82833607274227484b42977ab2293))
* **gate-enforcement:** add per-task state machine, scope declaration, and hard blocks ([a1ab8ad](https://github.com/zaxbysauce/opencode-swarm/commit/a1ab8adb8378b3402c97184328e61442fd80774f))
* **gate-enforcement:** per-task state machine, scope declaration, and hard blocks (v6.21) ([90324cf](https://github.com/zaxbysauce/opencode-swarm/commit/90324cf53a88a7ad0132f9d8786b084d3e95e035))
* implement glob/path exclude patterns and .secretscanignore support for secretscan ([4271898](https://github.com/zaxbysauce/opencode-swarm/commit/42718983db6f6bed160990a52c0906c3ac886da3))
* implement session durability and Turbo Mode controls (v6.26) ([a87eb95](https://github.com/zaxbysauce/opencode-swarm/commit/a87eb95065985e82f9a158e24cd64dc6dc2902df))
* **secretscan:** glob/path exclude patterns and .secretscanignore support ([4a3a91a](https://github.com/zaxbysauce/opencode-swarm/commit/4a3a91a613710a599831b1f159bf62ece963c957))
* session durability and Turbo Mode controls (v6.26) ([9d7eb32](https://github.com/zaxbysauce/opencode-swarm/commit/9d7eb32f0a69c06e5566d75c4620c023d7a71cfd))
* v6.19.0 G�� Prompt-Quality & Adversarial Robustness Update ([0fdf2e8](https://github.com/zaxbysauce/opencode-swarm/commit/0fdf2e818846a0f2c66b8ff42cd650b8d923f0c1))
* **v6.20:** add AST diffing, parallelism framework, PR gate, checkpoint extension, agent output, skill versioning, and context efficiency ([f13ea28](https://github.com/zaxbysauce/opencode-swarm/commit/f13ea285cb862dc0e5dae5e641b560bd5c0ffac5))
* **v6.20:** AST diffing, parallelism framework, PR gate, checkpoint extension, agent output, skill versioning ([d6acce7](https://github.com/zaxbysauce/opencode-swarm/commit/d6acce7dd3fe559e74fc0abde479f39e4678be8f))


### Bug Fixes

* add {{AGENT_PREFIX}} to remaining bare architect reference in FOR tag example ([6545fe0](https://github.com/zaxbysauce/opencode-swarm/commit/6545fe080cd302d5a189aff9439e68e71964863b))
* add handoff command, run memory service, and context budget guard ([efa334c](https://github.com/zaxbysauce/opencode-swarm/commit/efa334cd2e6435eda93176f3f3325a6e1d21d895))
* add handoff command, run memory, and context budget guard ([1118edb](https://github.com/zaxbysauce/opencode-swarm/commit/1118edbac57535eb83552251adb8eddffc264cca))
* **agents:** align prompt contracts with audit intent ([1999097](https://github.com/zaxbysauce/opencode-swarm/commit/19990975925bf61facb448b0b24472e09df870f4))
* **agents:** escape backticks in coder and docs template literals ([2f4faf4](https://github.com/zaxbysauce/opencode-swarm/commit/2f4faf4f8522f77c9d84ea83aca52c5d176bfeac))
* align agent prompt contracts and tests ([c5a906e](https://github.com/zaxbysauce/opencode-swarm/commit/c5a906e9c33d3e4a37aa4f515a55ee14e6cfea4f))
* align gate evidence fixes with tracked dist output ([cb1405a](https://github.com/zaxbysauce/opencode-swarm/commit/cb1405ade97705b86a1664ea019502760507ad3e))
* align prompt drift contracts and tests ([3d94e0f](https://github.com/zaxbysauce/opencode-swarm/commit/3d94e0fce3fc3e2b8668a48ab190f6012ef9faca))
* align tests with wired detectors and hardened interactive safety gates ([5c9701e](https://github.com/zaxbysauce/opencode-swarm/commit/5c9701e8793bd0d807be27d2623c155851dd67ab))
* **architect:** tier QA gates to reduce low-risk churn ([5e38b05](https://github.com/zaxbysauce/opencode-swarm/commit/5e38b05a492c72b823abf17874a155c9d74618aa))
* **build:** remove misplaced src test artifact breaking declarations ([3bee31e](https://github.com/zaxbysauce/opencode-swarm/commit/3bee31ea841b6af5773478f2c514892666be10bb))
* centralize regex safety with escapeRegex/simpleGlobToRegex utilities ([2139031](https://github.com/zaxbysauce/opencode-swarm/commit/2139031404d2573d92b631408df5be66042d488b))
* centralize regex safety with escapeRegex/simpleGlobToRegex utilities ([efd034d](https://github.com/zaxbysauce/opencode-swarm/commit/efd034dd13eada386e15a3d259a37fa4269ec235))
* **ci:** remove native tree-sitter devDeps that compiled from source on Windows ([9138137](https://github.com/zaxbysauce/opencode-swarm/commit/9138137309f81ae2ac4c2287f7da436d4f5446a7))
* clean up remaining workflow tech debt ([5b8cabc](https://github.com/zaxbysauce/opencode-swarm/commit/5b8cabc5f605d5764ca3faff27066a028f173f72))
* clean up remaining workflow tech debt ([e052c3d](https://github.com/zaxbysauce/opencode-swarm/commit/e052c3d51f121202b45350dd7c43ecd6dd35761b))
* code review group A G�� JSON safety, regex escaping, directory threading ([590df9a](https://github.com/zaxbysauce/opencode-swarm/commit/590df9a4ca8bb0811ea0396691b4cb28a9598e57))
* complete remaining workflow reliability hotfixes ([a88d0a8](https://github.com/zaxbysauce/opencode-swarm/commit/a88d0a8970663bc3e787f9cd04098dd06d91197c))
* complete remaining workflow reliability hotfixes ([d76fa58](https://github.com/zaxbysauce/opencode-swarm/commit/d76fa586bd5c846a4d823ce3d2999edaaa78f225))
* correct broken anchor in docs/configuration.md ([40daacc](https://github.com/zaxbysauce/opencode-swarm/commit/40daaccd0a63ab81d876613e07a9c26f84af0b60))
* correct broken anchor in docs/configuration.md to #configuration-reference ([169b4c7](https://github.com/zaxbysauce/opencode-swarm/commit/169b4c756e50d1d794e44de92cdd7d4a7183bff3))
* delegation-gate fallback evidence writes use process.cwd() instead of directory ([b163737](https://github.com/zaxbysauce/opencode-swarm/commit/b16373712cefa323c760aa0d368d3c44dc519af2))
* **dist:** rebuild dist after lint fixes ([fb5be58](https://github.com/zaxbysauce/opencode-swarm/commit/fb5be5821387815798f99744a35cc0cfc168b4e8))
* **dist:** rebuild dist artifacts for cwd fixes and delegation-gate additions ([6ed7a5b](https://github.com/zaxbysauce/opencode-swarm/commit/6ed7a5b9169f0130997bac6cbcf90a48c4064cbd))
* **dist:** rebuild dist artifacts for update_task_status and write_retro tool additions ([03eb93a](https://github.com/zaxbysauce/opencode-swarm/commit/03eb93ac5bb5ef096bcb3a339cfb3351358abb27))
* expose update_task_status and write_retro tools, repair retro compatibility ([ec96421](https://github.com/zaxbysauce/opencode-swarm/commit/ec964215369bae5226e2c0cbb0abf46fce37e485))
* gate warn() behind DEBUG and block direct plan.md writes ([4763f25](https://github.com/zaxbysauce/opencode-swarm/commit/4763f25f29405930b2fe91ecfe7e6f44dc7f98f9))
* gate warn() behind DEBUG and block direct plan.md writes ([36897b1](https://github.com/zaxbysauce/opencode-swarm/commit/36897b1236994a2ac0013b299679ee787606114e))
* harden interactive test runner safety gates ([0a1e66e](https://github.com/zaxbysauce/opencode-swarm/commit/0a1e66e232a6895cc8dc3d49fa811c9588d5c731))
* harden interactive test runner safety gates ([3b489f4](https://github.com/zaxbysauce/opencode-swarm/commit/3b489f46e248bcc4dccd78cf6d62395a63a34718))
* harden JSON.parse, escape regex injection, thread directory into pipeline-tracker ([20b1163](https://github.com/zaxbysauce/opencode-swarm/commit/20b1163f1ca0925ef53aec65018545b7af9d2974))
* harden phase_complete agent aggregation and warnings ([cd5b202](https://github.com/zaxbysauce/opencode-swarm/commit/cd5b20257addf7019226764358810a6a10fdf73e))
* harden pre_check_batch, diff, glob, placeholder-scan, and sast-scan ([11c40f5](https://github.com/zaxbysauce/opencode-swarm/commit/11c40f5a1d4886a9c88c2403b563a74c6a5a8dda))
* honor qa_gates reviewer override in catastrophic phase checks ([17d2e79](https://github.com/zaxbysauce/opencode-swarm/commit/17d2e793dd9e62736d2b2d9c7697fa7eb6c79626))
* honor reviewer qa override in catastrophic checks ([c46b3da](https://github.com/zaxbysauce/opencode-swarm/commit/c46b3daa853049a6d2f0c3128e36e28c6fda0a6f))
* **hotfix-78:** summarization verification, gate-state wiring, and plan-state guard hardening ([1bc62e8](https://github.com/zaxbysauce/opencode-swarm/commit/1bc62e8993c2307e35bcd00dc836e531f044de63))
* **hotfix-78:** summarization verification, gate-state wiring, and plan-state guard hardening ([a42f4f1](https://github.com/zaxbysauce/opencode-swarm/commit/a42f4f1298b04518f1be8d7ca23825f201b518b7))
* implement issues [#145](https://github.com/zaxbysauce/opencode-swarm/issues/145) and [#146](https://github.com/zaxbysauce/opencode-swarm/issues/146) task/phase status handling ([e62749e](https://github.com/zaxbysauce/opencode-swarm/commit/e62749e8739faacbd66f935a83f609c4f6436649))
* **issue-124:** checkReviewerGate skips corrupt sessions; fix mock leakage in phase-monitor tests ([dc1da81](https://github.com/zaxbysauce/opencode-swarm/commit/dc1da8126aa4b3f53f528330404b48a3f728c68f))
* **lint:** remove CI-blocking biome errors in hooks ([3e8fe80](https://github.com/zaxbysauce/opencode-swarm/commit/3e8fe80bad25c2c4df6758c98798b7b4ac45ebe7))
* **lint:** replace control character regex literal with RegExp constructor to fix noControlCharactersInRegex CI error ([0673429](https://github.com/zaxbysauce/opencode-swarm/commit/0673429f3247dfee94f4e0a8c7194bc06264ced1))
* **lint:** resolve 5 biome errors introduced by Phase 1-4 hardening ([9dacdf3](https://github.com/zaxbysauce/opencode-swarm/commit/9dacdf360db80c4fb0e4bfd4e42d6dbde6ceb701))
* **lint:** resolve biome lint errors to unblock CI ([1aefafb](https://github.com/zaxbysauce/opencode-swarm/commit/1aefafb7ef46dbc84cd23c028fac6591a31c1fa0))
* move violation warnings to system messages and suppress repeated self-coding alerts ([e1d55b9](https://github.com/zaxbysauce/opencode-swarm/commit/e1d55b9303c7fd6e12b8f1d8ad46ef26aa51a50b))
* normalize bare agent name references in prompts to use {{AGENT_PREFIX}} ([efeb4bf](https://github.com/zaxbysauce/opencode-swarm/commit/efeb4bf099409151fa80ccadf1f319ceb8ce1eea))
* normalize prefixed agent names in isAgentDelegation to unblock QA gates for non-default swarms ([4ec0fc6](https://github.com/zaxbysauce/opencode-swarm/commit/4ec0fc6cd24cdca2ae32472ddec132e2b4c0263d))
* normalize subagent_type with stripKnownSwarmPrefix in isAgentDelegation to support prefixed agents like mega_reviewer/mega_test_engineer ([44eb706](https://github.com/zaxbysauce/opencode-swarm/commit/44eb706aa48107d86f3c2ec1d63a12d52d75ca9f))
* normalize task handoff and clarify architect setup ([c4c5cbb](https://github.com/zaxbysauce/opencode-swarm/commit/c4c5cbb8f127008823471055df9749cee9a202c3))
* normalize task tool name for architect handoff ([c832728](https://github.com/zaxbysauce/opencode-swarm/commit/c832728e533854d7da7e615692254e92913f4a6b))
* pass explicit directories to delegation gate tests ([3a798d4](https://github.com/zaxbysauce/opencode-swarm/commit/3a798d477f8d7f4fd2674867e1f6aca2e61ee203))
* pass explicit directories to delegation gate tests ([6d722bb](https://github.com/zaxbysauce/opencode-swarm/commit/6d722bb5c79a837a77ed4025a48b7a9c8343e121))
* persist phaseAgentsDispatched across session restarts for phase_complete ([9b8d53e](https://github.com/zaxbysauce/opencode-swarm/commit/9b8d53ead540dacad19b2edccf6b41b4276f2926))
* persist phaseAgentsDispatched across session restarts for phase_complete ([bb1e068](https://github.com/zaxbysauce/opencode-swarm/commit/bb1e0688116fea45068f217da127c3ff8ed8e0d8))
* persist taskWorkflowStates in session snapshots and reconcile states from plan (Issue [#81](https://github.com/zaxbysauce/opencode-swarm/issues/81)) ([d5c3637](https://github.com/zaxbysauce/opencode-swarm/commit/d5c36376dee5d0db5bf19d6047f3bad346f086dd))
* phase completion reliability and workspace validation hardening ([4051d14](https://github.com/zaxbysauce/opencode-swarm/commit/4051d14b71d5f5cce5b8f479c534eac8817d436a))
* phase completion reliability and workspace validation hardening ([600e9bb](https://github.com/zaxbysauce/opencode-swarm/commit/600e9bb158e98f30e375ce784271f561492bcf98))
* phase_complete updates plan.json on success and adds completed-task fallback for agent requirements ([07c001d](https://github.com/zaxbysauce/opencode-swarm/commit/07c001d470152de7743ebd4bd8dc1d3f99af645b))
* phase_complete updates plan.json on success and adds completed-task fallback for agent requirements ([14888eb](https://github.com/zaxbysauce/opencode-swarm/commit/14888ebfc54d734e6f35ee114ae6b8efedc76401))
* plumb ToolContext.sessionID into phase_complete to fix cross-session tracking ([be22929](https://github.com/zaxbysauce/opencode-swarm/commit/be22929273309b22876e6d612263bb007ebce4d3))
* plumb ToolContext.sessionID into phase_complete to fix cross-session tracking ([e7f898e](https://github.com/zaxbysauce/opencode-swarm/commit/e7f898e1f43cbd83f20b9511a9afec88489dda26)), closes [#89](https://github.com/zaxbysauce/opencode-swarm/issues/89)
* read subagent_type from input.args in tool.execute.after hook ([87a0b1f](https://github.com/zaxbysauce/opencode-swarm/commit/87a0b1f406a2db367e5c04783534be812f11c62a))
* read subagent_type from input.args in tool.execute.after hook ([045c69d](https://github.com/zaxbysauce/opencode-swarm/commit/045c69d5ed2c7046963b25f2a1f28fd57f452803))
* reconcile evidence handling and contain test scope ([cea26ec](https://github.com/zaxbysauce/opencode-swarm/commit/cea26ec1aa5754d5a8b213d4c13a05fd658978b7))
* reconcile evidence handling and contain test scope ([8ebf15a](https://github.com/zaxbysauce/opencode-swarm/commit/8ebf15a4e84685feda136dce66421c9c6076683a))
* record explorer and sme gate evidence ([f3e60de](https://github.com/zaxbysauce/opencode-swarm/commit/f3e60de2a096450d6302b2a19a68180b8a500c08))
* record explorer and sme gate evidence ([833cced](https://github.com/zaxbysauce/opencode-swarm/commit/833cced7a61a1fb5cba004a8cbcef1dbff4b4c81))
* recover task state from delegation chains before gate check ([a6e3574](https://github.com/zaxbysauce/opencode-swarm/commit/a6e3574048996b4b60aa285692ddb064bfb76390))
* **release:** realign release-please baseline to v6.19.0 ([02c505a](https://github.com/zaxbysauce/opencode-swarm/commit/02c505a0aa73aca0c9a96c288f04dc6d3cbdedf2))
* remove debug console.log, fix advanceTaskState guard, move batch warnings to system messages ([8f38933](https://github.com/zaxbysauce/opencode-swarm/commit/8f38933575b4ae809e9aa15477b55aa20df860cd))
* remove platform guard from Windows device path check in declare-scope ([10f1b1f](https://github.com/zaxbysauce/opencode-swarm/commit/10f1b1f71f0efb149cf0ed54948288fb46170cbb))
* remove platform guard from Windows device path check in declare-scope ([8aef2c6](https://github.com/zaxbysauce/opencode-swarm/commit/8aef2c6e5379f02a121664e6c2a01ebd4f054377))
* replace bare reviewer/test_engineer agent name references with {{AGENT_PREFIX}} in architect prompt ([e34fdab](https://github.com/zaxbysauce/opencode-swarm/commit/e34fdab4719289bb6e9731ea532de2394a707852))
* resolve .swarm output dir against project root in sbom_generate ([af49bd5](https://github.com/zaxbysauce/opencode-swarm/commit/af49bd5c4cbaeef8700c2aa5783fdad02409c86d))
* resolve .swarm output directory against project root in sbom-generate ([4e5a210](https://github.com/zaxbysauce/opencode-swarm/commit/4e5a210185577f46d65177f05de31f84069e75f4))
* resolve 26 test failures from knowledge system audit ([5bda121](https://github.com/zaxbysauce/opencode-swarm/commit/5bda12182a1210de2f4b9c8c796c728d50f7d9e6))
* resolve all 26 test failures in knowledge system audit ([ae49bc0](https://github.com/zaxbysauce/opencode-swarm/commit/ae49bc04f4bf219275c4801bfb92dccd07eaf962))
* resolve all biome lint errors to restore CI green ([2b19afc](https://github.com/zaxbysauce/opencode-swarm/commit/2b19afcbc1e8b1c8628a50ba6bd89a328b2150a5))
* resolve biome lint errors in regex utility and phase-complete ([bc2a2ac](https://github.com/zaxbysauce/opencode-swarm/commit/bc2a2acfb555e7bf16a0f8072a6cac71fde2295d))
* resolve CI typecheck failure G�� scope afterCoder in delegation-gate ([1f1c6bf](https://github.com/zaxbysauce/opencode-swarm/commit/1f1c6bf028a30be039bc2ec6f8b4c48b2c080ade))
* resolve path before isSourceCodePath check, fix test gate setup ([d16df29](https://github.com/zaxbysauce/opencode-swarm/commit/d16df2936a0cdc63713ada655c5189d92d368157))
* resolve path before isSourceCodePath check, fix test gate setup ([d498cc0](https://github.com/zaxbysauce/opencode-swarm/commit/d498cc0c171fb19796dadc8cea482824540829d5))
* resolve phase_complete fallback regressions affecting task status flow ([f908425](https://github.com/zaxbysauce/opencode-swarm/commit/f908425906e02c8d2fa8378fad8ec14e97a1091a))
* resolve TypeScript CI failures ([e752163](https://github.com/zaxbysauce/opencode-swarm/commit/e75216340ceeb42374a5f628c3370cd1d277a39b))
* restore architect delegation and add gate status tool ([2223d95](https://github.com/zaxbysauce/opencode-swarm/commit/2223d954b635c769e3e1ecf3ba35f78b16f04a8e))
* restore architect delegation and add gate status tool ([ef8bcb2](https://github.com/zaxbysauce/opencode-swarm/commit/ef8bcb2e1d1ade91b704f1ba26779ac557de714f))
* restore architect delegation and add gate status tool ([8a655ea](https://github.com/zaxbysauce/opencode-swarm/commit/8a655ea7328da6acfd617b5b690000e182666604))
* restore delegation-gate task advancement after task calls ([04c5212](https://github.com/zaxbysauce/opencode-swarm/commit/04c521267daf9fd2bcabcdc7d6a7017d3738d860))
* restore delegation-gate task advancement after task calls ([8894427](https://github.com/zaxbysauce/opencode-swarm/commit/8894427e230d742d3b895a70ead027c4b53d1348))
* restore evidence compatibility and stale workflow expectation ([f91e69e](https://github.com/zaxbysauce/opencode-swarm/commit/f91e69eb1e49b53406699b0b936c023bac84b64a))
* restore evidence compatibility and stale workflow expectation ([2d91300](https://github.com/zaxbysauce/opencode-swarm/commit/2d91300ea733f5c04ae0281c40f7d27a72e116fb))
* restore evidence ID compatibility ([7c71e9a](https://github.com/zaxbysauce/opencode-swarm/commit/7c71e9acf5f6c0871262c0088bf792af7bccdc45))
* restore release-please trigger after non-conventional merge ([00302b3](https://github.com/zaxbysauce/opencode-swarm/commit/00302b34deef33b536de547df726094e1fc9fc5d))
* restore release-please trigger with conventional commit guidance ([4caa55b](https://github.com/zaxbysauce/opencode-swarm/commit/4caa55b7ba489bf73d67e9996a1722582f4f1f06))
* seed task workflow state in new sessions during cross-session propagation ([1b49604](https://github.com/zaxbysauce/opencode-swarm/commit/1b496042b581634adc53a0bcbaf7b4e9e99a4cee))
* seed task workflow state in new sessions during cross-session propagation ([2c51514](https://github.com/zaxbysauce/opencode-swarm/commit/2c5151477866411e0dfb461b71d234a50d893f15))
* silent catch blocks in delegation-gate now log warnings; gate heuristic checks on coder delegation; fix [ ] sanitization ([b28dae1](https://github.com/zaxbysauce/opencode-swarm/commit/b28dae1e860a0f25b44181b0019aaae59b7169fe))
* state machine never advances on default config and CLI writes wrong config file ([#81](https://github.com/zaxbysauce/opencode-swarm/issues/81) [#84](https://github.com/zaxbysauce/opencode-swarm/issues/84)) ([ac8dffa](https://github.com/zaxbysauce/opencode-swarm/commit/ac8dffaaf6fb7c94675fa22621125cc420c20c57))
* state machine never advances on default config and CLI writes wrong config file ([#81](https://github.com/zaxbysauce/opencode-swarm/issues/81) [#84](https://github.com/zaxbysauce/opencode-swarm/issues/84)) ([9023b40](https://github.com/zaxbysauce/opencode-swarm/commit/9023b406527469672c644bb39610dae1e4fcd8e7))
* suppress repeated violation warnings and route all guardrail guidance to system messages ([9500d72](https://github.com/zaxbysauce/opencode-swarm/commit/9500d729353984d8732cb6f029216ec4fe626f38))
* sync active task identity for durable evidence ([f2f7291](https://github.com/zaxbysauce/opencode-swarm/commit/f2f729195b66bdaa0fedf200c0d45dc6078b953c))
* sync active task identity for durable evidence ([058e036](https://github.com/zaxbysauce/opencode-swarm/commit/058e0366769a85ac27a1d29596ca23ca9838afc6))
* test isolation - use DI for curator runner, loosen drift path traversal assertion ([e334e7d](https://github.com/zaxbysauce/opencode-swarm/commit/e334e7d461ad322b13d03765bf5c9531981b70c5))
* **tests:** always write explicit curator config in test helper to prevent user config leak ([d0543f4](https://github.com/zaxbysauce/opencode-swarm/commit/d0543f457488d59e42cdbd7dc6aa6562584603f2))
* **tests:** always write explicit curator config to prevent user config leak ([1e6a571](https://github.com/zaxbysauce/opencode-swarm/commit/1e6a571a009b3cd82d1ecb31a1c29b8024842e5b))
* **tests:** correct phase_complete adversarial test expectations for RETROSPECTIVE_MISSING behavior ([bc0383f](https://github.com/zaxbysauce/opencode-swarm/commit/bc0383ff14577e4f4fd18152d001c6c41c5500bf))
* **tests:** replace .resolves.not.toThrow() with Bun-compatible await pattern ([dd31ca5](https://github.com/zaxbysauce/opencode-swarm/commit/dd31ca5ee5b45489ef9ab0f09380a601d9dd737c))
* **tests:** replace .resolves.not.toThrow() with Bun-compatible await pattern ([d98173d](https://github.com/zaxbysauce/opencode-swarm/commit/d98173d99892f390b68e4cdae98bd7fbdac1cac7))
* tool hardening and Windows CI native-dep removal ([e6155e0](https://github.com/zaxbysauce/opencode-swarm/commit/e6155e09bed9705c1970c6b0d61b16ef6b24d804))
* tool-based task gate evidence store (Issue [#146](https://github.com/zaxbysauce/opencode-swarm/issues/146)) ([c2a34c2](https://github.com/zaxbysauce/opencode-swarm/commit/c2a34c213afdb67067656b91354bae62d4eda57e))
* tool-based task gate evidence store (Issues [#146](https://github.com/zaxbysauce/opencode-swarm/issues/146), [#145](https://github.com/zaxbysauce/opencode-swarm/issues/145)) ([37cedaf](https://github.com/zaxbysauce/opencode-swarm/commit/37cedafc091ab9839ad222f6d4c52031829b0f92))
* **tools:** expose update_task_status and write_retro, repair retro compatibility, harden architect prompt ([694dd16](https://github.com/zaxbysauce/opencode-swarm/commit/694dd1656bd34dc5ffbfac71c0587bd898c6b9a0))
* update test expectations to match wired detectors and hardened safety guards ([6f50f6e](https://github.com/zaxbysauce/opencode-swarm/commit/6f50f6e3246c2a5555ee65e74ec757f1da0b600b))
* use directory instead of process.cwd() in delegation-gate fallback evidence path ([3aef904](https://github.com/zaxbysauce/opencode-swarm/commit/3aef904459c470bbfe30c6e873ef03a50b3474cf))
* use dynamic agent prefix in system-enhancer injected prompt text ([1873088](https://github.com/zaxbysauce/opencode-swarm/commit/187308862fc99897e8515e786e332e63baaf7d94))
* use workspace directory as cwd for all subprocess calls ([5e24335](https://github.com/zaxbysauce/opencode-swarm/commit/5e243354e3f7828c7537e9d69b4e65261025173e))
* use workspace directory as cwd for all subprocess calls ([3d855b6](https://github.com/zaxbysauce/opencode-swarm/commit/3d855b6f012c49543b86a40509cb749de63cbfcb))


### Reverts

* undo direct push of architect delegation and gate status hotfix ([326b323](https://github.com/zaxbysauce/opencode-swarm/commit/326b323eab6b60e9c23d5fbf34fb338b72ca0553))

## [6.26.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.25.9...v6.26.0) (2026-03-14)


### Features

* implement session durability and Turbo Mode controls (v6.26) ([a87eb95](https://github.com/zaxbysauce/opencode-swarm/commit/a87eb95065985e82f9a158e24cd64dc6dc2902df))
* session durability and Turbo Mode controls (v6.26) ([9d7eb32](https://github.com/zaxbysauce/opencode-swarm/commit/9d7eb32f0a69c06e5566d75c4620c023d7a71cfd))


### Bug Fixes

* resolve TypeScript CI failures ([e752163](https://github.com/zaxbysauce/opencode-swarm/commit/e75216340ceeb42374a5f628c3370cd1d277a39b))

## [6.25.9](https://github.com/zaxbysauce/opencode-swarm/compare/v6.25.8...v6.25.9) (2026-03-14)


### Bug Fixes

* restore evidence compatibility and stale workflow expectation ([f91e69e](https://github.com/zaxbysauce/opencode-swarm/commit/f91e69eb1e49b53406699b0b936c023bac84b64a))
* restore evidence compatibility and stale workflow expectation ([2d91300](https://github.com/zaxbysauce/opencode-swarm/commit/2d91300ea733f5c04ae0281c40f7d27a72e116fb))

## [6.25.8](https://github.com/zaxbysauce/opencode-swarm/compare/v6.25.7...v6.25.8) (2026-03-14)


### Bug Fixes

* clean up remaining workflow tech debt ([5b8cabc](https://github.com/zaxbysauce/opencode-swarm/commit/5b8cabc5f605d5764ca3faff27066a028f173f72))
* clean up remaining workflow tech debt ([e052c3d](https://github.com/zaxbysauce/opencode-swarm/commit/e052c3d51f121202b45350dd7c43ecd6dd35761b))
* remove platform guard from Windows device path check in declare-scope ([10f1b1f](https://github.com/zaxbysauce/opencode-swarm/commit/10f1b1f71f0efb149cf0ed54948288fb46170cbb))
* remove platform guard from Windows device path check in declare-scope ([8aef2c6](https://github.com/zaxbysauce/opencode-swarm/commit/8aef2c6e5379f02a121664e6c2a01ebd4f054377))
* restore evidence ID compatibility ([7c71e9a](https://github.com/zaxbysauce/opencode-swarm/commit/7c71e9acf5f6c0871262c0088bf792af7bccdc45))

## [6.25.7](https://github.com/zaxbysauce/opencode-swarm/compare/v6.25.6...v6.25.7) (2026-03-14)


### Bug Fixes

* pass explicit directories to delegation gate tests ([3a798d4](https://github.com/zaxbysauce/opencode-swarm/commit/3a798d477f8d7f4fd2674867e1f6aca2e61ee203))
* pass explicit directories to delegation gate tests ([6d722bb](https://github.com/zaxbysauce/opencode-swarm/commit/6d722bb5c79a837a77ed4025a48b7a9c8343e121))

## [6.25.6](https://github.com/zaxbysauce/opencode-swarm/compare/v6.25.5...v6.25.6) (2026-03-14)


### Bug Fixes

* complete remaining workflow reliability hotfixes ([a88d0a8](https://github.com/zaxbysauce/opencode-swarm/commit/a88d0a8970663bc3e787f9cd04098dd06d91197c))
* complete remaining workflow reliability hotfixes ([d76fa58](https://github.com/zaxbysauce/opencode-swarm/commit/d76fa586bd5c846a4d823ce3d2999edaaa78f225))

## [6.25.5](https://github.com/zaxbysauce/opencode-swarm/compare/v6.25.4...v6.25.5) (2026-03-14)


### Bug Fixes

* sync active task identity for durable evidence ([f2f7291](https://github.com/zaxbysauce/opencode-swarm/commit/f2f729195b66bdaa0fedf200c0d45dc6078b953c))
* sync active task identity for durable evidence ([058e036](https://github.com/zaxbysauce/opencode-swarm/commit/058e0366769a85ac27a1d29596ca23ca9838afc6))

## [6.25.4](https://github.com/zaxbysauce/opencode-swarm/compare/v6.25.3...v6.25.4) (2026-03-13)


### Bug Fixes

* align tests with wired detectors and hardened interactive safety gates ([5c9701e](https://github.com/zaxbysauce/opencode-swarm/commit/5c9701e8793bd0d807be27d2623c155851dd67ab))
* harden interactive test runner safety gates ([0a1e66e](https://github.com/zaxbysauce/opencode-swarm/commit/0a1e66e232a6895cc8dc3d49fa811c9588d5c731))
* harden interactive test runner safety gates ([3b489f4](https://github.com/zaxbysauce/opencode-swarm/commit/3b489f46e248bcc4dccd78cf6d62395a63a34718))
* update test expectations to match wired detectors and hardened safety guards ([6f50f6e](https://github.com/zaxbysauce/opencode-swarm/commit/6f50f6e3246c2a5555ee65e74ec757f1da0b600b))

## [6.25.3](https://github.com/zaxbysauce/opencode-swarm/compare/v6.25.2...v6.25.3) (2026-03-13)


### Bug Fixes

* record explorer and sme gate evidence ([f3e60de](https://github.com/zaxbysauce/opencode-swarm/commit/f3e60de2a096450d6302b2a19a68180b8a500c08))
* record explorer and sme gate evidence ([833cced](https://github.com/zaxbysauce/opencode-swarm/commit/833cced7a61a1fb5cba004a8cbcef1dbff4b4c81))

## [6.25.2](https://github.com/zaxbysauce/opencode-swarm/compare/v6.25.1...v6.25.2) (2026-03-13)


### Bug Fixes

* delegation-gate fallback evidence writes use process.cwd() instead of directory ([b163737](https://github.com/zaxbysauce/opencode-swarm/commit/b16373712cefa323c760aa0d368d3c44dc519af2))
* reconcile evidence handling and contain test scope ([cea26ec](https://github.com/zaxbysauce/opencode-swarm/commit/cea26ec1aa5754d5a8b213d4c13a05fd658978b7))
* reconcile evidence handling and contain test scope ([8ebf15a](https://github.com/zaxbysauce/opencode-swarm/commit/8ebf15a4e84685feda136dce66421c9c6076683a))
* use directory instead of process.cwd() in delegation-gate fallback evidence path ([3aef904](https://github.com/zaxbysauce/opencode-swarm/commit/3aef904459c470bbfe30c6e873ef03a50b3474cf))

## [6.25.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.25.0...v6.25.1) (2026-03-13)


### Bug Fixes

* restore architect delegation and add gate status tool ([2223d95](https://github.com/zaxbysauce/opencode-swarm/commit/2223d954b635c769e3e1ecf3ba35f78b16f04a8e))
* restore architect delegation and add gate status tool ([ef8bcb2](https://github.com/zaxbysauce/opencode-swarm/commit/ef8bcb2e1d1ade91b704f1ba26779ac557de714f))
* restore architect delegation and add gate status tool ([8a655ea](https://github.com/zaxbysauce/opencode-swarm/commit/8a655ea7328da6acfd617b5b690000e182666604))


### Reverts

* undo direct push of architect delegation and gate status hotfix ([326b323](https://github.com/zaxbysauce/opencode-swarm/commit/326b323eab6b60e9c23d5fbf34fb338b72ca0553))

## [6.25.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.24.0...v6.25.0) (2026-03-13)


### Features

* **agents:** complete audit phase 4-6 G�� remaining 13 deferred items ([d4001fa](https://github.com/zaxbysauce/opencode-swarm/commit/d4001fa0e07d94f429e59a3003078826bc052c66))
* **agents:** complete audit phase 4-6 G�� remaining 13 deferred items ([d60f3e2](https://github.com/zaxbysauce/opencode-swarm/commit/d60f3e2e0b176c52a8182b1c09d0ae66abdd8ce9))


### Bug Fixes

* **agents:** align prompt contracts with audit intent ([1999097](https://github.com/zaxbysauce/opencode-swarm/commit/19990975925bf61facb448b0b24472e09df870f4))
* align prompt drift contracts and tests ([3d94e0f](https://github.com/zaxbysauce/opencode-swarm/commit/3d94e0fce3fc3e2b8668a48ab190f6012ef9faca))

## [6.24.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.23.2...v6.24.0) (2026-03-12)


### Features

* **agents:** add defensive coding rules and error handling to coder (C1, C2, X3, X4) ([cbb2220](https://github.com/zaxbysauce/opencode-swarm/commit/cbb22202ecd289b824335abb6d99aacc66ffa87c))
* **agents:** add differential review focus and structured reasoning to reviewer (R1, R2, X3, X4) ([45e9069](https://github.com/zaxbysauce/opencode-swarm/commit/45e9069f90609787d36a7e089e7f3b5a1dd8cde2))
* **agents:** add documentation scope rules to docs (D1, X3, X4) ([e39d22b](https://github.com/zaxbysauce/opencode-swarm/commit/e39d22b9a16e57289a08b3288f5e8f573453f738))
* **agents:** add research protocol and confidence calibration to sme (S1, X3, X4) ([b1f250d](https://github.com/zaxbysauce/opencode-swarm/commit/b1f250d00ba31f20d9265a2a0dad2f9c949c5d3c))
* **agents:** add structured codebase analysis protocol to explorer (E1, X3, X4) ([b2d346c](https://github.com/zaxbysauce/opencode-swarm/commit/b2d346c8867a62e891d63d54768be29bba6a0b31))
* **agents:** overhaul test-engineer prompt (T1-T4, X3, X4) ([b830f91](https://github.com/zaxbysauce/opencode-swarm/commit/b830f91ae2b82833607274227484b42977ab2293))


### Bug Fixes

* **agents:** escape backticks in coder and docs template literals ([2f4faf4](https://github.com/zaxbysauce/opencode-swarm/commit/2f4faf4f8522f77c9d84ea83aca52c5d176bfeac))
* align agent prompt contracts and tests ([c5a906e](https://github.com/zaxbysauce/opencode-swarm/commit/c5a906e9c33d3e4a37aa4f515a55ee14e6cfea4f))

## [6.23.2](https://github.com/zaxbysauce/opencode-swarm/compare/v6.23.1...v6.23.2) (2026-03-12)


### Bug Fixes

* align gate evidence fixes with tracked dist output ([cb1405a](https://github.com/zaxbysauce/opencode-swarm/commit/cb1405ade97705b86a1664ea019502760507ad3e))
* resolve CI typecheck failure G�� scope afterCoder in delegation-gate ([1f1c6bf](https://github.com/zaxbysauce/opencode-swarm/commit/1f1c6bf028a30be039bc2ec6f8b4c48b2c080ade))
* tool-based task gate evidence store (Issue [#146](https://github.com/zaxbysauce/opencode-swarm/issues/146)) ([c2a34c2](https://github.com/zaxbysauce/opencode-swarm/commit/c2a34c213afdb67067656b91354bae62d4eda57e))
* tool-based task gate evidence store (Issues [#146](https://github.com/zaxbysauce/opencode-swarm/issues/146), [#145](https://github.com/zaxbysauce/opencode-swarm/issues/145)) ([37cedaf](https://github.com/zaxbysauce/opencode-swarm/commit/37cedafc091ab9839ad222f6d4c52031829b0f92))

## [6.23.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.23.0...v6.23.1) (2026-03-12)


### Bug Fixes

* recover task state from delegation chains before gate check ([a6e3574](https://github.com/zaxbysauce/opencode-swarm/commit/a6e3574048996b4b60aa285692ddb064bfb76390))

## [6.23.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.22.21...v6.23.0) (2026-03-12)


### Features

* implement glob/path exclude patterns and .secretscanignore support for secretscan ([4271898](https://github.com/zaxbysauce/opencode-swarm/commit/42718983db6f6bed160990a52c0906c3ac886da3))
* **secretscan:** glob/path exclude patterns and .secretscanignore support ([4a3a91a](https://github.com/zaxbysauce/opencode-swarm/commit/4a3a91a613710a599831b1f159bf62ece963c957))

## [6.22.21](https://github.com/zaxbysauce/opencode-swarm/compare/v6.22.20...v6.22.21) (2026-03-12)


### Bug Fixes

* seed task workflow state in new sessions during cross-session propagation ([1b49604](https://github.com/zaxbysauce/opencode-swarm/commit/1b496042b581634adc53a0bcbaf7b4e9e99a4cee))
* seed task workflow state in new sessions during cross-session propagation ([2c51514](https://github.com/zaxbysauce/opencode-swarm/commit/2c5151477866411e0dfb461b71d234a50d893f15))

## [6.22.20](https://github.com/zaxbysauce/opencode-swarm/compare/v6.22.19...v6.22.20) (2026-03-12)


### Bug Fixes

* resolve 26 test failures from knowledge system audit ([5bda121](https://github.com/zaxbysauce/opencode-swarm/commit/5bda12182a1210de2f4b9c8c796c728d50f7d9e6))
* resolve all 26 test failures in knowledge system audit ([ae49bc0](https://github.com/zaxbysauce/opencode-swarm/commit/ae49bc04f4bf219275c4801bfb92dccd07eaf962))

## [6.22.19](https://github.com/zaxbysauce/opencode-swarm/compare/v6.22.18...v6.22.19) (2026-03-12)


### Bug Fixes

* correct broken anchor in docs/configuration.md ([40daacc](https://github.com/zaxbysauce/opencode-swarm/commit/40daaccd0a63ab81d876613e07a9c26f84af0b60))
* correct broken anchor in docs/configuration.md to #configuration-reference ([169b4c7](https://github.com/zaxbysauce/opencode-swarm/commit/169b4c756e50d1d794e44de92cdd7d4a7183bff3))

## [6.22.18](https://github.com/zaxbysauce/opencode-swarm/compare/v6.22.17...v6.22.18) (2026-03-12)


### Bug Fixes

* centralize regex safety with escapeRegex/simpleGlobToRegex utilities ([2139031](https://github.com/zaxbysauce/opencode-swarm/commit/2139031404d2573d92b631408df5be66042d488b))
* centralize regex safety with escapeRegex/simpleGlobToRegex utilities ([efd034d](https://github.com/zaxbysauce/opencode-swarm/commit/efd034dd13eada386e15a3d259a37fa4269ec235))
* resolve biome lint errors in regex utility and phase-complete ([bc2a2ac](https://github.com/zaxbysauce/opencode-swarm/commit/bc2a2acfb555e7bf16a0f8072a6cac71fde2295d))

## [6.22.17](https://github.com/zaxbysauce/opencode-swarm/compare/v6.22.16...v6.22.17) (2026-03-12)


### Bug Fixes

* code review group A G�� JSON safety, regex escaping, directory threading ([590df9a](https://github.com/zaxbysauce/opencode-swarm/commit/590df9a4ca8bb0811ea0396691b4cb28a9598e57))
* harden JSON.parse, escape regex injection, thread directory into pipeline-tracker ([20b1163](https://github.com/zaxbysauce/opencode-swarm/commit/20b1163f1ca0925ef53aec65018545b7af9d2974))

## [6.22.16](https://github.com/zaxbysauce/opencode-swarm/compare/v6.22.15...v6.22.16) (2026-03-12)


### Bug Fixes

* resolve .swarm output dir against project root in sbom_generate ([af49bd5](https://github.com/zaxbysauce/opencode-swarm/commit/af49bd5c4cbaeef8700c2aa5783fdad02409c86d))
* resolve .swarm output directory against project root in sbom-generate ([4e5a210](https://github.com/zaxbysauce/opencode-swarm/commit/4e5a210185577f46d65177f05de31f84069e75f4))

## [6.22.15](https://github.com/zaxbysauce/opencode-swarm/compare/v6.22.14...v6.22.15) (2026-03-11)


### Bug Fixes

* honor qa_gates reviewer override in catastrophic phase checks ([17d2e79](https://github.com/zaxbysauce/opencode-swarm/commit/17d2e793dd9e62736d2b2d9c7697fa7eb6c79626))
* honor reviewer qa override in catastrophic checks ([c46b3da](https://github.com/zaxbysauce/opencode-swarm/commit/c46b3daa853049a6d2f0c3128e36e28c6fda0a6f))

## [6.22.14](https://github.com/zaxbysauce/opencode-swarm/compare/v6.22.13...v6.22.14) (2026-03-11)


### Bug Fixes

* add {{AGENT_PREFIX}} to remaining bare architect reference in FOR tag example ([6545fe0](https://github.com/zaxbysauce/opencode-swarm/commit/6545fe080cd302d5a189aff9439e68e71964863b))
* normalize bare agent name references in prompts to use {{AGENT_PREFIX}} ([efeb4bf](https://github.com/zaxbysauce/opencode-swarm/commit/efeb4bf099409151fa80ccadf1f319ceb8ce1eea))
* use dynamic agent prefix in system-enhancer injected prompt text ([1873088](https://github.com/zaxbysauce/opencode-swarm/commit/187308862fc99897e8515e786e332e63baaf7d94))

## [6.22.13](https://github.com/zaxbysauce/opencode-swarm/compare/v6.22.12...v6.22.13) (2026-03-11)


### Bug Fixes

* harden phase_complete agent aggregation and warnings ([cd5b202](https://github.com/zaxbysauce/opencode-swarm/commit/cd5b20257addf7019226764358810a6a10fdf73e))
* resolve phase_complete fallback regressions affecting task status flow ([f908425](https://github.com/zaxbysauce/opencode-swarm/commit/f908425906e02c8d2fa8378fad8ec14e97a1091a))

## [6.22.12](https://github.com/zaxbysauce/opencode-swarm/compare/v6.22.11...v6.22.12) (2026-03-11)


### Bug Fixes

* **issue-124:** checkReviewerGate skips corrupt sessions; fix mock leakage in phase-monitor tests ([dc1da81](https://github.com/zaxbysauce/opencode-swarm/commit/dc1da8126aa4b3f53f528330404b48a3f728c68f))
* silent catch blocks in delegation-gate now log warnings; gate heuristic checks on coder delegation; fix [ ] sanitization ([b28dae1](https://github.com/zaxbysauce/opencode-swarm/commit/b28dae1e860a0f25b44181b0019aaae59b7169fe))
* test isolation - use DI for curator runner, loosen drift path traversal assertion ([e334e7d](https://github.com/zaxbysauce/opencode-swarm/commit/e334e7d461ad322b13d03765bf5c9531981b70c5))

## [6.22.11](https://github.com/zaxbysauce/opencode-swarm/compare/v6.22.10...v6.22.11) (2026-03-11)


### Bug Fixes

* remove debug console.log, fix advanceTaskState guard, move batch warnings to system messages ([8f38933](https://github.com/zaxbysauce/opencode-swarm/commit/8f38933575b4ae809e9aa15477b55aa20df860cd))

## [6.22.10](https://github.com/zaxbysauce/opencode-swarm/compare/v6.22.9...v6.22.10) (2026-03-11)


### Bug Fixes

* move violation warnings to system messages and suppress repeated self-coding alerts ([e1d55b9](https://github.com/zaxbysauce/opencode-swarm/commit/e1d55b9303c7fd6e12b8f1d8ad46ef26aa51a50b))
* suppress repeated violation warnings and route all guardrail guidance to system messages ([9500d72](https://github.com/zaxbysauce/opencode-swarm/commit/9500d729353984d8732cb6f029216ec4fe626f38))

## [6.22.9](https://github.com/zaxbysauce/opencode-swarm/compare/v6.22.8...v6.22.9) (2026-03-11)


### Bug Fixes

* normalize prefixed agent names in isAgentDelegation to unblock QA gates for non-default swarms ([4ec0fc6](https://github.com/zaxbysauce/opencode-swarm/commit/4ec0fc6cd24cdca2ae32472ddec132e2b4c0263d))
* normalize subagent_type with stripKnownSwarmPrefix in isAgentDelegation to support prefixed agents like mega_reviewer/mega_test_engineer ([44eb706](https://github.com/zaxbysauce/opencode-swarm/commit/44eb706aa48107d86f3c2ec1d63a12d52d75ca9f))

## [6.22.8](https://github.com/zaxbysauce/opencode-swarm/compare/v6.22.7...v6.22.8) (2026-03-11)


### Bug Fixes

* restore release-please trigger after non-conventional merge ([00302b3](https://github.com/zaxbysauce/opencode-swarm/commit/00302b34deef33b536de547df726094e1fc9fc5d))
* restore release-please trigger with conventional commit guidance ([4caa55b](https://github.com/zaxbysauce/opencode-swarm/commit/4caa55b7ba489bf73d67e9996a1722582f4f1f06))

## [6.22.7](https://github.com/zaxbysauce/opencode-swarm/compare/v6.22.6...v6.22.7) (2026-03-10)


### Bug Fixes

* phase_complete updates plan.json on success and adds completed-task fallback for agent requirements ([07c001d](https://github.com/zaxbysauce/opencode-swarm/commit/07c001d470152de7743ebd4bd8dc1d3f99af645b))
* phase_complete updates plan.json on success and adds completed-task fallback for agent requirements ([14888eb](https://github.com/zaxbysauce/opencode-swarm/commit/14888ebfc54d734e6f35ee114ae6b8efedc76401))

## [6.22.6](https://github.com/zaxbysauce/opencode-swarm/compare/v6.22.5...v6.22.6) (2026-03-10)


### Bug Fixes

* read subagent_type from input.args in tool.execute.after hook ([87a0b1f](https://github.com/zaxbysauce/opencode-swarm/commit/87a0b1f406a2db367e5c04783534be812f11c62a))
* read subagent_type from input.args in tool.execute.after hook ([045c69d](https://github.com/zaxbysauce/opencode-swarm/commit/045c69d5ed2c7046963b25f2a1f28fd57f452803))

## [6.22.5](https://github.com/zaxbysauce/opencode-swarm/compare/v6.22.4...v6.22.5) (2026-03-10)


### Bug Fixes

* normalize task handoff and clarify architect setup ([c4c5cbb](https://github.com/zaxbysauce/opencode-swarm/commit/c4c5cbb8f127008823471055df9749cee9a202c3))
* normalize task tool name for architect handoff ([c832728](https://github.com/zaxbysauce/opencode-swarm/commit/c832728e533854d7da7e615692254e92913f4a6b))

## [6.22.4](https://github.com/zaxbysauce/opencode-swarm/compare/v6.22.3...v6.22.4) (2026-03-10)


### Bug Fixes

* restore delegation-gate task advancement after task calls ([04c5212](https://github.com/zaxbysauce/opencode-swarm/commit/04c521267daf9fd2bcabcdc7d6a7017d3738d860))
* restore delegation-gate task advancement after task calls ([8894427](https://github.com/zaxbysauce/opencode-swarm/commit/8894427e230d742d3b895a70ead027c4b53d1348))

## [6.22.3](https://github.com/zaxbysauce/opencode-swarm/compare/v6.22.2...v6.22.3) (2026-03-09)


### Bug Fixes

* persist phaseAgentsDispatched across session restarts for phase_complete ([9b8d53e](https://github.com/zaxbysauce/opencode-swarm/commit/9b8d53ead540dacad19b2edccf6b41b4276f2926))
* persist phaseAgentsDispatched across session restarts for phase_complete ([bb1e068](https://github.com/zaxbysauce/opencode-swarm/commit/bb1e0688116fea45068f217da127c3ff8ed8e0d8))

## [6.22.2](https://github.com/zaxbysauce/opencode-swarm/compare/v6.22.1...v6.22.2) (2026-03-09)


### Bug Fixes

* **tests:** always write explicit curator config in test helper to prevent user config leak ([d0543f4](https://github.com/zaxbysauce/opencode-swarm/commit/d0543f457488d59e42cdbd7dc6aa6562584603f2))
* **tests:** always write explicit curator config to prevent user config leak ([1e6a571](https://github.com/zaxbysauce/opencode-swarm/commit/1e6a571a009b3cd82d1ecb31a1c29b8024842e5b))

## [6.22.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.22.0...v6.22.1) (2026-03-09)


### Bug Fixes

* **tests:** replace .resolves.not.toThrow() with Bun-compatible await pattern ([dd31ca5](https://github.com/zaxbysauce/opencode-swarm/commit/dd31ca5ee5b45489ef9ab0f09380a601d9dd737c))
* **tests:** replace .resolves.not.toThrow() with Bun-compatible await pattern ([d98173d](https://github.com/zaxbysauce/opencode-swarm/commit/d98173d99892f390b68e4cdae98bd7fbdac1cac7))

## [6.22.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.21.3...v6.22.0) (2026-03-09)


### Features

* add Curator background analysis system with phase-level drift detection and knowledge injection ([8cf8d07](https://github.com/zaxbysauce/opencode-swarm/commit/8cf8d07ed8383948288fed53b31c6c0d0f8dfc91))


### Bug Fixes

* persist taskWorkflowStates in session snapshots and reconcile states from plan (Issue [#81](https://github.com/zaxbysauce/opencode-swarm/issues/81)) ([d5c3637](https://github.com/zaxbysauce/opencode-swarm/commit/d5c36376dee5d0db5bf19d6047f3bad346f086dd))
* resolve all biome lint errors to restore CI green ([2b19afc](https://github.com/zaxbysauce/opencode-swarm/commit/2b19afcbc1e8b1c8628a50ba6bd89a328b2150a5))

## [6.21.3]

### Phase 7 G�� Curator Documentation

* Updated `README.md` with complete Curator feature documentation G�� configuration table (8 fields), pipeline overview, and Issue #81 hotfix notes (taskWorkflowStates persistence, reconcileTaskStatesFromPlan behavior).
* Updated `docs/planning.md` with Curator integration guide G�� phase-monitor init, phase-complete pipeline, knowledge-injector drift injection, DriftReport interface, and config quick-reference table.

### Phase 6 G�� Curator Integration Wiring

* Added curator pipeline wiring after `curateAndStoreSwarm` in `phase_complete` (runCuratorPhase G�� applyCuratorKnowledgeUpdates G�� runCriticDriftCheck). Wrapped in try/catch to ensure phase_complete never blocks.
* Added Curator init call in `phase_monitor` firstG��phase guard with try/catch.
* Added drift injection in `knowledge_injector` (readPriorDriftReports G�� buildDriftInjectionText G�� prepend to cachedInjectionText) wrapped in try/catch.
* Added corresponding unit tests for these behaviours.(https://github.com/zaxbysauce/opencode-swarm/compare/v6.21.2...v6.21.3) (2026-03-08)


### Bug Fixes

* plumb ToolContext.sessionID into phase_complete to fix cross-session tracking ([be22929](https://github.com/zaxbysauce/opencode-swarm/commit/be22929273309b22876e6d612263bb007ebce4d3))
* plumb ToolContext.sessionID into phase_complete to fix cross-session tracking ([e7f898e](https://github.com/zaxbysauce/opencode-swarm/commit/e7f898e1f43cbd83f20b9511a9afec88489dda26)), closes [#89](https://github.com/zaxbysauce/opencode-swarm/issues/89)

## [6.21.2](https://github.com/zaxbysauce/opencode-swarm/compare/v6.21.1...v6.21.2) (2026-03-08)


### Bug Fixes

* state machine never advances on default config and CLI writes wrong config file ([#81](https://github.com/zaxbysauce/opencode-swarm/issues/81) [#84](https://github.com/zaxbysauce/opencode-swarm/issues/84)) ([ac8dffa](https://github.com/zaxbysauce/opencode-swarm/commit/ac8dffaaf6fb7c94675fa22621125cc420c20c57))
* state machine never advances on default config and CLI writes wrong config file ([#81](https://github.com/zaxbysauce/opencode-swarm/issues/81) [#84](https://github.com/zaxbysauce/opencode-swarm/issues/84)) ([9023b40](https://github.com/zaxbysauce/opencode-swarm/commit/9023b406527469672c644bb39610dae1e4fcd8e7))

## [6.21.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.21.0...v6.21.1) (2026-03-08)


### Bug Fixes

* **hotfix-78:** summarization verification, gate-state wiring, and plan-state guard hardening ([1bc62e8](https://github.com/zaxbysauce/opencode-swarm/commit/1bc62e8993c2307e35bcd00dc836e531f044de63))
* **hotfix-78:** summarization verification, gate-state wiring, and plan-state guard hardening ([a42f4f1](https://github.com/zaxbysauce/opencode-swarm/commit/a42f4f1298b04518f1be8d7ca23825f201b518b7))
* **lint:** replace control character regex literal with RegExp constructor to fix noControlCharactersInRegex CI error ([0673429](https://github.com/zaxbysauce/opencode-swarm/commit/0673429f3247dfee94f4e0a8c7194bc06264ced1))

## [6.21.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.20.3...v6.21.0) (2026-03-07)


### Features

* **gate-enforcement:** add per-task state machine, scope declaration, and hard blocks ([a1ab8ad](https://github.com/zaxbysauce/opencode-swarm/commit/a1ab8adb8378b3402c97184328e61442fd80774f))
* **gate-enforcement:** per-task state machine, scope declaration, and hard blocks (v6.21) ([90324cf](https://github.com/zaxbysauce/opencode-swarm/commit/90324cf53a88a7ad0132f9d8786b084d3e95e035))

## [6.20.3](https://github.com/zaxbysauce/opencode-swarm/compare/v6.20.2...v6.20.3) (2026-03-07)


### Bug Fixes

* resolve path before isSourceCodePath check, fix test gate setup ([d16df29](https://github.com/zaxbysauce/opencode-swarm/commit/d16df2936a0cdc63713ada655c5189d92d368157))
* resolve path before isSourceCodePath check, fix test gate setup ([d498cc0](https://github.com/zaxbysauce/opencode-swarm/commit/d498cc0c171fb19796dadc8cea482824540829d5))

## [6.20.2](https://github.com/zaxbysauce/opencode-swarm/compare/v6.20.1...v6.20.2) (2026-03-07)


### Bug Fixes

* gate warn() behind DEBUG and block direct plan.md writes ([4763f25](https://github.com/zaxbysauce/opencode-swarm/commit/4763f25f29405930b2fe91ecfe7e6f44dc7f98f9))
* gate warn() behind DEBUG and block direct plan.md writes ([36897b1](https://github.com/zaxbysauce/opencode-swarm/commit/36897b1236994a2ac0013b299679ee787606114e))

## [6.20.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.20.0...v6.20.1) (2026-03-07)


### Bug Fixes

* **dist:** rebuild dist after lint fixes ([fb5be58](https://github.com/zaxbysauce/opencode-swarm/commit/fb5be5821387815798f99744a35cc0cfc168b4e8))
* **dist:** rebuild dist artifacts for cwd fixes and delegation-gate additions ([6ed7a5b](https://github.com/zaxbysauce/opencode-swarm/commit/6ed7a5b9169f0130997bac6cbcf90a48c4064cbd))
* **lint:** resolve biome lint errors to unblock CI ([1aefafb](https://github.com/zaxbysauce/opencode-swarm/commit/1aefafb7ef46dbc84cd23c028fac6591a31c1fa0))
* use workspace directory as cwd for all subprocess calls ([5e24335](https://github.com/zaxbysauce/opencode-swarm/commit/5e243354e3f7828c7537e9d69b4e65261025173e))
* use workspace directory as cwd for all subprocess calls ([3d855b6](https://github.com/zaxbysauce/opencode-swarm/commit/3d855b6f012c49543b86a40509cb749de63cbfcb))

## [6.20.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.19.8...v6.20.0) (2026-03-07)


### Features

* **v6.20:** add AST diffing, parallelism framework, PR gate, checkpoint extension, agent output, skill versioning, and context efficiency ([f13ea28](https://github.com/zaxbysauce/opencode-swarm/commit/f13ea285cb862dc0e5dae5e641b560bd5c0ffac5))

#### New: PR-Based Human Gate (`src/git/`)
Swarm can now create branches, stage/commit files, and open GitHub PRs automatically at phase boundaries.
- `src/git/branch.ts` G�� `createBranch()`, `stageAll()`, `stageFiles()` (throws on empty array), `getCurrentBranch()`, `getCurrentSha()`
- `src/git/pr.ts` G�� `createPullRequest()` with `sanitizeInput()` for all gh CLI args, `generateEvidenceMd()` to attach swarm evidence as PR body
- `src/git/index.ts` G�� `runPRWorkflow()` orchestrates branch G�� commit G�� PR in one call

**Configuration:** No new config keys required. Uses your existing `gh` CLI authentication. Set `baseBranch` in `runPRWorkflow()` options to override the default (`main`).

#### New: Parallelism Framework (`src/parallel/`)
Infrastructure for tracking, routing, and coordinating parallel task execution.
- `src/parallel/meta-indexer.ts` G�� Indexes `meta.summary` fields from `events.jsonl` for parallel task introspection
- `src/parallel/review-router.ts` G�� Routes tasks to single or double reviewer based on complexity score
- `src/parallel/dependency-graph.ts` G�� Builds a dependency graph from `plan.json`, performs topological sort, detects circular dependencies
- `src/parallel/file-locks.ts` G�� Atomic file locking with TTL expiry and path traversal protection

**Configuration:** No configuration required in v6.20 G�� these modules are used internally by the swarm runtime.

#### New: AST-Aware Diffing (`src/diff/`)
Structured diff analysis using AST language definitions.
- `src/diff/ast-diff.ts` G�� `computeASTDiff()` returns typed `ASTChange[]` (added/removed/modified nodes) using tree-sitter grammars where available, falling back to line-diff for unsupported languages

**Configuration:** No configuration required. AST diff is invoked automatically by the diff gate when the changed file's language is registered in `src/lang/registry.ts`.

#### New: Role-Scoped Context Filter (`src/context/`)
Reduces context window pressure by filtering messages that don't apply to the receiving agent's role.
- `src/context/role-filter.ts` G�� Filters context entries based on `[FOR: agent1, agent2]` tags; entries tagged `[FOR: ALL]` are always passed through
- `src/context/zone-classifier.ts` G�� Classifies files into zones (`production` / `test` / `config` / `generated` / `docs` / `build`) to enforce file authority rules

**Configuration:** Tag your swarm output with `[FOR: reviewer, test_engineer]` or `[FOR: ALL]` to control which agents receive each context entry. No config key changes needed.

#### New: Agent Output Writer (`src/output/`)
Structured output formatting for agent responses.
- `src/output/agent-writer.ts` G�� `writeAgentOutput()` formats agent results with `meta.summary`, verdict, and structured sections; `readAgentOutput()` retrieves stored outputs; `listAgentOutputs()` enumerates all agent output files

**Configuration:** No configuration required. Output writer is used by architect hooks automatically.

#### New: Skill Versioning (`src/skills/`)
Skills now carry a `SKILL_VERSION` for compatibility tracking and can be overridden per agent.
- `src/skills/index.ts` G�� Exports `SKILL_VERSION`, base skill definitions, and per-agent overlay maps

**Configuration:** No action required. `SKILL_VERSION` is embedded in agent system prompts automatically.

#### New: Project Identity (`src/knowledge/`)
Each project now generates a stable identity hash for cross-session knowledge correlation.
- `src/knowledge/identity.ts` G�� `getOrCreateIdentity()` creates `.swarm/identity.json` with `projectHash`, `projectName`, `repoUrl`, and `absolutePath`

**Configuration:** Identity is created automatically on first swarm run. No configuration needed.

#### New: /swarm checkpoint Command (`src/commands/checkpoint.ts`)
The checkpoint system now has a user-facing slash command in addition to the existing tool.
- `/swarm checkpoint save [label]` G�� Save a named checkpoint
- `/swarm checkpoint restore [label]` G�� Restore to a checkpoint (soft reset)
- `/swarm checkpoint list` G�� List all checkpoints with timestamps
- `/swarm checkpoint delete [label]` G�� Remove a checkpoint

**Configuration:** No configuration required.

#### New: Delegation Envelope Types (`src/types/delegation.ts`)
Formal `DelegationEnvelope` interface for typed agent-to-agent task delegation, with `parseDelegationEnvelope()` for safe extraction from message content.

### Additions to Existing Modules

* `src/hooks/delegation-gate.ts` G�� Added `parseDelegationEnvelope()` export used by the role-scoped context filter
* `src/hooks/knowledge-store.ts` G�� Added `getPlatformConfigDir()` export for cross-platform config path resolution (Windows: `%LOCALAPPDATA%\opencode-swarm\config`, macOS: `~/Library/Application Support/opencode-swarm`, Linux: `~/.config/opencode-swarm`)

### Upgrade Notes

No breaking changes. All new modules are additive. Existing `plugin.config.ts` configurations are fully compatible with v6.20.0.

## [6.19.8](https://github.com/zaxbysauce/opencode-swarm/compare/v6.19.7...v6.19.8) (2026-03-06)


### Bug Fixes

* add handoff command, run memory service, and context budget guard ([efa334c](https://github.com/zaxbysauce/opencode-swarm/commit/efa334cd2e6435eda93176f3f3325a6e1d21d895))
* add handoff command, run memory, and context budget guard ([1118edb](https://github.com/zaxbysauce/opencode-swarm/commit/1118edbac57535eb83552251adb8eddffc264cca))

## [6.19.7](https://github.com/zaxbysauce/opencode-swarm/compare/v6.19.6...v6.19.7) (2026-03-06)


### Bug Fixes

* **dist:** rebuild dist artifacts for update_task_status and write_retro tool additions ([03eb93a](https://github.com/zaxbysauce/opencode-swarm/commit/03eb93ac5bb5ef096bcb3a339cfb3351358abb27))
* expose update_task_status and write_retro tools, repair retro compatibility ([ec96421](https://github.com/zaxbysauce/opencode-swarm/commit/ec964215369bae5226e2c0cbb0abf46fce37e485))
* **tests:** correct phase_complete adversarial test expectations for RETROSPECTIVE_MISSING behavior ([bc0383f](https://github.com/zaxbysauce/opencode-swarm/commit/bc0383ff14577e4f4fd18152d001c6c41c5500bf))
* **tools:** expose update_task_status and write_retro, repair retro compatibility, harden architect prompt ([694dd16](https://github.com/zaxbysauce/opencode-swarm/commit/694dd1656bd34dc5ffbfac71c0587bd898c6b9a0))

## [6.19.6](https://github.com/zaxbysauce/opencode-swarm/compare/v6.19.5...v6.19.6) (2026-03-06)


### Bug Fixes

* **ci:** remove native tree-sitter devDeps that compiled from source on Windows ([9138137](https://github.com/zaxbysauce/opencode-swarm/commit/9138137309f81ae2ac4c2287f7da436d4f5446a7))
* harden pre_check_batch, diff, glob, placeholder-scan, and sast-scan ([11c40f5](https://github.com/zaxbysauce/opencode-swarm/commit/11c40f5a1d4886a9c88c2403b563a74c6a5a8dda))
* **lint:** resolve 5 biome errors introduced by Phase 1-4 hardening ([9dacdf3](https://github.com/zaxbysauce/opencode-swarm/commit/9dacdf360db80c4fb0e4bfd4e42d6dbde6ceb701))
* tool hardening and Windows CI native-dep removal ([e6155e0](https://github.com/zaxbysauce/opencode-swarm/commit/e6155e09bed9705c1970c6b0d61b16ef6b24d804))

## [6.19.5](https://github.com/zaxbysauce/opencode-swarm/compare/v6.19.4...v6.19.5) (2026-03-06)


### Bug Fixes

* phase completion reliability and workspace validation hardening ([4051d14](https://github.com/zaxbysauce/opencode-swarm/commit/4051d14b71d5f5cce5b8f479c534eac8817d436a))
* phase completion reliability and workspace validation hardening ([600e9bb](https://github.com/zaxbysauce/opencode-swarm/commit/600e9bb158e98f30e375ce784271f561492bcf98))

## [6.19.4](https://github.com/zaxbysauce/opencode-swarm/compare/v6.19.3...v6.19.4) (2026-03-05)


### Bug Fixes

* **lint:** remove CI-blocking biome errors in hooks ([3e8fe80](https://github.com/zaxbysauce/opencode-swarm/commit/3e8fe80bad25c2c4df6758c98798b7b4ac45ebe7))

## [6.19.3](https://github.com/zaxbysauce/opencode-swarm/compare/v6.19.2...v6.19.3) (2026-03-04)


### Bug Fixes

* **architect:** tier QA gates to reduce low-risk churn ([5e38b05](https://github.com/zaxbysauce/opencode-swarm/commit/5e38b05a492c72b823abf17874a155c9d74618aa))

## [6.19.2](https://github.com/zaxbysauce/opencode-swarm/compare/v6.19.1...v6.19.2) (2026-03-04)


### Bug Fixes

* **build:** remove misplaced src test artifact breaking declarations ([3bee31e](https://github.com/zaxbysauce/opencode-swarm/commit/3bee31ea841b6af5773478f2c514892666be10bb))

## [6.19.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.19.0...v6.19.1) (2026-03-04)


### Bug Fixes

* **release:** realign release-please baseline to v6.19.0 ([02c505a](https://github.com/zaxbysauce/opencode-swarm/commit/02c505a0aa73aca0c9a96c288f04dc6d3cbdedf2))

## [6.19.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.18.1...v6.19.0) (2026-03-04)


### Features

* v6.19.0 G�� Prompt-Quality & Adversarial Robustness Update ([0fdf2e8](https://github.com/zaxbysauce/opencode-swarm/commit/0fdf2e818846a0f2c66b8ff42cd650b8d923f0c1))

## v6.19.0 G�� Prompt-Quality & Adversarial Robustness Update

### Added
- **Critic Sounding Board mode** G�� Architect consults critic before escalating to user (UNNECESSARY/REPHRASE/APPROVED/RESOLVE verdicts)
- **Architect Escalation Discipline** G�� Three-tier escalation hierarchy (self-resolve G�� critic G�� user)
- **Adversarial detector patterns** G�� PRECEDENT_MANIPULATION, SELF_REVIEW, CONTENT_EXEMPTION, GATE_DELEGATION_BYPASS, VELOCITY_RATIONALIZATION
- **Intent reconstruction in mega-reviewer** G�� Reconstructs developer intent before evaluating changes
- **Complexity-scaled review depth** G�� TRIVIAL/MODERATE/COMPLEX classification determines review thoroughness
- **SME confidence-gated routing** G�� Architect routes LOW-confidence results to second opinion or user flag
- **meta.summary convention** G�� Agents include one-line summaries in state events for downstream consumption
- **Role-relevance tagging** G�� Agents tag outputs with [FOR: agent1, agent2] for future context filtering
- **Cross-agent verbosity controls** G�� Response length scales to finding complexity

### Improved
- **Critic DRIFT-CHECK** with trajectory-level evaluation, first-error focus, anti-rubber-stamp bias
- **Mega-reviewer three-tier review structure** (correctness G�� safety G�� quality)
- **SME confidence levels and staleness awareness**

### Added (Hotfix)
- **Coder self-audit checklist** G�� Pre-completion verification
- **Gate authority block** G�� Architect cannot self-judge task completion
- **Retry circuit breaker** G�� Architect intervenes after 3 coder rejections to simplify approach
- **Spec-writing discipline for destructive operations** G�� Mandatory error strategy, message accuracy, platform compatibility
- **SME platform awareness** G�� Cross-platform verification required for OS-interaction APIs

### JSONL Events
- `sounding_board_consulted` G�� Every sounding board invocation
- `architect_loop_detected` G�� Third occurrence of same impasse
- `precedent_manipulation_detected` G�� Highest-severity adversarial pattern
- `coder_self_audit` G�� End of every task
- `coder_retry_circuit_breaker` G�� Coder task rejected 3 times


## [6.18.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.18.0...v6.18.1) (2026-03-04)


### Bug Fixes

* retrospective schema mismatch G�� write_retro tool + /swarm write-retro command (v6.18.1) ([406a635](https://github.com/zaxbysauce/opencode-swarm/commit/406a6355648d5cfb1965d78fdc1f6c11370b01dd))

## [6.18.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.17.3...v6.18.0) (2026-03-04)


### Features

* robustness, discoverability & intelligence expansion (v6.18.0) ([f5fd2ef](https://github.com/zaxbysauce/opencode-swarm/commit/f5fd2ef7667165101aeaa76fd8b2209193c79ad3))

## [6.17.3](https://github.com/zaxbysauce/opencode-swarm/compare/v6.17.2...v6.17.3) (2026-03-03)


### Bug Fixes

* diagnostic signal fidelity G�� warnG��log reclassification and loadEvidence discriminated union (v6.17.3) ([986eed5](https://github.com/zaxbysauce/opencode-swarm/commit/986eed540328eb0803d70fdf9e7b61ebef22839a))

## [6.17.2](https://github.com/zaxbysauce/opencode-swarm/compare/v6.17.1...v6.17.2) (2026-03-03)


### Bug Fixes

* add bunx run subcommand for out-of-session plugin invocation (v6.17.2) ([847b0e4](https://github.com/zaxbysauce/opencode-swarm/commit/847b0e489f77370d64ea070739a5828732636a19))

## [6.17.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.17.0...v6.17.1) (2026-03-03)


### Bug Fixes

* wire knowledge migrate command, retrieval outcomes, and dark matter persistence (v6.17.1) ([98ce920](https://github.com/zaxbysauce/opencode-swarm/commit/98ce920dee309ba61aa8f92bb8a5d5ed4a5fb1ec))

## [6.17.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.16.1...v6.17.0) (2026-03-03)


### Features

* add two-tier cross-project knowledge base (v6.17.0) ([6f0e90d](https://github.com/zaxbysauce/opencode-swarm/commit/6f0e90d8aea5590d1fc1f613b5a894667a931779))

## [6.16.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.16.0...v6.16.1) (2026-03-02)


### Bug Fixes

* add spec lifecycle fixes G�� explicit override, stale detection, archival, plan ingestion gate (v6.16.1) ([6c94b6c](https://github.com/zaxbysauce/opencode-swarm/commit/6c94b6c3e00826af59dab961cfe15c5bf72ca436))

## [6.16.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.15.0...v6.16.0) (2026-03-02)

### Features

* **Multi-Language Support (11 languages, 3 tiers)** G�� Language profile abstraction in `src/lang/profiles.ts` covering TypeScript/JS, Python, Rust, Go (Tier 1), Java, Kotlin, C#/.NET, C/C++, Swift (Tier 2), Dart/Flutter, Ruby (Tier 3)
* **Profile-driven build detection** G�� `discoverBuildCommandsFromProfiles()` in `src/build/discovery.ts` picks highest-priority build binary per language profile; existing detection preserved as fallback
* **Profile-driven test framework detection** G�� 9 new detect functions in `src/tools/test-runner.ts`; 16 frameworks total (Go, Java/Maven, Java/Gradle, Kotlin, C#, CMake/ctest, Swift, Dart, Ruby RSpec/minitest)
* **Profile-driven lint detection** G�� `detectAdditionalLinter()` in `src/tools/lint.ts`; 10 detector functions (golangci-lint, Checkstyle, ktlint, dotnet-format, cppcheck, swiftlint, dart analyze, RuboCop, scalafmt, buf)
* **Package audit expansion** G�� govulncheck (Go), dotnet list package (C#), bundle-audit (Ruby), dart pub outdated (Dart) in `src/tools/pkg-audit.ts`; all 7 auditors normalized to unified result format
* **Semgrep SAST integration** G�� profile-driven language dispatch in `src/tools/sast-scan.ts`; auto-mode (`semgrep --config auto --lang`) for languages without native rulesets; soft warning when semgrep binary absent
* **Language-aware prompt injection** G�� coder and reviewer agents receive language-specific constraints and review checklists from task file paths via `getProfileForFile()` in `src/hooks/system-enhancer.ts`; both Path A and Path B inject for coder + reviewer
* **New Tree-sitter grammars** G�� Kotlin, Swift, Dart WASM grammars vendored in `src/lang/grammars/`; `LANGUAGE_WASM_MAP` updated in `src/lang/runtime.ts`
* **Graceful degradation** G�� all profile-driven tools skip with a soft warning when required binary is not on PATH; never a hard gate failure
* **200+ new tests** G�� `tests/unit/lang/`, `tests/integration/lang/`, `tests/unit/tools/`, `tests/unit/hooks/` covering profiles, detector, tool integration, and prompt injection

## [6.15.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.14.12...v6.15.0) (2026-03-02)


### Features

* add requirements-driven planning pipeline (v6.15.0) ([c2b6262](https://github.com/zaxbysauce/opencode-swarm/commit/c2b6262b62ebaa77b96fee13bae86b84f41576aa))

## [6.15.0](https://github.com/zaxbysauce/opencode-swarm/compare/v6.14.12...v6.15.0) (2026-03-02)

### Features

* SPECIFY mode for Architect G�� generate structured requirement specs (FR-###, SC-###) from feature descriptions (src/agents/architect.ts)
* CLARIFY-SPEC mode for Architect G�� resolve spec ambiguities one question at a time, max 8 questions (src/agents/architect.ts)
* Soft Spec Gate in PLAN mode G�� warns when planning without a spec and offers to create one or skip (src/agents/architect.ts)
* ANALYZE mode for Critic G�� audit plans against specs for gaps and gold-plating with FR-### coverage table (src/agents/critic.ts)
* DRIFT-CHECK mode for Critic G�� automatic requirement drift detection at phase boundaries in PHASE-WRAP (src/agents/critic.ts, src/agents/architect.ts)
* Project Governance G�� auto-detect MUST/SHOULD rules from project-instructions.md in DISCOVER mode (src/agents/architect.ts)
* Research Caching for SME G�� cache external URL lookups in context.md ## Research Sources to avoid redundant fetches (src/agents/sme.ts)
* External plan import path in SPECIFY mode G�� reverse-engineer spec from existing plan and validate task format (src/agents/architect.ts)
* New commands: /swarm specify, /swarm clarify, /swarm analyze (src/commands/specify.ts, src/commands/clarify.ts, src/commands/analyze.ts)
* Automated release notes pipeline G�� update-release-notes CI job populates GitHub release body from docs/releases/{tag}.md (.github/workflows/release-and-publish.yml)

## [6.14.12](https://github.com/zaxbysauce/opencode-swarm/compare/v6.14.11...v6.14.12) (2026-03-02)


### Bug Fixes

* harden context enforcement and stabilize cross-platform CI ([7e4cf0a](https://github.com/zaxbysauce/opencode-swarm/commit/7e4cf0a513e5dc1cd13ff3f7645d25a1942a9e2c))

## [6.14.12](https://github.com/zaxbysauce/opencode-swarm/compare/v6.14.11...v6.14.12) (2026-03-02)

### Features

* Hard context enforcement with priority pruning and agentG��switch reset (src/hooks/context-budget.ts)
* ProviderG��aware model limit resolution (src/hooks/model-limits.ts)
* Message priority classification tiers (src/hooks/message-priority.ts)
* Windows absolute path validation in utils (src/hooks/utils.ts)
* CI test timeout safeguard to prevent hangs ( .github/workflows/ci.yml )

### Bug Fixes

* Guardrails fixes for delegation and selfG��coding detection
* Minor stability improvements

## [6.14.11](https://github.com/zaxbysauce/opencode-swarm/compare/v6.14.10...v6.14.11) (2026-03-01)


### Bug Fixes

* add token fallback when OIDC publish fails ([549131d](https://github.com/zaxbysauce/opencode-swarm/commit/549131d4e0efeabb986e851191ef9dbb95f72d86))

## [6.14.10](https://github.com/zaxbysauce/opencode-swarm/compare/v6.14.9...v6.14.10) (2026-03-01)


### Bug Fixes

* force npm trusted publish via OIDC-only auth path ([199dbb5](https://github.com/zaxbysauce/opencode-swarm/commit/199dbb5026d35b76a39c22450115db4804495511))

## [6.14.9](https://github.com/zaxbysauce/opencode-swarm/compare/v6.14.8...v6.14.9) (2026-03-01)


### Bug Fixes

* use minimal npm trusted publisher workflow config ([d014a0c](https://github.com/zaxbysauce/opencode-swarm/commit/d014a0c7f415b871a0e4b6206e6489090f90edde))

## [6.14.8](https://github.com/zaxbysauce/opencode-swarm/compare/v6.14.7...v6.14.8) (2026-03-01)


### Bug Fixes

* clear setup-node auth token before npm trusted publish ([53ee183](https://github.com/zaxbysauce/opencode-swarm/commit/53ee183c2aedae0d3652119a01008e20f4641fbf))

## [6.14.7](https://github.com/zaxbysauce/opencode-swarm/compare/v6.14.6...v6.14.7) (2026-03-01)


### Bug Fixes

* set npm environment on publish job for trusted publisher OIDC ([c47b8e6](https://github.com/zaxbysauce/opencode-swarm/commit/c47b8e6975e96d45775bbcb51bb8646bc9b99fee))

## [6.14.6](https://github.com/zaxbysauce/opencode-swarm/compare/v6.14.5...v6.14.6) (2026-03-01)


### Bug Fixes

* suppress GITHUB_TOKEN injection in setup-node for OIDC npm publish ([923565c](https://github.com/zaxbysauce/opencode-swarm/commit/923565ca1a57c31b34be23610bb89c5c825502dc))

## [6.14.5](https://github.com/zaxbysauce/opencode-swarm/compare/v6.14.4...v6.14.5) (2026-03-01)


### Bug Fixes

* restore registry-url to setup-node to enable OIDC npm publish ([7d47e97](https://github.com/zaxbysauce/opencode-swarm/commit/7d47e97312c7091f6869fac60398c138928d13d5))

## [6.14.4](https://github.com/zaxbysauce/opencode-swarm/compare/v6.14.3...v6.14.4) (2026-03-01)


### Bug Fixes

* remove registry-url from setup-node to unblock OIDC npm publish ([3d17561](https://github.com/zaxbysauce/opencode-swarm/commit/3d1756154827fee6f0db22ec67fafbaab812e916))

## [6.14.3](https://github.com/zaxbysauce/opencode-swarm/compare/v6.14.2...v6.14.3) (2026-03-01)


### Bug Fixes

* switch publish-npm to OIDC trusted publishing (remove NPM_TOKEN, add provenance) ([5cfa728](https://github.com/zaxbysauce/opencode-swarm/commit/5cfa728537c1f07eb5d7d6475fee96f44e9d5764))

## [6.14.2](https://github.com/zaxbysauce/opencode-swarm/compare/v6.14.1...v6.14.2) (2026-03-01)


### Bug Fixes

* declare js-yaml devDependency and harden CI/publish workflows ([30e7fdf](https://github.com/zaxbysauce/opencode-swarm/commit/30e7fdf89a1b50ab3b7289023f0e1844b10d88c5))
* remove matrix false positive from ci-workflow-security expression injection check ([9950a40](https://github.com/zaxbysauce/opencode-swarm/commit/9950a40cbcaa9c5e4f511e8541812dff89f8c3c4))

## [6.13.4](https://github.com/zaxbysauce/opencode-swarm/compare/v6.13.3...v6.13.4) (2026-03-01)


### Features

* v6.13.3 retrospective enforcement & memory improvements ([3ce66cd](https://github.com/zaxbysauce/opencode-swarm/commit/3ce66cd3d2c5319a21682b5a42b8ca103fa3ca26))


### Bug Fixes

* add null guard in system-enhancer adversarial afterEach before rmSync ([af49674](https://github.com/zaxbysauce/opencode-swarm/commit/af49674fc2652197cc5c4e9916994faddb028dc0))
* resolve 10 pre-existing syntax-check test failures ([3460a34](https://github.com/zaxbysauce/opencode-swarm/commit/3460a34bc6b6db5aa83837b7e461a28012c9734e))
* stop test-plan-sync dirs leaking into project root ([c84cad0](https://github.com/zaxbysauce/opencode-swarm/commit/c84cad0d4675fdf2fd285c88ec03fe4d91d8aab8))
* use os.tmpdir() in tests to prevent temp dirs leaking into project root ([b32a0e1](https://github.com/zaxbysauce/opencode-swarm/commit/b32a0e103306b36fe6fafd0a8a3d2c893314b59b))

## [6.13.3] - 2026-02-28

### Bug Fixes
- **Retrospective gate:** `phase_complete` now requires a retrospective evidence bundle
  before allowing phase completion. Agents can no longer skip retrospectives.
- **Phase-scoped retro injection:** System enhancer now reads the previous phase's
  retrospective by phase number (not random recent file) and always injects lessons G��
  not just when `reviewer_rejections > 2`.
- **Deduplicated retro logic:** Extracted shared retrospective injection function from
  duplicated Path A / Path B code in system-enhancer.ts.

### Improvements
- **User directive capture:** New `user_directives` field in RetrospectiveEvidence schema
  captures user corrections with category and persistence scope.
- **Approach tracking:** New `approaches_tried` field tracks what was attempted and why
  approaches were abandoned, enabling future trajectory mining.
- **Pre-phase briefing:** Architect prompt now requires reading previous phase retrospective
  and printing a briefing acknowledgment before starting any new phase.
- **Coder retro injection:** Coder agent now receives condensed lessons_learned from the
  previous phase's retrospective.
- **Cross-project memory:** Phase 1 of any project now receives historical lessons from
  up to 3 recent retrospectives from prior projects in the same workspace, including
  carried-forward user directives.
- **Phase count guidance:** Architect prompt now discourages single-phase plans for large
  task sets (5+ tasks G�� 2+ phases, 10+ tasks G�� 3+ phases).
- **Plan ID tagging:** Retrospectives now include `plan_id` in metadata for reliable
  cross-project vs. same-plan filtering.

## [6.13.2] - 2026-02-28

### Added
- **`phase_complete` tool**: New enforcement gate that verifies all required agents (coder, reviewer, test_engineer) were dispatched before a phase completes. Emits structured `PhaseCompleteEvent` to `.swarm/events.jsonl`, resets per-phase dispatch tracking, and blocks or warns based on configurable policy (`enforce`/`warn`).
- **`exempt_tools` config**: `SummaryConfigSchema` now supports `exempt_tools` (default: `['retrieve_summary','task']`) to prevent summarization loops G�� outputs from those tools are never summarized.
- **Same-model adversarial detection**: New `AdversarialDetectionConfigSchema` and `src/hooks/adversarial-detector.ts`. Detects when coder and reviewer share the same underlying model and injects a warning or policy escalation into the reviewer's system prompt. Supports `warn`, `gate`, and `ignore` policies.
- **Swarm Briefing doc**: `docs/swarm-briefing.md` G�� 95-line LLM-readable pipeline briefing covering the 12-step pipeline, task format table, sizing rules, and example tasks.
- **Task Field Reference**: Inserted `## Task Field Reference` into `docs/planning.md` with FILE/TASK/CONSTRAINT/AC definitions, Good/Bad examples, and SMALL/MEDIUM/LARGE sizing guidance.

### Fixed
- **HF-1b G�� Architect test execution guardrail**: Architect agents now receive an injection preventing bulk `bun test` runs. Only specific test files for code modified in-session may be run, one at a time. Resolves crash-on-concurrent-test-run issue.
- **HF-1 scope refactor**: `baseRole` declaration hoisted out of block scope so it is shared between the HF-1 (coder/test_engineer no-verify) and HF-1b (architect no-bulk-test) guardrail blocks.

### Tests
- 46 new tests for HF-1b guardrails (`system-enhancer-hf1b.test.ts`, `system-enhancer-hf1b-adversarial.test.ts`)
- 400 tests across 17 files for Phases 1G��4 (phase_complete, summarization loop, adversarial detection, docs)

## [6.12.1](https://github.com/zaxbysauce/opencode-swarm/compare/v6.12.0...v6.12.1) (2026-02-28)


### Bug Fixes

* TypeScript errors from optional current_phase ([284bc5f](https://github.com/zaxbysauce/opencode-swarm/commit/284bc5f574ef87210063c0bc8abe3fcd165b5886))

## [6.13.1] - 2026-02-28

### Added
- **consolidateSystemMessages** utility to merge multiple system messages into one at index 0.
- **Test isolation helpers** `createIsolatedTestEnv` and `assertSafeForWrite`.
- Migration for v6.12 presets-format configs (inG��memory, with warning).

### Fixed
- `/swarm` command template: `{{arguments}}` G�� `$ARGUMENTS` with LLM noG��op instruction.
- `install()` default config: preset/presets schema G�� agents schema.
- DEFAULT_MODELS updates: `claude-sonnet-4-5` G�� `claude-sonnet-4-20250514`, `gemini-2.0-flash` G�� `gemini-2.5-flash`.

### Tests
- 20 new tests for consolidation utility.
- 14 new tests for isolation helper.

## [6.13.0] - 2026-02-28

### Added
- **Role-Scoped Tool Filtering**: AGENT_TOOL_MAP in src/config/constants.ts
  - Architect gets all 17+ tools
  - Other agents capped at 12 tools
  - Config option: tool_filter.enabled/overrides

- **Plan Cursor**: Compressed plan summary under 1,500 tokens
  - extractPlanCursor in src/hooks/extractors.ts
  - Priority 1 injection in system-enhancer
  - Config: plan_cursor.enabled/max_tokens/lookahead_tasks

- **Mode-Conditional System Injection**: detectArchitectMode in src/hooks/system-enhancer.ts
  - DISCOVER/PLAN/EXECUTE/PHASE-WRAP/UNKNOWN modes
  - DISCOVER mode suppresses: Plan Cursor, Decisions, Agent Context, Drift, Pre-Check
  - Phase Header always injects

- **Tool Output Truncation**: truncateToolOutput in src/utils/tool-output.ts
  - Config: tool_output.truncation_enabled/max_lines/per_tool
  - Only diff/symbols tools truncated by default
  - Footer with omitted lines count and retrieval guidance

- **ZodError Fixes**: src/config/plan-schema.ts
  - current_phase now optional with inference fallback
  - PhaseStatusSchema accepts both 'complete' and 'completed'
  - loadPlan guarded with try-catch in system-enhancer

### Tests
- 209 new tests across 6 test files

## [6.12.0] - 2026-02-27

### Added
- **Anti-Process-Violation Hardening**: Runtime detection hooks to catch architect workflow violations
  - Self-coding detection: Warns when architect uses write/edit tools directly instead of delegating to mega_coder
  - Gate tracking: Detects partial QA gate execution (skipping gates)
  - Self-fix detection: Warns when same agent fixes its own gate failure within 2 minutes
  - Batch detection: Detects "implement X and add Y" batching in delegation requests
  - Zero-coder-delegation detection: Catches when tasks complete without any coder delegation
  - Catastrophic violation warning: Warns when Phase >= 4 has zero reviewer calls

- **New state tracking fields** in `AgentSessionState`:
  - `architectWriteCount`: Tracks architect's direct code edits
  - `gateLog`: Tracks which QA gates have run
  - `reviewerCallCount`: Tracks mega_reviewer delegations
  - `lastGateFailure`: Records last failed gate for self-fix detection
  - `selfFixAttempted`: Flag for self-fix detection
  - `partialGateWarningIssued`: Dedup for partial gate warnings
  - `catastrophicPhaseWarnings`: Set of phases with catastrophic warnings
  - `lastCoderDelegationTaskId`: Tracks last delegated task for zero-delegation detection

- **Pipeline-tracker compliance escalation**: Phase >= 4 now includes explicit compliance reminders

### Changed
- **Architect prompt hardening**: Added 11 new enforcement blocks to the architect agent prompt:
  - ANTI-SELF-CODING RULES with concrete G��/G�� rationalization examples
  - Tool-usage boundary clarifying Rule 1 (DELEGATE all coding)
  - Self-coding pre-check in Rule 4 fallback
  - PARTIAL GATE RATIONALIZATIONS anti-pattern list
  - G�� TASK COMPLETION GATE hard-stop checklist
  - precheckbatch SCOPE BOUNDARY (Stage A gates only)
  - Rule 7 STAGE A / STAGE B restructure
  - CATASTROPHIC VIOLATION CHECK for zero-reviewer scenarios
  - GATE FAILURE RESPONSE RULES with structured rejection format
  - Rule 3 BATCHING DETECTION + split requirement
  - RETRY PROTOCOL with resume-at-step instruction

- **Delegation gate enhanced**: Batch detection now catches 8 patterns including verb+and+verb, "while you're at it", and compound task descriptions

### Fixed
- **Path traversal in `isOutsideSwarmDir`**: Now uses `path.resolve()` and `path.relative()` for proper normalization instead of simple prefix check (fixes `.swarm/../src/evil.ts` bypass)
- **Lint errors across codebase**: Fixed 30+ lint errors in checkpoint.ts, test-runner.ts, pkg-audit.ts, placeholder-scan.ts, syntax-check.ts, trigger.ts

### Security
- **Path traversal bypass fixed**: The `isOutsideSwarmDir` function in `guardrails.ts` now correctly detects traversal attempts like `.swarm/../src/evil.ts`, `../.swarm/../../etc/passwd`, and URL-encoded variants
- **135 adversarial security tests**: Comprehensive coverage of path traversal, prototype pollution, state mutation, gate bypass, and batch detection evasion attacks

### Tests
- **487 new v6.12 tests** across 8 test files:
  - `self-coding-detection.test.ts`: 40+ tests for self-coding, batch, self-fix detection
  - `gate-tracking.test.ts`: Gate tracking, reviewer count, delegation violation tests
  - `guardrails-catastrophic-warning.test.ts`: Catastrophic warning injection, deduplication, edge cases
  - `guardrails-v612-adversarial.test.ts`: Circuit breaker, config tampering, state pollution attacks
  - Plus updates to existing test files for new hook behaviors
- **34 new path traversal adversarial tests** in `guardrails-pathtraversal-adversarial.test.ts`

---

## v6.11.1 - Packaging Fix (2026-02-27)

### Fixes

- Remove `postinstall` hook to avoid Bun dependency during npm global install
- Grammars are bundled via `bun run build` into `dist/lang/grammars`

## v6.11.0 - Architect Prompt Hardening (2026-02-26)

### Workflow Hardening

#### MODE Labels G�� Clear Architect Workflow Phases
Renamed internal workflow headers from "Phase N" to explicit MODE labels:
- `MODE: RESUME` G�� Resume detection
- `MODE: CLARIFY` G�� Requirement clarification
- `MODE: DISCOVER` G�� Codebase exploration
- `MODE: CONSULT` G�� SME consultation
- `MODE: PLAN` G�� Plan creation
- `MODE: CRITIC-GATE` G�� Plan review checkpoint
- `MODE: EXECUTE` G�� Task implementation
- `MODE: PHASE-WRAP` G�� Phase completion

**NAMESPACE RULE**: MODE labels refer to architect's internal workflow. Project plan phases remain "Phase N" in plan.md.

#### G�� HARD STOP G�� Pre-Commit Checklist
Mandatory 4-item checklist before marking any task complete:
- [ ] All QA gates passed (lint:check, secretscan, sast_scan)
- [ ] Reviewer approval documented
- [ ] Tests pass with evidence
- [ ] No security findings

There is no override. A commit without a completed QA gate is a workflow violation.

#### Observable Output G�� Required Print Statements
All blocking steps (5c-5m) now require explicit output:
```
G�� REQUIRED: Print {description} on all blocking steps
```
Ensures visibility into gate progress and failure points.

### Task Quality Enforcement

#### Task Granularity Rules
Tasks classified as SMALL/MEDIUM/LARGE with decomposition requirements:
- **SMALL**: 1 file, single verb, <2 hours
- **MEDIUM**: 1-2 files, compound action, <4 hours
- **LARGE**: Must decompose into smaller tasks

#### Task Atomicity Checks
Critic validates tasks are not oversized:
- Max 2 files per task (otherwise decompose)
- No compound verbs ("and", "plus", "with") in task descriptions
- Clear acceptance criteria required

#### TASK COMPLETION CHECKLIST
Emit before marking task complete:
- Evidence written to `.swarm/evidence/{taskId}/`
- plan.md updated with `[x] task complete`
- Completion confirmation printed

### Failure Handling

#### FAILURE COUNTING
Retry counter with escalation after 5 failures:
```
RETRY #{count}/5
```

#### RETRY PROTOCOL
Structured rejection format on gate failure:
```
RETRY #{count}/5
FAILED GATE: {gate_name}
REASON: {specific failure}
REQUIRED FIX: {actionable instruction}
RESUME AT: {step_5x}
```

### Anti-Rationalization

#### ANTI-EXEMPTION RULES (8 patterns blocked)
The following rationalizations are explicitly blocked:
1. "It's a simple change"
2. "Just updating docs"
3. "Only a config tweak"
4. "Hotfix, no time for QA"
5. "The tests pass locally"
6. "I'll clean it up later"
7. "No logic changes"
8. "Already reviewed the pattern"

There are NO simple changes. There are NO exceptions to the QA gate sequence.

### Security

#### AUTHOR BLINDNESS WARNING
Added to coder prompt: warns against self-review bias and requires treating own code with same scrutiny as others'.

### Updated Phase 5 QA Gate Sequence

```
coder G�� diff G�� syntax_check G�� placeholder_scan G�� imports G�� 
lint fix G�� build_check G�� pre_check_batch (4 parallel: lint:check, secretscan, sast_scan, quality_budget) G�� 
reviewer G�� security review G�� verification tests G�� adversarial tests G�� coverage check G�� complete
```

**Note**: `secretscan` and `sast_scan` now run inside `pre_check_batch`, not as standalone steps.

### Files Changed
- `src/agents/architect.ts` G�� MODE labels, HARD STOP, observable output, anti-exemption rules
- `src/agents/critic.ts` G�� Task granularity checks, atomicity validation
- `src/agents/coder.ts` G�� Author blindness warning
- `tests/unit/agents/architect-gates.test.ts` G�� Gate sequence tests
- `tests/unit/agents/architect-v6-prompt.test.ts` G�� Prompt structure validation
- `tests/unit/agents/architect-workflow-security.test.ts` G�� Security gate tests
- `tests/unit/agents/architect-adversarial.test.ts` G�� Anti-rationalization tests

---

## v6.10.0 - Parallel Pre-Check Batch (2026-02-26)

### New Features

#### pre_check_batch - Parallel Verification Tooling

**4x faster QA gates** by running independent checks in parallel:

- **lint:check** - Code quality verification (hard gate)
- **secretscan** - Secret detection (hard gate)  
- **sast_scan** - Static security analysis with 63+ rules (hard gate)
- **quality_budget** - Maintainability threshold enforcement

**Benefits**:
- Reduces total gate time from ~60s (sequential) to ~15s (parallel)
- All tools run via `p-limit` with max 4 concurrent operations
- Individual tool timeouts (60s) prevent cascading failures
- Unified `gates_passed` boolean for simplified gate logic

### New Configuration

```json
{
  "pipeline": {
    "parallel_precheck": true  // default: true
  }
}
```

Set to `false` to run gates sequentially (useful for debugging or resource constraints).

### Updated Phase 5 QA Gate Sequence

```
coder G�� diff G�� syntax_check G�� placeholder_scan G�� imports G�� 
lint fix G�� build_check G�� pre_check_batch (parallel) G�� 
reviewer G�� security reviewer G�� test_engineer G�� coverage check
```

### System Hints

Architect receives hints about parallel vs sequential mode via system enhancer hook. Phase 5 prompt updated to use `pre_check_batch` after `build_check`.

### Dependencies

- Added `p-limit@7.3.0` for concurrency control

### Upgrade Guide

**No breaking changes.**

1. Update to v6.10.0
2. Parallel pre-check enabled by default
3. Set `pipeline.parallel_precheck: false` to disable if needed
4. Run `bun test` to verify installation

---

## v6.9.0 - Quality & Anti-Slop Tooling (2026-02-25)

### New Features

#### syntax_check - Tree-sitter Parse Validation
- Validates syntax across 9+ languages (JS/TS, Python, Go, Rust, Java, PHP, C, C++, C#)
- Uses Tree-sitter parsers for accurate error detection
- Runs before all other gates to catch syntax errors early

#### placeholder_scan - Anti-Slop Detection
- Detects TODO/FIXME/TBD/XXX comments in production code
- Identifies placeholder text and stub implementations
- Prevents shipping incomplete or "sloppy" code
- Configurable allow_globs for docs/tests directories

#### sast_scan - Static Security Analysis
- 63+ offline security rules across 9 languages
- High-signal, low false-positive detection
- Tier A: Built-in rules (always available)
- Tier B: Optional Semgrep integration (if on PATH)
- Rules cover: eval, command injection, deserialization, buffer overflow, etc.

#### sbom_generate - Dependency Tracking
- Generates CycloneDX v1.5 SBOMs
- Supports 8 ecosystems: Node.js, Python, Rust, Go, Java, .NET, Swift, Dart
- Parses lock files: package-lock.json, Cargo.lock, poetry.lock, go.sum, etc.
- Non-blocking evidence collection

#### build_check - Build Verification
- Runs repo-native build/typecheck commands
- Supports 10+ ecosystems with automatic detection
- Graceful skip when toolchain unavailable
- Captures build output for debugging

#### quality_budget - Maintainability Enforcement
- Enforces 4 quality metrics:
  - Complexity delta (cyclomatic complexity)
  - Public API delta (new exports)
  - Duplication ratio (copy-paste detection)
  - Test-to-code ratio (coverage proxy)
- Configurable thresholds per project
- Integrated with `/swarm benchmark --ci-gate`

### New Evidence Types
- `syntax` - Syntax check results
- `placeholder` - Placeholder scan findings
- `sast` - Security analysis findings
- `sbom` - Software Bill of Materials
- `build` - Build verification results
- `quality_budget` - Quality metrics and violations

### Configuration

New `gates` config section in `.opencode/swarm.json`:

```json
{
  "gates": {
    "syntax_check": { "enabled": true },
    "placeholder_scan": { "enabled": true },
    "sast_scan": { "enabled": true },
    "sbom_generate": { "enabled": true },
    "build_check": { "enabled": true },
    "quality_budget": {
      "enabled": true,
      "max_complexity_delta": 5,
      "max_public_api_delta": 10,
      "max_duplication_ratio": 0.05,
      "min_test_to_code_ratio": 0.3
    }
  }
}
```

### Complete QA Gate Sequence

```
coder G�� diff G�� syntax_check G�� placeholder_scan G�� imports G�� 
lint G�� secretscan G�� sast_scan G�� build_check G�� quality_budget G�� 
reviewer G�� security reviewer G�� test_engineer G�� coverage check
```

### Local-Only Guarantee

All v6.9.0 quality tools run **locally** without:
- Docker containers
- Network connections
- External APIs
- Cloud services

Optional enhancement: Semgrep (only if already installed on PATH)

### Upgrade Guide

**No breaking changes.**

1. Update to v6.9.0
2. New gates are enabled by default
3. Configure thresholds in `.opencode/swarm.json` (optional)
4. Run `bun test` to verify installation

### Stats
- 6 new tools
- 6 new evidence types
- 12 total evidence types
- 1,100+ tests passing
- 63 SAST rules
- 11 supported languages

---

## Previous Versions

### v6.8.x
- Evidence system
- Benchmark suite
- CI gate
