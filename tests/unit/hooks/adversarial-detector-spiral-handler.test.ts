/**
 * Verification tests for handleDebuggingSpiral - Task 5.7 Spiral checkpoint wiring
 * Tests: event logging, checkpoint creation, architect notification, non-fatal failures, label format
 */

import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	type AdversarialPatternMatch,
	handleDebuggingSpiral,
} from '../../../src/hooks/adversarial-detector';

// Mock the checkpoint module
jest.mock('../../../src/tools/checkpoint.js', () => ({
	saveCheckpointRecord: jest.fn(),
}));

import * as checkpointModule from '../../../src/tools/checkpoint.js';

const { saveCheckpointRecord } = checkpointModule;

describe('handleDebuggingSpiral', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(async () => {
		// Create a temp directory
		tempDir = `test-spiral-handler-${Date.now()}`;
		originalCwd = process.cwd();

		// Change to parent directory where we'll create our test directory
		process.chdir(os.tmpdir());

		// Create the test directory with .swarm subdirectory
		fs.mkdirSync(tempDir, { recursive: true });
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });

		// Reset mock
		jest.clearAllMocks();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			const cleanupPath = path.join(os.tmpdir(), tempDir);
			fs.rmSync(cleanupPath, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe('1. handleDebuggingSpiral logs event', () => {
		test('writes event to events.jsonl file', async () => {
			const match: AdversarialPatternMatch = {
				pattern: 'DEBUGGING_SPIRAL',
				severity: 'HIGH',
				matchedText: 'Same rejection reason resurfacing: "type error"',
				confidence: 'HIGH',
			};

			// Mock checkpoint to succeed
			(saveCheckpointRecord as jest.Mock).mockReturnValue({ success: true });

			await handleDebuggingSpiral(match, '1.1', tempDir);

			// Verify event was logged
			const eventsPath = path.join(tempDir, '.swarm', 'events.jsonl');
			expect(fs.existsSync(eventsPath)).toBe(true);

			const content = fs.readFileSync(eventsPath, 'utf-8');
			const event = JSON.parse(content.trim());

			expect(event.event).toBe('debugging_spiral_detected');
			expect(event.taskId).toBe('1.1');
			expect(event.pattern).toBe('DEBUGGING_SPIRAL');
			expect(event.matchedText).toBe(
				'Same rejection reason resurfacing: "type error"',
			);
			expect(event.confidence).toBe('HIGH');
		});
	});

	describe('2. handleDebuggingSpiral creates checkpoint', () => {
		test('calls saveCheckpointRecord with label and directory', async () => {
			const match: AdversarialPatternMatch = {
				pattern: 'DEBUGGING_SPIRAL',
				severity: 'HIGH',
				matchedText: 'Test spiral',
				confidence: 'HIGH',
			};

			// Mock checkpoint to succeed
			(saveCheckpointRecord as jest.Mock).mockReturnValue({ success: true });

			await handleDebuggingSpiral(match, '1.1', tempDir);

			// Verify saveCheckpointRecord was called
			expect(saveCheckpointRecord).toHaveBeenCalledTimes(1);

			const callArgs = (saveCheckpointRecord as jest.Mock).mock.calls[0];
			const label = callArgs[0];
			const directory = callArgs[1];

			expect(label).toMatch(/^spiral-1\.1-\d+$/);
			expect(directory).toBe(tempDir);
		});

		test('sets checkpointCreated to true when checkpoint succeeds', async () => {
			const match: AdversarialPatternMatch = {
				pattern: 'DEBUGGING_SPIRAL',
				severity: 'HIGH',
				matchedText: 'Test spiral',
				confidence: 'HIGH',
			};

			// Mock checkpoint to succeed
			(saveCheckpointRecord as jest.Mock).mockReturnValue({ success: true });

			const result = await handleDebuggingSpiral(match, '1.1', tempDir);

			expect(result.checkpointCreated).toBe(true);
		});

		test('sets checkpointCreated to false when checkpoint returns failure', async () => {
			const match: AdversarialPatternMatch = {
				pattern: 'DEBUGGING_SPIRAL',
				severity: 'HIGH',
				matchedText: 'Test spiral',
				confidence: 'HIGH',
			};

			// Mock checkpoint to fail
			(saveCheckpointRecord as jest.Mock).mockReturnValue({
				success: false,
				error: 'No changes to save',
			});

			const result = await handleDebuggingSpiral(match, '1.1', tempDir);

			expect(result.checkpointCreated).toBe(false);
		});
	});

	describe('3. Returns architect notification message', () => {
		test('returns message with FOR: architect tag', async () => {
			const match: AdversarialPatternMatch = {
				pattern: 'DEBUGGING_SPIRAL',
				severity: 'HIGH',
				matchedText: 'Same rejection reason resurfacing: "type error"',
				confidence: 'HIGH',
			};

			(saveCheckpointRecord as jest.Mock).mockReturnValue({ success: true });

			const result = await handleDebuggingSpiral(match, '1.1', tempDir);

			expect(result.message).toContain('[FOR: architect]');
			expect(result.message).toContain(
				'DEBUGGING SPIRAL DETECTED for task 1.1',
			);
			expect(result.message).toContain(
				'Issue: Same rejection reason resurfacing: "type error"',
			);
			expect(result.message).toContain('Confidence: HIGH');
		});

		test('includes checkpoint success message when checkpoint created', async () => {
			const match: AdversarialPatternMatch = {
				pattern: 'DEBUGGING_SPIRAL',
				severity: 'HIGH',
				matchedText: 'Test spiral',
				confidence: 'HIGH',
			};

			(saveCheckpointRecord as jest.Mock).mockReturnValue({ success: true });

			const result = await handleDebuggingSpiral(match, '1.1', tempDir);

			expect(result.message).toContain('✓ Auto-checkpoint created:');
		});

		test('includes checkpoint failure message when checkpoint fails', async () => {
			const match: AdversarialPatternMatch = {
				pattern: 'DEBUGGING_SPIRAL',
				severity: 'HIGH',
				matchedText: 'Test spiral',
				confidence: 'HIGH',
			};

			(saveCheckpointRecord as jest.Mock).mockReturnValue({ success: false });

			const result = await handleDebuggingSpiral(match, '1.1', tempDir);

			expect(result.message).toContain('⚠ Auto-checkpoint failed (non-fatal)');
		});

		test('includes recommendation to escalate or change approach', async () => {
			const match: AdversarialPatternMatch = {
				pattern: 'DEBUGGING_SPIRAL',
				severity: 'HIGH',
				matchedText: 'Test spiral',
				confidence: 'HIGH',
			};

			(saveCheckpointRecord as jest.Mock).mockReturnValue({ success: true });

			const result = await handleDebuggingSpiral(match, '1.1', tempDir);

			expect(result.message).toContain(
				'Recommendation: Consider escalating to user or taking a different approach',
			);
			expect(result.message).toContain(
				'The current fix strategy appears to be cycling without progress',
			);
		});
	});

	describe('4. Checkpoint failure is non-fatal', () => {
		test('does not throw when saveCheckpointRecord throws', async () => {
			const match: AdversarialPatternMatch = {
				pattern: 'DEBUGGING_SPIRAL',
				severity: 'HIGH',
				matchedText: 'Test spiral',
				confidence: 'HIGH',
			};

			// Mock checkpoint to throw
			(saveCheckpointRecord as jest.Mock).mockImplementation(() => {
				throw new Error('Checkpoint service unavailable');
			});

			// Should not throw
			const result = await handleDebuggingSpiral(match, '1.1', tempDir);

			// Should return valid result with checkpointCreated false
			expect(result.checkpointCreated).toBe(false);
			expect(result.message).toBeDefined();
			expect(result.eventLogged).toBe(true);
		});

		test('does not throw when checkpoint returns invalid result', async () => {
			const match: AdversarialPatternMatch = {
				pattern: 'DEBUGGING_SPIRAL',
				severity: 'HIGH',
				matchedText: 'Test spiral',
				confidence: 'HIGH',
			};

			// Mock checkpoint to return undefined (falsy)
			(saveCheckpointRecord as jest.Mock).mockReturnValue(null);

			// Should not throw
			const result = await handleDebuggingSpiral(match, '1.1', tempDir);

			// Should return valid result with checkpointCreated false
			expect(result.checkpointCreated).toBe(false);
			expect(result.message).toBeDefined();
			expect(result.eventLogged).toBe(true);
		});
	});

	describe('5. Label format is correct', () => {
		test('checkpoint label follows spiral-{taskId}-{timestamp} format', async () => {
			const match: AdversarialPatternMatch = {
				pattern: 'DEBUGGING_SPIRAL',
				severity: 'HIGH',
				matchedText: 'Test spiral',
				confidence: 'HIGH',
			};

			(saveCheckpointRecord as jest.Mock).mockReturnValue({ success: true });

			await handleDebuggingSpiral(match, '5.7.1', tempDir);

			const callArgs = (saveCheckpointRecord as jest.Mock).mock.calls[0];
			const label = callArgs[0];

			// Check format: spiral-{taskId}-{timestamp}
			expect(label).toMatch(/^spiral-5\.7\.1-\d+$/);
		});

		test('label contains valid timestamp (13+ digits for ms)', async () => {
			const match: AdversarialPatternMatch = {
				pattern: 'DEBUGGING_SPIRAL',
				severity: 'HIGH',
				matchedText: 'Test spiral',
				confidence: 'HIGH',
			};

			(saveCheckpointRecord as jest.Mock).mockReturnValue({ success: true });

			await handleDebuggingSpiral(match, '1.1', tempDir);

			const callArgs = (saveCheckpointRecord as jest.Mock).mock.calls[0];
			const label = callArgs[0];
			const timestampPart = label.split('-')[2];
			const timestamp = parseInt(timestampPart, 10);

			// Should be a valid timestamp (reasonable date range)
			expect(timestamp).toBeGreaterThan(1700000000000); // After year 2023
			expect(timestamp).toBeLessThan(2000000000000); // Before year 2033
		});

		test('message includes the checkpoint label when checkpoint succeeds', async () => {
			const match: AdversarialPatternMatch = {
				pattern: 'DEBUGGING_SPIRAL',
				severity: 'HIGH',
				matchedText: 'Test spiral',
				confidence: 'HIGH',
			};

			(saveCheckpointRecord as jest.Mock).mockReturnValue({ success: true });

			const result = await handleDebuggingSpiral(match, '3.2', tempDir);

			const callArgs = (saveCheckpointRecord as jest.Mock).mock.calls[0];
			const label = callArgs[0];

			expect(result.message).toContain(`✓ Auto-checkpoint created: ${label}`);
		});
	});

	describe('integration: full spiral handling flow', () => {
		test('complete flow: logs event, creates checkpoint, returns notification', async () => {
			const match: AdversarialPatternMatch = {
				pattern: 'DEBUGGING_SPIRAL',
				severity: 'HIGH',
				matchedText: '3+ cycles with different rejection reasons (5 unique)',
				confidence: 'MEDIUM',
			};

			(saveCheckpointRecord as jest.Mock).mockReturnValue({ success: true });

			const result = await handleDebuggingSpiral(match, '5.7', tempDir);

			// Verify all return values
			expect(result.eventLogged).toBe(true);
			expect(result.checkpointCreated).toBe(true);
			expect(result.message).toContain('[FOR: architect]');
			expect(result.message).toContain('DEBUGGING SPIRAL DETECTED');
			expect(result.message).toContain('5.7');
			expect(result.message).toContain(
				'3+ cycles with different rejection reasons (5 unique)',
			);
			expect(result.message).toContain('MEDIUM');
			expect(result.message).toContain(
				'Recommendation: Consider escalating to user',
			);

			// Verify event file exists
			const eventsPath = path.join(tempDir, '.swarm', 'events.jsonl');
			const content = fs.readFileSync(eventsPath, 'utf-8');
			const event = JSON.parse(content.trim());
			expect(event.event).toBe('debugging_spiral_detected');
			expect(event.taskId).toBe('5.7');

			// Verify checkpoint was called
			expect(saveCheckpointRecord).toHaveBeenCalledTimes(1);
		});
	});
});
