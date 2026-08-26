import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripKnownSwarmPrefix } from '../../../src/config/schema';
import {
	type ContextEntry,
	filterByRole,
} from '../../../src/context/role-filter';
import { readCoreEvents } from '../../../src/events/core-events.js';
import { resetSwarmState } from '../../../src/state';

describe('filterByRole', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		// Create a temporary directory for event logging tests
		tempDir = path.join(
			process.cwd(),
			'tests',
			'unit',
			'context',
			'temp-test-' + Date.now(),
		);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		resetSwarmState();
		// Clean up temporary directory
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	describe('entries included for all agents', () => {
		it('includes entries with [FOR: ALL] tag for any agent', () => {
			const entries: ContextEntry[] = [
				{
					role: 'assistant',
					content: '[FOR: ALL] This is a global message for all agents',
				},
			];

			const result = filterByRole(entries, 'architect', tempDir);
			expect(result).toHaveLength(1);
			expect(result[0].content).toContain('global message');
		});

		it('includes [FOR: ALL] entries for reviewer agent', () => {
			const entries: ContextEntry[] = [
				{
					role: 'assistant',
					content: '[FOR: ALL] Important context for everyone',
				},
			];

			const result = filterByRole(entries, 'reviewer', tempDir);
			expect(result).toHaveLength(1);
		});

		it('includes [FOR: ALL] entries for test_engineer agent', () => {
			const entries: ContextEntry[] = [
				{
					role: 'assistant',
					content: '[FOR: ALL] Shared knowledge',
				},
			];

			const result = filterByRole(entries, 'test_engineer', tempDir);
			expect(result).toHaveLength(1);
		});
	});

	describe('entries included only for matching agent', () => {
		it('includes entries when target agent matches specific tag', () => {
			const entries: ContextEntry[] = [
				{
					role: 'assistant',
					content: '[FOR: coder] This is specifically for coders',
				},
			];

			const result = filterByRole(entries, 'coder', tempDir);
			expect(result).toHaveLength(1);
			expect(result[0].content).toContain('specifically for coders');
		});

		it('includes entries for multiple comma-separated agents', () => {
			const entries: ContextEntry[] = [
				{
					role: 'assistant',
					content: '[FOR: coder, reviewer] This is for code reviewers',
				},
			];

			const resultCoder = filterByRole(entries, 'coder', tempDir);
			expect(resultCoder).toHaveLength(1);

			const resultReviewer = filterByRole(entries, 'reviewer', tempDir);
			expect(resultReviewer).toHaveLength(1);
		});

		it('excludes entries when target agent does not match specific tag', () => {
			const entries: ContextEntry[] = [
				{
					role: 'assistant',
					content: '[FOR: coder] This is only for coders',
				},
			];

			const result = filterByRole(entries, 'architect', tempDir);
			expect(result).toHaveLength(0);
		});
	});

	describe('entries excluded for non-matching agents', () => {
		it('excludes coder-specific entries from architect', () => {
			const entries: ContextEntry[] = [
				{
					role: 'assistant',
					content: '[FOR: coder] Implementation details here',
				},
			];

			const result = filterByRole(entries, 'architect', tempDir);
			expect(result).toHaveLength(0);
		});

		it('excludes architect-specific entries from coder', () => {
			const entries: ContextEntry[] = [
				{
					role: 'assistant',
					content: '[FOR: architect] Design decisions here',
				},
			];

			const result = filterByRole(entries, 'coder', tempDir);
			expect(result).toHaveLength(0);
		});

		it('excludes reviewer-specific entries from test_engineer', () => {
			const entries: ContextEntry[] = [
				{
					role: 'assistant',
					content: '[FOR: reviewer] Review feedback here',
				},
			];

			const result = filterByRole(entries, 'test_engineer', tempDir);
			expect(result).toHaveLength(0);
		});
	});

	describe('untagged entries included for all (backward compat)', () => {
		it('includes entries without [FOR: ...] tag for all agents', () => {
			const entries: ContextEntry[] = [
				{
					role: 'assistant',
					content: 'This is a plain message without any tags',
				},
			];

			const resultArchitect = filterByRole(entries, 'architect', tempDir);
			expect(resultArchitect).toHaveLength(1);

			const resultCoder = filterByRole(entries, 'coder', tempDir);
			expect(resultCoder).toHaveLength(1);

			const resultReviewer = filterByRole(entries, 'reviewer', tempDir);
			expect(resultReviewer).toHaveLength(1);
		});

		it('includes mixed tagged and untagged entries correctly', () => {
			const entries: ContextEntry[] = [
				{
					role: 'assistant',
					content: '[FOR: architect] Architect-only info',
				},
				{
					role: 'assistant',
					content: 'Plain shared info',
				},
				{
					role: 'assistant',
					content: '[FOR: coder] Coder-only info',
				},
			];

			const resultArchitect = filterByRole(entries, 'architect', tempDir);
			expect(resultArchitect).toHaveLength(2); // architect-specific + untagged
			expect(
				resultArchitect.some((e) => e.content.includes('Architect-only')),
			).toBe(true);
			expect(
				resultArchitect.some((e) => e.content.includes('Plain shared')),
			).toBe(true);

			const resultCoder = filterByRole(entries, 'coder', tempDir);
			expect(resultCoder).toHaveLength(2); // coder-specific + untagged
		});
	});

	describe('case-insensitive agent matching', () => {
		it('matches agents case-insensitively', () => {
			const entries: ContextEntry[] = [
				{
					role: 'assistant',
					content: '[FOR: CODER] Uppercase agent tag',
				},
			];

			const result = filterByRole(entries, 'coder', tempDir);
			expect(result).toHaveLength(1);
		});

		it('matches target role case-insensitively', () => {
			const entries: ContextEntry[] = [
				{
					role: 'assistant',
					content: '[FOR: coder] Lowercase agent tag',
				},
			];

			const result = filterByRole(entries, 'CODER', tempDir);
			expect(result).toHaveLength(1);
		});

		it('matches mixed case correctly', () => {
			const entries: ContextEntry[] = [
				{
					role: 'assistant',
					content: '[FOR: Test_Engineer] Mixed case tag',
				},
			];

			const result = filterByRole(entries, 'test_engineer', tempDir);
			expect(result).toHaveLength(1);
		});
	});

	describe('stripKnownSwarmPrefix() used', () => {
		it('mega_coder matches coder via stripKnownSwarmPrefix', () => {
			const entries: ContextEntry[] = [
				{
					role: 'assistant',
					content: '[FOR: coder] Coder task',
				},
			];

			const result = filterByRole(entries, 'mega_coder', tempDir);
			expect(result).toHaveLength(1);
		});

		it('local_coder matches coder', () => {
			const entries: ContextEntry[] = [
				{
					role: 'assistant',
					content: '[FOR: coder] Code implementation',
				},
			];

			const result = filterByRole(entries, 'local_coder', tempDir);
			expect(result).toHaveLength(1);
		});

		it('paid_reviewer matches reviewer', () => {
			const entries: ContextEntry[] = [
				{
					role: 'assistant',
					content: '[FOR: reviewer] Review task',
				},
			];

			const result = filterByRole(entries, 'paid_reviewer', tempDir);
			expect(result).toHaveLength(1);
		});

		it('cloud_architect matches architect', () => {
			const entries: ContextEntry[] = [
				{
					role: 'assistant',
					content: '[FOR: architect] Architecture task',
				},
			];

			const result = filterByRole(entries, 'cloud_architect', tempDir);
			expect(result).toHaveLength(1);
		});

		it('prefixed agents can target specific base agents', () => {
			// When entry is tagged for coder, mega_coder should receive it
			const entries: ContextEntry[] = [
				{
					role: 'assistant',
					content: '[FOR: coder] Implementation for coders',
				},
			];

			const resultMegaCoder = filterByRole(entries, 'mega_coder', tempDir);
			expect(resultMegaCoder).toHaveLength(1);

			const resultLocalCoder = filterByRole(entries, 'local_coder', tempDir);
			expect(resultLocalCoder).toHaveLength(1);
		});
	});

	describe('system prompts never filtered', () => {
		it('system prompts are never filtered regardless of tags', () => {
			const entries: ContextEntry[] = [
				{
					role: 'system',
					content: '[FOR: architect] System prompt for architect only',
				},
				{
					role: 'system',
					content: 'Plain system prompt',
				},
			];

			const result = filterByRole(entries, 'coder', tempDir);
			expect(result).toHaveLength(2); // Both system prompts should be included
		});

		it('system prompts with [FOR: coder] still included for architect', () => {
			const entries: ContextEntry[] = [
				{
					role: 'system',
					content: '[FOR: coder] This says coder but system never filtered',
				},
			];

			const result = filterByRole(entries, 'architect', tempDir);
			expect(result).toHaveLength(1);
		});
	});

	describe('user entries with delegation envelopes never filtered', () => {
		it('user entries with delegation envelopes are never filtered', () => {
			const entries: ContextEntry[] = [
				{
					role: 'user',
					content: `taskId: 1.1
targetAgent: coder
action: implement
commandType: task
files: src/auth.ts
acceptanceCriteria: User can login
technicalContext: Using Express.js`,
				},
			];

			const result = filterByRole(entries, 'architect', tempDir);
			expect(result).toHaveLength(1);
		});

		it('delegation envelope user entry with [FOR: OTHER] tag still included', () => {
			const entries: ContextEntry[] = [
				{
					role: 'user',
					content: `[FOR: architect]
taskId: 1.1
targetAgent: coder
action: implement
commandType: task
files: src/main.ts, src/utils.ts
acceptanceCriteria: Feature works correctly`,
				},
			];

			const result = filterByRole(entries, 'reviewer', tempDir);
			// Should be included because it has a valid delegation envelope (user role, never filtered)
			expect(result).toHaveLength(1);
		});
	});

	describe('assistant entries with plan/knowledge content never filtered', () => {
		it('assistant entries with plan references are never filtered', () => {
			const entries: ContextEntry[] = [
				{
					role: 'assistant',
					content: `[FOR: architect]
Please check .swarm/plan.md for current tasks.`,
				},
			];

			const result = filterByRole(entries, 'coder', tempDir);
			expect(result).toHaveLength(1);
		});

		it('assistant entries with context references are never filtered', () => {
			const entries: ContextEntry[] = [
				{
					role: 'assistant',
					content: `[FOR: reviewer]
Review the .swarm/context for session history.`,
				},
			];

			const result = filterByRole(entries, 'test_engineer', tempDir);
			expect(result).toHaveLength(1);
		});

		it('assistant entries with knowledge references are never filtered', () => {
			const entries: ContextEntry[] = [
				{
					role: 'assistant',
					content: `[FOR: architect]
Check the knowledge base for similar issues.`,
				},
			];

			const result = filterByRole(entries, 'coder', tempDir);
			expect(result).toHaveLength(1);
		});

		it('assistant entries with swarm knowledge references are never filtered', () => {
			const entries: ContextEntry[] = [
				{
					role: 'assistant',
					content: `[FOR: coder]
This is documented in swarm knowledge base.`,
				},
			];

			const result = filterByRole(entries, 'reviewer', tempDir);
			expect(result).toHaveLength(1);
		});
	});

	describe('context_filtered event logged', () => {
		const readContextFilteredEvent = (dir: string): Record<string, unknown> =>
			JSON.parse(readCoreEvents(dir).text.trim());
		it('logs context_filtered event to events.jsonl', () => {
			const entries: ContextEntry[] = [
				{
					role: 'assistant',
					content: '[FOR: architect] Architect-only info',
				},
				{
					role: 'assistant',
					content: 'Plain shared info',
				},
			];

			filterByRole(entries, 'coder', tempDir);

			const eventsPath = path.join(tempDir, '.swarm', 'events.jsonl');
			expect(fs.existsSync(eventsPath)).toBe(true);

			const event = readContextFilteredEvent(tempDir);

			expect(event.event).toBe('context_filtered');
			expect(event.agentName).toBe('coder');
			expect(event.totalEntries).toBe(2);
			expect(event.includedEntries).toBe(1); // Only untagged entry for coder
			expect(event.filteredEntries).toBe(1);
		});

		it('logs event with correct agent name', () => {
			const entries: ContextEntry[] = [
				{
					role: 'assistant',
					content: 'Test content',
				},
			];

			filterByRole(entries, 'mega_coder', tempDir);

			const eventsPath = path.join(tempDir, '.swarm', 'events.jsonl');
			const event = readContextFilteredEvent(tempDir);

			expect(event.agentName).toBe('mega_coder');
		});

		it('logs event with estimated tokens saved', () => {
			const entries: ContextEntry[] = [
				{
					role: 'assistant',
					content: '[FOR: architect] Should be filtered for coder',
				},
			];

			filterByRole(entries, 'coder', tempDir);

			const eventsPath = path.join(tempDir, '.swarm', 'events.jsonl');
			const event = readContextFilteredEvent(tempDir);

			expect(event.estimatedTokensSaved).toBe(100); // 1 filtered * 100
		});
	});

	describe('edge cases', () => {
		it('returns empty array for empty entries', () => {
			const result = filterByRole([], 'coder', tempDir);
			expect(result).toEqual([]);
		});

		it('returns empty array for undefined entries', () => {
			const result = filterByRole(undefined as any, 'coder', tempDir);
			expect(result).toEqual([]);
		});

		it('handles entries with empty content', () => {
			const entries: ContextEntry[] = [
				{
					role: 'assistant',
					content: '',
				},
			];

			const result = filterByRole(entries, 'coder', tempDir);
			// Empty content has no [FOR: ...] tag, so should be included
			expect(result).toHaveLength(1);
		});

		it('handles whitespace-only [FOR: ...] tag', () => {
			const entries: ContextEntry[] = [
				{
					role: 'assistant',
					content: '[FOR: ] Empty agent list',
				},
			];

			const result = filterByRole(entries, 'coder', tempDir);
			// Empty agent list should result in no matches
			expect(result).toHaveLength(0);
		});

		it('handles tag not at beginning of content (treated as untagged)', () => {
			const entries: ContextEntry[] = [
				{
					role: 'assistant',
					content: 'Some prefix text [FOR: coder] after prefix',
				},
			];

			const result = filterByRole(entries, 'coder', tempDir);
			// Tag not at beginning is treated as untagged (backward compat)
			expect(result).toHaveLength(1);
		});

		it('handles multiple tags in content (first one wins)', () => {
			const entries: ContextEntry[] = [
				{
					role: 'assistant',
					content: '[FOR: architect] First tag [FOR: coder] Second tag',
				},
			];

			const resultCoder = filterByRole(entries, 'coder', tempDir);
			expect(resultCoder).toHaveLength(0); // First tag is architect

			const resultArchitect = filterByRole(entries, 'architect', tempDir);
			expect(resultArchitect).toHaveLength(1);
		});
	});

	describe('filtering with user role (non-delegation)', () => {
		it('user entries without delegation envelope follow normal filtering', () => {
			const entries: ContextEntry[] = [
				{
					role: 'user',
					content: '[FOR: architect] User message for architect only',
				},
			];

			const result = filterByRole(entries, 'coder', tempDir);
			// User entry without delegation envelope should be filtered normally
			expect(result).toHaveLength(0);
		});
	});
});
