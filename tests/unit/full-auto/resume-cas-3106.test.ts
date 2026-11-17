/**
 * #3106 (PRR-004): expected-pauseGeneration CAS under the state lock.
 * startFullAutoRun with options.expectedPauseGeneration refuses (returns
 * undefined, writes nothing) unless the persisted session is still paused at
 * exactly that generation — the check-then-arm window a second process can
 * interleave (abort → terminated + gen bump; off → idle WITHOUT a gen bump;
 * re-pause → gen bump) closes for every writer shape.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	disarmFullAutoRun,
	loadFullAutoRunState,
	pauseFullAutoRun,
	startFullAutoRun,
	terminateFullAutoRun,
} from '../../../src/full-auto/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SESSION_ID = 'sess-cas-3106';

let tmpDir: string;

beforeEach(() => {
	tmpDir = canonicalMkdtemp('resume-cas-3106-');
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function armAndPause(mode: string): number {
	startFullAutoRun(tmpDir, SESSION_ID, { mode } as never);
	pauseFullAutoRun(tmpDir, SESSION_ID, 'deadline exceeded');
	const state = loadFullAutoRunState(tmpDir, SESSION_ID);
	if (!state?.pauseGeneration)
		throw new Error('seed failed: no pause generation');
	return state.pauseGeneration;
}

describe('startFullAutoRun expectedPauseGeneration CAS (#3106)', () => {
	test('stale generation (re-pause interleave): refuses, writes nothing', () => {
		const observed = armAndPause('supervised');
		pauseFullAutoRun(tmpDir, SESSION_ID, 'deadline exceeded again'); // gen bump
		const before = loadFullAutoRunState(tmpDir, SESSION_ID);
		const result = startFullAutoRun(
			tmpDir,
			SESSION_ID,
			{ mode: 'supervised' } as never,
			{
				expectedPauseGeneration: observed,
			},
		);
		const after = loadFullAutoRunState(tmpDir, SESSION_ID);
		expect(result).toBeUndefined();
		expect(after?.status).toBe('paused');
		expect(after?.pauseGeneration).toBe(before?.pauseGeneration ?? 0);
		expect(after?.runGeneration).toBe(before?.runGeneration);
	}, 30_000);

	test('off interleave (no generation bump): the status arm refuses', () => {
		const observed = armAndPause('supervised');
		disarmFullAutoRun(tmpDir, SESSION_ID, 'manual off');
		const result = startFullAutoRun(
			tmpDir,
			SESSION_ID,
			{ mode: 'supervised' } as never,
			{
				expectedPauseGeneration: observed,
			},
		);
		expect(result).toBeUndefined();
		expect(loadFullAutoRunState(tmpDir, SESSION_ID)?.status).toBe('idle');
	}, 30_000);

	test('terminate interleave (abort): refuses, terminal state survives', () => {
		const observed = armAndPause('supervised');
		terminateFullAutoRun(
			tmpDir,
			SESSION_ID,
			'manual abort via /swarm full-auto abort',
		);
		const result = startFullAutoRun(
			tmpDir,
			SESSION_ID,
			{ mode: 'supervised' } as never,
			{
				expectedPauseGeneration: observed,
			},
		);
		expect(result).toBeUndefined();
		const after = loadFullAutoRunState(tmpDir, SESSION_ID);
		expect(after?.status).toBe('terminated');
		expect(after?.terminateReason).toBe(
			'manual abort via /swarm full-auto abort',
		);
	}, 30_000);

	test('positive control: exact generation arms', () => {
		const observed = armAndPause('supervised');
		const result = startFullAutoRun(
			tmpDir,
			SESSION_ID,
			{ mode: 'strict' } as never,
			{
				expectedPauseGeneration: observed,
			},
		);
		expect(result?.status).toBe('running');
		expect(result?.mode).toBe('strict');
		expect(loadFullAutoRunState(tmpDir, SESSION_ID)?.status).toBe('running');
	}, 30_000);

	test('no option keeps the unconditional behavior (on-arm compatibility)', () => {
		startFullAutoRun(tmpDir, SESSION_ID, { mode: 'supervised' } as never);
		const state = startFullAutoRun(tmpDir, SESSION_ID, {
			mode: 'assisted',
		} as never);
		expect(state.status).toBe('running'); // re-arm without precondition
		expect(state.mode).toBe('assisted');
	}, 30_000);
});
