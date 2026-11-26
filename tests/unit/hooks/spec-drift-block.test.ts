/**
 * Tests for the spec-drift structural block (issue #853 Layer B).
 *
 * Covers SPEC_DRIFT_BLOCKED_TOOLS membership (registration-coherent — every
 * blocked tool must exist as a TOOL_NAMES entry) and the runtime behavior of
 * enforceSpecDriftGate against .swarm/spec-staleness.json.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	enforceSpecDriftGate,
	SPEC_DRIFT_BLOCKED_TOOLS,
} from '../../../src/hooks/guardrails';

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spec-drift-block-'));
	await fs.mkdir(path.join(tmpDir, '.swarm'), { recursive: true });
});

afterEach(async () => {
	try {
		await fs.rm(tmpDir, { recursive: true, force: true });
	} catch {
		// best effort
	}
});

async function writeStalenessFile(): Promise<void> {
	await fs.writeFile(
		path.join(tmpDir, '.swarm', 'spec-staleness.json'),
		JSON.stringify({
			specHash_plan: 'def456',
			specHash_current: 'abc123',
			reason: 'spec.md changed since plan saved',
		}),
	);
}

async function removeStalenessFile(): Promise<void> {
	try {
		await fs.unlink(path.join(tmpDir, '.swarm', 'spec-staleness.json'));
	} catch {
		// best effort
	}
}

const SPEC_CONTENT = '# Spec\n';

async function writeRecoveryWal(
	state: 'PREPARED' | 'COMMITTED' | 'corrupt',
): Promise<void> {
	const raw =
		state === 'corrupt'
			? '{ bad wal'
			: JSON.stringify({
					version: 2,
					mode: 'repair',
					state,
					transitionId: `test-${state}`,
					markerHash: 'marker-hash',
					planTitle: 'Plan',
					phase: 1,
					previousHash: 'old',
					// newHash must be the hash of the captured content, as the
					// recovery run requires (F-002); a mismatched pair is corrupt.
					newHash: createHash('sha256')
						.update(SPEC_CONTENT, 'utf-8')
						.digest('hex'),
					specContent: SPEC_CONTENT,
					actor: 'spec_write',
					recordedAt: '2026-11-25T00:00:00.000Z',
				});
	await fs.writeFile(
		path.join(tmpDir, '.swarm', 'spec-drift-recovery.json'),
		raw,
	);
}

const NON_BLOCKED_TOOLS = [
	'get_approved_plan',
	'lint_spec',
	'set_qa_gates',
	'convene_council',
	'convene_general_council',
	'submit_phase_council_verdicts',
	'lean_turbo_plan_lanes',
	'lean_turbo_runner_status',
	'lean_turbo_review',
];

describe('SPEC_DRIFT_BLOCKED_TOOLS membership', () => {
	test('contains exactly 5 entries (size prevents drift)', () => {
		expect(SPEC_DRIFT_BLOCKED_TOOLS.size).toBe(5);
	});

	test('exact membership: the five known blocked tools', () => {
		const expected = new Set<string>([
			'save_plan',
			'update_task_status',
			'phase_complete',
			'lean_turbo_run_phase',
			'lean_turbo_acquire_locks',
		]);
		expect(SPEC_DRIFT_BLOCKED_TOOLS.size).toBe(expected.size);
		for (const t of expected) {
			expect(SPEC_DRIFT_BLOCKED_TOOLS.has(t)).toBe(true);
		}
	});

	test('NOT-blocked tools: the documented allow-list is excluded', () => {
		for (const tool of NON_BLOCKED_TOOLS) {
			expect(SPEC_DRIFT_BLOCKED_TOOLS.has(tool)).toBe(false);
		}
	});
});

describe('enforceSpecDriftGate', () => {
	test('throws SPEC_DRIFT_BLOCK for every blocked tool when staleness file exists', async () => {
		await writeStalenessFile();
		for (const tool of SPEC_DRIFT_BLOCKED_TOOLS) {
			expect(() => enforceSpecDriftGate(tmpDir, tool)).toThrow(
				/SPEC_DRIFT_BLOCK/,
			);
		}
	});

	test('explains the agent-executable repair path and that clarify alone does not clear drift', async () => {
		await writeStalenessFile();
		expect(() => enforceSpecDriftGate(tmpDir, 'save_plan')).toThrow(
			/clarify alone does not clear drift/i,
		);
		expect(() => enforceSpecDriftGate(tmpDir, 'save_plan')).toThrow(
			/canonical spec_write/,
		);
	});

	test('does NOT throw for non-blocked tools even when staleness file exists', async () => {
		await writeStalenessFile();
		for (const tool of NON_BLOCKED_TOOLS) {
			expect(() => enforceSpecDriftGate(tmpDir, tool)).not.toThrow();
		}
	});

	test('does NOT throw when staleness file is absent', async () => {
		for (const tool of SPEC_DRIFT_BLOCKED_TOOLS) {
			expect(() => enforceSpecDriftGate(tmpDir, tool)).not.toThrow();
		}
	});

	test('immediately unblocks after staleness file is deleted (no cache)', async () => {
		await writeStalenessFile();
		expect(() => enforceSpecDriftGate(tmpDir, 'save_plan')).toThrow(
			/SPEC_DRIFT_BLOCK/,
		);
		await removeStalenessFile();
		expect(() => enforceSpecDriftGate(tmpDir, 'save_plan')).not.toThrow();
	});

	test('a PREPARED recovery WAL blocks protected mutations without a marker', async () => {
		await writeRecoveryWal('PREPARED');
		expect(() => enforceSpecDriftGate(tmpDir, 'save_plan')).toThrow(
			/PREPARED spec-drift recovery transaction is incomplete/,
		);
		expect(() => enforceSpecDriftGate(tmpDir, 'save_plan')).toThrow(
			/canonical spec_write/,
		);
		expect(() => enforceSpecDriftGate(tmpDir, 'save_plan')).toThrow(
			/acknowledge-spec-drift alone does not clear a WAL-only block/,
		);
		expect(() => enforceSpecDriftGate(tmpDir, 'spec_write')).not.toThrow();
	});

	test('a corrupt recovery WAL fails closed at the mutation gate', async () => {
		await writeRecoveryWal('corrupt');
		expect(() => enforceSpecDriftGate(tmpDir, 'update_task_status')).toThrow(
			/corrupt or unreadable/,
		);
		expect(() => enforceSpecDriftGate(tmpDir, 'update_task_status')).toThrow(
			/Neither canonical spec_write nor \/swarm acknowledge-spec-drift can clear a corrupt WAL/,
		);
	});

	test('a COMMITTED recovery WAL alone does not block protected mutations', async () => {
		await writeRecoveryWal('COMMITTED');
		expect(() => enforceSpecDriftGate(tmpDir, 'save_plan')).not.toThrow();
	});

	test('no-op when directory is undefined', () => {
		expect(() => enforceSpecDriftGate(undefined, 'save_plan')).not.toThrow();
	});
});

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
