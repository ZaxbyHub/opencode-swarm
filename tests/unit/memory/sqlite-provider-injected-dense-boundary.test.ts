import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	computeMemoryContentHash,
	createMemoryId,
	SQLiteMemoryProvider,
} from '../../../src/memory';
import type { MemoryRecord, RecallRequest } from '../../../src/memory/types';
import { withFrozenClock } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0))
		await fs.rm(root, { recursive: true, force: true });
});

function makeRecord(
	root: string,
	name: string,
	overrides: Partial<MemoryRecord> = {},
): MemoryRecord {
	const base = {
		scope: {
			type: 'repository' as const,
			repoId: 'allowed-repo',
			repoRoot: root,
		},
		kind: 'project_fact' as const,
		text: `${name} memory`,
		stability: 'durable' as const,
		...overrides,
	};
	return {
		id: createMemoryId(base),
		...base,
		tags: [],
		confidence: 1,
		source: { type: 'file', filePath: `${name}.ts` },
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		contentHash: computeMemoryContentHash(base),
		metadata: {},
	};
}

describe('injected dense selector boundary', () => {
	test('cannot receive or return cross-scope, stale, or disallowed-kind records', async () => {
		const root = canonicalMkdtemp('swarm-dense-boundary-');
		roots.push(root);
		const { allowed, crossScope, stale, disallowedKind } = withFrozenClock(
			() => ({
				allowed: makeRecord(root, 'allowed'),
				crossScope: makeRecord(root, 'cross-scope', {
					scope: {
						type: 'repository',
						repoId: 'other-repo',
						repoRoot: root,
					},
				}),
				stale: makeRecord(root, 'stale', {
					expiresAt: '2000-01-01T00:00:00.000Z',
				}),
				disallowedKind: makeRecord(root, 'disallowed-kind', {
					kind: 'repo_convention',
				}),
			}),
		);
		let suppliedIds: string[] = [];
		const provider = new SQLiteMemoryProvider(
			root,
			{ enabled: true, provider: 'sqlite', embeddings: { enabled: true } },
			undefined,
			{
				embeddingProvider: {
					modelVersion: 'test:1',
					dimension: 1,
					available: true,
					embed: async () => new Float32Array([1]),
					embedBatch: async (texts) => texts.map(() => new Float32Array([1])),
				},
				denseSelector: async (_request, _queryEmbedding, candidates) => {
					suppliedIds = candidates.map((record) => record.id);
					return [crossScope, stale, disallowedKind, ...candidates, crossScope];
				},
			},
		);
		try {
			for (const record of [allowed, crossScope, stale, disallowedKind])
				await provider.upsert(record);
			const request: RecallRequest = {
				query: 'memory',
				scopes: [allowed.scope],
				kinds: ['project_fact'],
				maxItems: 5,
				tokenBudget: 256,
			};
			const selected = await (
				provider as unknown as {
					selectDenseCandidates(
						request: RecallRequest,
						queryEmbedding: Float32Array,
					): Promise<MemoryRecord[]>;
				}
			).selectDenseCandidates(request, new Float32Array([1]));

			expect(suppliedIds).toEqual([allowed.id]);
			expect(selected.map((record) => record.id)).toEqual([allowed.id]);
		} finally {
			await provider.close();
		}
	});
});
