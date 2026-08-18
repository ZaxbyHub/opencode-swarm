/**
 * Issue #1687 (F-007) — ADVERSARIAL hardening pass for the ACCEPTANCE-coverage
 * gate reviewed/approved in delegation-gate-acceptance-coverage.test.ts.
 *
 * This file does NOT re-test what the sibling file already covers. It probes
 * for the two failure modes that matter most for a mechanical text gate:
 *
 *  1. FALSE-BLOCK: a legitimate, verbatim (or trivially-reformatted) copy of a
 *     spec requirement body must NEVER be rejected. A false block here halts a
 *     real swarm run.
 *  2. BYPASS: a dispatch that does NOT actually carry the requirement body
 *     (token-only reference, paraphrase, partial copy) must ALWAYS be
 *     rejected — the gate is a mechanical substring check, not semantic, so
 *     these are the only kinds of bypass structurally possible.
 *
 * Plus: id-collision (word-boundary correctness for numerically-adjacent ids),
 * additional fail-open integration paths (ambiguous task id, mixed FR/SC
 * partial coverage), all driven through the REAL `toolBefore` hook wherever
 * feasible so wiring regressions (not just helper-level regressions) are
 * caught.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import type { Plan } from '../../../src/config/plan-schema';
import {
	checkAcceptanceCoversFrRefs,
	createDelegationGateHook,
	extractSpecRequirementBodyById,
} from '../../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { recordPlanCriticApproval } from './_delegation-gate-helpers';

// ---------------------------------------------------------------------------
// Fixture bodies / spec text (independent of the sibling file's fixture, per
// convention for sibling adversarial suites).
// ---------------------------------------------------------------------------
const FR001_BODY =
	'The widget SHALL render the configured label exactly once on mount.';
const FR002_BODY =
	'The task SHALL carry all mapped requirements when it maps to more than one.';
const FR1_BODY = 'The button SHALL emit exactly one click event per tap.';
const FR12_BODY = 'The button group SHALL space buttons evenly across the row.';
const MARKUP_BODY =
	'The `Foo` component SHALL use **strict** mode and log via `console.warn`.';
const SC006_BODY =
	'Given the multi-map task, when both requirements apply, then the acceptance covers both bodies.';

const ADV_SPEC_MD = [
	'# Spec Adversarial Fixture',
	'',
	'## Functional Requirements',
	'',
	`- **FR-001 — Widget renders.** ${FR001_BODY}`,
	`- **FR-002 — Multi map.** ${FR002_BODY}`,
	`- **FR-1 — Short id.** ${FR1_BODY}`,
	`- **FR-12 — Longer sibling id.** ${FR12_BODY}`,
	`- **FR-MARKUP — Markup body.** ${MARKUP_BODY}`,
	'',
	'## Success Criteria',
	'',
	`- **SC-001 (FR-001).** Given a mounted widget, when the label is set, then it appears verbatim.`,
	`- **SC-006 (FR-002).** ${SC006_BODY}`,
	'',
].join('\n');

// ===========================================================================
// Group A — pure-unit probes (no toolBefore) for id-collision / markup /
// separator-agnostic multi-FR concatenation / CRLF.
// ===========================================================================

describe('ADVERSARIAL: id-collision word-boundary (extractSpecRequirementBodyById)', () => {
	it('FR-1 does not resolve to the FR-12 body (numerically-adjacent ids)', () => {
		const body = extractSpecRequirementBodyById(ADV_SPEC_MD, 'FR-1');
		expect(body).not.toBeNull();
		expect((body as string).trim()).toBe(FR1_BODY);
		expect(body).not.toContain('button group');
	});

	it('FR-12 does not resolve to the FR-1 body (reverse direction)', () => {
		const body = extractSpecRequirementBodyById(ADV_SPEC_MD, 'FR-12');
		expect(body).not.toBeNull();
		expect((body as string).trim()).toBe(FR12_BODY);
		expect(body).not.toContain('one click event');
	});

	it('checkAcceptanceCoversFrRefs: FR-1 is NOT satisfied by the FR-12 body alone', () => {
		// ACCEPTANCE reproduces FR-12's body but the task only maps FR-1 — must
		// still report not-covered for FR-1 (proves the extractor keyed on the
		// correct, distinct body rather than any FR-1*-prefixed line).
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText: `ACCEPTANCE: ${FR12_BODY}`,
			frRefs: ['FR-1'],
			specText: ADV_SPEC_MD,
		});
		expect(result).toMatchObject({ covered: false, missingId: 'FR-1' });
	});

	it('checkAcceptanceCoversFrRefs: FR-1 IS satisfied by its own body even with FR-12 present in spec', () => {
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText: `ACCEPTANCE: ${FR1_BODY}`,
			frRefs: ['FR-1'],
			specText: ADV_SPEC_MD,
		});
		expect(result).toEqual({ covered: true });
	});
});

describe('ADVERSARIAL: false-block resistance (checkAcceptanceCoversFrRefs, pure)', () => {
	it('covered when spec body itself contains backticks/**bold** and ACCEPTANCE reproduces them verbatim', () => {
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText: `ACCEPTANCE: ${MARKUP_BODY}`,
			frRefs: ['FR-MARKUP'],
			specText: ADV_SPEC_MD,
		});
		expect(result).toEqual({ covered: true });
	});

	it('covered when ACCEPTANCE concatenates two bodies with a blank-line separator', () => {
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText: `ACCEPTANCE: ${FR001_BODY}\n\n${FR002_BODY}`,
			frRefs: ['FR-001', 'FR-002'],
			specText: ADV_SPEC_MD,
		});
		expect(result).toEqual({ covered: true });
	});

	it('covered when ACCEPTANCE concatenates two bodies with only a single newline separator', () => {
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText: `ACCEPTANCE: ${FR001_BODY}\n${FR002_BODY}`,
			frRefs: ['FR-001', 'FR-002'],
			specText: ADV_SPEC_MD,
		});
		expect(result).toEqual({ covered: true });
	});

	it('covered when ACCEPTANCE concatenates two bodies with an arbitrary punctuation separator', () => {
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText: `ACCEPTANCE: ${FR001_BODY} | ${FR002_BODY}`,
			frRefs: ['FR-001', 'FR-002'],
			specText: ADV_SPEC_MD,
		});
		expect(result).toEqual({ covered: true });
	});

	it('covered when spec.md uses CRLF line endings and ACCEPTANCE has a trailing CR', () => {
		const crlfSpec = ADV_SPEC_MD.replace(/\n/g, '\r\n');
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText: `ACCEPTANCE: ${FR001_BODY}\r\n`,
			frRefs: ['FR-001'],
			specText: crlfSpec,
		});
		expect(result).toEqual({ covered: true });
	});

	it('covered when the copy includes the leading "- " bullet marker plus the full bold id/title prefix', () => {
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText: `ACCEPTANCE: - **FR-001 — Widget renders.** ${FR001_BODY}`,
			frRefs: ['FR-001'],
			specText: ADV_SPEC_MD,
		});
		expect(result).toEqual({ covered: true });
	});
});

describe('ADVERSARIAL: bypass resistance (checkAcceptanceCoversFrRefs, pure)', () => {
	it('rejects an ACCEPTANCE that contains only the FR id TOKEN, not the body text', () => {
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText:
				'ACCEPTANCE: satisfies FR-001 requirements as discussed with the team',
			frRefs: ['FR-001'],
			specText: ADV_SPEC_MD,
		});
		expect(result).toMatchObject({ covered: false, missingId: 'FR-001' });
	});

	it('rejects a PARAPHRASE of the requirement body (same meaning, different words)', () => {
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText:
				'ACCEPTANCE: the widget should show its label once it mounts, matching config',
			frRefs: ['FR-001'],
			specText: ADV_SPEC_MD,
		});
		expect(result).toMatchObject({ covered: false, missingId: 'FR-001' });
	});

	it('rejects a PARTIAL copy — only the first half of the body', () => {
		const half = FR001_BODY.slice(0, Math.floor(FR001_BODY.length / 2));
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText: `ACCEPTANCE: ${half}`,
			frRefs: ['FR-001'],
			specText: ADV_SPEC_MD,
		});
		expect(result).toMatchObject({ covered: false, missingId: 'FR-001' });
	});

	it('rejects a PARTIAL copy — only the second half of the body (no anchoring assumption)', () => {
		const half = FR001_BODY.slice(Math.floor(FR001_BODY.length / 2));
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText: `ACCEPTANCE: ${half}`,
			frRefs: ['FR-001'],
			specText: ADV_SPEC_MD,
		});
		expect(result).toMatchObject({ covered: false, missingId: 'FR-001' });
	});
});

// ===========================================================================
// Group B — integration through the REAL toolBefore hook.
// ===========================================================================

function makeConfig(): PluginConfig {
	return { hooks: { delegation_gate: true } } as unknown as PluginConfig;
}

function makeTempProject(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const real = fs.realpathSync(dir);
	fs.mkdirSync(path.join(real, '.swarm'), { recursive: true });
	return real;
}

function toolBeforeInput(sessionID: string, callID = 'call-1') {
	return { tool: 'Task', sessionID, callID };
}

/**
 * Plan with:
 *  - 1.1 mapped to FR-001 only
 *  - 2.1 mapped to FR-001 AND SC-006 (mixed FR/SC multi-ref task)
 *  - 3.1 unmapped (no fr_refs) — used as the second id in the ambiguity probe
 */
async function writeAdvFixturePlan(dir: string): Promise<void> {
	const plan: Plan = {
		schema_version: '1.0.0' as const,
		title: 'Adversarial Coverage Test Plan',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small' as const,
						description: 'Mapped to FR-001 only',
						depends: [],
						files_touched: ['src/task-1.1.ts'],
						fr_refs: ['FR-001'],
					},
					{
						id: '2.1',
						phase: 1,
						status: 'pending',
						size: 'small' as const,
						description: 'Mapped to FR-001 and SC-006',
						depends: [],
						files_touched: ['src/task-2.1.ts'],
						fr_refs: ['FR-001', 'SC-006'],
					},
					{
						id: '3.1',
						phase: 1,
						status: 'pending',
						size: 'small' as const,
						description: 'Unmapped',
						depends: [],
						files_touched: ['src/task-3.1.ts'],
					},
				],
			},
		],
	} as Plan;
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
	fs.writeFileSync(path.join(dir, '.swarm', 'spec.md'), ADV_SPEC_MD);
	await recordPlanCriticApproval(dir, plan);
}

describe('ADVERSARIAL: toolBefore integration', () => {
	let tempDir: string;

	beforeEach(async () => {
		resetSwarmState();
		tempDir = makeTempProject('c1687-adv-');
		await writeAdvFixturePlan(tempDir);
	});

	afterEach(() => {
		resetSwarmState();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	// -- False-block direction: realistic legitimate copies must NOT throw ----

	it('coder: whole-bullet copy (leading "- " + bold id/title prefix) resolves', async () => {
		const hooks = createDelegationGateHook(makeConfig(), tempDir);
		ensureAgentSession('sess-adv-wholebullet', 'architect');
		await expect(
			hooks.toolBefore(toolBeforeInput('sess-adv-wholebullet'), {
				args: {
					subagent_type: 'coder',
					task_id: '1.1',
					prompt: `TASK: 1.1 implement it\nACCEPTANCE: - **FR-001 — Widget renders.** ${FR001_BODY}`,
				},
			}),
		).resolves.toBeUndefined();
	});

	it('coder: CRLF-authored prompt (body line ends with \\r\\n) resolves', async () => {
		const hooks = createDelegationGateHook(makeConfig(), tempDir);
		ensureAgentSession('sess-adv-crlf', 'architect');
		const prompt = `TASK: 1.1 implement it\r\nACCEPTANCE: ${FR001_BODY}\r\n`;
		await expect(
			hooks.toolBefore(toolBeforeInput('sess-adv-crlf'), {
				args: { subagent_type: 'coder', task_id: '1.1', prompt },
			}),
		).resolves.toBeUndefined();
	});

	it('coder: body reproduced with extra inline whitespace (tabs/double-spaces) resolves', async () => {
		const hooks = createDelegationGateHook(makeConfig(), tempDir);
		ensureAgentSession('sess-adv-ws', 'architect');
		const noisyBody = FR001_BODY.replace(/ /g, '  ').replace(
			'SHALL',
			'\tSHALL',
		);
		await expect(
			hooks.toolBefore(toolBeforeInput('sess-adv-ws'), {
				args: {
					subagent_type: 'coder',
					task_id: '1.1',
					prompt: `TASK: 1.1 implement it\nACCEPTANCE: ${noisyBody}`,
				},
			}),
		).resolves.toBeUndefined();
	});

	it('coder: markup body (backticks/**bold**) reproduced verbatim resolves', async () => {
		const hooks = createDelegationGateHook(makeConfig(), tempDir);
		ensureAgentSession('sess-adv-markup', 'architect');
		// Retarget 1.1 to the markup FR for this probe by writing a fresh plan.
		const plan: Plan = {
			schema_version: '1.0.0' as const,
			title: 'Markup Plan',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'pending',
							size: 'small' as const,
							description: 'Markup task',
							depends: [],
							files_touched: ['src/task-1.1.ts'],
							fr_refs: ['FR-MARKUP'],
						},
					],
				},
			],
		} as Plan;
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
		);
		await recordPlanCriticApproval(tempDir, plan);
		const hooks2 = createDelegationGateHook(makeConfig(), tempDir);
		await expect(
			hooks2.toolBefore(toolBeforeInput('sess-adv-markup'), {
				args: {
					subagent_type: 'coder',
					task_id: '1.1',
					prompt: `TASK: 1.1 implement it\nACCEPTANCE: ${MARKUP_BODY}`,
				},
			}),
		).resolves.toBeUndefined();
	});

	it('coder: multi-FR task, ACCEPTANCE concatenates both bodies with an arbitrary separator, resolves', async () => {
		const hooks = createDelegationGateHook(makeConfig(), tempDir);
		ensureAgentSession('sess-adv-multi-ok', 'architect');
		await expect(
			hooks.toolBefore(toolBeforeInput('sess-adv-multi-ok'), {
				args: {
					subagent_type: 'coder',
					task_id: '2.1',
					prompt: `TASK: 2.1 implement it\nACCEPTANCE: ${FR001_BODY}\n\n---\n\n${SC006_BODY}`,
				},
			}),
		).resolves.toBeUndefined();
	});

	// -- #2205: non-verbatim ACCEPTANCE dispatches with the verbatim body
	// injected (id-only, paraphrase, partial copy, mixed FR+SC). These moved to
	// delegation-gate-acceptance-injection.test.ts (FR-006 ratchet: this file is
	// over the 500-line cap and must not grow).

	// -- Fail-closed: ambiguous task-id resolution ------------------------------

	it('coder: TASK line references two valid task ids without task_id => fails closed', async () => {
		const hooks = createDelegationGateHook(makeConfig(), tempDir);
		ensureAgentSession('sess-adv-ambiguous', 'architect');
		// No explicit task_id field; the TASK: line mentions BOTH "1.1" (mapped,
		// FR-001) and "3.1" (unmapped) — both are valid plan task ids, so
		// resolveDelegatedPlanTaskId's ambiguity guard must not guess which task
		// scope should authorize the coder.
		await expect(
			hooks.toolBefore(toolBeforeInput('sess-adv-ambiguous'), {
				args: {
					subagent_type: 'coder',
					prompt:
						'TASK: migrate 1.1 and 3.1 together\nACCEPTANCE: lorem ipsum dolor sit amet',
				},
			}),
		).rejects.toThrow(/SCOPE_NOT_DECLARED|task_id/i);
	});
});
