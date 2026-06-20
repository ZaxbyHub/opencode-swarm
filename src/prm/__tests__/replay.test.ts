import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ReplayEntry } from '../replay';
import {
	_test_exports,
	recordReplayEntry,
	startReplayRecording,
} from '../replay';

describe('startReplayRecording', () => {
	let directory: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prm-replay-'));
		// Clean up any test directories
		const replayDir = path.join(directory, '.swarm', 'replays');
		try {
			await fs.rm(replayDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	afterEach(async () => {
		await fs.rm(directory, { recursive: true, force: true });
	});

	test('creates replay directory if it does not exist', async () => {
		const replayDir = path.join(directory, '.swarm', 'replays');

		// Ensure directory does not exist
		try {
			await fs.rm(replayDir, { recursive: true, force: true });
		} catch {
			// ignore
		}

		const result = await startReplayRecording('test-session-123', directory);

		expect(result).not.toBeNull();
		const dirExists = await fs
			.access(replayDir)
			.then(() => true)
			.catch(() => false);
		expect(dirExists).toBe(true);
	});

	test('returns path to replay artifact file', async () => {
		const result = await startReplayRecording('test-session-123', directory);

		expect(result).not.toBeNull();
		expect(result).toContain('.swarm');
		expect(result).toContain('replays');
		expect(result).toMatch(/\.jsonl$/);
	});

	test('sanitizes sessionID with special characters', async () => {
		const result = await startReplayRecording('test-session-123!@#', directory);

		expect(result).not.toBeNull();
		// Hyphens are preserved, only !@# are replaced with underscore
		expect(result).toContain('test-session-123___');
	});

	test('returns null on filesystem error', async () => {
		// Using mocking to simulate filesystem failure since mkdir recursive succeeds on most paths
		const originalMkdir = fs.mkdir;
		vi.spyOn(fs, 'mkdir').mockRejectedValueOnce(
			new Error('ENOTDIR: not a directory'),
		);

		const result = await startReplayRecording('test-session', directory);

		vi.restoreAllMocks();
		expect(result).toBeNull();
	});
});

describe('recordReplayEntry', () => {
	let directory: string;
	let artifactPath: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prm-replay-'));
		// Create a test directory and get artifact path
		const replayDir = path.join(directory, '.swarm', 'replays');
		try {
			await fs.rm(replayDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
		artifactPath =
			(await startReplayRecording('test-session', directory)) ?? '';
	});

	afterEach(async () => {
		await fs.rm(directory, { recursive: true, force: true });
	});

	test('appends entry to replay artifact file', async () => {
		const entry = {
			type: 'llm_request' as const,
			data: { model: 'test-model', prompt: 'hello' },
		};

		await recordReplayEntry(artifactPath, 'test-session', entry);

		const content = await fs.readFile(artifactPath, 'utf-8');
		const lines = content.trim().split('\n');
		expect(lines).toHaveLength(1);

		const parsed = JSON.parse(lines[0]) as ReplayEntry;
		expect(parsed.sessionID).toBe('test-session');
		expect(parsed.type).toBe('llm_request');
		expect(parsed.data).toEqual({ model: 'test-model', prompt: 'hello' });
		expect(parsed.timestamp).toBeDefined();
	});

	test('appends multiple entries sequentially', async () => {
		const entry1 = { type: 'llm_request' as const, data: { prompt: 'first' } };
		const entry2 = {
			type: 'llm_response' as const,
			data: { response: 'second' },
		};
		const entry3 = { type: 'tool_call' as const, data: { tool: 'test' } };

		await recordReplayEntry(artifactPath, 'test-session', entry1);
		await recordReplayEntry(artifactPath, 'test-session', entry2);
		await recordReplayEntry(artifactPath, 'test-session', entry3);

		const content = await fs.readFile(artifactPath, 'utf-8');
		const lines = content.trim().split('\n');
		expect(lines).toHaveLength(3);
	});

	test('does not throw on filesystem error', async () => {
		const entry = { type: 'llm_request' as const, data: {} };

		// Should not throw even with invalid path
		await expect(
			recordReplayEntry(
				'/invalid/nonexistent/file.jsonl',
				'test-session',
				entry,
			),
		).resolves.toBeUndefined();
	});

	test('adds ISO timestamp to each entry', async () => {
		const entry = {
			type: 'pattern_detected' as const,
			data: { pattern: 'loop' },
		};

		const before = new Date().toISOString();
		await recordReplayEntry(artifactPath, 'test-session', entry);
		const after = new Date().toISOString();

		const content = await fs.readFile(artifactPath, 'utf-8');
		const parsed = JSON.parse(content.trim()) as ReplayEntry;

		expect(parsed.timestamp).toBeDefined();
		expect(parsed.timestamp >= before).toBe(true);
		expect(parsed.timestamp <= after).toBe(true);
	});
});

describe('sanitizeFilename', () => {
	let directory: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prm-replay-'));
	});

	afterEach(async () => {
		await fs.rm(directory, { recursive: true, force: true });
	});

	test('directly sanitizes unsafe filename characters', () => {
		expect(_test_exports.sanitizeFilename('../a b:c')).toBe('___a_b_c');
	});

	test('allows alphanumeric, underscore, and hyphen', async () => {
		const artifactPath = await startReplayRecording(
			'test_session-123',
			directory,
		);
		expect(artifactPath).not.toBeNull();
		expect(artifactPath).toContain('test_session-123');
	});

	test('replaces special characters with underscore', async () => {
		const artifactPath = await startReplayRecording(
			'test@session#123',
			directory,
		);
		expect(artifactPath).not.toBeNull();
		expect(artifactPath).toContain('test_session_123');
	});

	test('replaces spaces with underscore', async () => {
		const artifactPath = await startReplayRecording(
			'test session 123',
			directory,
		);
		expect(artifactPath).not.toBeNull();
		expect(artifactPath).toContain('test_session_123');
	});

	test('handles unicode characters', async () => {
		const artifactPath = await startReplayRecording('sessão-teste', directory);
		expect(artifactPath).not.toBeNull();
		// 'ã' is outside a-zA-Z0-9_- so it becomes underscore, but '-' is preserved
		expect(artifactPath).toContain('sess_o-teste');
	});
});

describe('replay path guards', () => {
	test('isPathSafe rejects traversal outside the base directory', () => {
		const base = path.join('/workspace', '.swarm', 'replays');
		expect(_test_exports.isPathSafe(path.join(base, 'ok.jsonl'), base)).toBe(
			true,
		);
		expect(
			_test_exports.isPathSafe(path.join(base, '..', 'x.jsonl'), base),
		).toBe(false);
	});

	test('isWithinReplaysDir requires a .swarm/replays path segment', () => {
		expect(
			_test_exports.isWithinReplaysDir(
				path.join('/workspace', '.swarm', 'replays', 'a.jsonl'),
			),
		).toBe(true);
		expect(
			_test_exports.isWithinReplaysDir(
				path.join('/workspace', '.swarm', 'not-replays', 'a.jsonl'),
			),
		).toBe(false);
	});
});
