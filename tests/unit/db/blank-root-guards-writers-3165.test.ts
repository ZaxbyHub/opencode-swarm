/**
 * #3165 section B, review F-01: the swarm.db stores that canonicalize a root
 * BEFORE calling getProjectDb never reached its blank-root guard, because
 * `canonicalProjectKey('')` is the absolute cwd. Each test pins the cwd to a
 * sandbox and checks that a blank root neither creates `<cwd>/.swarm` nor
 * reaches state that belongs to the cwd project.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { ProjectDbError } from '../../../src/db/db-errors.js';
import {
	closeAllGroupCommitWriters,
	closeGroupCommitWriter,
	getGroupCommitWriter,
	getOpenGroupCommitWriterCount,
} from '../../../src/db/group-commit-writer.js';
import {
	_resetInsightImportGuards,
	appendInsightCandidatesDb,
	consumeInsightCandidatesDb,
	countPendingInsightCandidatesDb,
	listPendingInsightCandidatesDb,
} from '../../../src/db/insight-candidate-store.js';
import {
	importLegacyJsonFiles,
	importLegacyJsonl,
} from '../../../src/db/legacy-import.js';
import {
	appendObservabilityEventDb,
	_internals as obsInternals,
	queryObservabilityEvents,
	readObservabilityCoverage,
	readObservabilitySinkHealth,
	registerObservabilityEventSink,
	resetObservabilityEventSinkForTesting,
	syncObservabilityImport,
} from '../../../src/db/observability-event-store.js';
import {
	_resetPhaseReportImportGuards,
	readPhaseReportsDb,
	upsertPhaseReportDb,
} from '../../../src/db/phase-report-store.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import { createObservation } from '../../../src/observability/index.js';
import {
	initTelemetry,
	resetTelemetryForTesting,
	telemetry,
} from '../../../src/telemetry.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const BLANKS = ['', '   ', ' \n\t '];

let sandbox: string;
const originalCwd = process.cwd();

beforeEach(() => {
	sandbox = canonicalMkdtemp('blank-root-writers-3165-');
	process.chdir(sandbox);
});

afterEach(() => {
	process.chdir(originalCwd);
	try {
		resetObservabilityEventSinkForTesting();
		resetTelemetryForTesting();
		closeAllGroupCommitWriters();
		closeAllProjectDbs();
		_resetPhaseReportImportGuards();
		_resetInsightImportGuards();
	} finally {
		safeRmRecursive(sandbox);
	}
});

function cwdSwarmCreated(): boolean {
	return existsSync(path.join(sandbox, '.swarm'));
}

function writeCwdSwarmFile(name: string, content: string): string {
	mkdirSync(path.join(sandbox, '.swarm'), { recursive: true });
	const file = path.join(sandbox, '.swarm', name);
	writeFileSync(file, content);
	return file;
}

function expectInvalidRoot(fn: () => unknown): void {
	let caught: unknown;
	try {
		fn();
	} catch (err) {
		caught = err;
	}
	expect(caught).toBeInstanceOf(ProjectDbError);
	expect((caught as ProjectDbError).category).toBe('invalid_root');
}

async function expectInvalidRootAsync(fn: () => Promise<unknown>) {
	let caught: unknown;
	try {
		await fn();
	} catch (err) {
		caught = err;
	}
	expect(caught).toBeInstanceOf(ProjectDbError);
	expect((caught as ProjectDbError).category).toBe('invalid_root');
}

/**
 * Record the observability store's DB seams. The writer is a stub that never
 * opens a DB, so in-memory counters can be observed without a swarm.db.
 */
function withObservabilitySeams(run: (calls: string[]) => void): void {
	const calls: string[] = [];
	const original = {
		getProjectDb: obsInternals.getProjectDb,
		getGroupCommitWriter: obsInternals.getGroupCommitWriter,
	};
	obsInternals.getProjectDb = (dir) => {
		calls.push(`db:${dir}`);
		return original.getProjectDb(dir);
	};
	obsInternals.getGroupCommitWriter = (dir) => {
		calls.push(`writer:${dir}`);
		return { enqueue: () => {}, flushSync: () => {} } as never;
	};
	try {
		run(calls);
	} finally {
		obsInternals.getProjectDb = original.getProjectDb;
		obsInternals.getGroupCommitWriter = original.getGroupCommitWriter;
	}
}

function sampleEvent() {
	return createObservation('gate_passed', {
		sessionId: 'sess-blank',
		taskId: 'task-1',
		gate: 'review',
	}) as ReturnType<typeof createObservation>;
}

describe('group-commit writer — regression: a blank root reached the cwd writer (#3165 B F-01)', () => {
	test('getGroupCommitWriter throws invalid_root and never returns the cwd writer', () => {
		// Previous code keyed the lookup by canonicalProjectKey(''), the cwd, so
		// it returned the cwd project's cached writer.
		const cwdWriter = getGroupCommitWriter(sandbox);
		for (const blank of BLANKS) {
			expectInvalidRoot(() => getGroupCommitWriter(blank));
		}
		expect(getGroupCommitWriter(sandbox)).toBe(cwdWriter);
	});

	test('closeGroupCommitWriter on a blank root leaves the cwd writer open', () => {
		// Previous code flushed, closed and evicted the cwd project's writer.
		const cwdWriter = getGroupCommitWriter(sandbox);
		for (const blank of BLANKS) closeGroupCommitWriter(blank);
		expect(getOpenGroupCommitWriterCount()).toBe(1);
		expect(getGroupCommitWriter(sandbox)).toBe(cwdWriter);
	});
});

describe('observability store — regression: a blank root wrote <cwd>/.swarm/swarm.db (#3165 B F-01)', () => {
	test('appendObservabilityEventDb throws invalid_root before any counter moves', () => {
		// Previous code canonicalized '' to the cwd, bumped the cwd's health
		// counters, then created `.swarm/swarm.db` there ('   ' made a
		// whitespace-named directory with its own .swarm).
		withObservabilitySeams((calls) => {
			for (const blank of BLANKS) {
				expectInvalidRoot(() =>
					appendObservabilityEventDb(blank, sampleEvent()),
				);
			}
			expect(calls).toEqual([]);
		});
		// No cwd counters: with no DB, the health read returns in-memory deltas.
		expect(readObservabilitySinkHealth(sandbox)).toBeNull();
		expect(cwdSwarmCreated()).toBe(false);
	});

	test('appendObservabilityEventDb on a blank root creates no cwd .swarm', () => {
		for (const blank of BLANKS) {
			expectInvalidRoot(() => appendObservabilityEventDb(blank, sampleEvent()));
		}
		expect(cwdSwarmCreated()).toBe(false);
		expect(readdirSync(sandbox)).toEqual([]);
	});

	test('registerObservabilityEventSink on a blank root keeps the project binding', async () => {
		// Previous code rebound the sink to the cwd, so the next telemetry
		// event created `<cwd>/.swarm/swarm.db`.
		const project = canonicalMkdtemp('blank-root-writers-3165-sink-');
		try {
			resetTelemetryForTesting();
			initTelemetry(project);
			registerObservabilityEventSink(project);
			for (const blank of BLANKS) registerObservabilityEventSink(blank);
			telemetry.sessionStarted('after-blank', 'architect');
			expect(queryObservabilityEvents(project, {}).rows.length).toBe(1);
			expect(cwdSwarmCreated()).toBe(false);
		} finally {
			resetObservabilityEventSinkForTesting();
			resetTelemetryForTesting();
			closeAllGroupCommitWriters();
			closeAllProjectDbs();
			safeRmRecursive(project);
		}
	});

	test('syncObservabilityImport throws invalid_root before flushing or opening anything', () => {
		// Previous code flushed the writer for '' (the cwd's, when cached) and
		// stat'ed the cwd's legacy stream before getProjectDb refused the root.
		writeCwdSwarmFile('telemetry.jsonl', '{"event":"session_started"}\n');
		withObservabilitySeams((calls) => {
			for (const blank of BLANKS) {
				expectInvalidRoot(() => syncObservabilityImport(blank));
			}
			expect(calls).toEqual([]);
		});
		expect(existsSync(path.join(sandbox, '.swarm', 'swarm.db'))).toBe(false);
	});

	test('readObservabilitySinkHealth returns null instead of the cwd counters', () => {
		// Previous code returned the cwd project's in-memory health delta.
		withObservabilitySeams(() => {
			appendObservabilityEventDb(sandbox, sampleEvent());
		});
		expect(readObservabilitySinkHealth(sandbox)?.accepted).toBe(1);
		for (const blank of BLANKS) {
			expect(readObservabilitySinkHealth(blank)).toBeNull();
		}
	});

	test('readObservabilityCoverage returns null even when the cwd has a legacy stream', () => {
		// Previous code found the cwd's telemetry.jsonl, then threw from
		// getProjectDb('') instead of reporting "unavailable".
		writeCwdSwarmFile('telemetry.jsonl', '{"event":"session_started"}\n');
		for (const blank of BLANKS) {
			expect(readObservabilityCoverage(blank)).toBeNull();
		}
		expect(existsSync(path.join(sandbox, '.swarm', 'swarm.db'))).toBe(false);
	});
});

describe('phase-report store — regression: a blank root reached the cwd project (#3165 B F-01)', () => {
	test('upsertPhaseReportDb throws invalid_root instead of writing through the cwd writer', async () => {
		// Previous code reused the cwd project's cached writer and wrote the
		// report into the cwd project's swarm.db.
		getGroupCommitWriter(sandbox);
		for (const blank of BLANKS) {
			await expectInvalidRootAsync(() =>
				upsertPhaseReportDb(blank, 'curator_drift', 1, '{}'),
			);
		}
		expect(readPhaseReportsDb(sandbox, 'curator_drift')).toEqual([]);
	});

	test('readPhaseReportsDb returns [] and leaves the cwd legacy report alone', () => {
		// Previous code saw the cwd's legacy report, tried to import it and
		// threw from getProjectDb('').
		const legacy = writeCwdSwarmFile('drift-report-phase-1.json', '{}');
		for (const blank of BLANKS) {
			expect(readPhaseReportsDb(blank, 'curator_drift')).toEqual([]);
		}
		expect(existsSync(legacy)).toBe(true);
		expect(existsSync(path.join(sandbox, '.swarm', 'swarm.db'))).toBe(false);
	});
});

describe('insight-candidate store — regression: a blank root reached the cwd project (#3165 B F-01)', () => {
	test('appendInsightCandidatesDb throws invalid_root instead of writing through the cwd writer', async () => {
		getGroupCommitWriter(sandbox);
		for (const blank of BLANKS) {
			await expectInvalidRootAsync(() =>
				appendInsightCandidatesDb(blank, [
					{ payload: '{}', createdAt: '2026-01-01T00:00:00.000Z' },
				]),
			);
		}
		expect(countPendingInsightCandidatesDb(sandbox)).toBe(0);
	});

	test('the read paths report no candidates and leave the cwd legacy queue alone', () => {
		// Previous code saw the cwd's legacy queue, tried to import it and
		// threw from getProjectDb('').
		const legacy = writeCwdSwarmFile('insight-candidates.jsonl', '{}\n');
		for (const blank of BLANKS) {
			expect(countPendingInsightCandidatesDb(blank)).toBe(0);
			expect(listPendingInsightCandidatesDb(blank, 10)).toEqual([]);
			expect(consumeInsightCandidatesDb(blank, 10)).toEqual([]);
		}
		expect(existsSync(legacy)).toBe(true);
		expect(existsSync(path.join(sandbox, '.swarm', 'swarm.db'))).toBe(false);
	});
});

describe('legacy import — regression: a blank root read the cwd .swarm (#3165 B F-01)', () => {
	test('importLegacyJsonl and importLegacyJsonFiles throw invalid_root even with nothing to import', () => {
		// Previous code looked in the cwd's .swarm and, finding nothing,
		// returned an empty result as if a project had been checked.
		for (const blank of BLANKS) {
			expectInvalidRoot(() =>
				importLegacyJsonl(blank, {
					fileName: 'insight-candidates.jsonl',
					streamCount: () => 0,
					insertRow: () => {},
					parseLine: (line) => line,
				}),
			);
			expectInvalidRoot(() =>
				importLegacyJsonFiles(blank, {
					filePrefix: 'drift-report-phase-',
					kind: 'curator_drift',
					kindCount: () => 0,
					upsertRow: () => {},
				}),
			);
		}
		expect(cwdSwarmCreated()).toBe(false);
	});
});
