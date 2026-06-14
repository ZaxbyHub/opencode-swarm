/**
 * Skill revision service.
 *
 * When a skill's violation rate crosses a soft threshold (>15% but ≤30%),
 * produces a revised version by feeding violation contexts into a bounded
 * LLM rewrite of the violated sections. Reuses the skill_improver.max_calls_per_day
 * quota budget but is capped to max 3 LLM calls per curator phase to avoid
 * starving manual skill-improve runs.
 *
 * Falls back to deterministic revision (append revision notes) when no LLM
 * delegate is available or quota is exhausted.
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import type { SkillImproverLLMDelegate } from '../hooks/skill-improver-llm-factory.js';
import { warn } from '../utils/logger.js';
import type { SkillChangelogEntry } from './skill-changelog.js';
import { appendSkillChangelog } from './skill-changelog.js';
import {
	appendRejectedSkillEdit,
	evaluateSkillChange,
} from './skill-evaluator.js';
import type { QuotaWindow } from './skill-improver-quota.js';
import { releaseQuota, reserveQuota } from './skill-improver-quota.js';

export const REVISION_VIOLATION_THRESHOLD = 0.15;
export const MAX_REVISION_CALLS_PER_PHASE = 3;

const DEFAULT_MAX_CALLS = 10;

export interface ViolationContext {
	taskId: string;
	agent: string;
	verdict: string;
	reviewerNotes?: string;
	timestamp: string;
}

export interface SkillRevisionResult {
	revised: boolean;
	reason: string;
	newVersion?: number;
	quotaConsumed: boolean;
}

export interface ReviseSkillParams {
	directory: string;
	slug: string;
	skillPath: string;
	violationContexts: ViolationContext[];
	currentContent: string;
	currentVersion: number;
	maxCalls?: number;
	quotaWindow?: QuotaWindow;
	delegate?: SkillImproverLLMDelegate;
	now?: Date;
}

export async function getSkillVersion(skillPath: string): Promise<number> {
	try {
		const content = await readFile(skillPath, 'utf-8');
		const match = content.match(/^version:\s*(\d+)\s*$/m);
		return match ? parseInt(match[1], 10) : 1;
	} catch {
		return 1;
	}
}

export function buildDeterministicRevision(
	currentContent: string,
	currentVersion: number,
	violationContexts: ViolationContext[],
): string {
	const nextVersion = currentVersion + 1;
	const isoDate = new Date().toISOString().slice(0, 10);

	const violationLines = violationContexts
		.map((v) => `- ${v.agent} (${v.taskId}): ${v.reviewerNotes ?? v.verdict}`)
		.join('\n');

	const revisionSection = [
		'## Revision Notes',
		'',
		`### Version ${nextVersion} (${isoDate})`,
		'',
		`Revised due to ${violationContexts.length} violation(s):`,
		violationLines,
		'',
		'Review the Required Procedure and Forbidden Shortcuts sections above for alignment with these violation patterns.',
		'',
	].join('\n');

	let result = currentContent;

	// Update or add version in frontmatter
	if (/^version:\s*\d+\s*$/m.test(result)) {
		result = result.replace(/^version:\s*\d+\s*$/m, `version: ${nextVersion}`);
	} else if (/^confidence:\s*.+$/m.test(result)) {
		result = result.replace(
			/^(confidence:\s*.+)$/m,
			`$1\nversion: ${nextVersion}`,
		);
	} else {
		// Insert version after the opening frontmatter fence as a last resort
		result = result.replace(/^(---\s*\n)/, `$1version: ${nextVersion}\n`);
	}

	// Remove any existing Revision Notes section (from prior revisions)
	const revisionNotesPattern =
		/## Revision Notes\n[\s\S]*?(?=\n## Source Knowledge IDs|$)/;
	if (revisionNotesPattern.test(result)) {
		result = result.replace(revisionNotesPattern, '');
	}

	// Insert the new Revision Notes section before Source Knowledge IDs
	const sourceKnowledgeIdx = result.indexOf('## Source Knowledge IDs');
	if (sourceKnowledgeIdx !== -1) {
		result =
			result.slice(0, sourceKnowledgeIdx) +
			revisionSection +
			'\n' +
			result.slice(sourceKnowledgeIdx);
	} else {
		// Append at end if no Source Knowledge IDs section exists
		result = `${result.trimEnd()}\n\n${revisionSection}`;
	}

	return result;
}

function buildLLMPrompt(
	currentContent: string,
	currentVersion: number,
	violationContexts: ViolationContext[],
): { systemPrompt: string; userPrompt: string } {
	const violationLines = violationContexts
		.map(
			(v) =>
				`- Task ${v.taskId} (${v.agent}): ${v.verdict}. Notes: ${v.reviewerNotes ?? '(none)'}`,
		)
		.join('\n');

	const systemPrompt = [
		`You are revising a generated skill document. The skill has been violated in ${violationContexts.length} recent tasks.`,
		'',
		'Current skill content:',
		'---',
		currentContent,
		'---',
		'',
		'Violation contexts (what agents did instead of following the skill):',
		violationLines,
	].join('\n');

	const userPrompt = [
		'Instructions:',
		'- Revise ONLY the sections that were violated',
		'- Preserve the exact frontmatter format (--- fenced YAML)',
		'- Preserve all sections: Trigger, Required Procedure, Forbidden Shortcuts, Delegation Template, Reviewer Checks, Source Knowledge IDs',
		`- Update the version field in frontmatter to ${currentVersion + 1}`,
		'- Make the violated rules clearer, more specific, or add missing edge cases',
		'- Do NOT remove any source knowledge IDs',
		'- Do NOT change the name or description in frontmatter',
		'- Return ONLY the complete revised SKILL.md content, nothing else',
	].join('\n');

	return { systemPrompt, userPrompt };
}

function validateLLMOutput(output: string): boolean {
	const trimmed = output.trim();
	if (!trimmed.startsWith('---')) return false;
	const closingIdx = trimmed.indexOf('---', 3);
	if (closingIdx === -1) return false;
	if (!trimmed.includes('## Source Knowledge IDs')) return false;
	if (!trimmed.includes('## Required Procedure')) return false;
	if (!trimmed.includes('## Trigger')) return false;
	if (!trimmed.includes('## Forbidden Shortcuts')) return false;
	return true;
}

async function validateRevisionCandidate(
	params: ReviseSkillParams,
	candidateContent: string,
	operation: string,
): Promise<{ passed: true } | { passed: false; reason: string }> {
	const evaluation = await evaluateSkillChange({
		directory: params.directory,
		slug: params.slug,
		candidateContent,
		incumbentContent: params.currentContent,
		operation,
	});
	if (evaluation.passed) return { passed: true };
	await appendRejectedSkillEdit(
		{
			directory: params.directory,
			slug: params.slug,
			candidateContent,
			incumbentContent: params.currentContent,
			operation,
		},
		evaluation,
	);
	return {
		passed: false,
		reason: `validation_failed: ${evaluation.reason}`,
	};
}

export async function reviseSkill(
	params: ReviseSkillParams,
): Promise<SkillRevisionResult> {
	if (params.violationContexts.length === 0) {
		return { revised: false, reason: 'no_violations', quotaConsumed: false };
	}

	if (!params.delegate) {
		try {
			const revised = _internals.buildDeterministicRevision(
				params.currentContent,
				params.currentVersion,
				params.violationContexts,
			);
			const validation = await validateRevisionCandidate(
				params,
				revised,
				'skill_reviser:deterministic',
			);
			if (!validation.passed) {
				return {
					revised: false,
					reason: validation.reason,
					quotaConsumed: false,
				};
			}
			const tmpPath = `${params.skillPath}.tmp-${process.pid}-${Date.now()}`;
			await writeFile(tmpPath, revised, 'utf-8');
			await rename(tmpPath, params.skillPath);

			const newVersion = params.currentVersion + 1;
			const entry: SkillChangelogEntry = {
				version: newVersion,
				timestamp: (params.now ?? new Date()).toISOString(),
				action: 'revised',
				reason: 'deterministic_revision',
				triggeringVerdicts: params.violationContexts.map((v) => ({
					taskId: v.taskId,
					verdict: v.verdict,
					agent: v.agent,
				})),
			};
			try {
				await appendSkillChangelog(params.directory, params.slug, entry);
			} catch (changelogErr) {
				warn(
					`[skill-reviser] changelog append failed (non-fatal) for ${params.slug}: ${
						changelogErr instanceof Error
							? changelogErr.message
							: String(changelogErr)
					}`,
				);
			}

			return {
				revised: true,
				reason: 'deterministic_revision',
				newVersion,
				quotaConsumed: false,
			};
		} catch (err) {
			warn(
				`[skill-reviser] deterministic revision failed for ${params.slug}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			return {
				revised: false,
				reason: 'deterministic_revision_failed',
				quotaConsumed: false,
			};
		}
	}

	// LLM-based revision path
	const quotaOpts = {
		maxCalls: params.maxCalls ?? DEFAULT_MAX_CALLS,
		window: params.quotaWindow ?? ('utc' as const),
		now: params.now,
		nCalls: 1,
	};

	let quotaReserved = false;
	let networkStarted = false;

	try {
		const quotaResult = await reserveQuota(params.directory, quotaOpts);
		if (!quotaResult.allowed) {
			return {
				revised: false,
				reason: 'quota_exhausted',
				quotaConsumed: false,
			};
		}
		quotaReserved = true;

		const { systemPrompt, userPrompt } = buildLLMPrompt(
			params.currentContent,
			params.currentVersion,
			params.violationContexts,
		);

		networkStarted = true;
		const llmOutput = await params.delegate(systemPrompt, userPrompt);

		if (!validateLLMOutput(llmOutput)) {
			return {
				revised: false,
				reason: 'llm_output_invalid',
				quotaConsumed: true,
			};
		}

		const expectedVersion = params.currentVersion + 1;
		let finalOutput = llmOutput.trim();
		// Force the correct version in the LLM output to prevent drift
		if (/^version:\s*\d+\s*$/m.test(finalOutput)) {
			finalOutput = finalOutput.replace(
				/^version:\s*\d+\s*$/m,
				`version: ${expectedVersion}`,
			);
		}

		const validation = await validateRevisionCandidate(
			params,
			`${finalOutput}\n`,
			'skill_reviser:llm',
		);
		if (!validation.passed) {
			return {
				revised: false,
				reason: validation.reason,
				quotaConsumed: true,
			};
		}

		const tmpPath = `${params.skillPath}.tmp-${process.pid}-${Date.now()}`;
		await writeFile(tmpPath, `${finalOutput}\n`, 'utf-8');
		await rename(tmpPath, params.skillPath);

		const newVersion = expectedVersion;
		const entry: SkillChangelogEntry = {
			version: newVersion,
			timestamp: (params.now ?? new Date()).toISOString(),
			action: 'revised',
			reason: 'llm_revision',
			triggeringVerdicts: params.violationContexts.map((v) => ({
				taskId: v.taskId,
				verdict: v.verdict,
				agent: v.agent,
			})),
		};
		try {
			await appendSkillChangelog(params.directory, params.slug, entry);
		} catch (changelogErr) {
			warn(
				`[skill-reviser] changelog append failed (non-fatal) for ${params.slug}: ${
					changelogErr instanceof Error
						? changelogErr.message
						: String(changelogErr)
				}`,
			);
		}

		return {
			revised: true,
			reason: 'llm_revision',
			newVersion,
			quotaConsumed: true,
		};
	} catch (err) {
		warn(
			`[skill-reviser] LLM revision failed for ${params.slug}: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);

		// Release quota only if we reserved it but never started network I/O
		if (quotaReserved && !networkStarted) {
			try {
				await releaseQuota(params.directory, quotaOpts);
			} catch {
				/* non-blocking */
			}
		}

		return {
			revised: false,
			reason: 'llm_revision_failed',
			quotaConsumed: networkStarted,
		};
	}
}

export const _internals = {
	reviseSkill,
	getSkillVersion,
	buildDeterministicRevision,
	buildLLMPrompt,
	validateLLMOutput,
	validateRevisionCandidate,
	REVISION_VIOLATION_THRESHOLD,
	MAX_REVISION_CALLS_PER_PHASE,
};
