import type {
	MemoryRecord,
	MemoryScopeRef,
	RecallBundle,
} from '../../../src/memory/types';

/**
 * Shared scope/record/bundle fixtures for the recall-injection suites
 * (extracted so the FR-006-capped entry suite stays at its baseline size).
 */
export const repositoryScope: MemoryScopeRef = {
	type: 'repository',
	repoId: 'repo-a',
	repoRoot: 'C:/repo-a',
};

export const allowedScopes: MemoryScopeRef[] = [
	{ type: 'workspace', workspaceId: 'workspace-a' },
	repositoryScope,
	{ type: 'run', runId: 'session-a' },
	{ type: 'agent', agentId: 'test_engineer', runId: 'session-a' },
];

export function makeRecord(
	kind: MemoryRecord['kind'],
	text: string,
): MemoryRecord {
	return {
		id: `mem_${kind === 'test_pattern' ? '1' : '2'}111111111111111`,
		scope: repositoryScope,
		kind,
		text,
		tags: ['testing'],
		confidence: 0.9,
		stability: 'durable',
		source: { type: 'file', filePath: 'package.json' },
		createdAt: '2026-05-20T00:00:00.000Z',
		updatedAt: '2026-05-20T00:00:00.000Z',
		contentHash:
			'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		metadata: {},
	};
}

export function makeBundle(record: MemoryRecord): RecallBundle {
	return {
		id: 'bundle_20260524_abcd',
		query: 'query',
		generatedAt: '2026-05-24T00:00:00.000Z',
		items: [
			{
				record,
				score: 0.81,
				reason: 'test fixture',
				signals: {
					textOverlap: 0.5,
					tagOverlap: 0,
					fileOverlap: 0,
					symbolOverlap: 0,
					kindMatch: true,
					scopeMatch: true,
				},
			},
		],
		tokenEstimate: 64,
		promptBlock: [
			'## Retrieved Swarm Memory',
			'',
			'- [mem_1111111111111111] kind=test_pattern scope=repository confidence=0.90 age=4d score=0.81',
			'  Run focused tests with bun --smol test.',
		].join('\n'),
	};
}
