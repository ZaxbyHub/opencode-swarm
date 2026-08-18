/**
 * Issue #2215: a requirement body that IS present in the delegation prompt, but
 * not aligned at character 0 of the compared text, must render the divergence
 * pointer — NOT the "[Requirement text completely missing from prompt]"
 * fallback that #2204 introduced for genuinely-omitted bodies.
 *
 * Two shapes are locked here, both end-to-end through `toolBefore` so the
 * rendered error string itself is the assertion surface:
 *
 *  1. The id-label glue mismatch. `extractSpecRequirementBodyById` takes
 *     everything after the closing `**` of a `- **FR-050**: <body>` bullet, so
 *     the extracted body carries a leading `": "`. An architect who pastes it
 *     verbatim behind an id label (`ACCEPTANCE: FR-050 - <body>`) misaligns by
 *     two characters, which starves the prefix probe.
 *  2. A dispatch shape with content after ACCEPTANCE. The gate compares the
 *     WHOLE prompt blob (`prompt`/`description`/`task`/`input`/`message`
 *     concatenated), and a dispatch commonly has other fields (`SKILLS:`,
 *     `SKILLS_USED_BY_CODER:`, `OUTPUT:`, ...) after `ACCEPTANCE:` — so a
 *     correctly-pasted body can sit in the MIDDLE of the compared text, with
 *     fields before AND after it. A suffix check that compares the two
 *     strings' trailing characters finds nothing here and falsely reports a
 *     body that is right there in the prompt as missing; the probe must
 *     search the blob for the body's tail instead.
 *
 * Case 1 also proves the renderer's `divergenceOffset === 0` qualifier is
 * reachable in the non-`completelyMissing` branch: before #2215 the
 * sub-threshold-prefix early return always set `completelyMissing`, so that
 * ternary could never fire.
 *
 * These live in their own file rather than in
 * `delegation-gate-acceptance-remediation.test.ts` (whose `writeSingleTaskPlan`
 * harness they mirror) because that file has no room left under the 500-line
 * FR-006 cap.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import type { Plan } from '../../../src/config/plan-schema';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir';
import { recordPlanCriticApproval } from './_delegation-gate-helpers';

function makeConfig(): PluginConfig {
	return { hooks: { delegation_gate: true } } as unknown as PluginConfig;
}

function makeTempProject(prefix: string): string {
	const real = canonicalMkdtemp(prefix);
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
		title: 'Shifted-Body Test Plan',
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

describe('#2215: present-but-shifted body renders a divergence pointer, not the missing fallback', () => {
	let tempDir: string;
	const BODY = 'The service SHALL retry the upload three times before failing.';

	beforeEach(async () => {
		resetSwarmState();
		tempDir = makeTempProject('c2215-shifted-');
		await writeSingleTaskPlan(tempDir, `- **FR-050**: ${BODY}\n`, ['FR-050']);
	});

	afterEach(() => {
		resetSwarmState();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	it('the id-label glue mismatch points at the mismatched head instead of claiming the text is absent', async () => {
		const hooks = createDelegationGateHook(makeConfig(), tempDir);
		ensureAgentSession('sess-2215-shifted', 'architect');
		let caught: Error | undefined;
		try {
			await hooks.toolBefore(toolBeforeInput('sess-2215-shifted'), {
				args: {
					subagent_type: 'coder',
					task_id: '1.1',
					prompt: `TASK: 1.1 implement it\nACCEPTANCE: FR-050 - ${BODY}`,
				},
			});
		} catch (err) {
			caught = err as Error;
		}
		expect(caught).toBeDefined();
		expect(caught?.message).toContain('ACCEPTANCE_FIELD_COVERAGE_MISMATCH');
		// The body IS in the prompt — claiming otherwise sends the architect
		// hunting for text that is right there (the #2215 regression).
		expect(caught?.message).not.toContain(
			'[Requirement text completely missing from prompt]',
		);
		// Nothing aligns from character 0, so the renderer's offset-0 qualifier
		// fires — live and correct only because of the suffix probe.
		expect(caught?.message).toContain(
			'first divergence at normalized offset 0 (no aligned prefix found)',
		);
		// The mismatched head on each side: the glue colon vs the id label.
		expect(caught?.message).toContain('spec requires here: ":"');
		expect(caught?.message).toContain(
			'ACCEPTANCE has here: "task: 1.1 implement it acceptance: fr-050 -"',
		);
	});

	it('the body is still found when a SKILLS line follows ACCEPTANCE in the dispatch', async () => {
		// The regression a tail-position compare cannot see: the compared blob does
		// not END with the body when a dispatch has content after ACCEPTANCE (a
		// SKILLS line here, but any trailing field has the same effect).
		const hooks = createDelegationGateHook(makeConfig(), tempDir);
		ensureAgentSession('sess-2215-trailing', 'architect');
		let caught: Error | undefined;
		try {
			await hooks.toolBefore(toolBeforeInput('sess-2215-trailing'), {
				args: {
					subagent_type: 'coder',
					task_id: '1.1',
					prompt: [
						'TASK: 1.1 implement it',
						'FILE: src/service/upload.ts',
						`ACCEPTANCE: FR-050 - ${BODY}`,
						'SKILLS: file:.claude/skills/engineering-conventions/SKILL.md',
					].join('\n'),
				},
			});
		} catch (err) {
			caught = err as Error;
		}
		expect(caught).toBeDefined();
		expect(caught?.message).toContain('ACCEPTANCE_FIELD_COVERAGE_MISMATCH');
		expect(caught?.message).not.toContain(
			'[Requirement text completely missing from prompt]',
		);
		expect(caught?.message).toContain(
			'first divergence at normalized offset 0 (no aligned prefix found)',
		);
		// The ACCEPTANCE snippet is the text preceding the LOCATED match, so it
		// stops at the id label and never bleeds into the trailing SKILLS line.
		expect(caught?.message).toContain('spec requires here: ":"');
		expect(caught?.message).toContain(
			'ACCEPTANCE has here: "task: 1.1 implement it file: src/service/upload.ts acceptance: fr-050 -"',
		);
	});
});
