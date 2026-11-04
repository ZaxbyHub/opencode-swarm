/**
 * #3491 W4 shipped suite — the shared sh -c payload extractor (sh's argv[2]
 * contract) through the real `createGuardrailsHooks().toolBefore` gate
 * (coder, declared scope `src/`), plus unit pins of the extractor and its
 * quote-aware tokenizer.
 *
 * The payload is the single quote-removed word immediately after `-c`;
 * following words become $0/$1… inside the payload's interpreter and are
 * NEVER scanned as commands (a trailing positional used to defeat the
 * anchored unwrap and hide every write inside the payload — the C5 frozen
 * family). Same-kind quote concatenation (`'\''`) collapses at bash
 * quote-removal because the tokenizer consumes the concatenation, not a
 * raw-quote rescan.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	dcExtractShellDashCPayload,
	dcStripOneWrapper,
	dcUnwrapWrappers,
	shellSplitWords,
	shSingleQuote,
} from '../../../src/hooks/guardrails/destructive-command';
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
	const ws = canonicalMkdtemp('shcp3491-ws-');
	created.push(ws);
	mkdirSync(path.join(ws, 'src'), { recursive: true });
	const sessionID = `shcp3491-s${++counter}`;
	const callID = `shcp3491-call-${counter}`;
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

const ANY_WRITE_BLOCK = /^WRITE BLOCKED(?: \[shell-write-scope\])?: /;
const ANY_DESTRUCTIVE_BLOCK = /^BLOCKED: /;
// The bash same-kind quote-concat splice (close-quote, escaped quote,
// re-open-quote) as an unambiguous runtime constant — writing it inside a
// plain string literal is escaping-fragile across editors and tooling.
const QCONCAT = String.fromCharCode(39, 92, 39, 39);

beforeEach(() => {
	resetSwarmState();
});

describe('W4 unit: quote-aware tokenizer and payload extractor', () => {
	test('shellSplitWords splits on unquoted whitespace only', () => {
		expect(shellSplitWords('sh -c "a b c" d')).toEqual([
			'sh',
			'-c',
			'a b c',
			'd',
		]);
	});

	test('shellSplitWords collapses same-kind quote concatenation into one word', () => {
		expect(shellSplitWords(`'echo '\\''x'\\'' > ../x'`)).toEqual([
			`echo 'x' > ../x`,
		]);
	});

	test('shellSplitWords honors backslash escapes outside quotes', () => {
		expect(shellSplitWords(String.raw`cp a b\ c`)).toEqual(['cp', 'a', 'b c']);
	});

	test('shSingleQuote round-trips metacharacters as one word', () => {
		const serialized = shSingleQuote("src # 'quot'");
		expect(shellSplitWords(serialized)).toEqual(["src # 'quot'"]);
	});

	test('payload = the first quote-removed word after -c', () => {
		expect(dcExtractShellDashCPayload(`'cp a ../x' sh`)).toBe('cp a ../x');
		expect(dcExtractShellDashCPayload(`"mkdir -p src && echo x > src/a"`)).toBe(
			'mkdir -p src && echo x > src/a',
		);
		expect(dcExtractShellDashCPayload(`echo`)).toBe('echo');
		expect(dcExtractShellDashCPayload(``)).toBeNull();
	});

	test('dcUnwrapWrappers uses the extractor for trailing positionals', () => {
		expect(dcUnwrapWrappers("sh -c 'cp a ../x' sh")).toBe('cp a ../x');
	});
});

describe('W4 gate: sh -c payload with a trailing positional (#3491 AC7, C5 family)', () => {
	test("sh -c 'cp a ../x' sh denies the payload's out-of-scope write", async () => {
		const got = await gate("sh -c 'cp a ../x' sh");
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
		expect(got.message).toMatch(/\.\.[\\/]x/);
	});

	test("sh -c 'echo x > src/ok' sh admits — the payload stays in scope", async () => {
		const got = await gate("sh -c 'echo x > src/ok' sh");
		expect(got.verdict).toBe('ADMITTED');
	});

	test("sh -c 'rm -rf ../../outside' sh denies (destructive arm, payload extracted)", async () => {
		const got = await gate("sh -c 'rm -rf ../../outside' sh", true);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_DESTRUCTIVE_BLOCK);
	});
});

describe('W4 gate: same-kind quote concatenation (#3491 AC7)', () => {
	test('sh -c with a quote-concat payload denies the reconstructed payload write', async () => {
		const got = await gate(`sh -c 'echo ${QCONCAT}x${QCONCAT} > ../x'`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
		expect(got.message).toMatch(/x/);
	});

	test('sh -c with a quote-concat in-scope payload admits', async () => {
		const got = await gate(`sh -c 'echo ${QCONCAT}x${QCONCAT} > src/ok'`);
		expect(got.verdict).toBe('ADMITTED');
	});
});

describe('W4 gate: positionals are never scanned as commands (group 3)', () => {
	test("sh -c 'echo hi' cp a ../x ADMITS — the $0 positional's write verb is not fabricated", async () => {
		// cp is a detected write verb: had the extractor scanned positionals,
		// this would flip to BLOCK. Real sh runs only `echo hi`.
		const got = await gate("sh -c 'echo hi' cp a ../x");
		expect(got.verdict).toBe('ADMITTED');
	});

	test('unit: the extractor never returns positional words', () => {
		expect(dcExtractShellDashCPayload(`'echo hi' cp a ../x`)).toBe('echo hi');
		expect(dcStripOneWrapper(`sh -c 'echo hi' cp a ../x`)).toBe('echo hi');
	});
});

// Final-critic round (fix-round 2): `-c` is honored wherever the sh getopt
// grammar puts it — as a CLUSTER member (`-xc`, `-lc`) or after other
// arg-consuming flags (`-eo pipefail -c`) — in both the dc extractor and
// detectInterpreterEval's shell-family matcher. The anchored `-c`-first
// regex ADMITTED every cluster spelling below while real bash executes the
// payload (critic ground-truthed file creation in a scratch ws); the same
// root cause over-blocked the benign multi-flag in-scope spellings.
describe('W4 gate: sh-family flag-cluster payload spellings (fix-round 2)', () => {
	test("sh -xc 'echo x > ../x' denies the cluster-member payload write", async () => {
		const got = await gate(`sh -xc 'echo x > ../x'`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
		expect(got.message).toMatch(/\.\.[\\/]x/);
	});

	test("bash -lc 'rm -rf ../../outside' denies (destructive arm, payload extracted)", async () => {
		const got = await gate(`bash -lc 'rm -rf ../../outside'`, true);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_DESTRUCTIVE_BLOCK);
	});

	test("env sh -xc 'echo x > ../x' denies through the env unwrap", async () => {
		const got = await gate(`env sh -xc 'echo x > ../x'`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
	});

	test("/bin/sh -xc 'echo x > ../x' denies the path-qualified cluster form", async () => {
		const got = await gate(`/bin/sh -xc 'echo x > ../x'`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
	});

	test("sh -xc 'echo x > src/ok' admits — the in-scope cluster payload control", async () => {
		const got = await gate(`sh -xc 'echo x > src/ok'`);
		expect(got.verdict).toBe('ADMITTED');
	});

	test("bash -eo pipefail -c 'echo x > src/ok' admits — multi-flag in-scope payload (over-block fixed)", async () => {
		// The eval classifier routed this at the cwd (out of scope src/)
		// because the extractor never reached the -c payload; extraction now
		// analyzes the payload's own in-scope write like the plain spelling.
		const got = await gate(`bash -eo pipefail -c 'echo x > src/ok'`);
		expect(got.verdict).toBe('ADMITTED');
	});
});

// Final-critic fix-round 3: bash-true next-word rule. The round-2 walk
// returned the CLUSTER TAIL after a mid-cluster `c` as the payload; real
// bash parses the tail letters as MORE OPTIONS and takes the payload from
// the NEXT standalone word (critic ground truth with isolated markers,
// re-verified locally on bash 5.3.9: `bash -ceu 'echo x > m1'` rc=0 creates
// m1; `bash -c'code'` glued is rc=1 invalid option). The tail rule made
// every c-not-last spelling below ADMIT — the extracted "payload" was a
// letter or two while the real payload went unscanned.
describe('W4 gate: c-not-last clusters — payload is the NEXT word (fix-round 3)', () => {
	test("bash -cx 'echo x > ../x' denies (tail letters are options)", async () => {
		const got = await gate(`bash -cx 'echo x > ../x'`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
		expect(got.message).toMatch(/\.\.[\\/]x/);
	});

	test("bash -ceu 'echo x > ../x' denies (critic ground-truth shape)", async () => {
		const got = await gate(`bash -ceu 'echo x > ../x'`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
	});

	test("sh -ceu 'echo x > ../x' denies", async () => {
		const got = await gate(`sh -ceu 'echo x > ../x'`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
	});

	test("bash -ecu 'echo x > ../x' denies", async () => {
		const got = await gate(`bash -ecu 'echo x > ../x'`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
	});

	test("bash -cv 'echo x > ../x' denies", async () => {
		const got = await gate(`bash -cv 'echo x > ../x'`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
	});

	test("sh -cx 'rm -rf ../../outside' denies (destructive arm, payload extracted)", async () => {
		const got = await gate(`sh -cx 'rm -rf ../../outside'`, true);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_DESTRUCTIVE_BLOCK);
	});

	test("sudo -D .. sh -cx 'echo x > f' denies through the chdir wrapper", async () => {
		// The W2 subshell rewrite wraps the unwrapped inner; with the tail
		// rule the inner "payload" was just `x` and the real write hid.
		const got = await gate(`sudo -D .. sh -cx 'echo x > f'`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
		expect(got.message).toMatch(/\.\.[\\/]f/);
	});

	test("sh -c'echo x > ../x' (tail-glued, invalid bash) stays denied — uncertain class", async () => {
		// bash rejects the glued spelling (rc=1 invalid option); the walk
		// classifies it uncertain and the eval classifier routes/denies.
		const got = await gate(`sh -c'echo x > ../x'`);
		expect(got.verdict).toBe('DENIED');
	});
});

// Final-critic fix-round 4: the round-3 tail-vs-next-word fallacy persisted
// in the o/O branches — `optname = tail || nextWord`. Ground truth (critic +
// re-verified locally on bash 5.3.9): `bash -oc pipefail 'echo x > g1'`
// rc=0 EXECUTES (args ride the next standalone words in order: o→pipefail,
// c→payload); `bash +oc pipefail 'code'` same; `bash -opipefail -c 'code'`
// rc=2 — the glued letters parse as options and o took the next word `-c`
// as its optname. The tail-eating o made both executing shapes ADMIT (o ate
// the tail 'c', 'pipefail' then read as a script word — no eval, no
// payload). The next-word rule now governs EVERY arg-taking member.
describe('W4 gate: next-word args for o/O clusters (fix-round 4)', () => {
	test("bash -oc pipefail 'echo x > ../x' denies (o and c share the cluster)", async () => {
		const got = await gate(`bash -oc pipefail 'echo x > ../x'`);
		expect(got.verdict).toBe('DENIED');
	});

	test("bash +oc pipefail 'echo x > ../x' denies (+ toggle form)", async () => {
		const got = await gate(`bash +oc pipefail 'echo x > ../x'`);
		expect(got.verdict).toBe('DENIED');
	});

	test("bash -opipefail -c 'echo x > ../x' denies via uncertain (glued o arg is rc=2 bash)", async () => {
		// bash errors (o took `-c` as its next-word optname); the walk
		// classifies the dash-led optname uncertain and the eval classifier
		// routes/denies — the payload is never trusted to a glued tail.
		const got = await gate(`bash -opipefail -c 'echo x > ../x'`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(
			/WRITE BLOCKED|SCOPE_VIOLATION|evaluates inline code/,
		);
	});

	test("bash -co pipefail 'echo x > ../x' stays denied (multi-arg-taking cluster)", async () => {
		const got = await gate(`bash -co pipefail 'echo x > ../x'`);
		expect(got.verdict).toBe('DENIED');
	});

	test("sh -xc 'echo x > ../x' (c-last) still denies", async () => {
		const got = await gate(`sh -xc 'echo x > ../x'`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
	});

	test("sh -c 'echo x > src/ok' admits (plain spelling control)", async () => {
		const got = await gate(`sh -c 'echo x > src/ok'`);
		expect(got.verdict).toBe('ADMITTED');
	});

	test("bash -eo pipefail -c 'echo x > src/ok' admits (spaced o arg)", async () => {
		const got = await gate(`bash -eo pipefail -c 'echo x > src/ok'`);
		expect(got.verdict).toBe('ADMITTED');
	});

	test("bash --rcfile /dev/null -c 'echo x > src/ok' admits (spaced long arg)", async () => {
		const got = await gate(`bash --rcfile /dev/null -c 'echo x > src/ok'`);
		expect(got.verdict).toBe('ADMITTED');
	});

	test("bash --rcfile=/dev/null -cx 'echo x > src/ok' admits (=value long, c-not-last cluster)", async () => {
		const got = await gate(`bash --rcfile=/dev/null -cx 'echo x > src/ok'`);
		expect(got.verdict).toBe('ADMITTED');
	});
});

// Final-critic fix-round 5: c's payload WORD-SELECTION is bash-true — the
// walk used to take the word after the -c cluster VERBATIM, but bash
// CONTINUES option parsing past -c and the command string is the FIRST
// NON-OPTION word. Ground truth (critic + re-verified locally on bash
// 5.3.9, markers + rc): `bash -c '-e' 'echo x > t1'` rc=0 executes the
// second word; `bash -c -x '…'` and `bash -x -c '-e' '…'` execute;
// `sh -c -- '…'` executes; `bash -c - '…'` / `-e - '…'` execute;
// `bash -c -o pipefail '…'`, `bash -c +o pipefail '…'`, `bash -c -c '…'`,
// `bash -c '-c' '…'` execute; after `--` the first operand IS the command
// string even when flag-shaped (`bash -c -- '-e' 'code'` rc=127 ran '-e');
// long flags after short parsing started ERROR rc=2. The verbatim rule
// admitted every executing shape below by analyzing the option word
// instead of the payload.
describe('W4 gate: c selects the first non-option word (fix-round 5)', () => {
	test("bash -c '-e' 'echo x > ../x' denies (flag-shaped word is an option)", async () => {
		const got = await gate(`bash -c '-e' 'echo x > ../x'`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
		expect(got.message).toMatch(/\.\.[\\/]x/);
	});

	test("bash -x -c '-e' 'echo x > ../x' denies", async () => {
		const got = await gate(`bash -x -c '-e' 'echo x > ../x'`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
	});

	test("bash -c -x 'echo x > ../x' denies (options continue past -c)", async () => {
		const got = await gate(`bash -c -x 'echo x > ../x'`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
	});

	test("sh -c -- 'echo x > ../x' denies (-- hands the operand to the payload)", async () => {
		const got = await gate(`sh -c -- 'echo x > ../x'`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
	});

	test("sh -c -- 'rm -rf ../../outside' denies (destructive arm)", async () => {
		const got = await gate(`sh -c -- 'rm -rf ../../outside'`, true);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_DESTRUCTIVE_BLOCK);
	});

	test("bash -c -o pipefail 'echo x > ../x' denies (o cluster after c)", async () => {
		const got = await gate(`bash -c -o pipefail 'echo x > ../x'`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
	});

	test("bash -c - 'echo x > ../x' denies (lone - ends option parsing)", async () => {
		const got = await gate(`bash -c - 'echo x > ../x'`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
	});

	test("bash -c +o pipefail 'echo x > ../x' denies (+ toggle after c)", async () => {
		const got = await gate(`bash -c +o pipefail 'echo x > ../x'`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
	});

	test("bash -c -c 'echo x > ../x' denies (repeated c re-flags)", async () => {
		const got = await gate(`bash -c -c 'echo x > ../x'`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
	});

	test("bash -c '-c' 'echo x > ../x' denies (flag-shaped c word)", async () => {
		const got = await gate(`bash -c '-c' 'echo x > ../x'`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
	});

	test("bash -c --rcfile /dev/null 'echo x > src/ok' denies (long after short parsing is rc=2 bash)", async () => {
		// bash errors ("bash: --: invalid option" rc=2 — long options are
		// only valid before short parsing starts); deny-on-uncertainty is
		// the bash-true conservative answer.
		const got = await gate(`bash -c --rcfile /dev/null 'echo x > src/ok'`);
		expect(got.verdict).toBe('DENIED');
	});

	test("bash -c '-e' 'echo x > src/ok' admits — right by extraction, not by accident", async () => {
		// The verbatim walk admitted this by analyzing '-e' (benign); the
		// payload 'echo x > src/ok' was never seen. Extraction of the first
		// non-option word now analyzes the real in-scope payload.
		const got = await gate(`bash -c '-e' 'echo x > src/ok'`);
		expect(got.verdict).toBe('ADMITTED');
	});
});

describe('W4 gate: clean-payload controls stay pinned (C5)', () => {
	test("sh -c 'echo x > ../x' stays denied", async () => {
		const got = await gate("sh -c 'echo x > ../x'");
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
	});

	test('cp a ../x stays denied (no wrapper)', async () => {
		const got = await gate('cp a ../x');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
	});

	test("sh -c 'echo x > src/ok' stays admitted", async () => {
		const got = await gate("sh -c 'echo x > src/ok'");
		expect(got.verdict).toBe('ADMITTED');
	});
});
