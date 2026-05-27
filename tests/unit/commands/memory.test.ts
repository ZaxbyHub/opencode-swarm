import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	handleMemoryCompactCommand,
	handleMemoryEvaluateCommand,
	handleMemoryExportCommand,
	handleMemoryImportCommand,
	handleMemoryPendingCommand,
	handleMemoryRecallLogCommand,
	handleMemoryStaleCommand,
	handleMemoryStatusCommand,
} from '../../../src/commands/memory';
import {
	computeMemoryContentHash,
	createMemoryId,
	createProposalId,
	type MemoryProposal,
	type MemoryRecord,
	SQLiteMemoryProvider,
} from '../../../src/memory';

let tmpDir: string;
let originalXdgConfigHome: string | undefined;

beforeEach(async () => {
	originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
	tmpDir = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-memory-command-')),
	);
	process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'xdg-config');
});

afterEach(async () => {
	if (originalXdgConfigHome === undefined) {
		delete process.env.XDG_CONFIG_HOME;
	} else {
		process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
	}
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('/swarm memory commands', () => {
	test('status reports the default sqlite provider and legacy JSONL files', async () => {
		const output = await handleMemoryStatusCommand(tmpDir, []);

		expect(output).toContain('Provider: `sqlite`');
		expect(output).toContain('memories.jsonl: `missing`');
		expect(output).toContain('proposals.jsonl: `missing`');
		expect(output).toContain('Automatic destructive cleanup: `disabled`');
	});

	test('export writes current SQLite memory to JSONL', async () => {
		const provider = new SQLiteMemoryProvider(tmpDir, {
			enabled: true,
			provider: 'sqlite',
		});
		const record = makeRecord('Exported memory remains JSONL compatible.');
		const proposal = makeProposal(record);
		try {
			await provider.upsert(record);
			await provider.createProposal(proposal);
		} finally {
			provider.close();
		}

		const output = await handleMemoryExportCommand(tmpDir, []);

		const exportDir = path.join(tmpDir, '.swarm', 'memory', 'export');
		expect(output).toContain('Swarm Memory Export');
		expect(existsSync(path.join(exportDir, 'memories.jsonl'))).toBe(true);
		expect(existsSync(path.join(exportDir, 'proposals.jsonl'))).toBe(true);
		expect(
			await fs.readFile(path.join(exportDir, 'memories.jsonl'), 'utf-8'),
		).toContain(record.id);
		expect(
			await fs.readFile(path.join(exportDir, 'proposals.jsonl'), 'utf-8'),
		).toContain(proposal.id);
	});

	test('import reports invalid JSONL rows while importing valid rows', async () => {
		const memoryDir = path.join(tmpDir, '.swarm', 'memory');
		await fs.mkdir(memoryDir, { recursive: true });
		const record = makeRecord('Imported JSONL memory is reported.');
		const proposal = makeProposal(record);
		await fs.writeFile(
			path.join(memoryDir, 'memories.jsonl'),
			`${JSON.stringify(record)}\n{"bad":"record"}\n`,
			'utf-8',
		);
		await fs.writeFile(
			path.join(memoryDir, 'proposals.jsonl'),
			`${JSON.stringify(proposal)}\nnot-json\n`,
			'utf-8',
		);

		const output = await handleMemoryImportCommand(tmpDir, []);

		expect(output).toContain('Imported memories: `1`');
		expect(output).toContain('Imported proposals: `1`');
		expect(output).toContain('Invalid rows: `2`');
		expect(output).toContain('memories.jsonl:2');
		expect(output).toContain('proposals.jsonl:2');
	});

	test('evaluate emits a parseable JSON recall report', async () => {
		const output = await handleMemoryEvaluateCommand(tmpDir, ['--json']);
		const report = JSON.parse(output);

		expect(report.summary.fixture_count).toBe(5);
		expect(report.summary.run_count).toBe(30);
		expect(report.summary.noisy_injection_count).toBe(0);
		expect(report.summary.same_scope_noise_count).toBeGreaterThan(0);
		expect(report.summary.cross_scope_leak_count).toBe(0);
		expect(report.summary.stale_memory_count).toBe(0);
		expect(report.summary).toHaveProperty('precision@k');
		expect(report.summary).toHaveProperty('recall@k');
	});

	test('evaluate without arguments emits the markdown recall summary', async () => {
		const output = await handleMemoryEvaluateCommand(tmpDir, []);

		expect(output).toContain('## Swarm Memory Recall Evaluation');
		expect(output).toContain('Fixtures: `5`');
		expect(output).toContain('Same-scope noise: `');
		expect(output).toContain(
			'Use `/swarm memory evaluate --json` for the full report.',
		);
		expect(() => JSON.parse(output)).toThrow();
	});

	test('evaluate reports usage for unknown flags and missing fixture values', async () => {
		const usage =
			'Usage: /swarm memory evaluate [--json] [--fixtures <directory>]';

		await expect(
			handleMemoryEvaluateCommand(tmpDir, ['--bogus']),
		).resolves.toBe(usage);
		await expect(
			handleMemoryEvaluateCommand(tmpDir, ['--fixtures']),
		).resolves.toBe(usage);
		await expect(
			handleMemoryEvaluateCommand(tmpDir, ['--fixture-dir', 'fixtures']),
		).resolves.toBe(usage);
	});

	test('pending lists pending proposals and rejected proposal reasons', async () => {
		const provider = new SQLiteMemoryProvider(tmpDir, {
			enabled: true,
			provider: 'sqlite',
		});
		const pendingRecord = makeRecord('Pending proposal should be listed.');
		const rejectedRecord = makeRecord(
			'Rejected proposal reason should be shown.',
		);
		const pending = makeProposal(pendingRecord);
		const rejected = makeProposal(rejectedRecord);
		try {
			await provider.createProposal(pending);
			await provider.createProposal(rejected);
			await provider.applyCuratorDecision({
				action: 'reject',
				proposalId: rejected.id,
				reason: 'Too vague to keep.',
			});
		} finally {
			provider.close();
		}

		const output = await handleMemoryPendingCommand(tmpDir, []);

		expect(output).toContain('Pending proposals shown: `1`');
		expect(output).toContain(pending.id);
		expect(output).toContain('Rejected proposal reasons shown: `1`');
		expect(output).toContain('Too vague to keep.');
	});

	test('pending keeps rejected reasons visible behind newer proposal pages', async () => {
		const provider = new SQLiteMemoryProvider(tmpDir, {
			enabled: true,
			provider: 'sqlite',
		});
		const rejectedRecord = makeRecord(
			'Old rejected proposal reason should still be shown.',
		);
		const rejected = makeProposal(rejectedRecord, {
			createdAt: '2026-01-01T12:00:00.000Z',
		});
		try {
			await provider.createProposal(rejected);
			await provider.applyCuratorDecision({
				action: 'reject',
				proposalId: rejected.id,
				reason: 'Rejected before many newer proposals.',
			});
			for (let index = 0; index < 105; index++) {
				const record = makeRecord(`Newer pending proposal ${index}.`);
				await provider.createProposal(
					makeProposal(record, {
						createdAt: new Date(Date.UTC(2026, 4, 25, 12, index)).toISOString(),
					}),
				);
			}
		} finally {
			provider.close();
		}

		const output = await handleMemoryPendingCommand(tmpDir, []);

		expect(output).toContain('Pending proposals shown: `20`');
		expect(output).toContain('Rejected proposal reasons shown: `1`');
		expect(output).toContain('Rejected before many newer proposals.');
	});

	test('recall-log summarizes usage by agent role and memory ID', async () => {
		const provider = new SQLiteMemoryProvider(tmpDir, {
			enabled: true,
			provider: 'sqlite',
		});
		const recalled = makeRecord('Recall log should count this memory.');
		const never = makeRecord('Never recalled memory should be visible.');
		try {
			await provider.upsert(recalled);
			await provider.upsert(never);
			await provider.recordRecallUsage({
				bundleId: 'bundle_20260525_abcd1234',
				query: 'memory maintenance',
				scopes: [recalled.scope],
				kinds: ['repo_convention'],
				memoryIds: [recalled.id],
				scores: [0.77],
				tokenEstimate: 120,
				agentRole: 'coder',
				runId: 'session-a',
				timestamp: '2026-05-25T13:00:00.000Z',
			});
			await provider.recordRecallUsage({
				bundleId: 'bundle_20260525_abcd5678',
				query: 'memory maintenance',
				scopes: [recalled.scope],
				memoryIds: [recalled.id],
				scores: [0.88],
				tokenEstimate: 80,
				agentRole: 'qa',
				runId: 'session-b',
				timestamp: '2026-05-25T14:00:00.000Z',
			});
		} finally {
			provider.close();
		}

		const output = await handleMemoryRecallLogCommand(tmpDir, []);

		expect(output).toContain('Recall events scanned: `2`');
		expect(output).toContain('`coder`: 1 recall event(s), 1 memory ID(s)');
		expect(output).toContain('`qa`: 1 recall event(s), 1 memory ID(s)');
		expect(output).toContain(`\`${recalled.id}\`: 2 hit(s)`);
		expect(output).toContain(never.id);
	});

	test('recall-log does not classify memories as never recalled outside the recent window', async () => {
		const provider = new SQLiteMemoryProvider(tmpDir, {
			enabled: true,
			provider: 'sqlite',
		});
		const oldRecalled = makeRecord('Older recall event should still count.');
		const filler = makeRecord('Filler recall event memory.');
		try {
			await provider.upsert(oldRecalled);
			await provider.upsert(filler);
			await provider.recordRecallUsage({
				bundleId: 'bundle_20260525_old',
				query: 'old recall',
				scopes: [oldRecalled.scope],
				memoryIds: [oldRecalled.id],
				scores: [0.7],
				tokenEstimate: 80,
				agentRole: 'coder',
				runId: 'old-session',
				timestamp: '2026-05-25T00:00:00.000Z',
			});
			for (let index = 0; index < 1000; index++) {
				await provider.recordRecallUsage({
					bundleId: `bundle_20260525_recent_${index}`,
					query: 'recent recall',
					scopes: [filler.scope],
					memoryIds: [filler.id],
					scores: [0.8],
					tokenEstimate: 80,
					agentRole: 'qa',
					runId: `recent-session-${index}`,
					timestamp: new Date(Date.UTC(2026, 4, 25, 1, 0, index)).toISOString(),
				});
			}
		} finally {
			provider.close();
		}

		const output = await handleMemoryRecallLogCommand(tmpDir, []);

		expect(output).toContain('Recall events scanned: `1001`');
		expect(output).toContain(`\`${oldRecalled.id}\`: 1 hit(s)`);
		expect(output).not.toContain(
			`${oldRecalled.id}\` ${oldRecalled.kind} confidence=`,
		);
	});

	test('stale lists expired scratch memories and superseded chains', async () => {
		const provider = new SQLiteMemoryProvider(tmpDir, {
			enabled: true,
			provider: 'sqlite',
		});
		const expiredScratch = makeScratchRecord('Expired scratch is stale.');
		const oldMemory = makeRecord('Old superseded convention.');
		const replacement = {
			...makeRecord('Replacement convention.'),
			supersedes: [oldMemory.id],
		};
		const superseded = {
			...oldMemory,
			updatedAt: '2026-05-25T14:00:00.000Z',
			supersededBy: replacement.id,
			metadata: { supersedeReason: 'Replacement is more precise.' },
		};
		try {
			await provider.upsert(expiredScratch);
			await provider.upsert(superseded);
			await provider.upsert(replacement);
		} finally {
			provider.close();
		}

		const output = await handleMemoryStaleCommand(tmpDir, []);

		expect(output).toContain('Expired scratch memories shown: `1`');
		expect(output).toContain(expiredScratch.id);
		expect(output).toContain('Superseded chains');
		expect(output).toContain(`${oldMemory.id}\` -> \`${replacement.id}`);
		expect(output).toContain('Replacement is more precise.');
	});

	test('compact is dry-run by default and requires --confirm to remove records', async () => {
		const provider = new SQLiteMemoryProvider(tmpDir, {
			enabled: true,
			provider: 'sqlite',
		});
		const deleted = makeRecord('Deleted memory should compact.');
		const expiredScratch = makeScratchRecord('Expired scratch should compact.');
		try {
			await provider.upsert(deleted);
			await provider.upsert(expiredScratch);
			await provider.delete(deleted.id, 'obsolete');
		} finally {
			provider.close();
		}

		const dryRun = await handleMemoryCompactCommand(tmpDir, []);
		expect(dryRun).toContain('Mode: `dry-run`');
		expect(dryRun).toContain('Deleted tombstones: `1`');
		expect(dryRun).toContain('Expired scratch records: `1`');
		await expect(
			handleMemoryCompactCommand(tmpDir, ['--limit', '1']),
		).resolves.toBe('Usage: /swarm memory compact [--confirm]');

		const afterDryRun = new SQLiteMemoryProvider(tmpDir, {
			enabled: true,
			provider: 'sqlite',
		});
		try {
			expect(await afterDryRun.get(deleted.id)).not.toBeNull();
			expect(await afterDryRun.get(expiredScratch.id)).not.toBeNull();
		} finally {
			afterDryRun.close();
		}

		const confirmed = await handleMemoryCompactCommand(tmpDir, ['--confirm']);
		expect(confirmed).toContain('Mode: `confirmed`');

		const afterConfirm = new SQLiteMemoryProvider(tmpDir, {
			enabled: true,
			provider: 'sqlite',
		});
		try {
			expect(await afterConfirm.get(deleted.id)).toBeNull();
			expect(await afterConfirm.get(expiredScratch.id)).toBeNull();
		} finally {
			afterConfirm.close();
		}
	});
});

function makeRecord(text: string): MemoryRecord {
	const base = {
		scope: {
			type: 'repository' as const,
			repoId: 'repo-a',
			repoRoot: path.join(tmpDir, 'repo-a'),
		},
		kind: 'repo_convention' as const,
		text,
	};
	return {
		id: createMemoryId(base),
		...base,
		tags: ['memory'],
		confidence: 0.9,
		stability: 'durable',
		source: { type: 'file', filePath: 'README.md' },
		createdAt: '2026-05-25T12:00:00.000Z',
		updatedAt: '2026-05-25T12:00:00.000Z',
		contentHash: computeMemoryContentHash(base),
		metadata: {},
	};
}

function makeScratchRecord(text: string): MemoryRecord {
	const base = {
		scope: {
			type: 'run' as const,
			runId: 'run-a',
		},
		kind: 'scratch' as const,
		text,
	};
	return {
		id: createMemoryId(base),
		...base,
		tags: ['scratch'],
		confidence: 0.5,
		stability: 'ephemeral',
		source: { type: 'agent', createdBy: 'coder' },
		createdAt: '2026-05-20T12:00:00.000Z',
		updatedAt: '2026-05-20T12:00:00.000Z',
		expiresAt: '2026-05-21T12:00:00.000Z',
		contentHash: computeMemoryContentHash(base),
		metadata: {},
	};
}

function makeProposal(
	record: MemoryRecord,
	options: { createdAt?: string } = {},
): MemoryProposal {
	const createdAt = options.createdAt ?? '2026-05-25T12:00:00.000Z';
	return {
		id: createProposalId({
			createdAt,
			proposer: 'coder',
			text: record.text,
		}),
		operation: 'add',
		proposedRecord: record,
		proposedBy: { agentRole: 'coder', runId: 'session-a' },
		rationale: 'Useful memory command coverage.',
		evidenceRefs: ['README.md'],
		status: 'pending',
		createdAt,
		metadata: {},
	};
}
