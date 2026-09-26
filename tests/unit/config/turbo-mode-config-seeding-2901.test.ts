import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type AgentSessionState,
	resetSwarmState,
	_internals as stateInternals,
	swarmState,
} from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * Issue #2901 — `turbo_mode` (top-level config key) is the config-seeded
 * session default for `AgentSessionState.turboMode`.
 *
 * The seeding is exercised END-TO-END through the production seam (project
 * config file → loader → ensureAgentSession → constructed session); tests
 * never hand-feed a seeding helper. The legacy undefined-field guard is
 * pinned to the conservative `false` (config seeding applies at construction
 * only, never mid-life), and construction survives a loader failure.
 */

let cleanupEnv: (() => void) | undefined;
let sidCounter = 0;
const realLoadPluginConfigWithMeta = stateInternals.loadPluginConfigWithMeta;

function makeProject(config: Record<string, unknown> | null): string {
	const dir = canonicalMkdtemp('turbo-seed-2901-');
	if (config !== null) {
		fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify(config, null, '\t'),
		);
	}
	return dir;
}

function nextSid(): string {
	sidCounter += 1;
	return `turbo-seed-2901-sid-${sidCounter}`;
}

function getSession(sid: string): AgentSessionState | undefined {
	return swarmState.agentSessions.get(sid);
}

beforeEach(() => {
	cleanupEnv = createIsolatedTestEnv().cleanup;
	resetSwarmState();
});

afterEach(() => {
	stateInternals.loadPluginConfigWithMeta = realLoadPluginConfigWithMeta;
	resetSwarmState();
	cleanupEnv?.();
	cleanupEnv = undefined;
});

describe('turbo_mode config seeding (issue #2901)', () => {
	test('turbo_mode: true seeds session.turboMode === true at first turn', () => {
		const project = makeProject({ turbo_mode: true });
		const sid = nextSid();

		stateInternals.ensureAgentSession(sid, 'architect', project);

		const session = getSession(sid);
		expect(session).toBeDefined();
		expect(session?.turboMode).toBe(true);
	});

	test('absent turbo_mode and explicit turbo_mode: false both seed false', () => {
		const noKeyProject = makeProject({});
		const explicitOffProject = makeProject({ turbo_mode: false });

		const sidA = nextSid();
		stateInternals.ensureAgentSession(sidA, 'architect', noKeyProject);
		expect(getSession(sidA)?.turboMode).toBe(false);

		const sidB = nextSid();
		stateInternals.ensureAgentSession(sidB, 'architect', explicitOffProject);
		expect(getSession(sidB)?.turboMode).toBe(false);
	});

	test('per-session toggle wins: an explicit off stays off across re-entry', () => {
		const project = makeProject({ turbo_mode: true });
		const sid = nextSid();

		stateInternals.ensureAgentSession(sid, 'architect', project);
		expect(getSession(sid)?.turboMode).toBe(true);

		// Simulate `/swarm turbo off`, then re-enter the chokepoint: the seed
		// applies only at construction, never to a live session.
		const session = getSession(sid);
		expect(session).toBeDefined();
		session.turboMode = false;

		stateInternals.ensureAgentSession(sid, 'architect', project);
		expect(getSession(sid)?.turboMode).toBe(false);
	});

	test('legacy undefined-field guard stays conservative false even when config says true', () => {
		const project = makeProject({ turbo_mode: true });
		const sid = nextSid();

		// A legacy session object missing the turboMode field entirely.
		swarmState.agentSessions.set(sid, {
			agentName: 'architect',
		} as unknown as AgentSessionState);

		stateInternals.ensureAgentSession(sid, 'architect', project);
		expect(getSession(sid)?.turboMode).toBe(false);
	});

	test('directory-less construction seeds false (no project config to read)', () => {
		const sid = nextSid();
		stateInternals.startAgentSession(sid, 'architect');
		expect(getSession(sid)?.turboMode).toBe(false);
	});

	test('a loader failure never breaks session construction (seeds false)', () => {
		const project = makeProject({ turbo_mode: true });
		stateInternals.loadPluginConfigWithMeta = () => {
			throw new Error('synthetic loader failure');
		};

		const sid = nextSid();
		expect(() =>
			stateInternals.ensureAgentSession(sid, 'architect', project),
		).not.toThrow();
		expect(getSession(sid)).toBeDefined();
		expect(getSession(sid)?.turboMode).toBe(false);
	});
});
