/**
 * Trace 3943-3951-close-residue-recoverability — #3951 AC7 supplementary
 * (D5: the pre-write lifecycle-marker refusal at promotion).
 *
 * Non-frozen companion to the frozen check
 * `external-skill-promote-3951-ac7-retired-marker.test.ts`, which accepts
 * EITHER a gate-accepted promotion OR a refusal. This file pins the refusal
 * BRANCH the plan specifies — the marker-SPECIFIC diagnostics and the
 * "pure pre-write predicate, nothing mutated" property — for all four marker
 * shapes plus the unaffected clean-promotion control:
 *   src/tools/external-skill-promote.ts:53-102 (readLifecycleMarkerState)
 *   src/tools/external-skill-promote.ts:745-753 (the gate, after the
 *   SKILL.md collision check at 727-734 and BEFORE _internals.writeSkillFile).
 *
 * Lifecycle fidelity: the retired case runs the REAL sequence
 * promote → curator retireSkill (writes retired.marker, LEAVES SKILL.md per
 * #1822) → explicit revoke (removes SKILL.md, leaves the marker) → promote a
 * DIFFERENT approved candidate into the emptied slug — exactly the state the
 * propagation gate would later refuse. The stale case writes stale.marker by
 * hand (the regeneration sweep's artifact) into the same emptied slug.
 *
 * Assertion discipline (per the plan's marker-specific wording requirement):
 * the retired diagnostic must not speak of staleness and the stale diagnostic
 * must not speak of retirement — asserted as negative regexes on the
 * returned error, not just positive word presence — and every refusal branch
 * leaves the marker bytes and the absence of SKILL.md untouched, with the
 * candidate record un-mutated (no promoted entry written).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createExternalSkillStore } from '../../../src/services/external-skill-store.js';
import { retireSkill } from '../../../src/services/skill-generator.js';
import { external_skill_promote } from '../../../src/tools/external-skill-promote.js';
import { external_skill_revoke } from '../../../src/tools/external-skill-revoke.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tmpDir = '';

afterEach(() => {
	if (tmpDir) void fsp.rm(tmpDir, { recursive: true, force: true });
});

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
	await fsp.mkdir(path.join(directory, '.opencode'), { recursive: true });
	await fsp.writeFile(
		path.join(directory, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ external_skills: { curation_enabled: true } }),
		'utf-8',
	);
}

/** Approved ('passed') candidate — the promote tool's accepted input. */
async function seedApprovedCandidate(
	directory: string,
	tag: string,
): Promise<string> {
	const store = createExternalSkillStore(directory, { max_candidates: 500 });
	const body = 'This is a safe skill body with no dangerous patterns.';
	const candidate = await store.add({
		source_url: `https://example.com/${tag}.md`,
		source_type: 'github',
		publisher: 'trace-3951',
		sha256: createHash('sha256').update(body).digest('hex'),
		fetched_at: new Date(Date.now() - 60_000).toISOString(),
		skill_name: 'ac7-marker-probe',
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

const slugDir = (directory: string, slug: string): string =>
	path.join(directory, '.opencode', 'skills', 'generated', slug);

const promote = (
	directory: string,
	candidateId: string,
	slug: string,
): Promise<{ success?: boolean; error?: string }> =>
	callTool(
		external_skill_promote,
		{ candidate_id: candidateId, slug, approver: 'user' },
		directory,
	).then((raw) => JSON.parse(raw) as { success?: boolean; error?: string });

/** Real lifecycle up to the emptied slug (retireSkill + revoke C1). */
async function emptiedSlugWithRetire(
	directory: string,
	slug: string,
): Promise<{ c1: string; c2: string }> {
	const c1 = await seedApprovedCandidate(directory, `${slug}-c1`);
	const c2 = await seedApprovedCandidate(directory, `${slug}-c2`);
	const first = await promote(directory, c1, slug);
	expect(first.success, 'precondition: C1 promoted').toBe(true);
	const retired = await retireSkill(directory, slug, 'ac7-staleness');
	expect(retired.retired, 'precondition: retireSkill reported retired').toBe(
		true,
	);
	const revoked = JSON.parse(
		await callTool(
			external_skill_revoke,
			{ candidate_id: c1, reason: 'ac7 marker probe' },
			directory,
		),
	) as { success?: boolean };
	expect(revoked.success, 'precondition: C1 revoked').toBe(true);
	return { c1, c2 };
}

const isAbsent = async (p: string): Promise<boolean> =>
	fsp.stat(p).then(
		() => false,
		() => true,
	);

describe('external_skill_promote lifecycle-marker refusal (#3951 AC7 / D5)', () => {
	test('retired-only: refusal names retired.marker with the unretire remedy, claims no staleness, mutates nothing', async () => {
		tmpDir = canonicalMkdtemp('promote-marker-retired-');
		await writeTestConfig(tmpDir);
		const slug = 'promote-marker-retired';
		const { c2 } = await emptiedSlugWithRetire(tmpDir, slug);
		const dir = slugDir(tmpDir, slug);
		const markerPath = path.join(dir, 'retired.marker');
		const skillPath = path.join(dir, 'SKILL.md');
		const markerBefore = await fsp.readFile(markerPath, 'utf-8');

		const second = await promote(tmpDir, c2, slug);
		expect(second.success).toBe(false);
		const error = second.error ?? '';
		// Marker-specific diagnostic (plan D5): names the marker, states the
		// retire-then-empty lifecycle, and gives the reversible remedy.
		expect(error).toContain('retired.marker');
		expect(error).toContain(markerPath);
		expect(error.toLowerCase()).toContain('retired');
		expect(error.toLowerCase()).toContain('unretire');
		// Must NOT be dressed up as a staleness problem.
		expect(error.toLowerCase()).not.toContain('stale');

		// Pure pre-write predicate: no SKILL.md, marker bytes untouched, and
		// the candidate record un-mutated (no promoted entry written).
		expect(await isAbsent(skillPath)).toBe(true);
		expect(await fsp.readFile(markerPath, 'utf-8')).toBe(markerBefore);
		const record = await createExternalSkillStore(tmpDir, {
			max_candidates: 500,
		}).get(c2);
		expect(record?.evaluation_verdict).toBe('passed');
	}, 30_000);

	test('stale-only: refusal names stale.marker with the delete/regenerate remedy, claims no retirement', async () => {
		tmpDir = canonicalMkdtemp('promote-marker-stale-');
		await writeTestConfig(tmpDir);
		const slug = 'promote-marker-stale';
		const c1 = await seedApprovedCandidate(tmpDir, `${slug}-c1`);
		const c2 = await seedApprovedCandidate(tmpDir, `${slug}-c2`);
		expect((await promote(tmpDir, c1, slug)).success).toBe(true);
		expect(
			(
				JSON.parse(
					await callTool(
						external_skill_revoke,
						{ candidate_id: c1, reason: 'stale probe' },
						tmpDir,
					),
				) as { success?: boolean }
			).success,
			'precondition: C1 revoked (slug emptied)',
		).toBe(true);
		const dir = slugDir(tmpDir, slug);
		const markerPath = path.join(dir, 'stale.marker');
		await fsp.writeFile(
			markerPath,
			JSON.stringify({ markedAt: 'probe' }),
			'utf-8',
		);
		const skillPath = path.join(dir, 'SKILL.md');

		const second = await promote(tmpDir, c2, slug);
		expect(second.success).toBe(false);
		const error = second.error ?? '';
		expect(error).toContain('stale.marker');
		expect(error).toContain(markerPath);
		expect(error.toLowerCase()).toContain('stale');
		// Actionable remedy: delete the marker (staleness re-evaluates) or use
		// a different slug.
		expect(error.toLowerCase()).toContain('delete');
		expect(error.toLowerCase()).toContain('regenerat');
		// Must NOT be dressed up as a retirement.
		expect(error.toLowerCase()).not.toContain('retir');
		expect(await isAbsent(skillPath)).toBe(true);
		expect(await isAbsent(path.join(dir, 'retired.marker'))).toBe(true);
	}, 30_000);

	test('dual marker: retirement takes precedence in the wording and BOTH paths are named', async () => {
		tmpDir = canonicalMkdtemp('promote-marker-dual-');
		await writeTestConfig(tmpDir);
		const slug = 'promote-marker-dual';
		const { c2 } = await emptiedSlugWithRetire(tmpDir, slug);
		const dir = slugDir(tmpDir, slug);
		const retiredPath = path.join(dir, 'retired.marker');
		const stalePath = path.join(dir, 'stale.marker');
		await fsp.writeFile(
			stalePath,
			JSON.stringify({ markedAt: 'probe' }),
			'utf-8',
		);

		const second = await promote(tmpDir, c2, slug);
		expect(second.success).toBe(false);
		const error = second.error ?? '';
		expect(error).toContain('retired.marker');
		expect(error).toContain(retiredPath);
		// Precedence + full disclosure of the companion marker.
		expect(error).toContain('was retired and then emptied');
		expect(error).toContain('stale.marker');
		expect(error).toContain(stalePath);
		expect(await isAbsent(path.join(dir, 'SKILL.md'))).toBe(true);
	}, 30_000);

	test('malformed marker (a DIRECTORY named retired.marker): fail-closed refusal with the not-a-regular-file reason', async () => {
		tmpDir = canonicalMkdtemp('promote-marker-malformed-');
		await writeTestConfig(tmpDir);
		const slug = 'promote-marker-malformed';
		const { c2 } = await emptiedSlugWithRetire(tmpDir, slug);
		const dir = slugDir(tmpDir, slug);
		const markerPath = path.join(dir, 'retired.marker');
		// Ambiguous marker state: the name exists but is not a regular file.
		await fsp.rm(markerPath, { recursive: true, force: true });
		await fsp.mkdir(markerPath);

		const second = await promote(tmpDir, c2, slug);
		expect(second.success).toBe(false);
		const error = second.error ?? '';
		expect(error).toContain('retired.marker');
		expect(error).toContain(markerPath);
		expect(error.toLowerCase()).toContain('not a regular file');
		// Fail CLOSED: the unreadable governance signal blocks the write, and
		// the anomalous marker is left exactly as found.
		expect(await isAbsent(path.join(dir, 'SKILL.md'))).toBe(true);
		expect((await fsp.stat(markerPath)).isDirectory()).toBe(true);
	}, 30_000);

	test('control: a fresh slug with no lifecycle marker promotes normally', async () => {
		tmpDir = canonicalMkdtemp('promote-marker-clean-');
		await writeTestConfig(tmpDir);
		const slug = 'promote-marker-clean';
		const c1 = await seedApprovedCandidate(tmpDir, `${slug}-c1`);

		const result = await promote(tmpDir, c1, slug);
		expect(result.error ?? '').toBe('');
		expect(result.success).toBe(true);
		expect(
			await fsp.readFile(path.join(slugDir(tmpDir, slug), 'SKILL.md'), 'utf-8'),
		).toContain('safe skill body');
		const record = await createExternalSkillStore(tmpDir, {
			max_candidates: 500,
		}).get(c1);
		expect(record?.evaluation_verdict).toBe('promoted');
	}, 30_000);
});
