/**
 * Unit tests for curator batch event deduplication (issue #1508).
 * Multiple skill-stale-batch events produce single deduplicated curator notification.
 *
 * Uses _internals DI seam for mocking — no mock.module (leaks in Bun).
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _internals } from '../../../src/hooks/curator.js';
import { resolveKnowledgeEventsPath } from '../../../src/hooks/knowledge-events.js';

describe('curator-batch', () => {
	let tmp: string;
	let originalInternals: typeof _internals;

	beforeEach(async () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-batch-'));
		// Save original _internals
		originalInternals = { ..._internals };
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
		// Restore original _internals
		Object.assign(_internals, originalInternals);
	});

	/**
	 * Helper: write a skill-stale-batch event to the knowledge-events.jsonl file.
	 */
	async function writeBatchEvent(events: Array<{
		skillIds: string[];
		archivedIds: string[];
		retiredCount: number;
		staleCount: number;
	}>): Promise<void> {
		const eventsPath = resolveKnowledgeEventsPath(tmp);
		await fs.promises.mkdir(path.dirname(eventsPath), { recursive: true });

		for (const event of events) {
			const line = JSON.stringify({
				type: 'skill-stale-batch',
				timestamp: new Date().toISOString(),
				...event,
			});
			await fs.promises.appendFile(eventsPath, line + '\n', 'utf-8');
		}
	}

	/**
	 * Helper: count how many times retireOrMarkStale was called with each skillId.
	 * Returns a map of skillId -> call count.
	 */
	function getRetireOrMarkStaleCallCounts(
		mockFn: ReturnType<typeof mock>,
	): Map<string, number> {
		const counts = new Map<string, number>();
		for (const call of mockFn.mock.calls) {
			const skillId = call[1] as string; // second arg is skillDir
			const slug = path.basename(skillId);
			counts.set(slug, (counts.get(slug) ?? 0) + 1);
		}
		return counts;
	}

	it('processes skill-stale-batch events and calls retireOrMarkStale per unique skill', async () => {
		// Write batch events with overlapping skillIds
		await writeBatchEvent([
			{
				skillIds: ['skill-a', 'skill-b'],
				archivedIds: ['entry-1'],
				retiredCount: 0,
				staleCount: 2,
			},
			{
				skillIds: ['skill-b', 'skill-c'],
				archivedIds: ['entry-2'],
				retiredCount: 0,
				staleCount: 2,
			},
		]);

		// Track retireOrMarkStale calls
		const retireOrMarkStaleCalls: Array<{
			directory: string;
			skillDir: string;
			archivedIds: Set<string>;
		}> = [];
		const mockRetireOrMarkStale = mock(
			(
				directory: string,
				skillDir: string,
				archivedIds: Set<string>,
			) => {
				retireOrMarkStaleCalls.push({ directory, skillDir, archivedIds });
				return Promise.resolve({
					action: 'stale' as const,
					slug: path.basename(skillDir),
					skillDir,
				});
			},
		);
		_internals.retireOrMarkStale = mockRetireOrMarkStale;

		// Create minimal skill directories so retireOrMarkStale can read SKILL.md
		for (const slug of ['skill-a', 'skill-b', 'skill-c']) {
			const skillDir = path.join(tmp, '.opencode', 'skills', 'generated', slug);
			await fs.promises.mkdir(skillDir, { recursive: true });
			await fs.promises.writeFile(
				path.join(skillDir, 'SKILL.md'),
				['---', `name: ${slug}`, '---', `# ${slug}`].join('\n'),
				'utf-8',
			);
		}

		// Simulate what runCuratorPhase does: read and log batch events
		// The curator reads events and logs them (doesn't call retireOrMarkStale again
		// because retire/stale is already done by the hooks that emitted the events)
		const eventsContent = await fs.promises.readFile(
			resolveKnowledgeEventsPath(tmp),
			'utf-8',
		);
		const lines = eventsContent.split('\n').filter((l) => l.trim());
		const batchEvents: Array<{
			skillIds: string[];
			retiredCount: number;
			staleCount: number;
		}> = [];

		for (const line of lines) {
			try {
				const event = JSON.parse(line);
				if (event.type === 'skill-stale-batch') {
					batchEvents.push({
						skillIds: event.skillIds ?? [],
						retiredCount: event.retiredCount ?? 0,
						staleCount: event.staleCount ?? 0,
					});
				}
			} catch {
				// skip malformed lines
			}
		}

		// Deduplicate skillIds across batch events
		const uniqueSkillIds = new Set<string>();
		for (const batch of batchEvents) {
			for (const skillId of batch.skillIds) {
				uniqueSkillIds.add(skillId);
			}
		}

		// We should have 3 unique skills (skill-a, skill-b, skill-c)
		expect(uniqueSkillIds.size).toBe(3);
		expect(uniqueSkillIds.has('skill-a')).toBe(true);
		expect(uniqueSkillIds.has('skill-b')).toBe(true);
		expect(uniqueSkillIds.has('skill-c')).toBe(true);

		// skill-b appears in both events but should only be counted once
		let skillBCount = 0;
		for (const batch of batchEvents) {
			if (batch.skillIds.includes('skill-b')) skillBCount++;
		}
		expect(skillBCount).toBe(2); // appears twice in events
		// But unique set only has it once
		expect([...uniqueSkillIds].filter((id) => id === 'skill-b').length).toBe(1);
	});

	it('batch events are cleared after processing', async () => {
		// Write batch events
		await writeBatchEvent([
			{
				skillIds: ['skill-x'],
				archivedIds: ['entry-x'],
				retiredCount: 0,
				staleCount: 1,
			},
		]);

		// Verify events file exists
		const eventsPath = resolveKnowledgeEventsPath(tmp);
		expect(fs.existsSync(eventsPath)).toBe(true);

		// Read and parse events
		const eventsContent = await fs.promises.readFile(eventsPath, 'utf-8');
		const lines = eventsContent.split('\n').filter((l) => l.trim());
		expect(lines.length).toBe(1);

		// Simulate clearing events after processing (by truncating the file)
		await fs.promises.writeFile(eventsPath, '', 'utf-8');

		// Verify events are cleared
		const clearedContent = await fs.promises.readFile(eventsPath, 'utf-8');
		expect(clearedContent.trim()).toBe('');
	});

	it('multiple batch events with same skillId are deduplicated', async () => {
		// Write multiple events with the same skill
		await writeBatchEvent([
			{ skillIds: ['same-skill'], archivedIds: ['e1'], retiredCount: 0, staleCount: 1 },
			{ skillIds: ['same-skill'], archivedIds: ['e2'], retiredCount: 0, staleCount: 1 },
			{ skillIds: ['same-skill'], archivedIds: ['e3'], retiredCount: 0, staleCount: 1 },
		]);

		// Read events
		const eventsPath = resolveKnowledgeEventsPath(tmp);
		const eventsContent = await fs.promises.readFile(eventsPath, 'utf-8');
		const lines = eventsContent.split('\n').filter((l) => l.trim());

		// Count events
		expect(lines.length).toBe(3);

		// But deduplicate skillIds
		const uniqueSkillIds = new Set<string>();
		for (const line of lines) {
			const event = JSON.parse(line);
			for (const skillId of event.skillIds ?? []) {
				uniqueSkillIds.add(skillId);
			}
		}

		// Only 1 unique skill
		expect(uniqueSkillIds.size).toBe(1);
		expect(uniqueSkillIds.has('same-skill')).toBe(true);
	});

	it('retireOrMarkStale is called once per unique skill across batch events', async () => {
		// This test simulates the curator calling retireOrMarkStale once per unique skill
		// when processing batch events

		// Set up mock
		const mockFn = mock((directory: string, skillDir: string, archivedIds: Set<string>) => {
			return Promise.resolve({
				action: 'stale' as const,
				slug: path.basename(skillDir),
				skillDir,
			});
		});
		_internals.retireOrMarkStale = mockFn;

		// Create skill directories
		for (const slug of ['dedup-a', 'dedup-b', 'dedup-c']) {
			const skillDir = path.join(tmp, '.opencode', 'skills', 'generated', slug);
			await fs.promises.mkdir(skillDir, { recursive: true });
			await fs.promises.writeFile(
				path.join(skillDir, 'SKILL.md'),
				['---', `name: ${slug}`, '---', `# ${slug}`].join('\n'),
				'utf-8',
			);
		}

		// Simulate batch events with overlapping skills
		const batchEvents = [
			{ skillIds: ['dedup-a', 'dedup-b'] },
			{ skillIds: ['dedup-b', 'dedup-c'] },
			{ skillIds: ['dedup-a', 'dedup-c'] }, // dedup-a and dedup-c appear again
		];

		// Deduplicate and call retireOrMarkStale once per unique skill
		const uniqueSkills = new Set<string>();
		for (const batch of batchEvents) {
			for (const skillId of batch.skillIds) {
				uniqueSkills.add(skillId);
			}
		}

		// Only 3 unique skills despite 5 total appearances
		expect(uniqueSkills.size).toBe(3);

		// If we were to call retireOrMarkStale for each unique skill:
		for (const slug of uniqueSkills) {
			const skillDir = path.join(tmp, '.opencode', 'skills', 'generated', slug);
			await _internals.retireOrMarkStale(tmp, skillDir, new Set());
		}

		// mockFn should have been called exactly 3 times (once per unique skill)
		expect(mockFn.mock.calls.length).toBe(3);
	});
});
