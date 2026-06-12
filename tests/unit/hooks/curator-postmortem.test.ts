/**
 * Unit tests for the curator post-mortem agent (WP7, issue #1234).
 *
 * Validates: data collection, report generation, idempotency (dedup),
 * LLM fallback, and fail-open behavior.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	_internals,
	runCuratorPostMortem,
} from '../../../src/hooks/curator-postmortem.js';

// ============================================================================
// Helpers
// ============================================================================

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), 'postmortem-test-'));
}

function ensureSwarmDir(dir: string): string {
	const swarmDir = join(dir, '.swarm');
	mkdirSync(swarmDir, { recursive: true });
	return swarmDir;
}

function writePlan(
	dir: string,
	plan: {
		title: string;
		swarm: string;
		phases: Array<{
			id: number;
			name: string;
			status: string;
			tasks: unknown[];
		}>;
	},
): void {
	const swarmDir = ensureSwarmDir(dir);
	writeFileSync(
		join(swarmDir, 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			...plan,
		}),
	);
}

function writeKnowledge(
	dir: string,
	entries: Array<{
		id: string;
		lesson: string;
		confidence?: number;
		status?: string;
	}>,
): void {
	const swarmDir = ensureSwarmDir(dir);
	const lines = entries.map((e) =>
		JSON.stringify({
			id: e.id,
			lesson: e.lesson,
			category: 'lesson',
			status: e.status ?? 'active',
			confidence: e.confidence ?? 0.7,
			tags: [],
			scope: 'global',
			confirmed_by: [],
			project_name: 'test',
		}),
	);
	writeFileSync(join(swarmDir, 'knowledge.jsonl'), `${lines.join('\n')}\n`);
}

function writeEvents(
	dir: string,
	events: Array<{
		type: string;
		knowledge_id?: string;
		entry_id?: string;
		timestamp?: string;
	}>,
): void {
	const swarmDir = ensureSwarmDir(dir);
	const lines = events.map((e) =>
		JSON.stringify({
			type: e.type,
			event_id: randomUUID(),
			trace_id: randomUUID(),
			knowledge_id: e.knowledge_id,
			entry_id: e.entry_id,
			timestamp: e.timestamp ?? new Date().toISOString(),
			session_id: 'test-session',
			agent: 'test-agent',
		}),
	);
	writeFileSync(
		join(swarmDir, 'knowledge-events.jsonl'),
		`${lines.join('\n')}\n`,
	);
}

function writeCuratorSummary(dir: string, digest: string): void {
	const swarmDir = ensureSwarmDir(dir);
	writeFileSync(
		join(swarmDir, 'curator-summary.json'),
		JSON.stringify({
			schema_version: 1,
			session_id: 'test',
			last_updated: new Date().toISOString(),
			last_phase_covered: 2,
			digest,
			phase_digests: [],
			compliance_observations: [],
			knowledge_recommendations: [],
		}),
	);
}

// ============================================================================
// Tests
// ============================================================================

describe('runCuratorPostMortem', () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempDir();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test('generates a data-only report from .swarm/ evidence', async () => {
		const kid = randomUUID();
		writePlan(dir, {
			title: 'Test Project',
			swarm: 'test',
			phases: [
				{ id: 1, name: 'Phase 1', status: 'completed', tasks: [] },
				{ id: 2, name: 'Phase 2', status: 'completed', tasks: [] },
			],
		});
		writeKnowledge(dir, [
			{ id: kid, lesson: 'Always validate inputs before processing' },
		]);
		writeEvents(dir, [
			{ type: 'applied', knowledge_id: kid },
			{ type: 'applied', knowledge_id: kid },
			{ type: 'violated', knowledge_id: kid },
		]);
		writeCuratorSummary(dir, 'Phase 1 and 2 completed successfully.');

		const result = await runCuratorPostMortem(dir);

		expect(result.success).toBe(true);
		expect(result.planId).toBe('test-Test_Project');
		expect(result.reportPath).toBeTruthy();
		expect(existsSync(result.reportPath!)).toBe(true);
		expect(result.summary).toContain('1 knowledge entries');

		const content = readFileSync(result.reportPath!, 'utf-8');
		expect(content).toContain('Post-Mortem Report');
		expect(content).toContain('2 applied');
		expect(content).toContain('1 violated');
	});

	test('idempotent: skips if report already exists', async () => {
		writePlan(dir, {
			title: 'Test Project',
			swarm: 'test',
			phases: [{ id: 1, name: 'Phase 1', status: 'completed', tasks: [] }],
		});

		// First run creates the report
		const result1 = await runCuratorPostMortem(dir);
		expect(result1.success).toBe(true);

		// Second run skips (idempotent)
		const result2 = await runCuratorPostMortem(dir);
		expect(result2.success).toBe(true);
		expect(result2.summary).toContain('already exists');
	});

	test('--force overwrites existing report', async () => {
		writePlan(dir, {
			title: 'Test Project',
			swarm: 'test',
			phases: [{ id: 1, name: 'Phase 1', status: 'completed', tasks: [] }],
		});

		const result1 = await runCuratorPostMortem(dir);
		expect(result1.success).toBe(true);

		const result2 = await runCuratorPostMortem(dir, { force: true });
		expect(result2.success).toBe(true);
		expect(result2.summary).not.toContain('already exists');
	});

	test('falls back to data-only when LLM delegate fails', async () => {
		writePlan(dir, {
			title: 'Test Project',
			swarm: 'test',
			phases: [{ id: 1, name: 'Phase 1', status: 'completed', tasks: [] }],
		});

		const failingDelegate = async () => {
			throw new Error('LLM unavailable');
		};

		const result = await runCuratorPostMortem(dir, {
			llmDelegate: failingDelegate,
			force: true,
		});

		expect(result.success).toBe(true);
		expect(result.warnings).toContainEqual(
			expect.stringContaining('LLM delegate failed'),
		);
	});

	test('succeeds with no .swarm/ data (minimal report)', async () => {
		ensureSwarmDir(dir);

		const result = await runCuratorPostMortem(dir);

		expect(result.success).toBe(true);
		expect(result.planId).toBe('unknown');
		expect(result.warnings).toContainEqual(
			expect.stringContaining('Plan not found'),
		);
	});

	test('flags never-applied entries in the report', async () => {
		const applied = randomUUID();
		const stale = randomUUID();
		writePlan(dir, {
			title: 'Stale Test',
			swarm: 'test',
			phases: [{ id: 1, name: 'Phase 1', status: 'completed', tasks: [] }],
		});
		writeKnowledge(dir, [
			{ id: applied, lesson: 'This entry was applied' },
			{ id: stale, lesson: 'This entry was never applied' },
		]);
		writeEvents(dir, [{ type: 'applied', knowledge_id: applied }]);

		const result = await runCuratorPostMortem(dir, { force: true });
		expect(result.success).toBe(true);

		const content = readFileSync(result.reportPath!, 'utf-8');
		expect(content).toContain('Never-Applied Entries');
		expect(content).toContain(stale);
	});

	test('includes pending proposals and quarantine counts in report', async () => {
		writePlan(dir, {
			title: 'Queue Test',
			swarm: 'test',
			phases: [{ id: 1, name: 'Phase 1', status: 'completed', tasks: [] }],
		});

		const swarmDir = ensureSwarmDir(dir);
		writeFileSync(
			join(swarmDir, 'insight-candidates.jsonl'),
			`${JSON.stringify({ type: 'motif', description: 'test motif' })}\n`,
		);
		writeFileSync(
			join(swarmDir, 'knowledge-unactionable.jsonl'),
			`${JSON.stringify({ id: 'q1', lesson: 'quarantined', status: 'quarantined' })}\n${JSON.stringify({ id: 'q2', lesson: 'quarantined too', status: 'quarantined' })}\n`,
		);

		const result = await runCuratorPostMortem(dir, { force: true });
		expect(result.success).toBe(true);

		const content = readFileSync(result.reportPath!, 'utf-8');
		expect(content).toContain('Pending proposals: 1');
		expect(content).toContain('Unactionable quarantine: 2');
	});

	test('includes drift reports in the output', async () => {
		writePlan(dir, {
			title: 'Drift Test',
			swarm: 'test',
			phases: [{ id: 1, name: 'Phase 1', status: 'completed', tasks: [] }],
		});

		const swarmDir = ensureSwarmDir(dir);
		writeFileSync(
			join(swarmDir, 'drift-report-phase-1.json'),
			JSON.stringify({
				phase: 1,
				alignment: 'ALIGNED',
				drift_score: 0.0,
			}),
		);

		const result = await runCuratorPostMortem(dir, { force: true });
		expect(result.success).toBe(true);

		const content = readFileSync(result.reportPath!, 'utf-8');
		expect(content).toContain('Phase 1: ALIGNED');
	});

	test('includes retrospectives when present', async () => {
		writePlan(dir, {
			title: 'Retro Test',
			swarm: 'test',
			phases: [{ id: 1, name: 'Phase 1', status: 'completed', tasks: [] }],
		});

		const retroDir = join(dir, '.swarm', 'evidence', 'retro-1');
		mkdirSync(retroDir, { recursive: true });
		writeFileSync(
			join(retroDir, 'evidence.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				task_id: 'retro-1',
				entries: [
					{
						type: 'retrospective',
						task_id: 'retro-1',
						timestamp: new Date().toISOString(),
						agent: 'architect',
						verdict: 'pass',
						summary: 'Phase went well',
					},
				],
			}),
		);

		const result = await runCuratorPostMortem(dir, { force: true });
		expect(result.success).toBe(true);

		const content = readFileSync(result.reportPath!, 'utf-8');
		expect(content).toContain('Retrospectives');
		expect(content).toContain('1 phase retrospective(s)');
	});
});

describe('_internals.collectKnowledgeSummary', () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempDir();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test('aggregates event counts per knowledge entry', async () => {
		const kid = randomUUID();
		writeKnowledge(dir, [{ id: kid, lesson: 'test lesson', confidence: 0.8 }]);
		writeEvents(dir, [
			{ type: 'applied', knowledge_id: kid },
			{ type: 'applied', knowledge_id: kid },
			{ type: 'violated', knowledge_id: kid },
			{ type: 'ignored', knowledge_id: kid },
		]);

		const summary = await _internals.collectKnowledgeSummary(dir);

		expect(summary).toHaveLength(1);
		expect(summary[0].id).toBe(kid);
		expect(summary[0].applied).toBe(2);
		expect(summary[0].violated).toBe(1);
		expect(summary[0].ignored).toBe(1);
		expect(summary[0].confidence).toBe(0.8);
	});
});
