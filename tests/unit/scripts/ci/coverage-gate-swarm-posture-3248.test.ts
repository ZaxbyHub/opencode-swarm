/**
 * Pins the coverage gate's checkout-drift posture alignment (issue #3248,
 * class 1). The checkout-drift preload (tests/preload/prod-store-tripwire.ts
 * + tests/helpers/checkout-drift.ts) enforces "creating `.swarm/` where none
 * existed". The unit job pre-writes `.swarm/repository-validation/` manifests
 * before any test file runs; scripts/ci/run-coverage-gate.sh historically did
 * not, so on every fresh coverage shard the FIRST file whose execution
 * materialized `.swarm/` (the writers tracked in #3165-A) failed attempt 1
 * and passed the in-job retry — the ubuntu/coverage-only retry-flake wave
 * behind the 2026-10 flake-detection issue flood (cli-version /
 * commands.test / run-command / delegation-gate-scope /
 * guardrails-modified-files: 22/22/22/16/16 detections).
 *
 * These tests are source-text pins (the script only runs on an ubuntu CI
 * runner with a full checkout; the repo's precedent for pinning CI script
 * wiring by source scan is tests/unit/scripts/ci/ci-yml-integration.test.ts).
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..', '..');
const GATE_SCRIPT = path.join(
	REPO_ROOT,
	'scripts',
	'ci',
	'run-coverage-gate.sh',
);
const DRIFT_HELPER = path.join(
	REPO_ROOT,
	'tests',
	'helpers',
	'checkout-drift.ts',
);

describe('coverage-gate checkout-drift posture (issue #3248)', () => {
	const script = fs.readFileSync(GATE_SCRIPT, 'utf-8');
	const helper = fs.readFileSync(DRIFT_HELPER, 'utf-8');

	test('the gate pre-creates .swarm/coverage-gate before the per-file loop', () => {
		expect(script).toContain('mkdir -p .swarm/coverage-gate');
		// PRR-024: pin the mkdir itself BEFORE the loop — a reorder that
		// leaves the cp before `failed=0` but moves the mkdir after it would
		// make the cp target a nonexistent directory at runtime.
		const mkdirAt = script.indexOf('mkdir -p .swarm/coverage-gate');
		const manifestAt = script.indexOf(
			'cp gated-tests.txt ".swarm/coverage-gate/shard-${shard_index:-all}-expected-files.txt"',
		);
		const loopAt = script.indexOf('failed=0');
		expect(mkdirAt).toBeGreaterThan(-1);
		expect(manifestAt).toBeGreaterThan(mkdirAt);
		expect(loopAt).toBeGreaterThan(manifestAt);
	});

	test('the gate refuses a symlinked or non-directory .swarm before writing', () => {
		expect(script).toContain('[ -L .swarm ]');
		// The refusal must bite: the guard's OWN exit 1, bounded to the guard
		// block — an unrelated `exit 1` later in the file must not satisfy
		// this pin (PRR-022's unbounded-indexOf gap).
		const guardAt = script.indexOf('[ -L .swarm ]');
		expect(guardAt).toBeGreaterThan(-1);
		const guardWindow = script.slice(guardAt, guardAt + 400);
		expect(guardWindow).toContain('exit 1');
	});

	test('the drift helper ignores the coverage-gate prefix alongside repository-validation', () => {
		expect(helper).toContain("'coverage-gate'");
		// Both CI-owned prefixes must be in the SAME ignore list (PRR-023:
		// assert inside the slice, not file-wide — the literal elsewhere in
		// the file must not satisfy this).
		const listStart = helper.indexOf('IGNORED_SWARM_PREFIXES');
		const listEnd = helper.indexOf('];', listStart);
		const list = helper.slice(listStart, listEnd);
		expect(list).toContain("'repository-validation'");
		expect(list).toContain("'coverage-gate'");
	});

	test('the posture trade-off stays tied to its retirement plan (#3165-A, PRR-036)', () => {
		// The pre-creation skips the drift tripwire's creation check on
		// coverage shards; since #3165-A a write inside .swarm/ fails anyway.
		// The gate comment must keep naming #3165-A so removing that
		// acknowledgment fails a pin.
		const postureComment = script.indexOf('Checkout-drift posture alignment');
		expect(postureComment).toBeGreaterThan(-1);
		expect(script.slice(postureComment, postureComment + 1600)).toContain(
			'#3165-A',
		);
	});
});
