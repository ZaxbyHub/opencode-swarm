/**
 * Issue #1687 (FR-003 / SC-003 / SC-004): pre-dispatch acceptance-criteria
 * enforcement for coder and reviewer delegations.
 *
 * Two layers are covered here:
 *  1. Direct unit tests of the exported, named production function
 *     `validateCoderReviewerAcceptanceField` (the enforcement logic SC-004
 *     requires to be discoverable and named).
 *  2. Integration tests that drive the REAL `toolBefore` hook, proving the
 *     function has a genuine BLOCKING call site in the pre-dispatch coder/
 *     reviewer interception path (SC-004: "at least one production caller that
 *     BLOCKS dispatch ... from within the actual pre-dispatch toolBefore
 *     interception"). A green unit test alone would not prove the call site.
 *
 * Scope discipline: non-coder/reviewer targets (sme/explorer/critic/...) MUST
 * NOT be gated by this check, and the M15 advisory mechanism
 * (appendDelegationEnvelopeAdvisory / toolAfter) is out of scope here and left
 * intact — its own coverage lives in delegation-gate-envelope.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import type { Plan } from '../../../src/config/plan-schema';
import {
	createDelegationGateHook,
	validateCoderReviewerAcceptanceField,
} from '../../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { recordPlanCriticApproval } from './_delegation-gate-helpers';

function makeConfig(): PluginConfig {
	return {
		hooks: { delegation_gate: true },
	} as unknown as PluginConfig;
}

function toolBeforeInput(sessionID: string, callID = 'call-1') {
	return { tool: 'Task', sessionID, callID };
}

describe('validateCoderReviewerAcceptanceField (unit)', () => {
	it('accepts a prompt with a populated ACCEPTANCE line', () => {
		const result = validateCoderReviewerAcceptanceField(
			'TASK: do the thing\nACCEPTANCE: FR-001 the widget renders correctly',
		);
		expect(result.valid).toBe(true);
		expect(result.reason).toBeUndefined();
	});

	it('rejects a prompt with no ACCEPTANCE line at all', () => {
		const result = validateCoderReviewerAcceptanceField(
			'TASK: do the thing\nFILE: src/foo.ts',
		);
		expect(result.valid).toBe(false);
		expect(result.reason).toBe('acceptance_field_missing');
	});

	it('rejects a prompt whose ACCEPTANCE line is empty', () => {
		const result = validateCoderReviewerAcceptanceField(
			'TASK: do the thing\nACCEPTANCE:',
		);
		expect(result.valid).toBe(false);
		expect(result.reason).toBe('acceptance_field_empty');
	});

	it('rejects a prompt whose ACCEPTANCE line is whitespace-only', () => {
		const result = validateCoderReviewerAcceptanceField(
			'TASK: do the thing\nACCEPTANCE:    \t  ',
		);
		expect(result.valid).toBe(false);
		expect(result.reason).toBe('acceptance_field_empty');
	});

	it('is case-insensitive on the ACCEPTANCE header', () => {
		const result = validateCoderReviewerAcceptanceField(
			'task: x\nacceptance: done when tests pass',
		);
		expect(result.valid).toBe(true);
	});

	it('accepts CRLF-authored prompts (no false "missing" from a trailing \\r)', () => {
		const result = validateCoderReviewerAcceptanceField(
			'TASK: do the thing\r\nACCEPTANCE: done when tests pass\r\n',
		);
		expect(result.valid).toBe(true);
	});

	it('does not treat an incidental mid-line "ACCEPTANCE:" as the field header', () => {
		const result = validateCoderReviewerAcceptanceField(
			'TASK: x\nCONSTRAINT: do not remove the ACCEPTANCE: handling elsewhere',
		);
		expect(result.valid).toBe(false);
		expect(result.reason).toBe('acceptance_field_missing');
	});

	it('does not match the reviewer output field ACCEPTANCE_SATISFACTION:', () => {
		// `^ACCEPTANCE:` requires the colon immediately after ACCEPTANCE, so
		// ACCEPTANCE_SATISFACTION: is not a false positive.
		const result = validateCoderReviewerAcceptanceField(
			'TASK: x\nACCEPTANCE_SATISFACTION: SATISFIED',
		);
		expect(result.valid).toBe(false);
		expect(result.reason).toBe('acceptance_field_missing');
	});

	// ---- multi-line ACCEPTANCE section (PR #1864 review feedback) ----
	// A bare `ACCEPTANCE:` header whose content follows on subsequent lines (a
	// plausible verbatim-copy format for a wrapped/multi-line FR body) must NOT
	// be false-blocked as empty.
	it('accepts a bare ACCEPTANCE header with content on the following line', () => {
		const result = validateCoderReviewerAcceptanceField(
			'TASK: x\nACCEPTANCE:\n- **FR-001 — Foo.** The system SHALL render the widget.',
		);
		expect(result.valid).toBe(true);
		expect(result.reason).toBeUndefined();
	});

	it('accepts a multi-line ACCEPTANCE body terminated by a following field header', () => {
		const result = validateCoderReviewerAcceptanceField(
			'TASK: x\nACCEPTANCE:\n- **FR-001 — Foo.** The system SHALL do X.\n- **FR-002 — Bar.** And also Y.\nSKILLS: none',
		);
		expect(result.valid).toBe(true);
	});

	it('accepts a bare ACCEPTANCE header with a leading blank line then content', () => {
		const result = validateCoderReviewerAcceptanceField(
			'TASK: x\nACCEPTANCE:\n\nthe widget renders correctly and is covered by a test',
		);
		expect(result.valid).toBe(true);
	});

	it('accepts a CRLF-authored multi-line ACCEPTANCE section', () => {
		const result = validateCoderReviewerAcceptanceField(
			'TASK: x\r\nACCEPTANCE:\r\n- **FR-001.** The system SHALL do X.\r\nSKILLS: none\r\n',
		);
		expect(result.valid).toBe(true);
	});

	// Bypass resistance: a bare header immediately followed by another field
	// header has NO content of its own — the next field's content must not be
	// miscounted as ACCEPTANCE content.
	it('rejects a bare ACCEPTANCE header immediately followed by another field header', () => {
		const result = validateCoderReviewerAcceptanceField(
			'TASK: x\nACCEPTANCE:\nSKILLS: none',
		);
		expect(result.valid).toBe(false);
		expect(result.reason).toBe('acceptance_field_empty');
	});

	it('rejects a bare ACCEPTANCE header followed only by blank lines then a field header', () => {
		const result = validateCoderReviewerAcceptanceField(
			'TASK: x\nACCEPTANCE:\n   \n\nOUTPUT: a diff',
		);
		expect(result.valid).toBe(false);
		expect(result.reason).toBe('acceptance_field_empty');
	});
});

describe('toolBefore acceptance-field gate (integration, SC-003/SC-004)', () => {
	let testDir: string;

	beforeEach(async () => {
		resetSwarmState();
		testDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-field-')),
		);
		fs.mkdirSync(path.join(testDir, '.swarm'), { recursive: true });
		const plan: Plan = {
			schema_version: '1.0.0',
			title: 'Acceptance field integration',
			swarm: 'test',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Implementation',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'Exercise the acceptance gate',
							depends: [],
							files_touched: ['src/foo.ts'],
						},
					],
				},
			],
		};
		fs.writeFileSync(
			path.join(testDir, '.swarm', 'plan.json'),
			JSON.stringify(plan),
		);
		await recordPlanCriticApproval(testDir, plan);
	});
	afterEach(() => {
		resetSwarmState();
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	// ---- coder (a/b/c) ----
	it('(a) allows a coder dispatch that carries a non-empty ACCEPTANCE field', async () => {
		const hooks = createDelegationGateHook(makeConfig(), testDir);
		ensureAgentSession('sess-coder-ok', 'architect');
		await expect(
			hooks.toolBefore(toolBeforeInput('sess-coder-ok'), {
				args: {
					subagent_type: 'coder',
					prompt:
						'TASK: 1.1\nACCEPTANCE: FR-001 the feature works and is tested',
				},
			}),
		).resolves.toBeUndefined();
	});

	it('(b) blocks a coder dispatch with no ACCEPTANCE field', async () => {
		const hooks = createDelegationGateHook(makeConfig(), testDir);
		ensureAgentSession('sess-coder-missing', 'architect');
		await expect(
			hooks.toolBefore(toolBeforeInput('sess-coder-missing'), {
				args: { subagent_type: 'coder', prompt: 'TASK: implement it' },
			}),
		).rejects.toThrow('ACCEPTANCE_FIELD_REQUIRED');
	});

	it('(c) blocks a coder dispatch with a whitespace-only ACCEPTANCE field', async () => {
		const hooks = createDelegationGateHook(makeConfig(), testDir);
		ensureAgentSession('sess-coder-empty', 'architect');
		await expect(
			hooks.toolBefore(toolBeforeInput('sess-coder-empty'), {
				args: {
					subagent_type: 'coder',
					prompt: 'TASK: implement it\nACCEPTANCE:    ',
				},
			}),
		).rejects.toThrow('ACCEPTANCE_FIELD_REQUIRED');
	});

	it('(a2) allows a coder dispatch whose ACCEPTANCE is a multi-line section', async () => {
		const hooks = createDelegationGateHook(makeConfig(), testDir);
		ensureAgentSession('sess-coder-multiline', 'architect');
		await expect(
			hooks.toolBefore(toolBeforeInput('sess-coder-multiline'), {
				args: {
					subagent_type: 'coder',
					prompt:
						'TASK: 1.1\nACCEPTANCE:\n- **FR-001 — Foo.** The system SHALL render the widget.\nSKILLS: none',
				},
			}),
		).resolves.toBeUndefined();
	});

	// ---- reviewer (d) ----
	it('(d1) allows a reviewer dispatch that carries a non-empty ACCEPTANCE field', async () => {
		const hooks = createDelegationGateHook(makeConfig(), testDir);
		ensureAgentSession('sess-rev-ok', 'architect');
		await expect(
			hooks.toolBefore(toolBeforeInput('sess-rev-ok'), {
				args: {
					subagent_type: 'reviewer',
					prompt:
						'TASK: review it\nACCEPTANCE: FR-002 the diff satisfies the requirement',
				},
			}),
		).resolves.toBeUndefined();
	});

	it('(d2) blocks a reviewer dispatch with no ACCEPTANCE field', async () => {
		const hooks = createDelegationGateHook(makeConfig(), testDir);
		ensureAgentSession('sess-rev-missing', 'architect');
		await expect(
			hooks.toolBefore(toolBeforeInput('sess-rev-missing'), {
				args: { subagent_type: 'reviewer', prompt: 'TASK: review it' },
			}),
		).rejects.toThrow('ACCEPTANCE_FIELD_REQUIRED');
	});

	it('(d3) blocks a reviewer dispatch with an empty ACCEPTANCE field', async () => {
		const hooks = createDelegationGateHook(makeConfig(), testDir);
		ensureAgentSession('sess-rev-empty', 'architect');
		await expect(
			hooks.toolBefore(toolBeforeInput('sess-rev-empty'), {
				args: {
					subagent_type: 'reviewer',
					prompt: 'TASK: review it\nACCEPTANCE:',
				},
			}),
		).rejects.toThrow('ACCEPTANCE_FIELD_REQUIRED');
	});

	it('blocks a prefixed coder target (mega_coder) missing ACCEPTANCE', async () => {
		const hooks = createDelegationGateHook(makeConfig(), testDir);
		ensureAgentSession('sess-mega', 'architect');
		await expect(
			hooks.toolBefore(toolBeforeInput('sess-mega'), {
				args: { subagent_type: 'mega_coder', prompt: 'TASK: implement it' },
			}),
		).rejects.toThrow('ACCEPTANCE_FIELD_REQUIRED');
	});

	// ---- scope discipline (e) ----
	it('(e1) does NOT gate an sme dispatch that lacks an ACCEPTANCE field', async () => {
		const hooks = createDelegationGateHook(makeConfig(), testDir);
		ensureAgentSession('sess-sme', 'architect');
		// resolves (no throw of ANY kind) proves the acceptance gate never fired —
		// strictly stronger than asserting "not ACCEPTANCE_FIELD_REQUIRED".
		await expect(
			hooks.toolBefore(toolBeforeInput('sess-sme'), {
				args: { subagent_type: 'sme', prompt: 'TASK: advise on approach' },
			}),
		).resolves.toBeUndefined();
	});

	it('(e2) does NOT gate an explorer dispatch that lacks an ACCEPTANCE field', async () => {
		const hooks = createDelegationGateHook(makeConfig(), testDir);
		ensureAgentSession('sess-explorer', 'architect');
		await expect(
			hooks.toolBefore(toolBeforeInput('sess-explorer'), {
				args: { subagent_type: 'explorer', prompt: 'find where X lives' },
			}),
		).resolves.toBeUndefined();
	});

	it('(e3) does NOT gate a critic dispatch that lacks an ACCEPTANCE field', async () => {
		const hooks = createDelegationGateHook(makeConfig(), testDir);
		ensureAgentSession('sess-critic', 'architect');
		await expect(
			hooks.toolBefore(toolBeforeInput('sess-critic'), {
				args: { subagent_type: 'critic', prompt: 'challenge the finding' },
			}),
		).resolves.toBeUndefined();
	});

	it('does not fire for a non-Task tool even with a coder-looking arg', async () => {
		const hooks = createDelegationGateHook(makeConfig(), testDir);
		ensureAgentSession('sess-nontask', 'architect');
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'sess-nontask', callID: 'c1' },
				{ args: { subagent_type: 'coder', command: 'ls' } },
			),
		).resolves.toBeUndefined();
	});
});
