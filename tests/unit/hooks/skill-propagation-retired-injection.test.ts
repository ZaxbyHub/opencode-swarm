/**
 * Retired-skill injectability tests (issue #2966).
 *
 * `validateSkillReference` previously checked path shape, containment,
 * existence, frontmatter, and audience — but not the retirement lifecycle
 * markers that discovery and routing already respected, so an explicit
 * `SKILLS: file:` reference to a retired generated skill validated and the
 * delegation proceeded carrying stale (sometimes inverted) instructions.
 *
 * This suite pins: the validator arms (retired/stale/unmapped/control,
 * precedence, sanitization, symlink policy), the flipped end-to-end
 * reproduction through `validateExplicitSkillReferencesBefore` over ALL 19
 * historical retired slugs, the consumer-safe replacement map, and the
 * reconciled repository tree census.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals as gate,
	RETIRED_SKILL_REPLACEMENTS,
	validateExplicitSkillReferencesBefore,
	validateSkillReference,
} from '../../../src/hooks/skill-propagation-gate';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const realGate = { ...gate };

/** The 19 retired generated-skill slugs from the #2966 reconciliation. */
const RETIRED_SLUGS = [
	'add-path-type-assertions-or-realpath-resolve-calls-in-path-joini',
	'gate-attribution',
	'git-revert-safety',
	'grep-for-mock-module-across-the-entire-test-file-and-confirm-eve',
	'merge-queue-readiness',
	'mock-module',
	'mock-to-internals-migration',
	'opt-in-tool-registration',
	'phase-complete',
	'pr-readiness',
	'pr-review-fix',
	'propagation-test',
	'run-tests-on-the-unmodified-codebase-before-starting-to-establis',
	'safe-extraction',
	'safe-rename',
	'skill-edit-validation',
	'spread-real-module-exports-as-base-of-every-mock-module-return-o',
	'widen-return-type',
	'worktree-retry-cleanup',
] as const;

const MAPPED_SLUGS = [
	'gate-attribution',
	'merge-queue-readiness',
	'skill-edit-validation',
	'worktree-retry-cleanup',
	'pr-review-fix',
] as const;

/** The 17 active generated forks retained by the reconciliation. */
const RETAINED_SLUGS = [
	'bundle-safety',
	'check-skill-provenance-stamps-before-archiving-knowledge-entries',
	'confirm-failures-are-causally-linked-to-the-task-before-reportin',
	'ensure-all-tests-pass-after-code-changes',
	'guardrail-patterns',
	'include-test-files-that-assert-on-behavior-being-changed-in-decl',
	'isolate-the-specific-failure-mode-before-proposing-a-fix',
	'restore-internals-seams-in-finally-blocks-after-each-test',
	'run-affected-test-file-in-isolation-and-in-co-run-with-its-test-',
	'run-affected-test-suite-end-to-end-after-multi-file-signature-ch',
	'run-failing-tests-immediately-after-test-gate-failure',
	'run-relevant-tests-after-adding-error-handling-wrappers',
	'run-relevant-tests-after-logic-changes',
	'run-test-suite-after-registration-changes',
	'update-or-delete-tests-that-assert-intentionally-removed-behavio',
	'use-internals-di-seam-pattern-for-test-injectable-functions',
	'verify-skill-mirror-pairs-exist-in-both-opencode-skills-and-clau',
] as const;

let scratch: string;

function writeSkillDir(
	root: string,
	relativeDir: string,
	marker?: { kind: 'retired' | 'stale'; payload?: string },
): string {
	const dir = path.join(root, relativeDir);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'SKILL.md'), '# synthetic skill\n', 'utf-8');
	if (marker) {
		fs.writeFileSync(
			path.join(dir, `${marker.kind}.marker`),
			marker.payload ?? '{}',
			'utf-8',
		);
	}
	return dir;
}

function delegationWith(reference: string) {
	return {
		tool: 'Task',
		agent: 'architect',
		sessionID: 'retired-injection-session',
		args: {
			subagent_type: 'coder',
			prompt: ['TASK: retired-injection', `SKILLS: ${reference}`].join('\n'),
		},
	};
}

const CONFIG = { enabled: false, enforce: false } as const;

function validate(root: string, reference: string) {
	return validateSkillReference(
		root,
		reference,
		{},
		{
			enforceAudience: false,
		},
	);
}

beforeEach(() => {
	scratch = canonicalMkdtemp('retired-injection-');
});

afterEach(() => {
	Object.assign(gate, realGate);
	try {
		fs.rmSync(scratch, { recursive: true, force: true });
	} catch {
		/* best-effort cleanup */
	}
});

describe('validator arms', () => {
	test('retired marker, mapped slug: invalid, reason names the replacement', () => {
		writeSkillDir(scratch, '.opencode/skills/generated/gate-attribution', {
			kind: 'retired',
			payload: JSON.stringify({
				retiredAt: '2026-07-02T00:00:00.000Z',
				reason: 'superseded by bundled canon',
			}),
		});
		const result = validate(
			scratch,
			'file:.opencode/skills/generated/gate-attribution/SKILL.md',
		);
		expect(result.valid).toBe(false);
		expect(result.reason).toContain('retired');
		expect(result.reason).toContain('gate-attribution');
		expect(result.reason).toContain('superseded by bundled canon');
		expect(result.reason).toContain(
			'file:.swarm/bundled-skills/gate-attribution/SKILL.md',
		);
	});

	test('stale marker: invalid with the stale state', () => {
		writeSkillDir(scratch, '.opencode/skills/generated/some-stale-skill', {
			kind: 'stale',
			payload: 'source knowledge archived',
		});
		const result = validate(
			scratch,
			'file:.opencode/skills/generated/some-stale-skill/SKILL.md',
		);
		expect(result.valid).toBe(false);
		expect(result.reason).toContain('stale');
		expect(result.reason).toContain('source knowledge archived');
	});

	test('unmapped retired slug: invalid with the actionable generic instruction', () => {
		writeSkillDir(scratch, '.opencode/skills/generated/never-mapped', {
			kind: 'retired',
			payload: JSON.stringify({ retiredAt: '2026-07-02T00:00:00.000Z' }),
		});
		const result = validate(
			scratch,
			'file:.opencode/skills/generated/never-mapped/SKILL.md',
		);
		expect(result.valid).toBe(false);
		expect(result.reason).toContain('skill_generate');
		expect(result.reason).toContain('skill_inspect');
	});

	test('no-marker control: valid (no regression on live skills)', () => {
		writeSkillDir(scratch, '.opencode/skills/generated/live-skill');
		const result = validate(
			scratch,
			'file:.opencode/skills/generated/live-skill/SKILL.md',
		);
		expect(result.valid).toBe(true);
	});

	test('both markers in one directory: retired precedence', () => {
		const dir = writeSkillDir(
			scratch,
			'.opencode/skills/generated/both-markers',
			{
				kind: 'stale',
				payload: 'stale text',
			},
		);
		fs.writeFileSync(
			path.join(dir, 'retired.marker'),
			JSON.stringify({ retiredAt: '2026-07-02T00:00:00.000Z' }),
			'utf-8',
		);
		const result = validate(
			scratch,
			'file:.opencode/skills/generated/both-markers/SKILL.md',
		);
		expect(result.valid).toBe(false);
		expect(result.reason).toContain('retired');
		expect(result.reason).not.toContain('stale text');
	});

	test('marker payload with control characters and oversize is sanitized and bounded', () => {
		writeSkillDir(scratch, '.opencode/skills/generated/hostile-marker', {
			kind: 'retired',
			payload: JSON.stringify({
				retiredAt: '2026-07-02T00:00:00.000Z',
				reason: `evil${'\n'.repeat(3)}multi\tline\r\n${'x'.repeat(400)}`,
			}),
		});
		const result = validate(
			scratch,
			'file:.opencode/skills/generated/hostile-marker/SKILL.md',
		);
		expect(result.valid).toBe(false);
		expect(result.reason).not.toMatch(/\n|\r|\t/);
		expect(result.reason?.length ?? 0).toBeLessThan(600);
	});

	test('unreadable marker payload still fails closed with the generic message', () => {
		const dir = writeSkillDir(scratch, '.opencode/skills/generated/unreadable');
		fs.writeFileSync(path.join(dir, 'retired.marker'), 'not-json{', 'utf-8');
		// readFileSync is seam'd to THROW for this one file only
		const realRead = gate.readFileSync;
		gate.readFileSync = ((p: unknown, ...rest: unknown[]) => {
			if (typeof p === 'string' && p.endsWith('retired.marker')) {
				throw new Error('EACCES');
			}
			return (realRead as (a: unknown, ...b: unknown[]) => string)(p, ...rest);
		}) as typeof fs.readFileSync;
		const result = validate(
			scratch,
			'file:.opencode/skills/generated/unreadable/SKILL.md',
		);
		expect(result.valid).toBe(false);
		expect(result.reason).toContain('retired');
	});

	test('alias whose TARGET directory is retired is blocked (realpath policy)', () => {
		const target = writeSkillDir(
			scratch,
			'.opencode/skills/generated/retired-real',
			{
				kind: 'retired',
				payload: JSON.stringify({
					retiredAt: '2026-07-02T00:00:00.000Z',
					reason: 'retired via junction target',
				}),
			},
		);
		// A directory junction needs no symlink privilege on Windows (and is a
		// plain symlink on POSIX), so this arm EXECUTES on every CI platform:
		// the lexical directory is the alias, the realpath directory is the
		// retired target, and the realpath-side marker must block.
		const aliasDir = path.join(scratch, '.opencode/skills/alias-junction');
		fs.symlinkSync(target, aliasDir, 'junction');
		const result = validate(
			scratch,
			'file:.opencode/skills/alias-junction/SKILL.md',
		);
		expect(result.valid).toBe(false);
		// The refusal names the LEXICAL slug (what the architect referenced)…
		expect(result.reason).toContain('alias-junction');
		// …classifies it as retired, and carries the target-side marker detail.
		expect(result.reason).toContain('retired');
		expect(result.reason).toContain('retired via junction target');
	});

	test('marker on the LEXICAL directory blocks even when the target differs', () => {
		const target = writeSkillDir(
			scratch,
			'.opencode/skills/generated/live-target',
		);
		const aliasDir = path.join(scratch, '.opencode/skills/lexically-retired');
		fs.mkdirSync(aliasDir, { recursive: true });
		fs.writeFileSync(path.join(aliasDir, 'retired.marker'), '{}', 'utf-8');
		try {
			fs.symlinkSync(
				path.join(target, 'SKILL.md'),
				path.join(aliasDir, 'SKILL.md'),
				'file',
			);
		} catch {
			return; // no symlink privilege on this host
		}
		const result = validate(
			scratch,
			'file:.opencode/skills/lexically-retired/SKILL.md',
		);
		expect(result.valid).toBe(false);
		// The refusal names the LEXICAL slug whose directory carries the marker
		// (the file-symlink target itself is a live directory).
		expect(result.reason).toContain('lexically-retired');
		expect(result.reason).toContain('retired');
	});
});

describe('end-to-end explicit gate (the flipped reproduction)', () => {
	test('all 19 historical retired slugs are blocked with guidance', async () => {
		for (const slug of RETIRED_SLUGS) {
			writeSkillDir(scratch, `.opencode/skills/generated/${slug}`, {
				kind: 'retired',
				payload: JSON.stringify({
					retiredAt: '2026-07-02T00:00:00.000Z',
				}),
			});
		}
		for (const slug of RETIRED_SLUGS) {
			const result = await validateExplicitSkillReferencesBefore(
				scratch,
				delegationWith(`file:.opencode/skills/generated/${slug}/SKILL.md`),
				CONFIG,
			);
			expect(result.blocked, `${slug}: not blocked`).toBe(true);
			expect(result.reason, `${slug}: reason missing`).toContain(slug);
			const replacement = RETIRED_SKILL_REPLACEMENTS[slug];
			if (replacement !== undefined) {
				expect(result.reason, `${slug}: replacement missing`).toContain(
					replacement,
				);
			} else {
				expect(result.reason, `${slug}: generic guidance missing`).toContain(
					'skill_generate',
				);
			}
		}
	});

	test('live control: an explicit reference to a live skill is NOT blocked', async () => {
		writeSkillDir(scratch, '.opencode/skills/generated/live-skill');
		const result = await validateExplicitSkillReferencesBefore(
			scratch,
			delegationWith('file:.opencode/skills/generated/live-skill/SKILL.md'),
			CONFIG,
		);
		expect(result.blocked).toBe(false);
	});
});

describe('replacement map census', () => {
	test('covers exactly the five claimed slugs with consumer-stable bundled references', () => {
		expect(Object.keys(RETIRED_SKILL_REPLACEMENTS).sort()).toEqual(
			[...MAPPED_SLUGS].sort(),
		);
		for (const slug of MAPPED_SLUGS) {
			const value = RETIRED_SKILL_REPLACEMENTS[slug];
			expect(value.startsWith('file:.swarm/bundled-skills/')).toBe(true);
			expect(value.endsWith('/SKILL.md')).toBe(true);
			// non-self: never points back at the retired tree
			expect(value.includes('/generated/')).toBe(false);
		}
		expect(RETIRED_SKILL_REPLACEMENTS['pr-review-fix']).toBe(
			'file:.swarm/bundled-skills/swarm-pr-feedback/SKILL.md',
		);
	});

	test('every replacement target resolves in a consumer-shaped tree', () => {
		// Consumer projects have NO .opencode natives — only .swarm/bundled-skills.
		for (const slug of MAPPED_SLUGS) {
			const reference = RETIRED_SKILL_REPLACEMENTS[slug];
			const relative = reference.replace(/^file:/, '');
			writeSkillDir(scratch, path.dirname(relative));
			const result = validate(scratch, reference);
			expect(result.valid, `${slug}: replacement does not resolve`).toBe(true);
		}
	});
});

describe('repository tree census (reconciliation pinned)', () => {
	// Repo-root resolution via import.meta.dir (cwd-independent read-only
	// census of the checkout's skill trees; FR-011 safe).
	const repoRoot = path.resolve(import.meta.dir, '../../..');
	const generatedRoot = path.join(repoRoot, '.opencode', 'skills', 'generated');

	test('zero retired/stale markers under .opencode/skills/generated', () => {
		let markerCount = 0;
		for (const slug of fs.readdirSync(generatedRoot)) {
			const dir = path.join(generatedRoot, slug);
			if (
				fs.existsSync(path.join(dir, 'retired.marker')) ||
				fs.existsSync(path.join(dir, 'stale.marker'))
			) {
				markerCount += 1;
			}
		}
		expect(markerCount).toBe(0);
	});

	test('the 20 reconciled directories are gone; the 17 active forks remain', () => {
		for (const slug of RETIRED_SLUGS) {
			expect(
				fs.existsSync(path.join(generatedRoot, slug)),
				`${slug}: still present`,
			).toBe(false);
		}
		expect(fs.existsSync(path.join(generatedRoot, 'ci-failure-batching'))).toBe(
			false,
		);
		for (const slug of RETAINED_SLUGS) {
			expect(
				fs.existsSync(path.join(generatedRoot, slug)),
				`${slug}: wrongly removed`,
			).toBe(true);
		}
	});

	test('no SKILL.md outside generated/ references the deleted retired forks', () => {
		const roots = ['.agents/skills', '.opencode/skills', '.claude/skills'].map(
			(rel) => path.join(repoRoot, rel),
		);
		const offenders: string[] = [];
		const walk = (dir: string): void => {
			if (!fs.existsSync(dir)) return;
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					if (full === generatedRoot) continue; // self-references excluded
					walk(full);
					continue;
				}
				if (entry.name !== 'SKILL.md') continue;
				const content = fs.readFileSync(full, 'utf-8');
				if (
					content.includes('generated/mock-to-internals-migration') ||
					content.includes('generated/safe-extraction')
				) {
					offenders.push(path.relative(repoRoot, full));
				}
			}
		};
		for (const root of roots) walk(root);
		expect(offenders).toEqual([]);
	});

	test('the three test-file-split copies remain byte-identical (mirror contract)', () => {
		const read = (tree: string) =>
			fs.readFileSync(
				path.join(repoRoot, tree, 'skills/test-file-split/SKILL.md'),
			);
		const opencode = read('.opencode');
		expect(read('.claude').equals(opencode)).toBe(true);
		expect(read('.agents').equals(opencode)).toBe(true);
	});
});
