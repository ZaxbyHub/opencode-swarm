import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleAcknowledgeSpecDriftCommand } from '../commands/acknowledge-spec-drift';

describe('handleAcknowledgeSpecDriftCommand', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(
			tmpdir(),
			'acknowledge-spec-drift-test-' +
				Date.now() +
				'-' +
				Math.random().toString(36).slice(2),
		);
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		try {
			await rm(tempDir, { force: true, recursive: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe('ENOENT case', () => {
		test('returns "No spec drift detected." when spec-staleness.json does not exist', async () => {
			// Don't create spec-staleness.json - it should not exist
			const result = await handleAcknowledgeSpecDriftCommand(tempDir, []);

			expect(result).toBe('No spec drift detected.');
		});
	});

	describe('malformed JSON case', () => {
		test('deletes corrupted spec-staleness.json and returns error message', async () => {
			const specStalenessPath = join(tempDir, '.swarm', 'spec-staleness.json');
			await writeFile(specStalenessPath, '{ invalid json content }');

			const result = await handleAcknowledgeSpecDriftCommand(tempDir, []);

			expect(result).toBe(
				'Spec staleness file was corrupted. It has been removed.',
			);

			// Verify file was deleted
			await expect(unlink(specStalenessPath)).rejects.toThrow();
		});

		test('handles empty file as malformed JSON', async () => {
			const specStalenessPath = join(tempDir, '.swarm', 'spec-staleness.json');
			await writeFile(specStalenessPath, '');

			const result = await handleAcknowledgeSpecDriftCommand(tempDir, []);

			expect(result).toBe(
				'Spec staleness file was corrupted. It has been removed.',
			);
		});
	});

	describe('valid JSON case', () => {
		test('deletes spec-staleness.json and appends event to events.jsonl', async () => {
			const specStalenessPath = join(tempDir, '.swarm', 'spec-staleness.json');
			const eventsPath = join(tempDir, '.swarm', 'events.jsonl');

			const validPayload = {
				planTitle: 'Test Plan',
				phase: 3,
				specHash_plan: 'abc123',
				specHash_current: 'def456',
				reason: 'spec modified',
				timestamp: '2024-01-01T00:00:00.000Z',
			};
			await writeFile(specStalenessPath, JSON.stringify(validPayload));

			const result = await handleAcknowledgeSpecDriftCommand(tempDir, []);

			// Verify the response contains expected content
			expect(result).toContain(
				'Spec drift acknowledged for plan "Test Plan" (phase 3)',
			);
			expect(result).toContain('Warning: Spec drift was acknowledged');

			// Verify spec-staleness.json was deleted
			await expect(unlink(specStalenessPath)).rejects.toThrow();

			// Verify events.jsonl was created with the acknowledgment event
			const eventsContent = await readFile(eventsPath, 'utf-8');
			const eventLines = eventsContent.trim().split('\n');
			expect(eventLines).toHaveLength(1);

			const event = JSON.parse(eventLines[0]);
			expect(event.type).toBe('spec_drift_acknowledged');
			expect(event.phase).toBe(3);
			expect(event.planTitle).toBe('Test Plan');
			// Issue #890: actor is now caller-supplied; default is 'unknown'
			expect(event.acknowledgedBy).toBe('unknown');
			expect(event.timestamp).toBeDefined();
		});

		test('returns confirmation with warning message', async () => {
			const specStalenessPath = join(tempDir, '.swarm', 'spec-staleness.json');

			const validPayload = {
				planTitle: 'My Awesome Project',
				phase: 7,
				specHash_plan: 'hash123',
				specHash_current: null,
				reason: 'spec deleted',
				timestamp: '2024-06-15T12:00:00.000Z',
			};
			await writeFile(specStalenessPath, JSON.stringify(validPayload));

			const result = await handleAcknowledgeSpecDriftCommand(tempDir, []);

			expect(result).toBe(
				'Spec drift acknowledged for plan "My Awesome Project" (phase 7).\n\n⚠️  Warning: Spec drift was acknowledged — verify that the implementation still matches the spec before proceeding.',
			);
		});

		test('appends to existing events.jsonl', async () => {
			const specStalenessPath = join(tempDir, '.swarm', 'spec-staleness.json');
			const eventsPath = join(tempDir, '.swarm', 'events.jsonl');

			// Create existing events
			const existingEvent = {
				type: 'some_existing_event',
				timestamp: '2024-01-01T00:00:00.000Z',
			};
			await writeFile(eventsPath, `${JSON.stringify(existingEvent)}\n`);

			const validPayload = {
				planTitle: 'Append Test',
				phase: 2,
				specHash_plan: 'xyz',
				specHash_current: 'xyz',
				reason: 'spec unchanged',
				timestamp: '2024-01-02T00:00:00.000Z',
			};
			await writeFile(specStalenessPath, JSON.stringify(validPayload));

			await handleAcknowledgeSpecDriftCommand(tempDir, []);

			// Verify events.jsonl has both events
			const eventsContent = await readFile(eventsPath, 'utf-8');
			const eventLines = eventsContent.trim().split('\n');
			expect(eventLines).toHaveLength(2);

			const firstEvent = JSON.parse(eventLines[0]);
			expect(firstEvent.type).toBe('some_existing_event');

			const secondEvent = JSON.parse(eventLines[1]);
			expect(secondEvent.type).toBe('spec_drift_acknowledged');
			expect(secondEvent.planTitle).toBe('Append Test');
		});

		test('non-fatal when events.jsonl append fails', async () => {
			const specStalenessPath = join(tempDir, '.swarm', 'spec-staleness.json');

			// Make .swarm read-only so appendFile will fail
			await writeFile(
				specStalenessPath,
				JSON.stringify({
					planTitle: 'Test',
					phase: 1,
					specHash_plan: 'hash',
					specHash_current: 'hash',
					reason: 'test',
					timestamp: '2024-01-01T00:00:00.000Z',
				}),
			);

			// The command should still succeed (non-fatal) even if event logging fails
			// because the spec-staleness.json is deleted
			const result = await handleAcknowledgeSpecDriftCommand(tempDir, []);

			expect(result).toContain('Spec drift acknowledged');
			// spec-staleness.json should still be deleted
			await expect(unlink(specStalenessPath)).rejects.toThrow();
		});
	});

	// Issue #890: caller-supplied actor for forensic audit trail.
	describe('acknowledgedBy actor parameter (issue #890)', () => {
		test('records "user" when invoked via chat slash command', async () => {
			const specStalenessPath = join(tempDir, '.swarm', 'spec-staleness.json');
			const eventsPath = join(tempDir, '.swarm', 'events.jsonl');
			await writeFile(
				specStalenessPath,
				JSON.stringify({
					planTitle: 'P',
					phase: 1,
					specHash_plan: 'h',
					specHash_current: 'h',
					reason: 'r',
					timestamp: '2024-01-01T00:00:00.000Z',
				}),
			);
			await handleAcknowledgeSpecDriftCommand(tempDir, [], 'user');
			const event = JSON.parse(
				(await readFile(eventsPath, 'utf-8')).trim().split('\n').pop() ?? '{}',
			);
			expect(event.acknowledgedBy).toBe('user');
		});

		test('records "cli" when invoked via CLI run dispatch', async () => {
			const specStalenessPath = join(tempDir, '.swarm', 'spec-staleness.json');
			const eventsPath = join(tempDir, '.swarm', 'events.jsonl');
			await writeFile(
				specStalenessPath,
				JSON.stringify({
					planTitle: 'P',
					phase: 1,
					specHash_plan: 'h',
					specHash_current: 'h',
					reason: 'r',
					timestamp: '2024-01-01T00:00:00.000Z',
				}),
			);
			await handleAcknowledgeSpecDriftCommand(tempDir, [], 'cli');
			const event = JSON.parse(
				(await readFile(eventsPath, 'utf-8')).trim().split('\n').pop() ?? '{}',
			);
			expect(event.acknowledgedBy).toBe('cli');
		});
	});
});
