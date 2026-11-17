/**
 * Issue #3617 feedback round (PRR-005/F-01 + PRR-012/F-08b) — negative and
 * compatibility legs for the incremental-verify trigger gate.
 *
 * RED at base would be: the compat arm absent (compat leg fails) and the raw
 * leg present-but-unpinned. This suite is NEW (the positive legs live in the
 * frozen incremental-verify-underscore-trigger.test.ts; this sibling file
 * keeps that file byte-stable per the checkpoint contract).
 *
 * Legs:
 * - negative: a dispatched agent that matches NO trigger entry runs nothing
 *   (a gate-removal mutant — "every dispatch triggers a typecheck" — fails
 *   this leg);
 * - compat (PRR-005/F-01): a pre-#3330 naive prefix-stripped trigger entry
 *   ('custom' for dispatched 'acme_custom') keeps firing;
 * - raw-arm pin: a trigger entry spelled exactly as dispatched but distinct
 *   from the canonical role ('code-coder' -> canonical 'coder') keeps firing
 *   through the raw-name arm alone.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	deleteStoredInputArgs,
	setStoredInputArgs,
} from '../../../src/hooks/guardrails/stored-input-args';
import type { IncrementalVerifyHook } from '../../../src/hooks/incremental-verify';
import {
	createIncrementalVerifyHook,
	resetAdvisoryDedup,
} from '../../../src/hooks/incremental-verify';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

describe('incremental-verify trigger gate — negative and compat legs (#3617)', () => {
	let projectDir = '';
	let messages: Array<{ sessionId: string; message: string }>;
	let hook: IncrementalVerifyHook;
	let callIDs: string[];

	function makeHook(triggerAgents: string[]): void {
		hook = createIncrementalVerifyHook(
			{
				enabled: true,
				triggerAgents,
				command: ['bun', '--version'],
				timeoutMs: 10_000,
			},
			projectDir,
			(sessionId, message) => messages.push({ sessionId, message }),
		);
	}

	async function drive(subagentType: string): Promise<boolean> {
		resetAdvisoryDedup();
		messages.length = 0;
		const callID = `call-${subagentType}`;
		callIDs.push(callID);
		setStoredInputArgs(callID, { subagent_type: subagentType });
		await hook.toolAfter(
			{ tool: 'task', sessionID: `sess-${subagentType}`, callID },
			{ output: 'ok' },
		);
		return messages.length > 0;
	}

	beforeEach(() => {
		projectDir = canonicalMkdtemp('j3617-incr-negative-');
		messages = [];
		callIDs = [];
	});

	afterEach(() => {
		for (const callID of callIDs) {
			deleteStoredInputArgs(callID);
		}
		resetAdvisoryDedup();
		removeTreeWithRetry(projectDir);
	});

	test('negative: a non-trigger dispatched agent runs nothing', async () => {
		makeHook(['test_engineer']);
		expect(await drive('coder')).toBe(false);
		expect(await drive('reviewer')).toBe(false);
	});

	test('negative: the dispatched name must still match an entry (not every name fires)', async () => {
		makeHook(['coder']);
		expect(await drive('reviewer')).toBe(false);
	});

	test('compat (PRR-005/F-01): pre-#3330 naive prefix-stripped entries keep firing', async () => {
		// Base replaced 'acme_custom' with 'custom'; configs listing that
		// non-canonical form must keep working after the canonical swap.
		makeHook(['custom']);
		expect(await drive('acme_custom')).toBe(true);
	});

	test('raw-arm pin: an entry spelled exactly as dispatched matches via the raw arm', async () => {
		// 'code-coder' canonicalizes to 'coder', which is NOT an entry; only
		// the raw-name compatibility arm can match this dispatch.
		makeHook(['code-coder']);
		expect(await drive('code-coder')).toBe(true);
	});

	test('padded-trigger (#3625): a whitespace-padded dispatch matches via every trimmed-derived form', async () => {
		// Before #3625 all three trigger forms derived from the RAW padded
		// spelling, so ' Case_coder ' matched no unpadded entry on any arm (the
		// suffix extractor cannot see '_coder' through the trailing space).
		// Canonical arm: ' mega_local_coder ' resolves only through the
		// canonical suffix extraction (its base-compat form 'local_coder' is
		// not 'coder'), so a revert of the canonical-arm trim fails this leg.
		makeHook(['coder']);
		expect(await drive(' mega_local_coder ')).toBe(true); // canonical arm
		expect(await drive(' coder ')).toBe(true); // bare canonical, padded
		makeHook(['Case_coder']);
		expect(await drive(' Case_coder ')).toBe(true); // raw arm
		makeHook(['custom']);
		expect(await drive(' acme_custom ')).toBe(true); // base-compat arm
		// Suffix near-miss: 'test_engineer' ends with 'engineer' but is not it,
		// so a suffix-matching over-matcher would flip this leg to true.
		makeHook(['engineer']);
		expect(await drive(' Case_test_engineer ')).toBe(false); // near-miss stays gated
	});
});
