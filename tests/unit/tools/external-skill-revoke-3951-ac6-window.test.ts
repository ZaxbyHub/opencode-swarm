/**
 * Trace 3943-3951-close-residue-recoverability — #3951 AC6 (P8 verify→unlink
 * revoke window).
 *
 * Frozen discriminating check (RED at base 18c09e03e, GREEN after the fix).
 *
 * `external_skill_revoke` (src/tools/external-skill-revoke.ts:407-448)
 * verifies the recorded promotion digest and only THEN unlinks the LEXICAL
 * promoted path via `_internals.retireSkillFile`. The in-code comment at
 * 441-446 states the window is "NOT atomic": when a concurrent revoke completes
 * and a different approved candidate is promoted into the vacated slug
 * (external-skill-promote's exclusive-create writeSkillFile), the delayed
 * revoke's unlink deletes the replacement file while the new promotion record
 * still reads `promoted`.
 *
 * Interleaving is injected INSIDE the `retireSkillFile` wrapper (the real
 * verify→unlink gap) with full argument forwarding: (a) call the real function
 * once — the concurrent revoke's completion vacates the slug; (b) run the real
 * promote tool for a second seeded approved candidate into the same slug;
 * (c) call the real function again — the delayed revoke's unlink proceeds
 * against whatever now lives at the path. Deterministic by construction (one
 * injected phase flag; no timing).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createExternalSkillStore } from '../../../src/services/external-skill-store.js';
import { external_skill_promote } from '../../../src/tools/external-skill-promote.js';
import {
	external_skill_revoke,
	_internals as revokeInternals,
} from '../../../src/tools/external-skill-revoke.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

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

/** seedCandidate shape from tests/unit/tools/external-skill-promote.test.ts. */
async function seedApprovedCandidate(
	directory: string,
	tag: string,
): Promise<string> {
	const store = createExternalSkillStore(directory, { max_candidates: 500 });
	const body = 'This is a safe skill body with no dangerous patterns.';
	const candidate = await store.add({
		source_url: `https://example.com/ac6-${tag}.md`,
		source_type: 'github',
		publisher: 'trace-3951',
		sha256: createHash('sha256').update(body).digest('hex'),
		fetched_at: new Date(Date.now() - 60_000).toISOString(),
		skill_name: 'ac6-probe',
		skill_body: body,
		risk_flags: [],
		evaluation_verdict: 'passed',
		evaluation_history: [
			{
				verdict: 'passed',
				timestamp: new Date(Date.now() - 60_000).toISOString(),
				actor: 'system',
				reason: 'gates',
			},
		],
	});
	return candidate.id;
}

describe('external_skill_revoke verify-to-unlink window — regression: delayed revoke unlinks a replacement promoted into the vacated slug (#3951 AC6)', () => {
	const realRetireSkillFile = revokeInternals.retireSkillFile;
	let tmpDir: string;

	afterEach(() => {
		// Restore the seam even if the test body threw mid-interleave.
		revokeInternals.retireSkillFile = realRetireSkillFile;
		if (tmpDir) {
			void fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	test('a delayed revoke resuming after a concurrent revoke + a different candidate promoted into the slug leaves the replacement file and its promotion record unchanged', async () => {
		tmpDir = canonicalMkdtemp('ac6-revoke-window-');
		await writeTestConfig(tmpDir);

		const slug = 'ac6-revoke-window';
		const c1 = await seedApprovedCandidate(tmpDir, 'c1');
		const c2 = await seedApprovedCandidate(tmpDir, 'c2');
		const skillPath = path.join(
			tmpDir,
			'.opencode',
			'skills',
			'generated',
			slug,
			'SKILL.md',
		);

		const promote1 = JSON.parse(
			await callTool(
				external_skill_promote,
				{ candidate_id: c1, slug, approver: 'user' },
				tmpDir,
			),
		) as { success?: boolean };
		expect(promote1.success, 'precondition: C1 promoted into the slug').toBe(
			true,
		);

		// Inject the interleaving INSIDE the verify→unlink gap, at the
		// retireSkillFile seam. Full argument forwarding (the fix may add an
		// expectedDigest option to the seam signature — the wrapper stays
		// arity-agnostic).
		let injected = false;
		let interleavePromoteSuccess: boolean | undefined;
		revokeInternals.retireSkillFile = (async (
			filePath: string,
			...rest: unknown[]
		) => {
			if (!injected) {
				injected = true;
				// (a) the concurrent revoke's completion: slug vacated.
				await realRetireSkillFile(filePath, ...rest);
				// (b) a DIFFERENT approved candidate is promoted into the same
				//     slug through the normal writeSkillFile path.
				const p2 = JSON.parse(
					await callTool(
						external_skill_promote,
						{ candidate_id: c2, slug, approver: 'user' },
						tmpDir,
					),
				) as { success?: boolean };
				interleavePromoteSuccess = p2.success;
				// (c) falls through: the delayed revoke's unlink proceeds now.
			}
			return realRetireSkillFile(filePath, ...rest);
		}) as typeof revokeInternals.retireSkillFile;

		// The delayed revoke (A) — must COMPLETE without throwing.
		let revokeThrew = false;
		let rawAck = '';
		try {
			rawAck = await callTool(
				external_skill_revoke,
				{ candidate_id: c1, reason: 'ac6 delayed revoke' },
				tmpDir,
			);
		} catch {
			revokeThrew = true;
		} finally {
			revokeInternals.retireSkillFile = realRetireSkillFile;
		}
		expect(revokeThrew, 'the delayed revoke call must not throw').toBe(false);
		expect(injected, 'precondition: the interleave fired').toBe(true);
		expect(
			interleavePromoteSuccess,
			'precondition: C2 promotion into the vacated slug succeeded',
		).toBe(true);

		// AC6 outcome: the replacement SKILL.md still exists AND C2's promotion
		// record still reads 'promoted' (the revoke may refuse instead, but the
		// replacement must survive either way).
		const replacementExists = await fs.stat(skillPath).then(
			() => true,
			() => false,
		);
		expect(
			replacementExists,
			`replacement SKILL.md at ${skillPath} was deleted by the delayed revoke`,
		).toBe(true);

		const store = createExternalSkillStore(tmpDir, { max_candidates: 500 });
		const c2After = await store.get(c2);
		expect(
			c2After?.evaluation_verdict,
			'C2 promotion record must still read promoted',
		).toBe('promoted');
	}, 30_000);
});
