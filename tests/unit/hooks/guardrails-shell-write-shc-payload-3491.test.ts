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
