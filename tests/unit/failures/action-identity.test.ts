import { describe, expect, test } from 'bun:test';
import { createActionIdentity } from '../../../src/failures/action-identity';

describe('createActionIdentity', () => {
	test('distinguishes missing versus empty fields and keeps raw task ids out of the pattern', () => {
		const missing = createActionIdentity({
			tool: 'Task',
			args: { subagent_type: 'coder' },
		});
		const empty = createActionIdentity({
			tool: 'Task',
			args: {
				subagent_type: 'coder',
				taskId: '   ',
				phase: '',
				background: null,
			},
		});

		expect(missing.taskMarker).toBe('missing');
		expect(empty.taskMarker).toBe('empty');
		expect(missing.phaseMarker).toBe('missing');
		expect(empty.phaseMarker).toBe('empty');
		expect(missing.pattern).not.toContain('task-1');
		expect(empty.pattern).not.toContain('task-1');
		expect(missing.pattern).toMatch(/^task:coder:task-missing:/);
		expect(empty.pattern).toMatch(/^task:coder:task-empty:/);
	});

	test('normalizes prefixed swarm roles and hashes additional values deterministically', () => {
		const first = createActionIdentity({
			tool: 'Task',
			args: {
				subagent_type: 'mega_coder',
				taskId: '1.2',
				prompt: 'deploy the thing',
				url: 'https://user:secret@example.com/private?token=abc',
				metadata: { b: 2, a: 1 },
			},
		});
		const reordered = createActionIdentity({
			tool: 'Task',
			args: {
				metadata: { a: 1, b: 2 },
				url: 'https://user:secret@example.com/private?token=abc',
				prompt: 'deploy the thing',
				taskId: '1.2',
				subagent_type: 'mega_coder',
			},
		});
		const changedPrompt = createActionIdentity({
			tool: 'Task',
			args: {
				subagent_type: 'mega_coder',
				taskId: '1.2',
				prompt: 'deploy something else',
				url: 'https://user:secret@example.com/private?token=abc',
				metadata: { a: 1, b: 2 },
			},
		});

		expect(first.role).toBe('coder');
		expect(first.swarm).toBe('mega');
		expect(first.additionalDigest).toBe(reordered.additionalDigest);
		expect(first.digest).toBe(reordered.digest);
		expect(first.additionalDigest).not.toBe(changedPrompt.additionalDigest);
		expect(first.pattern).not.toContain('deploy the thing');
		expect(first.pattern).not.toContain('secret@example.com');
	});

	test('captures parent identity, generation, mode, background, and scope state', () => {
		const identity = createActionIdentity({
			tool: 'Task',
			args: {
				subagent_type: 'coder',
				taskId: '1.4',
				parentSessionID: 'ses_123',
				parentInvocationID: 9,
				dispatchGeneration: 'g-22',
				mode: 'review',
				background: true,
				working_directory: 'packages/app',
				files: ['src/a.ts', 'src/b.ts'],
			},
		});

		expect(identity.parentSessionMarker).toBe('value');
		expect(identity.parentSessionDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(identity.parentInvocation).toBe('9');
		expect(identity.dispatchGeneration).toBe('g-22');
		expect(identity.mode).toBe('review');
		expect(identity.background).toBe(true);
		expect(identity.scopeMarker).toBe('value');
		expect(identity.scopeDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(identity.pattern).toContain('gen-value-');
		expect(identity.pattern).toContain('bg-value-');
	});

	test('collapses oversized and malformed values into typed sentinels', () => {
		const oversized = createActionIdentity({
			tool: 'Task',
			args: {
				subagent_type: 'coder',
				taskId: 'x'.repeat(256),
				generation: { bad: true },
				background: 'maybe',
			},
		});

		expect(oversized.taskId).toMatch(/^oversized:/);
		expect(oversized.dispatchGeneration).toBe('invalid:object');
		expect(oversized.backgroundMarker).toBe('invalid');
	});
});
