/**
 * Issue #3381 (AC2 + AC3): hardening pins for
 * `validateCoderReviewerAcceptanceField` (src/hooks/delegation-gate.ts).
 *
 * Two gaps in the validator are pinned here:
 *
 *  - "zero-width" (AC2): a zero-width space (U+200B) is NOT whitespace for
 *    `String.prototype.trim()`, so both `ACCEPTANCE:<ZWSP>` (inline) and a
 *    bare `ACCEPTANCE:` header followed by a ZWSP-only line count as
 *    "content" today and slip a criteria-free coder/reviewer dispatch past
 *    the pre-dispatch gate. Both must be rejected as
 *    `acceptance_field_empty`. At base these legs are RED (the validator
 *    returns `{ valid: true }`).
 *
 *  - "own field" (AC3): the gate feeds the validator the Task tool's text
 *    fields joined with `\n`
 *    (ACCEPTANCE_ARGS_FIELDS.map(...).join('\n'), see delegation-gate.ts).
 *    A bare `ACCEPTANCE:` header at the END of one field must not borrow
 *    the NEXT field's text as its criteria via the multi-line
 *    following-line scan. At base the joined shape
 *    `['T\nACCEPTANCE:', 'next field text'].join('\n')` validates as
 *    `{ valid: true }` — this leg is RED.
 *
 * Control legs (green at base AND after the fix) prove the RED legs fail
 * for the pinned reasons, not because the validator regressed broadly:
 * a real inline criterion stays valid, a truly-bare own-field header is
 * still `acceptance_field_empty`, and a genuine multi-line criteria block
 * (the PR #1864 verbatim-copy format, same shape the preserving suite
 * `delegation-gate-acceptance-field.test.ts` already pins) stays valid.
 */

import { afterEach, beforeEach, describe, expect, it, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { validateCoderReviewerAcceptanceField } from '../../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import {
	createDelegationGateHook,
	makeConfig,
} from './_delegation-gate-helpers';

const ZWSP = '\u200B' as const;

describe('zero-width (AC2 — issue #3381)', () => {
	it('RED-at-base: inline ZWSP-only content must be acceptance_field_empty, not valid', () => {
		const result = validateCoderReviewerAcceptanceField(
			`TASK: x\nACCEPTANCE:${ZWSP}`,
		);
		expect(result.valid).toBe(false);
		expect(result.reason).toBe('acceptance_field_empty');
	});

	it('RED-at-base: a ZWSP-only line after a bare header must be acceptance_field_empty, not valid', () => {
		const result = validateCoderReviewerAcceptanceField(
			`TASK: x\nACCEPTANCE:\n${ZWSP}`,
		);
		expect(result.valid).toBe(false);
		expect(result.reason).toBe('acceptance_field_empty');
	});

	it('control (green at base): a real inline criterion stays valid', () => {
		const result = validateCoderReviewerAcceptanceField(
			'ACCEPTANCE: real criterion',
		);
		expect(result.valid).toBe(true);
		expect(result.reason).toBeUndefined();
	});

	it('control (green at base): a truly bare ACCEPTANCE header at end of input is acceptance_field_empty', () => {
		const result = validateCoderReviewerAcceptanceField('TASK: x\nACCEPTANCE:');
		expect(result.valid).toBe(false);
		expect(result.reason).toBe('acceptance_field_empty');
	});

	it('control (green at base): a genuine multi-line criteria block stays valid', () => {
		// Same verbatim FR/SC copy shape the preserving suite pins in
		// delegation-gate-acceptance-field.test.ts (bare header + bullet
		// criteria + next-field terminator). Must remain valid after the
		// hardening: the fix may not break the good-faith multi-line format.
		const result = validateCoderReviewerAcceptanceField(
			'TASK: x\nACCEPTANCE:\n- **FR-001 — Foo.** The system SHALL do X.\n- **FR-002 — Bar.** And also Y.\nSKILLS: none',
		);
		expect(result.valid).toBe(true);
		expect(result.reason).toBeUndefined();
	});
});

describe('own field (AC3 — issue #3381; hook-level legs)', () => {
	// AMENDED (plan-critic round 1, CHECK_WRONG): the original leg called the
	// validator directly on the pre-joined string. The fix lands at the CALL
	// SITE (the gate joins the Task text fields before validating), so a
	// validator-level joined-string leg can never go green under a correct
	// fix — and satisfying it inside the validator would need a heuristic
	// that breaks the legitimate same-field multi-line format. These legs
	// drive the REAL delegation-gate hook with separate Task args, which is
	// the abstraction AC3 names ("a bare ACCEPTANCE: ends one field and the
	// next dispatch field holds text").
	let directory = '';
	let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;
	const SESSION_ID = 'test-session-ownfield';
	let callCounter = 0;

	beforeEach(async () => {
		isolatedEnv = createIsolatedTestEnv();
		resetSwarmState();
		directory = canonicalMkdtemp('swarm-ownfield-test-');
		await mkdir(join(directory, '.swarm'), { recursive: true });
		// Project-boundary marker (same reason as the auto-inject suite: a host
		// whose real home holds .swarm + .opencode would claim the fixture dir).
		await mkdir(join(directory, '.opencode'), { recursive: true });
	});

	afterEach(async () => {
		resetSwarmState();
		if (directory) {
			await rm(directory, { recursive: true, force: true });
		}
		isolatedEnv?.cleanup();
		isolatedEnv = undefined;
	});

	function makeHook() {
		return createDelegationGateHook(makeConfig(undefined), directory);
	}

	async function dispatch(
		hook: ReturnType<typeof makeHook>,
		args: Record<string, unknown>,
	): Promise<Error | undefined> {
		callCounter += 1;
		try {
			await hook.toolBefore(
				{
					tool: 'Task',
					sessionID: SESSION_ID,
					callID: `ownfield-call-${callCounter}`,
				},
				{ args },
			);
			return undefined;
		} catch (error) {
			return error as Error;
		}
	}

	test("RED-at-base: a bare ACCEPTANCE at the end of prompt must not borrow description's text (dispatch rejected)", async () => {
		ensureAgentSession(SESSION_ID, 'architect', directory);
		const error = await dispatch(makeHook(), {
			subagent_type: 'coder',
			prompt: 'T\nACCEPTANCE:',
			description: 'next field text',
		});
		// At base the joined-text validation counts description's first line,
		// so the acceptance gate PASSES and the dispatch is stopped later (by
		// the scope gate) — the RED signature is the absence of the acceptance
		// rejection. After the fix the header is judged against its own field,
		// the gate rejects with the empty-field reason, and the message names
		// ACCEPTANCE_FIELD_REQUIRED like every other strict rejection.
		expect(error?.message).toContain('ACCEPTANCE_FIELD_REQUIRED');
	});

	test("RED-at-base (plan-critic round 2): a lone-CR trailing 'header' in prompt must not borrow description's text either", async () => {
		// 'ACCEPTANCE:\r' (lone CR, no LF) is not recognized as a header line
		// by the validator (its header regex and \r?\n split leave the CR
		// outside the match in a way that yields acceptance_field_missing for
		// the prompt alone), yet the JOINED text passes at base because the
		// multi-line scan counts description's first line — the same
		// cross-field borrowing defect as the leg above with a CR-mediated
		// spelling. The fix must fail closed whenever NO field independently
		// validates, not only when a carrier returns acceptance_field_empty.
		ensureAgentSession(SESSION_ID, 'architect', directory);
		const error = await dispatch(makeHook(), {
			subagent_type: 'coder',
			prompt: 'ACCEPTANCE:\r',
			description: 'next field text',
		});
		expect(error?.message).toContain('ACCEPTANCE_FIELD_REQUIRED');
	});

	test('control (green at base and after the fix): genuine criteria inside one field pass the acceptance gate', async () => {
		ensureAgentSession(SESSION_ID, 'architect', directory);
		const error = await dispatch(makeHook(), {
			subagent_type: 'coder',
			prompt: 'Implement X\nACCEPTANCE: it works end to end',
			description: 'next field text',
		});
		expect(error?.message).not.toContain('ACCEPTANCE_FIELD_REQUIRED');
	});

	test('control (green at base and after the fix): a genuine multi-line criteria block inside one field passes', async () => {
		ensureAgentSession(SESSION_ID, 'architect', directory);
		const error = await dispatch(makeHook(), {
			subagent_type: 'coder',
			prompt:
				'Implement X\nACCEPTANCE:\n- **FR-001 — Foo.** The system SHALL do X.\n- **FR-002 — Bar.** And also Y.',
			description: 'next field text',
		});
		expect(error?.message).not.toContain('ACCEPTANCE_FIELD_REQUIRED');
	});
});
