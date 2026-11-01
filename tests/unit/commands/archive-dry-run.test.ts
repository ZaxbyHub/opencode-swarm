/**
 * Tests for archive.ts --dry-run mode (Task 1.5)
 *
 * Verifies that loadEvidence discriminated union is handled correctly:
 * 1. 'found' status with old bundle → appears in "would archive"
 * 2. 'not_found' status → does NOT appear in "would archive"
 * 3. 'invalid_schema' status → does NOT appear in "would archive"
 *
 * Uses real filesystem operations instead of module mocking to avoid
 * bun test runner module-registry contamination across test files.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleArchiveCommand } from '../../../src/commands/archive.js';
import type { Evidence } from '../../../src/config/evidence-schema.js';
import { saveEvidence } from '../../../src/evidence/manager.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir';

let tempDir: string;

beforeEach(() => {
	tempDir = require('node:fs').realpathSync(
		require('node:fs').mkdtempSync(
			path.join(os.tmpdir(), 'archive-dry-run-test-'),
		),
	);
	mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
});

afterEach(() => {
	safeRmRecursive(tempDir);
});

function createNoteEvidence(taskId: string): Evidence {
	return {
		type: 'note',
		task_id: taskId,
		timestamp: new Date().toISOString(),
		agent: 'test-agent',
		verdict: 'info',
		summary: 'Test note',
	};
}

async function makeBundleOld(taskId: string, daysOld: number): Promise<void> {
	const { loadEvidence } = await import('../../../src/evidence/manager.js');
	const result = await loadEvidence(tempDir, taskId);
	if (result.status !== 'found') {
		throw new Error(`Bundle not found for task ${taskId}`);
	}
	const bundle = result.bundle;
	const oldDate = new Date();
	oldDate.setDate(oldDate.getDate() - daysOld);
	const oldIso = oldDate.toISOString();
	bundle.updated_at = oldIso;
	bundle.created_at = oldIso;
	const evidencePath = path.join(
		tempDir,
		'.swarm',
		'evidence',
		taskId,
		'evidence.json',
	);
	await Bun.write(evidencePath, JSON.stringify(bundle));
}

describe('handleArchiveCommand --dry-run loadEvidence discriminated union', () => {
	it('should include task in "would archive" when loadEvidence returns status: "found" with old bundle', async () => {
		// Create a real bundle and age it
		await saveEvidence(tempDir, '1.1', createNoteEvidence('1.1'));
		await makeBundleOld('1.1', 100); // 100 days old, older than 90-day default

		const result = await handleArchiveCommand(tempDir, ['--dry-run']);

		expect(result).toContain('Would archive');
		expect(result).toContain('1.1');
	});

	it('should NOT include task in "would archive" when loadEvidence returns status: "not_found"', async () => {
		// Create a valid task ID directory WITHOUT an evidence.json file
		// listEvidenceTaskIds will find the directory, but loadEvidence returns 'not_found'
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '2.1');
		mkdirSync(evidenceDir, { recursive: true });
		// Note: no evidence.json created in this directory

		const result = await handleArchiveCommand(tempDir, ['--dry-run']);

		expect(result).not.toContain('2.1');
		expect(result).toContain('No evidence bundles older than 90 days found');
	});

	it('should NOT include task in "would archive" when loadEvidence returns status: "invalid_schema"', async () => {
		// Create a task ID directory with invalid JSON content
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '3.1');
		mkdirSync(evidenceDir, { recursive: true });
		writeFileSync(
			path.join(evidenceDir, 'evidence.json'),
			'{ invalid json content !!!',
		);

		const result = await handleArchiveCommand(tempDir, ['--dry-run']);

		expect(result).not.toContain('3.1');
		expect(result).toContain('No evidence bundles older than 90 days found');
	});

	it('should handle mixed scenarios correctly', async () => {
		// Task 1.1: old valid bundle → should appear in would-archive
		await saveEvidence(tempDir, '1.1', createNoteEvidence('1.1'));
		await makeBundleOld('1.1', 100);

		// Task 2.1: directory exists but no evidence.json → not_found, skip
		const notFoundDir = path.join(tempDir, '.swarm', 'evidence', '2.1');
		mkdirSync(notFoundDir, { recursive: true });

		// Task 3.1: directory exists with invalid JSON → invalid_schema, skip
		const invalidDir = path.join(tempDir, '.swarm', 'evidence', '3.1');
		mkdirSync(invalidDir, { recursive: true });
		writeFileSync(path.join(invalidDir, 'evidence.json'), '{ invalid }');

		const result = await handleArchiveCommand(tempDir, ['--dry-run']);

		// Only task-old (1.1) should appear in would archive
		expect(result).toContain('1.1');
		expect(result).not.toContain('2.1');
		expect(result).not.toContain('3.1');
		expect(result).toContain('Age-based (1)');
	});
});
