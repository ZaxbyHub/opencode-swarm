/**
 * #3588 item 4 (collated trace 3586-3588-3591-shell-gate-walk-fixpoint,
 * Fix 5): a sudo edit combined with -D/--chdir withdraws RELATIVE targets as
 * unresolved. sudo 1.9.15p5 opens operands against the invoking cwd and -D
 * only moves the editor (Docker, sudoers CWD=*: `cd /opt/ws; sudo -D
 * /opt/other -e f` edited /opt/ws/f and left /opt/other/f alone), so a join
 * onto the -D value is wrong; other sudo builds are unverified, so neither
 * directory is assumed. ABSOLUTE or drive-qualified operands name the same
 * file under both models and pass through unchanged. Gate-level pins (coder
 * agent, declared scope src/).
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

	test('sudo -D src -e shadow → DENY (relative target is unresolved)', async () => {
		const got = await gate('sudo -D src -e shadow', { 'src/shadow': 'x\n' });
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/dynamic/i);
	}, 30_000);

	test('sudo -D src -e /etc/passwd → DENY (absolute escape control)', async () => {
		const got = await gate('sudo -D src -e /etc/passwd');
		expect(got.verdict).toBe('DENIED');
	}, 30_000);

	// PR #3615 review F-01: the earlier join let `../` cancel the -D value and
	// fabricated an in-scope literal. Every -D spelling now withdraws.
	test.each([
		['sudo -D "$D" -e ../src/shadow'],
		['sudo --chdir="$D" -e ../src/shadow'],
		['sudo -D $D -e ../src/shadow'],
		['sudo -D ~ -e ../src/shadow'],
		['sudo -D s* -e ../src/shadow'],
		['sudo -D $1 -e ../src/shadow'],
		['sudo -D $@ -e ../src/shadow'],
		['set -- /etc; sudo -D $1 -e ../src/shadow'],
		['sudo -D /opt/x -e ../src/shadow'],
	])('%s → DENY (relative target is unresolved)', async (command) => {
		const got = await gate(command);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/dynamic/i);
	}, 30_000);

	// PR #3615 feedback PRR-015 (Copilot): a TILDE-leading operand must NOT
	// be rewritten — the raw `~`-leading operand keeps the dynamic marker and
	// fails closed (a real $HOME-relative sudoedit target).
	test.each([
		["cd src; sudo -D src -e '~/shadow'", /dynamic/i],
		['sudo -D src -e ~/shadow', /dynamic/i],
		["sudo -D src -e '~root/x'", /dynamic/i],
	])(
		'%s → DENY (tilde operand stays unqualified/dynamic)',
		async (command, pattern) => {
			const got = await gate(command);
			expect(got.verdict).toBe('DENIED');
			expect(got.message).toMatch(pattern);
		},
		30_000,
	);

	test('drive-qualified absolute is emitted unchanged (Windows spelling)', () => {
		const analysis = detectPosixWrites('sudo -D src -e C:/Windows/x.txt');
		const paths = analysis.writes
			.filter((w) => w.category === 'launcher_write' && w.path !== null)
			.map((w) => w.path);
		expect(paths).toContain('C:/Windows/x.txt');
	});
});

describe('#3588 Fix 5: detector-level emission shape', () => {
	function editWrites(command: string) {
		return detectPosixWrites(command).writes.filter(
			(w) => w.category === 'launcher_write',
		);
	}

	test('relative operand is withdrawn, never joined onto the chdir', () => {
		const writes = editWrites('sudo -D src -e shadow');
		expect(writes.map((w) => w.path)).toEqual([null]);
	});

	test('every brace branch under -D is withdrawn', () => {
		const writes = editWrites('sudo -D src -e {a,b}');
		expect(writes.length).toBeGreaterThan(0);
		for (const write of writes) expect(write.path).toBeNull();
	});

	test('brace with an escaping branch denies at the gate', async () => {
		const got = await gate('sudo -D src -e {a,../esc}');
		expect(got.verdict).toBe('DENIED');
	}, 30_000);

	test('post-sentinel and multiple operands withdraw too', () => {
		expect(editWrites('sudo -D /etc -e -- shadow').map((w) => w.path)).toEqual([
			null,
		]);
		expect(
			editWrites('sudo -D /etc -e shadow hosts').map((w) => w.path),
		).toEqual([null, null]);
	});

	test('an absolute operand under -D is emitted as written', () => {
		expect(editWrites('sudo -D src -e /etc/passwd').map((w) => w.path)).toEqual(
			['/etc/passwd'],
		);
	});

	test('no-D operands stay as written (withdrawal is conditional on -D)', () => {
		const paths = editWrites('sudo -e src/{a,../esc}').map((w) => w.path);
		expect(paths).toContain('src/a');
		expect(paths).toContain('src/../esc');
	});
});
