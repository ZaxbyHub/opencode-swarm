import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	appendKnowledge,
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store';
import { readSupervisorReportRaw } from '../../../src/summaries/store';
import { TOOL_NAME_SET } from '../../../src/tools/tool-names';
import { write_architecture_supervisor_evidence } from '../../../src/tools/write-architecture-supervisor-evidence';

let tempDir: string;

beforeEach(() => {
	tempDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'swarm-asev-')));
	mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

type ExecuteFn = (args: unknown, ctx: { directory: string }) => Promise<string>;

function run(args: unknown): Promise<string> {
	return (
		write_architecture_supervisor_evidence.execute as unknown as ExecuteFn
	)(args, { directory: tempDir });
}

describe('write_architecture_supervisor_evidence registration', () => {
	test('is in TOOL_NAME_SET', () => {
		expect(TOOL_NAME_SET.has('write_architecture_supervisor_evidence')).toBe(
			true,
		);
	});
});

describe('write_architecture_supervisor_evidence execute', () => {
	test('persists a REJECT verdict that survives as a raw top-level field', async () => {
		const out = await run({
			phase: 2,
			verdict: 'REJECT',
			findings: [
				{
					severity: 'high',
					category: 'contradiction',
					agents: ['coder', 'test_engineer'],
					tasks: ['2.1', '2.2'],
					description: 'redis vs in-memory store',
					recommendation: 'pick one',
				},
			],
		});
		const parsed = JSON.parse(out);
		expect(parsed.success).toBe(true);
		expect(parsed.verdict).toBe('REJECT');
		expect(parsed.findings_count).toBe(1);

		const raw = readSupervisorReportRaw(tempDir, 2);
		expect(raw?.verdict).toBe('REJECT');
		expect(raw?.phase_number).toBe(2);
		expect(raw?.findings).toHaveLength(1);
	});

	test('persists an APPROVE verdict with no findings', async () => {
		const out = await run({ phase: 1, verdict: 'APPROVE' });
		expect(JSON.parse(out).success).toBe(true);
		const raw = readSupervisorReportRaw(tempDir, 1);
		expect(raw?.verdict).toBe('APPROVE');
		expect(raw?.findings).toEqual([]);
	});

	test('rejects an invalid verdict without writing', async () => {
		const out = await run({ phase: 1, verdict: 'MAYBE' });
		const parsed = JSON.parse(out);
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('invalid arguments');
		expect(readSupervisorReportRaw(tempDir, 1)).toBeNull();
	});
});

describe('write_architecture_supervisor_evidence knowledge feedback (Chunk E)', () => {
	function writeConfig(persist: boolean) {
		const dir = `${tempDir}/.opencode`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			`${dir}/opencode-swarm.json`,
			JSON.stringify({
				architectural_supervision: {
					enabled: true,
					persist_knowledge_recommendations: persist,
				},
			}),
			'utf-8',
		);
	}

	const recArgs = {
		phase: 1,
		verdict: 'CONCERNS',
		knowledge_recommendations: [
			{
				lesson:
					'Pick a single storage backend per phase; mixing Redis and in-memory maps across tasks causes cross-task incoherence.',
				target_agents: ['coder'],
				confidence: 0.8,
			},
		],
	};

	test('routes recommendations through the actionability gate when persist flag is enabled', async () => {
		// Realigned (Change 4): prose recommendations must pass the Layer-5
		// actionability gate before reaching the active store. In this offline
		// test environment no curator LLM is available to enrich them, so the
		// recommendation is QUARANTINED to the unactionable queue (recoverable by
		// the hardening loop) rather than stored as an active candidate.
		writeConfig(true);
		const out = await run(recArgs);
		const parsed = JSON.parse(out);
		expect(parsed.knowledge_proposed).toBe(0);
		expect(parsed.knowledge_quarantined).toBe(1);

		// Nothing landed in the active store…
		const knowledgePath = resolveSwarmKnowledgePath(tempDir);
		const entries =
			(await readKnowledge<{ status: string; lesson: string }>(
				knowledgePath,
			)) ?? [];
		expect(entries).toHaveLength(0);

		// …but the recommendation is preserved in the unactionable queue.
		const queued =
			(await readKnowledge<{ status: string; lesson: string }>(
				path.join(tempDir, '.swarm', 'knowledge-unactionable.jsonl'),
			)) ?? [];
		expect(queued).toHaveLength(1);
		expect(queued[0].status).toBe('quarantined_unactionable');
		expect(queued[0].lesson).toContain('single storage backend');
	});

	test('does not propose knowledge when persist flag is disabled', async () => {
		writeConfig(false);
		const out = await run(recArgs);
		expect(JSON.parse(out).knowledge_proposed).toBe(0);
	});
});

describe('write_architecture_supervisor_evidence skill-draft feedback (Chunk E)', () => {
	function writeConfig(persist: boolean) {
		const dir = `${tempDir}/.opencode`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			`${dir}/opencode-swarm.json`,
			JSON.stringify({
				architectural_supervision: {
					enabled: true,
					persist_knowledge_recommendations: persist,
				},
			}),
			'utf-8',
		);
	}

	async function seedMatureKnowledge() {
		const kp = resolveSwarmKnowledgePath(tempDir);
		const mk = (id: string, lesson: string) => ({
			id,
			tier: 'swarm' as const,
			lesson,
			category: 'process' as const,
			tags: ['process'],
			scope: 'global' as const,
			confidence: 0.95,
			status: 'candidate' as const,
			confirmed_by: [
				{
					phase_number: 1,
					confirmed_at: new Date().toISOString(),
					project_name: 'p',
				},
				{
					phase_number: 2,
					confirmed_at: new Date().toISOString(),
					project_name: 'p',
				},
			],
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
			},
			schema_version: '2.0.0',
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			project_name: 'p',
			auto_generated: true,
		});
		await appendKnowledge(
			kp,
			mk(
				'id1',
				'Run the full test suite before completing a phase to catch cross-task regressions.',
			),
		);
		await appendKnowledge(
			kp,
			mk(
				'id2',
				'Run the complete test suite prior to marking a phase done so regressions surface early.',
			),
		);
	}

	const failureLoopArgs = {
		phase: 1,
		verdict: 'REJECT',
		findings: [
			{
				severity: 'high',
				category: 'failure_loop',
				description:
					'agents repeatedly tried to bypass the write-guard constraint',
			},
		],
	};

	test('proposes a draft skill when a failure_loop finding is present and feedback is enabled', async () => {
		writeConfig(true);
		await seedMatureKnowledge();
		const out = await run(failureLoopArgs);
		const parsed = JSON.parse(out);
		expect(parsed.skills_proposed).toBeGreaterThanOrEqual(1);
		expect(existsSync(`${tempDir}/.swarm/skills/proposals`)).toBe(true);
	});

	test('does NOT generate skills without a failure_loop finding (gating)', async () => {
		writeConfig(true);
		await seedMatureKnowledge();
		const out = await run({
			phase: 1,
			verdict: 'CONCERNS',
			findings: [
				{ severity: 'low', category: 'risk', description: 'minor risk' },
			],
		});
		expect(JSON.parse(out).skills_proposed).toBe(0);
	});

	test('does NOT generate skills when feedback is disabled (gating)', async () => {
		writeConfig(false);
		await seedMatureKnowledge();
		const out = await run(failureLoopArgs);
		expect(JSON.parse(out).skills_proposed).toBe(0);
	});
});
