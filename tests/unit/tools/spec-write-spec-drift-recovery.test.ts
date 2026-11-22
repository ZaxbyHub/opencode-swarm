import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEffectiveSpecSync } from '../../../src/sdd/effective-spec';
import { spec_write } from '../../../src/tools/spec-write';
import { isSpecStale } from '../../../src/utils/spec-hash';
import { canonicalTmpDir } from '../../helpers/tmpdir.js';

function buildPlan(specHash: string) {
	return {
		schema_version: '1.0.0',
		title: 'Spec Repair Plan',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
		migration_status: 'native',
		specHash,
	};
}

describe('spec_write spec drift recovery', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(canonicalTmpDir(), `spec-write-recovery-${randomUUID()}`);
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true }).catch(() => {});
	});

	test('reports no recovery work when no drift marker exists', async () => {
		const result = JSON.parse(
			await spec_write.execute({ content: '# Spec\n\nFresh content.\n' }, {
				directory: tempDir,
			} as any),
		);

		expect(result.written).toBe(true);
		expect(result.spec_drift_recovery.status).toBe('no_marker');
	});

	test('repairs drift after writing the new spec and records a repaired event', async () => {
		const specContent = '# Spec\n\nRepaired requirements.\n';
		await writeFile(
			join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(buildPlan('oldhash123'), null, 2),
		);
		await writeFile(join(tempDir, '.swarm', 'spec-snapshot.md'), '# Old\n');
		await writeFile(
			join(tempDir, '.swarm', 'spec-staleness.json'),
			JSON.stringify({
				planTitle: 'Spec Repair Plan',
				phase: 1,
				specHash_plan: 'oldhash123',
				specHash_current: 'newhash456',
				reason: 'spec.md changed since plan saved',
				timestamp: '2026-08-14T14:00:00.000Z',
			}),
		);

		const result = JSON.parse(
			await spec_write.execute({ content: specContent }, {
				directory: tempDir,
			} as any),
		);

		expect(result.written).toBe(true);
		expect(result.spec_drift_recovery.status).toBe('applied');
		expect(result.spec_drift_recovery.mode).toBe('repair');
		expect(existsSync(join(tempDir, '.swarm', 'spec-staleness.json'))).toBe(
			false,
		);
		expect(
			await readFile(join(tempDir, '.swarm', 'spec-snapshot.md'), 'utf-8'),
		).toBe(specContent);

		const plan = JSON.parse(
			await readFile(join(tempDir, '.swarm', 'plan.json'), 'utf-8'),
		) as { specHash?: string };
		expect(plan.specHash).toBe(readEffectiveSpecSync(tempDir)?.hash);

		const event = JSON.parse(
			readFileSync(join(tempDir, '.swarm', 'events.jsonl'), 'utf-8')
				.trim()
				.split('\n')
				.pop() ?? '{}',
		);
		expect(event.type).toBe('spec_drift_repaired');
		expect(event.repairedBy).toBe('spec_write');
		expect(event.transitionId).toEqual(expect.any(String));
	});

	test('does not clear a corrupt marker even though the spec write succeeds', async () => {
		await writeFile(
			join(tempDir, '.swarm', 'spec-staleness.json'),
			'{ bad json',
		);

		const result = JSON.parse(
			await spec_write.execute({ content: '# Spec\n\nStill written.\n' }, {
				directory: tempDir,
			} as any),
		);

		expect(result.written).toBe(true);
		expect(result.spec_drift_recovery.status).toBe('corrupt_marker');
		expect(existsSync(join(tempDir, '.swarm', 'spec-staleness.json'))).toBe(
			true,
		);
	});

	describe('pre-marker plan-hash rebind (field regression: SPEC_DRIFT_BLOCK wedge)', () => {
		// Field sequence that wedged a live architect session (2026-11-22):
		// plan saved with the OLD spec hash → canonical spec_write replaced the
		// spec → reconcileSpecDrift returned no_marker because the drift marker
		// only materializes on the NEXT loadPlan → loadPlan inside save_plan then
		// wrote .swarm/spec-staleness.json → SPEC_DRIFT_BLOCK with guidance
		// pointing at "/swarm clarify" (not a swarm_command registry entry).
		// Previous code left plan.json at the old hash forever; the tests below
		// fail on pre-fix source (status was no_marker, specHash stayed stale).

		test('canonical spec write with an existing plan rebinds the plan specHash before the marker materializes', async () => {
			await writeFile(
				join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(buildPlan('oldhash123'), null, 2),
			);
			await writeFile(
				join(tempDir, '.swarm', 'spec.md'),
				'# Old Spec\n\nOld content.\n',
			);

			const result = JSON.parse(
				await spec_write.execute(
					{ content: '# Spec\n\nRebound requirements.\n' },
					{ directory: tempDir } as any,
				),
			);

			expect(result.written).toBe(true);
			expect(result.spec_drift_recovery.status).toBe('applied');
			expect(result.spec_drift_recovery.mode).toBe('repair');

			// The plan now carries the current spec hash...
			const plan = JSON.parse(
				await readFile(join(tempDir, '.swarm', 'plan.json'), 'utf-8'),
			) as { specHash?: string };
			expect(plan.specHash).toBe(readEffectiveSpecSync(tempDir)?.hash);

			// ...so the lazily-materialized marker can never appear for this write,
			// and isSpecStale (the exact loadPlan staleness predicate) stays quiet.
			expect(existsSync(join(tempDir, '.swarm', 'spec-staleness.json'))).toBe(
				false,
			);
			expect((await isSpecStale(tempDir, plan as never)).stale).toBe(false);

			// Audited repair: spec_drift_repaired event, committed WAL from the old
			// hash, and a verified spec snapshot.
			const event = JSON.parse(
				readFileSync(join(tempDir, '.swarm', 'events.jsonl'), 'utf-8')
					.trim()
					.split('\n')
					.pop() ?? '{}',
			);
			expect(event.type).toBe('spec_drift_repaired');
			expect(event.repairedBy).toBe('spec_write');
			const wal = JSON.parse(
				await readFile(
					join(tempDir, '.swarm', 'spec-drift-recovery.json'),
					'utf-8',
				),
			) as { state?: string; previousHash?: string };
			expect(wal.state).toBe('COMMITTED');
			expect(wal.previousHash).toBe('oldhash123');
			expect(
				await readFile(join(tempDir, '.swarm', 'spec-snapshot.md'), 'utf-8'),
			).toBe('# Spec\n\nRebound requirements.\n');
		});

		test('already-consistent plan stays no_marker and is left untouched', async () => {
			await writeFile(
				join(tempDir, '.swarm', 'spec.md'),
				'# Spec\n\nConsistent.\n',
			);
			const hash = readEffectiveSpecSync(tempDir)?.hash;
			expect(hash).toEqual(expect.any(String));
			await writeFile(
				join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(buildPlan(hash as string), null, 2),
			);

			const result = JSON.parse(
				await spec_write.execute({ content: '# Spec\n\nConsistent.\n' }, {
					directory: tempDir,
				} as any),
			);

			expect(result.written).toBe(true);
			expect(result.spec_drift_recovery.status).toBe('no_marker');
			const plan = JSON.parse(
				await readFile(join(tempDir, '.swarm', 'plan.json'), 'utf-8'),
			) as { specHash?: string };
			expect(plan.specHash).toBe(hash);
			expect(
				existsSync(join(tempDir, '.swarm', 'spec-drift-recovery.json')),
			).toBe(false);
			expect(existsSync(join(tempDir, '.swarm', 'events.jsonl'))).toBe(false);
		});

		test('plan without a specHash stays no_marker (pre-feature plans are exempt)', async () => {
			const planWithoutHash: Record<string, unknown> = {
				...buildPlan('x'),
			};
			delete planWithoutHash.specHash;
			await writeFile(
				join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(planWithoutHash, null, 2),
			);

			const result = JSON.parse(
				await spec_write.execute({ content: '# Spec\n\nNo stored hash.\n' }, {
					directory: tempDir,
				} as any),
			);

			expect(result.written).toBe(true);
			expect(result.spec_drift_recovery.status).toBe('no_marker');
			expect(
				existsSync(join(tempDir, '.swarm', 'spec-drift-recovery.json')),
			).toBe(false);
		});
	});
});
