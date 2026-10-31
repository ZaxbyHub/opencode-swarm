/**
 * A cd that cannot succeed must not move the walker's tracked cwd (issue
 * #3518 P-2 / frozen check C2's shipped surface). bash leaves the cwd
 * unchanged when `cd` fails (missing target or plain file), so later
 * siblings in a `;` / `||` sequence resolve at the real cwd — which the
 * declared scope must then judge. Legs through the REAL
 * createGuardrailsHooks().toolBefore (coder, scope src/), plus the
 * missing-dir / plain-file stat-gate legs.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const ANY_WRITE_BLOCK = /^(WRITE )?BLOCKED/;
const created: string[] = [];
let counter = 0;
afterAll(() => {
	for (const dir of created.splice(0)) removeTreeWithRetry(dir);
});

function config(): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
	};
}

async function gate(command: string): Promise<string> {
	const ws = canonicalMkdtemp('p3518b-ws-');
	created.push(ws);
	mkdirSync(path.join(ws, 'src'), { recursive: true });
	// `nx` exists but `nx/y` does not; a plain FILE at <ws>/file-target makes
	// `cd file-target` fail for the plain-file leg.
	mkdirSync(path.join(ws, 'nx'), { recursive: true });
	writeFileSync(path.join(ws, 'file-target'), 'plain file');
	const sessionID = `p3518b-${++counter}`;
	const callID = `p3518b-call-${counter}`;
	startAgentSession(sessionID, 'coder');
	installActiveScopeBinding({
		directory: ws,
		childSessionId: sessionID,
		taskId: '1.1',
		files: ['src/'],
		dispatchCallId: callID,
	});
	const hooks = createGuardrailsHooks(ws, undefined, config());
	try {
		await hooks.toolBefore(
			{ tool: 'bash', sessionID, callID },
			{ args: { command } },
		);
		return 'ADMITTED';
	} catch (error) {
		return (error as Error).message.split('\n')[0];
	} finally {
		resetSwarmState();
	}
}

describe('gate: failed cd must not move later siblings (real toolBefore)', () => {
	test('cd <missing>; out-of-scope write is DENIED', async () => {
		await expect(gate('cd nx/y; echo pwn > ../../src/f2')).resolves.toMatch(
			ANY_WRITE_BLOCK,
		);
	});
	test('cd <missing> || out-of-scope write is DENIED', async () => {
		await expect(gate('cd nx/y || echo pwn > ../../src/f2')).resolves.toMatch(
			ANY_WRITE_BLOCK,
		);
	});
	test('cd <plain-file>; out-of-scope write is DENIED', async () => {
		await expect(
			gate('cd file-target; echo pwn > ../../src/f2'),
		).resolves.toMatch(ANY_WRITE_BLOCK);
	});
	test('working cd && in-scope write stays ADMITTED (control)', async () => {
		await expect(gate('cd src && echo x > src/f')).resolves.toBe('ADMITTED');
	});
	test('working cd; relative in-scope write stays ADMITTED (control)', async () => {
		await expect(gate('cd src; echo x > f')).resolves.toBe('ADMITTED');
	});
	test('missing cd && out-of-scope write now BLOCKS (fail-closed over-block, disclosed)', async () => {
		// The && short-circuits so bash never runs the write, but with the
		// stat gate the tracked cwd stays at the workspace (base moved it to
		// the PHANTOM nx/y, which made ../../src/f look in-scope and ADMITTED
		// the shape). Resolving at the true cwd now blocks — conservative
		// fail-closed on an ambiguous shape, strictly safer than base.
		await expect(gate('cd nx/y && echo pwn > ../../src/f2')).resolves.toMatch(
			ANY_WRITE_BLOCK,
		);
	});
});
