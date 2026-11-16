/**
 * Issue #3322 (trace 3331-underscore-derivation-class, AC3+AC4+AC5) — the
 * incremental-verify trigger gate normalizes the delegated subagent type
 * with the naive first-underscore split
 * (`subagentType.replace(/^[^_]+_/, '')`, src/hooks/incremental-verify.ts),
 * the exact split #2960 eradicated from the Task-route resolver. The AC asks
 * the trigger to match via the canonical role derived by length delta from
 * `stripKnownSwarmPrefix` instead.
 *
 * Drives the REAL exported `createIncrementalVerifyHook` through its
 * `toolAfter` surface with `setStoredInputArgs`-recovered args (the same
 * path production uses, #1849) — harness mirrors the working probe at
 * .agents/issue-traces/3331-underscore-derivation-class/repro/
 * probe-3322-trigger-normalization.ts. Proceeds == a POST-CODER CHECK
 * advisory was queued via injectMessage; missed == the hook returned at the
 * trigger gate and queued nothing.
 *
 * Table legs (triggerAgents: ['test_engineer', 'coder']):
 * - 'test_engineer'            — unprefixed underscore trigger agent (AC3).
 *   Proceeds at base ONLY via the accidental raw-name arm; must keep
 *   proceeding when the derivation becomes canonical.
 * - 'mega_local_test_engineer' — double-prefixed (AC4). MISSED at base (naive
 *   split yields 'local_test_engineer', which is not a trigger entry, and the
 *   raw name is not either). This row is the file's RED discriminator:
 *   RED at base, GREEN after the fix.
 * - 'local_test_engineer'      — single-prefixed (AC5 preserving): proceeds
 *   at base via the naive arm (accidentally correct) and must keep
 *   proceeding.
 * - 'coder'                    — unprefixed non-underscore control (AC5
 *   preserving): proves the harness reaches the gate and the command path.
 *
 * Command is ['bun', '--version'] — spawnable on every OS this repo tests;
 * only the gate decision matters, so any exit code still counts as
 * "proceeded" (the advisory is PASS/FAILED-shaped, never absent).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	deleteStoredInputArgs,
	setStoredInputArgs,
} from '../../../src/hooks/guardrails/stored-input-args';
import {
	createIncrementalVerifyHook,
	type IncrementalVerifyHook,
	resetAdvisoryDedup,
} from '../../../src/hooks/incremental-verify';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

interface TriggerLeg {
	/** The subagent_type carried by the delegated Task. */
	subagentType: string;
	/** AC the leg covers. */
	acceptance: string;
}

const TRIGGER_LEGS: readonly TriggerLeg[] = [
	{
		subagentType: 'test_engineer',
		acceptance: 'AC3 — unprefixed underscore trigger agent still matches',
	},
	{
		subagentType: 'mega_local_test_engineer',
		acceptance:
			'AC4 — double-prefixed form normalizes to the canonical role (RED at base, GREEN after the fix)',
	},
	{
		subagentType: 'local_test_engineer',
		acceptance: 'AC5 — single-prefixed form keeps matching',
	},
	{
		subagentType: 'coder',
		acceptance: 'AC5 — unprefixed non-underscore control keeps matching',
	},
];

describe('incremental-verify trigger normalization — underscore agents (issue #3322)', () => {
	let projectDir = '';
	let messages: Array<{ sessionId: string; message: string }>;
	let hook: IncrementalVerifyHook;
	let callIDs: string[];

	beforeEach(() => {
		projectDir = canonicalMkdtemp('j3322-incr-verify-');
		messages = [];
		callIDs = [];
		resetAdvisoryDedup();
		hook = createIncrementalVerifyHook(
			{
				enabled: true,
				// 'coder' is the harness control: it must proceed at base,
				// proving the drive reaches the gate and the command path.
				triggerAgents: ['test_engineer', 'coder'],
				command: ['bun', '--version'],
				timeoutMs: 10_000,
			},
			projectDir,
			(sessionId, message) => messages.push({ sessionId, message }),
		);
	});

	afterEach(() => {
		for (const callID of callIDs) {
			deleteStoredInputArgs(callID);
		}
		resetAdvisoryDedup();
		removeTreeWithRetry(projectDir);
	});

	for (const leg of TRIGGER_LEGS) {
		test(`trigger gate proceeds for "${leg.subagentType}" (${leg.acceptance})`, async () => {
			// Fresh dedup state per leg so an earlier leg's advisory cannot
			// mask this leg's gate decision.
			resetAdvisoryDedup();
			messages.length = 0;
			const callID = `call-${leg.subagentType}`;
			callIDs.push(callID);
			// Production recovers the delegated subagent_type from the
			// toolBefore args snapshot keyed by callID (#1849).
			setStoredInputArgs(callID, { subagent_type: leg.subagentType });

			await hook.toolAfter(
				{ tool: 'task', sessionID: `sess-${leg.subagentType}`, callID },
				{ output: 'ok' },
			);

			// Proceeded => the trigger gate passed and a result advisory
			// (pass/fail — command-dependent, never gate-dependent) was
			// queued for the SAME session. Missed => nothing queued.
			expect(messages.length).toBeGreaterThan(0);
			expect(messages[0]?.sessionId).toBe(`sess-${leg.subagentType}`);
			expect(messages[0]?.message.startsWith('POST-CODER CHECK')).toBe(true);
		});
	}
});
