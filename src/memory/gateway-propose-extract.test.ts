import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMemoryGateway } from './gateway.js';
import { scoreMemoryRecords } from './scoring.js';
import type {
	MemoryContext,
	MemoryKind,
	MemoryProposal,
	MemoryProposalStore,
	MemoryProvider,
	MemoryRecord,
	RecallRequest,
} from './types.js';

function createMockProvider() {
	const proposals: MemoryProposal[] = [];
	return {
		proposals,
		provider: {
			recall: mock(async () => ({ items: [] })),
			upsert: mock(async (record: MemoryRecord) => record),
			close: mock(async () => {}),
			createProposal: mock(async (proposal: MemoryProposal) => {
				proposals.push(proposal);
				return proposal;
			}),
		} as MemoryProvider & Partial<MemoryProposalStore>,
	};
}

function createTestContext(): MemoryContext {
	return {
		directory: '/fake/test/dir',
		sessionID: 'test-session',
		agentRole: 'test_agent',
	};
}

describe('extractFilePaths via propose()', () => {
	let mockProvider: ReturnType<typeof createMockProvider>;

	beforeEach(() => {
		mockProvider = createMockProvider();
	});

	afterEach(() => {
		mock.restore();
	});

	test('SC-015: typical file paths → metadata.files populated', async () => {
		const gateway = createMemoryGateway(createTestContext(), {
			provider: mockProvider.provider,
			config: { enabled: true },
		});
		const proposal = await gateway.propose({
			operation: 'add',
			kind: 'code_pattern' as MemoryKind,
			text: 'found a pattern',
			rationale: 'reviewed code',
			evidenceRefs: [
				'src/memory/gateway.ts',
				'tests/unit/memory/gateway.test.ts',
			],
		});
		expect(proposal.proposedRecord).toBeDefined();
		expect(proposal.proposedRecord!.metadata).toBeDefined();
		const files = proposal.proposedRecord!.metadata['files'];
		expect(Array.isArray(files)).toBe(true);
		expect(files).toContain('src/memory/gateway.ts');
		expect(files).toContain('tests/unit/memory/gateway.test.ts');
	});

	test('extractFilePaths: no file paths → empty metadata.files', async () => {
		const gateway = createMemoryGateway(createTestContext(), {
			provider: mockProvider.provider,
			config: { enabled: true },
		});
		const proposal = await gateway.propose({
			operation: 'add',
			kind: 'code_pattern' as MemoryKind,
			text: 'no file evidence',
			rationale: 'just text',
			evidenceRefs: ['https://example.com', 'no-paths-here'],
		});
		expect(proposal.proposedRecord).toBeDefined();
		expect(proposal.proposedRecord!.metadata['files']).toBeUndefined();
	});

	test('extractFilePaths: mixed content → only matched paths returned', async () => {
		const gateway = createMemoryGateway(createTestContext(), {
			provider: mockProvider.provider,
			config: { enabled: true },
		});
		const proposal = await gateway.propose({
			operation: 'add',
			kind: 'code_pattern' as MemoryKind,
			text: 'mixed evidence',
			rationale: 'mixed refs',
			evidenceRefs: [
				'just a random string',
				'src/utils/helper.ts',
				'not a path either',
				'tests/worker.test.ts',
				'another string',
			],
		});
		expect(proposal.proposedRecord).toBeDefined();
		const files = proposal.proposedRecord!.metadata['files'] as string[];
		expect(files).toContain('src/utils/helper.ts');
		expect(files).toContain('tests/worker.test.ts');
		// Random strings should not be included
		expect(files).not.toContain('just a random string');
		expect(files).not.toContain('not a path either');
		expect(files).not.toContain('another string');
	});

	test('extractFilePaths: dedup — same path appears multiple times → only once', async () => {
		const gateway = createMemoryGateway(createTestContext(), {
			provider: mockProvider.provider,
			config: { enabled: true },
		});
		const proposal = await gateway.propose({
			operation: 'add',
			kind: 'code_pattern' as MemoryKind,
			text: 'dedup test',
			rationale: 'same path twice',
			evidenceRefs: [
				'src/memory/gateway.ts',
				'src/memory/gateway.ts',
				'tests/unit/gateway.test.ts',
				'src/memory/gateway.ts',
			],
		});
		expect(proposal.proposedRecord).toBeDefined();
		const files = proposal.proposedRecord!.metadata['files'] as string[];
		// Count occurrences — should be 1 each
		const counts = new Map<string, number>();
		for (const f of files) {
			counts.set(f, (counts.get(f) ?? 0) + 1);
		}
		for (const [path, count] of counts) {
			expect(count).toBe(1);
		}
		expect(files).toContain('src/memory/gateway.ts');
		expect(files).toContain('tests/unit/gateway.test.ts');
	});

	test('extractFilePaths: cap at 20 entries — 25+ paths → only first 20 returned', async () => {
		const gateway = createMemoryGateway(createTestContext(), {
			provider: mockProvider.provider,
			config: { enabled: true },
		});
		const refs: string[] = [];
		for (let i = 0; i < 25; i++) {
			refs.push(`src/file${i}.ts`);
		}
		const proposal = await gateway.propose({
			operation: 'add',
			kind: 'code_pattern' as MemoryKind,
			text: 'cap test',
			rationale: 'many files',
			evidenceRefs: refs,
		});
		expect(proposal.proposedRecord).toBeDefined();
		const files = proposal.proposedRecord!.metadata['files'] as string[];
		expect(files.length).toBe(20);
		// First 20 should be src/file0.ts through src/file19.ts
		for (let i = 0; i < 20; i++) {
			expect(files).toContain(`src/file${i}.ts`);
		}
		// Files 20-24 should NOT be present
		for (let i = 20; i < 25; i++) {
			expect(files).not.toContain(`src/file${i}.ts`);
		}
	});

	test('extractFilePaths: files from docs/, scripts/, packages/ also matched', async () => {
		const gateway = createMemoryGateway(createTestContext(), {
			provider: mockProvider.provider,
			config: { enabled: true },
		});
		const proposal = await gateway.propose({
			operation: 'add',
			kind: 'repo_convention' as MemoryKind,
			text: 'convention pattern',
			rationale: 'convention refs',
			evidenceRefs: [
				'docs/architecture.md',
				'scripts/build.sh',
				'packages/core/src/index.ts',
				'test/integration.test.ts',
			],
		});
		expect(proposal.proposedRecord).toBeDefined();
		const files = proposal.proposedRecord!.metadata['files'] as string[];
		expect(files).toContain('docs/architecture.md');
		expect(files).toContain('scripts/build.sh');
		expect(files).toContain('packages/core/src/index.ts');
		expect(files).toContain('test/integration.test.ts');
	});
});

describe('extractSymbols via propose()', () => {
	let mockProvider: ReturnType<typeof createMockProvider>;

	beforeEach(() => {
		mockProvider = createMockProvider();
	});

	afterEach(() => {
		mock.restore();
	});

	test('extractSymbols: typical identifiers → metadata.symbols populated', async () => {
		const gateway = createMemoryGateway(createTestContext(), {
			provider: mockProvider.provider,
			config: { enabled: true },
		});
		const proposal = await gateway.propose({
			operation: 'add',
			kind: 'code_pattern' as MemoryKind,
			text: 'pattern found',
			rationale: 'symbol evidence',
			evidenceRefs: [
				'functionName',
				'ClassName.method',
				'anotherFunc',
				'_privateHelper',
			],
		});
		expect(proposal.proposedRecord).toBeDefined();
		const symbols = proposal.proposedRecord!.metadata['symbols'] as string[];
		expect(Array.isArray(symbols)).toBe(true);
		// The identifier regex matches dotted names as a single token
		expect(symbols).toContain('functionName');
		expect(symbols).toContain('ClassName.method'); // dotted name matched as one token
		expect(symbols).toContain('anotherFunc');
		expect(symbols).toContain('_privateHelper');
	});

	test('extractSymbols: no symbols → metadata.symbols undefined', async () => {
		const gateway = createMemoryGateway(createTestContext(), {
			provider: mockProvider.provider,
			config: { enabled: true },
		});
		const proposal = await gateway.propose({
			operation: 'add',
			kind: 'code_pattern' as MemoryKind,
			text: 'no symbols here',
			rationale: 'no identifiers',
			evidenceRefs: ['123', '!!!', '---', '   '],
		});
		expect(proposal.proposedRecord).toBeDefined();
		expect(proposal.proposedRecord!.metadata['symbols']).toBeUndefined();
	});

	test('extractSymbols: reserved keywords filtered out', async () => {
		const gateway = createMemoryGateway(createTestContext(), {
			provider: mockProvider.provider,
			config: { enabled: true },
		});
		const proposal = await gateway.propose({
			operation: 'add',
			kind: 'code_pattern' as MemoryKind,
			text: 'reserved words',
			rationale: 'filter test',
			evidenceRefs: [
				'const',
				'function',
				'class',
				'async',
				'validFunction',
				'await',
			],
		});
		expect(proposal.proposedRecord).toBeDefined();
		const symbols = proposal.proposedRecord!.metadata['symbols'] as string[];
		expect(symbols).not.toContain('const');
		expect(symbols).not.toContain('function');
		expect(symbols).not.toContain('class');
		expect(symbols).not.toContain('async');
		expect(symbols).not.toContain('await');
		expect(symbols).toContain('validFunction');
	});

	test('extractSymbols: dedup — same symbol twice → only once', async () => {
		const gateway = createMemoryGateway(createTestContext(), {
			provider: mockProvider.provider,
			config: { enabled: true },
		});
		const proposal = await gateway.propose({
			operation: 'add',
			kind: 'code_pattern' as MemoryKind,
			text: 'same symbol',
			rationale: 'dup test',
			evidenceRefs: [
				'helperFunc',
				'helperFunc',
				'ClassName.method',
				'helperFunc',
			],
		});
		expect(proposal.proposedRecord).toBeDefined();
		const symbols = proposal.proposedRecord!.metadata['symbols'] as string[];
		const counts = new Map<string, number>();
		for (const s of symbols) {
			counts.set(s, (counts.get(s) ?? 0) + 1);
		}
		for (const [sym, count] of counts) {
			expect(count).toBe(1);
		}
	});

	test('extractSymbols: cap at 20 entries', async () => {
		const gateway = createMemoryGateway(createTestContext(), {
			provider: mockProvider.provider,
			config: { enabled: true },
		});
		const refs: string[] = [];
		for (let i = 0; i < 25; i++) {
			refs.push(`func${i}`);
		}
		const proposal = await gateway.propose({
			operation: 'add',
			kind: 'code_pattern' as MemoryKind,
			text: 'cap test',
			rationale: 'many symbols',
			evidenceRefs: refs,
		});
		expect(proposal.proposedRecord).toBeDefined();
		const symbols = proposal.proposedRecord!.metadata['symbols'] as string[];
		expect(symbols.length).toBe(20);
		for (let i = 0; i < 20; i++) {
			expect(symbols).toContain(`func${i}`);
		}
		for (let i = 20; i < 25; i++) {
			expect(symbols).not.toContain(`func${i}`);
		}
	});
});

describe('SC-016: fileOverlap scoring via scoreMemoryRecord', () => {
	afterEach(() => {
		mock.restore();
	});

	function makeRecord(
		text: string,
		metadata: Record<string, unknown> = {},
		sourceFilePath?: string,
	): MemoryRecord {
		const scope = {
			type: 'repository' as const,
			repoId: 'test-repo',
			repoRoot: '/fake',
		};
		return {
			id: `rec-${Math.random().toString(36).slice(2)}`,
			scope,
			kind: 'code_pattern' as MemoryKind,
			text,
			tags: [],
			confidence: 0.5,
			stability: 'durable' as const,
			source: sourceFilePath
				? { type: 'file' as const, filePath: sourceFilePath }
				: { type: 'manual' as const, ref: 'test' },
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			contentHash: 'hash',
			metadata,
		};
	}

	function makeRequest(
		query: string,
		scope: MemoryRecord['scope'],
	): RecallRequest {
		return {
			query,
			scopes: [scope],
			mode: 'manual',
			maxItems: 10,
			tokenBudget: 1000,
			minScore: 0,
		};
	}

	test('record with metadata.files scores higher on fileOverlap than record without', async () => {
		const recordWithFiles = makeRecord('gateway code pattern', {
			files: ['src/memory/gateway.ts', 'tests/gateway.test.ts'],
		});
		const recordWithoutFiles = makeRecord('gateway code pattern');

		const request = makeRequest('gateway memory ts', recordWithFiles.scope);

		const results = scoreMemoryRecords(
			[recordWithoutFiles, recordWithFiles],
			request,
		);
		expect(results.length).toBe(2);

		const withFiles = results.find(
			(r) => (r.record.metadata['files'] as string[])?.length > 0,
		)!;
		const withoutFiles = results.find((r) => !r.record.metadata['files'])!;

		// Both have textOverlap since text is identical, but the one with
		// file metadata should get an additional fileOverlap boost
		expect(withFiles.score).toBeGreaterThan(withoutFiles.score);
		expect(withFiles.signals.fileOverlap).toBeGreaterThan(0);
		expect(withoutFiles.signals.fileOverlap).toBe(0);
	});

	test('record with metadata.symbols scores higher on symbolOverlap than record without', async () => {
		const recordWithSymbols = makeRecord('pattern found', {
			symbols: ['helperFunc', 'ClassName.method'],
		});
		const recordWithoutSymbols = makeRecord('pattern found');

		const request = makeRequest(
			'helperFunc ClassName',
			recordWithSymbols.scope,
		);

		const results = scoreMemoryRecords(
			[recordWithSymbols, recordWithoutSymbols],
			request,
		);
		expect(results.length).toBe(2);

		const withSymbols = results.find(
			(r) => (r.record.metadata['symbols'] as string[])?.length > 0,
		)!;
		const withoutSymbols = results.find((r) => !r.record.metadata['symbols'])!;

		expect(withSymbols.score).toBeGreaterThan(withoutSymbols.score);
		expect(withSymbols.signals.symbolOverlap).toBeGreaterThan(0);
		expect(withoutSymbols.signals.symbolOverlap).toBe(0);
	});

	test('SC-015 integration: propose with file evidenceRefs → recall scores fileOverlap', async () => {
		// This is the end-to-end SC-015+SC-016 flow:
		// 1. propose() with file-path evidenceRefs populates metadata.files
		// 2. scoreMemoryRecord uses metadata.files to compute fileOverlap
		const mockProvider = createMockProvider();
		const gateway = createMemoryGateway(createTestContext(), {
			provider: mockProvider.provider,
			config: { enabled: true },
		});

		await gateway.propose({
			operation: 'add',
			kind: 'code_pattern' as MemoryKind,
			text: 'pattern in gateway',
			rationale: 'reviewed gateway',
			evidenceRefs: ['src/memory/gateway.ts', 'tests/memory/gateway.test.ts'],
		});

		expect(mockProvider.proposals.length).toBe(1);
		const proposal = mockProvider.proposals[0];
		expect(proposal.proposedRecord).toBeDefined();
		const files = proposal.proposedRecord!.metadata['files'] as string[];
		expect(files).toContain('src/memory/gateway.ts');
		expect(files).toContain('tests/memory/gateway.test.ts');

		// Now score this record
		const record = proposal.proposedRecord!;
		const records = [record];
		const scored = scoreMemoryRecords(records, {
			query: 'gateway memory ts',
			scopes: [record.scope], // use the record's own scope to ensure matching
			mode: 'manual',
			maxItems: 10,
			tokenBudget: 1000,
			minScore: 0,
		});

		expect(scored.length).toBe(1);
		expect(scored[0].signals.fileOverlap).toBeGreaterThan(0);
	});
});
