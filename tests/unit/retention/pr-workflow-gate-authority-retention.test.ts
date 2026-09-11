import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
	_internals as coordinationInternals,
	getCoordinationState,
} from '../../../src/db/coordination-store.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	CORE_EVENT_LIMITS,
	readCoreEvents,
} from '../../../src/events/core-events.js';
import {
	abortPrWorkflow,
	activatePrWorkflow,
	_test_exports as gateInternals,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	prWorkflowSessionFileStem,
	readPrWorkflowGateStateFromCoordination,
	readPrWorkflowGateStateFromDisk,
	workflowGateStatePath,
} from '../../../src/pr-review/persistence.js';
import { runRetentionSweep } from '../../../src/retention/sweep.js';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const FIXED_NOW = 1_700_000_000_000;
const directories: string[] = [];
let restoreClock: Restore | undefined;

function makeDirectory(prefix: string): string {
	const directory = canonicalMkdtemp(prefix);
	directories.push(directory);
	return directory;
}

function restartPersistence(): void {
	gateInternals.resetTrackedStateCache();
	closeAllProjectDbs();
}

async function ageProjection(
	directory: string,
	sessionID: string,
	now: number,
) {
	const old = new Date(now - 40 * DAY_MS);
	for (const filePath of [
		workflowGateStatePath(directory, sessionID),
		`${workflowGateStatePath(directory, sessionID)}.sqlite-projection`,
	]) {
		await fsp.utimes(filePath, old, old);
	}
}

beforeEach(() => {
	restoreClock = freezeClock({ fixedNow: FIXED_NOW });
	coordinationInternals.coordinationFaultInjector = undefined;
	gateInternals.resetTrackedStateCache();
});

afterEach(async () => {
	try {
		coordinationInternals.coordinationFaultInjector = undefined;
		gateInternals.resetTrackedStateCache();
		closeAllProjectDbs();
		for (const directory of directories.splice(0)) {
			await fsp.rm(directory, { recursive: true, force: true });
		}
	} finally {
		restoreClock?.();
		restoreClock = undefined;
	}
});

describe('PR-workflow gate authority retention', () => {
	test('active and recoverable state survives projection retention and crash-shaped replay', async () => {
		const directory = makeDirectory('pr-workflow-retention-');
		const sessionID = 'retention/active';
		const now = FIXED_NOW;

		const activated = await activatePrWorkflow(
			directory,
			sessionID,
			'PR_REVIEW',
		);
		const sessionStem = prWorkflowSessionFileStem(sessionID);
		expect(
			getCoordinationState(
				directory,
				`pr-workflow.state:${sessionStem}`,
				'state',
			),
		).toMatchObject({ entityKey: 'state' });
		expect(workflowGateStatePath(directory, sessionID)).toContain(
			`${sessionStem}.json`,
		);
		// Establish the canonical import/projection archive before aging only the
		// live projection, matching a process restart that has already observed
		// the SQLite authority once.
		await readPrWorkflowGateStateFromDisk(directory, sessionID);
		await ageProjection(directory, sessionID, now);
		const sweep = await runRetentionSweep(directory, { now });
		restartPersistence();

		expect(sweep.pruned['pr-workflow-gates']).toBe(1);
		expect(sweep.pruned['pr-workflow-gate-sidecars']).toBe(1);
		expect(
			await readPrWorkflowGateStateFromCoordination(directory, sessionID),
		).toMatchObject({
			sessionID,
			revision: activated.revision,
		});
		const repaired = await readPrWorkflowGateState(directory, sessionID);
		expect(repaired).toMatchObject({
			sessionID,
			mode: 'PR_REVIEW',
		});
		const projectionPath = workflowGateStatePath(directory, sessionID);
		const projectionBytes = await fsp.readFile(projectionPath, 'utf8');
		const importedPath = `${projectionPath}.imported`;
		const importedBeforeRepeat = fs.existsSync(importedPath);
		const repairedAgain = await readPrWorkflowGateState(directory, sessionID);
		expect(repairedAgain).toEqual(repaired);
		expect(await fsp.readFile(projectionPath, 'utf8')).toBe(projectionBytes);
		expect(fs.existsSync(importedPath)).toBe(importedBeforeRepeat);
		expect(fs.existsSync(projectionPath)).toBe(true);
		expect(
			fs.existsSync(
				`${workflowGateStatePath(directory, sessionID)}.sqlite-projection`,
			),
		).toBe(true);

		const legacyDirectory = makeDirectory('pr-workflow-retention-crash-');
		const legacySessionID = 'retention-crash';
		const seedDirectory = makeDirectory('pr-workflow-retention-seed-');
		await activatePrWorkflow(seedDirectory, legacySessionID, 'PR_REVIEW');
		const seedPath = workflowGateStatePath(seedDirectory, legacySessionID);
		const persistedPayload = JSON.parse(await fsp.readFile(seedPath, 'utf8'));
		const legacyPath = workflowGateStatePath(legacyDirectory, legacySessionID);
		await fsp.mkdir(path.dirname(legacyPath), { recursive: true });
		await fsp.copyFile(seedPath, legacyPath);
		let injected = false;
		coordinationInternals.coordinationFaultInjector = (point) => {
			if (!injected && point === 'after_commit_before_archive') {
				injected = true;
				throw new Error('simulated projection crash');
			}
		};
		await expect(
			readPrWorkflowGateStateFromDisk(legacyDirectory, legacySessionID),
		).rejects.toThrow('simulated projection crash');
		restartPersistence();
		coordinationInternals.coordinationFaultInjector = undefined;
		const replayed = await readPrWorkflowGateStateFromDisk(
			legacyDirectory,
			legacySessionID,
		);
		expect(replayed?.sessionID).toBe(legacySessionID);
		expect(replayed).toEqual(persistedPayload);
		expect(
			fs.existsSync(
				`${workflowGateStatePath(legacyDirectory, legacySessionID)}.imported`,
			),
		).toBe(true);
		expect(fs.existsSync(legacyPath)).toBe(true);
		expect(
			await readPrWorkflowGateStateFromDisk(legacyDirectory, legacySessionID),
		).toEqual(replayed);
		expect(fs.existsSync(`${legacyPath}.imported.1`)).toBe(false);
	});

	test('terminal cleanup removes authority and projection without resurrecting state', async () => {
		const directory = makeDirectory('pr-workflow-retention-terminal-');
		const sessionID = 'retention-terminal';
		await activatePrWorkflow(directory, sessionID, 'PR_REVIEW');

		await abortPrWorkflow(directory, sessionID, {
			kind: 'recovery',
			reason: 'retention terminal cleanup',
		});
		restartPersistence();
		expect(await readPrWorkflowGateState(directory, sessionID)).toBeNull();
		expect(fs.existsSync(workflowGateStatePath(directory, sessionID))).toBe(
			false,
		);
		expect(
			await readPrWorkflowGateStateFromCoordination(directory, sessionID),
		).toBeNull();

		await runRetentionSweep(directory, { now: FIXED_NOW });
		restartPersistence();
		expect(await readPrWorkflowGateState(directory, sessionID)).toBeNull();
		expect(fs.existsSync(workflowGateStatePath(directory, sessionID))).toBe(
			false,
		);

		const events = readCoreEvents(directory);
		expect(CORE_EVENT_LIMITS.activeMaxBytes).toBe(2 * 1024 * 1024);
		expect(CORE_EVENT_LIMITS.activeMaxEntries).toBe(20_000);
		expect(CORE_EVENT_LIMITS.ageMaxMs).toBe(7 * DAY_MS);
		expect(events.coverage).toBe('complete');
		expect(events.text).toContain('"type":"pr_workflow_aborted"');
		expect(events.text).toContain(`"sessionID":"${sessionID}"`);
	});
});
