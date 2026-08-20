import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { MemoryGateway } from '../../../src/memory/gateway';
import { recordOutcomeWithReflection } from '../../../src/memory/reflection-service';
import type { MemoryOutcome, MemoryRecord } from '../../../src/memory/types';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const NOW = new Date('2026-08-20T12:00:00.000Z');
let root: string;

beforeEach(async () => {
	root = canonicalMkdtemp('reflection-persistence-');
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

function memory(
	id: string,
	text: string,
	outcomes: MemoryOutcome[],
	overrides: Partial<MemoryRecord> = {},
): MemoryRecord {
	return {
		id,
		scope: { type: 'repository', repoId: 'repo' },
		kind: 'code_pattern',
		text,
		tags: ['reflection'],
		confidence: 0.8,
		stability: 'durable',
		source: { type: 'tool', ref: 'test' },
		createdAt: '2026-08-19T00:00:00.000Z',
		updatedAt: '2026-08-20T11:00:00.000Z',
		contentHash: `hash-${id}`,
		metadata: {
			outcomeEventIds: outcomes.map((_, index) => `${id}-event-${index}`),
		},
		outcomes,
		...overrides,
	};
}

function gatewayFor(
	records: MemoryRecord[],
	written: MemoryRecord,
	onList?: (filter: Record<string, unknown>) => void,
): MemoryGateway {
	return {
		recordOutcome: async () => written,
		listMemories: async (filter: Record<string, unknown>) => {
			onList?.(filter);
			return records;
		},
	} as unknown as MemoryGateway;
}

async function persistedArtifacts(): Promise<{
	markdown: string;
	json: string;
}> {
	const directory = path.join(root, '.swarm', 'reflections');
	return {
		markdown: await fs.readFile(path.join(directory, 'lessons.md'), 'utf-8'),
		json: await fs.readFile(path.join(directory, 'lessons.json'), 'utf-8'),
	};
}

describe('reflection persistence boundary', () => {
	test('redacts ephemeral and session secret text and corrections from both artifacts', async () => {
		const apiKey = 'sk-abcdefghijklmnopqrstuvwxyz123456';
		const sessionSecret = 'SESSION_TOKEN=supersecretvalue';
		const ephemeral = memory(
			'mem_ephemeral_secret',
			`Use ${apiKey} for the fixture`,
			[{ outcome: 'useful', at: NOW.toISOString() }],
			{ stability: 'ephemeral' },
		);
		const session = memory(
			'mem_session_secret',
			`Observed ${sessionSecret}`,
			[
				{
					outcome: 'corrected',
					at: NOW.toISOString(),
					correction: `Never persist ${sessionSecret}`,
				},
			],
			{ stability: 'session' },
		);

		const result = await recordOutcomeWithReflection(
			root,
			{ enabled: true, provider: 'local-jsonl' },
			gatewayFor([ephemeral, session], ephemeral),
			{
				memoryId: ephemeral.id,
				outcome: 'useful',
				eventId: 'reflection-secret-test',
			},
		);

		expect(result.reflectionUpdated).toBe(true);
		const artifacts = await persistedArtifacts();
		for (const artifact of [artifacts.markdown, artifacts.json]) {
			expect(artifact).not.toContain(apiKey);
			expect(artifact).not.toContain(sessionSecret);
			expect(artifact).toContain('[REDACTED:');
		}
	});

	test('excludes expired, deleted, and superseded records before counting or categorizing', async () => {
		const outcomes: MemoryOutcome[] = [
			{ outcome: 'useful', at: '2026-08-20T10:00:00.000Z' },
			{ outcome: 'useful', at: '2026-08-20T11:00:00.000Z' },
		];
		const active = memory('mem_active', 'Active lesson', outcomes);
		const expired = memory('mem_expired', 'Expired lesson', outcomes, {
			expiresAt: '2020-01-01T00:00:00.000Z',
		});
		const deleted = memory('mem_deleted', 'Deleted lesson', outcomes, {
			metadata: { deleted: true },
		});
		const superseded = memory('mem_superseded', 'Superseded lesson', outcomes, {
			supersededBy: active.id,
		});
		let observedFilter: Record<string, unknown> | undefined;

		const result = await recordOutcomeWithReflection(
			root,
			{ enabled: true, provider: 'local-jsonl' },
			gatewayFor(
				[expired, deleted, superseded, active],
				superseded,
				(filter) => {
					observedFilter = filter;
				},
			),
			{
				memoryId: superseded.id,
				outcome: 'useful',
				eventId: 'reflection-lifecycle-test',
			},
		);

		expect(result.reflectionUpdated).toBe(true);
		if (!result.reflectionUpdated) throw new Error(result.error);
		expect(observedFilter).toMatchObject({
			includeExpired: false,
			includeInactive: false,
			limit: 2000,
		});
		expect(result.digest.generatedFrom.entries).toBe(1);
		expect(result.digest.preferred.map((item) => item.memoryId)).toEqual([
			active.id,
		]);
		const artifacts = await persistedArtifacts();
		for (const excluded of [expired, deleted, superseded]) {
			expect(artifacts.json).not.toContain(excluded.id);
			expect(artifacts.markdown).not.toContain(excluded.text);
		}
	});
});
