import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { saveEvidence } from '../../../src/evidence/manager';
import {
	type ArchitectureSupervisorReport,
	normalizeAgentWorkSummary,
	type PhaseArchitectureSummary,
	SUMMARY_SCHEMA_VERSION,
} from '../../../src/summaries/schema';
import {
	AGENT_SUMMARY_METADATA_KIND,
	listAgentSummaries,
	readPhaseArchitectureSummary,
	readSupervisorReportRaw,
	writeAgentSummary,
	writePhaseArchitectureSummary,
	writeSupervisorReport,
} from '../../../src/summaries/store';

let tempDir: string;

beforeEach(() => {
	tempDir = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'swarm-summaries-')),
	);
	mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function makeSummary(
	overrides: Partial<Parameters<typeof normalizeAgentWorkSummary>[0]> = {},
) {
	return normalizeAgentWorkSummary({
		phase: 1,
		task_id: '1.1',
		session_id: 's1',
		agent: 'coder',
		summary: 'implemented the parser',
		key_decisions: ['used recursive descent'],
		...overrides,
	});
}

describe('writeAgentSummary / listAgentSummaries', () => {
	test('round-trips a stored summary', async () => {
		await writeAgentSummary(tempDir, makeSummary());
		const found = await listAgentSummaries(tempDir, { phase: 1 });
		expect(found).toHaveLength(1);
		expect(found[0].agent).toBe('coder');
		expect(found[0].key_decisions).toEqual(['used recursive descent']);
	});

	test('filters by phase', async () => {
		await writeAgentSummary(tempDir, makeSummary({ phase: 1, task_id: '1.1' }));
		await writeAgentSummary(tempDir, makeSummary({ phase: 2, task_id: '2.1' }));
		const p1 = await listAgentSummaries(tempDir, { phase: 1 });
		const p2 = await listAgentSummaries(tempDir, { phase: 2 });
		expect(p1).toHaveLength(1);
		expect(p2).toHaveLength(1);
		expect(p1[0].phase).toBe(1);
		expect(p2[0].phase).toBe(2);
	});

	test('filters by session', async () => {
		await writeAgentSummary(
			tempDir,
			makeSummary({ session_id: 'sA', task_id: '1.1' }),
		);
		await writeAgentSummary(
			tempDir,
			makeSummary({ session_id: 'sB', task_id: '1.2' }),
		);
		const a = await listAgentSummaries(tempDir, { session: 'sA' });
		expect(a).toHaveLength(1);
		expect(a[0].session_id).toBe('sA');
	});

	test('collects multiple agents that share one task bundle', async () => {
		await writeAgentSummary(tempDir, makeSummary({ agent: 'coder' }));
		await writeAgentSummary(
			tempDir,
			makeSummary({ agent: 'test_engineer', summary: 'added tests' }),
		);
		const found = await listAgentSummaries(tempDir, { phase: 1 });
		expect(found.map((s) => s.agent).sort()).toEqual([
			'coder',
			'test_engineer',
		]);
	});

	test('skips malformed agent-summary payloads without throwing', async () => {
		// Hand-write a note entry whose payload fails AgentWorkSummarySchema.
		await saveEvidence(tempDir, '9.9', {
			task_id: '9.9',
			type: 'note',
			timestamp: new Date().toISOString(),
			agent: 'coder',
			verdict: 'info',
			summary: 'broken',
			metadata: {
				kind: AGENT_SUMMARY_METADATA_KIND,
				phase: 1,
				session_id: 's1',
				payload: { not: 'a valid summary' },
			},
		});
		const found = await listAgentSummaries(tempDir, { phase: 1 });
		expect(found).toHaveLength(0);
	});

	test('ignores note entries that are not agent summaries', async () => {
		await saveEvidence(tempDir, '5.5', {
			task_id: '5.5',
			type: 'note',
			timestamp: new Date().toISOString(),
			agent: 'coder',
			verdict: 'info',
			summary: 'just a note',
		});
		const found = await listAgentSummaries(tempDir, {});
		expect(found).toHaveLength(0);
	});
});

describe('phase architecture summary sidecar', () => {
	test('write then read returns the same content', () => {
		const summary: PhaseArchitectureSummary = {
			schema_version: SUMMARY_SCHEMA_VERSION,
			phase: 3,
			summary: 'phase rollup',
			agents_seen: ['coder', 'test_engineer'],
			tasks_seen: ['3.1'],
			key_decisions: ['db is redis'],
			conflicts: [],
			unresolved_risks: [],
			constraint_violations: [],
			evidence_refs: [],
			created_at: new Date().toISOString(),
		};
		writePhaseArchitectureSummary(tempDir, summary);
		const read = readPhaseArchitectureSummary(tempDir, 3);
		expect(read?.summary).toBe('phase rollup');
		expect(read?.agents_seen).toEqual(['coder', 'test_engineer']);
	});

	test('read returns null when missing', () => {
		expect(readPhaseArchitectureSummary(tempDir, 7)).toBeNull();
	});
});

describe('supervisor report sidecar', () => {
	const report: ArchitectureSupervisorReport = {
		schema_version: SUMMARY_SCHEMA_VERSION,
		phase: 4,
		verdict: 'REJECT',
		findings: [
			{
				severity: 'high',
				category: 'contradiction',
				agents: ['coder', 'test_engineer'],
				tasks: ['4.1', '4.2'],
				evidence_refs: [],
				description: 'redis vs in-memory store',
				recommendation: 'pick one',
			},
		],
		knowledge_recommendations: [],
		created_at: new Date().toISOString(),
	};

	test('writes a raw bundle whose top-level verdict survives', () => {
		writeSupervisorReport(tempDir, report);
		const raw = readSupervisorReportRaw(tempDir, 4);
		expect(raw).not.toBeNull();
		expect(raw?.verdict).toBe('REJECT');
		expect(raw?.phase_number).toBe(4);
		expect(raw?.timestamp).toBe(report.created_at);
		expect(raw?.findings).toHaveLength(1);
	});

	test('read returns null when missing', () => {
		expect(readSupervisorReportRaw(tempDir, 99)).toBeNull();
	});
});
