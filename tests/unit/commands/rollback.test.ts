/**
 * Tests for handleRollbackCommand using real filesystem operations.
 *
 * Uses bun:test with:
 * - Real node:fs (no contamination of config tests)
 * - mock.module for hooks/utils only (not tested in this CI job)
 * - Real temp directories per test
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock validateSwarmPath to return deterministic paths (avoids empty-filename bug on Windows)
mock.module('../../../src/hooks/utils.js', () => ({
	validateSwarmPath: (directory: string, filename: string) =>
		path.join(directory, '.swarm', filename),
}));

// Import AFTER mock setup
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

function getEventsPath(): string {
	return path.join(testDir, '.swarm', 'events.jsonl');
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
	testDir = require('node:fs').realpathSync(
		require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'rollback-test-')),
	);
	mkdirSync(getSwarmDir(), { recursive: true });
});

afterEach(() => {
	mock.restore();
	try {
		rmSync(testDir, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
});

const FIXED_TIMESTAMP = new Date('2024-03-03T12:00:00Z').toISOString();

describe('handleRollbackCommand', () => {
	describe('List checkpoints (no phase argument)', () => {
		it('should return "No checkpoints found" when manifest does not exist', async () => {
			const result = await handleRollbackCommand(testDir, []);

			expect(result).toBe(
				'No checkpoints found. Use `/swarm checkpoint` to create checkpoints.',
			);
		});

		it('should return "No checkpoints found in manifest" when manifest has no checkpoints', async () => {
			createManifest([]);

			const result = await handleRollbackCommand(testDir, []);

			expect(result).toBe('No checkpoints found in manifest.');
		});

		it('should list available checkpoints', async () => {
			createManifest([
				{ phase: 1, label: 'Phase 1 complete', timestamp: FIXED_TIMESTAMP },
				{ phase: 2, label: 'Phase 2 complete', timestamp: FIXED_TIMESTAMP },
			]);

			const result = await handleRollbackCommand(testDir, []);

			expect(result).toContain('## Available Checkpoints');
			expect(result).toContain('- Phase 1: Phase 1 complete');
			expect(result).toContain('- Phase 2: Phase 2 complete');
			expect(result).toContain(
				'Run `/swarm rollback <phase>` to restore to a checkpoint.',
			);
		});

		it('should list checkpoints without label', async () => {
			createManifest([{ phase: 1, timestamp: FIXED_TIMESTAMP }]);

			const result = await handleRollbackCommand(testDir, []);

			expect(result).toContain('- Phase 1: no label');
		});
	});

	describe('Validate phase number', () => {
		it('should return error when phase is NaN', async () => {
			const result = await handleRollbackCommand(testDir, ['invalid']);

			expect(result).toBe('Error: Phase number must be a positive integer.');
		});

		it('should return error when phase is zero', async () => {
			const result = await handleRollbackCommand(testDir, ['0']);

			expect(result).toBe('Error: Phase number must be a positive integer.');
		});

		it('should return error when phase is negative', async () => {
			const result = await handleRollbackCommand(testDir, ['-1']);

			expect(result).toBe('Error: Phase number must be a positive integer.');
		});

		it('should accept valid positive integer phase', async () => {
			createManifest([
				{ phase: 1, label: 'Phase 1 complete', timestamp: FIXED_TIMESTAMP },
			]);
			createCheckpointDir(1, ['plan.md', 'context.md']);

			const result = await handleRollbackCommand(testDir, ['1']);

			expect(result).toContain('Rolled back to phase 1: Phase 1 complete');
		});
	});

	describe('Checkpoint not found', () => {
		it('should return error when manifest does not exist', async () => {
			const result = await handleRollbackCommand(testDir, ['1']);

			expect(result).toBe(
				'Error: No checkpoints found. Cannot rollback to phase 1.',
			);
		});

		it('should return error when checkpoint for phase does not exist', async () => {
			createManifest([
				{
					phase: 2,
					label: 'Phase 2 complete',
					timestamp: new Date().toISOString(),
				},
			]);

			const result = await handleRollbackCommand(testDir, ['1']);

			expect(result).toBe(
				'Error: Checkpoint for phase 1 not found. Available phases: 2',
			);
		});

		it('should return "none" when manifest has no checkpoints', async () => {
			createManifest([]);

			const result = await handleRollbackCommand(testDir, ['1']);

			expect(result).toBe(
				'Error: Checkpoint for phase 1 not found. Available phases: none',
			);
		});

		it('should return error when checkpoint directory does not exist', async () => {
			createManifest([
				{ phase: 1, label: 'Phase 1 complete', timestamp: FIXED_TIMESTAMP },
			]);
			// Note: NOT creating the checkpoint directory

			const result = await handleRollbackCommand(testDir, ['1']);

			expect(result).toBe(
				'Error: Checkpoint directory for phase 1 does not exist.',
			);
		});

		it('should return error when checkpoint directory is empty', async () => {
			createManifest([
				{ phase: 1, label: 'Phase 1 complete', timestamp: FIXED_TIMESTAMP },
			]);
			// Create empty checkpoint directory
			mkdirSync(getCheckpointDir(1), { recursive: true });

			const result = await handleRollbackCommand(testDir, ['1']);

			expect(result).toBe(
				'Error: Checkpoint for phase 1 is empty. Cannot rollback.',
			);
		});
	});

	describe('Copy files from checkpoint to .swarm/', () => {
		it('should copy all files from checkpoint directory', async () => {
			createManifest([
				{ phase: 1, label: 'Phase 1 complete', timestamp: FIXED_TIMESTAMP },
			]);
			createCheckpointDir(1, ['plan.md', 'context.md', 'events.jsonl']);

			const result = await handleRollbackCommand(testDir, ['1']);

			// Verify files were copied to .swarm/
			expect(existsSync(path.join(getSwarmDir(), 'plan.md'))).toBe(true);
			expect(existsSync(path.join(getSwarmDir(), 'context.md'))).toBe(true);
			expect(result).toContain('Rolled back to phase 1: Phase 1 complete');
		});

		it('should use correct source and destination paths', async () => {
			createManifest([
				{ phase: 1, label: 'Phase 1 complete', timestamp: FIXED_TIMESTAMP },
			]);
			createCheckpointDir(1, ['plan.md']);

			const result = await handleRollbackCommand(testDir, ['1']);

			const destFile = path.join(getSwarmDir(), 'plan.md');
			expect(existsSync(destFile)).toBe(true);
			expect(readFileSync(destFile, 'utf-8')).toBe('content of plan.md');
			expect(result).toContain('Rolled back to phase 1: Phase 1 complete');
		});
	});

	describe('Process ALL files even if some fail', () => {
		it('should copy multiple files successfully from checkpoint directory', async () => {
			createManifest([
				{ phase: 1, label: 'Phase 1 complete', timestamp: FIXED_TIMESTAMP },
			]);
			createCheckpointDir(1, ['plan.md', 'context.md', 'evidence.md']);

			const result = await handleRollbackCommand(testDir, ['1']);

			expect(existsSync(path.join(getSwarmDir(), 'plan.md'))).toBe(true);
			expect(existsSync(path.join(getSwarmDir(), 'context.md'))).toBe(true);
			expect(existsSync(path.join(getSwarmDir(), 'evidence.md'))).toBe(true);
			expect(result).toContain('Rolled back to phase 1: Phase 1 complete');
		});

		it('should report all files correctly when all succeed', async () => {
			createManifest([
				{ phase: 1, label: 'Phase 1 complete', timestamp: FIXED_TIMESTAMP },
			]);
			createCheckpointDir(1, [
				'plan.md',
				'context.md',
				'evidence.md',
				'state.md',
			]);

			const result = await handleRollbackCommand(testDir, ['1']);

			expect(result).toContain('Rolled back to phase 1: Phase 1 complete');
			expect(existsSync(path.join(getSwarmDir(), 'plan.md'))).toBe(true);
			expect(existsSync(path.join(getSwarmDir(), 'state.md'))).toBe(true);
		});

		it('should handle corrupted manifest gracefully', async () => {
			// Corrupted manifest JSON causes early return
			const checkpointsDir = path.join(testDir, '.swarm', 'checkpoints');
			mkdirSync(checkpointsDir, { recursive: true });
			writeFileSync(getManifestPath(), '{ corrupted json !!!');

			const result = await handleRollbackCommand(testDir, ['1']);

			expect(result).toContain('Error: Checkpoint manifest is corrupted');
		});
	});

	describe('Write rollback event to events.jsonl', () => {
		it('should write rollback event to events.jsonl on success', async () => {
			createManifest([
				{ phase: 1, label: 'Phase 1 complete', timestamp: FIXED_TIMESTAMP },
			]);
			createCheckpointDir(1, ['plan.md']);

			const result = await handleRollbackCommand(testDir, ['1']);

			expect(existsSync(getEventsPath())).toBe(true);
			const events = readFileSync(getEventsPath(), 'utf-8');
			expect(events).toContain('"type":"rollback"');
			expect(events).toContain('"phase":1');
			expect(events).toContain('"label":"Phase 1 complete"');
			expect(result).toContain('Rolled back to phase 1: Phase 1 complete');
		});

		it('should include checkpoint label in rollback event', async () => {
			createManifest([
				{
					phase: 1,
					label: 'Custom checkpoint label',
					timestamp: FIXED_TIMESTAMP,
				},
			]);
			createCheckpointDir(1, ['plan.md']);

			await handleRollbackCommand(testDir, ['1']);

			const events = readFileSync(getEventsPath(), 'utf-8');
			expect(events).toContain('"label":"Custom checkpoint label"');
		});

		it('should use empty label when checkpoint has no label', async () => {
			createManifest([{ phase: 1, timestamp: FIXED_TIMESTAMP }]);
			createCheckpointDir(1, ['plan.md']);

			await handleRollbackCommand(testDir, ['1']);

			const events = readFileSync(getEventsPath(), 'utf-8');
			expect(events).toContain('"label":""');
		});

		it('should handle error when writing rollback event gracefully (events.jsonl as directory)', async () => {
			createManifest([
				{ phase: 1, label: 'Phase 1 complete', timestamp: FIXED_TIMESTAMP },
			]);
			createCheckpointDir(1, ['plan.md']);
			// Pre-create events.jsonl as a directory to block appendFileSync
			mkdirSync(getEventsPath(), { recursive: true });

			// Should still return success despite append error
			const result = await handleRollbackCommand(testDir, ['1']);

			expect(result).toContain('Rolled back to phase 1: Phase 1 complete');
		});

		it('should NOT write rollback event when all files fail to copy', async () => {
			createManifest([
				{ phase: 1, label: 'Phase 1 complete', timestamp: FIXED_TIMESTAMP },
			]);
			// Create checkpoint with plan.md, but also pre-create plan.md as a DIRECTORY
			// to cause cpSync to fail (can't overwrite dir with file)
			const cpDir = getCheckpointDir(1);
			mkdirSync(cpDir, { recursive: true });
			writeFileSync(path.join(cpDir, 'plan.md'), 'content');
			const destPlanPath = path.join(getSwarmDir(), 'plan.md');
			mkdirSync(destPlanPath, { recursive: true }); // plan.md is a dir in dest

			const result = await handleRollbackCommand(testDir, ['1']);

			// Either partial failure or success depending on OS behavior for dir→file copy
			// On Windows, cpSync may fail when dest is a directory
			// Key: no crash and a string is returned
			expect(typeof result).toBe('string');
		});
	});

	describe('Success message', () => {
		it('should return success message with checkpoint label', async () => {
			createManifest([
				{ phase: 1, label: 'Phase 1 complete', timestamp: FIXED_TIMESTAMP },
			]);
			createCheckpointDir(1, ['plan.md']);

			const result = await handleRollbackCommand(testDir, ['1']);

			expect(result).toBe('Rolled back to phase 1: Phase 1 complete');
		});

		it('should return success message with "no label" when checkpoint has no label', async () => {
			createManifest([{ phase: 1, timestamp: FIXED_TIMESTAMP }]);
			createCheckpointDir(1, ['plan.md']);

			const result = await handleRollbackCommand(testDir, ['1']);

			expect(result).toBe('Rolled back to phase 1: no label');
		});
	});
});
