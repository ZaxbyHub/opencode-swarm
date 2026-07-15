/**
 * Skill auto-injection for subagent delegations.
 *
 * Extracted from the `tool.execute.before` hook in `src/index.ts` (issue #1770)
 * so the injection + usage-recording path is exercised by tests against the
 * REAL implementation rather than a parallel re-implementation.
 *
 * Two correctness fixes over the pre-extraction inline block:
 *
 *  1. Attribution — usage entries are now recorded with the **target subagent**
 *     as `agentName` and a real taskID (via `extractTaskIdFromPrompt`,
 *     falling back to the literal `'auto-injected'` when the prompt carries no
 *     task marker). Previously the inline block recorded the **architect**
 *     with the synthetic `taskID: 'injection'`, which (a) was inconsistent with
 *     the three other recording sites in `skill-propagation-gate.ts`, (b) broke
 *     the SKILL_COMPLIANCE round-trip join except by coincidence, and (c)
 *     inflated frequency / taskID-diversity scoring. The fallback is
 *     `'auto-injected'` rather than `'unknown'` so the compliance resolver's
 *     `resolvedTaskID !== 'unknown'` guard at `skill-propagation-gate.ts:1302`
 *     continues to fire and populate fallback skill paths.
 *
 *  2. Observability — a `skill_injection_decision` event is emitted to
 *     `.swarm/events.jsonl` for BOTH the qualified-injection and the
 *     `SKILLS: none` branches. Previously only the qualified branch produced a
 *     `console.warn`, and the `SKILLS: none` branch produced no durable signal,
 *     so a project whose skills all scored below the 0.5 threshold appeared
 *     indistinguishable from "the gate never ran." Usage entries are NOT written
 *     for the `SKILLS: none` branch: recording a phantom skillPath would corrupt
 *     per-skill scoring, and the absence of `skill-usage.jsonl` when no skill is
 *     injected is the correct semantic (there is no usage to record).
 */

import * as path from 'node:path';

import {
	extractSkillsFieldFromPrompt,
	extractTaskIdFromPrompt,
	parseDelegationArgs,
	writeWarnEvent,
} from './skill-propagation-gate.js';
import { readSkillMetadata } from './skill-scoring.js';
import { appendSkillUsageEntry } from './skill-usage-log.js';

/** A recommended skill as returned by `skillPropagationGateBefore`. */
export interface RecommendedSkill {
	skillPath: string;
	score: number;
	usageCount: number;
}

/** Options controlling console verbosity (mirrors the plugin `quiet` flag). */
export interface SkillInjectionOptions {
	/** When true, suppresses console.warn output (does not affect event emission). */
	quiet?: boolean;
}

/** Result of an injection attempt. */
export interface SkillInjectionResult {
	/** `true` if a `SKILLS:` (or `SKILLS_USED_BY_CODER:`) line was added to the prompt. */
	injected: boolean;
	/** The skills that were actually injected (empty for the `SKILLS: none` and skip paths). */
	injectedSkills: Array<{ skillPath: string; score: number }>;
}

/** Relevance-score threshold a recommended skill must meet to be injected. */
export const SKILL_INJECTION_THRESHOLD = 0.5;

/** Maximum number of skills injected into a single delegation prompt. */
export const SKILL_INJECTION_TOP_N = 5;

/**
 * Auto-inject a `SKILLS:` field into a delegation prompt when one is missing.
 *
 * Mutates `args.prompt` in place (preserving the pre-extraction hook contract)
 * and records one usage entry per injected skill to `.swarm/skill-usage.jsonl`.
 * Best-effort: recording/event failures are swallowed and never throw.
 *
 * @param directory           - Project root (`.swarm/` is created here).
 * @param args                - The Task tool args; `args.prompt` is mutated.
 * @param recommendedSkills   - From `skillPropagationGateBefore`. `undefined` / empty skips injection.
 * @param targetAgent         - The subagent being delegated to (parsed via `parseDelegationArgs`).
 *                              Used as the usage-entry `agentName` so the entry joins correctly
 *                              with later reviewer compliance verdicts.
 * @param sessionID           - The orchestrating session id.
 * @param options             - `{ quiet }` verbosity flag.
 * @returns `{ injected, injectedSkills }`.
 */
export function injectSkillsIntoDelegation(
	directory: string,
	args: Record<string, unknown>,
	recommendedSkills: ReadonlyArray<RecommendedSkill> | undefined,
	targetAgent: string,
	sessionID: string,
	options: SkillInjectionOptions = {},
): SkillInjectionResult {
	// No recommended skills → nothing to inject. This mirrors the pre-extraction
	// guard at src/index.ts:2104-2106 and is the primary "no-op" path.
	if (!recommendedSkills || recommendedSkills.length === 0) {
		return { injected: false, injectedSkills: [] };
	}

	const promptRaw = args.prompt;
	if (typeof promptRaw !== 'string') {
		return { injected: false, injectedSkills: [] };
	}

	// Parse the prompt to check for an existing SKILLS field. If the architect
	// hand-wrote one (or an explicit `SKILLS: none`), respect it and do not inject.
	const parsedDelegation = parseDelegationArgs(args);
	if (!parsedDelegation) {
		return { injected: false, injectedSkills: [] };
	}
	const existingSkills = parsedDelegation.skillsField.trim();
	if (existingSkills) {
		return { injected: false, injectedSkills: [] };
	}

	// Filter by relevance-score threshold.
	const qualified = recommendedSkills.filter(
		(s) => s.score >= SKILL_INJECTION_THRESHOLD,
	);

	if (qualified.length === 0) {
		// No skill above threshold — inject `SKILLS: none` and emit a decision
		// event so the cold-start outcome is auditable. We deliberately do NOT
		// record a usage entry: there is no skill usage to record, and a phantom
		// skillPath would corrupt per-skill scoring.
		args.prompt = `SKILLS: none\n\n${promptRaw}`;
		if (!options.quiet) {
			// biome-ignore lint/suspicious/noConsole: Skill propagation gate audit log — confirms when no skills qualified and SKILLS:none was injected; architect must see this to debug injection issues
			console.warn(
				'[skill-propagation-gate] No skills above threshold 0.5 — injected SKILLS: none',
			);
		}
		try {
			writeWarnEvent(directory, {
				type: 'skill_injection_decision',
				timestamp: new Date().toISOString(),
				decision: 'none',
				target_agent: targetAgent,
				sessionID,
				reason: 'no_skill_above_threshold',
				threshold: SKILL_INJECTION_THRESHOLD,
				considered: recommendedSkills.map((s) => ({
					skillPath: s.skillPath,
					score: s.score,
				})),
			});
		} catch {
			// Non-blocking: best-effort observability.
		}
		return { injected: true, injectedSkills: [] };
	}

	// Take top N by score from the qualified list.
	const topSkills = qualified.slice(0, SKILL_INJECTION_TOP_N);

	// Build the SKILLS: line with dynamic descriptions from SKILL.md frontmatter.
	const skillPaths = topSkills
		.map((s) => {
			const meta = readSkillMetadata(s.skillPath, directory);
			let desc = meta.description || '';
			if (!desc || desc === 'No description provided') {
				desc = path.basename(path.dirname(s.skillPath));
			}
			// Strip commas to prevent corruption of comma-delimited SKILLS: parsing.
			desc = desc.replace(/,/g, ';');
			return `file:${s.skillPath} (-- ${desc})`;
		})
		.join(', ');

	const skillsLine = `SKILLS: ${skillPaths}`;
	const newPrompt = `${skillsLine}\n\n${promptRaw}`;
	args.prompt = newPrompt;

	// Resolve a stable taskID for attribution. Prefer a real marker extracted
	// from the prompt; fall back to 'auto-injected' (NOT 'unknown') so the
	// compliance resolver's `resolvedTaskID !== 'unknown'` guard continues to
	// fire and populate fallback skill paths for reviewer verdicts.
	const extractedTaskId = extractTaskIdFromPrompt(promptRaw);
	const taskID =
		extractedTaskId !== 'unknown' ? extractedTaskId : 'auto-injected';

	// Log the injection (mirror pre-extraction console output).
	if (!options.quiet) {
		const skillNames = topSkills
			.map(
				(s) => `${path.basename(s.skillPath)} (score: ${s.score.toFixed(2)})`,
			)
			.join(', ');
		// biome-ignore lint/suspicious/noConsole: Skill propagation gate audit log — confirms which skills were injected for architect visibility
		console.warn(`[skill-propagation-gate] Injected skills: ${skillNames}`);
	}

	// Record each injected skill to skill-usage.jsonl. The `agentName` is the
	// TARGET subagent (who will actually use the skill), matching sites 4a/4c
	// in skill-propagation-gate.ts and enabling the reviewer compliance verdict
	// to join back to this delegation via the resolved taskID.
	for (const skill of topSkills) {
		try {
			appendSkillUsageEntry(directory, {
				skillPath: skill.skillPath,
				agentName: targetAgent,
				taskID,
				timestamp: new Date().toISOString(),
				complianceVerdict: 'not_checked',
				sessionID,
			});
		} catch {
			// Non-blocking: best-effort audit logging.
		}
	}

	// Emit a decision event mirroring the `SKILLS: none` branch, so the
	// qualified-injection outcome is equally auditable.
	try {
		writeWarnEvent(directory, {
			type: 'skill_injection_decision',
			timestamp: new Date().toISOString(),
			decision: 'injected',
			target_agent: targetAgent,
			sessionID,
			taskID,
			injected: topSkills.map((s) => ({
				skillPath: s.skillPath,
				score: s.score,
			})),
		});
	} catch {
		// Non-blocking: best-effort observability.
	}

	// SKILLS_USED_BY_CODER forwarding for reviewer delegations. When
	// auto-injecting skills and the target is a reviewer, append
	// SKILLS_USED_BY_CODER so the compliance feedback loop can track injected
	// skills back to the scoring system.
	if (targetAgent.toLowerCase().includes('reviewer')) {
		const usedByCoderLine = `SKILLS_USED_BY_CODER: ${topSkills
			.map((s) => `file:${s.skillPath}`)
			.join(', ')}`;
		args.prompt = `${newPrompt}\n${usedByCoderLine}`;
	}

	return {
		injected: true,
		injectedSkills: topSkills.map((s) => ({
			skillPath: s.skillPath,
			score: s.score,
		})),
	};
}

/**
 * Extract the SKILLS field from a prompt. Re-exported for tests that need to
 * inspect the post-injection prompt without re-parsing manually.
 */
export { extractSkillsFieldFromPrompt };
