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
import { splitSkillFrontmatter } from '../config/skill-contract-digest.js';
import type { SkillImproverLLMDelegate } from '../hooks/skill-improver-llm-factory.js';
import {
	consumeFlowContinuation,
	flowNeedsContinuation,
	parseMetadataFlowMap,
	stripInlineMetadataComment,
} from '../hooks/skill-scoring.js';
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
		// Dual-shape: spec metadata.version child (quoted, indented) first,
		// then the legacy column-0 form (PRR-016 — the exported reader was
		// column-0-only while every writer now emits the nested shape).
		const nested = content.match(/^\s+version:\s*"(\d+)"\s*$/m);
		if (nested) return parseInt(nested[1], 10);
		const match = content.match(/^version:\s*(\d+)\s*$/m);
		return match ? parseInt(match[1], 10) : 1;
	} catch {
		return 1;
	}
}

/** Mirror of the drift-check detector's child-value rejections: quote a
 * flow-map value being emitted as a block metadata child whenever its bare
 * form would be rejected (bare non-string scalars, flow collections).
 * Already-quoted values pass through unchanged. */
const BLOCK_CHILD_NON_STRING_SCALAR =
	/^(?:-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?|-?\.[0-9]+|true|false|null|yes|no|on|off|~|\d{4}-\d{2}-\d{2}(?:[T ].*)?)$/i;

function quoteBlockChildValue(value: string): string {
	const t = value.trim();
	const quoted =
		(t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
		(t.startsWith("'") && t.endsWith("'") && t.length >= 2);
	if (quoted) return t;
	if (/^\[.*\]$/.test(t) || /^\{.*\}$/.test(t)) {
		return `'${t.replace(/'/g, "''")}'`;
	}
	if (BLOCK_CHILD_NON_STRING_SCALAR.test(t)) {
		return `'${t.replace(/'/g, "''")}'`;
	}
	return t;
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

	// The notes header is decided AFTER the surgery attempt (see skipSurgery
	// below): an unparseable braced inline value intentionally leaves the
	// frontmatter untouched, so claiming "Version N+1" there would be a bump
	// the file never received (PR #3387 feedback review, finding 3).

	// Update or add version in FRONTMATTER ONLY. All version surgery is
	// bounded to the frontmatter slice so an indented `version:`/`confidence:`
	// line inside a fenced body example can never be rewritten instead of the
	// real declaration (PRR-004, PR #3207 review). Spec shape keeps version
	// as a quoted-string child under `metadata:` (issue #2907); legacy
	// top-level `version:` is bumped in place (its shape is already
	// pre-spec), and every NEW insertion prefers the spec shape so the
	// writer never produces frontmatter its own detector rejects.
	const split = splitSkillFrontmatter(currentContent);
	const fmLines = split.frontmatter.split('\n');
	// Inline-value `metadata:` (flow maps and any other non-empty inline
	// value) is rewritten to the canonical block form FIRST (issue #3217):
	// the version child is bumped in place inside the rewrite, so the anchor
	// branches below never fire for these inputs and a revision can never
	// stack a second `metadata:` block beneath an inline one.
	//
	// Feedback-round invariants (PR #3387 review): the match is spliced BY
	// INDEX — never via String.replace — so a byte-identical decoy earlier in
	// the frontmatter is untouched and `$` sequences in author values cannot
	// be expanded; multi-line flow maps are consumed whole; a braced value
	// that does not parse SKIPS surgery entirely so the reader keeps failing
	// closed (an invalid audience is never widened to absent); values the
	// drift-check detector would reject as children are quoted on emission;
	// and comment-only `metadata: # note` lines are stripped exactly like the
	// detector strips them (falling through to the anchors below).
	const inlineLineIndex = fmLines.findIndex((line) =>
		/^metadata[ \t]*:[ \t]*\S/i.test(line),
	);
	const inlineRawValue =
		inlineLineIndex === -1
			? ''
			: stripInlineMetadataComment(
					(/^[^:]*:[ \t]*(.*)$/.exec(fmLines[inlineLineIndex] ?? '') ?? [
						'',
						'',
					])[1] ?? '',
				);
	const hasInlineMetadata = inlineLineIndex !== -1 && inlineRawValue !== '';
	let skipSurgery = false;
	if (hasInlineMetadata && inlineLineIndex >= 0) {
		let flowValue = inlineRawValue;
		let lastInlineLine = inlineLineIndex;
		if (flowValue.startsWith('{') && flowNeedsContinuation(flowValue)) {
			const consumed = consumeFlowContinuation(
				flowValue,
				fmLines,
				inlineLineIndex + 1,
				fmLines.length,
			);
			if (consumed === null) {
				// Unparseable multi-line flow: skip surgery entirely — the
				// frontmatter is left untouched so the reader keeps failing
				// closed and no corrupt bytes reach disk.
				skipSurgery = true;
			} else {
				flowValue = consumed.value;
				lastInlineLine = consumed.endIndex;
			}
		}
		if (!skipSurgery) {
			if (flowValue.startsWith('{')) {
				const flow = parseMetadataFlowMap(flowValue);
				if (flow === null) {
					// Balanced-but-malformed braced value: skip surgery (same
					// rationale — never widen an invalid audience).
					skipSurgery = true;
				} else {
					const childLines: string[] = ['metadata:'];
					let versionHandled = false;
					for (const [rawKey, rawValue] of flow.pairs) {
						const key = rawKey.toLowerCase();
						if (key === 'version') {
							if (versionHandled) continue; // writer owns version
							childLines.push(`  version: "${nextVersion}"`);
							versionHandled = true;
							continue;
						}
						// Duplicate keys are emitted VERBATIM (both
						// occurrences) so the reader still marks the
						// duplicate and keeps failing closed — first-wins
						// here would silently widen an invalid audience.
						childLines.push(`  ${rawKey}: ${quoteBlockChildValue(rawValue)}`);
					}
					if (!versionHandled) {
						childLines.push(`  version: "${nextVersion}"`);
					}
					fmLines.splice(
						inlineLineIndex,
						lastInlineLine - inlineLineIndex + 1,
						...childLines,
					);
					// A coexisting column-0 `version:` is bumped too so the
					// stale legacy value cannot shadow the rewritten child.
					for (let li = 0; li < fmLines.length; li++) {
						const column0 = /^version:\s*"?(\d+)"?\s*$/.exec(fmLines[li] ?? '');
						if (column0) {
							fmLines[li] = `version: ${nextVersion}`;
							break;
						}
					}
				}
			} else {
				// Non-flow inline value (scalar or sequence): audience-neutral
				// canonicalization — the value is preserved verbatim as a
				// quoted child and the version child is appended.
				const childLines = [
					'metadata:',
					`  legacy_inline: '${flowValue.replace(/'/g, "''")}'`,
					`  version: "${nextVersion}"`,
				];
				fmLines.splice(inlineLineIndex, 1, ...childLines);
			}
		}
	}
	// The notes header reflects what actually happened: a skip-surgery
	// revision leaves the frontmatter untouched and must not claim a version
	// bump (PR #3387 feedback review, finding 3).
	const revisionSection = [
		'## Revision Notes',
		'',
		skipSurgery
			? `### Not revised (${isoDate}) — unparseable inline metadata; fix the metadata: line`
			: `### Version ${nextVersion} (${isoDate})`,
		'',
		`Revised due to ${violationContexts.length} violation(s):`,
		violationLines,
		'',
		'Review the Required Procedure and Forbidden Shortcuts sections above for alignment with these violation patterns.',
		'',
	].join('\n');

	let result: string;
	if (skipSurgery) {
		result = split.frontmatter + split.body;
	} else {
		let fm = fmLines.join('\n');
		if (!hasInlineMetadata) {
			const nestedVersion = /^(\s+)version:\s*"?(\d+)"?\s*[ \t]*$/m.exec(fm);
			if (nestedVersion?.[1]) {
				fm = fm.replace(
					/^(\s+)version:\s*"?(\d+)"?\s*[ \t]*$/m,
					`${nestedVersion[1]}version: "${nextVersion}"`,
				);
			} else if (/^version:\s*"?(\d+)"?\s*[ \t]*$/m.test(fm)) {
				// Legacy column-0 (quoted tolerated): bump in place, shape preserved.
				fm = fm.replace(
					/^version:\s*"?(\d+)"?\s*[ \t]*$/m,
					`version: ${nextVersion}`,
				);
			} else if (/^(\s+)confidence:\s*/m.test(fm)) {
				const indent = /^(\s+)confidence:/m.exec(fm)?.[1] ?? '';
				fm = fm.replace(
					/^(\s+)(confidence:[^\n]*)$/m,
					`$1$2\n${indent}version: "${nextVersion}"`,
				);
			} else if (
				/^confidence:[^\n]*$/m.test(fm) &&
				!/^metadata:(?:[ \t]*#[^\n]*)?[ \t]*$/im.test(fm)
			) {
				// Legacy column-0 confidence without a metadata block: legacy insert.
				fm = fm.replace(
					/^(confidence:[^\n]*)$/m,
					`$1\nversion: ${nextVersion}`,
				);
			} else if (/^metadata:(?:[ \t]*#[^\n]*)?[ \t]*$/im.test(fm)) {
				// Spec-shaped frontmatter (a comment-only value counts as an
				// empty block, mirroring the detector): insert the version as
				// the FIRST metadata child, preserving any comment. Function
				// replacer — the returned text is used literally and can
				// never expand `$` sequences.
				fm = fm.replace(
					/^metadata:(?:[ \t]*(#[^\n]*))?[ \t]*$/im,
					(_matched, comment: string | undefined) =>
						comment
							? `metadata: ${comment.trim()}\n  version: "${nextVersion}"`
							: `metadata:\n  version: "${nextVersion}"`,
				);
			} else {
				// No metadata block and no anchors: insert a minimal
				// spec-shaped block before the closing fence (keeps `name:`
				// as the first key).
				fm = fm.replace(
					/\n(---[ \t]*(?:\r?\n|$))/,
					`\nmetadata:\n  version: "${nextVersion}"\n$1`,
				);
			}
		}
		result = fm + split.body;
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
		'- Preserve the exact frontmatter format (--- fenced YAML), including the indented `metadata:` block',
		'- Preserve all sections: Trigger, Required Procedure, Forbidden Shortcuts, Delegation Template, Reviewer Checks, Source Knowledge IDs',
		`- Update the version field in frontmatter to ${currentVersion + 1} (metadata.version when the metadata block is present)`,
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
	try {
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
	} catch (rejectedErr) {
		warn(
			`[skill-reviser] rejected-skill edit append failed (non-fatal) for ${params.slug}: ${
				rejectedErr instanceof Error ? rejectedErr.message : String(rejectedErr)
			}`,
		);
	}
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
		// Force the correct version in the LLM output to prevent drift.
		// Bounded to the frontmatter slice and shape-aware (spec-shape
		// metadata child is quoted+indented; legacy is column-0) so the guard
		// cannot silently no-op on either emitted shape (PRR-004 class).
		{
			const llmSplit = splitSkillFrontmatter(finalOutput);
			let llmFm = llmSplit.frontmatter;
			const nested = /^(\s+)version:\s*"?\d+"?\s*[ \t]*$/m.exec(llmFm);
			if (nested?.[1]) {
				llmFm = llmFm.replace(
					/^(\s+)version:\s*"?\d+"?\s*[ \t]*$/m,
					`${nested[1]}version: "${expectedVersion}"`,
				);
			} else if (/^version:\s*\d+\s*$/m.test(llmFm)) {
				llmFm = llmFm.replace(
					/^version:\s*\d+\s*$/m,
					`version: ${expectedVersion}`,
				);
			}
			finalOutput = llmFm + llmSplit.body;
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
