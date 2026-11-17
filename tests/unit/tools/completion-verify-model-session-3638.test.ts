/**
 * #3662: the completion_verify TOOL WRAPPER must not take its Turbo session
 * from the model-supplied sessionID argument. The wrapper's session is
 * `ctx?.sessionID` only — a context without a session means "no Turbo
 * bypass", never "the session the arguments name". The direct
 * executeCompletionVerify API keeps explicit-session authority (the
 * phase_complete gate passes its own session).
 *
 * Legs:
 *   - context-without-session + model-named Turbo session → blocked ... RED at base, GREEN after the fix
 *   - direct API explicit Turbo session still bypasses .............. GREEN at both ends (control)
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { swarmState } from '../../../src/state';
import {
	completion_verify,
	executeCompletionVerify,
} from '../../../src/tools/completion-verify';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let dir: string;
let savedSessions: typeof swarmState.agentSessions;

beforeEach(() => {
	dir = canonicalMkdtemp('completion-verify-model-session-3638-');
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
	// 'turbo-on' has Turbo Mode active; the caller has none.
	swarmState.agentSessions = new Map([
		['turbo-on', { turboMode: true }],
	] as never);
});

afterEach(() => {
	swarmState.agentSessions = savedSessions;
	safeRmRecursive(dir);
});

describe('completion_verify — model-supplied session never selects the Turbo bypass (#3662)', () => {
	test('context without a session: naming a Turbo-active session still runs the verification (RED at base, GREEN after the fix)', async () => {
		// HOST-shaped invocation: the tool-level execute(args, ctx) adapter
		// (create-tool.ts) resolves the directory from ctx and forwards ctx;
		// a ctx that carries a directory but NO sessionID is exactly the
		// context-absent path the issue describes.
		const raw = await completion_verify.execute(
			{ phase: 1, sessionID: 'turbo-on' } as never,
			{ directory: dir } as never,
		);
		const result = JSON.parse(raw as string);
		expect(result.status).toBe('blocked');
		expect(result.tasksBlocked).toBe(1);
		expect(String(result.reason)).not.toMatch(/Turbo/i);
	});

	test('direct API with an explicit Turbo-active session still bypasses (control)', async () => {
		// The direct executeCompletionVerify API keeps explicit-session
		// authority — the phase_complete gate passes its own session.
		const raw = await executeCompletionVerify(
			{ phase: 1, sessionID: 'turbo-on' },
			dir,
		);
		const result = JSON.parse(raw);
		expect(result.status).toBe('passed');
		expect(String(result.reason)).toMatch(/Turbo/i);
	});
});
