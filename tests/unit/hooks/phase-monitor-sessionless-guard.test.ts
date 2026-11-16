/**
 * #3383 AC1 — a sessionless `experimental.chat.system.transform` invocation
 * must not run the phase monitor's side-effectful work.
 *
 * Defect (src/hooks/phase-monitor.ts): when the hook input carries NO
 * sessionID, the handler still runs `loadPlan(directory)` (materializing
 * `.swarm/plan.md` as its auto-heal side effect), calls
 * `delegateFactory?.(undefined)`, runs curator init, and writes
 * `.swarm/curator-briefing.md` — because curator defaults are
 * `enabled: true, init_enabled: true` (src/config/schema.ts).
 *
 * Drives the REAL exported `createPhaseMonitorHook` on a hermetic temp root
 * with a minimal valid `.swarm/plan.json` and an INJECTED curator runner +
 * delegate factory (dependency injection — no mock.module). The sessionless
 * leg is RED at base; the session-bound control leg pins the unchanged
 * session-attached behavior and must stay GREEN at base AND after the fix.
 *
 * Determinism notes: no clocks, no sleeps — every observable (factory calls,
 * runner calls, briefing bytes, .swarm tree) is read synchronously after the
 * awaited hook call returns.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CuratorInitResult } from '../../../src/hooks/curator-types';
import { createPhaseMonitorHook } from '../../../src/hooks/phase-monitor';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/** Injected-call observables (plain closures — the DI seam, not mock.module). */
interface CallLog {
	factorySessionIds: Array<string | undefined>;
	runnerDirectories: string[];
}

function makeRunner(log: CallLog) {
	return async (directory: string): Promise<CuratorInitResult> => {
		log.runnerDirectories.push(directory);
		return {
			briefing: '#3383 injected curator briefing',
			contradictions: [],
			knowledge_entries_reviewed: 0,
			prior_phases_covered: 0,
		};
	};
}

function makeFactory(log: CallLog) {
	return (sessionId: string | undefined): undefined => {
		log.factorySessionIds.push(sessionId);
		return undefined;
	};
}

/**
 * Minimal hermetic fixture: a valid `.swarm/plan.json` (NO plan.md — the
 * loadPlan materialization side effect must stay observable) plus an explicit
 * project config pinning the curator defaults the defect relies on, so the
 * test never depends on the developer's user-level opencode-swarm.json.
 */
function writeFixture(): string {
	const dir = canonicalMkdtemp('phase-monitor-sessionless-3383-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Sessionless phase-monitor probe plan',
			swarm: 'local',
			phases: [{ id: 1, name: 'Phase 1', status: 'pending', tasks: [] }],
		}),
		'utf-8',
	);
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ curator: { enabled: true, init_enabled: true } }),
		'utf-8',
	);
	return dir;
}

/** Recursive, sorted `.swarm` tree snapshot — the zero-writes observable. */
function swarmTree(dir: string): string[] {
	const root = path.join(dir, '.swarm');
	const entries: string[] = [];
	const walk = (abs: string, rel: string): void => {
		for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
			const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
			if (entry.isDirectory()) {
				entries.push(`${childRel}/`);
				walk(path.join(abs, entry.name), childRel);
			} else {
				entries.push(childRel);
			}
		}
	};
	walk(root, '');
	return entries.sort();
}

describe('createPhaseMonitorHook sessionless invocation guard (#3383 AC1)', () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('does no side-effectful work when invoked with no sessionID', async () => {
		const dir = writeFixture();
		tempDirs.push(dir);
		const log: CallLog = { factorySessionIds: [], runnerDirectories: [] };
		const treeBefore = swarmTree(dir);

		const hook = createPhaseMonitorHook(
			dir,
			undefined,
			makeRunner(log),
			makeFactory(log),
		);
		await hook({}, {});

		// DISCRIMINATING (all fail at base):
		// 1. the curator delegate factory must not be invoked at all (base
		//    calls it with undefined; note toEqual([undefined]) vs toEqual([])
		//    is a false match under bun's undefined-ignoring equality, so the
		//    call COUNT is the honest observable);
		expect(log.factorySessionIds.length).toBe(0);
		// 2. curator init must not run;
		expect(log.runnerDirectories).toEqual([]);
		// 3. .swarm/curator-briefing.md must not be written;
		expect(fs.existsSync(path.join(dir, '.swarm', 'curator-briefing.md'))).toBe(
			false,
		);
		// 4. loadPlan must not run — its plan.md auto-heal materialization is
		//    the observable side effect;
		expect(fs.existsSync(path.join(dir, '.swarm', 'plan.md'))).toBe(false);
		// 5. nothing else under .swarm may appear (review receipts, stores,
		//    caches) — the full zero-writes contract.
		expect(swarmTree(dir)).toEqual(treeBefore);
	}, 30_000);

	it('control: a session-bound first invocation still initializes the curator', async () => {
		const dir = writeFixture();
		tempDirs.push(dir);
		const log: CallLog = { factorySessionIds: [], runnerDirectories: [] };

		const hook = createPhaseMonitorHook(
			dir,
			undefined,
			makeRunner(log),
			makeFactory(log),
		);
		await hook({ sessionID: 'sess-control-3383' }, {});

		// PRESERVING (green at base and after the fix): session-attached
		// curator init is unchanged.
		expect(log.factorySessionIds).toEqual(['sess-control-3383']);
		expect(log.runnerDirectories).toEqual([dir]);
		const briefingPath = path.join(dir, '.swarm', 'curator-briefing.md');
		expect(fs.existsSync(briefingPath)).toBe(true);
		expect(fs.readFileSync(briefingPath, 'utf-8')).toBe(
			'#3383 injected curator briefing',
		);
	}, 30_000);
});
