/**
 * #3942 Stage B round 2 — provenance-claim determination under the bounded
 * head, deterministic fail-closed rule.
 *
 * Policy under test (reviewer ruling on the former "undetectable by
 * construction" tripwire): the provenance head is 64 KiB. When an artifact
 * begins with a '---' fence and NO closing fence is found within that head
 * WHILE the file is longer than the head, the claim state is UNVERIFIABLE
 * and verification refuses (unless a readable matching promotion record
 * binds the path — the path-first digest flow stays as is). An artifact
 * whose frontmatter closes within the head keeps the normal semantics:
 * claim line in frontmatter => needs a record; marker text in the body =>
 * ordinary. A file with no leading fence => ordinary. A file SHORTER than
 * the head whose fence never closes is deterministically scanned whole (its
 * entire content is frontmatter).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals as identityInternals,
	PROVENANCE_HEAD_BYTES,
	verifyPromotedExternalSkillSync,
} from '../../../src/services/external-skill-identity.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SKILL_BODY = 'Body for the truncated-frontmatter claim tests.';

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

/**
 * An artifact whose frontmatter is padded past the provenance head so no
 * closing '---' is visible. `markerFirst` puts the provenance marker right
 * after the opening fence (promote's field order); otherwise the marker sits
 * at the very END of the visible head (just before the cutoff).
 */
function overlongFrontmatterArtifact(markerFirst: boolean): string {
	const marker = 'skill_origin: promoted_external';
	const headroom = PROVENANCE_HEAD_BYTES; // visible window
	const padLine = (name: string, size: number) =>
		`${name}: ${'x'.repeat(size)}\n`;
	const parts: string[] = ['---\n'];
	if (markerFirst) {
		parts.push('promoted_from: external-skill-candidate\n');
		parts.push('candidate_id: 00000000-0000-4000-a000-000000000099\n');
		parts.push(`${marker}\n`);
		// Pad well past the head so the closing fence is out of view.
		parts.push(padLine('pad_a', headroom + 512));
		parts.push(padLine('pad_b', headroom + 512));
	} else {
		// Marker LAST inside the visible window: fence + padding sized so the
		// whole marker line fits before the cutoff with margin.
		const prefix = '---\n';
		const markerLine = `${marker}\n`;
		const padSize = headroom - prefix.length - markerLine.length - 64;
		parts.push(padLine('pad_a', Math.max(0, padSize)));
		parts.push(markerLine);
		parts.push(padLine('pad_b', headroom + 512));
	}
	// No closing fence anywhere in the visible head; a distant one (or none)
	// followed by the body.
	parts.push('---\n', '\n', SKILL_BODY);
	return parts.join('');
}

/** Frontmatter whose closing fence ends EXACTLY at the head-byte boundary. */
function frontmatterClosingExactlyAtBound(marker: boolean): string {
	const opening = '---\n';
	const markerLine = marker ? 'skill_origin: promoted_external\n' : '';
	const closing = '---\n';
	const padPrefix = 'pad: ';
	const padNewline = '\n';
	const fixedBytes =
		Buffer.byteLength(opening + markerLine + closing, 'utf-8') +
		padPrefix.length +
		padNewline.length;
	const padSize = PROVENANCE_HEAD_BYTES - fixedBytes;
	expect(padSize).toBeGreaterThan(0);
	const frontmatter =
		opening +
		markerLine +
		`${padPrefix}${'x'.repeat(padSize)}${padNewline}` +
		closing;
	expect(Buffer.byteLength(frontmatter, 'utf-8')).toBe(PROVENANCE_HEAD_BYTES);
	return frontmatter + SKILL_BODY;
}

/** Complete frontmatter closing WITHIN the head, marker ~64 bytes before it. */
function frontmatterWithMarkerNearCutoff(): string {
	const opening = '---\n';
	const markerLine = 'skill_origin: promoted_external\n';
	const closing = '---\n';
	const padPrefix = 'pad: ';
	const padNewline = '\n';
	const fixedBytes =
		Buffer.byteLength(opening + markerLine + closing, 'utf-8') +
		padPrefix.length +
		padNewline.length;
	const padSize = PROVENANCE_HEAD_BYTES - fixedBytes - 64;
	expect(padSize).toBeGreaterThan(0);
	const frontmatter =
		opening +
		`${padPrefix}${'x'.repeat(padSize)}${padNewline}` +
		markerLine +
		closing;
	expect(Buffer.byteLength(frontmatter, 'utf-8')).toBeLessThan(
		PROVENANCE_HEAD_BYTES,
	);
	return frontmatter + SKILL_BODY;
}

describe('verifyPromotedExternalSkillSync — bounded-head claim policy (Stage B round 2)', () => {
	let projectDir: string;

	beforeEach(() => {
		projectDir = canonicalMkdtemp('ext-skill-fm-claim-');
	});

	afterEach(() => {
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	test('claim at the TOP of an over-long frontmatter is refused by the bound rule', () => {
		const content = overlongFrontmatterArtifact(true);
		const head = Buffer.from(content, 'utf-8')
			.subarray(0, PROVENANCE_HEAD_BYTES)
			.toString('utf-8');
		expect(head.startsWith('---\n')).toBe(true);
		expect(head.includes('skill_origin: promoted_external')).toBe(true);
		expect(head.includes('\n---\n', 4)).toBe(false);

		const artifactPath = writeArtifact(projectDir, 'fm-claim-first', content);
		const result = verifyPromotedExternalSkillSync(projectDir, artifactPath);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain('provenance-verification bound');
			expect(result.reason).toContain('promotion claim');
		}
	});

	test('claim near the CUTOFF of an unterminated over-long frontmatter is refused by the bound rule', () => {
		const content = overlongFrontmatterArtifact(false);
		const head = Buffer.from(content, 'utf-8')
			.subarray(0, PROVENANCE_HEAD_BYTES)
			.toString('utf-8');
		expect(head.startsWith('---\n')).toBe(true);
		expect(head.lastIndexOf('skill_origin: promoted_external')).toBeGreaterThan(
			0,
		);
		expect(head.includes('\n---\n', 4)).toBe(false);

		const artifactPath = writeArtifact(projectDir, 'fm-claim-late', content);
		const result = verifyPromotedExternalSkillSync(projectDir, artifactPath);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain('provenance-verification bound');
		}
	});

	test('a marker beyond the head is now deterministically refused (former undetectable tripwire)', () => {
		// The pre-round-2 design accepted this artifact as ordinary and pinned
		// that acceptance with a tripwire. The decided rule replaces the limit
		// with a deterministic refusal: the fence does not close within the
		// head and the file is longer, so the claim state is unverifiable.
		const prefix = `---\npad: ${'x'.repeat(PROVENANCE_HEAD_BYTES)}\n`;
		const content = `${prefix}skill_origin: promoted_external\n---\n${SKILL_BODY}\n`;
		const artifactPath = writeArtifact(projectDir, 'fm-claim-beyond', content);
		const result = verifyPromotedExternalSkillSync(projectDir, artifactPath);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain('provenance-verification bound');
			expect(result.reason).toContain('promotion claim');
		}
	});

	test('an unterminated over-long frontmatter is refused even with NO claim marker', () => {
		// The bound rule is claim-agnostic: an ordinary artifact with a huge
		// frontmatter is equally unverifiable and must not be accepted.
		const content = [
			'---',
			'name: fm-ordinary-long',
			`description: ${'y'.repeat(PROVENANCE_HEAD_BYTES + 256)}`,
			'version: 1',
			'---',
			'',
			SKILL_BODY,
		].join('\n');
		const artifactPath = writeArtifact(projectDir, 'fm-ordinary-long', content);
		const result = verifyPromotedExternalSkillSync(projectDir, artifactPath);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain('provenance-verification bound');
		}
	});

	test('frontmatter closing EXACTLY at the head boundary: ordinary artifact accepted', () => {
		const content = frontmatterClosingExactlyAtBound(false);
		const artifactPath = writeArtifact(projectDir, 'fm-bound-plain', content);
		const result = verifyPromotedExternalSkillSync(projectDir, artifactPath);
		expect(result.ok, JSON.stringify(result)).toBe(true);
	});

	test('frontmatter closing EXACTLY at the head boundary: claim detected normally', () => {
		const content = frontmatterClosingExactlyAtBound(true);
		const artifactPath = writeArtifact(projectDir, 'fm-bound-claim', content);
		const result = verifyPromotedExternalSkillSync(projectDir, artifactPath);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain('no matching promotion record');
		}
	});

	test('claim near the cutoff of a COMPLETE frontmatter is detected normally', () => {
		const content = frontmatterWithMarkerNearCutoff();
		const artifactPath = writeArtifact(projectDir, 'fm-near-cutoff', content);
		const result = verifyPromotedExternalSkillSync(projectDir, artifactPath);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain('no matching promotion record');
		}
	});

	test('unterminated fence in a file SHORTER than the head: marker present => refused as orphan claim', () => {
		// Whole file visible => the unterminated block is deterministically
		// scanned; the Stage B whole-visible fallback still applies.
		const content = `---\nname: fm-small-unterminated\nskill_origin: promoted_external\npad: ${'x'.repeat(512)}`;
		const artifactPath = writeArtifact(projectDir, 'fm-small-claim', content);
		const result = verifyPromotedExternalSkillSync(projectDir, artifactPath);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain('no matching promotion record');
		}
	});

	test('unterminated fence in a file SHORTER than the head: no marker => accepted', () => {
		const content = `---\nname: fm-small-plain\npad: ${'x'.repeat(512)}`;
		const artifactPath = writeArtifact(projectDir, 'fm-small-plain', content);
		const result = verifyPromotedExternalSkillSync(projectDir, artifactPath);
		expect(result.ok, JSON.stringify(result)).toBe(true);
	});

	test('unverifiable claim state + indeterminate store still fails closed with the bound reason', () => {
		const content = overlongFrontmatterArtifact(true);
		const artifactPath = writeArtifact(
			projectDir,
			'fm-unverifiable-store',
			content,
		);
		const originalReaddir = identityInternals.readdirSync;
		identityInternals.readdirSync = (() => {
			throw Object.assign(new Error('denied'), { code: 'EPERM' });
		}) as typeof fs.readdirSync;
		try {
			const result = verifyPromotedExternalSkillSync(projectDir, artifactPath);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toContain('provenance-verification bound');
			}
		} finally {
			identityInternals.readdirSync = originalReaddir;
		}
	});

	test('marker text in the BODY after a complete frontmatter is still accepted', () => {
		const content = [
			'---',
			'name: fm-body-text',
			'description: Documents the promoted marker in prose.',
			'version: 1',
			'---',
			'',
			'An ordinary generated skill explaining that a line reading',
			'skill_origin: promoted_external',
			'marks promoted artifacts.',
		].join('\n');
		const artifactPath = writeArtifact(projectDir, 'fm-body-text', content);
		const result = verifyPromotedExternalSkillSync(projectDir, artifactPath);
		expect(result.ok, JSON.stringify(result)).toBe(true);
	});
});
