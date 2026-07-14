import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals as archiveCommandInternals,
	handleArchiveCommand,
} from '../../../src/commands/archive';
import type { Evidence } from '../../../src/config/evidence-schema';
import {
	_internals as evidenceInternals,
	saveEvidence,
} from '../../../src/evidence/manager';

const realDeleteEvidence = evidenceInternals.deleteEvidence;
const realArchiveNow = archiveCommandInternals.now;
const FIXED_NOW = Date.UTC(2026, 6, 14, 12);

describe('handleArchiveCommand', () => {
	let tempDir: string;

	beforeEach(() => {
		archiveCommandInternals.now = () => new Date(FIXED_NOW);
		tempDir = mkdtemp();
		mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
	});

	afterEach(() => {
		try {
			cleanup(tempDir);
		} finally {
			evidenceInternals.deleteEvidence = realDeleteEvidence;
			archiveCommandInternals.now = realArchiveNow;
		}
	});

	test('No evidence bundles → "No evidence bundles to archive."', async () => {
		const result = await handleArchiveCommand(tempDir, []);
		expect(result).toBe('No evidence bundles to archive.');
	});

	test('--dry-run with old bundles → shows preview with task IDs', async () => {
		// Create old bundle
		const taskId = '1.1';
		await saveEvidence(tempDir, taskId, createNoteEvidence(taskId, 'Old note'));
		await makeBundleOld(tempDir, taskId, 100);

		// Run dry-run
		const result = await handleArchiveCommand(tempDir, ['--dry-run']);

		// Should contain preview with task ID
		expect(result).toContain('## Archive Preview (dry run)');
		expect(result).toContain('**Would archive**: 1 bundle(s)');
		expect(result).toContain('**Age-based (1)**:');
		expect(result).toContain('- 1.1');
	});

	test('--dry-run with no old bundles → "No evidence bundles older than X days"', async () => {
		// Create recent bundle
		const taskId = '1.2';
		await saveEvidence(tempDir, taskId, createNoteEvidence(taskId, 'New note'));

		// Run dry-run
		const result = await handleArchiveCommand(tempDir, ['--dry-run']);

		// Should indicate no bundles to archive
		expect(result).toContain(
			'No evidence bundles older than 90 days found, and bundle count (1) is within max_bundles limit (1000).',
		);
	});

	test('Archive with old bundles → returns markdown with archived count', async () => {
		// Create old bundle
		const taskId = '1.1';
		await saveEvidence(tempDir, taskId, createNoteEvidence(taskId, 'Old note'));
		await makeBundleOld(tempDir, taskId, 100);

		// Run archive (not dry-run)
		const result = await handleArchiveCommand(tempDir, []);

		// Should contain archived info
		expect(result).toContain('## Evidence Archived');
		expect(result).toContain('**Archived**: 1 bundle(s)');
		expect(result).toContain('- 1.1');
	});

	test('Archive with only new bundles → "No evidence bundles older than X days"', async () => {
		// Create recent bundle
		const taskId = '1.2';
		await saveEvidence(tempDir, taskId, createNoteEvidence(taskId, 'New note'));

		// Run archive (not dry-run)
		const result = await handleArchiveCommand(tempDir, []);

		// Should indicate no bundles to archive
		expect(result).toBe('No evidence bundles older than 90 days found.');
	});

	test('reports only actual deletions when a selected deletion fails', async () => {
		const taskId = 'undeletable';
		await saveEvidence(tempDir, taskId, createNoteEvidence(taskId, 'Old note'));
		await makeBundleOld(tempDir, taskId, 100);
		evidenceInternals.deleteEvidence = async () => false;
		const result = await handleArchiveCommand(tempDir, []);
		expect(result).toBe(
			'No evidence bundles were archived; 1 selected deletion(s) failed and remain on disk.',
		);
	});

	test('--dry-run with max_bundles exceeded → shows max_bundles section', async () => {
		// Create config with max_bundles=10
		const configPath = path.join(tempDir, '.opencode', 'opencode-swarm.json');
		await Bun.write(
			configPath,
			JSON.stringify({
				evidence: { max_age_days: 90, max_bundles: 10 },
			}),
		);

		// Create 15 bundles
		const taskIds = [];
		for (let i = 1; i <= 15; i++) {
			const taskId = `${i}.1`;
			taskIds.push(taskId);
			await saveEvidence(
				tempDir,
				taskId,
				createNoteEvidence(taskId, `Note for ${taskId}`),
			);
		}

		// Make them with varying ages (all recent, so max_bundles will trigger)
		for (let i = 0; i < taskIds.length; i++) {
			await makeBundleOld(tempDir, taskIds[i], 30 - i * 2);
		}

		// Run dry-run
		const result = await handleArchiveCommand(tempDir, ['--dry-run']);

		// Should show max_bundles section
		expect(result).toContain('## Archive Preview (dry run)');
		expect(result).toContain('**Max bundles**: 10');
		expect(result).toContain('**Would archive**: 5 bundle(s)');
		expect(result).toContain('**Max bundles limit (5)**:');

		// Should list the 5 oldest that would be archived
		expect(result).toContain('- 1.1');
		expect(result).toContain('- 2.1');
		expect(result).toContain('- 3.1');
		expect(result).toContain('- 4.1');
		expect(result).toContain('- 5.1');
	});

	test('Archive with both old bundles and max_bundles exceeded', async () => {
		// Create config with max_age_days=50, max_bundles=10
		const configPath = path.join(tempDir, '.opencode', 'opencode-swarm.json');
		await Bun.write(
			configPath,
			JSON.stringify({
				evidence: { max_age_days: 50, max_bundles: 10 },
			}),
		);

		// Create 15 bundles with varying ages
		const taskIds = [];
		for (let i = 1; i <= 15; i++) {
			const taskId = `${i}.1`;
			taskIds.push(taskId);
			await saveEvidence(
				tempDir,
				taskId,
				createNoteEvidence(taskId, `Note for ${taskId}`),
			);
		}

		// Make some old, some new
		// 1.1 to 8.1: 100+ days (deleted by age)
		// 9.1: 70 days (deleted by age)
		// 10.1 to 15.1: recent (kept by age)
		await makeBundleOld(tempDir, '1.1', 120);
		await makeBundleOld(tempDir, '2.1', 115);
		await makeBundleOld(tempDir, '3.1', 110);
		await makeBundleOld(tempDir, '4.1', 105);
		await makeBundleOld(tempDir, '5.1', 100);
		await makeBundleOld(tempDir, '6.1', 95);
		await makeBundleOld(tempDir, '7.1', 90);
		await makeBundleOld(tempDir, '8.1', 85);
		await makeBundleOld(tempDir, '9.1', 70);
		await makeBundleOld(tempDir, '10.1', 40);
		await makeBundleOld(tempDir, '11.1', 30);
		await makeBundleOld(tempDir, '12.1', 25);
		await makeBundleOld(tempDir, '13.1', 20);
		await makeBundleOld(tempDir, '14.1', 15);
		await makeBundleOld(tempDir, '15.1', 10);

		// Run archive (not dry-run)
		// Age filter deletes 1.1 to 9.1 (9 bundles)
		// Remaining 6 bundles (10.1 to 15.1), max_bundles=10, so none more deleted
		const result = await handleArchiveCommand(tempDir, []);

		// Should show archived count and list
		expect(result).toContain('## Evidence Archived');
		expect(result).toContain('**Archived**: 9 bundle(s)');
		expect(result).toContain('- 1.1');
		expect(result).toContain('- 2.1');
		expect(result).toContain('- 3.1');
		expect(result).toContain('- 4.1');
		expect(result).toContain('- 5.1');
		expect(result).toContain('- 6.1');
		expect(result).toContain('- 7.1');
		expect(result).toContain('- 8.1');
		expect(result).toContain('- 9.1');
		expect(result).not.toContain('- 10.1');
	});
});

// Helper functions
function mkdtemp(): string {
	return require('node:fs').realpathSync(
		require('node:fs').mkdtempSync(
			path.join(os.tmpdir(), 'archive-command-test-'),
		),
	);
}

function cleanup(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

async function makeBundleOld(
	directory: string,
	taskId: string,
	daysOld: number,
): Promise<void> {
	const { loadEvidence } = await import('../../../src/evidence/manager');
	const result = await loadEvidence(directory, taskId);
	if (result.status !== 'found') {
		throw new Error(`Bundle not found for task ${taskId}`);
	}
	const bundle = result.bundle;

	// Set updated_at and created_at to old date
	const oldDate = new Date(FIXED_NOW);
	oldDate.setDate(oldDate.getDate() - daysOld);
	const oldIso = oldDate.toISOString();

	bundle.updated_at = oldIso;
	bundle.created_at = oldIso;

	// Write back
	const evidencePath = path.join(
		directory,
		'.swarm',
		'evidence',
		taskId,
		'evidence.json',
	);
	await Bun.write(evidencePath, JSON.stringify(bundle));
}

// Helper function to create note evidence with required fields
function createNoteEvidence(taskId: string, summary: string): Evidence {
	return {
		type: 'note',
		task_id: taskId,
		timestamp: new Date(FIXED_NOW).toISOString(),
		agent: 'test-agent',
		verdict: 'info',
		summary,
	};
}
