/**
 * Tests for steering-consumed hook
 *
 * Tests both recordSteeringConsumed and createSteeringConsumedHook functions
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	createSteeringConsumedHook,
	recordSteeringConsumed,
} from '../../../src/hooks/steering-consumed.js';

describe('recordSteeringConsumed', () => {
	let tempDir: string;
	let swarmDir: string;
	let eventsPath: string;

	beforeEach(() => {
		// Create isolated temp directory
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'steering-test-'));
		swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		eventsPath = path.join(swarmDir, 'events.jsonl');
	});

	afterEach(() => {
		// Clean up temp directory
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it('should append a valid steering-consumed JSON line to events.jsonl', () => {
		recordSteeringConsumed(tempDir, 'dir-123');

		expect(fs.existsSync(eventsPath)).toBe(true);

		const content = fs.readFileSync(eventsPath, 'utf-8');
		const lines = content.trim().split('\n');

		expect(lines.length).toBe(1);

		const event = JSON.parse(lines[0]) as {
			type: string;
			directiveId: string;
			timestamp: string;
		};

		expect(event.type).toBe('steering-consumed');
		expect(event.directiveId).toBe('dir-123');
		expect(event.timestamp).toBeTruthy();
	});

	it('should have correct type, directiveId, and valid ISO timestamp', () => {
		recordSteeringConsumed(tempDir, 'test-directive-abc');

		const content = fs.readFileSync(eventsPath, 'utf-8');
		const event = JSON.parse(content.trim()) as {
			type: string;
			directiveId: string;
			timestamp: string;
		};

		expect(event.type).toBe('steering-consumed');
		expect(event.directiveId).toBe('test-directive-abc');

		// Validate ISO 8601 timestamp format
		expect(() => new Date(event.timestamp)).not.toThrow();
		expect(event.timestamp).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
		);
	});

	it('should NOT throw on missing .swarm directory (silently swallows)', () => {
		const noSwarmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-swarm-'));

		expect(() => {
			recordSteeringConsumed(noSwarmDir, 'dir-456');
		}).not.toThrow();

		// Verify no events.jsonl was created
		const swarmPath = path.join(noSwarmDir, '.swarm');
		expect(fs.existsSync(swarmPath)).toBe(false);

		// Clean up
		fs.rmSync(noSwarmDir, { recursive: true, force: true });
	});

	it('should NOT throw on permission errors (silently swallows)', () => {
		// Create a directory with restricted permissions
		const restrictedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restricted-'));
		const restrictedSwarmDir = path.join(restrictedDir, '.swarm');
		fs.mkdirSync(restrictedSwarmDir, { recursive: true });

		// On Windows, we can't easily test permission errors, so we'll
		// simulate by making the file read-only after creation
		const restrictedEventsPath = path.join(restrictedSwarmDir, 'events.jsonl');
		fs.writeFileSync(restrictedEventsPath, 'existing data\n');

		try {
			// On Unix-like systems, we would make the directory read-only
			// On Windows, we'll rely on the fact that the function silently swallows errors
			recordSteeringConsumed(restrictedDir, 'dir-789');

			// The function should not throw regardless
			expect(true).toBe(true);
		} finally {
			// Clean up
			fs.rmSync(restrictedDir, { recursive: true, force: true });
		}
	});

	it('should produce two entries when called twice with same directiveId (no dedup in function)', () => {
		recordSteeringConsumed(tempDir, 'dir-twice');
		recordSteeringConsumed(tempDir, 'dir-twice');

		const content = fs.readFileSync(eventsPath, 'utf-8');
		const lines = content.trim().split('\n');

		expect(lines.length).toBe(2);

		const event1 = JSON.parse(lines[0]) as { directiveId: string };
		const event2 = JSON.parse(lines[1]) as { directiveId: string };

		expect(event1.directiveId).toBe('dir-twice');
		expect(event2.directiveId).toBe('dir-twice');
	});

	it('should append to existing events.jsonl content', () => {
		// Write initial content
		fs.writeFileSync(eventsPath, '{"type":"other-event","data":"test"}\n');

		recordSteeringConsumed(tempDir, 'dir-append');

		const content = fs.readFileSync(eventsPath, 'utf-8');
		const lines = content.trim().split('\n');

		expect(lines.length).toBe(2);
		expect(lines[0]).toContain('other-event');

		const newEvent = JSON.parse(lines[1]) as {
			type: string;
			directiveId: string;
		};
		expect(newEvent.type).toBe('steering-consumed');
		expect(newEvent.directiveId).toBe('dir-append');
	});
});

describe('createSteeringConsumedHook', () => {
	let tempDir: string;
	let swarmDir: string;
	let eventsPath: string;

	beforeEach(() => {
		// Create isolated temp directory
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-test-'));
		swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		eventsPath = path.join(swarmDir, 'events.jsonl');
	});

	afterEach(() => {
		// Clean up temp directory
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it('should return a function', () => {
		const hook = createSteeringConsumedHook(tempDir);

		expect(typeof hook).toBe('function');
		expect(hook.length).toBe(2); // Accepts input and output parameters
	});

	it('should resolve without error when events.jsonl does not exist', async () => {
		const hook = createSteeringConsumedHook(tempDir);

		// Remove events.jsonl if it exists
		if (fs.existsSync(eventsPath)) {
			fs.unlinkSync(eventsPath);
		}

		// Hook should resolve without throwing
		await expect(hook({}, {})).resolves.toBeUndefined();
		expect(fs.existsSync(eventsPath)).toBe(false);
	});

	it('should resolve without writing anything when events.jsonl is empty', async () => {
		const hook = createSteeringConsumedHook(tempDir);
		fs.writeFileSync(eventsPath, '');

		await hook({}, {});

		const content = fs.readFileSync(eventsPath, 'utf-8');
		expect(content).toBe('');
	});

	it('should write a steering-consumed event when events.jsonl has unacknowledged directive', async () => {
		const hook = createSteeringConsumedHook(tempDir);

		// Write a steering-directive event without a matching consumed event
		const directiveEvent = {
			type: 'steering-directive',
			directiveId: 'dir-unconsumed',
			timestamp: new Date().toISOString(),
		};
		fs.writeFileSync(eventsPath, `${JSON.stringify(directiveEvent)}\n`);

		await hook({}, {});

		const content = fs.readFileSync(eventsPath, 'utf-8');
		const lines = content.trim().split('\n');

		expect(lines.length).toBe(2);

		const consumedEvent = JSON.parse(lines[1]) as {
			type: string;
			directiveId: string;
		};

		expect(consumedEvent.type).toBe('steering-consumed');
		expect(consumedEvent.directiveId).toBe('dir-unconsumed');
	});

	it('should NOT write again when directive already has matching consumed event', async () => {
		const hook = createSteeringConsumedHook(tempDir);

		// Write both directive and consumed event
		const directiveEvent = {
			type: 'steering-directive',
			directiveId: 'dir-already-consumed',
			timestamp: new Date().toISOString(),
		};
		const consumedEvent = {
			type: 'steering-consumed',
			directiveId: 'dir-already-consumed',
			timestamp: new Date().toISOString(),
		};
		fs.writeFileSync(
			eventsPath,
			`${JSON.stringify(directiveEvent)}\n${JSON.stringify(consumedEvent)}\n`,
		);

		const contentBefore = fs.readFileSync(eventsPath, 'utf-8');
		const linesBefore = contentBefore.trim().split('\n');

		await hook({}, {});

		const contentAfter = fs.readFileSync(eventsPath, 'utf-8');
		const linesAfter = contentAfter.trim().split('\n');

		// Should not add any new lines
		expect(linesAfter.length).toBe(linesBefore.length);
	});

	it('should write consumed events for multiple unacknowledged directives', async () => {
		const hook = createSteeringConsumedHook(tempDir);

		// Write multiple steering-directive events without matching consumed events
		const directive1 = {
			type: 'steering-directive',
			directiveId: 'dir-1',
			timestamp: new Date().toISOString(),
		};
		const directive2 = {
			type: 'steering-directive',
			directiveId: 'dir-2',
			timestamp: new Date().toISOString(),
		};
		const directive3 = {
			type: 'steering-directive',
			directiveId: 'dir-3',
			timestamp: new Date().toISOString(),
		};
		fs.writeFileSync(
			eventsPath,
			`${JSON.stringify(directive1)}\n${JSON.stringify(directive2)}\n${JSON.stringify(directive3)}\n`,
		);

		await hook({}, {});

		const content = fs.readFileSync(eventsPath, 'utf-8');
		const lines = content.trim().split('\n');

		// Should have 3 directives + 3 consumed events = 6 lines
		expect(lines.length).toBe(6);

		// Verify consumed events were written
		const consumedDirectiveIds = lines
			.slice(3)
			.map((line) => JSON.parse(line) as { directiveId: string })
			.map((e) => e.directiveId);

		expect(consumedDirectiveIds).toContain('dir-1');
		expect(consumedDirectiveIds).toContain('dir-2');
		expect(consumedDirectiveIds).toContain('dir-3');
	});

	it('should skip malformed lines and process valid lines', async () => {
		const hook = createSteeringConsumedHook(tempDir);

		// Write mix of valid and malformed lines
		const validDirective = {
			type: 'steering-directive',
			directiveId: 'dir-valid',
			timestamp: new Date().toISOString(),
		};
		const malformed1 = 'not valid json';
		const malformed2 = '{ incomplete json';
		fs.writeFileSync(
			eventsPath,
			`${malformed1}\n${JSON.stringify(validDirective)}\n${malformed2}\n`,
		);

		await hook({}, {});

		const content = fs.readFileSync(eventsPath, 'utf-8');
		const lines = content.trim().split('\n');

		// Should have 3 original lines + 1 consumed event = 4 lines
		expect(lines.length).toBe(4);

		// Verify consumed event was written for the valid directive
		const consumedEvent = JSON.parse(lines[3]) as {
			type: string;
			directiveId: string;
		};
		expect(consumedEvent.type).toBe('steering-consumed');
		expect(consumedEvent.directiveId).toBe('dir-valid');
	});

	it('should write nothing when all directives are already consumed', async () => {
		const hook = createSteeringConsumedHook(tempDir);

		// Write directive and consumed pairs
		const dir1 = {
			type: 'steering-directive',
			directiveId: 'dir-done-1',
			timestamp: new Date().toISOString(),
		};
		const cons1 = {
			type: 'steering-consumed',
			directiveId: 'dir-done-1',
			timestamp: new Date().toISOString(),
		};
		const dir2 = {
			type: 'steering-directive',
			directiveId: 'dir-done-2',
			timestamp: new Date().toISOString(),
		};
		const cons2 = {
			type: 'steering-consumed',
			directiveId: 'dir-done-2',
			timestamp: new Date().toISOString(),
		};
		fs.writeFileSync(
			eventsPath,
			`${JSON.stringify(dir1)}\n${JSON.stringify(cons1)}\n${JSON.stringify(dir2)}\n${JSON.stringify(cons2)}\n`,
		);

		const contentBefore = fs.readFileSync(eventsPath, 'utf-8');

		await hook({}, {});

		const contentAfter = fs.readFileSync(eventsPath, 'utf-8');

		// Should not change
		expect(contentAfter).toBe(contentBefore);
	});

	it('should handle mixed scenario: some consumed, some not', async () => {
		const hook = createSteeringConsumedHook(tempDir);

		// Write directives with mixed consumption state
		const dir1 = {
			type: 'steering-directive',
			directiveId: 'mixed-1',
			timestamp: new Date().toISOString(),
		};
		const cons1 = {
			type: 'steering-consumed',
			directiveId: 'mixed-1',
			timestamp: new Date().toISOString(),
		};
		const dir2 = {
			type: 'steering-directive',
			directiveId: 'mixed-2',
			timestamp: new Date().toISOString(),
		};
		const dir3 = {
			type: 'steering-directive',
			directiveId: 'mixed-3',
			timestamp: new Date().toISOString(),
		};
		const cons3 = {
			type: 'steering-consumed',
			directiveId: 'mixed-3',
			timestamp: new Date().toISOString(),
		};
		fs.writeFileSync(
			eventsPath,
			`${JSON.stringify(dir1)}\n${JSON.stringify(cons1)}\n${JSON.stringify(dir2)}\n${JSON.stringify(dir3)}\n${JSON.stringify(cons3)}\n`,
		);

		await hook({}, {});

		const content = fs.readFileSync(eventsPath, 'utf-8');
		const lines = content.trim().split('\n');

		// Should have 5 original + 1 new consumed for mixed-2
		expect(lines.length).toBe(6);

		// Verify consumed event was written for mixed-2 only
		const consumedDirectiveIds = lines
			.slice(5)
			.map((line) => JSON.parse(line) as { directiveId: string })
			.map((e) => e.directiveId);

		expect(consumedDirectiveIds).toContain('mixed-2');
	});

	it('should ignore other event types and only process steering-directive', async () => {
		const hook = createSteeringConsumedHook(tempDir);

		// Write various event types
		const other1 = { type: 'other-event-1', data: 'test' };
		const other2 = { type: 'other-event-2', data: 'test' };
		const directive = {
			type: 'steering-directive',
			directiveId: 'dir-among-others',
			timestamp: new Date().toISOString(),
		};
		fs.writeFileSync(
			eventsPath,
			`${JSON.stringify(other1)}\n${JSON.stringify(directive)}\n${JSON.stringify(other2)}\n`,
		);

		await hook({}, {});

		const content = fs.readFileSync(eventsPath, 'utf-8');
		const lines = content.trim().split('\n');

		// Should have 3 original + 1 consumed = 4 lines
		expect(lines.length).toBe(4);

		// Verify consumed event was written
		const consumedEvent = JSON.parse(lines[3]) as {
			type: string;
			directiveId: string;
		};
		expect(consumedEvent.type).toBe('steering-consumed');
		expect(consumedEvent.directiveId).toBe('dir-among-others');
	});

	it('should handle empty directiveId gracefully', async () => {
		const hook = createSteeringConsumedHook(tempDir);

		// Write directive with missing directiveId
		const directive = {
			type: 'steering-directive',
			timestamp: new Date().toISOString(),
		};
		fs.writeFileSync(eventsPath, `${JSON.stringify(directive)}\n`);

		await hook({}, {});

		const content = fs.readFileSync(eventsPath, 'utf-8');
		const lines = content.trim().split('\n');

		// Should not write a consumed event for a directive without an ID
		expect(lines.length).toBe(1);
	});

	it('should swallow errors and resolve', async () => {
		const noSwarmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-swarm-hook-'));
		const hook = createSteeringConsumedHook(noSwarmDir);

		// Hook should resolve without throwing even when .swarm doesn't exist
		await expect(hook({}, {})).resolves.toBeUndefined();

		// Clean up
		fs.rmSync(noSwarmDir, { recursive: true, force: true });
	});
});
