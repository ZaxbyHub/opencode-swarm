/**
 * #3491 closure F-1 shipped suite (AC9, the ABSORB record 08a:55-60 named
 * PR-3 as owner): the sed/perl/awk `-i` in-place operands and curl's
 * `-o`/`--output` destinations route through the W8 brace engine. Sibling of
 * guardrails-shell-write-brace-3491.test.ts (which sits at the FR-006 cap
 * after its own closure legs).
 *
 * Bash expands `src/{a,../esc}` into per-command operands: sed/awk `-i` edit
 * EVERY one (executed ground truth), and the glued curl form
 * `-osrc/{a,../esc}` produces two `-o` flags (both written). The spaced curl
 * form treats the second branch as a URL in real curl — per-branch emission
 * is the deliberately fail-closed direction there (disclosed in the g3
 * fragment's Known edges).
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
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

const ANY_WRITE_BLOCK = /^(WRITE )?BLOCKED/;

async function gate(
	command: string,
): Promise<{ verdict: 'ADMITTED' | 'DENIED'; detail: string }> {
	const ws = canonicalMkdtemp('f1sites-ws-');
	created.push(ws);
	mkdirSync(path.join(ws, 'src'), { recursive: true });
	const sessionID = `f1s-${++counter}`;
	const callID = `f1s-call-${counter}`;
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
		return { verdict: 'ADMITTED', detail: '' };
	} catch (error) {
		return {
			verdict: 'DENIED',
			detail: (error as Error).message.split('\n')[0],
		};
	} finally {
		resetSwarmState();
	}
}

beforeEach(() => {
	resetSwarmState();
});

describe('closure F-1: sed -i brace destinations', () => {
	// The gate deny names the RESOLVED escaping branch (path prefix can
	// exceed a detail slice, so the class is asserted at the gate and the
	// branch naming at the detector level below).
	test('escaping branch denies at the gate', async () => {
		const got = await gate('sed -i s/a/b/ src/{a,../esc}');
		expect(got.verdict).toBe('DENIED');
		expect(got.detail).toMatch(ANY_WRITE_BLOCK);
	});
	test('in-scope {a,b} admits', async () => {
		const got = await gate('sed -i s/a/b/ src/{a,b}');
		expect(got.verdict).toBe('ADMITTED');
	});
	test('refusal class denies (dynamic branch)', async () => {
		const got = await gate('sed -i s/a/b/ src/{a,$(echo esc)}');
		expect(got.verdict).toBe('DENIED');
		expect(got.detail).toMatch(/dynamic/);
	});
});

describe('closure F-1: awk -i inplace brace destinations', () => {
	test('escaping branch denies at the gate', async () => {
		const got = await gate("awk -i inplace '{print}' src/{a,../esc}");
		expect(got.verdict).toBe('DENIED');
		expect(got.detail).toMatch(ANY_WRITE_BLOCK);
	});
	test('in-scope {a,b} admits', async () => {
		const got = await gate("awk -i inplace '{print}' src/{a,b}");
		expect(got.verdict).toBe('ADMITTED');
	});
	test('refusal class denies (numeric range over-cap)', async () => {
		const got = await gate("awk -i inplace '{print}' src/{a..i}");
		expect(got.verdict).toBe('DENIED');
		expect(got.detail).toMatch(/dynamic/);
	});
});

describe('closure F-1: curl -o brace destinations', () => {
	test('escaping branch denies at the gate', async () => {
		const got = await gate('curl -o src/{a,../esc} url');
		expect(got.verdict).toBe('DENIED');
		expect(got.detail).toMatch(ANY_WRITE_BLOCK);
	});
	test('glued -osrc/{a,../esc} (two -o flags in real curl) denies', async () => {
		const got = await gate('curl -osrc/{a,../esc} url');
		expect(got.verdict).toBe('DENIED');
		expect(got.detail).toMatch(ANY_WRITE_BLOCK);
	});
	test('--output= glued form denies on the escaping branch', async () => {
		const got = await gate('curl --output=src/{a,../esc} url');
		expect(got.verdict).toBe('DENIED');
		expect(got.detail).toMatch(ANY_WRITE_BLOCK);
	});
	test('in-scope {a,b} admits', async () => {
		const got = await gate('curl -o src/{a,b} url');
		expect(got.verdict).toBe('ADMITTED');
	});
	test('refusal class denies (dynamic branch)', async () => {
		const got = await gate('curl -o src/{a,$(echo esc)} url');
		expect(got.verdict).toBe('DENIED');
		expect(got.detail).toMatch(/dynamic/);
	});
});

describe('closure F-1 detector pins: per-branch emission', () => {
	const paths = (c: string) =>
		detectPosixWrites(c).writes.map((w) => w.path ?? w.dynamicSourceWord);
	test.each([
		['sed -i s/a/b/ src/{a,../esc}', ['src/a', 'src/../esc']],
		["awk -i inplace '{print}' src/{a,../esc}", ['src/a', 'src/../esc']],
		['curl -o src/{a,../esc} url', ['src/a', 'src/../esc']],
		['curl -osrc/{a,../esc} url', ['src/a', 'src/../esc']],
		['curl --output=src/{a,../esc} url', ['src/a', 'src/../esc']],
	])('%s emits both branches', (command, expected) => {
		expect(paths(command)).toEqual(expected);
	});
	test.each([
		['sed -i s/a/b/ src/{a,$(echo esc)}'],
		['curl -o src/{a,$(echo esc)} url'],
	])('%s refuses as one dynamic write naming the SOURCE word', (command) => {
		const writes = detectPosixWrites(command).writes;
		expect(writes.length).toBeGreaterThan(0);
		for (const w of writes) {
			expect(w.path).toBeNull();
			expect(w.dynamicSourceWord).toBeDefined();
		}
	});
});

describe('closure round 2: wget -O / scp brace destinations', () => {
	// wget(1) doc-sourced (no wget binary on this host): the GLUED form
	// expands to two -O spellings and GNU getopt FILE-option semantics keep
	// the LAST — which can be the escaping branch; per-branch emission
	// covers it. The SPACED form's second branch is a URL (curl-parity
	// over-approx, disclosed). scp's brace-shaped dest word hits the
	// class-closing backstop: a literal destination emission is refused.
	test('wget -Osrc/{a,../esc} url → DENIED (glued: two -O spellings, last wins)', async () => {
		const got = await gate('wget -Osrc/{a,../esc} url');
		expect(got.verdict).toBe('DENIED');
		expect(got.detail).toMatch(ANY_WRITE_BLOCK);
	});

	test('wget -O src/{a,b} url in scope → ADMITTED (spaced curl-parity over-approx)', async () => {
		const got = await gate('wget -O src/{a,b} url');
		expect(got.verdict).toBe('ADMITTED');
	});

	test('scp f src/{a,../esc} → DENIED (backstop refusal names the source word)', async () => {
		const got = await gate('scp f src/{a,../esc}');
		expect(got.verdict).toBe('DENIED');
		expect(got.detail).toMatch(/src\/\{a,\.\.\/esc\}/);
	});

	test('control: wget -O src/a url plain destination unchanged', async () => {
		const got = await gate('wget -O src/a url');
		expect(got.verdict).toBe('ADMITTED');
	});

	test('detector pins: wget per-branch, scp refusal', () => {
		const paths = (c: string) =>
			detectPosixWrites(c).writes.map((w) => w.path ?? w.dynamicSourceWord);
		expect(paths('wget -Osrc/{a,../esc} url')).toEqual(['src/a', 'src/../esc']);
		expect(paths('scp f src/{a,../esc}')).toEqual(['src/{a,../esc}']);
	});
});

describe('closure round 3: launcher_write brace destinations (the terminal literal-emitter site)', () => {
	// detectLauncherWrites pushed sudo -e edit targets and GNU time -o
	// report paths as LITERAL words — the last unbacked emitter. Both now
	// route through the W8 engine; the bare-keyword `time` spelling keeps
	// its bash-true pin (the glued word IS the timed command, nothing runs).
	test('/usr/bin/time -osrc/{a,../esc} true → DENIED (per-branch)', async () => {
		const got = await gate('/usr/bin/time -osrc/{a,../esc} true');
		expect(got.verdict).toBe('DENIED');
		expect(got.detail).toMatch(ANY_WRITE_BLOCK);
	});

	test(String.raw`\time -osrc/{a,../esc} true → DENIED (quoted keyword = GNU grammar)`, async () => {
		const got = await gate(String.raw`\time -osrc/{a,../esc} true`);
		expect(got.verdict).toBe('DENIED');
		expect(got.detail).toMatch(ANY_WRITE_BLOCK);
	});

	test('sudo -e src/{a,../esc} → DENIED (edit targets are write-class)', async () => {
		const got = await gate('sudo -e src/{a,../esc}');
		expect(got.verdict).toBe('DENIED');
		expect(got.detail).toMatch(ANY_WRITE_BLOCK);
	});

	test('in-scope control: cd src && sudo -e {a,b} ADMITS', async () => {
		const got = await gate('cd src && sudo -e {a,b}');
		expect(got.verdict).toBe('ADMITTED');
	});

	test('PIN: bare-keyword time -osrc/{a,../esc} true ADMITS (the word is the timed command)', async () => {
		const got = await gate('time -osrc/{a,../esc} true');
		expect(got.verdict).toBe('ADMITTED');
	});

	test('detector pins: launcher_write per-branch emission', () => {
		const paths = (c: string) =>
			detectPosixWrites(c).writes.map((w) => w.path ?? w.dynamicSourceWord);
		expect(paths('/usr/bin/time -osrc/{a,../esc} true')).toEqual([
			'src/a',
			'src/../esc',
		]);
		expect(paths('sudo -e src/{a,../esc}')).toEqual(['src/a', 'src/../esc']);
		expect(paths('time -osrc/{a,../esc} true')).toEqual([]);
	});
});

describe('closure round 4: the isDynamicPath brace chokepoint (X series)', () => {
	// The class-closing structural rung: any POSIX-detected write whose
	// literal path still carries an UNQUOTED brace-list region never went
	// through the W8 engine — refused as dynamic at the detectPosixWrites
	// chokepoint. "Zero unbacked literal destination emitters" is now true
	// by construction in the POSIX grammar.
	test.each([
		['gunzip -d src/{a,../esc}.gz'],
		['gzip -d src/{a,../esc}.gz'],
		['rsync -a x src/{a,../esc}'],
		['git checkout main -- src/{a,../esc}'],
		['git restore --hard -- src/{a,../esc}'],
	])('%s → DENIED (chokepoint refusal)', async (command) => {
		const got = await gate(command);
		expect(got.verdict).toBe('DENIED');
		expect(got.detail).toMatch(/dynamic path target|BLOCKED/);
	});

	test.each([
		['gunzip -d ../esc.gz'],
		['rsync -a x ../esc'],
		['git checkout main -- ../esc'],
	])('plain-escape control still DENIED: %s', async (command) => {
		const got = await gate(command);
		expect(got.verdict).toBe('DENIED');
	});

	test.each([
		['gunzip -d src/a.gz'],
		['rsync -a x src/b'],
	])('in-scope plain control still ADMITS: %s', async (command) => {
		const got = await gate(command);
		expect(got.verdict).toBe('ADMITTED');
	});

	test('chokepoint detector pins: refusal shape', () => {
		const writes = detectPosixWrites('gunzip -d src/{a,../esc}.gz').writes;
		expect(writes.length).toBeGreaterThan(0);
		for (const w of writes) {
			expect(w.path).toBeNull();
			expect(w.dynamicSourceWord).toBe('src/{a,../esc}.gz');
		}
	});

	test('chokepoint carve-outs: quoted literal + engine sites untouched', () => {
		const quoted = detectPosixWrites("cd src && echo x > '{a,b}'").writes;
		expect(quoted.some((w) => w.path === '{a,b}')).toBe(true);
		const tee = detectPosixWrites('tee src/{a,b}').writes.map((w) => w.path);
		expect(tee).toEqual(['src/a', 'src/b']);
	});
});

describe('final corner: no same-text shadow exemption at the chokepoint', () => {
	// A command carrying BOTH the unquoted and the quoted spelling of one
	// brace text must still refuse the unquoted word's write — the quoted
	// twin must not launder it. Pure-quoted literals stay literal by
	// construction (they never seed the refusal set).
	test("git checkout main -- src/{a,../esc} 'src/{a,../esc}' → DENIED", async () => {
		const got = await gate(
			"git checkout main -- src/{a,../esc} 'src/{a,../esc}'",
		);
		expect(got.verdict).toBe('DENIED');
		expect(got.detail).toMatch(/dynamic path target|BLOCKED/);
	});

	test("gunzip -d src/{a,../esc}.gz 'src/{a,../esc}.gz' → DENIED", async () => {
		const got = await gate("gunzip -d src/{a,../esc}.gz 'src/{a,../esc}.gz'");
		expect(got.verdict).toBe('DENIED');
		expect(got.detail).toMatch(/dynamic path target|BLOCKED/);
	});

	test('Q1 PIN: pure-quoted redirect literal in scope ADMITS', async () => {
		const got = await gate("cd src && echo x > '{a,b}'");
		expect(got.verdict).toBe('ADMITTED');
	});

	test('Q2 PIN: pure-quoted tee literal in scope ADMITS', async () => {
		const got = await gate("cd src && tee '{a,b}' < /dev/null");
		expect(got.verdict).toBe('ADMITTED');
	});

	test('Q3 PIN: pure-quoted in-place operand ADMITS', async () => {
		const got = await gate("cd src && sed -i s/a/b/ '{a,b}'");
		expect(got.verdict).toBe('ADMITTED');
	});
});
