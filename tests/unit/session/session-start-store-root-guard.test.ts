/**
 * A blank, whitespace-only, or relative project directory must never resolve
 * against process.cwd(). Before the guard, `startAgentSession(sid, agent, ttl,
 * '   ')` passed `if (directory)` and recordSessionStart joined '   ' onto
 * cwd, creating a whitespace-named directory (holding .swarm/session/) at the
 * root of whatever checkout ran the tests.
 *
 * Every case runs with cwd inside a throwaway sandbox so a regression lands
 * there and is caught by the empty-directory assertions.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	readEarliestSessionStart,
	recordSessionStart,
} from '../../../src/session/session-start-store';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import { type CwdSandbox, enterCwdSandbox } from '../../helpers/cwd-sandbox';

const BAD_ROOTS = ['', '   ', '\t\n', 'relative/project', '.'];

describe('session-start-store workspace-root guard', () => {
	let sandbox: CwdSandbox;

	beforeEach(() => {
		resetSwarmState();
		sandbox = enterCwdSandbox('session-start-root-guard-');
	});

	afterEach(() => {
		resetSwarmState();
		sandbox.restore();
	});

	for (const bad of BAD_ROOTS) {
		test(`recordSessionStart(${JSON.stringify(bad)}) writes nothing`, () => {
			recordSessionStart(bad, 1700000000000);
			expect(fs.readdirSync(sandbox.cwd)).toEqual([]);
			expect(readEarliestSessionStart(bad)).toBeNull();
		});
	}

	test('readEarliestSessionStart ignores a cwd-relative file for a blank root', () => {
		const planted = path.join(sandbox.cwd, '.swarm', 'session');
		fs.mkdirSync(planted, { recursive: true });
		fs.writeFileSync(
			path.join(planted, 'session-start.jsonl'),
			`${JSON.stringify({ startMs: 1700000000000 })}\n`,
		);
		expect(readEarliestSessionStart('')).toBeNull();
		expect(readEarliestSessionStart('.')).toBeNull();
	});

	test('startAgentSession with a whitespace directory touches no disk under cwd', () => {
		startAgentSession('ws-session', 'architect', undefined, '   ');
		expect(fs.readdirSync(sandbox.cwd)).toEqual([]);
		// Treated as no project at all: no cwd-derived owning project key.
		const session = swarmState.agentSessions.get('ws-session');
		expect(session).toBeDefined();
		expect(session?.owningProjectKey).toBeUndefined();
	});

	test('an absolute root still records', () => {
		const root = path.join(sandbox.root, 'project');
		fs.mkdirSync(root);
		recordSessionStart(root, 1700000000000);
		expect(readEarliestSessionStart(root)).toBe(
			new Date(1700000000000).toISOString(),
		);
	});
});
