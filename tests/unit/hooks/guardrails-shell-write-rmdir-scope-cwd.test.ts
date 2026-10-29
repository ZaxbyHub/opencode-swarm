/**
 * The bare-rmdir empty-directory-removal exemption (issue #3450, PR #3456
 * closeout) trusts the working directory resolveWriteTargets computes for the
 * write. That cwd tracking does not model every way a line changes directory
 * (the right side of `&&` / `||`, control-flow bodies, `pushd`, `builtin` and
 * `command` wrappers, `$X` command names, functions, `trap`, `source`, `.`,
 * bare `cd`, `cd ~`), so the tag must survive only when the line holds only
 * PLAIN_COMMAND_LINE characters (letters, digits, whitespace and
 * `_ . / - = & | ; < >`) and every command in it is a cwd-neutral name
 * (rmdir, mkdir, echo, true, false, test). Otherwise the write gets the
 * ordinary declared-scope check, as it did before the exemption existed.
 * A case whose line holds `$`, a quote, a backslash, a parenthesis or a
 * brace is decided by the character rule; a plain line that runs any other
 * command is decided by the allowlist.
 * Every gate case runs in its own fresh workspace and session.
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { detectPosixWrites } from '../../../src/hooks/shell-write-detect';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const SCOPE_VIOLATION =
	/^WRITE BLOCKED \[shell-write-scope\]: SCOPE_VIOLATION: shell write target /;
// #3474 (cd tracking): when the tracker now correctly follows a `cd` out of
// the workspace (or into control state), the same rejection surfaces as
// AUTHORITY_ROOT_ESCAPE / AUTHORITY_PROTECTED_PATH instead of
// SCOPE_VIOLATION (which came from resolving the target at the workspace
// root the mis-tracking left behind). Both are blocks.
// #3485 (PRR-020): the intentional verdict classes for these legs only — a
// session-state or wrong-layer failure must NOT satisfy a scope/cwd leg.
const ANY_WRITE_BLOCK =
	/^WRITE BLOCKED(?: \[shell-write-scope\])?: (?:SCOPE_VIOLATION|Agent "coder" is not authorised)/;
const ROOT_ESCAPE =
	/^WRITE BLOCKED(?: \[shell-write-scope\])?: Agent "coder" is not authorised to write .*AUTHORITY_ROOT_ESCAPE/;
const WORKSPACE_DIRS = [
	'a',
	'src',
	'lk',
	'one',
	'two',
	'x',
	'.swarm/lk',
	'.git/gk',
	'.scratch-a/tmp1',
];
const created: string[] = [];
let counter = 0;

afterAll(() => {
	for (const dir of created) removeTreeWithRetry(dir);
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

/**
 * A fresh workspace holding WORKSPACE_DIRS plus a sibling directory outside
 * it that holds an empty directory `a` (both directly under the canonical
 * temp dir, so `cd ../<outside>` from the workspace reaches it).
 */
function freshWorkspace(): { ws: string; outside: string } {
	const ws = canonicalMkdtemp('rmdir-cwd-ws-');
	const outside = canonicalMkdtemp('rmdir-cwd-out-');
	created.push(ws, outside);
	for (const dir of WORKSPACE_DIRS) {
		mkdirSync(path.join(ws, dir), { recursive: true });
	}
	mkdirSync(path.join(outside, 'a'), { recursive: true });
	return { ws, outside: path.basename(outside) };
}

/**
 * Runs `template` (every `<O>` replaced by the outside directory's name)
 * through the real guardrails toolBefore as `role`, bound to scope [src/], in
 * a fresh workspace and session. Returns 'ADMITTED' or the rejection message.
 */
async function gate(role: string, template: string): Promise<string> {
	const { ws, outside } = freshWorkspace();
	const command = template.split('<O>').join(outside);
	const sessionID = `rmdir-cwd-${++counter}`;
	const callID = `rmdir-cwd-call-${counter}`;
	startAgentSession(sessionID, role);
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
		return (error as Error).message;
	}
}

/** The tag flag of every rmdir write detectPosixWrites reports. */
function rmdirTags(command: string): boolean[] {
	return detectPosixWrites(command)
		.writes.filter((w) => w.operator.toLowerCase() === 'rmdir')
		.map((w) => w.emptyDirectoryRemoval === true);
}

/** Reported shapes: the tracker resolved `rmdir a` against the workspace. */
const REPORTED_OUTSIDE_SHAPES = [
	'true && cd ../<O>; rmdir a',
	'false || cd ../<O>; rmdir a',
	'mkdir -p src/t && cd ../<O>; rmdir a',
	'[ -d src ] && cd ../<O>; rmdir a',
	'pushd ../<O>; rmdir a',
	'builtin cd ../<O>; rmdir a',
	'command cd ../<O>; rmdir a',
	'X=cd; $X ../<O>; rmdir a',
	'if true; then cd ../<O>; fi; rmdir a',
	'for i in 1; do cd ../<O>; done; rmdir a',
	'while true; do cd ../<O>; break; done; rmdir a',
	'until false; do cd ../<O>; break; done; rmdir a',
	'case x in x) cd ../<O>;; esac; rmdir a',
	'f() { cd ../<O>; }; f; rmdir a',
	"trap 'cd ../<O>' DEBUG; rmdir a",
	'. src/x.sh; rmdir a',
	'source src/x.sh; rmdir a',
	'cd; rmdir a',
	'cd ~; rmdir a',
];

/** Reported shapes that reach repository control state from the workspace. */
const REPORTED_CONTROL_SHAPES = [
	'true && cd .swarm; rmdir lk',
	'pushd .swarm; rmdir lk',
	'true && cd .git; rmdir gk',
];

describe('detectPosixWrites: a line that may change directory loses the tag', () => {
	it.each([
		...REPORTED_OUTSIDE_SHAPES,
		...REPORTED_CONTROL_SHAPES,
	])('strips the tag from %s', (template) => {
		const tags = rmdirTags(template.split('<O>').join('o'));
		expect(tags.length).toBeGreaterThan(0);
		expect(tags.every((tag) => !tag)).toBe(true);
	});

	it.each([
		['a function definition', 'f() { true; }; rmdir a'],
		[
			'a function shadowing an allowlisted name',
			'echo() { true; }; echo; rmdir a',
		],
		['trap', "trap 'true' EXIT; rmdir a"],
		['source', 'source x.sh; rmdir a'],
		['dot', '. x.sh; rmdir a'],
		['builtin', 'builtin echo x; rmdir a'],
		['command', 'command echo x; rmdir a'],
		['pushd', 'pushd x; rmdir a'],
		['popd', 'popd; rmdir a'],
		['eval', 'eval true; rmdir a'],
		['exec', 'exec true; rmdir a'],
		['a $X command name', 'X=true; $X; rmdir a'],
		['a double-quoted command name', '"echo" x; rmdir a'],
		['a backslash-escaped command name', '\\echo x; rmdir a'],
		['cd ~', 'cd ~; rmdir a'],
		['a bare cd', 'cd; rmdir a'],
		['a cd inside a subshell', '(cd x); rmdir a'],
		['a cd inside a brace group', '{ cd x; }; rmdir a'],
		['an upper-case RMDIR (exact match only)', 'RMDIR a'],
		// bash-parser drops the delimiter word and leaves a bare marker in
		// the prefix of a command with no name.
		['a here-document marker in a nameless prefix', 'FOO=1 <<E; rmdir a'],
		['a bare here-document marker', '<<E; rmdir a'],
	])('strips the tag for %s', (_label, command) => {
		const tags = rmdirTags(command);
		expect(tags.length).toBeGreaterThan(0);
		expect(tags.every((tag) => !tag)).toBe(true);
	});

	it.each([
		['cd build && rmdir tmp'],
		['ls d && rmdir d'],
		['touch x && rmdir y'],
	])('withdraws the exemption from %s (accepted effect)', (command) => {
		expect(rmdirTags(command)).toEqual([false]);
	});

	it.each([
		['rmdir .scratch-a/tmp1', [true]],
		['rmdir a && rmdir b', [true, true]],
		['mkdir x && rmdir x', [true]],
		['rmdir a 2>/dev/null || true', [true]],
		['rmdir a && echo done', [true]],
		['FOO=1 rmdir a', [true]],
		['X=1; rmdir a', [true]],
		['FOO=1 >x; rmdir a', [true]],
		['test -d a && rmdir a', [true]],
		['false || rmdir a', [true]],
		['rmdir a | true', [true]],
		['if true; then rmdir a; fi', [true]],
		['for i in 1; do rmdir a; done', [true]],
		['while false; do rmdir a; done', [true]],
		['until true; do rmdir a; done', [true]],
		['if false; then true; else rmdir a; fi', [true]],
	])('keeps the tag for %s', (command, expected) => {
		expect(rmdirTags(command)).toEqual(expected);
	});

	// These lines run only cwd-neutral commands, but each holds a character
	// outside PLAIN_COMMAND_LINE (`(`, `)`, `{`, `}`, `[`, `]` or `$`), so the
	// whole-line character rule withdraws the tag (accepted effect).
	it.each([
		['(rmdir a)'],
		['{ rmdir a; }'],
		['[ -d a ] && rmdir a'],
		['case x in x) rmdir a;; esac'],
		['echo $(cd ../o); rmdir a'],
	])('withdraws the exemption from the non-plain line %s', (command) => {
		expect(rmdirTags(command)).toEqual([false]);
	});
});

describe('real gate: a missed cwd change never admits an outside rmdir', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	it.each(
		REPORTED_OUTSIDE_SHAPES,
	)('rejects a coder running %s', async (template) => {
		expect(await gate('coder', template)).toMatch(ANY_WRITE_BLOCK);
	});
});

describe('real gate: a missed cwd change never reaches control state', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	it.each(
		REPORTED_CONTROL_SHAPES,
	)('rejects a coder running %s', async (command) => {
		expect(await gate('coder', command)).toMatch(ANY_WRITE_BLOCK);
	});

	it.each(
		REPORTED_CONTROL_SHAPES,
	)('rejects an architect running %s', async (command) => {
		expect(await gate('architect', command)).toMatch(ANY_WRITE_BLOCK);
	});
});

describe('real gate: subshell, brace group and command substitution', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	it('scope-checks rmdir after a subshell cd (the line holds a cd)', async () => {
		expect(await gate('coder', '(cd ../<O>); rmdir a')).toMatch(
			SCOPE_VIOLATION,
		);
	});

	it('resolves rmdir after a brace-group cd outside the workspace', async () => {
		expect(await gate('coder', '{ cd ../<O>; }; rmdir a')).toMatch(ROOT_ESCAPE);
	});

	// The `$( )` characters are outside PLAIN_COMMAND_LINE, so the line now
	// gets the ordinary declared-scope check (it was admitted before that rule).
	it('scope-checks rmdir after a cd inside a command substitution', async () => {
		expect(await gate('coder', 'echo $(cd ../<O>); rmdir a')).toMatch(
			SCOPE_VIOLATION,
		);
	});
});

describe('real gate: cwd-neutral lines keep the exemption', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	it('admits a single out-of-scope workspace rmdir', async () => {
		expect(await gate('coder', 'rmdir .scratch-a/tmp1')).toBe('ADMITTED');
	});

	it('admits two distinct rmdirs joined by &&', async () => {
		expect(await gate('coder', 'rmdir one && rmdir two')).toBe('ADMITTED');
	});

	it('admits mkdir followed by rmdir', async () => {
		expect(await gate('coder', 'mkdir x && rmdir x')).toBe('ADMITTED');
	});

	it('admits rmdir followed by echo', async () => {
		expect(await gate('coder', 'rmdir a && echo done')).toBe('ADMITTED');
	});
});

/**
 * bash 5.3 runs `${ cmd; }` and `${| cmd; }` in the CURRENT shell, so a cd in
 * the body moves every later rmdir. Every such form needs `$`, which is
 * outside PLAIN_COMMAND_LINE, so the character rule withdraws the tag
 * wherever the form appears in the line.
 */
describe('detectPosixWrites: a current-shell substitution loses the tag', () => {
	it.each([
		['a ${ } body before rmdir', 'echo ${ cd ../o; }; rmdir a'],
		['a ${| } body before rmdir', 'echo ${| cd ../o; }; rmdir a'],
		['a ${| } body without spaces', 'echo ${|cd ../o;}; rmdir a'],
		['an rmdir suffix word', 'rmdir a ${ cd ../o; }'],
		['a prefix assignment', 'FOO=${ cd ../o; } rmdir a'],
		['a redirect target', 'rmdir a > ${ cd ../o; }x'],
		['a double-quoted word', 'echo "${ cd ../o; }"; rmdir a'],
		['a for word list', 'for i in ${ cd ../o; }; do rmdir a; done'],
		['a case word', 'case ${ cd ../o; } in x) rmdir a;; esac'],
		['a brace-group redirect', '{ rmdir a; } > ${ cd ../o; }'],
		['a here-document body', 'rmdir a <<E\n${ cd ../o; }\nE'],
		['an indirect expansion', 'echo ${!x}; rmdir a'],
	])('strips the tag for %s', (_label, command) => {
		const tags = rmdirTags(command);
		expect(tags.length).toBeGreaterThan(0);
		expect(tags.every((tag) => !tag)).toBe(true);
	});

	// Plain parameter references cannot change directory, but every
	// expansion needs `$`, which is outside PLAIN_COMMAND_LINE, so these lines
	// lose the tag too (accepted effect; they kept it before the character
	// rule).
	it.each([
		['echo ${HOME}; rmdir a'],
		['echo $1; rmdir a'],
		['echo "$HOME"; rmdir a'],
		['echo ${?} $@ $$ $! $- $* $0 ${10}; rmdir a'],
		['echo ${HOME:-x}; rmdir a'],
		['echo ${#}; rmdir a'],
	])('withdraws the exemption from the plain parameter in %s', (command) => {
		expect(rmdirTags(command)).toEqual([false]);
	});
});

describe('real gate: a current-shell substitution never admits an outside rmdir', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	it('rejects a coder running echo ${ cd ../<O>; }; rmdir a', async () => {
		expect(await gate('coder', 'echo ${ cd ../<O>; }; rmdir a')).toMatch(
			SCOPE_VIOLATION,
		);
	});

	it('rejects a coder running echo ${| cd ../<O>; }; rmdir a', async () => {
		expect(await gate('coder', 'echo ${| cd ../<O>; }; rmdir a')).toMatch(
			SCOPE_VIOLATION,
		);
	});

	it('rejects an architect running echo ${ cd .swarm; }; rmdir lk', async () => {
		expect(await gate('architect', 'echo ${ cd .swarm; }; rmdir lk')).toMatch(
			SCOPE_VIOLATION,
		);
	});

	// Admitted before PLAIN_COMMAND_LINE; `$`, `{` and `}` now withdraw the tag.
	it('scope-checks a plain-parameter line: echo ${HOME}; rmdir .scratch-a/tmp1', async () => {
		expect(await gate('coder', 'echo ${HOME}; rmdir .scratch-a/tmp1')).toMatch(
			SCOPE_VIOLATION,
		);
	});
});

/**
 * bash evaluates code it finds in QUOTED text at run time (arithmetic on a
 * variable, a `test -v` / `[ -v` subscript), so a `${ cd ..; }` body there
 * moves the later rmdir out of the directory the gate checks. Only a
 * PLAIN_COMMAND_LINE keeps the tag; the detect cases live in the -cwd2 file.
 */
describe('real gate: only a plain command line keeps the exemption', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	it.each([
		['coder', "x='a[${ cd ../<O>; }]'; echo $((x)); rmdir a"],
		['coder', "[ -v 'a[${ cd ../<O>; }]' ]; rmdir a"],
		['coder', "test -v 'a[${ cd ../<O>; }]'; rmdir a"],
		['coder', `x='a[$'"{ cd ../<O>; }]"; echo $((x)); rmdir a`],
		['architect', "[ -v 'a[${ cd .swarm; }]' ]; rmdir lk"],
	])('rejects a %s running %s', async (role, template) => {
		expect(await gate(role, template)).toMatch(ANY_WRITE_BLOCK);
	});

	// Each line holds exactly one kind of excluded character (`$`, a single
	// quote, brackets, or a lone `[`) and was admitted before the character
	// rule.
	it.each([
		['echo $HOME; rmdir .scratch-a/tmp1'],
		["rmdir .scratch-a/tmp1; echo 'x'"],
		['[ -d src ] && rmdir .scratch-a/tmp1'],
		['rmdir .scratch-a/tmp1; echo x['],
	])('scope-checks the non-plain line %s', async (command) => {
		expect(await gate('coder', command)).toMatch(ANY_WRITE_BLOCK);
	});

	it('admits a prefix assignment: FOO=1 rmdir .scratch-a/tmp1', async () => {
		expect(await gate('coder', 'FOO=1 rmdir .scratch-a/tmp1')).toBe('ADMITTED');
	});
});
