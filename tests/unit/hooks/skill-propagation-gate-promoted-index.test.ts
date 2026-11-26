/**
 * #3822 propagation-gate integration of the per-call promotion-record index
 * (RP-002) and the claim-gated indeterminacy policy (FB-101).
 *
 * The gate wraps each of its `validateSkillReference` loops in ONE
 * `withPromotionRecordIndex` scope per hook invocation: every generated-root
 * artifact validated during one loop shares a single bounded candidate-store
 * scan, and the index is discarded when the loop finishes — two sequential
 * hook invocations observe in-place record edits (no cross-call persistence,
 * no mtime-keyed cache).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	validateExplicitSkillReferencesBefore,
	validateSkillReference,
} from '../../../src/hooks/skill-propagation-gate';
import {
	ARTIFACT_DIGEST_PLACEHOLDER_LINE,
	_internals as identityInternals,
} from '../../../src/services/external-skill-identity.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const SKILL_BODY = 'Gate index integration skill body.';

const AUDIENCE_CONTEXT = {
	runner: 'opencode',
	audiences: ['swarm-plugin'],
} as never;

const GATE_CONFIG = { enabled: false, enforce: false } as const;

/**
 * Independent canonical digest oracle (line-based replacement, not
 * computeArtifactDigest) — the record hash is fixed before verification.
 */
function canonicalDigestOf(content: string): string {
	const lines = content.split('\n');
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith('content_digest:')) {
			const cr = lines[i].indexOf('\r');
			lines[i] =
				cr === -1
					? ARTIFACT_DIGEST_PLACEHOLDER_LINE
					: ARTIFACT_DIGEST_PLACEHOLDER_LINE + lines[i].slice(cr);
			break;
		}
	}
	return createHash('sha256').update(lines.join('\n')).digest('hex');
}

function generatedSkillPath(projectDir: string, slug: string): string {
	return path.join(
		projectDir,
		'.opencode',
		'skills',
		'generated',
		slug,
		'SKILL.md',
	);
}

function writeGeneratedSkill(
	projectDir: string,
	slug: string,
	content: string,
): string {
	const artifactPath = generatedSkillPath(projectDir, slug);
	fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
	fs.writeFileSync(artifactPath, content, 'utf-8');
	return artifactPath;
}

function claimedArtifact(slug: string, candidateId: string): string {
	return [
		'---',
		`name: ${slug}`,
		`candidate_id: ${candidateId}`,
		'skill_origin: promoted_external',
		'---',
		'',
		SKILL_BODY,
	].join('\n');
}

function ordinaryArtifact(slug: string): string {
	return [
		'---',
		`name: ${slug}`,
		'description: An ordinary generated skill.',
		'version: 1',
		'---',
		'',
		SKILL_BODY,
	].join('\n');
}

function recordJson(
	candidateId: string,
	targetPath: string,
	content: string,
	verdict = 'promoted',
): string {
	return JSON.stringify({
		id: candidateId,
		evaluation_verdict: verdict,
		evaluation_history: [
			{
				verdict: 'promoted',
				timestamp: '2026-01-15T12:00:00.000Z',
				actor: 'user',
				target_path: targetPath,
				promoted_content_hash: canonicalDigestOf(content),
			},
		],
	});
}

function writeRecord(
	projectDir: string,
	candidateId: string,
	json: string,
): void {
	const recordPath = path.join(
		projectDir,
		'.swarm',
		'skills',
		'candidates',
		`${candidateId}.json`,
	);
	fs.mkdirSync(path.dirname(recordPath), { recursive: true });
	fs.writeFileSync(recordPath, json, 'utf-8');
}

function delegationPrompt(references: string[]): string {
	return `TASK: gate-index\nSKILLS: ${references.join(', ')}`;
}

describe('gate — per-hook promotion-record index (RP-002)', () => {
	let projectDir: string;
	const originalIdentityReaddir = identityInternals.readdirSync;
	let identityReaddirCalls: number;

	beforeEach(() => {
		projectDir = canonicalMkdtemp('gate-promoted-index-');
		identityReaddirCalls = 0;
		identityInternals.readdirSync = ((dir: fs.PathLike, options?: unknown) => {
			identityReaddirCalls += 1;
			return originalIdentityReaddir(dir, options as never);
		}) as typeof fs.readdirSync;
	});

	afterEach(() => {
		identityInternals.readdirSync = originalIdentityReaddir;
		removeTreeWithRetry(projectDir);
	});

	test('multiple SKILLS references in ONE delegation cost ONE candidate-store scan', async () => {
		const contentA = claimedArtifact(
			'index-a',
			'00000000-0000-4000-a000-0000000000a1',
		);
		const contentB = claimedArtifact(
			'index-b',
			'00000000-0000-4000-a000-0000000000b2',
		);
		writeGeneratedSkill(projectDir, 'index-a', contentA);
		writeGeneratedSkill(projectDir, 'index-b', contentB);
		writeRecord(
			projectDir,
			'00000000-0000-4000-a000-0000000000a1',
			recordJson(
				'00000000-0000-4000-a000-0000000000a1',
				generatedSkillPath(projectDir, 'index-a'),
				contentA,
			),
		);
		writeRecord(
			projectDir,
			'00000000-0000-4000-a000-0000000000b2',
			recordJson(
				'00000000-0000-4000-a000-0000000000b2',
				generatedSkillPath(projectDir, 'index-b'),
				contentB,
			),
		);

		const result = await validateExplicitSkillReferencesBefore(
			projectDir,
			{
				tool: 'Task',
				agent: 'architect',
				sessionID: 'gate-index-session',
				args: {
					subagent_type: 'coder',
					prompt: delegationPrompt([
						'file:.opencode/skills/generated/index-a/SKILL.md',
						'file:.opencode/skills/generated/index-b/SKILL.md',
					]),
				},
			},
			GATE_CONFIG,
		);

		expect(result.blocked, result.reason ?? '').toBe(false);
		expect(result.validatedSkillPaths).toHaveLength(2);
		// The RP-002 contract: one bounded scan per hook invocation's loop.
		expect(identityReaddirCalls).toBe(1);
	});

	test('two sequential delegations observe an in-place record edit (no cross-call cache)', async () => {
		const candidateId = '00000000-0000-4000-a000-0000000000c3';
		const content = claimedArtifact('freshness', candidateId);
		writeGeneratedSkill(projectDir, 'freshness', content);
		writeRecord(
			projectDir,
			candidateId,
			recordJson(
				candidateId,
				generatedSkillPath(projectDir, 'freshness'),
				content,
			),
		);

		const input = {
			tool: 'Task',
			agent: 'architect',
			sessionID: 'gate-index-session',
			args: {
				subagent_type: 'coder',
				prompt: delegationPrompt([
					'file:.opencode/skills/generated/freshness/SKILL.md',
				]),
			},
		};

		const first = await validateExplicitSkillReferencesBefore(
			projectDir,
			input,
			GATE_CONFIG,
		);
		expect(first.blocked, first.reason ?? '').toBe(false);

		// In-place edit: the record flips to revoked (what a revoke does).
		writeRecord(
			projectDir,
			candidateId,
			recordJson(
				candidateId,
				generatedSkillPath(projectDir, 'freshness'),
				content,
				'revoked',
			),
		);

		const second = await validateExplicitSkillReferencesBefore(
			projectDir,
			input,
			GATE_CONFIG,
		);
		expect(second.blocked).toBe(true);
		expect(second.reason).toContain('no matching promotion record');
	});

	test('an unrelated corrupt record does not block an ordinary generated skill through the gate', () => {
		writeGeneratedSkill(
			projectDir,
			'ordinary-gate',
			ordinaryArtifact('ordinary-gate'),
		);
		fs.mkdirSync(path.join(projectDir, '.swarm', 'skills', 'candidates'), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(projectDir, '.swarm', 'skills', 'candidates', 'unrelated.json'),
			'{ corrupt',
			'utf-8',
		);

		const result = validateSkillReference(
			projectDir,
			'file:.opencode/skills/generated/ordinary-gate/SKILL.md',
			AUDIENCE_CONTEXT,
			{ enforceAudience: false },
		);
		expect(result.valid, result.reason ?? '').toBe(true);
	});
});
