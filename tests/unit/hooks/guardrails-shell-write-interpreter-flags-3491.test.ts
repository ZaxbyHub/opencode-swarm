/**
 * #3491 W7 shipped suite — per-interpreter eval cluster grammars + deno,
 * driven through the real `createGuardrailsHooks().toolBefore` gate (coder,
 * declared scope `src/`) plus detector-level classification pins through the
 * exported detectPosixWrites.
 *
 * The positional flag matcher never decomposed getopt CLUSTERS (`python
 * -Bc`, `perl -pe`, `ruby -ne`) and `deno` was absent from the interpreter
 * table — those spellings ran inline code without the interpreter_eval
 * classification (RC-3). Every new form must classify IDENTICALLY to the
 * known `-c`/`-e` baseline: deny at an out-of-scope eval cwd, admit at an
 * in-scope one.
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

function config(destructive: boolean): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
		...(destructive ? { block_destructive_commands: true } : {}),
	};
}

interface Verdict {
	verdict: 'ADMITTED' | 'DENIED';
	message: string;
}

async function gate(command: string, destructive = false): Promise<Verdict> {
	const ws = canonicalMkdtemp('w7interp-ws-');
	created.push(ws);
	mkdirSync(path.join(ws, 'src'), { recursive: true });
	const sessionID = `w7i-s${++counter}`;
	const callID = `w7i-call-${counter}`;
	startAgentSession(sessionID, 'coder');
	installActiveScopeBinding({
		directory: ws,
		childSessionId: sessionID,
		taskId: '1.1',
		files: ['src/'],
		dispatchCallId: callID,
	});
	const hooks = createGuardrailsHooks(ws, undefined, config(destructive));
	try {
		await hooks.toolBefore(
			{ tool: 'bash', sessionID, callID },
			{ args: { command } },
		);
		return { verdict: 'ADMITTED', message: '' };
	} catch (error) {
		return {
			verdict: 'DENIED',
			message: (error as Error).message.split('\n')[0],
		};
	} finally {
		resetSwarmState();
	}
}

const ANY_BLOCK = /^WRITE BLOCKED|^BLOCKED|^SCOPE_VIOLATION/;

beforeEach(() => {
	resetSwarmState();
});

describe('W7 gate: python cluster grammar (#3491 AC10, C8 family)', () => {
	test('python -Bc cluster: out-of-scope eval cwd denies', async () => {
		const got = await gate(`python -Bc "open('../x','w')"`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_BLOCK);
	});

	test('python -Bc cluster: in-scope eval cwd (cd src) admits', async () => {
		const got = await gate(`cd src && python -Bc "open('ok','w')"`);
		expect(got.verdict).toBe('ADMITTED');
	});

	test('python -uc cluster: argless member before c', async () => {
		const got = await gate(`python -uc "open('../x','w')"`);
		expect(got.verdict).toBe('DENIED');
	});

	test('python -W arg -c: arg-taking member modeled per python(1)', async () => {
		const got = await gate(`python -W ignore -c "open('../x','w')"`);
		expect(got.verdict).toBe('DENIED');
	});

	test('python -Wignore glued -c: both spellings of the arg member', async () => {
		const got = await gate(`python -Wignore -c "open('../x','w')"`);
		expect(got.verdict).toBe('DENIED');
	});

	test('python -X utf8 -c: second arg-taking member', async () => {
		const got = await gate(`python -X utf8 -c "open('../x','w')"`);
		expect(got.verdict).toBe('DENIED');
	});

	test('python -Bq script.py: -q is a real argless member — script run admits', async () => {
		const got = await gate('python -Bq script.py');
		expect(got.verdict).toBe('ADMITTED');
	});

	test('python -m module: module run is NOT eval (issue #1902) — admits', async () => {
		const got = await gate('python -m pytest');
		expect(got.verdict).toBe('ADMITTED');
	});

	test('python -Z unknown member: interpreter errors, nothing runs — admits', async () => {
		const got = await gate('python -Z script.py');
		expect(got.verdict).toBe('ADMITTED');
	});

	test('py -3 -c launcher: version selector then eval', async () => {
		const got = await gate(`py -3 -c "open('../x','w')"`);
		expect(got.verdict).toBe('DENIED');
	});
});

describe('W7 gate: perl cluster grammar (perlrun)', () => {
	test('perl -pe cluster: p loop prefix + e eval — out-of-scope denies', async () => {
		const got = await gate(`perl -pe 'BEGIN{open(F,">","../x")}' ../in`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_BLOCK);
	});

	test('perl -pe cluster: in-scope eval cwd admits', async () => {
		const got = await gate(`cd src && perl -pe 'BEGIN{open(F,">","ok")}' in`);
		expect(got.verdict).toBe('ADMITTED');
	});

	test('perl -E (say/features) member is eval per perlrun', async () => {
		const got = await gate(`perl -E "open(F,'>','../x')"`);
		expect(got.verdict).toBe('DENIED');
	});

	test('perl -we cluster: w argless + e eval', async () => {
		const got = await gate(`perl -we "open(F,'>','../x')"`);
		expect(got.verdict).toBe('DENIED');
	});

	test('perl -eCODE glued', async () => {
		const got = await gate(`perl -e"open(F,'>','../x')"`);
		expect(got.verdict).toBe('DENIED');
	});

	test('perl -n loop prefix WITHOUT e is not eval — admits', async () => {
		// (-ne WITH e is an eval: e's code is the next word. The e-less form
		// is the bare loop prefix over a script file.)
		const got = await gate('perl -n in.txt');
		expect(got.verdict).toBe('ADMITTED');
	});

	test('perl -c syntax check is not eval — admits', async () => {
		const got = await gate('perl -c script.pl');
		expect(got.verdict).toBe('ADMITTED');
	});

	test('perl -i in-place edit stays blocked by the in-place detector (C8 control)', async () => {
		const got = await gate(`perl -i -pe 's/a/b/' ../x`);
		expect(got.verdict).toBe('DENIED');
	});
});

describe('W7 gate: ruby cluster grammar (ruby(1))', () => {
	test('ruby -ne cluster: n loop prefix + e eval — out-of-scope denies', async () => {
		const got = await gate(`ruby -ne 'BEGIN{open("../x","w")}' in.rb`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_BLOCK);
	});

	test('ruby -ne cluster: in-scope eval cwd admits', async () => {
		const got = await gate(`cd src && ruby -ne 'BEGIN{open("ok","w")}' in.rb`);
		expect(got.verdict).toBe('ADMITTED');
	});

	test('ruby -pe cluster: p loop prefix + e eval', async () => {
		const got = await gate(`ruby -pe 'open("../x","w")' in.rb`);
		expect(got.verdict).toBe('DENIED');
	});

	test('ruby -eCODE glued', async () => {
		const got = await gate(`ruby -e'open("../x","w")'`);
		expect(got.verdict).toBe('DENIED');
	});

	test('ruby -n loop WITHOUT e is not eval — admits', async () => {
		const got = await gate('ruby -n script.rb');
		expect(got.verdict).toBe('ADMITTED');
	});

	test('ruby -E encoding member is NOT eval (perl -E IS) — admits', async () => {
		const got = await gate('ruby -E utf-8 script.rb');
		expect(got.verdict).toBe('ADMITTED');
	});

	test('ruby -r require member is not eval — admits', async () => {
		const got = await gate('ruby -r json script.rb');
		expect(got.verdict).toBe('ADMITTED');
	});
});

describe('W7 gate: deno subcommand eval', () => {
	test('deno eval CODE: out-of-scope eval cwd denies', async () => {
		const got = await gate(`deno eval "Deno.writeTextFileSync('../x','y')"`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_BLOCK);
	});

	test('deno eval CODE: in-scope eval cwd (cd src) admits', async () => {
		const got = await gate(
			`cd src && deno eval "Deno.writeTextFileSync('ok','y')"`,
		);
		expect(got.verdict).toBe('ADMITTED');
	});

	test('deno eval -p CODE: flag after the subcommand does not remove the eval', async () => {
		const got = await gate(`deno eval -p "Deno.writeTextFileSync('../x','y')"`);
		expect(got.verdict).toBe('DENIED');
	});

	test('deno -q eval CODE: argument-less global flag before the subcommand', async () => {
		const got = await gate(`deno -q eval "Deno.writeTextFileSync('../x','y')"`);
		expect(got.verdict).toBe('DENIED');
	});

	test('deno run script.ts: script-file carve-out parity — admits', async () => {
		const got = await gate('deno run script.ts');
		expect(got.verdict).toBe('ADMITTED');
	});

	test('deno --version: query form admits', async () => {
		const got = await gate('deno --version');
		expect(got.verdict).toBe('ADMITTED');
	});

	test('echo CODE | deno run -: stdin-eval shape classifies (out of scope)', async () => {
		const got = await gate(
			`echo 'Deno.writeTextFileSync("../x","y")' | deno run -`,
		);
		expect(got.verdict).toBe('DENIED');
	});

	test('echo CODE | deno run -: in-scope stdin eval admits', async () => {
		const got = await gate(
			`cd src && echo 'Deno.writeTextFileSync("ok","y")' | deno run -`,
		);
		expect(got.verdict).toBe('ADMITTED');
	});
});

describe('W7 detector-level classification pins (detectPosixWrites)', () => {
	const evalWrites = (command: string) =>
		detectPosixWrites(command).writes.filter(
			(w) => w.category === 'interpreter_eval',
		);

	test.each([
		['python -Bc "x=1"', 'python'],
		['python -W ignore -c "x=1"', 'python'],
		['perl -pe "x"', 'perl'],
		['perl -E "x"', 'perl'],
		['ruby -ne "x"', 'ruby'],
		['deno eval "x"', 'deno'],
	])('%s classifies an inspectable capability eval', (command, canonical) => {
		const writes = evalWrites(command);
		expect(writes.length).toBeGreaterThan(0);
		expect(writes[0]?.capability).toBe(true);
		expect(writes[0]?.operator.startsWith(`${canonical}`)).toBe(true);
	});

	test.each([
		['python script.py'],
		['python -m pytest'],
		['python -Z nothing.py'],
		['perl -n in.txt'],
		['ruby -n script.rb'],
		['deno run script.ts'],
		['deno --version'],
	])('%s classifies NO eval', (command) => {
		expect(evalWrites(command).length).toBe(0);
	});
});

describe('W7 closure F-2: deno unknown argument-less flags before eval', () => {
	test('deno --no-prompt eval "<write>" → DENIED (deny-on-uncertainty)', async () => {
		const got = await gate(
			`deno --no-prompt eval "Deno.writeTextFileSync('../x','y')"`,
		);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_BLOCK);
	});

	test('deno --unstable-kv eval "<write>" → DENIED', async () => {
		const got = await gate(
			`deno --unstable-kv eval "Deno.writeTextFileSync('../x','y')"`,
		);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_BLOCK);
	});

	test('control: deno -q eval still classifies (known flag skipped)', async () => {
		const got = await gate(`deno -q eval "Deno.writeTextFileSync('../x','y')"`);
		expect(got.verdict).toBe('DENIED');
	});

	test('control: the arg-taking disclosure case stays unclassified (disclosed)', async () => {
		const got = await gate('deno --config x eval "1"');
		expect(got.verdict).toBe('ADMITTED');
	});

	test('in-scope cwd admits through an unknown arg-less flag', async () => {
		const got = await gate(
			`cd src && deno --no-prompt eval "Deno.writeTextFileSync('ok','y')"`,
		);
		expect(got.verdict).toBe('ADMITTED');
	});

	test('detector pin: --no-prompt eval classifies a capability eval', () => {
		const evals = detectPosixWrites(
			`deno --no-prompt eval "Deno.writeTextFileSync('../x','y')"`,
		).writes.filter((w) => w.category === 'interpreter_eval');
		expect(evals.length).toBe(1);
		expect(evals[0]?.capability).toBe(true);
	});
});
