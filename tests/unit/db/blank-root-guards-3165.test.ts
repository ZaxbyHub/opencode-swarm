/**
 * #3165 section B: `.swarm` stores refuse a blank (and, where no caller needs
 * one, a relative) project root instead of resolving it against
 * process.cwd(). Each test runs with the cwd pinned to a sandbox and asserts
 * no `.swarm/` appeared there.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { handleDoctorCommand } from '../../../src/commands/doctor.js';
import type { CorpusReaders } from '../../../src/consensus/corpus.js';
import {
	listEvaluationRunIds,
	listTrajectorySessions,
	loadConsensusCorpus,
} from '../../../src/consensus/corpus.js';
import { mineAndStoreConsensusV1 } from '../../../src/consensus/public-api.js';
import { ProjectDbError } from '../../../src/db/db-errors.js';
import {
	closeProjectDb,
	getProjectDb,
	projectDbExists,
	projectDbPath,
	withProjectDbReadOnly,
} from '../../../src/db/project-db.js';
import {
	appendCoreEventSync,
	appendCoreEventsSync,
	CORE_EVENT_NO_STORE,
} from '../../../src/events/core-events.js';
import { recordSteeringConsumed } from '../../../src/hooks/steering-consumed.js';
import { getDiagnoseData } from '../../../src/services/diagnose-service.js';
import { writeSnapshot } from '../../../src/session/snapshot-writer.js';
import {
	flushAndDrainTelemetry,
	initTelemetry,
	resetTelemetryForTesting,
	telemetry,
} from '../../../src/telemetry.js';
import {
	isBlankDirectory,
	isNonBlankAbsoluteDirectory,
} from '../../../src/utils/path-security.js';
import {
	assertProjectRoot,
	resolveProjectRootDecision,
} from '../../../src/utils/project-boundary.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const BLANKS = ['', '   ', ' \n\t '];

let sandbox: string;
const originalCwd = process.cwd();

beforeEach(() => {
	sandbox = canonicalMkdtemp('blank-root-3165-');
	process.chdir(sandbox);
});

afterEach(() => {
	process.chdir(originalCwd);
	try {
		closeProjectDb(sandbox);
	} finally {
		safeRmRecursive(sandbox);
	}
});

function cwdSwarmCreated(): boolean {
	return existsSync(path.join(sandbox, '.swarm'));
}

describe('path-security root predicates (#3165 B)', () => {
	test('isBlankDirectory', () => {
		for (const blank of BLANKS) expect(isBlankDirectory(blank)).toBe(true);
		expect(isBlankDirectory(undefined)).toBe(true);
		expect(isBlankDirectory(42)).toBe(true);
		expect(isBlankDirectory('proj')).toBe(false);
		expect(isBlankDirectory(sandbox)).toBe(false);
	});

	test('isNonBlankAbsoluteDirectory', () => {
		for (const blank of BLANKS) {
			expect(isNonBlankAbsoluteDirectory(blank)).toBe(false);
		}
		expect(isNonBlankAbsoluteDirectory('proj')).toBe(false);
		expect(isNonBlankAbsoluteDirectory('.')).toBe(false);
		expect(isNonBlankAbsoluteDirectory(sandbox)).toBe(true);
	});
});

describe('getProjectDb — regression: a blank root opened <cwd>/.swarm/swarm.db (#3165 B)', () => {
	test('a blank root throws a typed invalid_root error and creates nothing in the cwd', () => {
		// Previous code ran resolve(''), which is process.cwd(), then created
		// `.swarm/swarm.db` there.
		for (const blank of BLANKS) {
			let caught: unknown;
			try {
				getProjectDb(blank);
			} catch (err) {
				caught = err;
			}
			expect(caught).toBeInstanceOf(ProjectDbError);
			expect((caught as ProjectDbError).category).toBe('invalid_root');
		}
		expect(cwdSwarmCreated()).toBe(false);
	});

	test('projectDbPath throws and projectDbExists / withProjectDbReadOnly report no DB for a blank root', () => {
		// A real DB in the cwd must not be found through a blank root.
		getProjectDb(sandbox);
		expect(projectDbExists(sandbox)).toBe(true);
		for (const blank of BLANKS) {
			expect(() => projectDbPath(blank)).toThrow(ProjectDbError);
			expect(projectDbExists(blank)).toBe(false);
			expect(withProjectDbReadOnly(blank, () => 'read')).toBeNull();
		}
	});

	test('closeProjectDb on a blank root leaves the cwd project handle open', () => {
		// lexicalAliasKey('') resolves the cwd, so an unguarded close could
		// release the cwd project's live connection.
		const db = getProjectDb(sandbox);
		for (const blank of BLANKS) closeProjectDb(blank);
		expect(() => db.query('SELECT 1').get()).not.toThrow();
		expect(getProjectDb(sandbox)).toBe(db);
	});

	test('a relative root still resolves (save_plan / declare_scope pass one through today)', () => {
		const db = getProjectDb('.');
		expect(db).toBeDefined();
		expect(existsSync(path.join(sandbox, '.swarm', 'swarm.db'))).toBe(true);
	});
});

describe('getDiagnoseData — regression: a blank or relative root diagnosed the cwd (#3165 B)', () => {
	test('reports one failing Project directory check and touches no cwd .swarm', async () => {
		for (const bad of [...BLANKS, 'relative/proj']) {
			const result = await getDiagnoseData(bad);
			expect(result.allPassed).toBe(false);
			expect(result.totalCount).toBe(1);
			expect(result.checks[0]?.name).toBe('Project directory');
			expect(result.checks[0]?.status).toBe('❌');
		}
		expect(cwdSwarmCreated()).toBe(false);
	});

	test('an absolute root still runs the full diagnosis', async () => {
		const result = await getDiagnoseData(sandbox);
		expect(result.totalCount).toBeGreaterThan(1);
		expect(result.checks.some((c) => c.name === 'Project directory')).toBe(
			false,
		);
	});
});

describe('listTrajectorySessions — regression: a blank or relative root listed <cwd>/.swarm/trajectories (#3165 B)', () => {
	test('a blank or relative root throws even when the cwd has trajectories', async () => {
		// Previous code joined the root with '.swarm/trajectories' and listed the
		// cwd's sessions.
		const trajectories = path.join(sandbox, '.swarm', 'trajectories');
		mkdirSync(trajectories, { recursive: true });
		writeFileSync(path.join(trajectories, 'ses_cwd.jsonl'), '');
		for (const bad of [...BLANKS, '.', 'relative/proj']) {
			await expect(listTrajectorySessions(bad)).rejects.toThrow(
				'non-blank absolute path',
			);
		}
		expect(await listTrajectorySessions(sandbox)).toEqual(['ses_cwd']);
	});
});

describe('consensus corpus readers — regression: a blank or relative root read <cwd>/.swarm (#3165 B)', () => {
	test('listEvaluationRunIds throws for a blank or relative root even when the cwd has runs', async () => {
		const runs = path.join(sandbox, '.swarm', 'evolution', 'runs');
		mkdirSync(runs, { recursive: true });
		writeFileSync(path.join(runs, 'run_cwd.json'), '{}');
		for (const bad of [...BLANKS, '.', 'relative/proj']) {
			await expect(listEvaluationRunIds(bad)).rejects.toThrow(
				'non-blank absolute path',
			);
		}
		expect(await listEvaluationRunIds(sandbox)).toEqual(['run_cwd']);
	});

	test('loadConsensusCorpus throws before calling any reader for a blank or relative root', async () => {
		// The per-source catch would otherwise record an enumerator's refusal as
		// an unreadable source while the other readers still read the cwd.
		const calls: string[] = [];
		const names: (keyof CorpusReaders)[] = [
			'listEvaluationRunIds',
			'readEvaluationRun',
			'listGateAuditResults',
			'readGateGroundTruth',
			'listEvidenceTaskIds',
			'readTaskTrajectory',
			'listTrajectorySessions',
			'readTrajectory',
			'readSkillUsageEntries',
			'readKnowledgeEntries',
			'loadEvidence',
			'readRejectedLessons',
			'readRejectedSkillEdits',
			'readTrajectoryWithCoverage',
			'readSkillUsageEntriesWithCoverage',
		];
		const readers = Object.fromEntries(
			names.map((name) => [
				name,
				() => {
					calls.push(name);
					throw new Error(`${name} must not run`);
				},
			]),
		) as unknown as CorpusReaders;
		for (const bad of [...BLANKS, '.', 'relative/proj']) {
			await expect(
				loadConsensusCorpus(bad, {
					maxEvidenceItems: 10,
					maxExcerptChars: 100,
					readers,
				}),
			).rejects.toThrow('non-blank absolute path');
		}
		expect(calls).toEqual([]);
	});

	test('mineAndStoreConsensusV1 throws before reading the cwd report store', async () => {
		// The prior-fingerprint read ran before the corpus guard. A FILE where the
		// report directory belongs makes that read fail with ENOTDIR, so the
		// error shows which ran first.
		const evolution = path.join(sandbox, '.swarm', 'evolution');
		mkdirSync(evolution, { recursive: true });
		writeFileSync(path.join(evolution, 'consensus'), 'not a directory');
		for (const bad of [...BLANKS, 'relative/proj']) {
			await expect(
				mineAndStoreConsensusV1({
					directory: bad,
					request: {} as never,
					deps: {} as never,
				}),
			).rejects.toThrow('non-blank absolute path');
		}
	});
});

describe('shared .swarm write seams — regression: a blank root wrote under the cwd (#3165 B)', () => {
	test('assertProjectRoot refuses a blank root', () => {
		// Previous code ran realpath(''), which is the cwd, and passed.
		for (const blank of BLANKS) {
			expect(() => assertProjectRoot(blank)).toThrow('blank directory');
		}
		expect(() => assertProjectRoot(sandbox)).not.toThrow();
	});

	test('resolveProjectRootDecision (plugin init) fails closed for a blank root', () => {
		// Previous code resolved '' to the cwd and returned kind 'root', so
		// plugin init wrote .swarm/ state there.
		for (const blank of BLANKS) {
			expect(resolveProjectRootDecision(blank).kind).toBe('fail-closed');
		}
		expect(resolveProjectRootDecision(sandbox)).toEqual({
			kind: 'root',
			directory: sandbox,
		});
	});

	test('handleDoctorCommand on a blank root creates no receipt ledger in the cwd', async () => {
		// The receipt ledger resolves its root through assertProjectRoot.
		await handleDoctorCommand('', []);
		expect(cwdSwarmCreated()).toBe(false);
	});

	test('the core-event append seams refuse a blank root and leave the cwd events.jsonl untouched', () => {
		mkdirSync(path.join(sandbox, '.swarm'), { recursive: true });
		const events = path.join(sandbox, '.swarm', 'events.jsonl');
		writeFileSync(events, '');
		for (const blank of BLANKS) {
			expect(() => appendCoreEventSync(blank, { type: 'probe' })).toThrow(
				CORE_EVENT_NO_STORE,
			);
			expect(() => appendCoreEventsSync(blank, [{ type: 'probe' }])).toThrow(
				CORE_EVENT_NO_STORE,
			);
			recordSteeringConsumed(blank, 'directive-1');
		}
		expect(readFileSync(events, 'utf8')).toBe('');
	});

	test('initTelemetry on a blank root is a no-op and creates no cwd .swarm', () => {
		resetTelemetryForTesting(); // a disabled module would pass vacuously
		try {
			for (const blank of BLANKS) initTelemetry(blank);
			expect(cwdSwarmCreated()).toBe(false);
		} finally {
			resetTelemetryForTesting();
		}
	});

	test('initTelemetry on a blank root keeps the open project stream', async () => {
		const project = canonicalMkdtemp('blank-root-3165-telemetry-');
		resetTelemetryForTesting();
		try {
			initTelemetry(project);
			for (const blank of BLANKS) initTelemetry(blank);
			telemetry.sessionStarted('after-blank', 'architect');
			await flushAndDrainTelemetry();
			const log = path.join(project, '.swarm', 'telemetry.jsonl');
			expect(readFileSync(log, 'utf8')).toContain('after-blank');
			expect(cwdSwarmCreated()).toBe(false);
		} finally {
			resetTelemetryForTesting();
			safeRmRecursive(project);
		}
	});

	test('writeSnapshot on a blank root creates no cwd .swarm', async () => {
		// Covered by the snapshot-coordination guard, which refuses a blank
		// root before the cwd project's coordination is initialized.
		const state = {
			toolAggregates: new Map(),
			activeAgent: new Map(),
			delegationChains: new Map(),
			agentSessions: new Map(),
		};
		await writeSnapshot('', state as never);
		expect(cwdSwarmCreated()).toBe(false);
	});
});
