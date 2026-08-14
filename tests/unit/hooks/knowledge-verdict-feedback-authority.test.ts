import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyKnowledgeVerdictFeedback } from '../../../src/hooks/knowledge-events.js';
import {
	commitDisplayedMembership,
	validateAndCommitTerminalBatch,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import {
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store.js';

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'verdict-feedback-authority-'));
	mkdirSync(join(directory, '.git'));
	mkdirSync(join(directory, '.swarm'));
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

async function seedKnowledge(lesson: string): Promise<string> {
	const entryId = randomUUID();
	writeFileSync(
		resolveSwarmKnowledgePath(directory),
		`${JSON.stringify({
			id: entryId,
			lesson,
			category: 'lesson',
			status: 'active',
			confidence: 0.5,
			tags: [],
			scope: 'global',
			confirmed_by: [],
			project_name: 'test',
		})}\n`,
	);
	return entryId;
}

async function commitTerminal(
	entryId: string,
	traceId: string,
	outcome: 'applied' | 'violated',
	eventId: string,
): Promise<void> {
	const displayed = await commitDisplayedMembership(directory, {
		trace_id: traceId,
		session_id: 'session-1',
		agent: 'architect',
		entries: [{ entry_id: entryId, critical: false }],
	});
	expect(displayed.ok).toBe(true);
	const terminal = await validateAndCommitTerminalBatch(directory, {
		trace_id: traceId,
		session_id: 'session-1',
		items: [{ entry_id: entryId, outcome, event_id: eventId }],
	});
	expect(terminal.ok).toBe(true);
}

async function confidence(entryId: string): Promise<number | undefined> {
	const entries = await readKnowledge<{ id: string; confidence: number }>(
		resolveSwarmKnowledgePath(directory),
	);
	return entries.find((entry) => entry.id === entryId)?.confidence;
}

describe('authoritative knowledge verdict feedback', () => {
	test('replaying the returned checkpoint applies no duplicate confidence bump', async () => {
		const entryId = await seedKnowledge('checkpoint is exactly once');
		await commitTerminal(entryId, randomUUID(), 'applied', 'terminal-1');

		const first = await applyKnowledgeVerdictFeedback(directory);
		const replay = await applyKnowledgeVerdictFeedback(directory, {
			sinceTimestamp: first.lastProcessedTimestamp,
			sinceEventId: first.lastProcessedEventId,
		});

		expect(replay).toEqual({ processed: 0, bumps: 0 });
		expect(await confidence(entryId)).toBeCloseTo(0.53);
	});

	test('a lost projection checkpoint cannot apply a committed terminal twice', async () => {
		const entryId = await seedKnowledge('entry-local cursor is atomic');
		await commitTerminal(
			entryId,
			randomUUID(),
			'applied',
			'terminal-after-projection-crash',
		);

		expect((await applyKnowledgeVerdictFeedback(directory)).bumps).toBe(1);
		expect((await applyKnowledgeVerdictFeedback(directory)).bumps).toBe(0);
		expect(await confidence(entryId)).toBeCloseTo(0.53);
	});

	test('authorized remediation preserves prior violation and current applied feedback', async () => {
		const entryId = await seedKnowledge('history survives remediation');
		const traceId = randomUUID();
		await commitTerminal(entryId, traceId, 'violated', 'prior-violation');
		const remediated = await validateAndCommitTerminalBatch(directory, {
			trace_id: traceId,
			session_id: 'session-1',
			items: [
				{
					entry_id: entryId,
					outcome: 'applied',
					event_id: 'authorized-applied',
				},
			],
			authorization: {
				actor: 'reviewer-remediation',
				reason: 'verified after remediation',
				expected_event_id: 'prior-violation',
				expected_outcome: 'violated',
			},
		});
		expect(remediated.ok).toBe(true);

		const result = await applyKnowledgeVerdictFeedback(directory);
		expect(result.processed).toBe(1);
		expect(await confidence(entryId)).toBeCloseTo(0.45);
	});
});
