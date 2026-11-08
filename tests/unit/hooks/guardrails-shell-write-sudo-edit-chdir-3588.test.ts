/**
 * #3588 item 4 (collated trace 3586-3588-3591-shell-gate-walk-fixpoint,
 * Fix 5): a sudo edit combined with -D/--chdir resolves the edit target
 * under the chdir directory — RELATIVE operands are qualified with
 * join(chdir, operand) inside the per-branch emitter, while ABSOLUTE or
 * drive-qualified operands pass through UNCHANGED (path.join would
 * fabricate in-scope targets for absolute paths; real sudoedit ignores -D
 * for them). Gate-level pins (coder agent, declared scope src/) with the
 * control set from the plan.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { detectPosixWrites } from '../../../src/hooks/shell-write-detect';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

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

interface Verdict {
	verdict: 'ADMITTED' | 'DENIED';
	message: string;
}

async function gate(
	command: string,
	fixtures?: Record<string, string>,
): Promise<Verdict> {
	const ws = canonicalMkdtemp('ec3588-');
	created.push(ws);
	mkdirSync(path.join(ws, 'src'), { recursive: true });
	if (fixtures) {
		for (const [name, content] of Object.entries(fixtures)) {
			writeFileSync(path.join(ws, name), content);
		}
	}
	const sessionID = `ec3588-s${++counter}`;
	const callID = `ec3588-call-${counter}`;
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
		return { verdict: 'ADMITTED', message: '' };
	} catch (error) {
		return {
			verdict: 'DENIED',
			message: (error as Error).message.split('\n')[0] ?? '',
		};
	} finally {
		resetSwarmState();
	}
}

describe('#3588 Fix 5: -D/--chdir carries onto edit outcomes (gate)', () => {
	test('cd src; sudo -D /etc -e shadow → DENY (resolves /etc/shadow)', async () => {
		const got = await gate('cd src; sudo -D /etc -e shadow');
		expect(got.verdict).toBe('DENIED');
	}, 30_000);

	test('cd src; sudo --chdir=/etc -e shadow → DENY (glued long form)', async () => {
		const got = await gate('cd src; sudo --chdir=/etc -e shadow');
		expect(got.verdict).toBe('DENIED');
	}, 30_000);

	test('cd src; sudo --chdir /etc -e shadow → DENY (spaced long form)', async () => {
		const got = await gate('cd src; sudo --chdir /etc -e shadow');
		expect(got.verdict).toBe('DENIED');
	}, 30_000);

	test('cd src; sudo -e shadow → ADMIT (no-chdir control, unchanged)', async () => {
		const got = await gate('cd src; sudo -e shadow', { 'src/shadow': 'x\n' });
		expect(got.verdict).toBe('ADMITTED');
	}, 30_000);

	test('sudo -D src -e shadow → ADMIT (relative-in-scope control)', async () => {
		const got = await gate('sudo -D src -e shadow', { 'src/shadow': 'x\n' });
		expect(got.verdict).toBe('ADMITTED');
	}, 30_000);

	test('sudo -D src -e /etc/passwd → DENY (absolute escape control)', async () => {
		const got = await gate('sudo -D src -e /etc/passwd');
		expect(got.verdict).toBe('DENIED');
	}, 30_000);

	test('drive-qualified absolute is emitted unchanged (Windows spelling)', () => {
		const analysis = detectPosixWrites('sudo -D src -e C:/Windows/x.txt');
		const paths = analysis.writes
			.filter((w) => w.category === 'launcher_write' && w.path !== null)
			.map((w) => w.path);
		expect(paths).toContain('C:/Windows/x.txt');
	});
});

describe('#3588 Fix 5: detector-level emission shape', () => {
	test('relative operand is joined onto the chdir directory', () => {
		const analysis = detectPosixWrites('sudo -D src -e shadow');
		const paths = analysis.writes
			.filter((w) => w.category === 'launcher_write')
			.map((w) => w.path);
		expect(paths).toContain(path.join('src', 'shadow'));
	});

	test('brace operands qualify per branch (brace-emission control)', () => {
		const analysis = detectPosixWrites('sudo -D src -e {a,b}');
		const paths = analysis.writes
			.filter((w) => w.category === 'launcher_write' && w.path !== null)
			.map((w) => w.path);
		expect(paths).toContain(path.join('src', 'a'));
		expect(paths).toContain(path.join('src', 'b'));
	});

	test('brace with an escaping branch denies at the gate', async () => {
		const got = await gate('sudo -D src -e {a,../esc}');
		expect(got.verdict).toBe('DENIED');
	}, 30_000);

	test('post-sentinel edit keeps the chdir context (sudo -D /etc -e -- shadow)', () => {
		const analysis = detectPosixWrites('sudo -D /etc -e -- shadow');
		const paths = analysis.writes
			.filter((w) => w.category === 'launcher_write')
			.map((w) => w.path);
		expect(paths).toContain(path.join('/etc', 'shadow'));
	});

	test('multiple operands each qualify', () => {
		const analysis = detectPosixWrites('sudo -D /etc -e shadow hosts');
		const paths = analysis.writes
			.filter((w) => w.category === 'launcher_write' && w.path !== null)
			.map((w) => w.path);
		expect(paths).toContain(path.join('/etc', 'shadow'));
		expect(paths).toContain(path.join('/etc', 'hosts'));
	});

	test('no-D brace pins unchanged (qualification is conditional on sudoChdir)', () => {
		const analysis = detectPosixWrites('sudo -e src/{a,../esc}');
		const paths = analysis.writes
			.filter((w) => w.category === 'launcher_write' && w.path !== null)
			.map((w) => w.path);
		expect(paths).toContain('src/a');
		expect(paths).toContain('src/../esc');
	});
});
