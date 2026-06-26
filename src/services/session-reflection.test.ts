import {
	afterEach,
	beforeEach,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	runSessionReflection,
	writeSessionReflection,
} from './session-reflection';

// These tests perform real filesystem I/O (mkdtemp + read/write evidence files).
// The async reads can be starved well past Bun's default 5s per-test timeout when
// this file shares a single Bun process with CPU-heavy sibling test files — e.g. a
// developer running `bun test src/` whole-tree. CI runs each file in its own
// process (per-file isolation in the `unit` job), so this only bites local
// whole-tree runs. A generous default keeps those reliable without weakening any
// assertion.
setDefaultTimeout(30_000);

describe('session-reflection — gatherToolProblems', () => {
	test('returns empty when no aggregates', () => {
		const result = _internals.gatherToolProblems(new Map());
		expect(result.problems).toEqual([]);
		expect(result.totalCalls).toBe(0);
		expect(result.totalFailures).toBe(0);
	});

	test('flags tools with >20% failure rate', () => {
		const aggs = new Map([
			[
				'bash',
				{
					tool: 'bash',
					count: 10,
					successCount: 7,
					failureCount: 3,
					totalDuration: 5000,
				},
			],
		]);
		const result = _internals.gatherToolProblems(aggs);
		expect(result.problems).toHaveLength(1);
		expect(result.problems[0].tool).toBe('bash');
		expect(result.problems[0].failureRate).toBe(0.3);
	});

	test('does not flag tools with low failure rate', () => {
		const aggs = new Map([
			[
				'read',
				{
					tool: 'read',
					count: 100,
					successCount: 99,
					failureCount: 1,
					totalDuration: 1000,
				},
			],
		]);
		const result = _internals.gatherToolProblems(aggs);
		expect(result.problems).toHaveLength(0);
		expect(result.totalCalls).toBe(100);
		expect(result.totalFailures).toBe(1);
	});

	test('flags tools with >2 absolute failures even if rate is low', () => {
		const aggs = new Map([
			[
				'write',
				{
					tool: 'write',
					count: 50,
					successCount: 47,
					failureCount: 3,
					totalDuration: 10000,
				},
			],
		]);
		const result = _internals.gatherToolProblems(aggs);
		expect(result.problems).toHaveLength(1);
		expect(result.problems[0].tool).toBe('write');
	});
});

describe('session-reflection — gatherAgentDispatches', () => {
	test('returns empty for no sessions', () => {
		const result = _internals.gatherAgentDispatches(new Map());
		expect(result).toEqual([]);
	});

	test('aggregates by agent name', () => {
		const sessions = new Map<
			string,
			{ agentName: string; lastDelegationReason?: string }
		>([
			['s1', { agentName: 'coder' }],
			['s2', { agentName: 'reviewer' }],
			['s3', { agentName: 'coder', lastDelegationReason: 'review_rejected' }],
		]);
		const result = _internals.gatherAgentDispatches(sessions);
		expect(result).toHaveLength(2);
		const coder = result.find((a) => a.agent === 'coder');
		expect(coder?.delegationCount).toBe(2);
		expect(coder?.lastDelegationReason).toBe('review_rejected');
	});
});

describe('session-reflection — gatherRetroLessonsAndTaxonomy', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-reflect-'));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('returns empty when no evidence dir', async () => {
		const result = await _internals.gatherRetroLessonsAndTaxonomy(tempDir);
		expect(result.lessons).toEqual([]);
		expect(result.taxonomy).toEqual({});
	});

	test('reads lessons and taxonomy from retro evidence', async () => {
		const retroDir = path.join(tempDir, '.swarm', 'evidence', 'retro-1');
		fs.mkdirSync(retroDir, { recursive: true });
		fs.writeFileSync(
			path.join(retroDir, 'evidence.json'),
			JSON.stringify({
				entries: [
					{
						lessons_learned: ['Always run tests before commit'],
						error_taxonomy: { logic_error: 2, interface_mismatch: 1 },
					},
				],
			}),
		);

		const result = await _internals.gatherRetroLessonsAndTaxonomy(tempDir);
		expect(result.lessons).toEqual(['Always run tests before commit']);
		expect(result.taxonomy).toEqual({
			logic_error: 2,
			interface_mismatch: 1,
		});
	});

	test('deduplicates lessons across retros', async () => {
		const retro1 = path.join(tempDir, '.swarm', 'evidence', 'retro-1');
		const retro2 = path.join(tempDir, '.swarm', 'evidence', 'retro-2');
		fs.mkdirSync(retro1, { recursive: true });
		fs.mkdirSync(retro2, { recursive: true });
		fs.writeFileSync(
			path.join(retro1, 'evidence.json'),
			JSON.stringify({ lessons_learned: ['lesson A'] }),
		);
		fs.writeFileSync(
			path.join(retro2, 'evidence.json'),
			JSON.stringify({ lessons_learned: ['lesson A', 'lesson B'] }),
		);

		const result = await _internals.gatherRetroLessonsAndTaxonomy(tempDir);
		expect(result.lessons).toEqual(['lesson A', 'lesson B']);
	});
});

describe('session-reflection — gatherGateFailures', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-reflect-gate-'));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('returns empty when no evidence', async () => {
		const result = await _internals.gatherGateFailures(tempDir);
		expect(result).toEqual([]);
	});

	test('counts failures from evidence bundles', async () => {
		const taskDir = path.join(tempDir, '.swarm', 'evidence', '1.1');
		fs.mkdirSync(taskDir, { recursive: true });
		fs.writeFileSync(
			path.join(taskDir, 'evidence.json'),
			JSON.stringify({
				entries: [
					{ agent: 'reviewer', verdict: 'fail' },
					{ agent: 'reviewer', verdict: 'fail' },
					{ agent: 'test_engineer', verdict: 'pass' },
				],
			}),
		);

		const result = await _internals.gatherGateFailures(tempDir);
		expect(result).toHaveLength(1);
		expect(result[0].gate).toBe('reviewer');
		expect(result[0].count).toBe(2);
	});

	test('skips retro directories', async () => {
		const retroDir = path.join(tempDir, '.swarm', 'evidence', 'retro-1');
		fs.mkdirSync(retroDir, { recursive: true });
		fs.writeFileSync(
			path.join(retroDir, 'evidence.json'),
			JSON.stringify({
				entries: [{ agent: 'architect', verdict: 'fail' }],
			}),
		);

		const result = await _internals.gatherGateFailures(tempDir);
		expect(result).toEqual([]);
	});
});

describe('session-reflection — buildDeterministicReport', () => {
	test('clean session produces minimal report', () => {
		const report = _internals.buildDeterministicReport({
			timestamp: '2026-06-26T00:00:00.000Z',
			totalToolCalls: 50,
			totalToolFailures: 0,
			toolProblems: [],
			agentDispatches: [],
			gateFailures: [],
			lessonsFromRetros: [],
			errorTaxonomy: {},
		});
		expect(report).toContain('No tool failures or gate rejections');
		expect(report).toContain('Session completed without notable issues');
	});

	test('session with problems produces detailed report', () => {
		const report = _internals.buildDeterministicReport({
			timestamp: '2026-06-26T00:00:00.000Z',
			totalToolCalls: 100,
			totalToolFailures: 15,
			toolProblems: [
				{
					tool: 'bash',
					failureCount: 10,
					totalCalls: 20,
					failureRate: 0.5,
					avgDurationMs: 3000,
				},
			],
			agentDispatches: [],
			gateFailures: [{ gate: 'reviewer', taskId: '1.1', count: 3 }],
			lessonsFromRetros: ['Always validate inputs'],
			errorTaxonomy: { logic_error: 4 },
		});
		expect(report).toContain('15 tool failure(s)');
		expect(report).toContain('bash');
		expect(report).toContain('reviewer');
		expect(report).toContain('logic_error');
		expect(report).toContain('Always validate inputs');
	});
});

describe('session-reflection — buildReflectionDataSummary', () => {
	test('produces text summary of session data', () => {
		const summary = _internals.buildReflectionDataSummary({
			timestamp: '2026-06-26T00:00:00.000Z',
			totalToolCalls: 50,
			totalToolFailures: 5,
			toolProblems: [
				{
					tool: 'build_check',
					failureCount: 4,
					totalCalls: 8,
					failureRate: 0.5,
					avgDurationMs: 5000,
				},
			],
			agentDispatches: [
				{
					agent: 'coder',
					delegationCount: 3,
					lastDelegationReason: 'normal_delegation',
				},
			],
			gateFailures: [],
			lessonsFromRetros: ['Test before commit'],
			errorTaxonomy: { planning_error: 2 },
		});
		expect(summary).toContain('SESSION DATA SNAPSHOT');
		expect(summary).toContain('build_check');
		expect(summary).toContain('coder');
		expect(summary).toContain('planning_error');
		expect(summary).toContain('Test before commit');
	});
});

describe('session-reflection — runSessionReflection', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-reflect-full-'));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('produces deterministic result when no delegate', async () => {
		const result = await runSessionReflection({
			directory: tempDir,
			toolAggregates: new Map(),
			agentSessions: new Map(),
		});
		expect(result.source).toBe('deterministic');
		expect(result.architectReport).toContain('## Problems Encountered');
		expect(result.data.totalToolCalls).toBe(0);
	});

	test('uses LLM delegate when provided', async () => {
		const mockDelegate = async () => 'LLM analysis: everything looks great.';

		const result = await runSessionReflection({
			directory: tempDir,
			toolAggregates: new Map(),
			agentSessions: new Map(),
			delegate: mockDelegate,
		});
		expect(result.source).toBe('llm');
		expect(result.architectReport).toBe(
			'LLM analysis: everything looks great.',
		);
	});

	test('falls back to deterministic on LLM failure', async () => {
		const failingDelegate = async () => {
			throw new Error('LLM unavailable');
		};

		const result = await runSessionReflection({
			directory: tempDir,
			toolAggregates: new Map(),
			agentSessions: new Map(),
			delegate: failingDelegate,
		});
		expect(result.source).toBe('deterministic');
		expect(result.architectReport).toContain('## Problems Encountered');
	});

	test('falls back to deterministic on empty LLM response', async () => {
		const emptyDelegate = async () => '   ';

		const result = await runSessionReflection({
			directory: tempDir,
			toolAggregates: new Map(),
			agentSessions: new Map(),
			delegate: emptyDelegate,
		});
		expect(result.source).toBe('deterministic');
	});

	test('gathers data from evidence files', async () => {
		const retroDir = path.join(tempDir, '.swarm', 'evidence', 'retro-1');
		fs.mkdirSync(retroDir, { recursive: true });
		fs.writeFileSync(
			path.join(retroDir, 'evidence.json'),
			JSON.stringify({
				entries: [
					{
						lessons_learned: ['Always validate before writing'],
						error_taxonomy: { planning_error: 2 },
					},
				],
			}),
		);

		const toolAggs = new Map([
			[
				'build_check',
				{
					tool: 'build_check',
					count: 8,
					successCount: 3,
					failureCount: 5,
					totalDuration: 40000,
				},
			],
		]);

		const result = await runSessionReflection({
			directory: tempDir,
			toolAggregates: toolAggs,
			agentSessions: new Map(),
		});

		expect(result.data.totalToolCalls).toBe(8);
		expect(result.data.totalToolFailures).toBe(5);
		expect(result.data.toolProblems).toHaveLength(1);
		expect(result.data.lessonsFromRetros).toContain(
			'Always validate before writing',
		);
		expect(result.data.errorTaxonomy.planning_error).toBe(2);
	});
});

describe('session-reflection — writeSessionReflection', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-reflect-write-'));
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('writes session-reflection.md into .swarm/', async () => {
		const result = await runSessionReflection({
			directory: tempDir,
			toolAggregates: new Map(),
			agentSessions: new Map(),
		});
		const filePath = await writeSessionReflection(tempDir, result);
		expect(filePath).toContain('session-reflection.md');
		const content = fs.readFileSync(filePath, 'utf-8');
		expect(content).toContain('# Session Reflection');
		expect(content).toContain('Source: deterministic');
		expect(content).toContain('## Problems Encountered');
	});

	test('throws when directory lacks .swarm (fs.writeFile ENOENT)', async () => {
		const noSwarmDir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'session-reflect-noswarm-'),
		);
		try {
			const result = await runSessionReflection({
				directory: noSwarmDir,
				toolAggregates: new Map(),
				agentSessions: new Map(),
			});
			await expect(
				writeSessionReflection(noSwarmDir, result),
			).rejects.toThrow();
		} finally {
			fs.rmSync(noSwarmDir, { recursive: true, force: true });
		}
	});
});
