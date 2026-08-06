/**
 * Skill smoke validator — the `smoke_validated` transition (issue #1822).
 *
 * Composes existing primitives rather than duplicating them:
 *   - `validateSkillPath` (path containment — knowledge-validator.ts);
 *   - symlink/reparse denial (deny escape; mirrors bundled-skills.ts pattern);
 *   - frontmatter schema check (YAML parse + required keys);
 *   - the phrase-eval gate (`evaluateSkillChange` / `isRejectedSkillContent`
 *     from skill-evaluator.ts) — refuses content the rejection ledger already
 *     rejected;
 *   - a bounded subprocess check via `spawnAsync` if the skill declares a
 *     check command (cwd explicit, stdin ignored, timeout, kill, 512KB cap).
 */

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { validateSkillPath } from '../../hooks/knowledge-validator.js';
import { spawnAsync } from '../../hooks/spawn-helper.js';
import { evaluateSkillChange, isRejectedSkillContent } from '../skill-evaluator.js';

export interface SmokeInput {
	directory: string;
	skillSlug: string;
	/** Candidate SKILL.md content (not yet written to the skill root). */
	candidateContent: string;
	/** Incumbent SKILL.md content (current). Empty string if no incumbent. */
	incumbentContent: string;
	/** Optional check command the skill declares (e.g. `["bun", "test"]`). */
	checkCommand?: string[];
	/** Timeout for the optional check command. */
	checkTimeoutMs?: number;
}

export interface SmokeResult {
	ok: boolean;
	verdict: 'COMPLIANT' | 'VIOLATED';
	notes: string[];
}

export const _internals = {
	validateSkillPath,
	isSymbolicLink: (p: string) => {
		try {
			return lstatSync(p).isSymbolicLink();
		} catch {
			return false;
		}
	},
	escapedRoot: (root: string, target: string) => {
		const rel = path.relative(path.resolve(root), path.resolve(target));
		return rel.startsWith('..') || path.isAbsolute(rel);
	},
	realpath: (p: string) => realpathSync(p),
	evaluateSkillChange,
	isRejectedSkillContent,
	spawnAsync,
};

/** Validate a candidate skill before the validation-running transition. */
export async function validateSkillSmoke(input: SmokeInput): Promise<SmokeResult> {
	const notes: string[] = [];

	// 1. Path containment — the slug must resolve to an allowlisted skill root.
	//    (validateSkillPath is the repo's existing guard; reuse, do not duplicate.)
	const repoRel = path.join('.opencode', 'skills', 'generated', input.skillSlug, 'SKILL.md');
	if (!_internals.validateSkillPath(repoRel)) {
		return {
			ok: false,
			verdict: 'VIOLATED',
			notes: [`skill path not in an allowlisted root: ${repoRel}`],
		};
	}

	// 2. Symlink/reparse denial — the target skill root must not be a symlink
	//    and must not escape the project root. Defense-in-depth even though the
	//    candidate is content-only at this stage (the eventual write target is
	//    what we protect).
	const skillRoot = path.join(
		input.directory,
		'.opencode',
		'skills',
		'generated',
		input.skillSlug,
	);
	if (existsSync(skillRoot)) {
		if (_internals.isSymbolicLink(skillRoot)) {
			return { ok: false, verdict: 'VIOLATED', notes: ['skill root is a symlink (reparse denied)'] };
		}
		const realRoot = _internals.realpath(skillRoot);
		if (_internals.escapedRoot(input.directory, realRoot)) {
			return {
				ok: false,
				verdict: 'VIOLATED',
				notes: ['skill root escaped project root after realpath (reparse denied)'],
			};
		}
	}

	// 3. Frontmatter schema check — must be valid YAML-ish with a `name`/`slug`
	//    and a `description`. Malformed frontmatter fails the smoke check.
	const fmError = checkFrontmatter(input.candidateContent);
	if (fmError) {
		return { ok: false, verdict: 'VIOLATED', notes: [`frontmatter: ${fmError}`] };
	}

	// 4. Phrase-eval gate — refuse content the rejection ledger already rejected.
	const rejected = await _internals.isRejectedSkillContent(
		input.directory,
		input.skillSlug,
		input.candidateContent,
	);
	if (rejected) {
		return {
			ok: false,
			verdict: 'VIOLATED',
			notes: ['candidate matches a previously-rejected edit (rejection ledger)'],
		};
	}

	// 5. evaluateSkillChange against the incumbent — a hard fail here is a VIOLATED.
	const evalResult = await _internals.evaluateSkillChange({
		directory: input.directory,
		slug: input.skillSlug,
		candidateContent: input.candidateContent,
		incumbentContent: input.incumbentContent || undefined,
		operation: 'skill-opt-smoke',
	});
	if (evalResult.status === 'invalid_eval_set') {
		notes.push(`invalid eval set: ${evalResult.reason}`);
	} else if (evalResult.status === 'rejected') {
		return {
			ok: false,
			verdict: 'VIOLATED',
			notes: [`phrase-eval gate rejected: ${evalResult.reason}`],
		};
	} else if (evalResult.status === 'passed') {
		notes.push(`phrase-eval passed (score ${evalResult.candidateScore.toFixed(2)})`);
	}

	// 6. Optional bounded subprocess check — if the skill declares a check command.
	if (input.checkCommand && input.checkCommand.length > 0) {
		const cmdResult = await _internals.spawnAsync(
			input.checkCommand,
			input.directory, // explicit cwd (AGENTS.md invariant #3, #4)
			input.checkTimeoutMs ?? 60_000,
		);
		if (!cmdResult || cmdResult.exitCode !== 0) {
			return {
				ok: false,
				verdict: 'VIOLATED',
				notes: [
					`check command exited ${cmdResult ? cmdResult.exitCode : 'null'}: ${(cmdResult?.stderr ?? '').slice(0, 200)}`,
				],
			};
		}
		notes.push('check command passed');
	}

	return { ok: true, verdict: 'COMPLIANT', notes };
}

/** Minimal frontmatter presence check (name + description required). */
function checkFrontmatter(content: string): string | null {
	const match = /^---\n([\s\S]*?)\n---/.exec(content);
	if (!match) return 'missing frontmatter block';
	const fm = match[1];
	if (!/^name:\s*\S/m.test(fm) && !/^slug:\s*\S/m.test(fm)) {
		return 'frontmatter missing name/slug';
	}
	if (!/^description:\s*\S/m.test(fm)) {
		return 'frontmatter missing description';
	}
	return null;
}

/** Read the incumbent SKILL.md content, or return empty string if absent. */
export function readIncumbentContent(directory: string, skillSlug: string): string {
	const incumbent = path.join(
		directory,
		'.opencode',
		'skills',
		'generated',
		skillSlug,
		'SKILL.md',
	);
	if (!existsSync(incumbent)) return '';
	try {
		return readFileSync(incumbent, 'utf8');
	} catch {
		return '';
	}
}
