import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	handleMemoryExportCommand,
	handleMemoryEvaluateCommand,
	handleMemoryImportCommand,
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

function makeProposal(record: MemoryRecord): MemoryProposal {
	const createdAt = '2026-05-25T12:00:00.000Z';
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
