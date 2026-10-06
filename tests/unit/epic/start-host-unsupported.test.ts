/**
 * `/swarm epic start` refuses on a host that gives the plugin no OpenCode SDK
 * client (OpenCode 2's adapter initializes with `client: undefined`): Epic's
 * worktree-isolated coders and its phase review both need that client.
 *
 * The check reads `swarmState.opencodeClient` directly, so these tests set it
 * and restore the original value; `undefined` = initialized on a client-less
 * host, `null` = never initialized (tests, scripts), an object = a v1 host.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { EPIC_SENTINEL_RELATIVE_PATH } from '../../../src/epic/lifecycle';
import {
	_internals,
	EPIC_HOST_UNSUPPORTED_MESSAGE,
	startEpic,
} from '../../../src/epic/start';
import { swarmState } from '../../../src/state';
import { freezeClock, type Restore } from '../../helpers/test-clock';
import { createStartProject, git } from './start-fixture';

const realInternals = { ..._internals };
const realClient = swarmState.opencodeClient;
const dirs: string[] = [];
let restoreClock: Restore | null = null;

async function project(config?: Record<string, unknown>): Promise<string> {
	const dir = await createStartProject('epic-start-host-', {
		git: true,
		...(config ? { config } : {}),
	});
	dirs.push(dir);
	return dir;
}

function start(dir: string) {
	return startEpic({ directory: dir, sessionID: 'ses_host', force: false });
}

beforeEach(() => {
	restoreClock = freezeClock({ isoNow: '2026-04-01T10:00:00.000Z' });
	_internals.hasActiveTurboMode = () => false;
	_internals.countTrackedWorktreeDispatches = () => 0;
});

afterEach(() => {
	restoreClock?.();
	restoreClock = null;
	Object.assign(_internals, realInternals);
	swarmState.opencodeClient = realClient;
	closeAllProjectDbs();
	for (const dir of dirs.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

describe('epic start on a host without an SDK client', () => {
	test('refuses host-unsupported and changes nothing', async () => {
		const dir = await project();
		const head = git(dir, ['rev-parse', 'HEAD']);
		const branch = git(dir, ['branch', '--show-current']);
		swarmState.opencodeClient = undefined as never;
		const result = await start(dir);
		expect(result).toMatchObject({
			status: 'refused',
			reason: 'host-unsupported',
			details: [EPIC_HOST_UNSUPPORTED_MESSAGE],
		});
		expect(fs.existsSync(path.join(dir, EPIC_SENTINEL_RELATIVE_PATH))).toBe(
			false,
		);
		expect(git(dir, ['rev-parse', 'HEAD'])).toBe(head);
		expect(git(dir, ['branch', '--show-current'])).toBe(branch);
	});

	test('the config gate still answers first', async () => {
		const dir = await project({});
		swarmState.opencodeClient = undefined as never;
		expect(await start(dir)).toMatchObject({
			reason: 'epic-disabled-by-config',
		});
	});

	test('a never-initialized process (null) is not a host verdict', async () => {
		const dir = await project();
		swarmState.opencodeClient = null;
		expect((await start(dir)).status).toBe('started');
	});

	test('a host that provides a client starts normally', async () => {
		const dir = await project();
		swarmState.opencodeClient = { session: {} } as never;
		expect((await start(dir)).status).toBe('started');
	});

	test('the message names the cause and the ways forward', () => {
		expect(EPIC_HOST_UNSUPPORTED_MESSAGE).toContain('SDK client');
		expect(EPIC_HOST_UNSUPPORTED_MESSAGE).toContain('OpenCode 2');
		expect(EPIC_HOST_UNSUPPORTED_MESSAGE).toContain('Balanced');
	});
});
