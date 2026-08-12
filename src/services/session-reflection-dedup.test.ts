/**
 * Tests for near-duplicate candidate detection in session reflection (FR-003, FR-012).
 *
 * Exercises gatherNearDuplicateCandidates via _internals DI seam.
 * Sibling file: session-reflection-issues.test.ts (FR-006 tests).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SwarmKnowledgeEntry } from '../hooks/knowledge-types';
import { _internals, runSessionReflection } from './session-reflection';

function emptyToolAggregates() {
	return new Map<
		string,
		{
			tool: string;
			count: number;
			successCount: number;
			failureCount: number;
			totalDuration: number;
		}
	>();
}

function emptyAgentSessions() {
	return new Map<
		string,
		{ agentName: string; lastDelegationReason?: string }
	>();
}

/** Minimal SwarmKnowledgeEntry shape for JSONL. */
interface TestKnowledgeEntry {
	id: string;
	tier: 'swarm';
	lesson: string;
	category: string;
	tags: string[];
	scope: string;
	confidence: number;
	status: string;
	created_at: string;
	confirmed_by: [];
	project_name: string;
}

function makeEntry(
	overrides: Partial<TestKnowledgeEntry> & { id: string; lesson: string },
): string {
	const entry: TestKnowledgeEntry = {
		tier: 'swarm',
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.5,
		status: 'candidate',
		created_at: new Date().toISOString(),
		confirmed_by: [],
		project_name: 'test',
		...overrides,
	};
	return JSON.stringify(entry);
}

describe('session-reflection — near-duplicate candidates (FR-003)', () => {
	let tempDir: string;
	let swarmDir: string;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `reflect-dedup-${Date.now()}`);
		await mkdir(tempDir, { recursive: true });
		swarmDir = path.join(tempDir, '.swarm');
		await mkdir(swarmDir, { recursive: true });
	});

	afterEach(() => {
		const { rmSync } = require('node:fs');
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('returns candidate pair when session entry near-duplicates existing entry', async () => {
		const now = new Date().toISOString();
		const entries = [
			makeEntry({
				id: 'e1',
				lesson: 'Always use path.join for cross-platform paths',
				created_at: '2025-01-01T00:00:00.000Z',
			}),
			makeEntry({
				id: 'e2',
				lesson: 'Always use path.join() for cross-platform file paths',
				created_at: now,
			}),
		];
		await appendFile(
			path.join(swarmDir, 'knowledge.jsonl'),
			entries.join('\n') + '\n',
		);

		const result = await runSessionReflection({
			directory: tempDir,
			toolAggregates: emptyToolAggregates(),
			agentSessions: emptyAgentSessions(),
			delegate: undefined,
			sessionStart: now,
			dedupThreshold: 0.5,
		});

		expect(result.data.nearDuplicateCandidates.length).toBeGreaterThanOrEqual(
			1,
		);
		const candidate = result.data.nearDuplicateCandidates[0];
		expect(candidate.sessionEntryText).toBeDefined();
		expect(candidate.existingEntryText).toBeDefined();
		expect(candidate.existingEntryId).toBeDefined();
		expect(candidate.sessionEntryText.length).toBeGreaterThan(0);
		expect(candidate.existingEntryText.length).toBeGreaterThan(0);
	});

	test('returns empty array when no near-duplicates exist', async () => {
		const entries = [
			makeEntry({
				id: 'e1',
				lesson: 'Use path.join for cross-platform paths',
				created_at: '2025-01-01T00:00:00.000Z',
			}),
			makeEntry({
				id: 'e2',
				lesson: 'Run tests after every code change for safety',
				created_at: new Date().toISOString(),
			}),
		];
		await appendFile(
			path.join(swarmDir, 'knowledge.jsonl'),
			entries.join('\n') + '\n',
		);

		const result = await runSessionReflection({
			directory: tempDir,
			toolAggregates: emptyToolAggregates(),
			agentSessions: emptyAgentSessions(),
			delegate: undefined,
			sessionStart: new Date().toISOString(),
			dedupThreshold: 0.8,
		});

		expect(result.data.nearDuplicateCandidates).toEqual([]);
	});

	test('fail-open: returns empty array when knowledge store is unreadable', async () => {
		const result = await runSessionReflection({
			directory: tempDir,
			toolAggregates: emptyToolAggregates(),
			agentSessions: emptyAgentSessions(),
			delegate: undefined,
			dedupThreshold: 0.6,
		});

		expect(result.data.nearDuplicateCandidates).toEqual([]);
	});

	test('threshold from input is used for comparison', async () => {
		const now = new Date().toISOString();
		const entries = [
			makeEntry({
				id: 'e1',
				lesson: 'Prefer early returns over deeply nested conditionals',
				created_at: '2025-01-01T00:00:00.000Z',
			}),
			makeEntry({
				id: 'e2',
				lesson: 'Prefer early returns over deeply nested conditions',
				created_at: now,
			}),
		];
		await appendFile(
			path.join(swarmDir, 'knowledge.jsonl'),
			entries.join('\n') + '\n',
		);

		const lowThresholdResult = await runSessionReflection({
			directory: tempDir,
			toolAggregates: emptyToolAggregates(),
			agentSessions: emptyAgentSessions(),
			delegate: undefined,
			sessionStart: now,
			dedupThreshold: 0.3,
		});

		const highThresholdResult = await runSessionReflection({
			directory: tempDir,
			toolAggregates: emptyToolAggregates(),
			agentSessions: emptyAgentSessions(),
			delegate: undefined,
			sessionStart: now,
			dedupThreshold: 0.99,
		});

		expect(
			lowThresholdResult.data.nearDuplicateCandidates.length,
		).toBeGreaterThanOrEqual(1);
		expect(highThresholdResult.data.nearDuplicateCandidates).toEqual([]);
	});

	test('defaults nearDuplicateCandidates to empty when dedupThreshold is absent', async () => {
		const result = await runSessionReflection({
			directory: tempDir,
			toolAggregates: emptyToolAggregates(),
			agentSessions: emptyAgentSessions(),
			delegate: undefined,
		});

		expect(result.data.nearDuplicateCandidates).toBeDefined();
		expect(Array.isArray(result.data.nearDuplicateCandidates)).toBe(true);
	});
});

describe('session-reflection — gatherNearDuplicateCandidates via _internals', () => {
	let tempDir: string;
	let swarmDir: string;
	const originalGather = _internals.gatherNearDuplicateCandidates;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `reflect-dedup-internals-${Date.now()}`);
		await mkdir(tempDir, { recursive: true });
		swarmDir = path.join(tempDir, '.swarm');
		await mkdir(swarmDir, { recursive: true });
	});

	afterEach(() => {
		const { rmSync } = require('node:fs');
		rmSync(tempDir, { recursive: true, force: true });
		_internals.gatherNearDuplicateCandidates = originalGather;
	});

	test('zero writes: gatherNearDuplicateCandidates does not modify knowledge.jsonl', async () => {
		const now = new Date().toISOString();
		const entries = [
			makeEntry({
				id: 'e1',
				lesson: 'Always use path.join for cross-platform paths',
				created_at: '2025-01-01T00:00:00.000Z',
			}),
			makeEntry({
				id: 'e2',
				lesson: 'Always use path.join() for cross-platform file paths',
				created_at: now,
			}),
		];
		const knowledgePath = path.join(swarmDir, 'knowledge.jsonl');
		await writeFile(knowledgePath, entries.join('\n') + '\n');

		const beforeContent = await readFile(knowledgePath, 'utf-8');

		await _internals.gatherNearDuplicateCandidates(tempDir, now, 0.5);

		const afterContent = await readFile(knowledgePath, 'utf-8');
		expect(afterContent).toBe(beforeContent);
	});

	test('per-entry fail-open: injected findActiveSwarmNearDuplicate throw on first entry does not abort scan', async () => {
		const originalDetector = _internals.findActiveSwarmNearDuplicate;
		let callCount = 0;

		const mockDetector = (
			_lesson: string,
			_entries: SwarmKnowledgeEntry[],
			_threshold: number,
		): SwarmKnowledgeEntry | undefined => {
			callCount++;
			if (callCount === 1)
				throw new Error('injected per-entry comparison failure');
			return {
				id: 'existing-1',
				lesson: 'Always use path.join() for cross-platform file paths',
				tier: 'swarm',
				category: 'process',
				tags: [],
				scope: 'global',
				confidence: 0.5,
				status: 'candidate',
				created_at: '2025-01-01T00:00:00.000Z',
				confirmed_by: [],
				project_name: 'test',
			} satisfies SwarmKnowledgeEntry;
		};

		_internals.findActiveSwarmNearDuplicate = mockDetector;
		afterEach(() => {
			_internals.findActiveSwarmNearDuplicate = originalDetector;
		});

		const now = new Date().toISOString();
		await appendFile(
			path.join(swarmDir, 'knowledge.jsonl'),
			[
				makeEntry({
					id: 'existing-1',
					lesson: 'Always use path.join() for cross-platform file paths',
					created_at: '2025-01-01T00:00:00.000Z',
				}),
				makeEntry({
					id: 's1',
					lesson: 'Always use path.join for cross-platform paths',
					created_at: now,
				}),
				makeEntry({
					id: 's2',
					lesson: 'A very different lesson about something else entirely',
					created_at: now,
				}),
			].join('\n') + '\n',
		);

		const result = await runSessionReflection({
			directory: tempDir,
			toolAggregates: emptyToolAggregates(),
			agentSessions: emptyAgentSessions(),
			delegate: undefined,
			sessionStart: now,
			dedupThreshold: 0.4,
		});

		expect(result.data.nearDuplicateCandidates).toHaveLength(1);
		const candidate = result.data.nearDuplicateCandidates[0]!;
		expect(candidate.sessionEntryText).toBe(
			'A very different lesson about something else entirely',
		);
		expect(candidate.existingEntryId).toBe('existing-1');
	});
});
