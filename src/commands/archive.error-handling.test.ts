/**
 * Tests for archive.ts graceful handling of corrupt evidence files (Task 1.6)
 *
 * Verifies that the try/catch in handleArchiveCommand's dry-run loop
 * catches exceptions from loadEvidence and skips corrupt/unreadable files.
 *
 * Uses real filesystem operations like existing archive tests.
 */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	vi,
} from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Evidence, EvidenceBundle } from '../config/evidence-schema';
import { handleArchiveCommand } from './archive';

let tempDir: string;

beforeEach(() => {
	tempDir = require('node:fs').realpathSync(
		require('node:fs').mkdtempSync(
			path.join(os.tmpdir(), 'archive-error-handling-test-'),
		),
	);
	mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
	mock.restore();
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

function createValidBundle(taskId: string, updatedAt: string): EvidenceBundle {
	const now = new Date().toISOString();
	return {
		schema_version: '1.0.0',
		task_id: taskId,
		entries: [],
		created_at: now,
		updated_at: updatedAt,
	};
}

describe('handleArchiveCommand --dry-run corrupt evidence handling', () => {
	it('should skip corrupt (invalid JSON) evidence file without throwing', async () => {
		// Create a directory with corrupt JSON content
		const corruptDir = path.join(tempDir, '.swarm', 'evidence', 'corrupt-task');
		mkdirSync(corruptDir, { recursive: true });
		writeFileSync(
			path.join(corruptDir, 'evidence.json'),
			'{ this is not valid json !!!',
		);

		// Create a valid evidence directory with RECENT bundle
		const validDir = path.join(tempDir, '.swarm', 'evidence', 'valid-task');
		mkdirSync(validDir, { recursive: true });
		const recentDate = new Date();
		recentDate.setDate(recentDate.getDate() - 10);
		const validBundle = createValidBundle(
			'valid-task',
			recentDate.toISOString(),
		);
		writeFileSync(
			path.join(validDir, 'evidence.json'),
			JSON.stringify(validBundle),
		);

		const result = await handleArchiveCommand(tempDir, ['--dry-run']);

		// Should complete without throwing
		expect(result).toBeDefined();
		expect(typeof result).toBe('string');

		// corrupt-task should NOT appear in the output (skipped due to invalid_schema)
		expect(result).not.toContain('corrupt-task');

		// Should indicate bundles are within max_bundles (recent bundles aren't listed individually)
		expect(result).toContain('within max_bundles');
	});

	it('should skip corrupt files and report only old valid bundles', async () => {
		// Create corrupt directory
		const corruptDir = path.join(tempDir, '.swarm', 'evidence', 'corrupt-task');
		mkdirSync(corruptDir, { recursive: true });
		writeFileSync(path.join(corruptDir, 'evidence.json'), '{ broken');

		// Create OLD valid bundle (100 days old) - should be reported as would-archive
		const validDir = path.join(tempDir, '.swarm', 'evidence', 'old-valid');
		mkdirSync(validDir, { recursive: true });
		const oldDate = new Date();
		oldDate.setDate(oldDate.getDate() - 100);
		writeFileSync(
			path.join(validDir, 'evidence.json'),
			JSON.stringify(createValidBundle('old-valid', oldDate.toISOString())),
		);

		const result = await handleArchiveCommand(tempDir, ['--dry-run']);

		// Should complete without throwing
		expect(result).toBeDefined();

		// old-valid should appear as would-archive
		expect(result).toContain('old-valid');
		expect(result).toContain('Age-based');

		// corrupt-task should NOT appear
		expect(result).not.toContain('corrupt-task');
	});

	it('should handle multiple corrupt files mixed with valid files', async () => {
		// Create corrupt directory 1
		const corrupt1Dir = path.join(tempDir, '.swarm', 'evidence', 'bad-file-1');
		mkdirSync(corrupt1Dir, { recursive: true });
		writeFileSync(path.join(corrupt1Dir, 'evidence.json'), '{ broken');

		// Create OLD valid bundle (should appear in output)
		const validDir = path.join(tempDir, '.swarm', 'evidence', 'good-file');
		mkdirSync(validDir, { recursive: true });
		const oldDate = new Date();
		oldDate.setDate(oldDate.getDate() - 100); // 100 days old
		writeFileSync(
			path.join(validDir, 'evidence.json'),
			JSON.stringify(createValidBundle('good-file', oldDate.toISOString())),
		);

		// Create corrupt directory 2
		const corrupt2Dir = path.join(tempDir, '.swarm', 'evidence', 'bad-file-2');
		mkdirSync(corrupt2Dir, { recursive: true });
		writeFileSync(
			path.join(corrupt2Dir, 'evidence.json'),
			'not json at all!!!',
		);

		const result = await handleArchiveCommand(tempDir, ['--dry-run']);

		// Should complete successfully
		expect(result).toContain('good-file');
		expect(result).not.toContain('bad-file-1');
		expect(result).not.toContain('bad-file-2');
	});

	it('should handle all files being corrupt gracefully', async () => {
		// Create multiple corrupt directories
		for (let i = 1; i <= 3; i++) {
			const corruptDir = path.join(
				tempDir,
				'.swarm',
				'evidence',
				`corrupt-${i}`,
			);
			mkdirSync(corruptDir, { recursive: true });
			writeFileSync(path.join(corruptDir, 'evidence.json'), `{ invalid ${i}`);
		}

		const result = await handleArchiveCommand(tempDir, ['--dry-run']);

		// Should complete without throwing
		expect(result).toBeDefined();
		expect(typeof result).toBe('string');
		// Should indicate no bundles to archive
		expect(result).toContain('No evidence bundles older than');
		// Corrupt bundles should not appear
		expect(result).not.toContain('corrupt-1');
		expect(result).not.toContain('corrupt-2');
		expect(result).not.toContain('corrupt-3');
	});

	it('should handle directory with missing evidence.json file', async () => {
		// Create a task directory WITHOUT an evidence.json file
		const emptyDir = path.join(tempDir, '.swarm', 'evidence', 'empty-task');
		mkdirSync(emptyDir, { recursive: true });
		// Note: no evidence.json created in this directory

		// Create OLD valid bundle (should appear in output)
		const validDir = path.join(tempDir, '.swarm', 'evidence', 'old-valid');
		mkdirSync(validDir, { recursive: true });
		const oldDate = new Date();
		oldDate.setDate(oldDate.getDate() - 100);
		writeFileSync(
			path.join(validDir, 'evidence.json'),
			JSON.stringify(createValidBundle('old-valid', oldDate.toISOString())),
		);

		const result = await handleArchiveCommand(tempDir, ['--dry-run']);

		// Should complete successfully
		expect(result).toContain('old-valid');
		expect(result).not.toContain('empty-task');
	});

	it('should handle directory with empty evidence.json file', async () => {
		// Create directory with empty file
		const emptyDir = path.join(tempDir, '.swarm', 'evidence', 'empty-file');
		mkdirSync(emptyDir, { recursive: true });
		writeFileSync(path.join(emptyDir, 'evidence.json'), '');

		// Create OLD valid bundle
		const validDir = path.join(tempDir, '.swarm', 'evidence', 'old-valid');
		mkdirSync(validDir, { recursive: true });
		const oldDate = new Date();
		oldDate.setDate(oldDate.getDate() - 100);
		writeFileSync(
			path.join(validDir, 'evidence.json'),
			JSON.stringify(createValidBundle('old-valid', oldDate.toISOString())),
		);

		const result = await handleArchiveCommand(tempDir, ['--dry-run']);

		// Should complete without throwing and skip empty file
		expect(result).toBeDefined();
		expect(result).toContain('old-valid');
		expect(result).not.toContain('empty-file');
	});

	it('should handle deeply nested corrupt data that parses but fails schema', async () => {
		// Create a file that is valid JSON but wrong schema
		const corruptDir = path.join(tempDir, '.swarm', 'evidence', 'wrong-schema');
		mkdirSync(corruptDir, { recursive: true });
		writeFileSync(
			path.join(corruptDir, 'evidence.json'),
			JSON.stringify({ wrong: 'schema', fields: 'here' }),
		);

		// Create OLD valid bundle
		const validDir = path.join(tempDir, '.swarm', 'evidence', 'old-valid');
		mkdirSync(validDir, { recursive: true });
		const oldDate = new Date();
		oldDate.setDate(oldDate.getDate() - 100);
		writeFileSync(
			path.join(validDir, 'evidence.json'),
			JSON.stringify(createValidBundle('old-valid', oldDate.toISOString())),
		);

		const result = await handleArchiveCommand(tempDir, ['--dry-run']);

		// Should complete without throwing
		expect(result).toBeDefined();
		expect(result).toContain('old-valid');
		expect(result).not.toContain('wrong-schema');
	});

	it('should handle mixed corrupt, old valid, and recent valid files', async () => {
		// Create corrupt file
		const corruptDir = path.join(tempDir, '.swarm', 'evidence', 'corrupt');
		mkdirSync(corruptDir, { recursive: true });
		writeFileSync(path.join(corruptDir, 'evidence.json'), '{ invalid');

		// Create OLD valid bundle
		const oldDir = path.join(tempDir, '.swarm', 'evidence', 'old-task');
		mkdirSync(oldDir, { recursive: true });
		const oldDate = new Date();
		oldDate.setDate(oldDate.getDate() - 100);
		writeFileSync(
			path.join(oldDir, 'evidence.json'),
			JSON.stringify(createValidBundle('old-task', oldDate.toISOString())),
		);

		// Create RECENT valid bundle (should NOT appear in output)
		const recentDir = path.join(tempDir, '.swarm', 'evidence', 'recent-task');
		mkdirSync(recentDir, { recursive: true });
		const recentDate = new Date();
		recentDate.setDate(recentDate.getDate() - 10);
		writeFileSync(
			path.join(recentDir, 'evidence.json'),
			JSON.stringify(
				createValidBundle('recent-task', recentDate.toISOString()),
			),
		);

		const result = await handleArchiveCommand(tempDir, ['--dry-run']);

		// Should complete without throwing
		expect(result).toBeDefined();

		// old-task should appear (would be archived)
		expect(result).toContain('old-task');
		expect(result).toContain('Age-based');

		// corrupt should NOT appear
		expect(result).not.toContain('corrupt');

		// recent-task should NOT appear in output (it's not old enough to archive)
		expect(result).not.toContain('recent-task');
	});
});
