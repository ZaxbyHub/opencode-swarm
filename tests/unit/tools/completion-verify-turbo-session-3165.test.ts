/**
 * #3165 E: completion_verify's Turbo bypass honours only the caller's own
 * session. hasActiveTurboMode(undefined) means "any session has Turbo on", and
 * the phase_complete gate called it without a session, so one session's
 * `/swarm turbo` let another session's phase skip completion verification.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { swarmState } from '../../../src/state';
import {
	completion_verify,
	executeCompletionVerify,
} from '../../../src/tools/completion-verify';
import { runCompletionVerifyGate } from '../../../src/tools/phase-complete/gates/completion-verify-gate';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let dir: string;
let savedSessions: typeof swarmState.agentSessions;

beforeEach(() => {
	dir = canonicalMkdtemp('completion-verify-turbo-3165-');
	mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	// A completed task whose identifier is missing: verification blocks it.
	writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify({
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					tasks: [
						{
							id: '1.1',
							description: 'Create `myFunction` in src/utils/missing.ts',
							status: 'completed',
						},
					],
				},
			],
		}),
	);
	savedSessions = swarmState.agentSessions;
	// 'mine' is the caller (Turbo off); 'other' turned Turbo on.
	swarmState.agentSessions = new Map([
		['mine', { turboMode: false }],
		['other', { turboMode: true }],
	] as never);
});

afterEach(() => {
	swarmState.agentSessions = savedSessions;
	safeRmRecursive(dir);
});

describe('completion_verify — regression: another session’s Turbo skipped verification (#3165 E)', () => {
	test('no session id: Turbo in another session does not bypass', async () => {
		const result = JSON.parse(await executeCompletionVerify({ phase: 1 }, dir));
		expect(result.status).toBe('blocked');
		expect(result.tasksBlocked).toBe(1);
	});

	test('the phase_complete gate passes its session, so another session’s Turbo does not bypass', async () => {
		const result = await runCompletionVerifyGate({
			phase: 1,
			dir,
			sessionID: 'mine',
			agentsDispatched: [],
		} as never);
		expect(result.blocked).toBe(true);
		expect(result.reason).toBe('COMPLETION_INCOMPLETE');
	});

	test('the tool uses the plugin context session over a model-supplied one', async () => {
		const raw = await completion_verify.execute(
			{ phase: 1, sessionID: 'other' },
			{ directory: dir, sessionID: 'mine' } as never,
		);
		expect(JSON.parse(raw as string).status).toBe('blocked');
	});
});

describe('completion_verify — the caller’s own Turbo session still bypasses (#3165 E)', () => {
	test('executeCompletionVerify with the Turbo session id passes with the bypass reason', async () => {
		const result = JSON.parse(
			await executeCompletionVerify({ phase: 1, sessionID: 'other' }, dir),
		);
		expect(result.status).toBe('passed');
		expect(result.reason).toContain('Turbo Mode active');
	});

	test('the tool called from the Turbo session passes', async () => {
		const raw = await completion_verify.execute({ phase: 1 }, {
			directory: dir,
			sessionID: 'other',
		} as never);
		expect(JSON.parse(raw as string).status).toBe('passed');
	});
});
