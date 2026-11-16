/**
 * #3491 W3 review-round shipped suite — compound depth-flag laundering,
 * quoted/escaped `time` spellings, and their explain parity. Sibling of
 * guardrails-shell-write-launcher-env-3491.test.ts (which sits near the
 * FR-006 500-line cap), per the review's instruction.
 *
 * The review demonstrated the laundering: when dcPreprocessWrappers changes
 * the text, the gate's didUnwrap branch replaced the analysis with
 * detect(detectionCommand) and DROPPED primaryAnalysis.unwrapDepthExceeded —
 * `echo ok; sudo×65 rm -rf ../../outside` ADMITTED, hiding non-write
 * destructive verbs at the paranoid bound. The depth refusal now ORs through
 * the substitution (mirroring mergeWriteAnalyses) and the destructive arms
 * consult the bound PER SEGMENT (the whole-command chain stops at the first
 * non-wrapper segment).
 *
 * Quoted/escaped `time` spellings suppress the bash KEYWORD (ground truth on
 * bash 5.3.9: `\time -p true` → "time: command not found" — a PATH-resolved
 * program runs instead), so the GNU-binary grammar governs them and
 * `\time -o FILE cmd` emits the timing-report write target.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { handleGuardrailExplain } from '../../../src/services/guardrail-explain-service';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const created: string[] = [];
let counter = 0;
afterEach(() => {
	for (const dir of created.splice(0)) removeTreeWithRetry(dir);
});

function config(destructive: boolean | undefined): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
		...(destructive === undefined
			? {}
			: { block_destructive_commands: destructive }),
	};
}

interface Verdict {
	verdict: 'ADMITTED' | 'DENIED';
	message: string;
}

async function gate(
	command: string,
	destructive: boolean | undefined = false,
): Promise<Verdict> {
	const ws = canonicalMkdtemp('w3depth-ws-');
	created.push(ws);
	mkdirSync(path.join(ws, 'src'), { recursive: true });
	const sessionID = `w3d-s${++counter}`;
	const callID = `w3d-call-${counter}`;
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

const SUDO65 = `${'sudo '.repeat(65)}rm -rf ../../outside`;
const COMMAND65 = `${'command '.repeat(65)}rm -rf ../../outside`;

beforeEach(() => {
	resetSwarmState();
});

describe('review REQUIRED: compound depth-flag laundering (#3491 W3)', () => {
	test.each([
		[
			'write-only (block_destructive_commands:false — the laundered channel)',
			false,
		],
		['default config', undefined],
		['destructive config', true],
	])('echo ok; sudo×65 rm -rf ../../outside DENIES (%s)', async (_label, destructive) => {
		const got = await gate(`echo ok; ${SUDO65}`, destructive);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/inspection bound/);
	});

	test.each([
		['write-only (the laundered channel)', false],
		['destructive config', true],
	])('echo ok; command×65 rm -rf ../../outside DENIES (%s)', async (_label, destructive) => {
		const got = await gate(`echo ok; ${COMMAND65}`, destructive);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/inspection bound/);
	});

	test('control: the same compound with a shallow chain admits (no over-block)', async () => {
		const got = await gate(`echo ok; sudo rm -rf node_modules`, true);
		expect(got.verdict).toBe('ADMITTED');
	});
});

describe('review advisory 1: quoted/escaped time selects the binary grammar', () => {
	test('\\time -o ../outside.txt true → DENIED (timing-report write target)', async () => {
		const got = await gate(String.raw`\time -o ../outside.txt true`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/^WRITE BLOCKED/);
	});

	test("'time' -o ../outside.txt true → DENIED (quotes suppress the keyword too)", async () => {
		const got = await gate("'time' -o ../outside.txt true");
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/^WRITE BLOCKED/);
	});

	test('"time" -o ../outside.txt true → DENIED', async () => {
		const got = await gate('"time" -o ../outside.txt true');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/^WRITE BLOCKED/);
	});

	test('\\time -p true ADMITS (-p is valid in BOTH grammars; the timed tail is benign)', async () => {
		const got = await gate(String.raw`\time -p true`);
		expect(got.verdict).toBe('ADMITTED');
	});

	test('bare keyword `time -o FILE true` ADMITS (keyword: -o IS the command word — nothing runs)', async () => {
		const got = await gate('time -o ../outside.txt true');
		expect(got.verdict).toBe('ADMITTED');
	});
});

describe('review REQUIRED: explain parity for the compound depth deny', () => {
	const explainRoots: string[] = [];
	afterEach(() => {
		for (const root of explainRoots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test.each([
		['echo ok; ' + SUDO65],
		['echo ok; ' + COMMAND65],
	])('%s explains as block', async (command) => {
		const root = canonicalMkdtemp('w3depth-explain-');
		explainRoots.push(root);
		// The review leg splits on spaces; the depth chains repeat words, so
		// re-join defensively (the dispatcher's whitespace split is the
		// production contract for explain's input).
		const explained = await handleGuardrailExplain(root, [
			'--scope',
			'src/',
			...command.split(' '),
		]);
		expect(explained).toMatch(/\| *Decision *\| *block */i);
	});
});
