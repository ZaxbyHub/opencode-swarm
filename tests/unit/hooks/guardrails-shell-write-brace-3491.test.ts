/**
 * #3491 W8 (RC-9): brace-expanded write destinations. Unquoted `{a,b}` /
 * `{1..3}` regions in a write destination (builtin operands, tee/dd `of=`,
 * redirect operands) expand to one write target per branch — bash-true
 * (executed ground truth in the issue trace): quoted/escaped braces and
 * commas never expand, a comma list beats a `..` alternative, sequences
 * need integer or single-letter endpoints. Real expansions the model
 * refuses (nested, over-cap, empty alternative, alpha/signed/zero-padded/
 * stepped sequences) classify the write dynamic — the gate's
 * dynamic-target block denies, fail-closed. Branches pair in BOTH resolver
 * walks (per-occurrence contexts), so expansion after a tracked `cd`
 * resolves at the post-cd directory. Legs run through the REAL
 * createGuardrailsHooks().toolBefore (coder, scope src/), plus
 * detector-level branch pins and `/swarm guardrail explain` parity rows.
 */

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	detectPosixWrites,
	resolveWriteTargets,
} from '../../../src/hooks/shell-write-detect';
import { handleGuardrailExplain } from '../../../src/services/guardrail-explain-service';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const ANY_WRITE_BLOCK = /^(WRITE )?BLOCKED/;
const created: string[] = [];
const explainRoots: string[] = [];
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

function freshWorkspace(): string {
	const ws = canonicalMkdtemp('w8-ws-');
	created.push(ws);
	mkdirSync(path.join(ws, 'src'), { recursive: true });
	return ws;
}

async function gate(
	command: string,
): Promise<{ verdict: 'ADMITTED' | 'DENIED'; detail: string }> {
	const ws = freshWorkspace();
	const sessionID = `w8-${++counter}`;
	const callID = `w8-call-${counter}`;
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
			detail: (error as Error).message.split('\n')[0].slice(0, 120),
		};
	} finally {
		resetSwarmState();
	}
}

async function expectAdmitted(command: string): Promise<void> {
	const got = await gate(command);
	expect(`${command} -> ${got.verdict} ${got.detail}`).toBe(
		`${command} -> ADMITTED `,
	);
}

async function expectDenied(
	command: string,
	detailPattern?: RegExp,
): Promise<void> {
	const got = await gate(command);
	expect(got.verdict).toBe('DENIED');
	if (detailPattern) expect(got.detail).toMatch(detailPattern);
}

function pathsOf(command: string): Array<string | null> {
	return detectPosixWrites(command).writes.map((w) => w.path);
}

describe('gate: the traversal branch is judged (C7 family)', () => {
	test('tee src/{a,../../x} DENIES (the ../../x branch is decisive)', async () => {
		// The escaping branch is named in the write set before resolution.
		expect(pathsOf('echo x | tee src/{a,../../x}')).toEqual([
			'src/a',
			'src/../../x',
		]);
		await expectDenied('echo x | tee src/{a,../../x}', /^WRITE BLOCKED/);
	});
	test('tee src/{a,b} in scope ADMITS (C7 control)', async () => {
		await expectAdmitted('echo x | tee src/{a,b}');
	});
	test('redirect src/{a,../../x} DENIES', async () => {
		await expectDenied('echo x > src/{a,../../x}');
	});
	test('redirect src/{a,b} ADMITS', async () => {
		await expectAdmitted('echo x > src/{a,b}');
	});
});

describe('gate: destination families (redirect, tee, dd of=, builtins)', () => {
	test('dd of=src/{a,../esc} DENIES; of=src/{a,b} ADMITS', async () => {
		await expectDenied('dd if=a of=src/{a,../esc.txt}');
		await expectAdmitted('dd if=a of=src/{a,b}');
	});
	test('cp destination expands — cp f src/{x,../../esc} DENIES', async () => {
		await expectDenied('cp f src/{x,../../esc}');
	});
	test('cp destination in scope ADMITS', async () => {
		await expectAdmitted('cp f src/{x,y}');
	});
	test('truncate operands expand — {a,../esc}/f DENIES', async () => {
		await expectDenied('truncate -s 0 src/{a,../esc.txt}');
		await expectAdmitted('truncate -s 0 src/{a,b}');
	});
	test('rmdir operands expand — src/{a,../../x} DENIES', async () => {
		await expectDenied('rmdir src/{a,../../x}');
	});
	test('mv destination expands — mv a src/{x,../esc} DENIES', async () => {
		await expectDenied('mv a src/{x,../esc.txt}');
	});
	test('procsub-body brace operand expands through the fallback channel', async () => {
		expect(pathsOf('tee >(cat > src/{a,../../x})')).toEqual([
			'src/a',
			'src/../../x',
		]);
		await expectDenied('tee >(cat > src/{a,../../x})');
	});
});

describe('gate: quoted and escaped braces are NOT expansions (ground truth)', () => {
	test("tee 'src/{a,../../x}' writes ONE literal file (quoted region)", async () => {
		// bash: the quoted brace never expands; the literal path
		// `src/{a,../../x}` is still lexically under src/ — in scope.
		expect(pathsOf("echo x | tee 'src/{a,../../x}'")).toEqual([
			'src/{a,../../x}',
		]);
		await expectAdmitted("echo x | tee 'src/{a,../../x}'");
	});
	test('escaped braces stay literal', () => {
		const bs = String.fromCharCode(92);
		expect(pathsOf(`echo x > src/${bs}{a,b${bs}}`)).toEqual(['src/{a,b}']);
	});
	test('an escaped comma is not a separator (literal)', () => {
		const bs = String.fromCharCode(92);
		expect(pathsOf(`echo x > src/{a${bs},b}`)).toEqual(['src/{a,b}']);
	});
	test('a brace with no comma or sequence is a literal name', async () => {
		await expectAdmitted('echo x > src/{a}');
	});
	test('a {a..} / {..3} shape is a literal (bash ground truth)', () => {
		expect(pathsOf('echo x > src/f{a..}')).toEqual(['src/f{a..}']);
		expect(pathsOf('echo x > src/{..3}')).toEqual(['src/{..3}']);
	});
	test('a parameter expansion ${a,b} is not a brace region (resolves dynamic)', async () => {
		// The literal keeps its `$` — the existing dynamic-path block denies.
		await expectDenied('echo x > src/${a,b}', /dynamic path target/);
	});
	test('a quoted alternative inside an unquoted region still expands', () => {
		expect(pathsOf('echo x > src/{a,"b"}')).toEqual(['src/a', 'src/b']);
	});
});

describe('gate: multiple regions, duplicates, sequences', () => {
	test('two regions go Cartesian (4 in-scope branches ADMIT)', async () => {
		expect(pathsOf('echo x > src/{a,b}/{1,2}')).toEqual([
			'src/a/1',
			'src/a/2',
			'src/b/1',
			'src/b/2',
		]);
		await expectAdmitted('echo x > src/{a,b}/{1,2}');
	});
	test('the Cartesian escaping branch DENIES', async () => {
		await expectDenied('echo x > src/{a,b}/{x,../../esc}');
	});
	test('numeric ranges expand ascending and descending', () => {
		expect(pathsOf('echo x > src/f{1..3}.txt')).toEqual([
			'src/f1.txt',
			'src/f2.txt',
			'src/f3.txt',
		]);
		expect(pathsOf('echo x > src/f{3..1}.txt')).toEqual([
			'src/f3.txt',
			'src/f2.txt',
			'src/f1.txt',
		]);
	});
	test('an 8-branch range ADMITS in scope; sequences survive the cap', async () => {
		await expectAdmitted('echo x > src/{1..8}');
	});
	test('duplicate branches each stay judged ({a,a} admits in scope)', async () => {
		expect(pathsOf('echo x > src/{a,a}')).toEqual(['src/a', 'src/a']);
		await expectAdmitted('echo x > src/{a,a}');
	});
	test('duplicate branches with an escaping twin DENY ({a,a,../../x})', async () => {
		await expectDenied('echo x > src/{a,a,../../x}');
	});
});

describe('gate: refused real expansions classify dynamic (fail-closed)', () => {
	test.each([
		['echo x > {a,{b,../../esc}}', 'nested braces'],
		['echo x > src/{1..9}', 'nine branches over the cap'],
		['echo x > src/{a..c}', 'alpha sequence'],
		['echo x > src/{01..3}', 'zero-padded sequence'],
		['echo x > src/{-1..2}', 'signed sequence'],
		['echo x > src/{1..7..2}', 'stepped sequence'],
		['echo x > src/{a,,b}', 'empty alternative'],
		['echo x > src/{,a}', 'leading empty alternative'],
	])('%s DENIES as a dynamic target (%s)', async (command) => {
		const analysis = detectPosixWrites(command);
		expect(analysis.writes).toHaveLength(1);
		expect(analysis.writes[0].path).toBeNull();
		await expectDenied(command, /dynamic path target/);
	});
	test('three regions are over the region cap — dynamic DENY', async () => {
		await expectDenied('echo x > src/{a,b}{c,d}{e,f}', /dynamic path target/);
	});
});

describe('gate: expansion after a tracked cd (resolver pairing)', () => {
	test('cd src; echo x > {a,../../x} DENIES at the post-cd directory', async () => {
		const analysis = detectPosixWrites('cd src; echo x > {a,../../x}');
		const resolved = resolveWriteTargets(
			'cd src; echo x > {a,../../x}',
			analysis.writes,
			'/ws',
		);
		const paths = resolved.map((r) => r.resolvedPath?.replaceAll('\\', '/'));
		// branch `a` lands in scope at /ws/src; the traversal escapes from there.
		expect(paths).toContain('/ws/src/a');
		expect(paths.some((p) => p !== null && !p.startsWith('/ws/src/'))).toBe(
			true,
		);
		await expectDenied('cd src; echo x > {a,../../x}');
	});
	test('cd src; echo x > {a,b} ADMITS (both branches pair at ws/src)', async () => {
		// The ADMIT is the pairing discriminator: an unpaired branch would
		// fall back to the starting cwd (/ws) — outside scope src/ — and deny.
		await expectAdmitted('cd src; echo x > {a,b}');
	});
});

describe('explain parity: expanded branches reach the mirror', () => {
	afterEach(() => {
		for (const root of explainRoots.splice(0)) {
			try {
				removeTreeWithRetry(root);
			} catch {
				/* best effort */
			}
		}
	});

	async function explain(command: string): Promise<string> {
		const root = canonicalMkdtemp('w8-explain-');
		explainRoots.push(root);
		mkdirSync(path.join(root, 'src'), { recursive: true });
		created.push(root);
		return handleGuardrailExplain(root, [
			'--scope',
			'src/',
			...command.split(' '),
		]);
	}

	test('tee src/{a,../../x} explains as block', async () => {
		const out = await explain('echo x | tee src/{a,../../x}');
		expect(out).toMatch(/\| *Decision *\| *block */i);
	});
	test('tee src/{a,b} explains as allow', async () => {
		const out = await explain('echo x | tee src/{a,b}');
		expect(out).toMatch(/\| *Decision *\| *allow */i);
	});
	test('a refused expansion explains as block', async () => {
		const out = await explain('echo x > src/{a..c}');
		expect(out).toMatch(/\| *Decision *\| *block */i);
	});
	test('expansion after a tracked cd explains as block', async () => {
		const out = await explain('cd src; echo x > {a,../../x}');
		expect(out).toMatch(/\| *Decision *\| *block */i);
	});
});
