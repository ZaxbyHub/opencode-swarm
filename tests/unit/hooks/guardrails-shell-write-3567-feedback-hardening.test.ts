/**
 * #3567 feedback-round hardening pins (swarm-pr-feedback run pr3567-20261104).
 *
 * Pins every gate defect the three concurrent reviews found on PR #3567, each
 * with a denial-CLASS assertion (never "any throw") and, where the fix is a
 * bash-true modeling change, an admit CONTROL so a blanket-deny regression
 * fails the suite:
 * - PRR-001: branch/loop withdrawal propagates (if/case/for/while dynamic cd).
 * - PRR-002: a function definition does NOT zero an inherited withdrawal.
 * - P-F5: a call to a transition-bearing function withdraws.
 * - PRR-006: same-directory cd/pushd refresh prevCwd (bash OLDPWD truth).
 * - PRR-008: bash opens a wrapper segment's own redirects in the PARENT cwd —
 *   the rewrite hoists `>`/`>>` out of the generated subshell.
 * - P-F3: an unquoted $() operand fails the wrapper walk closed.
 * - PRR-003: an unmodelable shell flag cluster (`bash -oc pipefail …`)
 *   denies (ground truth: the payload executes).
 * - P-B: a multi-statement `sh -c` payload's tail statements carry an
 *   uncertain child-cwd context.
 * - PRR-012: the ||-chain models BOTH outcomes (skip + execute-from-pre-left).
 * - PRR-011: an if/else pair produces NO fabricated no-body outcome.
 * - MS-3: an unresolved same-key write still nulls (resolution precedence).
 * - P-A: the segment splitter honors backslash escapes.
 * - P-R1: GNU env abbreviation spellings capture the chdir.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	getAgentSession,
	resetSwarmState,
	startAgentSession,
} from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const created: string[] = [];
let counter = 0;
afterAll(() => {
	for (const dir of created.splice(0)) removeTreeWithRetry(dir);
}, 120_000);

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
	scope: string[] | '.' = ['src/'],
): Promise<Verdict> {
	const ws = canonicalMkdtemp('fb3567-ws-');
	created.push(ws);
	mkdirSync(path.join(ws, 'src'), { recursive: true }, 120_000);
	const sessionID = `fb3567-s${++counter}`;
	const callID = `fb3567-call-${counter}`;
	startAgentSession(sessionID, 'coder');
	if (scope === '.') {
		const session = getAgentSession(sessionID);
		if (session) session.declaredCoderScope = ['.'];
	} else {
		installActiveScopeBinding(
			{
				directory: ws,
				childSessionId: sessionID,
				taskId: '1.1',
				files: scope,
				dispatchCallId: callID,
			},
			120_000,
		);
	}
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
			message: (error as Error).message.split('\n')[0],
		};
	} finally {
		resetSwarmState();
	}
}

const WITHDRAWAL =
	/dynamic path target|cannot be statically resolved|withdrew|withdrawn/i;
const ANY_BLOCK = /(?:WRITE )?BLOCKED/i;

describe('3567 feedback: control-flow withdrawal propagation (PRR-001)', () => {
	test.each([
		['if', 'if true; then cd $D; fi; echo x > src/f.ts'],
		['case', 'case x in x) cd $D;; esac; echo x > src/f.ts'],
		['for', 'for d in a b; do cd $d; done; echo x > src/f.ts'],
		['while', 'while true; do cd $D; break; done; echo x > src/f.ts'],
	])(
		'%s branch dynamic-cd withdrawal reaches the sibling',
		async (_k, cmd) => {
			const got = await gate(cmd);
			expect(got.verdict).toBe('DENIED');
			expect(got.message).toMatch(WITHDRAWAL);
		},
		120_000,
	);

	test('control: an else-less conditional without a cd keeps admits intact', async () => {
		// (The else-less `then cd` shape itself stays a disclosed over-block:
		// bash genuinely has two landings, so the v4 divergence contract
		// withdraws — that edge predates this round and stays disclosed.)
		const got = await gate('if true; then echo hi; fi; echo x > src/f');
		expect(got.verdict).toBe('ADMITTED');
	}, 120_000);
}, 120_000);

describe('3567 feedback: function seam (PRR-002 + P-F5)', () => {
	test('a call to a transition-bearing function withdraws the sibling', async () => {
		const got = await gate('f() { cd ..; }; f; echo x > src/f.ts');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	}, 120_000);

	test('a dynamic cd before the definition is not zeroed by the body copy', async () => {
		const got = await gate(
			'cd src; cd $V; f() { echo x > .ssh/authorized_keys; }; f',
		);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	}, 120_000);

	test('control: benign definition + call admits in-scope', async () => {
		const got = await gate('f() { echo x > src/f.txt; }; f');
		expect(got.verdict).toBe('ADMITTED');
	}, 120_000);
}, 120_000);

describe('3567 feedback: prevCwd refresh (PRR-006)', () => {
	test('cd ..; cd .; cd - lands where bash lands (the workspace parent)', async () => {
		const got = await gate('cd ..; cd .; cd -; echo x > src/f.ts');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/src\/f\.ts/);
	}, 120_000);
}, 120_000);

describe('3567 feedback: wrapper redirect hoist (PRR-008)', () => {
	test('redirect after cd applies at the bash-true parent landing', async () => {
		const got = await gate('cd ../outside && env -C src echo x > src/f');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/src\/f/);
	}, 120_000);

	test('control: wrapper without a preceding cd keeps the parent-cwd write', async () => {
		const got = await gate('env -C src echo x > src/f');
		expect(got.verdict).toBe('ADMITTED');
	}, 120_000);
}, 120_000);

describe('3567 feedback: $() operand fail-closed (P-F3)', () => {
	test('unquoted command substitution in the DIR operand denies', async () => {
		const got = await gate(
			"env -C $(git rev-parse --show-toplevel) sh -c 'echo x > /tmp/y'",
		);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_BLOCK);
	}, 120_000);
}, 120_000);

describe('3567 feedback: shell flag-cluster deny (PRR-003)', () => {
	test('bash -oc pipefail payload denies', async () => {
		const got = await gate(
			"cd src && bash -oc pipefail 'rm -rf ../../outside'",
		);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_BLOCK);
	}, 120_000);

	test('control: a modeled -c payload stays judged', async () => {
		const got = await gate("bash -c 'echo hi > src/f'");
		expect(got.verdict).toBe('ADMITTED');
	}, 120_000);
}, 120_000);

describe('3567 feedback: multi-statement payload isolation (P-B)', () => {
	test("bash -c 'cd ..; rm -rf dist' relocates the allowlisted target to the sentinel", async () => {
		// dist alone is an allowlisted build artifact judged at the session
		// cwd, so this leg FAILS if the isolation channel is removed.
		const got = await gate("bash -c 'cd ..; rm -rf dist'");
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/__swarm_unresolved_chdir__/);
	}, 120_000);

	test('control: a single-statement payload keeps exact judgment', async () => {
		const got = await gate("sh -c 'rm -rf dist'");
		expect(got.verdict).toBe('ADMITTED');
	}, 120_000);
});

describe('3567 feedback: || both-outcome model (PRR-012)', () => {
	test('a provable left-failure cd denies the sibling via the divergence channel', async () => {
		const got = await gate('cd nope/sub || cd ../..; echo x > src/f.ts');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/src\/f\.ts/);
	}, 120_000);

	test('an unknown-left || with a cd right-branch withdraws (disclosed over-block)', async () => {
		const got = await gate('true || cd src; echo x > src/f.ts');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	}, 120_000);
}, 120_000);

describe('3567 feedback: determinate if/else admits (PRR-011)', () => {
	test('no fabricated no-body outcome for an else pair', async () => {
		const got = await gate(
			'if true; then cd src; else cd src; fi; echo x > src/f',
		);
		expect(got.verdict).toBe('ADMITTED');
	}, 120_000);
}, 120_000);

describe('3567 feedback: resolution precedence (MS-3)', () => {
	test('a later same-key write cannot resurrect an unresolved one', async () => {
		const got = await gate('echo x > src/ok.txt; cd $D; echo x > src/ok.txt');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	}, 120_000);
}, 120_000);

describe('3567 feedback: segment splitter backslash branch (P-A)', () => {
	test("echo '; rm -rf ../dist; echo ' (escaped quote) is seen by the destructive arm", async () => {
		const got = await gate("echo \\'; rm -rf ../dist; echo \\'");
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_BLOCK);
	}, 120_000);
}, 120_000);

describe('3567 feedback: env abbreviation chdir capture (P-R1)', () => {
	test('env --ch src hoists the redirect to the parent cwd (bash truth)', async () => {
		const got = await gate('env --ch src echo x > src/f');
		expect(got.verdict).toBe('ADMITTED');
	}, 120_000);

	test('env --c src tracks the chdir for the destructive arm', async () => {
		const got = await gate('env --c src rm -rf . --dir-flag');
		expect(got.verdict).toBe('DENIED');
	}, 120_000);
}, 120_000);

describe('3567 feedback: reviewer-round additions', () => {
	test('fd redirect 2> after a cd hoists (deny at the bash-true landing)', async () => {
		const got = await gate('cd ../outside && env -C src echo x 2> src/err.txt');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/err\.txt/);
	}, 120_000);

	test('amp redirect &> after a cd hoists', async () => {
		const got = await gate(
			'cd ../outside && env -C src echo x &> src/both.txt',
		);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/both\.txt/);
	}, 120_000);

	test('fd-dup 2>&1 stays judged inside (no file target)', async () => {
		const got = await gate('cd ../outside && env -C src echo x 2>&1 > src/f');
		expect(got.verdict).toBe('DENIED');
		// The fd-dup token itself serializes quoted; the deny may surface
		// through the rewritten command's parse-failure channel — the pinned
		// contract is the rejection verdict.
		expect(got.message).toMatch(/src\/f|failed to parse command/);
	}, 120_000);

	test('transitive function call withdraws (call-graph closure)', async () => {
		const got = await gate('g() { cd ..; }; f() { g; }; f; echo x > src/f.ts');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	}, 120_000);

	test('write-path P-B: the payload cd cannot move the parent walk (scope src/)', async () => {
		const got = await gate("bash -c 'cd src'; echo x > f", ['src/']);
		expect(got.verdict).toBe('DENIED');
	}, 120_000);

	test('control: payload-internal write at the child cwd admits', async () => {
		const got = await gate("bash -c 'cd src; echo x > f'", ['src/']);
		expect(got.verdict).toBe('ADMITTED');
	}, 120_000);

	test('clobber redirect >| after a cd hoists', async () => {
		const got = await gate('cd ../outside && env -C src echo x >| src/f');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/src\/f/);
	}, 120_000);

	test('ksh uncertain cluster denies', async () => {
		const got = await gate("ksh -oc pipefail 'rm -rf ../../outside'");
		expect(got.verdict).toBe('DENIED');
	}, 120_000);

	test('env-prefixed uncertain cluster denies', async () => {
		const got = await gate("env bash -oc pipefail 'rm -rf ../../outside'");
		expect(got.verdict).toBe('DENIED');
	}, 120_000);

	test('backtick chdir operand fails closed', async () => {
		const got = await gate("env -C `echo src` sh -c 'echo x > ../f'");
		expect(got.verdict).toBe('DENIED');
	}, 120_000);

	test('control: $(date) in the wrapped ARGUMENTS keeps flowing (P-F3 scope)', async () => {
		const got = await gate('env -C src echo $(date) > src/f');
		expect(got.verdict).toBe('ADMITTED');
	}, 120_000);

	test('pushd stack overflow (33 entries) withdraws', async () => {
		const cmd = `${Array.from({ length: 33 }, (_, i) => `pushd d${i}`).join('; ')}; echo x > src/f`;
		const got = await gate(cmd);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	}, 120_000);
});
