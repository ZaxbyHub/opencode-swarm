import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	handleReportCommand,
	parseReportArgs,
	REPORT_JSON_SCHEMA_VERSION,
} from '../../../src/commands/report.js';
import {
	appendObservabilityEventDb,
	syncObservabilityImport,
} from '../../../src/db/observability-event-store.js';
import {
	closeAllProjectDbs,
	getProjectDb,
} from '../../../src/db/project-db.js';
import { createObservation } from '../../../src/observability/index.js';

function makeProject(): string {
	const dir = join(
		tmpdir(),
		`swarm-report-${Math.random().toString(36).slice(2, 10)}`,
	);
	mkdirSync(join(dir, '.swarm'), { recursive: true });
	return dir;
}

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) {
		const d = dirs.pop()!;
		closeAllProjectDbs();
		rmSync(d, { recursive: true, force: true });
	}
});

function seed(dir: string) {
	appendObservabilityEventDb(
		dir,
		createObservation('delegation_begin', {
			sessionId: 'sess-1',
			agentName: 'coder',
			taskId: 'task-9',
		}) as ReturnType<typeof createObservation>,
	);
	appendObservabilityEventDb(
		dir,
		createObservation('delegation_end', {
			sessionId: 'sess-1',
			agentName: 'coder',
			taskId: 'task-9',
			result: 'completed',
		}) as ReturnType<typeof createObservation>,
	);
	appendObservabilityEventDb(
		dir,
		createObservation('context_source_attribution', {
			sessionId: 'sess-1',
			taskId: 'task-9',
			source: 'context_pack',
			tokensReturned: 400,
			tokensSavedEstimate: 1600,
			estimate: true,
		}) as ReturnType<typeof createObservation>,
	);
}

describe('parseReportArgs', () => {
	test('accepts any subset of id filters + since + json', () => {
		const { parsed, error } = parseReportArgs([
			'--task',
			't1',
			'--session',
			's1',
			'--trace',
			'tr1',
			'--run',
			'b1',
			'--since',
			'2026-01-01T00:00:00Z',
			'--json',
		]);
		expect(error).toBeUndefined();
		expect(parsed!.filter).toEqual({
			taskId: 't1',
			sessionId: 's1',
			traceId: 'tr1',
			batchId: 'b1',
			since: '2026-01-01T00:00:00Z',
		});
		expect(parsed!.json).toBe(true);
	});
});

describe('handleReportCommand', () => {
	test('fail-open: a project with no store yields an explicit empty report, not an error', async () => {
		const dir = makeProject();
		dirs.push(dir);
		const md = await handleReportCommand(dir, []);
		expect(md).toContain('No observability store found');
		const json = await handleReportCommand(dir, ['--json']);
		expect(json).toContain('"unavailable":true');
	});

	test('coverage, pairing, and savings sections render with real rows', async () => {
		const dir = makeProject();
		dirs.push(dir);
		seed(dir);
		const md = await handleReportCommand(dir, []);
		expect(md).toContain('Swarm Observability Report');
		expect(md).toContain('**Coverage**');
		expect(md).toContain(
			'**Delegation pairing** — 1 begins / 1 ends; 0 unmatched',
		);
		expect(md).toContain('context_pack');
		// Determinism: identical output for the same cut.
		const md2 = await handleReportCommand(dir, []);
		expect(md).toBe(md2);
	});

	test('unmatched begins are disclosed, never fabricated', async () => {
		const dir = makeProject();
		dirs.push(dir);
		appendObservabilityEventDb(
			dir,
			createObservation('delegation_begin', {
				sessionId: 'sess-2',
				agentName: 'reviewer',
				taskId: 'task-x',
			}) as ReturnType<typeof createObservation>,
		);
		const md = await handleReportCommand(dir, []);
		expect(md).toContain('1 begins / 0 ends; 1 unmatched begin(s)');
	});

	test('--json emits a versioned schema block with coverage+pairing+savings', async () => {
		const dir = makeProject();
		dirs.push(dir);
		seed(dir);
		const out = await handleReportCommand(dir, ['--json']);
		expect(out).toContain('[REPORT_JSON]');
		const parsed = JSON.parse(
			out.slice('[REPORT_JSON]'.length, out.lastIndexOf('[/REPORT_JSON]')),
		) as Record<string, unknown>;
		expect(parsed.schemaVersion).toBe(REPORT_JSON_SCHEMA_VERSION);
		expect((parsed.coverage as Record<string, unknown>).totalRows).toBe(3);
		expect((parsed.pairing as Record<string, unknown>).begins).toBe(1);
		expect(Array.isArray(parsed.savings)).toBe(true);
		expect(Array.isArray(parsed.timeline)).toBe(true);
	});

	test('deterministic rebuild: delete imported rows + markers, re-import, identical report', async () => {
		const dir = makeProject();
		dirs.push(dir);
		writeFileSync(
			join(dir, '.swarm', 'telemetry.jsonl'),
			JSON.stringify({
				timestamp: '2026-01-01T00:00:00.000Z',
				event: 'gate_passed',
				sessionId: 's1',
				taskId: 't1',
			}) + '\n',
		);
		await handleReportCommand(dir, []); // triggers syncObservabilityImport
		const first = await handleReportCommand(dir, ['--json']);
		const db = getProjectDb(dir);
		db.run('DELETE FROM observability_event');
		db.run('DELETE FROM observability_import');
		const second = await handleReportCommand(dir, ['--json']);
		// The timeline rows must be byte-identical after full rebuild; only the
		// coverage.importedThisSync of the CURRENT sync differs (0 vs 1) — strip it.
		const strip = (s: string) =>
			s.replace(/"importedThisSync":\d+/, '"importedThisSync":X');
		expect(strip(second)).toBe(strip(first));
		expect(second).toContain('"importedRows":1');
	});

	test('filters narrow the timeline (session + task + since)', async () => {
		const dir = makeProject();
		dirs.push(dir);
		seed(dir);
		const md = await handleReportCommand(dir, [
			'--session',
			'sess-1',
			'--task',
			'task-9',
		]);
		expect(md).toContain('Timeline** — 3 event(s)');
		const none = await handleReportCommand(dir, ['--session', 'nope']);
		expect(none).toContain('0 unmatched'); // still a report, zero begins
		expect(none).not.toContain('3 event(s)');
	});
});
