/**
 * #3572 feedback-round hardening pins (swarm-pr-feedback run pr3572-20261104).
 *
 * Pins every review defect fixed on PR #3572, gate-level where the fix's
 * consequence is a verdict, detector-level where the fix is an emission
 * contract; every deny leg asserts a class and every family carries an
 * admit control:
 * - N-01: an accumulated sudo `-e`/`--edit` survives the getopt `--`
 *   sentinel — `sudo -e -- FILE` stays write-class (edit targets).
 * - N-02: a GNU `time -o FILE` segment stays WHOLE on the strip side (the
 *   cd-tracking context is preserved) while the timed tail is pushed to the
 *   destructive arms as an 'uncertain' occurrence (`rm -rf` in a timed tail
 *   denies; `cd src && time -o ok.txt true` admits cd-tracked).
 * - N-03: the keyword-suppressed `time` spelling selects the GNU grammar in
 *   the write-arm leaf walk (`'time' -o report curl -o ../outside url`
 *   emits the escaping download; the -o target itself is cd-tracked).
 * - N-29: GNU env `-S/--split-string` re-parses its payload as a command
 *   line — the reconstructed argv re-enters the FULL detector family (tee
 *   payloads are no longer write-free), nested -S and expansion-bearing
 *   payload words emit the unconditional dynamic refusal, and the wrapper-
 *   prefixed tee loop starts at the resolved leaf word (no bogus verb-word
 *   write target).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { detectPosixWrites } from '../../../src/hooks/shell-write-detect';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { evaluateScopeValidate } from '../../../src/tools/scope-validate';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const created: string[] = [];
const wsRoot = canonicalMkdtemp('fb3572-root-');
mkdirSync(path.join(wsRoot, 'src'), { recursive: true });
created.push(wsRoot);
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

async function gate(command: string): Promise<Verdict> {
	const ws = canonicalMkdtemp('fb3572-ws-');
	created.push(ws);
	mkdirSync(path.join(ws, 'src'), { recursive: true });
	const sessionID = `fb3572-s${++counter}`;
	const callID = `fb3572-call-${counter}`;
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

const ANY_BLOCK = /(?:WRITE )?BLOCKED/i;

describe('3572 feedback: sudo -- edit survival (N-01)', () => {
	test('detector: sudo -e -- FILE is write-class (edit target)', () => {
		const r = detectPosixWrites('sudo -e -- ../../esc');
		expect(r.writes.map((w) => w.path)).toContain('../../esc');
	});

	test('gate: sudo -e -- ../../esc denies (escaping edit target)', async () => {
		const got = await gate('sudo -e -- ../../esc');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_BLOCK);
	}, 120_000);

	test('gate: sudo -e -- src/ok.txt admits (in-scope edit target)', async () => {
		const got = await gate('sudo -e -- src/ok.txt');
		expect(got.verdict).toBe('ADMITTED');
	}, 120_000);
});

describe('3572 feedback: GNU time -o timed tail (N-02)', () => {
	test('detector: -o target emitted while the segment stays whole', () => {
		const r = detectPosixWrites(
			'/usr/bin/time -o src/report rm -rf ../outside',
		);
		expect(r.writes.map((w) => w.path)).toContain('src/report');
	});

	test('gate: rm in a timed tail denies (uncertain occurrence)', async () => {
		const got = await gate('/usr/bin/time -o src/report rm -rf ../outside');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_BLOCK);
	}, 120_000);

	test('gate: cd src && time -o ok.txt true admits (cd-tracked)', async () => {
		const got = await gate('cd src && /usr/bin/time -o ok.txt true');
		expect(got.verdict).toBe('ADMITTED');
	}, 120_000);
});

describe('3572 feedback: suppressed time leaf walk (N-03)', () => {
	test('detector: escaping download emitted (the exact review trigger)', () => {
		const r = detectPosixWrites("'time' -o src/report curl -o ../outside url");
		expect(r.writes.map((w) => w.path)).toContain('../outside');
	});

	test('gate: the same shape denies', async () => {
		const got = await gate("'time' -o src/report curl -o ../outside url");
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_BLOCK);
	}, 120_000);

	test('gate: cd src && time -o ok.txt true admits (GNU grammar)', async () => {
		const got = await gate("cd src && 'time' -o ok.txt true");
		expect(got.verdict).toBe('ADMITTED');
	}, 120_000);
});

describe('3572 feedback: env -S payload (N-29)', () => {
	test('detector: env -S tee payload is a real write', () => {
		const r = detectPosixWrites("env -S 'tee src/ok.txt'");
		expect(r.writes.map((w) => w.path)).toContain('src/ok.txt');
	});

	test('gate: env -S tee in-scope admits; escaping denies', async () => {
		expect((await gate("env -S 'tee src/ok.txt'")).verdict).toBe('ADMITTED');
		expect((await gate("env -S 'tee ../../esc.txt'")).verdict).toBe('DENIED');
	}, 120_000);

	test('detector: nested -S emits the dynamic refusal', () => {
		const r = detectPosixWrites("env -S 'env -S x tee /important'");
		expect(r.writes).toHaveLength(1);
		expect(r.writes[0]?.path).toBeNull();
		expect(r.writes[0]?.unresolvedContext).toBe(true);
	});

	test('gate: nested -S denies', async () => {
		const got = await gate("env -S 'env -S x tee /important'");
		expect(got.verdict).toBe('DENIED');
	}, 120_000);

	test('detector: expansion-bearing payload emits the dynamic refusal', () => {
		const r = detectPosixWrites('env -S "$PAYLOAD"');
		expect(r.writes).toHaveLength(1);
		expect(r.writes[0]?.path).toBeNull();
		expect(r.writes[0]?.unresolvedContext).toBe(true);
	});

	test('gate: env -S rm payload denies (destructive arm)', async () => {
		const got = await gate("env -S 'rm -rf /important'");
		expect(got.verdict).toBe('DENIED');
	}, 120_000);
});

describe('3572 feedback: wrapper-prefixed tee leaf offset (N-29 completion)', () => {
	test('detector: no bogus verb-word write for wrapper-prefixed tee', () => {
		for (const cmd of ['env tee src/ok.txt', 'command tee src/ok.txt']) {
			const r = detectPosixWrites(cmd);
			expect(r.writes.map((w) => w.path)).toEqual(['src/ok.txt']);
		}
	});

	test('gate: env tee in-scope admits; escaping denies', async () => {
		expect((await gate('env tee src/ok.txt')).verdict).toBe('ADMITTED');
		expect((await gate('env tee ../../esc.txt')).verdict).toBe('DENIED');
	}, 120_000);
});

describe('3572 feedback: uncertainty channel + deny-reason hygiene (N-13/N-25/N-26)', () => {
	test('gate: env -i sudo -i denies through the transparent head (N-25)', async () => {
		// The uncertainty channel sees through env/command/builtin/exec heads
		// — the interactive deny fires on the bare twin and must fire here.
		const got = await gate('env -i sudo -i');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/interactive shell/);
	}, 120_000);

	test('deny reason sanitizes a hostile launcher word (N-26)', async () => {
		// The hostile bytes ride the INTERPOLATED launcher word (a path-
		// qualified spelling whose basename is sudo) — the reviewer's delta:
		// a tail-word variant is never interpolated and the pin passes
		// pre-fix (vacuous).
		const hostileWord = `/${'x'.repeat(400)}\u0007/sudo`;
		const got = await gate(`${hostileWord} -h cmd`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message.length).toBeLessThan(400);
		expect(got.message).not.toContain('\u0007');
	}, 120_000);

	test('gate: perl -i.bak -ne is a denied eval for a coder scoped to src/ (N-13)', async () => {
		const got = await gate("perl -i.bak -ne 'print if /x/' src/a.ts");
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/BLOCKED/);
	}, 120_000);

	test('detector: deno run with argument-less flags keeps the stdin-eval shape (N-06)', () => {
		for (const cmd of [
			"echo 'x' | deno run -A -",
			"echo 'x' | deno run -A --unstable-kv -",
		]) {
			const r = detectPosixWrites(cmd);
			expect(r.writes.map((w) => w.operator)).toContain('deno [eval stdin]');
		}
	});
});

describe('3572 feedback: scope_validate channel parity (N-16)', () => {
	test('launcher uncertainty denies in the tool too', () => {
		// A write-free, non-destructive uncertainty shape — the destructive
		// classifier and the write resolution must NOT be the deny carrier
		// here, or the new parity channel is unreachable (vacuous).
		expect(() =>
			evaluateScopeValidate(
				{
					command: 'sudo -h host true',
					shell: 'posix',
					scope_files: ['src/'],
				},
				wsRoot,
			),
		).toThrow(/UNPARSEABLE_COMMAND/);
	});

	test('depth-bound exceedance denies in the tool too', () => {
		const deep = Array.from({ length: 70 }, () => 'sudo').join(' ');
		expect(() =>
			evaluateScopeValidate(
				{
					command: `${deep} true`,
					shell: 'posix',
					scope_files: ['src/'],
				},
				wsRoot,
			),
		).toThrow(/UNPARSEABLE_COMMAND/);
	});

	test('control: an ordinary in-scope write stays allowed', () => {
		const result = evaluateScopeValidate(
			{
				command: 'echo hi > src/ok.txt',
				shell: 'posix',
				scope_files: ['src/'],
			},
			wsRoot,
		);
		expect(result.allowed).toBe(true);
	});
});

describe('3572 feedback delta round (reviewer gate findings)', () => {
	test('gate: env -S shell-wrapper payload denies (quote grouping preserved)', async () => {
		// The bare-space join destroyed the sh -c script grouping — the
		// payload was invisible to both arms and the command admitted while
		// its unwrapped twin denied.
		expect((await gate(`env -S 'sh -c "rm -rf /important"'`)).verdict).toBe(
			'DENIED',
		);
		expect((await gate(`env -S 'bash -c "tee ../../esc"'`)).verdict).toBe(
			'DENIED',
		);
	}, 120_000);

	test('gate: glued --split-string=VALUE payload denies', async () => {
		expect((await gate(`env --split-string='rm -rf /important'`)).verdict).toBe(
			'DENIED',
		);
		expect((await gate(`env --split-string='tee ../../esc'`)).verdict).toBe(
			'DENIED',
		);
	}, 120_000);

	test('gate: the transparent-head uncertainty bound is the paranoid bound', async () => {
		// env x9 + sudo -i was admitted when the hop bound was 8.
		const deep = Array.from({ length: 9 }, () => 'env').join(' ');
		const got = await gate(`${deep} sudo -i`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/interactive shell/);
	}, 120_000);

	test('gate: declared-wrapper dynamic refusal survives the construct drop (N-07 correction)', async () => {
		// The `;` statement runs under bash; the plain twin denies on the
		// dynamic path and the declared-wrapper twin must deny too.
		const plain = await gate('echo hi ; echo y > src/$(echo ../../esc)');
		expect(plain.verdict).toBe('DENIED');
		const wrapped = await gate(
			'cmd /k echo hi ; echo y > src/$(echo ../../esc)',
		);
		expect(wrapped.verdict).toBe('DENIED');
	}, 120_000);

	test('gate: an in-scope timed delete judges at the tracked cwd (N-02 correction)', async () => {
		// The timed tail carries the segment context (time runs its command
		// in the current shell) — the bare twin admits and so must this.
		expect(
			(await gate('cd src && /usr/bin/time -o r.txt rm -rf build')).verdict,
		).toBe('ADMITTED');
	}, 120_000);

	test('detector: direct-verb env -S payloads still classify (delta regression)', () => {
		const r = detectPosixWrites("env -S 'tee src/ok.txt'");
		expect(r.writes.map((w) => w.path)).toContain('src/ok.txt');
	});
});
