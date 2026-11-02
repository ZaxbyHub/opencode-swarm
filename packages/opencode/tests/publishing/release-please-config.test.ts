import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Repo root relative to this test file: packages/opencode/tests/publishing/
const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..', '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'release-please-config.json');

// The reviewed bootstrap bound: the DORMANT TIP of the pre-resurrection
// 8.x line (23f051f1 "Merge pull request #207 …", 2026-03-16). The bound
// must exclude every BREAKING CHANGE commit (an earlier bound re-includes
// them and re-proposes 9.0.0-beta.0 — issue #3173's misfire); the dormant
// tip strictly dominates the previous bound (the last breaking commit,
// 98b020168) as an ancestor, so the exclusion invariant is preserved,
// while the six same-day March fix commits between them (376b12730,
// 288ac87, 6fdebce18, 7211e9a, 6a3ac99, and the merge noise) drop out of
// the bootstrap changelog sweep — they were polluting the release PR body
// (observed in #3235).
//
// Stranding note (corrects the previous bound rationale): telemetry has
// zero commits in (23f051f1, HEAD], and that is SAFE — release-please's
// linked-versions plugin appends
//   chore(telemetry): Synchronize opencode-swarm versions
//     Release-As: <primaryVersion>
// for group members with no release of their own (plugins/linked-versions
// buildRelocations path, verified against release-please 16.18.0 and
// 17.1.3), forcing every group member to release in lockstep whenever ANY
// member releases. The per-package "needs >=1 commit after the bound"
// leg that used to live here encoded the opposite (pre-linked-versions)
// premise and was replaced by the group-membership assertion below (the
// 'linked-versions lockstep group covers exactly the configured
// components' test) — that is the property that actually prevents
// stranding.
const REQUIRED_BOOTSTRAP_SHA = '23f051f1143d3566f05163c1a7a80d40b5b16ee7';
const PREVIOUS_BOOTSTRAP_SHA = '98b020168298679467bce6d5d20ce1fbdf62c06b';
// Explicit path -> component mapping (not just a set): a swapped pair would
// pass a set assertion while rendering misattributed tags
// (e.g. core released as telemetry-v8.0.2-beta.0).
const EXPECTED_COMPONENT_BY_PATH: Record<string, string> = {
	'packages/opencode': 'opencode',
	'packages/core': 'core',
	'packages/claude-code': 'claude-code',
	'packages/telemetry': 'telemetry',
};
// Dead config keys: `branches` is consumed by nothing (release-please@16/17
// read root keys only); `changelog-notes-type` is not a release-please key
// at all (the schema key is `changelog-type`) and is silently ignored.
const DEAD_ROOT_KEYS = ['branches', 'changelog-notes-type'];

function loadConfig(): Record<string, unknown> {
	if (!existsSync(CONFIG_PATH)) {
		throw new Error(`release-please-config.json not found at ${CONFIG_PATH}`);
	}
	return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}

function gitExitCode(args: string[]): number | undefined {
	// NOTE: Bun.spawnSync THROWS (ENOENT) when the binary is absent; a throw
	// here is a real environment failure, not a skip condition.
	return Bun.spawnSync(['git', '-C', REPO_ROOT, ...args], { stdout: 'ignore', stderr: 'ignore' }).exitCode;
}

describe('release-please config (issue #3150 release enablement)', () => {
	test('root bootstrap-sha is pinned to the reviewed bound', () => {
		const cfg = loadConfig();
		expect(cfg['bootstrap-sha']).toBe(REQUIRED_BOOTSTRAP_SHA);
	});

	test('no dead root-level config keys', () => {
		// release-please@16/17 and the pinned action read only root-level keys
		// (a `branches` array is silently ignored), and `changelog-notes-type`
		// is not a release-please key at all (the schema key is
		// `changelog-type`) - both would mislead readers into thinking the
		// next line is configured as written.
		const cfg = loadConfig();
		for (const key of DEAD_ROOT_KEYS) {
			expect(key in cfg, `dead root-level key "${key}" must not return`).toBe(false);
		}
	});

	test('per-component tags: include-component-in-tag is true, every package maps to its exact component, and no package overrides the flag', () => {
		const cfg = loadConfig();
		// With include-component-in-tag false, strategies/base.js blanks the
		// component: linked-versions can never match and every package shares
		// the collision-prone bare `v<version>` tag namespace (a drifted
		// monorepo then collides tags across version lines). release-please
		// honors a PER-PATH override of this key (manifest.js:
		// `pathConfig.includeComponentInTag ?? defaultConfig`), so a package
		// entry must not be able to silently restore the bare namespace.
		expect(cfg['include-component-in-tag']).toBe(true);
		const packages = (cfg['packages'] ?? {}) as Record<string, Record<string, unknown>>;
		for (const [pkgPath, expectedComponent] of Object.entries(EXPECTED_COMPONENT_BY_PATH)) {
			const entry = packages[pkgPath];
			expect(entry, `${pkgPath} must be present in packages`).toBeTypeOf('object');
			expect(entry['component'], `${pkgPath} component must be exactly "${expectedComponent}"`).toBe(expectedComponent);
			expect(
				'include-component-in-tag' in entry,
				`${pkgPath} must not override include-component-in-tag (would silently restore the shared tag namespace)`,
			).toBe(false);
		}
		expect(Object.keys(packages).sort()).toEqual(Object.keys(EXPECTED_COMPONENT_BY_PATH).sort());
	});

	test('linked-versions lockstep group covers exactly the configured components', () => {
		const cfg = loadConfig();
		const plugins = (cfg['plugins'] ?? []) as Array<unknown>;
		const types = plugins.map((p) => (typeof p === 'object' && p !== null ? (p as Record<string, unknown>)['type'] : p));
		expect(types).toContain('node-workspace');
		const linked = plugins.filter(
			(p) => typeof p === 'object' && p !== null && (p as Record<string, unknown>)['type'] === 'linked-versions',
		);
		expect(linked.length).toBe(1);
		const group = linked[0] as Record<string, unknown>;
		expect(group['groupName']).toBeTypeOf('string');
		expect((group['groupName'] as string).length).toBeGreaterThan(0);
		const expectedComponents = Object.values(EXPECTED_COMPONENT_BY_PATH).sort();
		expect([...((group['components'] ?? []) as string[])].sort()).toEqual(expectedComponents);
	});

	// History-dependent leg. CI's actions/checkout is shallow (depth 1) by
	// default and cannot resolve the anchor, so the leg degrades there — but
	// the two failure shapes are distinguished: a SHALLOW clone skips honestly,
	// while a FULL clone that cannot resolve the anchor (bogus/rewritten sha)
	// FAILS. On full clones it proves the properties that make the bound
	// correct: the bound resolves and is an ancestor of HEAD, it dominates
	// the previous (last-breaking-commit) bound, and no BREAKING CHANGE
	// commit exists after it — detected in BOTH Conventional-Commits forms.
	test('bootstrap-sha is the dormant tip and no breaking commit follows it (honest skip on shallow checkouts)', () => {
		const shallow = Bun.spawnSync(['git', '-C', REPO_ROOT, 'rev-parse', '--is-shallow-repository'], {
			stdout: 'pipe',
			stderr: 'ignore',
		});
		if (shallow.exitCode === 0 && shallow.stdout.toString().trim() === 'true') {
			console.log(`skip: shallow checkout cannot verify the ancestry of ${REQUIRED_BOOTSTRAP_SHA.slice(0, 8)} - run in a full clone to exercise this leg`);
			return;
		}
		expect(gitExitCode(['cat-file', '-e', `${REQUIRED_BOOTSTRAP_SHA}^{commit}`]), 'bootstrap-sha must resolve in a full clone (bogus/rewritten sha is a config defect)').toBe(0);
		expect(gitExitCode(['merge-base', '--is-ancestor', REQUIRED_BOOTSTRAP_SHA, 'HEAD']), 'bootstrap-sha must be an ancestor of HEAD').toBe(0);
		// The dormant tip must dominate the previous bound (the last breaking
		// commit): that is what guarantees the move never re-exposes a
		// breaking commit to the sweep.
		expect(gitExitCode(['merge-base', '--is-ancestor', PREVIOUS_BOOTSTRAP_SHA, REQUIRED_BOOTSTRAP_SHA]), 'the dormant-tip bound must strictly dominate the previous last-breaking-commit bound').toBe(0);
		// No BREAKING CHANGE commit may exist after the bound: one would force
		// a major bump back onto the 9.0.0-beta.0 misfire path. Conventional
		// commits express breaking two ways - a `BREAKING CHANGE:` footer
		// (trailer form) or a `!` before the colon in the subject.
		//
		// TRAILER LEG: git's trailer parser accepts the hyphen form
		// (`BREAKING-CHANGE:`) only — trailer keys are space-free, so the
		// standard space form parses to ZERO trailers (verified: printf
		// '…\n\nBREAKING CHANGE: x\n' | git interpret-trailers --parse emits
		// nothing). The trailer leg therefore sees hyphen-form footers.
		const trailers = Bun.spawnSync(
			['git', '-C', REPO_ROOT, 'log', '--format=%H|%-(trailers:key=BREAKING-CHANGE,valueonly)', `${REQUIRED_BOOTSTRAP_SHA}..HEAD`],
			{ stdout: 'pipe', stderr: 'ignore', timeout: 30_000 },
		);
		expect(trailers.exitCode).toBe(0);
		const trailerBreaking = trailers.stdout.toString().split('\n').filter((line) => {
			const value = line.slice(line.indexOf('|') + 1).trim();
			return line.includes('|') && value !== '';
		});
		expect(trailerBreaking, `commits with a BREAKING CHANGE trailer after the bound: ${trailerBreaking.join('; ')}`).toEqual([]);
		// BODY-SCAN LEG (#3229 R2): the space form `BREAKING CHANGE:` is
		// invisible to every trailers:key filter, so scan raw bodies
		// line-anchored. Both `BREAKING CHANGE:` and `BREAKING-CHANGE:` at
		// line start match. Records are framed with %x1e (argv-safe; a real
		// NUL cannot travel in an argv string).
		const bodies = Bun.spawnSync(
			['git', '-C', REPO_ROOT, 'log', '--format=%H%x1e%B%x1e', `${REQUIRED_BOOTSTRAP_SHA}..HEAD`],
			{ stdout: 'pipe', stderr: 'ignore', timeout: 30_000 },
		);
		expect(bodies.exitCode).toBe(0);
		// Framing: `%H%x1e%B%x1e` emits sha + RS + body + RS per commit, so
		// the split yields sha/body PAIRS at even/odd indices (review
		// PRR-014: the old single-sequence loop misattributed the body as
		// the identifier; detection was unaffected, triage was not).
		const bodyBreaking: string[] = [];
		const records = bodies.stdout.toString().split('');
		for (let i = 0; i + 1 < records.length; i += 2) {
			const sha = records[i].trim();
			const body = records[i + 1];
			if (sha === '') continue;
			if (/^BREAKING[ -]CHANGE:/m.test(body)) {
				bodyBreaking.push(sha.slice(0, 12));
			}
		}
		expect(bodyBreaking, `commits with a space/hyphen-form BREAKING CHANGE footer after the bound: ${bodyBreaking.join('; ')}`).toEqual([]);
		const subjects = Bun.spawnSync(['git', '-C', REPO_ROOT, 'log', '--format=%s', `${REQUIRED_BOOTSTRAP_SHA}..HEAD`], {
			stdout: 'pipe',
			stderr: 'ignore',
		});
		expect(subjects.exitCode).toBe(0);
		const bangBreaking = subjects.stdout.toString().split('\n').filter((line) => /^[a-zA-Z]+(\([^)]*\))?!:/.test(line));
		expect(bangBreaking, `breaking-by-syntax subjects after the bound: ${bangBreaking.join('; ')}`).toEqual([]);
	});
});

describe('breaking-commit body-scan leg is self-verifying (#3229 R2)', () => {
	// The scan regex used by the ancestry leg, exercised directly: it must
	// match BOTH footer spellings at line start and NOT match prose mentions
	// mid-line or a `BREAKING`-prefixed unrelated token. This pins the
	// detector itself, so a future refactor cannot silently narrow it back
	// to the trailer parser's hyphen-only view.
	const scanRe = /^BREAKING[ -]CHANGE:/m;
	test('matches space and hyphen footer forms at line start', () => {
		expect(scanRe.test('fix: demo\n\nBREAKING CHANGE: drops the v1 API\n')).toBe(true);
		expect(scanRe.test('fix: demo\n\nBREAKING-CHANGE: drops the v1 API\n')).toBe(true);
	});
	test('does not match prose mentions or unrelated tokens', () => {
		expect(scanRe.test('fix: demo\n\nthis is not a BREAKING CHANGE: notice\n')).toBe(false);
		expect(scanRe.test('fix: mention of BREAKING CHANGES elsewhere\n')).toBe(false);
		expect(scanRe.test('fix: BREAKINGCHANGE: no space before colon\n')).toBe(false);
	});
	test('executed mechanism pin: the space-key trailer filter was vacuous; corrected filter + body scan detect footers (#3229 R2)', () => {
		// Synthetic dangling commits (commit-tree against HEAD's tree, no ref
		// created, no working-tree impact) carry one footer spelling each —
		// the executed proof that the trailer leg alone is insufficient and
		// the body-scan leg is load-bearing.
		const tree = Bun.spawnSync(['git', '-C', REPO_ROOT, 'rev-parse', 'HEAD^{tree}'], { stdout: 'pipe', stderr: 'ignore' });
		expect(tree.exitCode).toBe(0);
		const treeSha = tree.stdout.toString().trim();
		const commitWithMessage = (message: string): string => {
			// CI runners carry no git identity (actions/checkout configures
			// none), and commit-tree refuses without one (exit 128). Provide
			// a per-invocation test identity so the probe is deterministic on
			// every runner image.
			const res = Bun.spawnSync(
				['git', '-C', REPO_ROOT, '-c', 'user.name=issue-tracer-probe', '-c', 'user.email=probe@example.invalid', 'commit-tree', treeSha, '-p', 'HEAD', '-m', message],
				{ stdout: 'pipe', stderr: 'ignore', timeout: 30_000 },
			);
			expect(res.exitCode).toBe(0);
			return res.stdout.toString().trim();
		};
		const spaceForm = commitWithMessage('fix: probe\n\nBREAKING CHANGE: space form value');
		const hyphenForm = commitWithMessage('fix: probe\n\nBREAKING-CHANGE: hyphen form value');
		const trailerValue = (sha: string, key: string): string => {
			const res = Bun.spawnSync(
				['git', '-C', REPO_ROOT, 'log', '-1', `--format=%(trailers:key=${key},valueonly)`, sha],
				{ stdout: 'pipe', stderr: 'ignore', timeout: 30_000 },
			);
			return res.stdout.toString().trim();
		};
		// The ORIGINAL filter spelling (`key=BREAKING CHANGE`, space-bearing)
		// matched NOTHING at all — the old leg was vacuous. git's trailer key
		// grammar is space-free, so the filter key itself never matches.
		expect(trailerValue(spaceForm, 'BREAKING CHANGE')).toBe('');
		expect(trailerValue(hyphenForm, 'BREAKING CHANGE')).toBe('');
		// The corrected hyphen-key filter sees the hyphen form only.
		expect(trailerValue(spaceForm, 'BREAKING-CHANGE')).toBe('');
		expect(trailerValue(hyphenForm, 'BREAKING-CHANGE')).toBe('hyphen form value');
		// The body scan catches BOTH spellings — the reason it exists.
		expect(scanRe.test(`fix: probe\n\nBREAKING CHANGE: space form value\n`)).toBe(true);
		expect(scanRe.test(`fix: probe\n\nBREAKING-CHANGE: hyphen form value\n`)).toBe(true);
	});
});
