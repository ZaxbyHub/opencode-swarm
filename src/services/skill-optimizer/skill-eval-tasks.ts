/**
 * Skill-eval task builder (issue #1822 — D1, critic C1/I4).
 *
 * The substrate's `builtin` scorer parses model output as `{caught:boolean}`
 * JSON and ignores `argv` (`runner.ts:144-162`); only `kind:'project'` scorers
 * consume `argv` (`runner.ts:175-228`). So the optimizer's skill-eval tasks
 * use `kind:'project'` scorers that invoke the SHARED `scoreSkillPhrases`
 * function (factored out of skill-evaluator.ts) via a small wrapper script.
 *
 * Rather than ship static fixture manifests with pre-computed `contentHash`
 * values (fragile — any edit invalidates the hash), this module BUILDS valid
 * `EvaluationTaskV1` objects at runtime and materializes their fixture files
 * into a fresh `inputRoot`. The content hash is computed from the materialized
 * files, guaranteeing consistency.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { EvaluationTaskV1 } from '../../evaluation/contracts.js';
import { computeTaskContentHash } from '../../evaluation/hashing.js';

/** A skill-eval case expressed as required/forbidden phrases (the gate model). */
export interface SkillEvalTaskSpec {
	id: string;
	category: string;
	protected?: boolean;
	instruction: string;
	requiredPhrases: string[];
	forbiddenPhrases: string[];
	/** Environment fixture body the candidate is evaluated against. */
	environmentBody: string;
}

/**
 * Default skill-eval task set — a minimal, curated set of phrase-based checks
 * a generated/optimized SKILL.md should satisfy. These are intentionally
 * generic (they check that a skill declares its trigger, required actions, and
 * avoids forbidden shortcuts) so they apply across skill slugs. Project-specific
 * eval cases live under `.swarm/skills/evals/<slug>/` (the existing gate).
 */
export const DEFAULT_SKILL_EVAL_TASKS: readonly SkillEvalTaskSpec[] = [
	{
		id: 'skill-eval-trigger-clarity',
		category: 'clarity',
		protected: false,
		instruction:
			'Read the candidate SKILL.md and confirm it declares a clear trigger condition. Return the trigger verbatim.',
		requiredPhrases: ['trigger', 'when'],
		forbiddenPhrases: ['maybe', 'sometimes'],
		environmentBody:
			'## Trigger\n\nWhen the agent is about to delegate a coding task.',
	},
	{
		id: 'skill-eval-required-actions',
		category: 'completeness',
		protected: true,
		instruction:
			'Read the candidate SKILL.md and confirm it lists the required actions an agent must take. Return them verbatim.',
		requiredPhrases: ['required', 'must'],
		forbiddenPhrases: ['shortcut', 'skip'],
		environmentBody:
			'## Required Procedure\n\n1. Confirm scope. 2. Delegate. 3. Verify.',
	},
	{
		id: 'skill-eval-reviewer-checks',
		category: 'safety',
		protected: true,
		instruction:
			'Read the candidate SKILL.md and confirm it specifies reviewer checks. Return them verbatim.',
		requiredPhrases: ['reviewer', 'check'],
		forbiddenPhrases: ['trust', 'assume'],
		environmentBody: '## Reviewer Checks\n\n- Scope matches. - Tests pass.',
	},
];

/**
 * Materialize a set of skill-eval task specs into a fresh `inputRoot` and
 * return valid `EvaluationTaskV1[]` (with computed contentHashes). The scorer
 * points at the bundled `score-skill-eval.cjs` wrapper, which reads the
 * candidate content + phrase spec via the `SWARM_EVAL_*` env / artifact dir.
 */
export function buildSkillEvalTasks(args: {
	inputRoot: string;
	tasks?: readonly SkillEvalTaskSpec[];
	/** Repo-relative path to the scorer wrapper (resolved against inputRoot). */
	scorerRelPath: string;
}): EvaluationTaskV1[] {
	const tasks = args.tasks ?? DEFAULT_SKILL_EVAL_TASKS;
	const result: EvaluationTaskV1[] = [];
	for (const spec of tasks) {
		const taskDir = path.join(args.inputRoot, 'skill-eval', spec.id);
		if (!existsSync(taskDir)) mkdirSync(taskDir, { recursive: true });

		// Instruction file.
		const instructionPath = path.join('skill-eval', spec.id, 'instruction.md');
		writeFileSync(
			path.join(args.inputRoot, instructionPath),
			`${spec.instruction}\n`,
			'utf8',
		);

		// Environment fixture.
		const envRelPath = path.join('skill-eval', spec.id, 'environment.md');
		writeFileSync(
			path.join(args.inputRoot, envRelPath),
			spec.environmentBody,
			'utf8',
		);

		// Phrase spec (read by the scorer wrapper).
		const phraseSpecPath = path.join('skill-eval', spec.id, 'phrase-spec.json');
		writeFileSync(
			path.join(args.inputRoot, phraseSpecPath),
			JSON.stringify({
				required_phrases: spec.requiredPhrases,
				forbidden_phrases: spec.forbiddenPhrases,
			}),
			'utf8',
		);

		const task: EvaluationTaskV1 = {
			v: 1,
			id: spec.id,
			source: 'curated',
			split: 'test',
			category: spec.category,
			protected: spec.protected ?? false,
			instructionPath,
			environment: { kind: 'fixture', path: envRelPath },
			scorer: {
				kind: 'project',
				argv: [args.scorerRelPath, phraseSpecPath],
				timeoutMs: 15_000,
				scoreRange: [0, 1],
			},
			provenance: {
				origin: 'opencode-swarm skill-opt default skill-eval set (issue #1822)',
				license: 'MIT',
				collectedAt: '2026-07-13T00:00:00Z',
				review: {
					reviewer: 'opencode-swarm team',
					reviewedAt: '2026-07-13T00:00:00Z',
					instruction: true,
					fixture: true,
					scorer: true,
					secretsPrivacy: true,
					license: true,
					split: true,
				},
			},
			contentHash: '',
		};
		// Compute the canonical content hash from the task object.
		task.contentHash = computeTaskContentHash(task);
		result.push(task);
	}
	return result;
}
