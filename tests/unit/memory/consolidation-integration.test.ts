import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { resolveMemoryConfig } from '../../../src/memory/config';
import { runConsolidationPass } from '../../../src/memory/consolidation';
import type { ConsolidationLogRecord } from '../../../src/memory/consolidation-log';
import {
	createMemoryGateway,
	type MemoryGateway,
} from '../../../src/memory/gateway';
import type { MemoryRunLogEvent } from '../../../src/memory/run-log';

let dir: string;
let gateway: MemoryGateway;

const config = resolveMemoryConfig({
	enabled: true,
	provider: 'local-jsonl',
	consolidation: { enabled: true },
});

beforeEach(() => {
	dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'consol-int-')));
	gateway = createMemoryGateway(
		{
			directory: dir,
			sessionID: 'sess1',
			runId: 'sess1',
			agentRole: 'explorer',
		},
		{ config },
	);
});

afterEach(async () => {
	await gateway.dispose();
	rmSync(dir, { recursive: true, force: true });
});

function deps(opts: {
	facts: Array<{ text: string; kind: string; confidence: number }>;
	signal?: AbortSignal;
}) {
	const log: ConsolidationLogRecord[] = [];
	const events: MemoryRunLogEvent[] = [];
	return {
		log,
		events,
		deps: {
			gateway,
			llmDelegate: async () => JSON.stringify({ facts: opts.facts }),
			now: () => new Date(),
			logEvent: async (e: MemoryRunLogEvent) => {
				events.push(e);
			},
			readLog: async () => log,
			appendLog: async (r: ConsolidationLogRecord) => {
				log.push(r);
			},
			signal: opts.signal,
		},
	};
}

describe('consolidation against a real MemoryGateway (local-jsonl)', () => {
	test('auto-applies a durable fact end-to-end through provider validation', async () => {
		// Seed a pending episodic proposal with real evidence.
		await gateway.propose({
			operation: 'add',
			kind: 'project_fact',
			text: 'The CI runs bun test per file in src for isolation.',
			rationale: 'observed in CI logs',
			evidenceRefs: ['src/ci.ts'],
		});
		const { deps: d } = deps({
			facts: [
				{
					text: 'CI runs bun test per file to isolate cross-file mocks.',
					kind: 'project_fact',
					confidence: 0.85,
				},
			],
		});
		const r = await runConsolidationPass(
			{ directory: dir, phaseNumber: 1, runId: 'sess1', config },
			d,
		);
		expect(r.added).toBe(1);
		// The fact is now a real durable memory that passed validateMemoryRecordRules
		// and validateCuratorPromotableMemory.
		const memories = await gateway.listMemories({});
		expect(memories.some((m) => m.text.includes('bun test per file'))).toBe(
			true,
		);
	});

	test('low-confidence fact is filed as a pending proposal, not applied', async () => {
		await gateway.propose({
			operation: 'add',
			kind: 'project_fact',
			text: 'weak signal about caching',
			rationale: 'maybe',
			evidenceRefs: ['src/cache.ts'],
		});
		const before = (await gateway.listMemories({})).length;
		const { deps: d } = deps({
			facts: [
				{
					text: 'Caching might be shared across runs.',
					kind: 'project_fact',
					confidence: 0.3,
				},
			],
		});
		const r = await runConsolidationPass(
			{ directory: dir, phaseNumber: 2, runId: 'sess1', config },
			d,
		);
		expect(r.proposed).toBe(1);
		expect(r.added).toBe(0);
		expect((await gateway.listMemories({})).length).toBe(before);
	});

	test('an already-aborted signal performs no writes and does not finalize', async () => {
		await gateway.propose({
			operation: 'add',
			kind: 'project_fact',
			text: 'A fact that should not be consolidated under abort.',
			rationale: 'seed',
			evidenceRefs: ['src/x.ts'],
		});
		const controller = new AbortController();
		controller.abort();
		const memBefore = (await gateway.listMemories({})).length;
		const { deps: d, log } = deps({
			facts: [{ text: 'durable fact', kind: 'project_fact', confidence: 0.9 }],
			signal: controller.signal,
		});
		const r = await runConsolidationPass(
			{ directory: dir, phaseNumber: 4, runId: 'sess1', config },
			d,
		);
		expect(r.skipReason).toBe('aborted');
		expect((await gateway.listMemories({})).length).toBe(memBefore);
		expect(log).toHaveLength(0);
	});
});
