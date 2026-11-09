/**
 * #3383 supplementary check — the sessionless guard must treat FALSY
 * session IDs as sessionless (empty string, runtime null), mirroring the
 * system-enhancer precedent (#3320), not only `undefined`.
 *
 * Base status (recorded pre-implementation at e8223e308): F1 RED — with no
 * guard at all, `hook({ sessionID: '' }, {})` proceeds into loadPlan and
 * curator-init exactly like the undefined shape.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import type {
	CuratorDelegateFactory,
	CuratorInitRunner,
} from '../../../src/hooks/phase-monitor.js';
import { createPhaseMonitorHook } from '../../../src/hooks/phase-monitor.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const CALLS = {
	factorySessionIds: [] as Array<string | undefined>,
	runnerCalls: 0,
};

const runner: CuratorInitRunner = async () => {
	CALLS.runnerCalls += 1;
	return {
		briefing: 'FALSY-PROBE-BRIEFING',
		contradictions: [],
		knowledge_entries_reviewed: 0,
		prior_phases_covered: 0,
	};
};

const factory: CuratorDelegateFactory = (sessionId) => {
	CALLS.factorySessionIds.push(sessionId);
	return undefined;
};

function writeMinimalPlan(dir: string): void {
	mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'falsy-probe',
			swarm: 'default',
			phases: [{ id: 1, name: 'Phase 1', status: 'pending', tasks: [] }],
		}),
	);
}

afterEach(() => {
	CALLS.factorySessionIds.length = 0;
	CALLS.runnerCalls = 0;
});

describe('phase-monitor falsy sessionless guard (#3383 supplementary)', () => {
	it('F1: an empty-string sessionID is sessionless — no factory, no runner, no .swarm writes', async () => {
		const dir = canonicalMkdtemp('pm-falsy-3383-');
		try {
			writeMinimalPlan(dir);
			const hook = createPhaseMonitorHook(dir, undefined, runner, factory);

			await hook({ sessionID: '' }, {});

			expect(CALLS.factorySessionIds.length).toBe(0);
			expect(CALLS.runnerCalls).toBe(0);
			expect(existsSync(path.join(dir, '.swarm', 'curator-briefing.md'))).toBe(
				false,
			);
			// loadPlan materializes plan.md on first run — absent means the
			// guard fired before loadPlan.
			expect(existsSync(path.join(dir, '.swarm', 'plan.md'))).toBe(false);
			expect(readdirSync(path.join(dir, '.swarm'))).toEqual(['plan.json']);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('F3: a runtime-null sessionID is sessionless — same zero-side-effect contract as F1', async () => {
		// Pins the null half of the falsy contract the file header and the
		// production comment claim: a null-unsafe guard rewrite (e.g.
		// `sessionId === undefined || sessionId === ''`) must stay RED here,
		// because a null sessionID would otherwise fall through to loadPlan,
		// delegateFactory(null) and the curator briefing/receipt writes.
		const dir = canonicalMkdtemp('pm-falsy-null-3383-');
		try {
			writeMinimalPlan(dir);
			const hook = createPhaseMonitorHook(dir, undefined, runner, factory);

			await hook(
				{ sessionID: null } as unknown as {
					sessionID?: string;
				},
				{},
			);

			expect(CALLS.factorySessionIds.length).toBe(0);
			expect(CALLS.runnerCalls).toBe(0);
			expect(existsSync(path.join(dir, '.swarm', 'curator-briefing.md'))).toBe(
				false,
			);
			expect(existsSync(path.join(dir, '.swarm', 'plan.md'))).toBe(false);
			expect(readdirSync(path.join(dir, '.swarm'))).toEqual(['plan.json']);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('F2 (control): a truthy sessionID still initializes on the empty-string probe dir shape', async () => {
		const dir = canonicalMkdtemp('pm-falsy-control-');
		try {
			writeMinimalPlan(dir);
			const hook = createPhaseMonitorHook(dir, undefined, runner, factory);

			await hook({ sessionID: 'sess-falsy-control' }, {});

			expect(CALLS.factorySessionIds).toEqual(['sess-falsy-control']);
			expect(CALLS.runnerCalls).toBe(1);
			expect(existsSync(path.join(dir, '.swarm', 'curator-briefing.md'))).toBe(
				true,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
