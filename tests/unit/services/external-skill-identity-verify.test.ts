/**
 * #3822 promoted-skill verifier decision tree — claim-gated indeterminacy
 * (FB-101/RP-001), frontmatter-only provenance claims (FB-108), revoked
 * records (FB-102), and the advisory digest line (FB-212).
 *
 * Decided policy under test (see the module header of
 * src/services/external-skill-identity.ts):
 *
 *   - Artifact WITHOUT a provenance claim and with no readable matching
 *     record is accepted as an ordinary generated skill EVEN WHEN the store
 *     scan is indeterminate (over-cap, corrupt/oversized unrelated record,
 *     unreadable store). A corrupt or oversized UNRELATED record must never
 *     block ordinary skills.
 *   - Artifact WITH a provenance claim requires a determinate record: an
 *     indeterminate lookup is refused with a reason that NAMES the cause and
 *     the bounded record file name — and never says "exceeds the synchronous
 *     verification bound" for a non-over-cap cause.
 *   - A provenance claim is recognized ONLY in the LEADING frontmatter block
 *     (--- ... ---); the same line as body prose is not a claim (FB-108).
 *   - The frontmatter `content_digest:` line is advisory: editing its value
 *     never changes verification, which is bound to the record hash (FB-212).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	ARTIFACT_DIGEST_PLACEHOLDER_LINE,
	computeArtifactDigest,
	_internals as identityInternals,
	MAX_PROMOTION_RECORD_FILES,
	PROMOTION_RECORD_MAX_BYTES,
	verifyPromotedExternalSkillSync,
} from '../../../src/services/external-skill-identity.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SKILL_BODY = 'Ordinary generated skill body for verifier policy tests.';

/**
 * Independent canonical digest oracle (line-based, NOT
 * computeArtifactDigest): replaces the first line that is EXACTLY
 * `content_digest: <64 hex | pending>` (LF or CRLF terminated) with the
 * placeholder; any other digest-line value is hashed as-is.
 */
function independentCanonicalDigest(content: string): string {
	const lines = content.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const bare = lines[i].replace(/\r$/, '');
		if (/^content_digest: (?:[a-f0-9]{64}|pending)$/.test(bare)) {
			lines[i] = ARTIFACT_DIGEST_PLACEHOLDER_LINE + lines[i].slice(bare.length);
			break;
		}
	}
	return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/**
 * Report cap+1 record files through the readdir seam instead of writing
 * ~1000 real files (slow and timing-flaky on Windows); the cap is checked
 * on the listing before any record is opened. The seam is restored in
 * afterEach.
 */
function stubOverCapListing(): void {
	const names = Array.from(
		{ length: MAX_PROMOTION_RECORD_FILES + 1 },
		(_, i) => `filler-${i}.json`,
	);
	identityInternals.readdirSync = (() =>
		names) as unknown as typeof fs.readdirSync;
}

function artifactPathFor(projectDir: string, slug: string): string {
	return path.join(
		projectDir,
		'.opencode',
		'skills',
		'generated',
		slug,
		'SKILL.md',
	);
}

function writeArtifact(
	projectDir: string,
	slug: string,
	content: string,
): string {
	const artifactPath = artifactPathFor(projectDir, slug);
	fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
	fs.writeFileSync(artifactPath, content, 'utf-8');
	return artifactPath;
}

function ordinarySkillMarkdown(slug: string): string {
	return [
		'---',
		`name: ${slug}`,
		'description: An ordinary generated skill.',
		'skill_origin: generated',
		'version: 1',
		'---',
		'',
		SKILL_BODY,
	].join('\n');
}

function claimedSkillMarkdown(slug: string, body = SKILL_BODY): string {
	return [
		'---',
		`name: ${slug}`,
		'skill_origin: promoted_external',
		'---',
		'',
		body,
	].join('\n');
}

function candidatesDir(projectDir: string): string {
	return path.join(projectDir, '.swarm', 'skills', 'candidates');
}

function writeStoreFile(
	projectDir: string,
	name: string,
	content: string,
): void {
	fs.mkdirSync(candidatesDir(projectDir), { recursive: true });
	fs.writeFileSync(
		path.join(candidatesDir(projectDir), name),
		content,
		'utf-8',
	);
}

describe('verifyPromotedExternalSkillSync — claim-gated indeterminacy (FB-101/RP-001)', () => {
	let projectDir: string;
	const originalReaddir = identityInternals.readdirSync;

	beforeEach(() => {
		projectDir = canonicalMkdtemp('ext-skill-verify-');
	});

	afterEach(() => {
		identityInternals.readdirSync = originalReaddir;
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	test('ordinary skill + unrelated CORRUPT record is accepted', () => {
		writeArtifact(
			projectDir,
			'ordinary-corrupt',
			ordinarySkillMarkdown('ordinary-corrupt'),
		);
		writeStoreFile(projectDir, 'unrelated-corrupt.json', '{ not json');
		const result = verifyPromotedExternalSkillSync(
			projectDir,
			artifactPathFor(projectDir, 'ordinary-corrupt'),
		);
		expect(result.ok, JSON.stringify(result)).toBe(true);
	});

	test('ordinary skill + unrelated OVERSIZED record is accepted', () => {
		writeArtifact(
			projectDir,
			'ordinary-oversize',
			ordinarySkillMarkdown('ordinary-oversize'),
		);
		writeStoreFile(
			projectDir,
			'unrelated-huge.json',
			'x'.repeat(PROMOTION_RECORD_MAX_BYTES + 1),
		);
		const result = verifyPromotedExternalSkillSync(
			projectDir,
			artifactPathFor(projectDir, 'ordinary-oversize'),
		);
		expect(result.ok, JSON.stringify(result)).toBe(true);
	});

	test('ordinary skill + over-cap store (cap+1 records) is accepted', () => {
		writeArtifact(
			projectDir,
			'ordinary-overcap',
			ordinarySkillMarkdown('ordinary-overcap'),
		);
		stubOverCapListing();
		const result = verifyPromotedExternalSkillSync(
			projectDir,
			artifactPathFor(projectDir, 'ordinary-overcap'),
		);
		expect(result.ok, JSON.stringify(result)).toBe(true);
	});

	test('CLAIMED artifact + corrupt record is refused naming the record file', () => {
		writeArtifact(
			projectDir,
			'claimed-corrupt',
			claimedSkillMarkdown('claimed-corrupt'),
		);
		writeStoreFile(projectDir, 'named-corrupt.json', '{ not json');
		const result = verifyPromotedExternalSkillSync(
			projectDir,
			artifactPathFor(projectDir, 'claimed-corrupt'),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain('named-corrupt.json');
			expect(result.reason).toContain('corrupt');
			// FB-101: the synchronous-bound phrase is reserved for over-cap.
			expect(result.reason).not.toContain('synchronous verification bound');
		}
	});

	test('CLAIMED artifact + oversized record is refused naming the record file', () => {
		writeArtifact(
			projectDir,
			'claimed-oversize',
			claimedSkillMarkdown('claimed-oversize'),
		);
		writeStoreFile(
			projectDir,
			'named-huge.json',
			'x'.repeat(PROMOTION_RECORD_MAX_BYTES + 1),
		);
		const result = verifyPromotedExternalSkillSync(
			projectDir,
			artifactPathFor(projectDir, 'claimed-oversize'),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain('named-huge.json');
			expect(result.reason).toContain('exceeds');
			expect(result.reason).not.toContain('synchronous verification bound');
		}
	});

	test('CLAIMED artifact + over-cap store is refused with the bound reason', () => {
		writeArtifact(
			projectDir,
			'claimed-overcap',
			claimedSkillMarkdown('claimed-overcap'),
		);
		stubOverCapListing();
		const result = verifyPromotedExternalSkillSync(
			projectDir,
			artifactPathFor(projectDir, 'claimed-overcap'),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain('synchronous verification bound');
		}
	});

	test('unreadable store: claimed refused naming unreadable, unclaimed accepted', () => {
		writeArtifact(
			projectDir,
			'claimed-store',
			claimedSkillMarkdown('claimed-store'),
		);
		writeArtifact(
			projectDir,
			'ordinary-store',
			ordinarySkillMarkdown('ordinary-store'),
		);
		identityInternals.readdirSync = (() => {
			throw Object.assign(new Error('denied'), { code: 'EPERM' });
		}) as typeof fs.readdirSync;

		const claimed = verifyPromotedExternalSkillSync(
			projectDir,
			artifactPathFor(projectDir, 'claimed-store'),
		);
		expect(claimed.ok).toBe(false);
		if (!claimed.ok) {
			expect(claimed.reason).toContain('unreadable');
			expect(claimed.reason).toContain('EPERM');
			expect(claimed.reason).not.toContain('synchronous verification bound');
		}

		const ordinary = verifyPromotedExternalSkillSync(
			projectDir,
			artifactPathFor(projectDir, 'ordinary-store'),
		);
		expect(ordinary.ok, JSON.stringify(ordinary)).toBe(true);
	});
});

describe('verifyPromotedExternalSkillSync — provenance claim scope (FB-108)', () => {
	let projectDir: string;

	beforeEach(() => {
		projectDir = canonicalMkdtemp('ext-skill-claim-');
	});

	afterEach(() => {
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	test('the claim line as BODY TEXT is not a claim (ordinary skill accepted)', () => {
		// Pre-fix, detectProvenanceClaim scanned the whole 8 KiB head, so an
		// ordinary generated skill DOCUMENTING 'skill_origin: promoted_external'
		// in prose was refused as an orphaned promotion claim.
		const content = [
			'---',
			'name: body-text-claim',
			'description: Documents the promoted provenance marker in prose.',
			'version: 1',
			'---',
			'',
			'This skill explains that a line reading',
			'skill_origin: promoted_external',
			'marks promoted artifacts. It is itself an ordinary generated skill.',
		].join('\n');
		writeArtifact(projectDir, 'body-text-claim', content);
		const result = verifyPromotedExternalSkillSync(
			projectDir,
			artifactPathFor(projectDir, 'body-text-claim'),
		);
		expect(result.ok, JSON.stringify(result)).toBe(true);
	});

	test('the same line in the LEADING frontmatter without a record is refused', () => {
		writeArtifact(
			projectDir,
			'frontmatter-claim',
			claimedSkillMarkdown('frontmatter-claim'),
		);
		const result = verifyPromotedExternalSkillSync(
			projectDir,
			artifactPathFor(projectDir, 'frontmatter-claim'),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain('no matching promotion record');
		}
	});
});

describe('verifyPromotedExternalSkillSync — revoked records (FB-102)', () => {
	let projectDir: string;

	beforeEach(() => {
		projectDir = canonicalMkdtemp('ext-skill-vrev-');
	});

	afterEach(() => {
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	test('a revoked record does not shadow an ordinary skill at the same path', () => {
		const slug = 'shadowed-ordinary';
		writeArtifact(projectDir, slug, ordinarySkillMarkdown(slug));
		writeStoreFile(
			projectDir,
			'revoked.json',
			JSON.stringify({
				id: '00000000-0000-4000-a000-000000000003',
				evaluation_verdict: 'revoked',
				evaluation_history: [
					{
						verdict: 'promoted',
						timestamp: '2026-01-15T12:00:00.000Z',
						actor: 'user',
						target_path: artifactPathFor(projectDir, slug),
						promoted_content_hash:
							'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
					},
					{
						verdict: 'revoked',
						timestamp: '2026-02-15T12:00:00.000Z',
						actor: 'user',
					},
				],
			}),
		);
		const result = verifyPromotedExternalSkillSync(
			projectDir,
			artifactPathFor(projectDir, slug),
		);
		expect(result.ok, JSON.stringify(result)).toBe(true);
	});

	test('a claimed artifact whose only record is revoked is refused as an orphan claim', () => {
		const slug = 'claimed-after-revoke';
		writeArtifact(projectDir, slug, claimedSkillMarkdown(slug));
		writeStoreFile(
			projectDir,
			'revoked.json',
			JSON.stringify({
				id: '00000000-0000-4000-a000-000000000004',
				evaluation_verdict: 'revoked',
				evaluation_history: [
					{
						verdict: 'promoted',
						timestamp: '2026-01-15T12:00:00.000Z',
						actor: 'user',
						target_path: artifactPathFor(projectDir, slug),
						promoted_content_hash:
							'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
					},
					{
						verdict: 'revoked',
						timestamp: '2026-02-15T12:00:00.000Z',
						actor: 'user',
					},
				],
			}),
		);
		const result = verifyPromotedExternalSkillSync(
			projectDir,
			artifactPathFor(projectDir, slug),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain('no matching promotion record');
		}
	});
});

describe('verifyPromotedExternalSkillSync — advisory digest line (FB-212)', () => {
	let projectDir: string;

	beforeEach(() => {
		projectDir = canonicalMkdtemp('ext-skill-advisory-');
	});

	afterEach(() => {
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	test('editing ONLY the advisory frontmatter digest value still verifies', () => {
		const slug = 'advisory-edit';
		const content = [
			'---',
			`name: ${slug}`,
			'candidate_id: 00000000-0000-4000-a000-000000000005',
			'skill_origin: promoted_external',
			'content_digest: 1111111111111111111111111111111111111111111111111111111111111111',
			'---',
			'',
			SKILL_BODY,
		].join('\n');
		const artifactPath = writeArtifact(projectDir, slug, content);

		// Seed the record with the hash computed by the INDEPENDENT oracle —
		// the advisory value above is deliberately garbage and must not
		// matter: verification recomputes the canonical digest over the
		// on-disk bytes with the digest line replaced.
		writeStoreFile(
			projectDir,
			'00000000-0000-4000-a000-000000000005.json',
			JSON.stringify({
				id: '00000000-0000-4000-a000-000000000005',
				evaluation_verdict: 'promoted',
				evaluation_history: [
					{
						verdict: 'promoted',
						timestamp: '2026-01-15T12:00:00.000Z',
						actor: 'user',
						target_path: artifactPath,
						promoted_content_hash: independentCanonicalDigest(content),
					},
				],
			}),
		);

		const result = verifyPromotedExternalSkillSync(projectDir, artifactPath);
		expect(result.ok, JSON.stringify(result)).toBe(true);
		// Cross-check: the independent oracle and the implementation agree on
		// the canonical digest of this artifact (no self-oracle: the record
		// hash was fixed BEFORE this call).
		expect(independentCanonicalDigest(content)).toBe(
			computeArtifactDigest(content),
		);
	});
});
