/**
 * Epic v2 C6 — `/swarm epic start` and learning:
 *   - first start imports the Epic v1 files once into the project prior
 *     (calibration.json hotModuleAdditions ⇒ α = 2; divergence.jsonl replayed
 *     — latest record per plan + task — declared ⇒ exposures, undeclared ⇒
 *     incidents + co-writes) and marks `importedFrom`; never re-imported,
 *     not even after `/swarm epic prior reset`;
 *   - the record keeps the prior's digest and the epic's posterior starts as
 *     a copy of that prior; the sizing dry-run plans with it;
 *   - learning disabled: no import, no posterior, `priorDigest: null`.
 * Real temp projects (git), real plan ledger (start-fixture).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	EPIC_POSTERIOR_RELATIVE_PATH,
	EPIC_PRIOR_LEARNING_RELATIVE_PATH,
	importLegacyEpicCalibrationOnce,
	readEpicPosterior,
	readEpicPrior,
	resetEpicPrior,
} from '../../../src/epic/learning-store';
import { _internals, startEpic } from '../../../src/epic/start';
import { freezeClock, type Restore } from '../../helpers/test-clock';
import { createStartProject } from './start-fixture';

const realInternals = { ..._internals };
const NOW = '2026-04-01T10:00:00.000Z';
const dirs: string[] = [];
let restoreClock: Restore | null = null;

async function project(config?: Record<string, unknown>): Promise<string> {
	const dir = await createStartProject('epic-learning-start-', {
		git: true,
		...(config ? { config } : {}),
	});
	dirs.push(dir);
	return dir;
}

function writeLegacy(dir: string): void {
	const epicDir = path.join(dir, '.swarm', 'epic');
	fs.mkdirSync(epicDir, { recursive: true });
	fs.writeFileSync(
		path.join(epicDir, 'calibration.json'),
		JSON.stringify({
			version: 1,
			hotModuleAdditions: ['src/hot.ts', 'src/co.ts'],
			consecutiveCleanCount: 0,
			processedRecords: 3,
		}),
	);
	const record = (taskId: string, undeclared: string[]) =>
		JSON.stringify({
			planId: 'p',
			taskId,
			declaredScope: ['src/file-1.ts'],
			actualFiles: ['src/file-1.ts', ...undeclared],
			undeclared,
		});
	fs.writeFileSync(
		path.join(epicDir, 'divergence.jsonl'),
		[
			// Superseded by the later record of the same task.
			record('1.1', ['src/stale.ts']),
			record('1.1', ['src/co.ts']),
			'{ torn',
			record('1.2', []),
			'',
		].join('\n'),
	);
}

beforeEach(() => {
	restoreClock = freezeClock({ isoNow: NOW, fixedNow: Date.parse(NOW) });
	_internals.hasActiveTurboMode = () => false;
	_internals.countTrackedWorktreeDispatches = () => 0;
});

afterEach(() => {
	restoreClock?.();
	restoreClock = null;
	Object.assign(_internals, realInternals);
	closeAllProjectDbs();
	for (const dir of dirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe('Epic v1 import (once)', () => {
	test('first start imports calibration + divergence into the prior', async () => {
		const dir = await project();
		writeLegacy(dir);
		const result = await startEpic({
			directory: dir,
			sessionID: 'ses',
			force: true,
		});
		expect(result.status).toBe('started');
		if (result.status !== 'started') return;
		expect(result.learning).toMatchObject({
			enabled: true,
			prior: 'ok',
			imported: { calibrationHotModules: 2, divergenceRecords: 2 },
		});
		const prior = readEpicPrior(dir);
		if (prior.status !== 'ok') throw new Error('no prior');
		const files = prior.prior.stats.files;
		// Hot modules seeded at α = 2 (max with the replayed incident).
		expect(files.get('src/hot.ts')).toEqual({ alpha: 2, beta: 0 });
		expect(files.get('src/co.ts')).toEqual({ alpha: 2, beta: 0 });
		// Latest record per task only: the superseded write is not learned.
		expect(files.has('src/stale.ts')).toBe(false);
		expect(files.get('src/file-1.ts')).toEqual({ alpha: 0, beta: 2 });
		expect(prior.prior.stats.edges.get('src/file-1.ts')?.get('src/co.ts')).toBe(
			1,
		);
		expect(prior.prior.importedFrom).toEqual({
			source: 'epic-v1-import',
			at: NOW,
			calibrationHotModules: 2,
			divergenceRecords: 2,
		});

		// The record keeps the digest; the posterior copies that prior.
		const bytes = fs.readFileSync(
			path.join(dir, EPIC_PRIOR_LEARNING_RELATIVE_PATH),
			'utf-8',
		);
		expect(result.record.priorDigest).toBe(
			createHash('sha256').update(bytes).digest('hex'),
		);
		const posterior = readEpicPosterior(dir);
		expect(posterior).toMatchObject({
			epicKey: result.record.epicKey,
			token: result.record.token,
			priorDigest: result.record.priorDigest,
			lastAppliedWaveSeq: 0,
		});
		expect(posterior?.base.stats.files.get('src/hot.ts')).toEqual({
			alpha: 2,
			beta: 0,
		});
		expect(posterior?.increments.files.size).toBe(0);
	});

	test('import runs once — never again, not even after a prior reset', async () => {
		const dir = await project();
		writeLegacy(dir);
		const now = Date.parse(NOW);
		expect(importLegacyEpicCalibrationOnce(dir, now).status).toBe('imported');
		expect(importLegacyEpicCalibrationOnce(dir, now).status).toBe(
			'already-imported',
		);
		expect(resetEpicPrior(dir, now).status).toBe('reset');
		expect(importLegacyEpicCalibrationOnce(dir, now).status).toBe(
			'already-imported',
		);
		const prior = readEpicPrior(dir);
		if (prior.status !== 'ok') throw new Error('no prior');
		expect(prior.prior.stats.files.size).toBe(0);
	});

	test('no Epic v1 files: nothing imported and no prior written', async () => {
		const dir = await project();
		expect(importLegacyEpicCalibrationOnce(dir, Date.parse(NOW)).status).toBe(
			'nothing-to-import',
		);
		expect(
			fs.existsSync(path.join(dir, EPIC_PRIOR_LEARNING_RELATIVE_PATH)),
		).toBe(false);
	});
});

describe('start without a prior / with learning disabled', () => {
	test('neutral start: no prior ⇒ priorDigest null, empty posterior', async () => {
		const dir = await project();
		const result = await startEpic({
			directory: dir,
			sessionID: 'ses',
			force: false,
		});
		if (result.status !== 'started') throw new Error(result.status);
		expect(result.record.priorDigest).toBeNull();
		expect(result.learning).toMatchObject({ prior: 'absent', hotFiles: 0 });
		expect(readEpicPosterior(dir)?.base.stats.files.size).toBe(0);
	});

	test('learning disabled: no import, no posterior', async () => {
		const dir = await project({
			epic: { mode: { enabled: true }, learning: { enabled: false } },
		});
		writeLegacy(dir);
		const result = await startEpic({
			directory: dir,
			sessionID: 'ses',
			force: true,
		});
		if (result.status !== 'started') throw new Error(result.status);
		expect(result.record.priorDigest).toBeNull();
		expect(result.learning).toMatchObject({ enabled: false, imported: null });
		expect(
			fs.existsSync(path.join(dir, EPIC_PRIOR_LEARNING_RELATIVE_PATH)),
		).toBe(false);
		expect(fs.existsSync(path.join(dir, EPIC_POSTERIOR_RELATIVE_PATH))).toBe(
			false,
		);
	});
});
