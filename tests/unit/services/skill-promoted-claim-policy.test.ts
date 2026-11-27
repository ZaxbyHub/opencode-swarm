/**
 * #3942 Stage B round 2 — sweep/regenerate consistency with the verifier's
 * bounded-head claim policy.
 *
 * The verifier deterministically refuses an artifact whose leading '---'
 * fence does not close within the 64 KiB provenance head while the file is
 * longer (claim state unverifiable). The shared predicate
 * `artifactCarriesPromotionClaim` must treat the SAME artifact as
 * claimed-by-policy so the stale-skill sweep SKIPS it and regenerateSkill
 * REFUSES it — mutating bytes the gate refuses anyway would strand the
 * skill (unverifiable AND rewritten).
 *
 * Fixtures are hand-written artifacts (no promote tool needed: the policy
 * fires before any record lookup, and no store exists in these projects).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { PROVENANCE_HEAD_BYTES } from '../../../src/services/external-skill-identity';
import { regenerateSkill } from '../../../src/services/skill-generator';
import { reconcileStaleActiveSkills } from '../../../src/services/skill-improver';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const OVERLONG_SLUG = 'overlong-frontmatter-skill';
const ORDINARY_SLUG = 'ordinary-control-skill';

let tmp: string;
let isolatedEnv: ReturnType<typeof createIsolatedTestEnv>;

beforeEach(() => {
	isolatedEnv = createIsolatedTestEnv();
	tmp = canonicalMkdtemp('swarm-claim-policy-');
});

afterEach(() => {
	try {
		removeTreeWithRetry(tmp);
	} finally {
		isolatedEnv.cleanup();
	}
});

/** An artifact whose frontmatter fence never closes within the head (file longer than the head), with NO claim marker at all. */
function overlongFrontmatterContent(): string {
	return [
		'---',
		`name: ${OVERLONG_SLUG}`,
		`description: ${'x'.repeat(PROVENANCE_HEAD_BYTES + 512)}`,
		'version: 1',
		'---',
		'',
		'Body that never matters: the fence is out of view.',
	].join('\n');
}

async function writeGeneratedSkill(
	slug: string,
	content: string,
): Promise<string> {
	const dir = path.join(tmp, '.opencode', 'skills', 'generated', slug);
	await mkdir(dir, { recursive: true });
	const skillPath = path.join(dir, 'SKILL.md');
	await writeFile(skillPath, content, 'utf-8');
	return skillPath;
}

function retiredMarkerPath(slug: string): string {
	return path.join(
		tmp,
		'.opencode',
		'skills',
		'generated',
		slug,
		'retired.marker',
	);
}

describe('shared claim policy — over-long frontmatter is claimed-by-policy (Stage B round 2)', () => {
	it('the stale sweep SKIPS an over-long-frontmatter artifact and changes no bytes', async () => {
		const content = overlongFrontmatterContent();
		const artifactPath = await writeGeneratedSkill(OVERLONG_SLUG, content);

		const result = await reconcileStaleActiveSkills(tmp, { dryRun: false });

		expect(result.skipped).toContain(OVERLONG_SLUG);
		expect(result.regenerated).not.toContain(OVERLONG_SLUG);
		expect(result.retired).not.toContain(OVERLONG_SLUG);
		expect(readFileSync(artifactPath, 'utf-8')).toBe(content);
		expect(existsSync(retiredMarkerPath(OVERLONG_SLUG))).toBe(false);
	});

	it('regenerateSkill REFUSES an over-long-frontmatter artifact and changes no bytes', async () => {
		const content = overlongFrontmatterContent();
		const artifactPath = await writeGeneratedSkill(OVERLONG_SLUG, content);

		const result = await regenerateSkill(tmp, OVERLONG_SLUG, {
			evaluate: false,
		});

		expect(result.regenerated).toBe(false);
		expect(result.retired).not.toBe(true);
		expect(result.reason).toContain('promoted external skill');
		expect(readFileSync(artifactPath, 'utf-8')).toBe(content);
		expect(existsSync(retiredMarkerPath(OVERLONG_SLUG))).toBe(false);
	});

	it('control: an ordinary stale skill with a NORMAL frontmatter is still reconciled', async () => {
		await writeGeneratedSkill(
			ORDINARY_SLUG,
			[
				'---',
				`name: ${ORDINARY_SLUG}`,
				'status: active',
				'generated_at: 2026-01-01T00:00:00.000Z',
				'version: 1',
				'skill_origin: generated',
				'---',
				'',
				'# Ordinary stale skill (no source_knowledge_ids)',
				'',
			].join('\n'),
		);

		const result = await reconcileStaleActiveSkills(tmp, { dryRun: false });

		expect(result.retired).toContain(ORDINARY_SLUG);
		expect(result.skipped).not.toContain(ORDINARY_SLUG);
		expect(existsSync(retiredMarkerPath(ORDINARY_SLUG))).toBe(true);
	});
});
