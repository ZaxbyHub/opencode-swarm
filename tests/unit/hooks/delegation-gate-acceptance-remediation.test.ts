/**
 * Issue #2063 (Workstream A1/A2) — the two ACCEPTANCE-gate errors
 * (`ACCEPTANCE_FIELD_REQUIRED`, `ACCEPTANCE_FIELD_COVERAGE_MISMATCH`) used to
 * point recovery at `src/agents/<role>.ts` — a path that does not exist in an
 * installed plugin deployment, sending agents spelunking into
 * `node_modules/opencode-swarm` / `~/.cache/opencode` instead of fixing their
 * own dispatch content (the actual root cause of issue #2063's endless
 * self-loops). This file is split out of
 * `delegation-gate-acceptance-coverage.test.ts` per the 500-line FR-006 cap
 * (test-file-split skill) and covers exactly the A1/A2 remediation-text
 * changes:
 *
 *  - A1: neither error contains a `src/agents/...` path reference, and both
 *    carry the anti-spelunking directive.
 *  - A2: the coverage-mismatch error embeds the raw, untrimmed requirement
 *    body for the missing id; bodies over `ACCEPTANCE_EXPECTED_BODY_CAP`
 *    (2000 chars) are truncated with a stated cap and a `.swarm/spec.md`
 *    pointer; the "PRESERVE LINE BREAKS" instruction exists because
 *    `normalizeAcceptanceText`'s list-marker strip is position-dependent (only
 *    a line-initial `-`/`*` marker is stripped) — a bulleted body reproduced
 *    WITH line breaks passes, but the same content flattened onto one line
 *    strands an un-stripped marker mid-body and fails.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import type { Plan } from '../../../src/config/plan-schema';
import {
	ACCEPTANCE_EXPECTED_BODY_CAP,
	buildAcceptanceCoverageMismatchError,
	checkAcceptanceCoversFrRefs,
	createDelegationGateHook,
} from '../../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { recordPlanCriticApproval } from './_delegation-gate-helpers';

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

async function writeSingleTaskPlan(
	dir: string,
	specMd: string,
	frRefs: string[],
): Promise<void> {
	const plan: Plan = {
		schema_version: '1.0.0' as const,
		title: 'Remediation Test Plan',
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
						description: 'Mapped task',
						depends: [],
						files_touched: ['src/mapped-task.ts'],
						fr_refs: frRefs,
					},
				],
			},
		],
	} as Plan;
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
	fs.writeFileSync(path.join(dir, '.swarm', 'spec.md'), specMd);
	await recordPlanCriticApproval(dir, plan);
}

// ===========================================================================
// A1 — no `src/agents/` reference; anti-spelunking directive present.
// ===========================================================================

describe('A1: gate errors are runtime-valid (no src/agents/ misdirection)', () => {
	let tempDir: string;

	beforeEach(async () => {
		resetSwarmState();
		tempDir = makeTempProject('c2063-a1-');
	});

	afterEach(() => {
		resetSwarmState();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	it('ACCEPTANCE_FIELD_REQUIRED does not reference src/agents/ and carries the anti-spelunking directive', async () => {
		const hooks = createDelegationGateHook(makeConfig(), tempDir);
		ensureAgentSession('sess-a1-required', 'architect');
		let caught: Error | undefined;
		try {
			await hooks.toolBefore(toolBeforeInput('sess-a1-required'), {
				args: { subagent_type: 'coder', prompt: 'TASK: implement it' },
			});
		} catch (err) {
			caught = err as Error;
		}
		expect(caught).toBeDefined();
		expect(caught?.message).toContain('ACCEPTANCE_FIELD_REQUIRED');
		expect(caught?.message).not.toContain('src/agents/');
		expect(caught?.message).toContain(
			'ACCEPTANCE FIELD RESOLUTION section of your system prompt',
		);
		expect(caught?.message).toContain('.swarm/spec.md');
		expect(caught?.message).toContain(
			'Do NOT investigate the installed swarm plugin package (node_modules/opencode-swarm, ~/.cache/opencode)',
		);
		expect(caught?.message).toContain(
			'If this same error repeats after 2 fix attempts, STOP and present the blocker to the user.',
		);
	});

	it('ACCEPTANCE_FIELD_COVERAGE_MISMATCH does not reference src/agents/ and carries the anti-spelunking directive', () => {
		// The mismatch throw is defense-in-depth after #2205's gate-side
		// injection (a lorem-ipsum ACCEPTANCE now dispatches WITH the verbatim
		// body injected), so the message contract is asserted through the
		// exported builder — the same function the throw site calls.
		const body = 'The widget SHALL render the configured label exactly once.';
		const specMd = `- **FR-001 — Widget renders.** ${body}\n`;
		const res = checkAcceptanceCoversFrRefs({
			specText: specMd,
			acceptanceText: 'ACCEPTANCE: lorem ipsum',
			frRefs: ['FR-001'],
		});
		expect(res.covered).toBe(false);
		const err = buildAcceptanceCoverageMismatchError({
			targetAgent: 'coder',
			coverageTaskId: '1.1',
			coverageResult: res,
		});
		expect(err.message).toContain('ACCEPTANCE_FIELD_COVERAGE_MISMATCH');
		expect(err.message).not.toContain('src/agents/');
		expect(err.message).toContain(
			'ACCEPTANCE FIELD RESOLUTION section of your system prompt',
		);
		expect(err.message).toContain(
			'Do NOT investigate the installed swarm plugin package (node_modules/opencode-swarm, ~/.cache/opencode)',
		);
		expect(err.message).toContain(
			'If this same error repeats after 2 fix attempts, STOP and present the blocker to the user.',
		);
	});
});

// ===========================================================================
// A2 — expectedBody embedding, cap + truncation, position-dependent
// list-marker normalization (bulleted multi-line body).
// ===========================================================================

describe('A2: checkAcceptanceCoversFrRefs returns expectedBody on a miss', () => {
	it('returns the raw, untrimmed body for the missing id', () => {
		const body = '  The widget SHALL render exactly once.  ';
		const specMd = `- **FR-010 — Widget.**${body}\n`;
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText: 'ACCEPTANCE: unrelated text',
			frRefs: ['FR-010'],
			specText: specMd,
		});
		expect(result.covered).toBe(false);
		expect(result.expectedBody).toBe(body);
	});

	it('does not set expectedBody when covered', () => {
		const body = 'The widget SHALL render exactly once.';
		const specMd = `- **FR-011 — Widget.** ${body}\n`;
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText: `ACCEPTANCE: ${body}`,
			frRefs: ['FR-011'],
			specText: specMd,
		});
		expect(result.covered).toBe(true);
		expect(result.expectedBody).toBeUndefined();
	});
});

describe('A2: ACCEPTANCE_FIELD_COVERAGE_MISMATCH embeds the requirement body', () => {
	let tempDir: string;

	beforeEach(async () => {
		resetSwarmState();
		tempDir = makeTempProject('c2063-a2-');
	});

	afterEach(() => {
		resetSwarmState();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	it('embeds the exact raw body for the missing id, fenced, with a line-break-preserving instruction', () => {
		// Post-#2205 the toolBefore throw is defense-in-depth (the gate injects
		// verbatim bodies instead of blocking), so the embedding contract is
		// asserted through the exported builder the throw site calls.
		const body =
			'The widget SHALL render the configured label exactly once on mount.';
		const specMd = `- **FR-020 — Widget renders.** ${body}\n`;
		const res = checkAcceptanceCoversFrRefs({
			specText: specMd,
			acceptanceText: 'ACCEPTANCE: lorem ipsum',
			frRefs: ['FR-020'],
		});
		expect(res.covered).toBe(false);
		const err = buildAcceptanceCoverageMismatchError({
			targetAgent: 'coder',
			coverageTaskId: '1.1',
			coverageResult: res,
		});
		expect(err.message).toContain(body);
		expect(err.message).toContain('```');
		expect(err.message).toContain('PRESERVING ITS LINE BREAKS');
		expect(err.message).toContain('FR-020');
		expect(err.message).toContain(String(ACCEPTANCE_EXPECTED_BODY_CAP));
	});

	it('truncates a body over ACCEPTANCE_EXPECTED_BODY_CAP chars, stating the cap and a spec.md pointer', () => {
		expect(ACCEPTANCE_EXPECTED_BODY_CAP).toBe(2000);
		const longBody = `The widget SHALL ${'x'.repeat(ACCEPTANCE_EXPECTED_BODY_CAP + 500)} verbatim.`;
		const specMd = `- **FR-030 — Long body.** ${longBody}\n`;
		const res = checkAcceptanceCoversFrRefs({
			specText: specMd,
			acceptanceText: 'ACCEPTANCE: lorem ipsum',
			frRefs: ['FR-030'],
		});
		expect(res.covered).toBe(false);
		const err = buildAcceptanceCoverageMismatchError({
			targetAgent: 'coder',
			coverageTaskId: '1.1',
			coverageResult: res,
		});
		expect(err.message).toContain(
			`…[truncated — read the remainder from .swarm/spec.md under FR-030]`,
		);
		expect(err.message).toContain(String(ACCEPTANCE_EXPECTED_BODY_CAP));
		// The full (untruncated) body must NOT appear verbatim in the message.
		expect(err.message).not.toContain(longBody);
		// The first ACCEPTANCE_EXPECTED_BODY_CAP chars of the body must be present.
		expect(err.message).toContain(longBody.slice(0, 200));
	});

	it('does not truncate a body under the cap (no truncation marker)', () => {
		const body = 'The widget SHALL render the configured label once.';
		const specMd = `- **FR-031 — Short body.** ${body}\n`;
		const res = checkAcceptanceCoversFrRefs({
			specText: specMd,
			acceptanceText: 'ACCEPTANCE: lorem ipsum',
			frRefs: ['FR-031'],
		});
		expect(res.covered).toBe(false);
		const err = buildAcceptanceCoverageMismatchError({
			targetAgent: 'coder',
			coverageTaskId: '1.1',
			coverageResult: res,
		});
		expect(err.message).not.toContain('truncated');
		expect(err.message).toContain(body);
	});
});

// ===========================================================================
// A2 — position-dependent list-marker normalization (bulleted multi-line
// body). Pins the behavior documented at normalizeAcceptanceText (:893):
// the leading list-marker strip only fires at LINE START (`^` with the `m`
// flag), so a bulleted rendering of a single wrapped body PASSES when the
// line breaks are preserved (each `-` sits at a real line start and is
// stripped) but FAILS once flattened onto one line (the interior `-`
// survives mid-string and breaks the substring match).
// ===========================================================================

describe('A2: bulleted multi-line requirement body — line-break preservation', () => {
	let tempDir: string;
	// A single body, deliberately reformatted by the "architect" as a two-line
	// bulleted list that splits mid-sentence — a plausible good-faith
	// reformatting mistake, not a paraphrase.
	const FULL_BODY =
		'The widget SHALL render the configured label exactly once on mount, ' +
		'and also support dark mode theming automatically.';
	const LINE_1 =
		'The widget SHALL render the configured label exactly once on mount, and';
	const LINE_2 = 'also support dark mode theming automatically.';

	beforeEach(async () => {
		resetSwarmState();
		tempDir = makeTempProject('c2063-a2-bullet-');
		const specMd = `- **FR-040 — Widget renders.** ${FULL_BODY}\n`;
		await writeSingleTaskPlan(tempDir, specMd, ['FR-040']);
	});

	afterEach(() => {
		resetSwarmState();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	it('pure: with real line breaks, each "- " sits at a line start and is stripped => covered', () => {
		const acceptanceWithBreaks = `ACCEPTANCE:\n- ${LINE_1}\n- ${LINE_2}`;
		const specMd = `- **FR-040 — Widget renders.** ${FULL_BODY}\n`;
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText: acceptanceWithBreaks,
			frRefs: ['FR-040'],
			specText: specMd,
		});
		expect(result).toEqual({ covered: true });
	});

	it('pure: the SAME content flattened onto one line strands the interior "- " => not covered', () => {
		const flattened = `ACCEPTANCE: - ${LINE_1} - ${LINE_2}`;
		const specMd = `- **FR-040 — Widget renders.** ${FULL_BODY}\n`;
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText: flattened,
			frRefs: ['FR-040'],
			specText: specMd,
		});
		expect(result).toMatchObject({ covered: false, missingId: 'FR-040' });
	});

	it('integration: ACCEPTANCE pasted WITH line breaks resolves through toolBefore', async () => {
		const hooks = createDelegationGateHook(makeConfig(), tempDir);
		ensureAgentSession('sess-a2-bullet-ok', 'architect');
		const prompt = `TASK: 1.1 implement it\nACCEPTANCE:\n- ${LINE_1}\n- ${LINE_2}`;
		await expect(
			hooks.toolBefore(toolBeforeInput('sess-a2-bullet-ok'), {
				args: { subagent_type: 'coder', task_id: '1.1', prompt },
			}),
		).resolves.toBeUndefined();
	});

	it('integration: the same body FLATTENED onto one line dispatches with the correctly line-broken body injected (#2205)', async () => {
		const hooks = createDelegationGateHook(makeConfig(), tempDir);
		ensureAgentSession('sess-a2-bullet-bad', 'architect');
		const output = {
			args: {
				subagent_type: 'coder',
				task_id: '1.1',
				prompt: `TASK: 1.1 implement it\nACCEPTANCE: - ${LINE_1} - ${LINE_2}`,
			} as Record<string, unknown>,
		};
		// Pre-#2205 the flattened (interior "- " stranded) copy was rejected;
		// the gate now appends the verbatim spec body — with its original
		// single-line form — so the downstream coder sees the exact text.
		await expect(
			hooks.toolBefore(toolBeforeInput('sess-a2-bullet-bad'), output),
		).resolves.toBeUndefined();
		expect(String(output.args.prompt)).toContain(`FR-040: ${FULL_BODY}`);
	});
});
