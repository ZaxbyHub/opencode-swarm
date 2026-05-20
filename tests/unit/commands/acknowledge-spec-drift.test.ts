/**
 * Tests for handleAcknowledgeSpecDriftCommand
 *
 * Tests the acknowledge-spec-drift command which:
 * 1. Reads spec-staleness.json
 * 2. If exists and valid: deletes it, loads plan, computes hash, updates plan.specHash, writes acknowledgment event
 * 3. If doesn't exist: returns 'No spec drift detected.'
 * 4. If malformed: deletes it and returns corruption message
 * 5. If plan has no specHash: skips hash update step
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleAcknowledgeSpecDriftCommand } from '../../../src/commands/acknowledge-spec-drift';

describe('handleAcknowledgeSpecDriftCommand', () => {
	let tempDir: string;

	async function getSwarmPath(filename: string): Promise<string> {
		return join(tempDir, '.swarm', filename);
	}

	function getSwarmPathSync(filename: string): string {
		return join(tempDir, '.swarm', filename);
	}

	beforeEach(async () => {
		tempDir = join(
			tmpdir(),
			'ack-spec-drift-test-' +
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

	describe('When spec-staleness.json does not exist', () => {
		test('should return "No spec drift detected." without error', async () => {
			const result = await handleAcknowledgeSpecDriftCommand(tempDir, []);

			expect(result).toBe('No spec drift detected.');
		});

		test('should not create any files', async () => {
			await handleAcknowledgeSpecDriftCommand(tempDir, []);

			const specStalenessPath = await getSwarmPath('spec-staleness.json');
			const planPath = await getSwarmPath('plan.json');
			const eventsPath = await getSwarmPath('events.jsonl');

			expect(existsSync(specStalenessPath)).toBe(false);
			expect(existsSync(planPath)).toBe(false);
			expect(existsSync(eventsPath)).toBe(false);
		});
	});

	describe('When spec-staleness.json is malformed', () => {
		test('should delete the malformed file and return corruption message', async () => {
			const specStalenessPath = await getSwarmPath('spec-staleness.json');
			await writeFile(specStalenessPath, '{ invalid json !!!');

			const result = await handleAcknowledgeSpecDriftCommand(tempDir, []);

			expect(result).toBe(
				'Spec staleness file was corrupted. It has been removed.',
			);
			// File should be deleted
			expect(existsSync(specStalenessPath)).toBe(false);
		});

		test('should handle empty file as malformed', async () => {
			const specStalenessPath = await getSwarmPath('spec-staleness.json');
			await writeFile(specStalenessPath, '');

			const result = await handleAcknowledgeSpecDriftCommand(tempDir, []);

			expect(result).toBe(
				'Spec staleness file was corrupted. It has been removed.',
			);
			expect(existsSync(specStalenessPath)).toBe(false);
		});

		test('should handle JSON that parses but has wrong structure', async () => {
			const specStalenessPath = await getSwarmPath('spec-staleness.json');
			// Valid JSON but wrong structure (missing required fields)
			// This is syntactically valid JSON but semantically invalid
			await writeFile(specStalenessPath, JSON.stringify({ foo: 'bar' }));

			const result = await handleAcknowledgeSpecDriftCommand(tempDir, []);

			// Since JSON parses successfully, the command proceeds with undefined values
			// This is a known limitation - the implementation doesn't validate the schema
			// The event will have undefined values but command doesn't crash
			expect(result).toContain('Spec drift acknowledged');
		});
	});

	describe('When spec-staleness.json exists with valid data', () => {
		test('should delete spec-staleness.json after acknowledgment', async () => {
			const specStalenessPath = await getSwarmPath('spec-staleness.json');
			const planPath = getSwarmPathSync('plan.json');
			const specMdPath = getSwarmPathSync('spec.md');

			// Create valid plan with specHash
			const plan = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'in_progress',
								size: 'small',
								description: 'Test task',
								depends: [],
							},
						],
					},
				],
				migration_status: 'native',
				specHash: 'oldhash123',
			};
			writeFileSync(planPath, JSON.stringify(plan, null, 2));

			// Create spec.md
			writeFileSync(specMdPath, '# Spec\nThis is the spec content.');

			// Create spec-staleness.json
			await writeFile(
				specStalenessPath,
				JSON.stringify({
					planTitle: 'Test Plan',
					phase: 1,
					specHash_plan: 'oldhash123',
					specHash_current: 'newhash456',
					reason: 'spec.md has been modified',
					timestamp: new Date().toISOString(),
				}),
			);

			await handleAcknowledgeSpecDriftCommand(tempDir, []);

			expect(existsSync(specStalenessPath)).toBe(false);
		});

		test('should update plan.specHash with current computed hash and save plan', async () => {
			const specStalenessPath = await getSwarmPath('spec-staleness.json');
			const planPath = getSwarmPathSync('plan.json');
			const specMdPath = getSwarmPathSync('spec.md');

			// Create valid plan with specHash
			const plan = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'in_progress',
								size: 'small',
								description: 'Test task',
								depends: [],
							},
						],
					},
				],
				migration_status: 'native',
				specHash: 'oldhash123',
			};
			writeFileSync(planPath, JSON.stringify(plan, null, 2));

			// Create spec.md with specific content
			writeFileSync(specMdPath, '# Spec\nUpdated spec content.');

			// Create spec-staleness.json
			await writeFile(
				specStalenessPath,
				JSON.stringify({
					planTitle: 'Test Plan',
					phase: 1,
					specHash_plan: 'oldhash123',
					specHash_current: 'newhash456',
					reason: 'spec.md has been modified',
					timestamp: new Date().toISOString(),
				}),
			);

			await handleAcknowledgeSpecDriftCommand(tempDir, []);

			// Read the updated plan
			const updatedPlan = JSON.parse(readFileSync(planPath, 'utf-8'));
			// The specHash should now be the hash of the current spec.md
			expect(updatedPlan.specHash).not.toBe('oldhash123');
			expect(typeof updatedPlan.specHash).toBe('string');
		});

		test('should write acknowledgment event with previousHash and newHash', async () => {
			const specStalenessPath = await getSwarmPath('spec-staleness.json');
			const eventsPath = getSwarmPathSync('events.jsonl');
			const planPath = getSwarmPathSync('plan.json');
			const specMdPath = getSwarmPathSync('spec.md');

			// Create valid plan with specHash
			const plan = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'in_progress',
								size: 'small',
								description: 'Test task',
								depends: [],
							},
						],
					},
				],
				migration_status: 'native',
				specHash: 'oldhash123',
			};
			writeFileSync(planPath, JSON.stringify(plan, null, 2));

			// Create spec.md
			writeFileSync(specMdPath, '# Spec\nUpdated spec content.');

			// Create spec-staleness.json
			await writeFile(
				specStalenessPath,
				JSON.stringify({
					planTitle: 'Test Plan',
					phase: 1,
					specHash_plan: 'oldhash123',
					specHash_current: 'newhash456',
					reason: 'spec.md has been modified',
					timestamp: new Date().toISOString(),
				}),
			);

			await handleAcknowledgeSpecDriftCommand(tempDir, []);

			expect(existsSync(eventsPath)).toBe(true);
			const eventsContent = readFileSync(eventsPath, 'utf-8');
			const eventLine = eventsContent
				.trim()
				.split('\n')
				.find((line) => line.includes('spec_drift_acknowledged'));
			expect(eventLine).toBeDefined();

			const event = JSON.parse(eventLine!);
			expect(event.type).toBe('spec_drift_acknowledged');
			expect(event.previousHash).toBe('oldhash123');
			expect(event.newHash).not.toBeNull();
			expect(event.planTitle).toBe('Test Plan');
			expect(event.phase).toBe(1);
			// Issue #890: actor is caller-supplied; default (no arg) is 'unknown'.
			expect(event.acknowledgedBy).toBe('unknown');
		});

		test('should return success message with plan title and phase', async () => {
			const specStalenessPath = await getSwarmPath('spec-staleness.json');

			// Create spec-staleness.json
			await writeFile(
				specStalenessPath,
				JSON.stringify({
					planTitle: 'My Test Plan',
					phase: 2,
					specHash_plan: 'oldhash123',
					specHash_current: 'newhash456',
					reason: 'spec.md has been modified',
					timestamp: new Date().toISOString(),
				}),
			);

			const result = await handleAcknowledgeSpecDriftCommand(tempDir, []);

			expect(result).toContain('My Test Plan');
			expect(result).toContain('phase 2');
			expect(result).toContain('Spec drift acknowledged');
		});

		test('should handle when spec.md does not exist (newHash is null)', async () => {
			const specStalenessPath = await getSwarmPath('spec-staleness.json');
			const planPath = getSwarmPathSync('plan.json');

			// Create valid plan with specHash
			const plan = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'in_progress',
								size: 'small',
								description: 'Test task',
								depends: [],
							},
						],
					},
				],
				migration_status: 'native',
				specHash: 'oldhash123',
			};
			writeFileSync(planPath, JSON.stringify(plan, null, 2));

			// Do NOT create spec.md

			// Create spec-staleness.json
			await writeFile(
				specStalenessPath,
				JSON.stringify({
					planTitle: 'Test Plan',
					phase: 1,
					specHash_plan: 'oldhash123',
					specHash_current: null,
					reason: 'spec.md has been deleted',
					timestamp: new Date().toISOString(),
				}),
			);

			await handleAcknowledgeSpecDriftCommand(tempDir, []);

			// Read the updated plan - specHash should be updated to undefined
			// (since computeSpecHash returns null when spec.md doesn't exist)
			const updatedPlan = JSON.parse(readFileSync(planPath, 'utf-8'));
			// The implementation sets plan.specHash = null ?? undefined
			// which results in undefined (since null ?? undefined === undefined)
			expect(updatedPlan.specHash).toBeUndefined();
		});
	});

	describe('When plan exists but has no specHash', () => {
		test('should gracefully skip the hash update step', async () => {
			const specStalenessPath = await getSwarmPath('spec-staleness.json');
			const eventsPath = getSwarmPathSync('events.jsonl');
			const planPath = getSwarmPathSync('plan.json');
			const specMdPath = getSwarmPathSync('spec.md');

			// Create plan WITHOUT specHash
			const plan = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'in_progress',
								size: 'small',
								description: 'Test task',
								depends: [],
							},
						],
					},
				],
				migration_status: 'native',
				// No specHash!
			};
			writeFileSync(planPath, JSON.stringify(plan, null, 2));
			writeFileSync(specMdPath, '# New Spec Content');

			// Create spec-staleness.json
			await writeFile(
				specStalenessPath,
				JSON.stringify({
					planTitle: 'Test Plan',
					phase: 1,
					specHash_plan: 'somehash',
					specHash_current: 'newhash',
					reason: 'spec.md has been modified',
					timestamp: new Date().toISOString(),
				}),
			);

			const result = await handleAcknowledgeSpecDriftCommand(tempDir, []);

			// Should still succeed
			expect(result).toContain('Spec drift acknowledged');

			// Plan should NOT have specHash added
			const updatedPlan = JSON.parse(readFileSync(planPath, 'utf-8'));
			expect(updatedPlan.specHash).toBeUndefined();

			// Event should still be written with previousHash but newHash should be null
			expect(existsSync(eventsPath)).toBe(true);
			const eventsContent = readFileSync(eventsPath, 'utf-8');
			const eventLine = eventsContent
				.trim()
				.split('\n')
				.find((line) => line.includes('spec_drift_acknowledged'));
			expect(eventLine).toBeDefined();
			const event = JSON.parse(eventLine!);
			expect(event.previousHash).toBe('somehash');
			expect(event.newHash).toBeNull();
		});
	});

	describe('Event file handling edge cases', () => {
		test('should handle missing events.jsonl (create new one)', async () => {
			const specStalenessPath = await getSwarmPath('spec-staleness.json');
			const eventsPath = getSwarmPathSync('events.jsonl');

			// Create spec-staleness.json
			await writeFile(
				specStalenessPath,
				JSON.stringify({
					planTitle: 'Test Plan',
					phase: 1,
					specHash_plan: 'oldhash',
					specHash_current: 'newhash',
					reason: 'spec.md has been modified',
					timestamp: new Date().toISOString(),
				}),
			);
			// events.jsonl does not exist

			await handleAcknowledgeSpecDriftCommand(tempDir, []);

			expect(existsSync(eventsPath)).toBe(true);
			const eventsContent = readFileSync(eventsPath, 'utf-8');
			expect(eventsContent).toContain('spec_drift_acknowledged');
		});

		test('should append to existing events.jsonl', async () => {
			const specStalenessPath = await getSwarmPath('spec-staleness.json');
			const eventsPath = getSwarmPathSync('events.jsonl');

			// Pre-create events.jsonl with existing content
			writeFileSync(
				eventsPath,
				'{"type":"other_event","timestamp":"2024-01-01T00:00:00Z"}\n',
			);

			// Create spec-staleness.json
			await writeFile(
				specStalenessPath,
				JSON.stringify({
					planTitle: 'Append Test',
					phase: 2,
					specHash_plan: 'xyz',
					specHash_current: 'xyz',
					reason: 'spec unchanged',
					timestamp: '2024-01-02T00:00:00.000Z',
				}),
			);

			await handleAcknowledgeSpecDriftCommand(tempDir, []);

			const eventsContent = readFileSync(eventsPath, 'utf-8');
			const lines = eventsContent.trim().split('\n');
			expect(lines.length).toBe(2);
			expect(lines[0]).toContain('other_event');
			expect(lines[1]).toContain('spec_drift_acknowledged');
		});

		test('should not fail if events.jsonl is a directory', async () => {
			const specStalenessPath = await getSwarmPath('spec-staleness.json');
			const eventsPath = getSwarmPathSync('events.jsonl');

			// Create spec-staleness.json
			await writeFile(
				specStalenessPath,
				JSON.stringify({
					planTitle: 'Test Plan',
					phase: 1,
					specHash_plan: 'oldhash',
					specHash_current: 'newhash',
					reason: 'spec.md has been modified',
					timestamp: new Date().toISOString(),
				}),
			);
			// Pre-create events.jsonl as a directory to block append
			mkdirSync(eventsPath, { recursive: true });

			// Should not throw, just log error
			const result = await handleAcknowledgeSpecDriftCommand(tempDir, []);

			// Command still succeeds (event logging is non-fatal)
			expect(result).toContain('Spec drift acknowledged');
		});
	});

	describe('Return message verification', () => {
		test('should include warning about verifying implementation', async () => {
			const specStalenessPath = await getSwarmPath('spec-staleness.json');

			await writeFile(
				specStalenessPath,
				JSON.stringify({
					planTitle: 'Test Plan',
					phase: 1,
					specHash_plan: 'oldhash',
					specHash_current: 'newhash',
					reason: 'spec.md has been modified',
					timestamp: new Date().toISOString(),
				}),
			);

			const result = await handleAcknowledgeSpecDriftCommand(tempDir, []);

			expect(result).toContain(
				'⚠️  Warning: Spec drift was acknowledged — verify that the implementation still matches the spec before proceeding.',
			);
		});
	});
});
