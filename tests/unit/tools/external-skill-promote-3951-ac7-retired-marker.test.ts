/**
 * Trace 3943-3951-close-residue-recoverability — #3951 AC7 (NF-3 retired
 * marker blocks re-promotion).
 *
 * Frozen discriminating check (RED at base 18c09e03e, GREEN after the fix).
 *
 * Real lifecycle: `external_skill_promote` C1 into slug S → curator
 * `retireSkill(S)` (src/services/skill-generator.ts:1822-1901) writes
 * `retired.marker` and leaves SKILL.md (#1822 reversibility) →
 * `external_skill_revoke` C1 removes SKILL.md but has NO marker handling →
 * `external_skill_promote` C2 (a different approved candidate) into the same
 * slug S: its only collision gate is SKILL.md existence
 * (src/tools/external-skill-promote.ts:664-684), so promote happily recreates
 * SKILL.md and reports success — while
 * `skill-propagation-gate.ts:799-823` returns `valid: false` on the stale
 * marker BEFORE digest verification. The new promotion is unusable.
 *
 * AC7 contract asserted: after curator retirement and a successful explicit
 * revoke, promotion of a different approved candidate into the same slug
 * EITHER succeeds with a skill the propagation gate accepts, OR refuses before
 * writing with an actionable lifecycle diagnostic (no SKILL.md left behind).
 * #1822 reversibility (retireSkill on a live skill leaves SKILL.md) stays
 * asserted.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { validateSkillReference } from '../../../src/hooks/skill-propagation-gate.js';
import { createExternalSkillStore } from '../../../src/services/external-skill-store.js';
import { _internals as validatorInternals } from '../../../src/services/external-skill-validator.js';
import { retireSkill } from '../../../src/services/skill-generator.js';
import { external_skill_promote } from '../../../src/tools/external-skill-promote.js';
import { external_skill_revoke } from '../../../src/tools/external-skill-revoke.js';
import { withFrozenClockAsync } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/** Deterministic instant every clock read in this file is relative to. */
const FIXED_NOW = 1_800_000_000_000;

/**
 * The validator's provenance scan reads "now" through a DI seam that calls a
 * bare no-arg Date constructor (src/services/external-skill-validator.ts:1055),
 * which the Date-spy in test-clock.ts cannot intercept. Pin the seam to the
 * frozen instant so seeded candidate stamps compare consistently.
 */
const FROZEN_ISO = new Date(FIXED_NOW).toISOString();
const realGetTimestamp = validatorInternals.getTimestamp;

function callTool(
	tool: unknown,
	args: unknown,
	directory: string,
): Promise<string> {
	return (
		tool as unknown as {
			execute: (a: unknown, ctx: { directory: string }) => Promise<string>;
		}
	).execute(args, { directory });
}

async function writeTestConfig(directory: string): Promise<void> {
	const configDir = path.join(directory, '.opencode');
	await fs.mkdir(configDir, { recursive: true });
	await fs.writeFile(
		path.join(configDir, 'opencode-swarm.json'),
		JSON.stringify({
			external_skills: {
				curation_enabled: true,
				max_candidates: 500,
				max_bytes_per_candidate: 1048576,
				eviction_policy: 'fifo',
				ttl_days: 90,
				evaluation_enabled: true,
				sources: [],
				max_candidates_per_discovery: 50,
				max_concurrent_fetches: 5,
				fetch_timeout_ms: 30000,
			},
		}),
		'utf-8',
	);
}

async function seedApprovedCandidate(
	directory: string,
	tag: string,
): Promise<string> {
	const store = createExternalSkillStore(directory, { max_candidates: 500 });
	const body = 'This is a safe skill body with no dangerous patterns.';
	const candidate = await store.add({
		source_url: `https://example.com/ac7-${tag}.md`,
		source_type: 'github',
		publisher: 'trace-3951',
		sha256: createHash('sha256').update(body).digest('hex'),
		fetched_at: new Date(FIXED_NOW - 60_000).toISOString(),
		skill_name: 'ac7-probe',
		skill_body: body,
		risk_flags: [],
		evaluation_verdict: 'passed',
		evaluation_history: [
			{
				verdict: 'passed',
				timestamp: new Date(FIXED_NOW - 60_000).toISOString(),
				actor: 'system',
				reason: 'gates',
			},
		],
	});
	return candidate.id;
}

describe('external_skill_promote after curator retirement — regression: stale retired.marker makes a re-promotion unusable while promote reports success (#3951 AC7)', () => {
	let tmpDir: string;

	afterEach(() => {
		validatorInternals.getTimestamp = realGetTimestamp;
		if (tmpDir) {
			void fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	test(
		'after curator retirement + successful revoke, promoting a different approved candidate into the same slug yields a gate-accepted skill or an explicit pre-write refusal',
		() =>
			withFrozenClockAsync(
				async () => {
					validatorInternals.getTimestamp = () => FROZEN_ISO;
					tmpDir = canonicalMkdtemp('ac7-repromote-');
					await writeTestConfig(tmpDir);

					const slug = 'ac7-repromote';
					const skillDir = path.join(
						tmpDir,
						'.opencode',
						'skills',
						'generated',
						slug,
					);
					const skillPath = path.join(skillDir, 'SKILL.md');
					const markerPath = path.join(skillDir, 'retired.marker');

					const c1 = await seedApprovedCandidate(tmpDir, 'c1');
					const c2 = await seedApprovedCandidate(tmpDir, 'c2');

					// 1. Promote C1.
					const promote1 = JSON.parse(
						await callTool(
							external_skill_promote,
							{ candidate_id: c1, slug, approver: 'user' },
							tmpDir,
						),
					) as { success?: boolean };
					expect(promote1.success, 'precondition: C1 promotion succeeded').toBe(
						true,
					);

					// 2. Curator retirement writes the marker and LEAVES SKILL.md (#1822
					//    reversibility contract — asserted so the fix cannot "solve" AC7 by
					//    making retirement destructive).
					const retired = await retireSkill(tmpDir, slug, 'ac7-staleness');
					expect(
						retired.retired,
						'precondition: retireSkill reported retired',
					).toBe(true);
					expect(
						await fs.stat(markerPath).then(
							() => true,
							() => false,
						),
						'retireSkill must write retired.marker',
					).toBe(true);
					expect(
						await fs.stat(skillPath).then(
							() => true,
							() => false,
						),
						'#1822: retireSkill leaves SKILL.md in place (reversible)',
					).toBe(true);

					// 3. Explicit revoke of C1 (the AC's "successful explicit revoke").
					const revoke = JSON.parse(
						await callTool(
							external_skill_revoke,
							{ candidate_id: c1, reason: 'ac7 revoke' },
							tmpDir,
						),
					) as { success?: boolean };
					expect(revoke.success, 'precondition: C1 revoke succeeded').toBe(
						true,
					);

					// 4. Promote a DIFFERENT approved candidate into the same slug.
					const promote2 = JSON.parse(
						await callTool(
							external_skill_promote,
							{ candidate_id: c2, slug, approver: 'user' },
							tmpDir,
						),
					) as { success?: boolean; error?: string };

					// 5. AC7 contract: success ⇒ the propagation gate accepts the skill;
					//    refusal ⇒ it happened BEFORE writing, with an actionable lifecycle
					//    diagnostic and no SKILL.md left behind.
					const gate = validateSkillReference(
						tmpDir,
						`file:.opencode/skills/generated/${slug}/SKILL.md`,
						{},
						{ enforceAudience: false },
					);
					if (promote2.success === true) {
						expect(
							gate.valid,
							`promote reported success but the propagation gate refuses the new skill: ${gate.reason}`,
						).toBe(true);
					} else {
						expect(typeof promote2.error).toBe('string');
						expect(
							promote2.error ?? '',
							'refusal must name the lifecycle cause (retired marker)',
						).toMatch(/retired|marker|lifecycle/iu);
						expect(
							await fs.stat(skillPath).then(
								() => true,
								() => false,
							),
							'a refused promotion must not leave a SKILL.md behind',
						).toBe(false);
					}
				},
				{ fixedNow: FIXED_NOW },
			),
		30_000,
	);
});
