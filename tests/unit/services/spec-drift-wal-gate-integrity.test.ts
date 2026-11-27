/**
 * F-002 (PR 3920 closeout): the mutation gate must apply the same captured-content
 * integrity check as the recovery run. A structurally valid COMMITTED WAL whose
 * specContent no longer hashes to newHash is corrupt and must block protected
 * mutations, not pass as COMMITTED.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { enforceSpecDriftGate } from '../../../src/hooks/guardrails';
import { spec_write } from '../../../src/tools/spec-write';
import { canonicalTmpDir } from '../../helpers/tmpdir.js';

describe('spec-drift WAL mutation gate applies captured-content integrity (F-002)', () => {
	let tempDir: string;
	const walPath = () => join(tempDir, '.swarm', 'spec-drift-recovery.json');

	beforeEach(async () => {
		tempDir = join(canonicalTmpDir(), `spec-wal-gate-${randomUUID()}`);
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
		await writeFile(
			join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(
				{
					schema_version: '1.0.0',
					title: 'WAL Gate Plan',
					swarm: 'test-swarm',
					current_phase: 1,
					phases: [
						{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] },
					],
					migration_status: 'native',
					specHash: 'oldhash123',
				},
				null,
				2,
			),
		);
		await writeFile(join(tempDir, '.swarm', 'spec.md'), '# Old Spec\n\nOld.\n');
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true }).catch(() => {});
	});

	test('a consistent COMMITTED WAL from a real repair does not block protected mutations', async () => {
		const result = JSON.parse(
			await spec_write.execute({ content: '# Spec\n\nRepaired content.\n' }, {
				directory: tempDir,
			} as any),
		);
		expect(result.spec_drift_recovery.status).toBe('applied');
		expect(existsSync(walPath())).toBe(true);

		expect(() => enforceSpecDriftGate(tempDir, 'save_plan')).not.toThrow();
	});

	test('a COMMITTED WAL whose captured content no longer hashes to newHash blocks save_plan', async () => {
		await spec_write.execute({ content: '# Spec\n\nRepaired content.\n' }, {
			directory: tempDir,
		} as any);
		const wal = JSON.parse(readFileSync(walPath(), 'utf-8')) as {
			state: string;
			specContent: string | null;
		};
		expect(wal.state).toBe('COMMITTED');
		// Structurally valid, but the captured content is no longer what newHash covers.
		wal.specContent = '# Tampered\n\nNot what was committed.\n';
		writeFileSync(walPath(), JSON.stringify(wal, null, 2));

		expect(() => enforceSpecDriftGate(tempDir, 'save_plan')).toThrow(
			/SPEC_DRIFT_BLOCK/,
		);
	});
});
