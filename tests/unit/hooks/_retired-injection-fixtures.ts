/**
 * Shared fixtures for the retired-skill injection suites (issue #2966).
 * Underscore-prefixed: not a test file (FR-006 500-line split, PR #3506
 * feedback round).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateSkillReference } from '../../../src/hooks/skill-propagation-gate';

/**
 * The 19 retired generated-skill slugs from the #2966 reconciliation. The
 * 20th deleted directory, `ci-failure-batching`, was an ACTIVE bundled-slug
 * collision (no marker) — it is covered by the tree census, not by the
 * retired-marker validator arms (a reference to it now fails on file
 * non-existence, not retirement).
 */
export const RETIRED_SLUGS = [
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

export const MAPPED_SLUGS = [
	'gate-attribution',
	'merge-queue-readiness',
	'skill-edit-validation',
	'worktree-retry-cleanup',
	'pr-review-fix',
	'pr-readiness',
] as const;

/** The 17 active generated forks retained by the reconciliation. */
export const RETAINED_SLUGS = [
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

export function writeSkillDir(
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

export function delegationWith(reference: string) {
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

export const GATE_CONFIG = { enabled: false, enforce: false } as const;

export function validate(root: string, reference: string) {
	return validateSkillReference(
		root,
		reference,
		{},
		{
			enforceAudience: false,
		},
	);
}
