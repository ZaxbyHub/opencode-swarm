/**
 * Epic v2 (r3 M-a) — config `turbo_mode: true` must not seed Turbo on for a
 * new session while an Epic is open for the project.
 *
 * The seam lives in `resolveInitialTurboMode`: when an epic is OPEN for the
 * project's current plan (sentinel fast path, then the config-gated,
 * identity-checked probe), new sessions start with `turboMode === false`.
 * Without an open epic — no sentinel, a leftover sentinel with the Epic
 * config gate off, or an orphaned epic — the #2901 seeding is unchanged. Exercised end-to-end: project config file → loader →
 * ensureAgentSession → constructed session.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	resetSwarmState,
	resolveInitialTurboMode,
	_internals as stateInternals,
	swarmState,
} from '../../../src/state';
import { openEpicForTest } from '../../helpers/epic-lifecycle';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let cleanupEnv: (() => void) | undefined;
let sidCounter = 0;
const realLoadPluginConfigWithMeta = stateInternals.loadPluginConfigWithMeta;

function makeProject(config: Record<string, unknown>): string {
	const dir = canonicalMkdtemp('turbo-seed-epic-');
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify(config, null, '\t'),
	);
	return dir;
}

const EPIC_ON = { strategy: 'standard', epic: { mode: { enabled: true } } };

/** Open a REAL epic (lifecycle row + sentinel) bound to a plan on disk. */
function writeEpicSentinel(dir: string): void {
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify({ swarm: 'seed-swarm', title: 'Seed Plan', phases: [] }),
	);
	openEpicForTest(dir);
}

function newSessionTurbo(dir: string): boolean | undefined {
	sidCounter += 1;
	const sid = `turbo-seed-epic-sid-${sidCounter}`;
	stateInternals.ensureAgentSession(sid, 'architect', dir);
	return swarmState.agentSessions.get(sid)?.turboMode;
}

beforeEach(() => {
	cleanupEnv = createIsolatedTestEnv().cleanup;
	resetSwarmState();
});

afterEach(() => {
	stateInternals.loadPluginConfigWithMeta = realLoadPluginConfigWithMeta;
	closeAllProjectDbs();
	resetSwarmState();
	cleanupEnv?.();
	cleanupEnv = undefined;
});

describe('resolveInitialTurboMode — Epic sentinel seam', () => {
	test('turbo_mode: true + open Epic sentinel → new session turboMode false', () => {
		const project = makeProject({ turbo_mode: true, turbo: EPIC_ON });
		writeEpicSentinel(project);
		expect(resolveInitialTurboMode(project)).toBe(false);
		expect(newSessionTurbo(project)).toBe(false);
	});

	test('turbo_mode: true without a sentinel → unchanged (#2901 seeding on)', () => {
		const project = makeProject({ turbo_mode: true, turbo: EPIC_ON });
		expect(resolveInitialTurboMode(project)).toBe(true);
		expect(newSessionTurbo(project)).toBe(true);
	});

	test('the sentinel only blocks seeding; turbo_mode absent/false stays false', () => {
		for (const config of [
			{ turbo: EPIC_ON },
			{ turbo_mode: false, turbo: EPIC_ON },
		]) {
			const project = makeProject(config);
			expect(newSessionTurbo(project)).toBe(false);
			writeEpicSentinel(project);
			expect(newSessionTurbo(project)).toBe(false);
		}
	});

	test('closing the Epic (sentinel removed) restores seeding for later sessions', () => {
		const project = makeProject({ turbo_mode: true, turbo: EPIC_ON });
		writeEpicSentinel(project);
		expect(newSessionTurbo(project)).toBe(false);
		fs.unlinkSync(path.join(project, '.swarm', 'epic', 'epic.json'));
		expect(newSessionTurbo(project)).toBe(true);
	});

	test('a leftover sentinel with the Epic config gate off does not suppress seeding', () => {
		const project = makeProject({ turbo_mode: true, turbo: EPIC_ON });
		writeEpicSentinel(project);
		expect(newSessionTurbo(project)).toBe(false);
		fs.writeFileSync(
			path.join(project, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({ turbo_mode: true }),
		);
		expect(
			fs.existsSync(path.join(project, '.swarm', 'epic', 'epic.json')),
		).toBe(true);
		expect(newSessionTurbo(project)).toBe(true);
	});

	test('an orphaned epic (plan replaced) does not suppress seeding', () => {
		const project = makeProject({ turbo_mode: true, turbo: EPIC_ON });
		writeEpicSentinel(project);
		fs.writeFileSync(
			path.join(project, '.swarm', 'plan.json'),
			JSON.stringify({ swarm: 'seed-swarm', title: 'Replaced', phases: [] }),
		);
		expect(resolveInitialTurboMode(project)).toBe(true);
	});

	test('a sentinel in a DIFFERENT project does not affect this project', () => {
		const epicProject = makeProject({ turbo_mode: true, turbo: EPIC_ON });
		writeEpicSentinel(epicProject);
		const other = makeProject({ turbo_mode: true, turbo: EPIC_ON });
		expect(newSessionTurbo(other)).toBe(true);
		expect(newSessionTurbo(epicProject)).toBe(false);
	});
});
