/**
 * F-003/CS-001/MSP-001, FB-210, RP-003, TF-004/MTI-001 — external_skill_revoke
 * hardening (PR #3942 feedback).
 *
 *   F-003  — a promoted path whose FINAL component is a symlink refuses the
 *            revoke (link + target unchanged, verdict stays promoted), and
 *            the unlink targets the LEXICAL promoted path.
 *   FB-210 — only ENOENT counts as "file missing" (idempotent success); any
 *            other inspection error, or a non-regular file, refuses without
 *            unlinking and without touching the verdict.
 *   RP-003 — the hash-verification read is a single bounded fd-based read
 *            (open once, fstat, read at most limit+1 bytes, close in finally).
 *   TF-004/MTI-001 — over-bound (PROMOTED_ARTIFACT_MAX_BYTES+1) and
 *            at-boundary (exactly MAX) artifact-size coverage.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExternalSkillCandidate } from '../../../src/config/schema.js';
import { PROMOTED_ARTIFACT_MAX_BYTES } from '../../../src/services/external-skill-identity.js';
import { createExternalSkillStore } from '../../../src/services/external-skill-store.js';
import {
	_internals,
	external_skill_revoke,
} from '../../../src/tools/external-skill-revoke.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

function sha256(content: string): string {
	return createHash('sha256').update(content).digest('hex');
}

async function callRevoke(args: unknown, directory: string): Promise<string> {
	return (
		external_skill_revoke as unknown as {
			execute: (args: unknown, ctx: { directory: string }) => Promise<string>;
		}
	).execute(args, { directory });
}

/** Seed a promoted candidate with a structured promotion entry. */
async function seedStructuredCandidate(
	directory: string,
	targetPath: string,
	promotedContentHash: string,
): Promise<ExternalSkillCandidate> {
	const store = createExternalSkillStore(directory, { max_candidates: 500 });
	return store.add({
		source_url: 'https://example.com/skill.md',
		source_type: 'github',
		publisher: 'test-publisher',
		sha256: sha256('Skill body content.'),
		fetched_at: '2026-01-15T12:00:00.000Z',
		skill_name: 'revoke-hardening-skill',
		skill_body: 'Skill body content.',
		risk_flags: [],
		evaluation_verdict: 'promoted',
		evaluation_history: [
			{
				verdict: 'promoted',
				timestamp: '2026-01-15T12:02:00.000Z',
				actor: 'user',
				reason: 'Promoted',
				target_path: targetPath,
				promoted_content_hash: promotedContentHash,
			},
		] as ExternalSkillCandidate['evaluation_history'],
	});
}

function writeSkillFile(targetPath: string, content: string): string {
	fs.mkdirSync(path.dirname(targetPath), { recursive: true });
	fs.writeFileSync(targetPath, content, 'utf-8');
	return targetPath;
}

function generatedPath(directory: string, slug: string): string {
	return path.join(
		directory,
		'.opencode',
		'skills',
		'generated',
		slug,
		'SKILL.md',
	);
}

async function candidateVerdict(
	directory: string,
	id: string,
): Promise<string | undefined> {
	const store = createExternalSkillStore(directory, { max_candidates: 500 });
	const candidate = await store.get(id);
	return candidate?.evaluation_verdict;
}

/** Probe once whether an unprivileged FILE symlink can be created here. */
let canFileSymlink = true;
const probeRoot = fs.mkdtempSync(
	path.join(fs.realpathSync(os.tmpdir()), 'rvhk-'),
);
try {
	const probeTarget = path.join(probeRoot, 't.txt');
	fs.writeFileSync(probeTarget, 'x', 'utf-8');
	fs.symlinkSync(probeTarget, path.join(probeRoot, 'l.txt'), 'file');
} catch {
	canFileSymlink = false;
	// Visible skip reason — a silent skip hides why the real-symlink coverage
	// is missing on this platform (win32 without Developer Mode: EPERM).
	process.stdout.write(
		'[SKIP] revoke real-file-symlink tests: file symlink creation not permitted on this platform\n',
	);
} finally {
	fs.rmSync(probeRoot, { recursive: true, force: true });
}

describe('external_skill_revoke — hardening (F-003/FB-210/RP-003/TF-004)', () => {
	let projectDir: string;
	let retireCalls: string[];
	const originalLoadConfig = _internals.loadConfig;
	const originalRetireSkillFile = _internals.retireSkillFile;
	const originalLstatTarget = _internals.lstatTarget;

	beforeEach(() => {
		projectDir = canonicalMkdtemp('ext-skill-revoke-hardening-');
		const configDir = path.join(projectDir, '.opencode');
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(
			path.join(configDir, 'opencode-swarm.json'),
			JSON.stringify({
				external_skills: {
					curation_enabled: true,
					max_candidates: 500,
					max_bytes_per_candidate: 1_048_576,
					eviction_policy: 'fifo',
				},
			}),
			'utf-8',
		);
		retireCalls = [];
		// Capture unlink targets; delegate to the real retire for behavior.
		const realRetire = originalRetireSkillFile;
		_internals.retireSkillFile = async (filePath: string): Promise<boolean> => {
			retireCalls.push(filePath);
			return realRetire(filePath);
		};
	});

	afterEach(() => {
		_internals.loadConfig = originalLoadConfig;
		_internals.retireSkillFile = originalRetireSkillFile;
		_internals.lstatTarget = originalLstatTarget;
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	test('final-component symlink (seam-injected) refuses revoke: no unlink, verdict unchanged', async () => {
		const realPath = writeSkillFile(
			generatedPath(projectDir, 'seam-symlink'),
			'# approved content\n',
		);
		const linkPath = generatedPath(projectDir, 'seam-link');
		const candidate = await seedStructuredCandidate(
			projectDir,
			linkPath,
			sha256('# approved content\n'),
		);
		// Deterministic arm: force the lstat result to "symlink" regardless of
		// platform symlink privilege. The real-filesystem arm is below.
		const realLstat = originalLstatTarget;
		_internals.lstatTarget = async (filePath: string) => {
			if (filePath === linkPath) return { kind: 'symlink' as const };
			return realLstat(filePath);
		};

		const raw = await callRevoke(
			{ candidate_id: candidate.id, reason: 'operator requested revoke' },
			projectDir,
		);
		const parsed = JSON.parse(raw) as { success: boolean; error?: string };
		expect(parsed.success, raw).toBe(false);
		expect(parsed.error).toContain('symlink');
		expect(retireCalls).toEqual([]);
		expect(fs.existsSync(realPath)).toBe(true);
		expect(await candidateVerdict(projectDir, candidate.id)).toBe('promoted');
	});

	test.skipIf(!canFileSymlink)(
		'in-root file symlink to a matching file is refused; target and link unchanged (real link)',
		async () => {
			const realPath = writeSkillFile(
				generatedPath(projectDir, 'real-slug'),
				'# real approved content\n',
			);
			const linkPath = generatedPath(projectDir, 'link-slug');
			// The link's parent directory must exist before the link is created.
			fs.mkdirSync(path.dirname(linkPath), { recursive: true });
			fs.symlinkSync(realPath, linkPath, 'file');
			const candidate = await seedStructuredCandidate(
				projectDir,
				linkPath,
				sha256('# real approved content\n'),
			);

			const raw = await callRevoke(
				{ candidate_id: candidate.id, reason: 'operator requested revoke' },
				projectDir,
			);
			const parsed = JSON.parse(raw) as { success: boolean; error?: string };
			expect(parsed.success, raw).toBe(false);
			expect(parsed.error).toContain('symlink');
			// BOTH the link and the real target must survive untouched.
			expect(fs.existsSync(realPath)).toBe(true);
			expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
			expect(retireCalls).toEqual([]);
			expect(await candidateVerdict(projectDir, candidate.id)).toBe('promoted');
		},
	);

	test('non-regular target (directory) refuses revoke instead of "missing" idempotent success', async () => {
		const dirPath = path.join(
			projectDir,
			'.opencode',
			'skills',
			'generated',
			'dir-slug',
			'SKILL.md',
		);
		fs.mkdirSync(dirPath, { recursive: true });
		const candidate = await seedStructuredCandidate(
			projectDir,
			dirPath,
			'a'.repeat(64),
		);

		const raw = await callRevoke(
			{ candidate_id: candidate.id, reason: 'operator requested revoke' },
			projectDir,
		);
		const parsed = JSON.parse(raw) as { success: boolean; error?: string };
		expect(parsed.success, raw).toBe(false);
		expect(parsed.error).toContain('not a regular file');
		expect(fs.existsSync(dirPath)).toBe(true);
		expect(retireCalls).toEqual([]);
		expect(await candidateVerdict(projectDir, candidate.id)).toBe('promoted');
	});

	test('non-ENOENT inspection error (EACCES) refuses revoke; file kept, verdict unchanged', async () => {
		const skillPath = writeSkillFile(
			generatedPath(projectDir, 'eaccess-slug'),
			'# approved content\n',
		);
		const candidate = await seedStructuredCandidate(
			projectDir,
			skillPath,
			sha256('# approved content\n'),
		);
		// Inject a non-ENOENT inspection failure (the seam wraps the real
		// lstat; the file itself exists and its hash matches, so ONLY the
		// inspection error can justify a refusal).
		_internals.lstatTarget = async () => ({
			kind: 'error' as const,
			code: 'EACCES',
		});

		const raw = await callRevoke(
			{ candidate_id: candidate.id, reason: 'operator requested revoke' },
			projectDir,
		);
		const parsed = JSON.parse(raw) as { success: boolean; error?: string };
		expect(parsed.success, raw).toBe(false);
		expect(parsed.error).toContain('could not be inspected');
		expect(parsed.error).toContain('EACCES');
		expect(fs.existsSync(skillPath)).toBe(true);
		expect(retireCalls).toEqual([]);
		expect(await candidateVerdict(projectDir, candidate.id)).toBe('promoted');
	});

	test('over-bound artifact (MAX+1 bytes) is refused with the verification-bound reason', async () => {
		const header = '# ok\n';
		const content = header + 'a'.repeat(PROMOTED_ARTIFACT_MAX_BYTES - 4);
		expect(Buffer.byteLength(content, 'utf-8')).toBe(
			PROMOTED_ARTIFACT_MAX_BYTES + 1,
		);
		const skillPath = writeSkillFile(
			generatedPath(projectDir, 'overbound-slug'),
			content,
		);
		const candidate = await seedStructuredCandidate(
			projectDir,
			skillPath,
			'a'.repeat(64),
		);

		const raw = await callRevoke(
			{ candidate_id: candidate.id, reason: 'operator requested revoke' },
			projectDir,
		);
		const parsed = JSON.parse(raw) as { success: boolean; error?: string };
		expect(parsed.success, raw).toBe(false);
		expect(parsed.error).toContain('verification bound');
		expect(fs.existsSync(skillPath)).toBe(true);
		expect(retireCalls).toEqual([]);
		expect(await candidateVerdict(projectDir, candidate.id)).toBe('promoted');
	});

	test('at-boundary artifact (exactly MAX bytes, digest verified) revokes cleanly', async () => {
		const header = '# ok\n';
		const content =
			header + 'a'.repeat(PROMOTED_ARTIFACT_MAX_BYTES - header.length);
		expect(Buffer.byteLength(content, 'utf-8')).toBe(
			PROMOTED_ARTIFACT_MAX_BYTES,
		);
		const skillPath = writeSkillFile(
			generatedPath(projectDir, 'atbound-slug'),
			content,
		);
		// No content_digest line in this artifact, so the canonical digest is
		// the plain sha256 — computed independently with node:crypto.
		const candidate = await seedStructuredCandidate(
			projectDir,
			skillPath,
			sha256(content),
		);

		const raw = await callRevoke(
			{ candidate_id: candidate.id, reason: 'operator requested revoke' },
			projectDir,
		);
		const parsed = JSON.parse(raw) as {
			success: boolean;
			error?: string;
			skill_file_removed?: boolean;
		};
		expect(parsed.success, raw).toBe(true);
		expect(parsed.skill_file_removed).toBe(true);
		expect(fs.existsSync(skillPath)).toBe(false);
		expect(retireCalls).toEqual([skillPath]);
		expect(await candidateVerdict(projectDir, candidate.id)).toBe('revoked');
	});

	// A directory junction needs no symlink privilege on Windows (and is a
	// plain dir symlink on POSIX), so this arm executes on every platform:
	// the PARENT is a link but the final component is a regular file, the
	// canonical target stays inside the generated root, and the unlink must
	// name the LEXICAL promoted path (MSP-001), not the canonicalized one.
	test('unlink targets the LEXICAL promoted path through an in-root parent junction', async () => {
		const linkKind =
			process.platform === 'win32' ? ('junction' as const) : ('dir' as const);
		const realDir = path.join(
			projectDir,
			'.opencode',
			'skills',
			'generated',
			'real-dir',
		);
		fs.mkdirSync(realDir, { recursive: true });
		const realPath = path.join(realDir, 'SKILL.md');
		fs.writeFileSync(realPath, '# approved via junction\n', 'utf-8');
		const linkDir = path.join(
			projectDir,
			'.opencode',
			'skills',
			'generated',
			'link-dir',
		);
		fs.symlinkSync(realDir, linkDir, linkKind);
		const lexicalTarget = path.join(linkDir, 'SKILL.md');
		const canonicalTarget = realPath;
		expect(fs.realpathSync(lexicalTarget)).toBe(canonicalTarget);
		const candidate = await seedStructuredCandidate(
			projectDir,
			lexicalTarget,
			sha256('# approved via junction\n'),
		);

		const raw = await callRevoke(
			{ candidate_id: candidate.id, reason: 'operator requested revoke' },
			projectDir,
		);
		const parsed = JSON.parse(raw) as {
			success: boolean;
			error?: string;
			skill_file_removed?: boolean;
		};
		expect(parsed.success, raw).toBe(true);
		expect(parsed.skill_file_removed).toBe(true);
		expect(retireCalls).toEqual([lexicalTarget]);
		expect(fs.existsSync(canonicalTarget)).toBe(false);
		expect(await candidateVerdict(projectDir, candidate.id)).toBe('revoked');
	});

	test('default lstatTarget: only ENOENT is "missing"; any other inspection failure is "error" (FB-210)', async () => {
		const probe = originalLstatTarget;
		// Genuinely absent => the one kind that authorizes idempotent success.
		expect(await probe(path.join(projectDir, 'does-not-exist.md'))).toEqual({
			kind: 'missing',
		});
		// Regular file / directory classify normally.
		const file = writeSkillFile(
			generatedPath(projectDir, 'probe-file'),
			'# x\n',
		);
		expect(await probe(file)).toEqual({ kind: 'file' });
		expect(await probe(path.dirname(file))).toEqual({ kind: 'other' });
		// A non-ENOENT failure (an invalid path argument rejects on every
		// platform with a code that is NOT ENOENT) must surface as 'error',
		// never be mistaken for an absent file.
		const bad = await probe(`${file}\0bad`);
		expect(bad.kind).toBe('error');
	});
});
