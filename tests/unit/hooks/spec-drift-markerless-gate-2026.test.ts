/**
 * PR 3920 closeout (SolCritic): markerless spec-pair gate. With no staleness
 * marker and no PREPARED/corrupt recovery WAL, enforceSpecDriftGate compares
 * plan.json's stored specHash to the current effective spec with loadPlan's
 * semantics. Split from spec-drift-block.test.ts for the FR-006 cap.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { enforceSpecDriftGate } from '../../../src/hooks/guardrails';

/**
 * PR 3920 closeout (SolCritic): the marker is not the only drift signal. With no
 * marker and no PREPARED/corrupt WAL, the gate compares plan.json's specHash to
 * the current effective spec directly (loadPlan's semantics: hashless exemption,
 * deletion, obligation-preserving exemption, bootstrap allow). A COMMITTED WAL
 * must not suppress this check; only a marker or PREPARED/corrupt WAL has
 * precedence.
 */
describe('markerless spec-pair gate (PR 3920 closeout)', () => {
	let pairDir: string;

	beforeEach(async () => {
		pairDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spec-drift-pair-'));
		await fs.mkdir(path.join(pairDir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		try {
			await fs.rm(pairDir, { recursive: true, force: true });
		} catch {
			// best effort
		}
	});

	function writePair(specContent: string, planSpecHash: string): void {
		fsSync.writeFileSync(path.join(pairDir, '.swarm', 'spec.md'), specContent);
		fsSync.writeFileSync(
			path.join(pairDir, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Pair Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
				migration_status: 'native',
				specHash: planSpecHash,
			}),
		);
	}

	const hashOf = (content: string): string =>
		createHash('sha256').update(content, 'utf-8').digest('hex');

	test('markerless drift blocks with spec_write repair guidance, not acknowledgment', () => {
		writePair('# Spec\n\nNew requirements.\n', hashOf('# Spec\n\nOld.\n'));

		expect(() => enforceSpecDriftGate(pairDir, 'save_plan')).toThrow(
			/canonical spec_write/,
		);
		expect(() => enforceSpecDriftGate(pairDir, 'save_plan')).toThrow(
			/markerless/,
		);
	});

	test('a markerless consistent pair admits', () => {
		writePair('# Spec\n\nSame.\n', hashOf('# Spec\n\nSame.\n'));
		expect(() => enforceSpecDriftGate(pairDir, 'save_plan')).not.toThrow();
	});

	test('bootstrap with no plan.json admits', () => {
		fsSync.writeFileSync(path.join(pairDir, '.swarm', 'spec.md'), '# Spec\n');
		expect(() => enforceSpecDriftGate(pairDir, 'save_plan')).not.toThrow();
	});

	test('a pre-feature hashless plan admits', () => {
		writePair('# Spec\n\nChanged.\n', '');
		expect(() => enforceSpecDriftGate(pairDir, 'save_plan')).not.toThrow();
	});

	test('an invalid plan.json blocks as retryable, not drift', () => {
		fsSync.writeFileSync(path.join(pairDir, '.swarm', 'spec.md'), '# Spec\n');
		// Parseable JSON that violates PlanSchema: reaches the schema-validation arm.
		fsSync.writeFileSync(
			path.join(pairDir, '.swarm', 'plan.json'),
			JSON.stringify({ schema_version: '2.0.0', title: 'x' }),
		);

		expect(() => enforceSpecDriftGate(pairDir, 'save_plan')).toThrow(
			/failed schema validation|not valid JSON/,
		);
	});

	test('a COMMITTED recovery WAL does not suppress the markerless check', () => {
		writePair('# Spec\n\nNew requirements.\n', hashOf('# Spec\n\nOld.\n'));
		fsSync.writeFileSync(
			path.join(pairDir, '.swarm', 'spec-drift-recovery.json'),
			JSON.stringify({
				version: 2,
				mode: 'repair',
				state: 'COMMITTED',
				transitionId: 'committed-1',
				markerHash: 'marker-hash',
				planTitle: 'Pair Plan',
				phase: 1,
				previousHash: 'old',
				newHash: hashOf('# Spec\n\nNew requirements.\n'),
				specContent: '# Spec\n\nNew requirements.\n',
				actor: 'spec_write',
				recordedAt: '2026-11-26T00:00:00.000Z',
			}),
		);

		expect(() => enforceSpecDriftGate(pairDir, 'save_plan')).toThrow(
			/SPEC_DRIFT_BLOCK/,
		);
	});

	test('an obligation-preserving edit admits despite a stale stored hash', () => {
		// Snapshot and current spec are identical obligation-bearing content, so the
		// edit is obligation-preserving even though the stored hash predates it.
		const spec = '# Spec\n\nMUST keep this obligation FR-1.\n';
		fsSync.writeFileSync(path.join(pairDir, '.swarm', 'spec.md'), spec);
		fsSync.writeFileSync(
			path.join(pairDir, '.swarm', 'spec-snapshot.md'),
			spec,
		);
		fsSync.writeFileSync(
			path.join(pairDir, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Pair Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
				migration_status: 'native',
				specHash: hashOf('# Spec\n\nOld obligations.\n'),
			}),
		);

		expect(() => enforceSpecDriftGate(pairDir, 'save_plan')).not.toThrow();
	});

	test('an auto-detected projection failure with no native spec blocks as retryable (F-012)', () => {
		// No env/config binding, but Spec-Kit is detectable (.specify marker plus a
		// specs/<feature>/spec.md layout): auto-detection runs and its failure must
		// not read as deletion.
		fsSync.mkdirSync(path.join(pairDir, '.specify'), { recursive: true });
		fsSync.mkdirSync(path.join(pairDir, 'specs', 'my-feature'), {
			recursive: true,
		});
		fsSync.writeFileSync(
			path.join(pairDir, 'specs', 'my-feature', 'spec.md'),
			'# Feature spec.\n',
		);
		fsSync.writeFileSync(
			path.join(pairDir, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Pair Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
				migration_status: 'native',
				specHash: hashOf('# Spec\n\nGone.\n'),
			}),
		);

		expect(() => enforceSpecDriftGate(pairDir, 'save_plan')).toThrow(
			/retry or repair/,
		);
	});

	test('an empty .specify marker does not mask a genuine deletion (F-013)', () => {
		// The reader treats an empty marker as NOT a competing source, so a null
		// here is a genuine deletion and must say so.
		fsSync.mkdirSync(path.join(pairDir, '.specify'), { recursive: true });
		fsSync.writeFileSync(
			path.join(pairDir, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Pair Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
				migration_status: 'native',
				specHash: hashOf('# Spec\n\nGone.\n'),
			}),
		);

		expect(() => enforceSpecDriftGate(pairDir, 'save_plan')).toThrow(/deleted/);
	});

	test('a failed projection with no native spec blocks as retryable, not deletion (F-011)', () => {
		// A bound projection source (env) whose projection fails returns null with no
		// native file: retryable, not deletion.
		process.env.SWARM_SDD_SOURCE = 'speckit';
		try {
			fsSync.writeFileSync(
				path.join(pairDir, '.swarm', 'plan.json'),
				JSON.stringify({
					schema_version: '1.0.0',
					title: 'Pair Plan',
					swarm: 'test-swarm',
					current_phase: 1,
					phases: [
						{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] },
					],
					migration_status: 'native',
					specHash: hashOf('# Spec\n\nGone.\n'),
				}),
			);

			expect(() => enforceSpecDriftGate(pairDir, 'save_plan')).toThrow(
				/retry or repair/,
			);
		} finally {
			delete process.env.SWARM_SDD_SOURCE;
		}
	});

	test('an empty openspec directory does not mask a genuine deletion (F-014)', () => {
		// The reader yields a null projection for an empty openspec/ layout, so a
		// null here is a genuine deletion and must say so.
		fsSync.mkdirSync(path.join(pairDir, 'openspec'), { recursive: true });
		fsSync.writeFileSync(
			path.join(pairDir, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Pair Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
				migration_status: 'native',
				specHash: hashOf('# Spec\n\nGone.\n'),
			}),
		);

		expect(() => enforceSpecDriftGate(pairDir, 'save_plan')).toThrow(/deleted/);
	});

	test('an openspec layout with inputs but an empty projection blocks as retryable (F-015)', () => {
		// openspec/ has a spec file, but its content parses to zero requirements, so
		// the projection returns null: a projection FAILURE, not source absence.
		fsSync.mkdirSync(path.join(pairDir, 'openspec', 'specs', 'x'), {
			recursive: true,
		});
		fsSync.writeFileSync(
			path.join(pairDir, 'openspec', 'specs', 'x', 'spec.md'),
			'Plain notes with no requirement headings.\n',
		);
		fsSync.writeFileSync(
			path.join(pairDir, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Pair Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
				migration_status: 'native',
				specHash: hashOf('# Spec\n\nGone.\n'),
			}),
		);

		expect(() => enforceSpecDriftGate(pairDir, 'save_plan')).toThrow(
			/retry or repair/,
		);
	});

	test('an oversized sole openspec input blocks as retryable, not deletion (F-016)', () => {
		// The build's scans drop files over MAX_SOURCE_BYTES, so the sole spec input
		// vanishes from the scan; presence must still hold and the block must be
		// retryable, not deletion.
		fsSync.mkdirSync(path.join(pairDir, 'openspec', 'specs', 'x'), {
			recursive: true,
		});
		fsSync.writeFileSync(
			path.join(pairDir, 'openspec', 'specs', 'x', 'spec.md'),
			'# Spec\n\n' + 'x'.repeat(513 * 1024) + '\n',
		);
		fsSync.writeFileSync(
			path.join(pairDir, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Pair Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
				migration_status: 'native',
				specHash: hashOf('# Spec\n\nGone.\n'),
			}),
		);

		expect(() => enforceSpecDriftGate(pairDir, 'save_plan')).toThrow(
			/retry or repair/,
		);
	});

	test('a deleted spec blocks as drift', () => {
		fsSync.writeFileSync(
			path.join(pairDir, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Pair Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
				migration_status: 'native',
				specHash: hashOf('# Spec\n\nGone.\n'),
			}),
		);

		expect(() => enforceSpecDriftGate(pairDir, 'save_plan')).toThrow(/deleted/);
	});

	test('malformed UTF-8 in plan.json blocks as retryable, not drift (F-009)', () => {
		// The malformed byte sits INSIDE the title string, so a replacing decoder
		// would still parse and schema-validate the file and misread it as drift.
		fsSync.writeFileSync(path.join(pairDir, '.swarm', 'spec.md'), '# Spec\n');
		const head = Buffer.from('{"schema_version":"1.0.0","title":"a', 'utf8');
		const tail = Buffer.from(
			'","swarm":"x","current_phase":1,"phases":[{"id":1,"name":"P","status":"in_progress","tasks":[]}],"migration_status":"native","specHash":"abc"}',
			'utf8',
		);
		fsSync.writeFileSync(
			path.join(pairDir, '.swarm', 'plan.json'),
			Buffer.concat([head, Buffer.from([0xff]), tail]),
		);

		expect(() => enforceSpecDriftGate(pairDir, 'save_plan')).toThrow(
			/could not be read/,
		);
	});

	test('an unreadable-but-present spec blocks as retryable, not deletion (F-010)', () => {
		// spec.md exists but exceeds the native reader's 512 KiB bound: the reader
		// returns null, which is unreadability, not deletion.
		fsSync.writeFileSync(
			path.join(pairDir, '.swarm', 'spec.md'),
			`# Spec\n\n${'x'.repeat(513 * 1024)}\n`,
		);
		fsSync.writeFileSync(
			path.join(pairDir, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Pair Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
				migration_status: 'native',
				specHash: hashOf('# Spec\n\nGone.\n'),
			}),
		);

		expect(() => enforceSpecDriftGate(pairDir, 'save_plan')).toThrow(
			/retry or recover/,
		);
	});
});
