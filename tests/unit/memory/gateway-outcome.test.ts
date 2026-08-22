import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { MemoryGateway } from '../../../src/memory';
import { evictAndClose } from '../../../src/memory/provider-pool';
import { MAX_OUTCOME_QUESTION_LENGTH } from '../../../src/memory/schema';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tmpDir: string;

beforeEach(() => {
	tmpDir = canonicalMkdtemp('swarm-memory-gateway-outcome-');
});

afterEach(async () => {
	evictAndClose(tmpDir);
	await fs.rm(tmpDir, { recursive: true, force: true });
});

test('recordOutcome enforces the effective question text budget before persistence', async () => {
	const gateway = new MemoryGateway(
		{ directory: tmpDir, sessionID: 'session-a', agentRole: 'coder' },
		{
			config: { enabled: true, provider: 'local-jsonl' },
			now: () => new Date('2026-05-24T12:00:00.000Z'),
		},
	);
	const accepted = await gateway.recordOutcome({
		question: 'q'.repeat(MAX_OUTCOME_QUESTION_LENGTH),
		outcome: 'useful',
	});
	expect(accepted.text.endsWith('q'.repeat(MAX_OUTCOME_QUESTION_LENGTH))).toBe(
		true,
	);
	expect(
		(await gateway.listMemories({ includeInactive: true })).map(
			(record) => record.id,
		),
	).toEqual([accepted.id]);

	await expect(
		gateway.recordOutcome({
			question: 'q'.repeat(MAX_OUTCOME_QUESTION_LENGTH + 1),
			outcome: 'dead_end',
		}),
	).rejects.toThrow(
		`question must be at most ${MAX_OUTCOME_QUESTION_LENGTH} characters`,
	);
	expect(
		(await gateway.listMemories({ includeInactive: true })).map(
			(record) => record.id,
		),
	).toEqual([accepted.id]);
});
