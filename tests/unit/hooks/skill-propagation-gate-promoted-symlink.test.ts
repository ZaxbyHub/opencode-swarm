/**
 * #3942 Stage B review (gate lexical/real split, FB-112) — a lexical
 * reference under .opencode/skills/generated/ whose RESOLVED path leaves the
 * generated root must not skip promoted-artifact identity verification.
 *
 * Pre-fix behavior: validateSkillReference ran verifyPromotedExternalSkillSync
 * only when the REALPATH was inside the generated root, so replacing a
 * promoted skill's SKILL.md with a symlink to a tampered in-project copy
 * OUTSIDE the root passed every containment check and validated without any
 * digest comparison.
 *
 * Fix under test: verification runs when EITHER the lexical or the resolved
 * path is inside the generated root, and the LEXICAL in-root path is passed
 * to the verifier (pathIdentityKeys covers both spellings; reads through the
 * lexical path follow a replaced symlink, so the digest runs on the bytes
 * the gate will actually load).
 *
 * Windows hosts may refuse symlink creation (EPERM). The real-symlink arm is
 * therefore registered with an explicit visible skip reason when the probe
 * fails; the simulated arm (gate realpathSync seam) covers the same split on
 * every host.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals as gateInternals,
	validateSkillReference,
} from '../../../src/hooks/skill-propagation-gate.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

const CANDIDATE_ID = '00000000-0000-4000-a000-0000000000e4';
const ORIGINAL_BODY = '# Promoted skill body as approved at promotion time.';
const TAMPERED_BODY = '# Tampered body injected after approval.';

const AUDIENCE_CONTEXT = {
	runner: 'opencode',
	audiences: ['swarm-plugin'],
} as never;

function claimedMarkdown(body: string): string {
	return [
		'---',
		`name: symlink-bypass-skill`,
		`candidate_id: ${CANDIDATE_ID}`,
		'skill_origin: promoted_external',
		'---',
		'',
		body,
	].join('\n');
}

/** Canonical digest computed independently (line replacement + node:crypto). */
function canonicalDigestOf(content: string): string {
	const placeholder = 'content_digest: <recorded>';
	const lines = content.split('\n');
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith('content_digest:')) {
			const cr = lines[i].indexOf('\r');
			lines[i] = cr === -1 ? placeholder : placeholder + lines[i].slice(cr);
			break;
		}
	}
	return createHash('sha256').update(lines.join('\n')).digest('hex');
}

function generatedSkillPath(projectDir: string): string {
	return path.join(
		projectDir,
		'.opencode',
		'skills',
		'generated',
		'symlink-bypass-skill',
		'SKILL.md',
	);
}

function writeRecordBinding(projectDir: string, content: string): void {
	const artifactPath = generatedSkillPath(projectDir);
	const recordPath = path.join(
		projectDir,
		'.swarm',
		'skills',
		'candidates',
		`${CANDIDATE_ID}.json`,
	);
	fs.mkdirSync(path.dirname(recordPath), { recursive: true });
	fs.writeFileSync(
		recordPath,
		JSON.stringify({
			id: CANDIDATE_ID,
			evaluation_verdict: 'promoted',
			evaluation_history: [
				{
					verdict: 'promoted',
					timestamp: '2026-01-15T12:00:00.000Z',
					actor: 'user',
					target_path: artifactPath,
					promoted_content_hash: canonicalDigestOf(content),
				},
			],
		}),
		'utf-8',
	);
}

function validate(projectDir: string) {
	return validateSkillReference(
		projectDir,
		'file:.opencode/skills/generated/symlink-bypass-skill/SKILL.md',
		AUDIENCE_CONTEXT,
		{ enforceAudience: false },
	);
}

describe('gate — lexical-in-root / real-outside generated-root split (Stage B, FB-112)', () => {
	let projectDir: string;
	const originalRealpath = gateInternals.realpathSync;

	beforeEach(() => {
		projectDir = canonicalMkdtemp('gate-symlink-bypass-');
	});

	afterEach(() => {
		gateInternals.realpathSync = originalRealpath;
		removeTreeWithRetry(projectDir);
	});

	test('SIMULATED split: resolved path outside the root still verifies the lexical artifact', () => {
		const original = claimedMarkdown(ORIGINAL_BODY);
		const tampered = claimedMarkdown(TAMPERED_BODY);
		// The record binds the in-root path to the ORIGINAL bytes.
		writeRecordBinding(projectDir, original);
		// The in-root file holds TAMPERED bytes, and an identical tampered
		// copy lives elsewhere in the project. The gate's realpathSync seam
		// simulates "the in-root path resolves to the outside copy" (exactly
		// what a symlink replacement produces) on hosts where creating one is
		// unreliable.
		const artifactPath = generatedSkillPath(projectDir);
		fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
		fs.writeFileSync(artifactPath, tampered, 'utf-8');
		const outsideCopy = path.join(projectDir, 'tampered-copy.md');
		fs.writeFileSync(outsideCopy, tampered, 'utf-8');

		gateInternals.realpathSync = ((p: fs.PathLike, options?: unknown) => {
			if (
				typeof p === 'string' &&
				path.resolve(p) === path.resolve(artifactPath)
			) {
				return outsideCopy;
			}
			return originalRealpath(p, options as never);
		}) as typeof fs.realpathSync;

		// Pre-fix: the resolved path is outside the generated root, identity
		// verification is skipped entirely, and the tampered skill validates.
		const result = validate(projectDir);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.reason).toContain('recorded promotion hash');
		}
	});

	test('control: matching bytes through the same simulated split still validate', () => {
		const original = claimedMarkdown(ORIGINAL_BODY);
		writeRecordBinding(projectDir, original);
		const artifactPath = generatedSkillPath(projectDir);
		fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
		fs.writeFileSync(artifactPath, original, 'utf-8');
		const outsideCopy = path.join(projectDir, 'matching-copy.md');
		fs.writeFileSync(outsideCopy, original, 'utf-8');

		gateInternals.realpathSync = ((p: fs.PathLike, options?: unknown) => {
			if (
				typeof p === 'string' &&
				path.resolve(p) === path.resolve(artifactPath)
			) {
				return outsideCopy;
			}
			return originalRealpath(p, options as never);
		}) as typeof fs.realpathSync;

		const result = validate(projectDir);
		expect(result.valid, result.reason ?? '').toBe(true);
	});
});

/** Capability probe for FILE symlinks (visible-skip arm, see file header). */
const canFileSymlink = (() => {
	const probeDir = canonicalMkdtemp('symlink-probe-gate-');
	try {
		fs.symlinkSync(
			path.join(probeDir, 'target.md'),
			path.join(probeDir, 'link.md'),
			'file',
		);
		return true;
	} catch {
		return false;
	} finally {
		removeTreeWithRetry(probeDir);
	}
})();

describe('gate — REAL symlink replacement (requires symlink privilege)', () => {
	let projectDir: string;

	beforeEach(() => {
		projectDir = canonicalMkdtemp('gate-symlink-real-');
	});

	afterEach(() => {
		removeTreeWithRetry(projectDir);
	});

	// The skip reason is visible in the test name: hosts without symlink
	// privilege (Windows EPERM without developer mode) cannot create the
	// replacement; the simulated arm above covers the same split there.
	test.skipIf(!canFileSymlink)(
		'real symlink to a tampered in-project copy is refused — skipped when the host refuses symlink creation',
		() => {
			const original = claimedMarkdown(ORIGINAL_BODY);
			const tampered = claimedMarkdown(TAMPERED_BODY);
			writeRecordBinding(projectDir, original);
			const artifactPath = generatedSkillPath(projectDir);
			fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
			const outsideCopy = path.join(projectDir, 'tampered-copy.md');
			fs.writeFileSync(outsideCopy, tampered, 'utf-8');
			fs.symlinkSync(outsideCopy, artifactPath, 'file');
			try {
				const result = validate(projectDir);
				expect(result.valid).toBe(false);
				if (!result.valid) {
					expect(result.reason).toContain('recorded promotion hash');
				}
			} finally {
				// Remove the symlink itself (not the target) so cleanup is safe
				// even if an assertion threw.
				try {
					fs.rmSync(artifactPath, { force: true });
				} catch {
					// Best-effort; removeTreeWithRetry below handles the rest.
				}
			}
		},
	);
});
