/**
 * Trace 3943-3951-close-residue-recoverability — #3951 AC6 supplementary
 * (D4: the identity-guarded destructive unlink).
 *
 * Non-frozen companion to the frozen check
 * `external-skill-revoke-3951-ac6-window.test.ts` (the delayed-revoke /
 * replacement-promote interleaving) and to
 * `external-skill-revoke-hardening.test.ts` (F-003/FB-210/RP-003/TF-004,
 * which cover the TOOL-LEVEL probe and verification before the guard). This
 * file pins the guard itself, which lives INSIDE
 * `_internals.retireSkillFile` (src/tools/external-skill-revoke.ts:62-119):
 * same-digest removal, mismatch refusal, ENOENT idempotence, guard-level
 * unreadable/non-regular refusal, the legacy null-digest (unguarded) path,
 * and the boolean-wrapper compatibility the plan required for every existing
 * test double.
 *
 * Injection route: the swap happens inside a full-argument FORWARDING wrapper
 * at the `retireSkillFile` seam — i.e. between the tool's own verification
 * and the guard's bounded read — which is exactly the residual hash→unlink
 * gap the in-code comment at 508-519 states honestly. Deterministic by
 * construction (one phase flag; no timing).
 *
 * Deviation recorded, not blessed: the plan's D4 wording says the tool
 * "catches SkillFileDigestMismatchError → returns the existing refusal payload
 * shape". The implementation lets the typed refusal fall through the generic
 * catch (external-skill-revoke.ts:565-571), so the operator-visible string is
 * `Failed to revoke candidate: Refusing to remove the promoted skill file…`
 * rather than a dedicated refusal branch. The OBSERVABLE contract the AC
 * requires is unchanged and is what this file asserts: success:false, NO
 * unlink, NO store.update, NO revoked audit entry.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { ExternalSkillCandidate } from '../../../src/config/schema.js';
import { computeArtifactDigest } from '../../../src/services/external-skill-identity.js';
import { createExternalSkillStore } from '../../../src/services/external-skill-store.js';
import {
	external_skill_revoke,
	_internals as revokeInternals,
	SkillFileDigestMismatchError,
} from '../../../src/tools/external-skill-revoke.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const realRetireSkillFile = revokeInternals.retireSkillFile;
let tmpDir = '';

afterEach(() => {
	revokeInternals.retireSkillFile = realRetireSkillFile;
	if (tmpDir) void fsp.rm(tmpDir, { recursive: true, force: true });
});

function callRevoke(args: unknown, directory: string): Promise<string> {
	return (
		external_skill_revoke as unknown as {
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

const skillPathOf = (directory: string, slug: string): string =>
	path.join(directory, '.opencode', 'skills', 'generated', slug, 'SKILL.md');

/**
 * Seed a PROMOTED candidate carrying the structured identity
 * (target_path + promoted_content_hash) that the guard trusts. Pass
 * `withHash: false` for the legacy pre-#3822 shape (target_path present,
 * promoted_content_hash absent → findStructuredPromotionEntry skips it and
 * the tool falls back to the prose-slug derivation, unguarded).
 */
async function seedPromoted(
	directory: string,
	slug: string,
	content: string,
	options: { withHash?: boolean; hash?: string } = {},
): Promise<string> {
	const withHash = options.withHash !== false;
	const target = skillPathOf(directory, slug);
	await fsp.mkdir(path.dirname(target), { recursive: true });
	await fsp.writeFile(target, content, 'utf-8');
	const history = {
		verdict: 'promoted' as const,
		timestamp: new Date(Date.now() - 60_000).toISOString(),
		actor: 'user' as const,
		reason: `Promoted to .opencode/skills/generated/${slug}/SKILL.md — re-validation passed`,
		target_path: target,
		...(withHash
			? {
					promoted_content_hash: options.hash ?? computeArtifactDigest(content),
				}
			: {}),
	};
	const store = createExternalSkillStore(directory, { max_candidates: 500 });
	const candidate = await store.add({
		source_url: `https://example.com/${slug}.md`,
		source_type: 'github',
		publisher: 'trace-3951',
		sha256: computeArtifactDigest(content),
		fetched_at: new Date(Date.now() - 120_000).toISOString(),
		skill_name: slug,
		skill_body: content,
		risk_flags: [],
		evaluation_verdict: 'promoted',
		evaluation_history: [
			history,
		] as ExternalSkillCandidate['evaluation_history'],
	});
	return candidate.id;
}

async function readRecord(
	directory: string,
	id: string,
): Promise<ExternalSkillCandidate | null> {
	return createExternalSkillStore(directory, { max_candidates: 500 }).get(id);
}

const revokedAuditCount = (c: ExternalSkillCandidate | null): number =>
	(c?.evaluation_history ?? []).filter(
		(e) => e.actor === 'user' && e.verdict === 'revoked',
	).length;

const exists = (p: string): Promise<boolean> =>
	fsp.stat(p).then(
		() => true,
		() => false,
	);

describe('external_skill_revoke identity-guarded unlink (#3951 AC6 / D4)', () => {
	test('same digest: the guard passes, the file is removed and the record is revoked', async () => {
		tmpDir = canonicalMkdtemp('revoke-guard-same-');
		await writeTestConfig(tmpDir);
		const slug = 'revoke-guard-same';
		const content = '# guarded skill\nbody\n';
		const id = await seedPromoted(tmpDir, slug, content);
		const target = skillPathOf(tmpDir, slug);

		const ack = JSON.parse(
			await callRevoke({ candidate_id: id, reason: 'guard positive' }, tmpDir),
		) as { success?: boolean; skill_file_removed?: boolean };

		expect(ack.success).toBe(true);
		expect(ack.skill_file_removed).toBe(true);
		expect(await exists(target)).toBe(false);
		const record = await readRecord(tmpDir, id);
		expect(record?.evaluation_verdict).toBe('revoked');
		expect(revokedAuditCount(record)).toBe(1);
	}, 30_000);

	test('content swapped inside the verify→unlink gap: typed refusal, no unlink, no revoked audit entry', async () => {
		tmpDir = canonicalMkdtemp('revoke-guard-mismatch-');
		await writeTestConfig(tmpDir);
		const slug = 'revoke-guard-mismatch';
		const content = '# guarded skill\noriginal\n';
		const id = await seedPromoted(tmpDir, slug, content);
		const target = skillPathOf(tmpDir, slug);

		// Full-argument forwarding wrapper: the swap lands in the gap between
		// the tool's own verification and the guard's bounded read.
		let swapped = false;
		revokeInternals.retireSkillFile = (async (
			filePath: string,
			...rest: unknown[]
		) => {
			if (!swapped) {
				swapped = true;
				await fsp.writeFile(filePath, 'REPLACED-BY-ANOTHER-PROMOTION', 'utf-8');
			}
			return realRetireSkillFile(filePath, ...rest);
		}) as typeof revokeInternals.retireSkillFile;

		const ack = JSON.parse(
			await callRevoke({ candidate_id: id, reason: 'guard mismatch' }, tmpDir),
		) as { success?: boolean; error?: string; skill_file_removed?: boolean };

		expect(swapped, 'precondition: the swap fired in the gap').toBe(true);
		expect(ack.success).toBe(false);
		expect(ack.skill_file_removed, 'no removal is claimed').toBeUndefined();
		expect(ack.error ?? '').toContain(
			'no longer matches the recorded promoted digest',
		);
		expect(ack.error ?? '').toContain('File left in place');
		// The replacement survives, byte-for-byte.
		expect(await exists(target)).toBe(true);
		expect(await fsp.readFile(target, 'utf-8')).toBe(
			'REPLACED-BY-ANOTHER-PROMOTION',
		);
		const record = await readRecord(tmpDir, id);
		expect(record?.evaluation_verdict).toBe('promoted');
		expect(revokedAuditCount(record), 'no audit entry for a file we kept').toBe(
			0,
		);

		// The refusal is TYPED (the plan's contract for forwarding wrappers):
		// a direct seam call with a stale digest rejects with the exported
		// error class rather than returning a boolean.
		let typed: unknown;
		try {
			await realRetireSkillFile(target, { expectedDigest: '0'.repeat(64) });
		} catch (err) {
			typed = err;
		}
		expect(typed).toBeInstanceOf(SkillFileDigestMismatchError);
	}, 30_000);

	test('ENOENT is idempotent success (skill_file_removed:false) and still stamps the record revoked', async () => {
		tmpDir = canonicalMkdtemp('revoke-guard-enoent-');
		await writeTestConfig(tmpDir);
		const slug = 'revoke-guard-enoent';
		const id = await seedPromoted(tmpDir, slug, '# guarded skill\nenoent\n');
		const target = skillPathOf(tmpDir, slug);
		await fsp.rm(target);

		const ack = JSON.parse(
			await callRevoke({ candidate_id: id, reason: 'guard enoent' }, tmpDir),
		) as { success?: boolean; skill_file_removed?: boolean };

		expect(ack.success).toBe(true);
		expect(
			ack.skill_file_removed,
			'a missing file must not be reported as removed',
		).toBe(false);
		const record = await readRecord(tmpDir, id);
		expect(record?.evaluation_verdict).toBe('revoked');
		expect(revokedAuditCount(record)).toBe(1);
	}, 30_000);

	test('guard-level non-regular target: refusal with the read reason, the directory stays, nothing is revoked', async () => {
		tmpDir = canonicalMkdtemp('revoke-guard-unreadable-');
		await writeTestConfig(tmpDir);
		const slug = 'revoke-guard-unreadable';
		const id = await seedPromoted(
			tmpDir,
			slug,
			'# guarded skill\nunreadable\n',
		);
		const target = skillPathOf(tmpDir, slug);

		// The swap happens AFTER the tool's own lstat probe passed (kind
		// 'file'), so the refusal must come from the GUARD's inspection — the
		// tool-level non-regular branch is covered by
		// external-skill-revoke-hardening.test.ts and is not what this pins.
		let swapped = false;
		revokeInternals.retireSkillFile = (async (
			filePath: string,
			...rest: unknown[]
		) => {
			if (!swapped) {
				swapped = true;
				await fsp.rm(filePath);
				await fsp.mkdir(filePath);
			}
			return realRetireSkillFile(filePath, ...rest);
		}) as typeof revokeInternals.retireSkillFile;

		const ack = JSON.parse(
			await callRevoke(
				{ candidate_id: id, reason: 'guard unreadable' },
				tmpDir,
			),
		) as { success?: boolean; error?: string };

		expect(swapped, 'precondition: the target was replaced').toBe(true);
		expect(ack.success).toBe(false);
		expect(ack.error ?? '').toContain('pre-removal identity check');
		expect(ack.error ?? '').toContain('instead of a regular file');
		expect(ack.error ?? '').toContain('File left in place');
		expect((await fsp.stat(target)).isDirectory()).toBe(true);
		const record = await readRecord(tmpDir, id);
		expect(record?.evaluation_verdict).toBe('promoted');
		expect(revokedAuditCount(record)).toBe(0);
	}, 30_000);

	test('legacy record without promoted_content_hash keeps today unguarded semantics', async () => {
		tmpDir = canonicalMkdtemp('revoke-guard-legacy-');
		await writeTestConfig(tmpDir);
		const slug = 'revoke-guard-legacy';
		const id = await seedPromoted(tmpDir, slug, '# legacy skill\noriginal\n', {
			withHash: false,
		});
		const target = skillPathOf(tmpDir, slug);
		// A guard would have refused these bytes; there is no recorded digest
		// to compare against, so the removal proceeds (recorded residual).
		await fsp.writeFile(target, '# legacy skill\nTAMPERED\n', 'utf-8');

		const ack = JSON.parse(
			await callRevoke({ candidate_id: id, reason: 'guard legacy' }, tmpDir),
		) as { success?: boolean; skill_file_removed?: boolean };

		expect(ack.success).toBe(true);
		expect(ack.skill_file_removed).toBe(true);
		expect(await exists(target)).toBe(false);
		const record = await readRecord(tmpDir, id);
		expect(record?.evaluation_verdict).toBe('revoked');
		expect(revokedAuditCount(record)).toBe(1);
	}, 30_000);

	test('existing arity-reducing boolean wrappers keep working (compat clause)', async () => {
		tmpDir = canonicalMkdtemp('revoke-guard-wrapper-');
		await writeTestConfig(tmpDir);
		const slug = 'revoke-guard-wrapper';
		const id = await seedPromoted(tmpDir, slug, '# guarded skill\nwrapper\n');
		const target = skillPathOf(tmpDir, slug);

		// The shape every pre-#3951 double uses
		// (external-skill-revoke-hardening.test.ts:145-149): one positional
		// parameter, Promise<boolean>. The tool's arity-2 call still resolves;
		// such a double simply does not reach the guard — which is why the
		// FULL-ARGUMENT FORWARDING form used above is the recommended shape.
		let calls = 0;
		revokeInternals.retireSkillFile = (async (filePath: string) => {
			calls++;
			return realRetireSkillFile(filePath);
		}) as typeof revokeInternals.retireSkillFile;

		const ack = JSON.parse(
			await callRevoke({ candidate_id: id, reason: 'guard wrapper' }, tmpDir),
		) as { success?: boolean; skill_file_removed?: boolean };

		expect(calls).toBe(1);
		expect(ack.success).toBe(true);
		expect(ack.skill_file_removed).toBe(true);
		expect(await exists(target)).toBe(false);
		expect((await readRecord(tmpDir, id))?.evaluation_verdict).toBe('revoked');
	}, 30_000);
});
