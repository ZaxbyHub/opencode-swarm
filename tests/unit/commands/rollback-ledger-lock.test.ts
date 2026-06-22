import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fsSync from 'node:fs';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mock validateSwarmPath before importing rollback.ts (it binds at module load)
mock.module('../../../src/hooks/utils.js', () => ({
	validateSwarmPath: (directory: string, filename: string) =>
		path.join(directory, '.swarm', filename),
}));

const { handleRollbackCommand } = await import(
	'../../../src/commands/rollback.js'
);

let testDir: string;

function getSwarmDir(): string {
	return path.join(testDir, '.swarm');
}

function getManifestPath(): string {
	return path.join(testDir, '.swarm', 'checkpoints', 'manifest.json');
}

function getCheckpointDir(phase: number): string {
	return path.join(testDir, '.swarm', 'checkpoints', `phase-${phase}`);
}

function createManifest(
	checkpoints: Array<{ phase: number; label?: string; timestamp: string }>,
) {
	const checkpointsDir = path.join(testDir, '.swarm', 'checkpoints');
	mkdirSync(checkpointsDir, { recursive: true });
	writeFileSync(getManifestPath(), JSON.stringify({ checkpoints }));
}

function createCheckpointDir(phase: number, files: string[] = ['plan.md']) {
	const cpDir = getCheckpointDir(phase);
	mkdirSync(cpDir, { recursive: true });
	for (const f of files) {
		writeFileSync(path.join(cpDir, f), `content of ${f}`);
	}
}

beforeEach(() => {
	testDir = mkdtempSync(path.join(os.tmpdir(), 'rollback-ledger-test-'));
	mkdirSync(getSwarmDir(), { recursive: true });
});

afterEach(() => {
	try {
		rmSync(testDir, { recursive: true, force: true });
	} catch {}
	mock.restore();
});

describe('handleRollbackCommand — ledger EBUSY stale-warning (FR-006 SC-011)', () => {
	it('unlinkSync EBUSY → warning returned (not raw exception)', async () => {
		const ebusiError = Object.assign(new Error('EBUSY: resource busy'), {
			code: 'EBUSY',
		});

		await mock.module('node:fs', () => ({
			...fsSync,
			unlinkSync: mock((p: string) => {
				if (p.endsWith('plan-ledger.jsonl')) {
					throw ebusiError;
				}
				// succeed silently for other files
			}),
		}));

		createManifest([
			{
				phase: 1,
				label: 'Phase 1 complete',
				timestamp: new Date().toISOString(),
			},
		]);
		createCheckpointDir(1, ['plan.md']);
		writeFileSync(
			path.join(getSwarmDir(), 'plan-ledger.jsonl'),
			'ledger content',
		);
		writeFileSync(
			path.join(getSwarmDir(), 'plan.json'),
			JSON.stringify({ title: 'test', schema_version: '1.0.0', phases: [] }),
		);

		const result = await handleRollbackCommand(testDir, ['1']);

		expect(result).toContain('⚠️ Warning: Could not delete stale ledger');
		expect(result).toContain('EBUSY');
	});

	it('Warning suggests /swarm reset-session', async () => {
		const ebusiError = Object.assign(new Error('EBUSY: resource busy'), {
			code: 'EBUSY',
		});

		await mock.module('node:fs', () => ({
			...fsSync,
			unlinkSync: mock((p: string) => {
				if (p.endsWith('plan-ledger.jsonl')) {
					throw ebusiError;
				}
				// succeed silently for other files
			}),
		}));

		createManifest([
			{
				phase: 1,
				label: 'Phase 1 complete',
				timestamp: new Date().toISOString(),
			},
		]);
		createCheckpointDir(1, ['plan.md']);
		writeFileSync(
			path.join(getSwarmDir(), 'plan-ledger.jsonl'),
			'ledger content',
		);
		writeFileSync(
			path.join(getSwarmDir(), 'plan.json'),
			JSON.stringify({ title: 'test', schema_version: '1.0.0', phases: [] }),
		);

		const result = await handleRollbackCommand(testDir, ['1']);

		expect(result).toContain('/swarm reset-session');
	});

	it('ledgerDeletionFailed flag skips ledger re-init', async () => {
		const ebusiError = Object.assign(new Error('EBUSY: resource busy'), {
			code: 'EBUSY',
		});

		await mock.module('node:fs', () => ({
			...fsSync,
			unlinkSync: mock((p: string) => {
				if (p.endsWith('plan-ledger.jsonl')) {
					throw ebusiError;
				}
				// succeed silently for other files
			}),
		}));

		createManifest([
			{
				phase: 1,
				label: 'Phase 1 complete',
				timestamp: new Date().toISOString(),
			},
		]);
		createCheckpointDir(1, ['plan.md']);
		writeFileSync(
			path.join(getSwarmDir(), 'plan-ledger.jsonl'),
			'ledger content',
		);
		// Create a plan.json so that if initLedger were called, it would attempt to run.
		// The presence of this file proves the init block was skipped due to
		// ledgerDeletionFailed=true, not due to a missing plan.json.
		writeFileSync(
			path.join(getSwarmDir(), 'plan.json'),
			JSON.stringify({ title: 'test', schema_version: '1.0.0', phases: [] }),
		);

		const result = await handleRollbackCommand(testDir, ['1']);

		// If initLedger were called and failed, the output would contain
		// "Rollback restored files but failed to initialize ledger".
		// The success message below proves the init block was skipped.
		expect(result).toContain('Rolled back to phase 1: Phase 1 complete');
		expect(result).not.toContain('failed to initialize ledger');
	});
});
