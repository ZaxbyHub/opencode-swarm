/**
 * System Enhancer Hook
 *
 * Enhances the system prompt with current phase information from the plan
 * and cross-agent context from the activity log.
 * Reads plan.md and injects phase context into the system prompt.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../config';
import {
	AUTO_PROCEED_BANNER,
	DEFAULT_SCORING_CONFIG,
	FULL_AUTO_BANNER,
	LEAN_TURBO_BANNER,
	OPENCODE_NATIVE_AGENTS,
	TURBO_MODE_BANNER,
} from '../config/constants';
import type { RetrospectiveEvidence } from '../config/evidence-schema';
import type { RuntimePlan } from '../config/plan-schema';
import { stripKnownSwarmPrefix } from '../config/schema';
import { listEvidenceTaskIds, loadEvidence } from '../evidence/manager';
import { getProfileForFile } from '../lang/detector';
import { loadPlan } from '../plan/manager';
import {
	getAgentSession,
	getResolvedAutoProceed,
	hasActiveFullAuto,
	hasActiveLeanTurbo,
	hasActiveTurboMode,
	swarmState,
} from '../state';

/**
 * Build the [spec-drift] advisory injected into the model's system prompt
 * after every loadPlan whenever spec staleness is detected (issue #853
 * Layer A). The text is appended to `output.system` and survives the
 * single-system-message collapse at `experimental.chat.system.transform`.
 *
 * The "Do NOT proceed" line enumerates every tool in SPEC_DRIFT_BLOCKED_TOOLS
 * so the architect knows exactly which calls will return SPEC_DRIFT_BLOCK
 * from Layer B.
 */
export function buildSpecDriftAdvisory(args: {
	reason: string;
	currentHash: string | null;
	storedHash: string;
	midLoadRemovals?: { count: number; source: string };
}): string {
	const lines = [
		'[spec-drift]',
		`Reason: ${args.reason}`,
		`Stored spec hash: ${args.storedHash}`,
		`Current spec hash: ${args.currentHash ?? '(spec.md missing)'}`,
		'Action: surface this warning to the user at your next user-facing reply. ' +
			'Do NOT proceed with destructive plan operations (save_plan with removals, ' +
			'update_task_status, phase_complete, lean_turbo_run_phase, ' +
			'lean_turbo_acquire_locks) until the user runs /swarm clarify or ' +
			'/swarm acknowledge-spec-drift.',
	];
	if (args.midLoadRemovals) {
		lines.push(
			`Auto-removed during recovery: ${args.midLoadRemovals.count} task(s) ` +
				`(source: ${args.midLoadRemovals.source}). See ` +
				'.swarm/plan-ledger.jsonl for IDs.',
		);
	}
	return lines.join('\n');
}

function readSpecStalenessSnapshot(
	directory: string,
): { specHash_plan: string; specHash_current: string | null } | null {
	try {
		const p = path.join(directory, '.swarm', 'spec-staleness.json');
		if (!fs.existsSync(p)) return null;
		const raw = fs.readFileSync(p, 'utf-8');
		const parsed = JSON.parse(raw);
		if (
			typeof parsed?.specHash_plan === 'string' &&
			(typeof parsed?.specHash_current === 'string' ||
				parsed?.specHash_current === null)
		) {
			return {
				specHash_plan: parsed.specHash_plan,
				specHash_current: parsed.specHash_current,
			};
		}
	} catch {
		/* malformed — fall through */
	}
	return null;
}

function maybeAppendSpecDriftAdvisory(
	output: { system: string[] },
	directory: string,
	plan: RuntimePlan | null,
): void {
	if (!plan?._specStale) return;
	const snap = readSpecStalenessSnapshot(directory);
	const storedHash =
		snap?.specHash_plan ?? plan.specHash ?? '(unknown — plan missing specHash)';
	const currentHash = snap?.specHash_current ?? null;
	output.system.push(
		buildSpecDriftAdvisory({
			reason: plan._specStaleReason ?? 'spec.md changed since plan was saved',
			currentHash,
			storedHash,
			midLoadRemovals: plan._midLoadRemovals,
		}),
	);
}

import {
	analyzeDecisionDrift,
	formatBudgetWarning,
	formatDriftForContext,
	getContextBudgetReport,
} from '../services';
import { telemetry } from '../telemetry';
import { warn } from '../utils';
import {
	detectAdversarialPair,
	formatAdversarialWarning,
} from './adversarial-detector';
import {
	type ContentType,
	type ContextCandidate,
	rankCandidates,
	type ScoringConfig,
} from './context-scoring';
import {
	extractCurrentPhase,
	extractCurrentPhaseFromPlan,
	extractCurrentTask,
	extractCurrentTaskFromPlan,
	extractDecisions,
	extractPlanCursor,
} from './extractors';
import {
	appendKnowledge,
	readKnowledge,
	resolveSwarmKnowledgePath,
	rewriteKnowledge,
} from './knowledge-store';
import type { SwarmKnowledgeEntry } from './knowledge-types.js';
import { validateActionability } from './knowledge-validator.js';
import {
	buildCoderLocalizationBlock,
	buildReviewerBlastRadiusBlock,
} from './repo-graph-injection';
import { buildSemanticDiffBlock } from './semantic-diff-injection.js';
import {
	estimateTokens,
	readSwarmFileAsync,
	safeHook,
	validateSwarmPath,
} from './utils';

/**
 * Extract the swarm prefix from a full agent name.
 * e.g., "mega_architect" → "mega_", "architect" → ""
 */
function extractAgentPrefix(fullAgentName: string | null | undefined): string {
	if (!fullAgentName) return '';
	const baseName = stripKnownSwarmPrefix(fullAgentName);
	if (baseName.length >= fullAgentName.length) return '';
	return fullAgentName.substring(0, fullAgentName.length - baseName.length);
}

/**
 * Estimate content type based on text characteristics.
 */
function estimateContentType(text: string): ContentType {
	// Simple heuristics
	if (
		text.includes('```') ||
		text.includes('function ') ||
		text.includes('const ')
	) {
		return 'code';
	}
	if (text.startsWith('{') || text.startsWith('[')) {
		return 'json';
	}
	if (text.includes('#') || text.includes('*') || text.includes('- ')) {
		return 'markdown';
	}
	return 'prose';
}

/**
 * Build a retrospective injection string for the architect system message.
 * Tier 1: direct phase-scoped lookup for same-plan previous phase.
 * Tier 2: cross-project historical lessons (Phase 1 only).
 * Returns null if no valid retrospective found.
 */
export async function buildRetroInjection(
	directory: string,
	currentPhaseNumber: number,
	currentPlanTitle?: string,
): Promise<string | null> {
	try {
		const prevPhase = currentPhaseNumber - 1;

		// Tier 1: direct lookup for previous phase in same plan (Phase 2+ only)
		if (prevPhase >= 1) {
			const result1 = await loadEvidence(directory, `retro-${prevPhase}`);
			if (result1.status === 'found' && result1.bundle.entries.length > 0) {
				const retroEntry = result1.bundle.entries.find(
					(entry): entry is RetrospectiveEvidence =>
						entry.type === 'retrospective',
				);

				if (retroEntry && retroEntry.verdict !== 'fail') {
					const lessons = retroEntry.lessons_learned ?? [];
					const rejections = retroEntry.top_rejection_reasons ?? [];
					const nonSessionDirectives = (
						retroEntry.user_directives ?? []
					).filter((d) => d.scope !== 'session');

					let block = `## Previous Phase Retrospective (Phase ${prevPhase})
**Outcome:** ${retroEntry.summary ?? 'Phase completed.'}
**Rejection reasons:** ${rejections.join(', ') || 'None'}
**Lessons learned:**
${lessons.map((l) => `- ${l}`).join('\n')}

⚠️ Apply these lessons to the current phase. Do not repeat the same mistakes.`;

					if (nonSessionDirectives.length > 0) {
						const top5 = nonSessionDirectives.slice(0, 5);
						block += `\n\n## User Directives (from Phase ${prevPhase})\n${top5.map((d) => `- [${d.category}] ${d.directive}`).join('\n')}`;
					}

					return block;
				}
			}

			// Fallback: scan all evidence for any retro
			const taskIds = await listEvidenceTaskIds(directory);
			const retroIds = taskIds.filter((id) => id.startsWith('retro-'));

			let latestRetro: {
				entry: RetrospectiveEvidence;
				phase: number;
			} | null = null;

			for (const taskId of retroIds) {
				const r = await loadEvidence(directory, taskId);
				if (r.status === 'found' && r.bundle.entries.length > 0) {
					for (const entry of r.bundle.entries) {
						if (entry.type === 'retrospective') {
							const retro = entry as RetrospectiveEvidence;
							if (retro.verdict !== 'fail') {
								if (
									latestRetro === null ||
									retro.phase_number > latestRetro.phase
								) {
									latestRetro = { entry: retro, phase: retro.phase_number };
								}
							}
						}
					}
				}
			}

			if (latestRetro) {
				const { entry, phase } = latestRetro;
				const lessons = entry.lessons_learned ?? [];
				const rejections = entry.top_rejection_reasons ?? [];
				const nonSessionDirectives = (entry.user_directives ?? []).filter(
					(d) => d.scope !== 'session',
				);

				let block = `## Previous Phase Retrospective (Phase ${phase})
**Outcome:** ${entry.summary ?? 'Phase completed.'}
**Rejection reasons:** ${rejections.join(', ') || 'None'}
**Lessons learned:**
${lessons.map((l) => `- ${l}`).join('\n')}

⚠️ Apply these lessons to the current phase. Do not repeat the same mistakes.`;

				if (nonSessionDirectives.length > 0) {
					const top5 = nonSessionDirectives.slice(0, 5);
					block += `\n\n## User Directives (from Phase ${phase})\n${top5.map((d) => `- [${d.category}] ${d.directive}`).join('\n')}`;
				}

				return block;
			}

			// Tier 1 found nothing for Phase 2+ → no injection
			return null;
		}

		// Tier 2: cross-project historical lessons (Phase 1 ONLY)
		const allTaskIds = await listEvidenceTaskIds(directory);
		const allRetroIds = allTaskIds.filter((id) => id.startsWith('retro-'));

		if (allRetroIds.length === 0) {
			return null;
		}

		interface RetroEntry {
			entry: RetrospectiveEvidence;
			timestamp: string;
		}
		const allRetros: RetroEntry[] = [];
		const cutoffMs = 30 * 24 * 60 * 60 * 1000;
		const now = Date.now();

		for (const taskId of allRetroIds) {
			const b = await loadEvidence(directory, taskId);
			if (b.status !== 'found') continue;
			for (const e of b.bundle.entries) {
				if (e.type === 'retrospective') {
					const retro = e as RetrospectiveEvidence;
					if (retro.verdict === 'fail') continue;
					// Filter out retros from the current project (same plan_id)
					if (
						currentPlanTitle &&
						typeof retro.metadata === 'object' &&
						retro.metadata !== null &&
						'plan_id' in retro.metadata &&
						retro.metadata.plan_id === currentPlanTitle
					)
						continue;
					const ts = retro.timestamp ?? b.bundle.created_at;
					const ageMs = now - new Date(ts).getTime();
					if (Number.isNaN(ageMs) || ageMs > cutoffMs) continue;
					allRetros.push({ entry: retro, timestamp: ts });
				}
			}
		}

		if (allRetros.length === 0) {
			return null;
		}

		allRetros.sort((a, b) => {
			const ta = new Date(a.timestamp).getTime();
			const tb = new Date(b.timestamp).getTime();
			if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
			if (Number.isNaN(ta)) return 1;
			if (Number.isNaN(tb)) return -1;
			return tb - ta;
		});
		const top3 = allRetros.slice(0, 3);

		const lines: string[] = [
			'## Historical Lessons (from recent prior projects)',
		];
		lines.push('Most recent retrospectives in this workspace:');
		const allCarriedDirectives: Array<{ category: string; directive: string }> =
			[];
		for (const { entry, timestamp } of top3) {
			const date = timestamp.split('T')[0] ?? 'unknown';
			const summary = entry.summary ?? `Phase ${entry.phase_number} completed`;
			const topLesson = entry.lessons_learned?.[0] ?? 'No lessons recorded';
			lines.push(`- Phase ${entry.phase_number} (${date}): ${summary}`);
			lines.push(`  Key lesson: ${topLesson}`);
			const nonSession = (entry.user_directives ?? []).filter(
				(d) => d.scope !== 'session',
			);
			allCarriedDirectives.push(...nonSession);
		}
		if (allCarriedDirectives.length > 0) {
			const top5 = allCarriedDirectives.slice(0, 5);
			lines.push('User directives carried forward:');
			for (const d of top5) {
				lines.push(`- [${d.category}] ${d.directive}`);
			}
		}

		const tier2Block = lines.join('\n');
		return tier2Block.length <= 800
			? tier2Block
			: `${tier2Block.substring(0, 797)}...`;
	} catch {
		return null;
	}
}

/**
 * Build a condensed retrospective injection for the coder agent.
 * Only injects Tier 1 lessons_learned bullets. No Tier 2 cross-project history.
 * Capped at 400 chars.
 */
async function buildCoderRetroInjection(
	directory: string,
	currentPhaseNumber: number,
): Promise<string | null> {
	try {
		const prevPhase = currentPhaseNumber - 1;
		if (prevPhase < 1) return null;

		const result = await loadEvidence(directory, `retro-${prevPhase}`);
		if (result.status !== 'found' || result.bundle.entries.length === 0)
			return null;

		const retroEntry = result.bundle.entries.find(
			(entry): entry is RetrospectiveEvidence => entry.type === 'retrospective',
		);

		if (!retroEntry || retroEntry.verdict === 'fail') return null;

		const lessons = retroEntry.lessons_learned ?? [];
		const summaryLine = `[SWARM RETROSPECTIVE] From Phase ${prevPhase}:${retroEntry.summary ? ` ${retroEntry.summary}` : ''}`;
		const allLines = [summaryLine, ...lessons];
		const text = allLines.join('\n');
		return text.length <= 400 ? text : `${text.substring(0, 397)}...`;
	} catch {
		return null;
	}
}

/**
 * Build language-specific coder constraints block from task file paths.
 * Returns null if no language profile is found for the task files.
 */
function buildLanguageCoderConstraints(
	currentTaskText: string | null,
): string | null {
	if (!currentTaskText) return null;

	// Extract file paths from task text (e.g. "src/tools/lint.ts")
	const filePaths = currentTaskText.match(/\bsrc\/\S+\.[a-zA-Z0-9]+\b/g) ?? [];
	if (filePaths.length === 0) return null;

	// Collect unique constraints across all task file paths (max 10 total)
	const allConstraints: string[] = [];
	const seenConstraints = new Set<string>();
	let languageLabel = '';

	for (const filePath of filePaths) {
		const profile = getProfileForFile(filePath);
		if (!profile) continue;
		if (!languageLabel) {
			languageLabel = profile.displayName;
		}
		for (const constraint of profile.prompts.coderConstraints) {
			if (!seenConstraints.has(constraint) && allConstraints.length < 10) {
				seenConstraints.add(constraint);
				allConstraints.push(constraint);
			}
		}
	}

	if (allConstraints.length === 0) return null;

	return `[LANGUAGE-SPECIFIC CONSTRAINTS — ${languageLabel}]\n${allConstraints.map((c) => `- ${c}`).join('\n')}`;
}

/**
 * Build language-specific reviewer checklist block from task file paths.
 * Returns null if no language profile is found for the task files.
 */
function buildLanguageReviewerChecklist(
	currentTaskText: string | null,
): string | null {
	if (!currentTaskText) return null;

	// Extract file paths from task text (e.g. "src/tools/lint.ts")
	const filePaths = currentTaskText.match(/\bsrc\/\S+\.[a-zA-Z0-9]+\b/g) ?? [];
	if (filePaths.length === 0) return null;

	// Collect unique checklist items across all task file paths (max 10 total)
	const allItems: string[] = [];
	const seenItems = new Set<string>();
	let languageLabel = '';

	for (const filePath of filePaths) {
		const profile = getProfileForFile(filePath);
		if (!profile) continue;
		if (!languageLabel) {
			languageLabel = profile.displayName;
		}
		for (const item of profile.prompts.reviewerChecklist) {
			if (!seenItems.has(item) && allItems.length < 10) {
				seenItems.add(item);
				allItems.push(item);
			}
		}
	}

	if (allItems.length === 0) return null;

	return `[LANGUAGE-SPECIFIC REVIEW CHECKLIST — ${languageLabel}]\n${allItems.map((i) => `- [ ] ${i}`).join('\n')}`;
}

/**
 * Build language-specific test-engineer constraints block from task file paths.
 * Returns null if no language profile is found or no testConstraints are defined.
 */
function buildLanguageTestConstraints(
	currentTaskText: string | null,
): string | null {
	if (!currentTaskText) return null;

	const filePaths = currentTaskText.match(/\bsrc\/\S+\.[a-zA-Z0-9]+\b/g) ?? [];
	if (filePaths.length === 0) return null;

	const allConstraints: string[] = [];
	const seenConstraints = new Set<string>();
	let languageLabel = '';

	for (const filePath of filePaths) {
		const profile = getProfileForFile(filePath);
		if (!profile) continue;
		if (!languageLabel) {
			languageLabel = profile.displayName;
		}
		const testConstraints = profile.prompts.testConstraints ?? [];
		for (const constraint of testConstraints) {
			if (!seenConstraints.has(constraint) && allConstraints.length < 10) {
				seenConstraints.add(constraint);
				allConstraints.push(constraint);
			}
		}
	}

	if (allConstraints.length === 0) return null;

	return `[LANGUAGE-SPECIFIC TEST CONSTRAINTS — ${languageLabel}]\n${allConstraints.map((c) => `- ${c}`).join('\n')}`;
}

/**
 * Creates the experimental.chat.system.transform hook for system enhancement.
 */
export function createSystemEnhancerHook(
	config: PluginConfig,
	directory: string,
): Record<string, unknown> {
	const enabled = config.hooks?.system_enhancer !== false;

	if (!enabled) {
		return {};
	}

	return {
		'experimental.chat.system.transform': safeHook(
			async (
				_input: { sessionID?: string; model?: unknown },
				output: { system: string[] },
			): Promise<void> => {
				try {
					// Skip swarm context injection for native opencode agents (build,
					// plan, general, explore, compaction, title, summary). These agents
					// have no use for phase/task/knowledge injection and must not trigger
					// scanDocIndex or the dark-matter scan unnecessarily.
					//
					// Limitation: activeAgent is populated lazily by the chat.message
					// hook, which fires after system.transform. On the very first prompt
					// of any new session the guard cannot fire because activeAgent has no
					// entry yet. The hang risk is still mitigated by the async pruning
					// walk in scanDocIndex (see doc-scan.ts), which makes the worst-case
					// cost proportional to the number of matching doc files, not the
					// total number of files in the repo.
					if (_input.sessionID) {
						const sessionAgent = swarmState.activeAgent.get(_input.sessionID);
						if (
							sessionAgent &&
							OPENCODE_NATIVE_AGENTS.has(sessionAgent.toLowerCase() as never)
						) {
							return;
						}
					}

					const maxInjectionTokens =
						config.context_budget?.max_injection_tokens ?? 4000;
					let injectedTokens = 0;

					function tryInject(text: string): void {
						const tokens = estimateTokens(text);
						if (injectedTokens + tokens > maxInjectionTokens) {
							warn(
								`system-enhancer: injection budget exceeded (${injectedTokens + tokens} > ${maxInjectionTokens} tokens) — truncating system prompt content`,
							);
							return;
						}
						output.system.push(text);
						injectedTokens += tokens;
					}

					const contextContent = await readSwarmFileAsync(
						directory,
						'context.md',
					);

					// v6.39: Auto-trigger doc_scan to build/refresh doc manifest
					// Non-blocking — failure does not prevent plan processing
					try {
						const { scanDocIndex } = await import('../tools/doc-scan.js');
						const { manifest, cached } = await scanDocIndex(directory);
						if (!cached) {
							warn(
								`[system-enhancer] Doc manifest generated: ${manifest.files.length} files indexed`,
							);
						}
					} catch {
						// Non-blocking — doc scan failure should not prevent plan processing
					}

					// Dark matter scan: detect co-change patterns in git history
					// Non-blocking — skip silently on repos without git history, shallow clones, or errors
					// Cached: skip if dark-matter.md already exists (matches doc_scan caching pattern)
					try {
						const darkMatterPath = validateSwarmPath(
							directory,
							'dark-matter.md',
						);
						if (!fs.existsSync(darkMatterPath)) {
							const {
								detectDarkMatter,
								formatDarkMatterOutput,
								darkMatterToKnowledgeEntries,
							} = await import('../tools/co-change-analyzer.js');
							const darkMatter = await detectDarkMatter(directory, {
								minCommits: 20,
								minCoChanges: 3,
							});
							// Always write cache — even on empty results — to prevent
							// repeated O(n²) recomputation on every chat turn (#1021).
							// Ensure .swarm/ directory exists before writing (may not exist
							// on first run in a fresh repo before plugin init creates it).
							await fs.promises.mkdir(path.dirname(darkMatterPath), {
								recursive: true,
							});
							const darkMatterReport = formatDarkMatterOutput(darkMatter);
							await fs.promises.writeFile(
								darkMatterPath,
								darkMatterReport,
								'utf-8',
							);
							warn(
								`[system-enhancer] Dark matter scan complete: ${darkMatter.length} co-change patterns found`,
							);
							if (darkMatter.length > 0) {
								// Generate knowledge entries from dark matter results
								try {
									const projectName = path.basename(path.resolve(directory));
									const knowledgeEntries = darkMatterToKnowledgeEntries(
										darkMatter,
										projectName,
									);
									const knowledgePath = resolveSwarmKnowledgePath(directory);
									// Deduplicate: skip entries already in knowledge
									const existingEntries =
										await readKnowledge<SwarmKnowledgeEntry>(knowledgePath);
									const existingLessons = new Set(
										existingEntries.map((e) => e.lesson),
									);
									// Layer-5 actionability gate (Change 4): dark-matter entries are
									// generated actionable at the source, but the gate contract is
									// structural — enforce it here so a future change to the
									// generator cannot silently bypass it.
									const newEntries = knowledgeEntries.filter(
										(e) =>
											!existingLessons.has(e.lesson) &&
											validateActionability(e).actionable,
									);
									if (newEntries.length === 0) {
										warn(
											`[system-enhancer] No new knowledge entries (all duplicates)`,
										);
									} else {
										for (const entry of newEntries) {
											await appendKnowledge(knowledgePath, entry);
										}
										warn(
											`[system-enhancer] Created ${newEntries.length} new knowledge entries (${knowledgeEntries.length - newEntries.length} duplicates skipped)`,
										);
									}
								} catch (e) {
									// Non-blocking: knowledge is supplementary
									warn(
										`[system-enhancer] Failed to create knowledge entries: ${e}`,
									);
								}
							}
						} // end if (!fs.existsSync(darkMatterPath))

						// Retroactive repair: v6.41.0 regression (b324ce1) wrote dark matter entries
						// with scope: 'project', which is filtered out by the default scope_filter ['global'].
						// Re-scope any such entries to 'global' so they can reach the architect.
						try {
							const knowledgePath = resolveSwarmKnowledgePath(directory);
							const allEntries =
								await readKnowledge<SwarmKnowledgeEntry>(knowledgePath);
							const stale = allEntries.filter(
								(e) =>
									e.scope === 'project' &&
									e.auto_generated === true &&
									Array.isArray(e.tags) &&
									e.tags.includes('dark-matter'),
							);
							if (stale.length > 0) {
								for (const e of stale) {
									e.scope = 'global';
									e.updated_at = new Date().toISOString();
								}
								await rewriteKnowledge(knowledgePath, allEntries);
								warn(
									`[system-enhancer] Repaired ${stale.length} dark matter knowledge entries (scope: 'project' → 'global')`,
								);
							}
						} catch {
							// Non-blocking
						}
					} catch {
						// Non-blocking — skip silently on repos without git history, shallow clones, or errors
					}

					// Check if scoring is enabled
					const scoringEnabled =
						config.context_budget?.scoring?.enabled === true;

					if (!scoringEnabled) {
						// Path A: EXACT LEGACY CODE - do not change
						// Priority 0: Minimal phase header
						let plan = null;
						try {
							plan = await loadPlan(directory);
						} catch (error) {
							warn(
								`Failed to load plan: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
						// Issue #853 Layer A: surface spec drift to the model.
						maybeAppendSpecDriftAdvisory(output, directory, plan);
						const mode = await detectArchitectMode(directory);
						let planContent: string | null = null;
						let phaseHeader = '';
						if (plan && plan.migration_status !== 'migration_failed') {
							phaseHeader = extractCurrentPhaseFromPlan(plan) || '';
							planContent = await readSwarmFileAsync(directory, 'plan.md');
						} else {
							planContent = await readSwarmFileAsync(directory, 'plan.md');
							phaseHeader = planContent
								? extractCurrentPhase(planContent) || ''
								: '';
						}
						if (phaseHeader) {
							tryInject(`[SWARM CONTEXT] Phase: ${phaseHeader}`);
						}

						// Priority 1: Plan cursor (compressed plan summary)
						if (mode !== 'DISCOVER' && planContent) {
							const planCursor = extractPlanCursor(planContent);
							tryInject(planCursor);
						}

						// Priority 2: Handoff brief injection (resuming from model switch)
						if (mode !== 'DISCOVER') {
							try {
								const handoffContent = await readSwarmFileAsync(
									directory,
									'handoff.md',
								);
								if (handoffContent) {
									// Validate paths BEFORE rename
									const handoffPath = validateSwarmPath(
										directory,
										'handoff.md',
									);
									const consumedPath = validateSwarmPath(
										directory,
										'handoff-consumed.md',
									);

									// Check for duplicate handoff-consumed.md (warn but continue)
									if (fs.existsSync(consumedPath)) {
										warn(
											'Duplicate handoff detected: handoff-consumed.md already exists',
										);
										fs.unlinkSync(consumedPath);
									}

									// Rename BEFORE injection - only inject if rename succeeds
									fs.renameSync(handoffPath, consumedPath);

									// Clean up supplementary handoff-prompt.md artifact if present
									try {
										const promptPath = validateSwarmPath(
											directory,
											'handoff-prompt.md',
										);
										fs.unlinkSync(promptPath);
									} catch {
										// handoff-prompt.md may not exist — non-blocking
									}

									// Only inject if rename succeeded
									const handoffBlock = `## HANDOFF — Resuming from model switch
The previous model's session ended. Here is your starting context:

${handoffContent}`;
									tryInject(`[HANDOFF BRIEF]\n${handoffBlock}`);
								}
								// biome-ignore lint/suspicious/noExplicitAny: error type is unknown from catch clause
							} catch (error: any) {
								// Log non-ENOENT errors (file not found is expected)
								if (error?.code !== 'ENOENT') {
									warn('Handoff injection failed:', error);
								}
							}
						}

						// Priority 3: Decisions
						if (mode !== 'DISCOVER' && contextContent) {
							const decisions = extractDecisions(contextContent, 200);
							if (decisions) {
								tryInject(`[SWARM CONTEXT] Key decisions: ${decisions}`);
							}

							// Priority 4 (lowest): Agent context
							if (config.hooks?.agent_activity !== false && _input.sessionID) {
								const activeAgent = swarmState.activeAgent.get(
									_input.sessionID,
								);
								if (activeAgent) {
									const agentContext = extractAgentContext(
										contextContent,
										activeAgent,
										config.hooks?.agent_awareness_max_chars ?? 300,
									);
									if (agentContext) {
										tryInject(`[SWARM AGENT CONTEXT] ${agentContext}`);
									}
								}
							}
						}

						// Priority 5 (lowest): Summarization awareness
						tryInject(
							'[SWARM HINT] Large tool outputs may be auto-summarized. Use /swarm retrieve <id> to get the full content if needed.',
						);

						// v6.0: Security review override
						if (config.review_passes?.always_security_review) {
							tryInject(
								'[SWARM CONFIG] Security review pass is MANDATORY for ALL tasks. Skip file-pattern check — always run security-only reviewer pass after general review APPROVED.',
							);
						}

						// v6.0: Integration analysis override
						if (config.integration_analysis?.enabled === false) {
							tryInject(
								'[SWARM CONFIG] Integration analysis is DISABLED. Skip diff tool and integration impact analysis after coder tasks.',
							);
						}

						// v6.1: UI/UX Designer agent opt-in
						if (config.ui_review?.enabled) {
							tryInject(
								'[SWARM CONFIG] UI/UX Designer agent is ENABLED. For tasks matching UI trigger keywords or file paths, delegate to designer BEFORE coder (Rule 9).',
							);
						}

						// v6.1: Docs agent opt-out
						if (config.docs?.enabled === false) {
							tryInject(
								'[SWARM CONFIG] Docs agent is DISABLED. Skip docs delegation in Phase 6.',
							);
						}

						// v6.2: Lint gate opt-out
						if (config.lint?.enabled === false) {
							tryInject(
								'[SWARM CONFIG] Lint gate is DISABLED. Skip lint check/fix in QA sequence.',
							);
						}

						// v6.2: Secretscan gate opt-out
						if (config.secretscan?.enabled === false) {
							tryInject(
								'[SWARM CONFIG] Secretscan gate is DISABLED. Skip secretscan in QA sequence.',
							);
						}

						// v6.13.1-hotfix: Agent execution guardrails
						const activeAgent_hf1 = swarmState.activeAgent.get(
							_input.sessionID ?? '',
						);
						const baseRole = activeAgent_hf1
							? stripKnownSwarmPrefix(activeAgent_hf1)
							: null;

						// HF-1: Prevent coder from self-verifying
						if (baseRole === 'coder' || baseRole === 'test_engineer') {
							const hf1Prefix = extractAgentPrefix(activeAgent_hf1);
							tryInject(
								`[SWARM CONFIG] You must NOT run build, test, lint, or type-check commands (npm run build, bun test, npx tsc, eslint, etc.). Make ONLY the code changes specified in your task. Verification is handled by the ${hf1Prefix}reviewer agent — do not self-verify. If your task explicitly asks you to run a specific command, that is the only exception.`,
							);
						}

						// v6.13.1-hotfix: Prevent architect from running full test suite
						// Concurrent or bulk test runs crash OpenCode — architect must delegate or scope narrowly
						if (baseRole === 'architect' || baseRole === null) {
							const hf1Prefix = extractAgentPrefix(activeAgent_hf1);
							tryInject(
								`[SWARM CONFIG] You must NEVER run the full test suite or batch test files. If you need to verify changes, run ONLY the specific test files for code YOU modified in this session — one file at a time, strictly serial. Do not run tests from directories or files unrelated to your changes. Do not run bun test without an explicit file path. When possible, delegate test execution to the ${hf1Prefix}test_engineer agent instead of running tests yourself.`,
							);
						}

						// v6.13.2: Same-model adversarial detection
						if (config.adversarial_detection?.enabled !== false) {
							const activeAgent_adv = swarmState.activeAgent.get(
								_input.sessionID ?? '',
							);
							if (activeAgent_adv) {
								const baseRole_adv = stripKnownSwarmPrefix(activeAgent_adv);
								const pairs_adv = config.adversarial_detection?.pairs ?? [
									['coder', 'reviewer'],
								];
								const policy_adv =
									config.adversarial_detection?.policy ?? 'warn';
								for (const [agentA, agentB] of pairs_adv) {
									if (baseRole_adv === agentB) {
										const sharedModel = detectAdversarialPair(
											agentA,
											agentB,
											config,
										);
										if (sharedModel) {
											const warningText = formatAdversarialWarning(
												agentA,
												agentB,
												sharedModel,
												policy_adv,
											);
											if (policy_adv !== 'ignore') {
												tryInject(`[SWARM CONFIG] ${warningText}`);
											}
										}
									}
								}
							}
						}

						// v6.10: Parallel pre-check batch hint — architect-only
						if (mode !== 'DISCOVER') {
							const sessionId_preflight = _input.sessionID;
							const activeAgent_preflight = swarmState.activeAgent.get(
								sessionId_preflight ?? '',
							);
							const isArchitectForPreflight =
								!activeAgent_preflight ||
								stripKnownSwarmPrefix(activeAgent_preflight) === 'architect';

							if (isArchitectForPreflight) {
								if (config.pipeline?.parallel_precheck !== false) {
									const preflightPrefix = extractAgentPrefix(
										activeAgent_preflight,
									);
									tryInject(
										`[SWARM HINT] Parallel pre-check enabled: call pre_check_batch(files, directory) after lint --fix and build_check to run lint:check + secretscan + sast_scan + quality_budget concurrently (max 4 parallel). Check gates_passed before calling ${preflightPrefix}reviewer.`,
									);
								} else {
									tryInject(
										'[SWARM HINT] Parallel pre-check disabled: run lint:check → secretscan → sast_scan → quality_budget sequentially.',
									);
								}
							}
						}

						// v6.13.3: Coder retrospective injection — condensed Tier 1 lessons only
						if (baseRole === 'coder') {
							try {
								const currentPhaseNum_coder = plan?.current_phase ?? 1;
								const coderRetro = await buildCoderRetroInjection(
									directory,
									currentPhaseNum_coder,
								);
								if (coderRetro) {
									tryInject(coderRetro);
								}
							} catch {
								// Silently skip
							}
						}

						// v6.x: Coder context pack — knowledge recall + prior rejections
						if (baseRole === 'coder') {
							const sessionId_ccp = _input.sessionID ?? '';
							const ccpSession = swarmState.agentSessions.get(sessionId_ccp);

							// Knowledge recall from knowledge base
							try {
								const coderScope = ccpSession?.declaredCoderScope;
								const primaryFile = coderScope?.[0] ?? '';
								if (primaryFile.length > 0) {
									const { knowledge_recall } = await import(
										'../tools/knowledge-recall.js'
									);
									const rawResult = await knowledge_recall.execute(
										{ query: primaryFile },
										// Pass minimal context so createSwarmTool extracts directory correctly
										// biome-ignore lint/suspicious/noExplicitAny: knowledge_recall.execute expects a narrow internal context; directory is the only needed field
										{ directory } as any,
									);
									if (rawResult && typeof rawResult === 'string') {
										const parsed = JSON.parse(rawResult) as {
											results: Array<{
												id: string;
												lesson: string;
												category: string;
												confidence: number;
												score: number;
											}>;
											total: number;
										};
										if (parsed.results.length > 0) {
											const lines = parsed.results.map((r) => {
												const lesson =
													r.lesson.length > 200
														? `${r.lesson.slice(0, 200)}...`
														: r.lesson;
												return `- [${r.category}] ${lesson}`;
											});
											tryInject(
												`## CONTEXT FROM KNOWLEDGE BASE\n${lines.join('\n')}`,
											);
										}
									}
								}
							} catch {
								// Silently skip knowledge recall failures
							}

							// Prior rejections from evidence
							try {
								const taskId_ccp = ccpSession?.currentTaskId;
								if (
									taskId_ccp &&
									!taskId_ccp.includes('..') &&
									!taskId_ccp.includes('/') &&
									!taskId_ccp.includes('\\') &&
									!taskId_ccp.includes('\0')
								) {
									const evidencePath = path.join(
										directory,
										'.swarm',
										'evidence',
										`${taskId_ccp}.json`,
									);
									if (fs.existsSync(evidencePath)) {
										const evidenceContent = fs.readFileSync(
											evidencePath,
											'utf-8',
										);
										const evidenceData = JSON.parse(evidenceContent) as {
											bundle?: {
												entries?: Array<{
													type: string;
													gate_type?: string;
													verdict?: string;
													reason?: string;
												}>;
											};
										};
										const rejections = (
											evidenceData.bundle?.entries ?? []
										).filter(
											(e) =>
												e.type === 'gate' &&
												e.gate_type === 'reviewer' &&
												e.verdict === 'reject',
										);
										if (rejections.length > 0) {
											const lines = rejections.map(
												(r) => `- ${r.reason ?? 'No reason provided'}`,
											);
											tryInject(`## PRIOR REJECTIONS\n${lines.join('\n')}`);
										}
									}
								}
							} catch {
								// Silently skip evidence read failures
							}

							// Repo graph: surface importers/blast radius for the declared scope.
							// Silent no-op if the graph hasn't been built yet — the coder can
							// invoke `repo_map action="build"` to enable this on demand.
							try {
								const coderScopePrimary = ccpSession?.declaredCoderScope?.[0];
								if (coderScopePrimary) {
									const localizationBlock = buildCoderLocalizationBlock(
										directory,
										coderScopePrimary,
									);
									if (localizationBlock) {
										tryInject(localizationBlock);
									}
								}
							} catch {
								// Silently skip graph injection failures
							}
						}

						// v6.16: Language-specific coder constraints injection
						if (baseRole === 'coder') {
							const taskText_lang_a =
								plan && plan.migration_status !== 'migration_failed'
									? extractCurrentTaskFromPlan(plan)
									: null;
							const langConstraints_a =
								buildLanguageCoderConstraints(taskText_lang_a);
							if (langConstraints_a) {
								tryInject(langConstraints_a);
							}
						}

						// v6.16: Language-specific reviewer checklist injection
						if (baseRole === 'reviewer') {
							const taskText_rev_a =
								plan && plan.migration_status !== 'migration_failed'
									? extractCurrentTaskFromPlan(plan)
									: null;
							const revChecklist_a =
								buildLanguageReviewerChecklist(taskText_rev_a);
							if (revChecklist_a) {
								tryInject(revChecklist_a);
							}

							// Repo graph: surface blast radius for the files the coder just
							// changed (carried in the session's declaredCoderScope).
							try {
								const reviewerSessionId = _input.sessionID ?? '';
								const reviewerSession =
									swarmState.agentSessions.get(reviewerSessionId);
								const changed = reviewerSession?.declaredCoderScope ?? [];
								if (changed.length > 0) {
									const blastBlock = buildReviewerBlastRadiusBlock(
										directory,
										changed,
									);
									if (blastBlock) {
										tryInject(blastBlock);
									}
								}
							} catch {
								// Silently skip graph injection failures
							}

							// v6.x: Semantic diff summary injection
							try {
								const reviewerSessionId = _input.sessionID ?? '';
								const reviewerSession =
									swarmState.agentSessions.get(reviewerSessionId);
								const semDiffChanged =
									reviewerSession?.declaredCoderScope ?? [];
								if (semDiffChanged.length > 0) {
									const semDiffBlock = await buildSemanticDiffBlock(
										directory,
										semDiffChanged,
									);
									if (semDiffBlock) {
										tryInject(semDiffBlock);
									}
								}
							} catch {
								// Silently skip semantic diff injection failures
							}
						}

						// v6.46: Language-specific test-engineer constraints injection
						if (baseRole === 'test_engineer') {
							const taskText_te_a =
								plan && plan.migration_status !== 'migration_failed'
									? extractCurrentTaskFromPlan(plan)
									: null;
							const testConstraints_a =
								buildLanguageTestConstraints(taskText_te_a);
							if (testConstraints_a) {
								tryInject(testConstraints_a);
							}
						}

						// v6.2: Retrospective injection — architect-only, most recent retro
						const sessionId_retro = _input.sessionID;
						const activeAgent_retro = swarmState.activeAgent.get(
							sessionId_retro ?? '',
						);
						const isArchitect =
							!activeAgent_retro ||
							stripKnownSwarmPrefix(activeAgent_retro) === 'architect';

						if (isArchitect) {
							// v6.x: Turbo/Full-Auto/Lean-Turbo banner injection for architect
							const sessionIdBanner = _input.sessionID;
							if (
								hasActiveTurboMode(sessionIdBanner) ||
								hasActiveFullAuto(sessionIdBanner) ||
								hasActiveLeanTurbo(sessionIdBanner)
							) {
								if (hasActiveTurboMode(sessionIdBanner)) {
									tryInject(TURBO_MODE_BANNER);
								}
								if (hasActiveFullAuto(sessionIdBanner)) {
									tryInject(FULL_AUTO_BANNER);
								}
								if (hasActiveLeanTurbo(sessionIdBanner)) {
									tryInject(LEAN_TURBO_BANNER);
								}
							}

							// v6.x: Auto-proceed banner injection for architect
							const sessionIdAutoProceed = _input.sessionID;
							if (sessionIdAutoProceed) {
								const sessionAutoProceed =
									getAgentSession(sessionIdAutoProceed);
								if (sessionAutoProceed) {
									const resolvedAutoProceed = getResolvedAutoProceed(
										sessionAutoProceed,
										plan?.execution_profile?.auto_proceed,
									);
									const source =
										sessionAutoProceed.autoProceedOverride !== undefined
											? 'session'
											: 'plan-or-default';
									const banner = `${AUTO_PROCEED_BANNER}\nAUTO_PROCEED STATUS:
- auto-proceed: ${resolvedAutoProceed ? 'on' : 'off'}
- source: ${source}
- nudge: ${sessionAutoProceed.autoProceedNudgeDone ? 'true' : 'false'}`;
									tryInject(banner);
								}
							}

							try {
								const currentPhaseNum = plan?.current_phase ?? 1;
								const retroText = await buildRetroInjection(
									directory,
									currentPhaseNum,
									plan?.title ?? undefined,
								);
								if (retroText) {
									if (retroText.length <= 1600) {
										tryInject(retroText);
									} else {
										tryInject(`${retroText.substring(0, 1600)}...`);
									}
								}
							} catch {
								// Silently skip if evidence dir missing or unreadable
							}

							// v6.2: Soft compaction advisory
							if (mode !== 'DISCOVER') {
								const compactionConfig = config.compaction_advisory;
								if (compactionConfig?.enabled !== false && sessionId_retro) {
									const session = swarmState.agentSessions.get(sessionId_retro);
									if (session) {
										const totalToolCalls = Array.from(
											swarmState.toolAggregates.values(),
										).reduce((sum, agg) => sum + agg.count, 0);

										const thresholds = compactionConfig?.thresholds ?? [
											50, 75, 100, 125, 150,
										];
										const lastHint = session.lastCompactionHint || 0;

										for (const threshold of thresholds) {
											if (totalToolCalls >= threshold && lastHint < threshold) {
												const totalToolCallsPlaceholder =
													'$' + '{totalToolCalls}';
												const messageTemplate =
													compactionConfig?.message ??
													`[SWARM HINT] Session has ${totalToolCallsPlaceholder} tool calls. Consider compacting at next phase boundary to maintain context quality.`;
												const message = messageTemplate.replace(
													totalToolCallsPlaceholder,
													String(totalToolCalls),
												);
												tryInject(message);
												session.lastCompactionHint = threshold;
												break;
											}
										}
									}
								}
							}
						}

						// v6.7: Decision drift detection — architect-only
						if (mode !== 'DISCOVER') {
							const automationCapabilities = config.automation?.capabilities;
							if (
								automationCapabilities?.decision_drift_detection === true &&
								_input.sessionID
							) {
								const activeAgentForDrift = swarmState.activeAgent.get(
									_input.sessionID,
								);
								const isArchitectForDrift =
									!activeAgentForDrift ||
									stripKnownSwarmPrefix(activeAgentForDrift) === 'architect';

								if (isArchitectForDrift) {
									try {
										const driftResult = await analyzeDecisionDrift(directory);
										if (driftResult.hasDrift) {
											const driftText = formatDriftForContext(driftResult);
											if (driftText) {
												tryInject(driftText);
											}
										}
									} catch {
										// Silently skip if drift analysis fails
									}
								}
							}
						}

						// Context budget check - run after all other assembly, architect-only
						const userConfig = config.context_budget;
						const defaultConfig: typeof import('../services').DEFAULT_CONTEXT_BUDGET_CONFIG =
							{
								enabled: true,
								budgetTokens: 40000,
								warningPct: 70,
								criticalPct: 90,
								warningMode: 'once',
								warningIntervalTurns: 20,
							};
						// Map schema config to service config format
						const contextBudgetConfig = userConfig
							? {
									// biome-ignore lint/suspicious/noExplicitAny: config spreading requires any
									...(defaultConfig as any),
									// biome-ignore lint/suspicious/noExplicitAny: config spreading requires any
									...(userConfig as any),
									warningPct: userConfig.warn_threshold
										? userConfig.warn_threshold * 100
										: defaultConfig.warningPct,
									criticalPct: userConfig.critical_threshold
										? userConfig.critical_threshold * 100
										: defaultConfig.criticalPct,
									budgetTokens:
										userConfig.model_limits?.default ??
										defaultConfig.budgetTokens,
								}
							: defaultConfig;

						if (contextBudgetConfig.enabled !== false) {
							const assembledSystemPrompt = output.system.join('\n');
							const budgetReport = await getContextBudgetReport(
								directory,
								assembledSystemPrompt,
								contextBudgetConfig,
							);
							swarmState.lastBudgetPct = budgetReport.budgetPct;
							telemetry.budgetUpdated(
								_input.sessionID ?? 'unknown',
								budgetReport.budgetPct,
								'architect',
							);
							const budgetWarning = await formatBudgetWarning(
								budgetReport,
								directory,
								contextBudgetConfig,
							);
							if (budgetWarning) {
								// Check if architect
								const sessionId_cb = _input.sessionID;
								const activeAgent_cb = sessionId_cb
									? swarmState.activeAgent.get(sessionId_cb)
									: null;
								const isArchitect_cb =
									!activeAgent_cb ||
									stripKnownSwarmPrefix(activeAgent_cb) === 'architect';
								if (isArchitect_cb) {
									output.system.push(`[FOR: architect]\n${budgetWarning}`);
								}
							}
						}

						// Pre-flight binary advisory (runs once, non-fatal) — architect-only
						try {
							const activeAgent_binary = swarmState.activeAgent.get(
								_input.sessionID ?? '',
							);
							const isArchitect_binary =
								!activeAgent_binary ||
								stripKnownSwarmPrefix(activeAgent_binary) === 'architect';
							if (isArchitect_binary) {
								const { getBinaryReadinessAdvisory } = await import(
									'../services/tool-doctor.js'
								);
								const advisory = getBinaryReadinessAdvisory();
								if (advisory) {
									tryInject(advisory);
								}
							}
						} catch {
							// Non-blocking — binary check failure must not prevent system enhancement
						}

						// Environment profile injection for coder and test_engineer
						try {
							const activeAgent_env = swarmState.activeAgent.get(
								_input.sessionID ?? '',
							);
							const agentBase_env = stripKnownSwarmPrefix(
								activeAgent_env ?? '',
							).toLowerCase();
							if (
								agentBase_env === 'coder' ||
								agentBase_env === 'test_engineer'
							) {
								const { ensureSessionEnvironment } = await import(
									'../state.js'
								);
								const { renderEnvironmentPrompt } = await import(
									'../environment/prompt-renderer.js'
								);
								const envSessionId = _input.sessionID ?? 'unknown';
								const profile = ensureSessionEnvironment(envSessionId);
								const audience =
									agentBase_env === 'coder' ? 'coder' : 'testengineer';
								const envPrompt = renderEnvironmentPrompt(profile, audience);
								tryInject(envPrompt);
							}
						} catch {
							// Non-blocking — environment injection failure must not break the hook
						}

						return;
					}

					// Path B: Scoring is enabled - build candidates and rank
					const mode_b = await detectArchitectMode(directory);
					const userScoringConfig = config.context_budget?.scoring;
					const candidates: ContextCandidate[] = [];
					let idCounter = 0;
					let planContentForCursor: string | null = null;

					// Build effective config with guaranteed weights (use defaults if user config missing/invalid)
					const effectiveConfig: ScoringConfig = (
						userScoringConfig?.weights
							? {
									...DEFAULT_SCORING_CONFIG,
									...userScoringConfig,
									weights: userScoringConfig.weights,
								}
							: DEFAULT_SCORING_CONFIG
					) as ScoringConfig;

					// Build candidates from same sources as legacy
					// Current phase
					let plan = null;
					try {
						plan = await loadPlan(directory);
					} catch (error) {
						warn(
							`Failed to load plan: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
					// Issue #853 Layer A: surface spec drift to the model.
					maybeAppendSpecDriftAdvisory(output, directory, plan);
					let currentPhase: string | null = null;
					let currentTask: string | null = null;

					if (plan && plan.migration_status !== 'migration_failed') {
						currentPhase = extractCurrentPhaseFromPlan(plan);
						currentTask = extractCurrentTaskFromPlan(plan);
					} else {
						planContentForCursor = await readSwarmFileAsync(
							directory,
							'plan.md',
						);
						if (planContentForCursor) {
							currentPhase = extractCurrentPhase(planContentForCursor);
							currentTask = extractCurrentTask(planContentForCursor);
						}
					}

					if (currentPhase) {
						const text = `[SWARM CONTEXT] Current phase: ${currentPhase}`;
						candidates.push({
							id: `candidate-${idCounter++}`,
							kind: 'phase',
							text,
							tokens: estimateTokens(text),
							priority: 1, // legacy priority 1
							metadata: { contentType: estimateContentType(text) },
						});
					}

					// Current task
					if (currentTask) {
						const text = `[SWARM CONTEXT] Current task: ${currentTask}`;
						candidates.push({
							id: `candidate-${idCounter++}`,
							kind: 'task',
							text,
							tokens: estimateTokens(text),
							priority: 2,
							metadata: {
								contentType: estimateContentType(text),
								isCurrentTask: true,
							},
						});
					}

					// Plan cursor for scoring path
					if (planContentForCursor) {
						const planCursor = extractPlanCursor(planContentForCursor);
						candidates.push({
							id: `candidate-${idCounter++}`,
							kind: 'phase',
							text: planCursor,
							tokens: estimateTokens(planCursor),
							priority: 1,
							metadata: { contentType: 'markdown' },
						});
					}

					// Handoff brief injection (resuming from model switch) for scoring path
					if (mode_b !== 'DISCOVER') {
						try {
							const handoffContent = await readSwarmFileAsync(
								directory,
								'handoff.md',
							);
							if (handoffContent) {
								// Validate paths BEFORE rename
								const handoffPath = validateSwarmPath(directory, 'handoff.md');
								const consumedPath = validateSwarmPath(
									directory,
									'handoff-consumed.md',
								);

								// Check for duplicate handoff-consumed.md (warn but continue)
								if (fs.existsSync(consumedPath)) {
									warn(
										'Duplicate handoff detected: handoff-consumed.md already exists',
									);
									fs.unlinkSync(consumedPath);
								}

								// Rename BEFORE adding to candidates - only add if rename succeeds
								fs.renameSync(handoffPath, consumedPath);

								// Only add to candidates if rename succeeded
								const handoffBlock = `## HANDOFF — Resuming from model switch
The previous model's session ended. Here is your starting context:

${handoffContent}`;
								const handoffText = `[HANDOFF BRIEF]\n${handoffBlock}`;
								candidates.push({
									id: `candidate-${idCounter++}`,
									kind: 'phase' as ContextCandidate['kind'],
									text: handoffText,
									tokens: estimateTokens(handoffText),
									priority: 1,
									metadata: { contentType: 'markdown' as ContentType },
								});
							}
							// biome-ignore lint/suspicious/noExplicitAny: error type is unknown from catch clause
						} catch (error: any) {
							// Log non-ENOENT errors (file not found is expected)
							if (error?.code !== 'ENOENT') {
								warn('Handoff injection failed:', error);
							}
						}
					}

					// Decisions
					if (contextContent) {
						const decisions = extractDecisions(contextContent, 200);
						if (decisions) {
							const text = `[SWARM CONTEXT] Key decisions: ${decisions}`;
							candidates.push({
								id: `candidate-${idCounter++}`,
								kind: 'decision',
								text,
								tokens: estimateTokens(text),
								priority: 3,
								metadata: { contentType: estimateContentType(text) },
							});
						}

						// Agent context
						if (config.hooks?.agent_activity !== false && _input.sessionID) {
							const activeAgent = swarmState.activeAgent.get(_input.sessionID);
							if (activeAgent) {
								const agentContext = extractAgentContext(
									contextContent,
									activeAgent,
									config.hooks?.agent_awareness_max_chars ?? 300,
								);
								if (agentContext) {
									const text = `[SWARM AGENT CONTEXT] ${agentContext}`;
									candidates.push({
										id: `candidate-${idCounter++}`,
										kind: 'agent_context',
										text,
										tokens: estimateTokens(text),
										priority: 4,
										metadata: { contentType: estimateContentType(text) },
									});
								}
							}
						}
					}

					// v6.0: Security review override
					if (config.review_passes?.always_security_review) {
						const text =
							'[SWARM CONFIG] Security review pass is MANDATORY for ALL tasks. Skip file-pattern check — always run security-only reviewer pass after general review APPROVED.';
						candidates.push({
							id: `candidate-${idCounter++}`,
							kind: 'phase' as ContextCandidate['kind'],
							text,
							tokens: estimateTokens(text),
							priority: 1,
							metadata: { contentType: 'prose' as ContentType },
						});
					}

					// v6.0: Integration analysis override
					if (config.integration_analysis?.enabled === false) {
						const text =
							'[SWARM CONFIG] Integration analysis is DISABLED. Skip diff tool and integration impact analysis after coder tasks.';
						candidates.push({
							id: `candidate-${idCounter++}`,
							kind: 'phase' as ContextCandidate['kind'],
							text,
							tokens: estimateTokens(text),
							priority: 1,
							metadata: { contentType: 'prose' as ContentType },
						});
					}

					// v6.1: UI/UX Designer agent opt-in
					if (config.ui_review?.enabled) {
						const text =
							'[SWARM CONFIG] UI/UX Designer agent is ENABLED. For tasks matching UI trigger keywords or file paths, delegate to designer BEFORE coder (Rule 9).';
						candidates.push({
							id: `candidate-${idCounter++}`,
							kind: 'phase' as ContextCandidate['kind'],
							text,
							tokens: estimateTokens(text),
							priority: 1,
							metadata: { contentType: 'prose' as ContentType },
						});
					}

					// v6.1: Docs agent opt-out
					if (config.docs?.enabled === false) {
						const text =
							'[SWARM CONFIG] Docs agent is DISABLED. Skip docs delegation in Phase 6.';
						candidates.push({
							id: `candidate-${idCounter++}`,
							kind: 'phase' as ContextCandidate['kind'],
							text,
							tokens: estimateTokens(text),
							priority: 1,
							metadata: { contentType: 'prose' as ContentType },
						});
					}

					// v6.2: Lint gate opt-out
					if (config.lint?.enabled === false) {
						const text =
							'[SWARM CONFIG] Lint gate is DISABLED. Skip lint check/fix in QA sequence.';
						candidates.push({
							id: `candidate-${idCounter++}`,
							kind: 'phase' as ContextCandidate['kind'],
							text,
							tokens: estimateTokens(text),
							priority: 1,
							metadata: { contentType: 'prose' as ContentType },
						});
					}

					// v6.2: Secretscan gate opt-out
					if (config.secretscan?.enabled === false) {
						const text =
							'[SWARM CONFIG] Secretscan gate is DISABLED. Skip secretscan in QA sequence.';
						candidates.push({
							id: `candidate-${idCounter++}`,
							kind: 'phase' as ContextCandidate['kind'],
							text,
							tokens: estimateTokens(text),
							priority: 1,
							metadata: { contentType: 'prose' as ContentType },
						});
					}

					// v6.13.2: Same-model adversarial detection
					if (config.adversarial_detection?.enabled !== false) {
						const activeAgent_adv_b = swarmState.activeAgent.get(
							_input.sessionID ?? '',
						);
						if (activeAgent_adv_b) {
							const baseRole_adv_b = stripKnownSwarmPrefix(activeAgent_adv_b);
							const pairs_adv_b = config.adversarial_detection?.pairs ?? [
								['coder', 'reviewer'],
							];
							const policy_adv_b =
								config.adversarial_detection?.policy ?? 'warn';
							for (const [agentA_b, agentB_b] of pairs_adv_b) {
								if (baseRole_adv_b === agentB_b) {
									const sharedModel_b = detectAdversarialPair(
										agentA_b,
										agentB_b,
										config,
									);
									if (sharedModel_b) {
										const warningText_b = formatAdversarialWarning(
											agentA_b,
											agentB_b,
											sharedModel_b,
											policy_adv_b,
										);
										if (policy_adv_b !== 'ignore') {
											candidates.push({
												id: `candidate-${idCounter++}`,
												kind: 'agent_context' as ContextCandidate['kind'],
												text: `[SWARM CONFIG] ${warningText_b}`,
												tokens: estimateTokens(warningText_b),
												priority: 2,
												metadata: { contentType: 'prose' as ContentType },
											});
										}
									}
								}
							}
						}
					}

					// v6.10: Parallel pre-check batch hint — architect-only
					const sessionId_preflight_b = _input.sessionID;
					const activeAgent_preflight_b = swarmState.activeAgent.get(
						sessionId_preflight_b ?? '',
					);
					const isArchitectForPreflight_b =
						!activeAgent_preflight_b ||
						stripKnownSwarmPrefix(activeAgent_preflight_b) === 'architect';

					if (isArchitectForPreflight_b) {
						const preflightPrefix_b = extractAgentPrefix(
							activeAgent_preflight_b,
						);
						const hintText_b =
							config.pipeline?.parallel_precheck !== false
								? `[SWARM HINT] Parallel pre-check enabled: call pre_check_batch(files, directory) after lint --fix and build_check to run lint:check + secretscan + sast_scan + quality_budget concurrently (max 4 parallel). Check gates_passed before calling ${preflightPrefix_b}reviewer.`
								: '[SWARM HINT] Parallel pre-check disabled: run lint:check → secretscan → sast_scan → quality_budget sequentially.';
						candidates.push({
							id: `candidate-${idCounter++}`,
							kind: 'phase' as ContextCandidate['kind'],
							text: hintText_b,
							tokens: estimateTokens(hintText_b),
							priority: 1,
							metadata: { contentType: 'prose' as ContentType },
						});
					}

					// v6.13.3: Retrospective injection — architect-only, phase-scoped Tier 1
					const sessionId_retro_b = _input.sessionID;
					const activeAgent_retro_b = swarmState.activeAgent.get(
						sessionId_retro_b ?? '',
					);
					const isArchitect_b =
						!activeAgent_retro_b ||
						stripKnownSwarmPrefix(activeAgent_retro_b) === 'architect';

					if (isArchitect_b) {
						// v6.x: Turbo/Full-Auto/Lean-Turbo banner injection for architect (Path B)
						const sessionIdBanner_b = _input.sessionID;
						if (
							hasActiveTurboMode(sessionIdBanner_b) ||
							hasActiveFullAuto(sessionIdBanner_b) ||
							hasActiveLeanTurbo(sessionIdBanner_b)
						) {
							if (hasActiveTurboMode(sessionIdBanner_b)) {
								candidates.push({
									id: `candidate-${idCounter++}`,
									kind: 'agent_context' as ContextCandidate['kind'],
									text: TURBO_MODE_BANNER,
									tokens: estimateTokens(TURBO_MODE_BANNER),
									priority: 1,
									metadata: { contentType: 'prose' as ContentType },
								});
							}
							if (hasActiveFullAuto(sessionIdBanner_b)) {
								candidates.push({
									id: `candidate-${idCounter++}`,
									kind: 'agent_context' as ContextCandidate['kind'],
									text: FULL_AUTO_BANNER,
									tokens: estimateTokens(FULL_AUTO_BANNER),
									priority: 1,
									metadata: { contentType: 'prose' as ContentType },
								});
							}
							if (hasActiveLeanTurbo(sessionIdBanner_b)) {
								candidates.push({
									id: `candidate-${idCounter++}`,
									kind: 'agent_context' as ContextCandidate['kind'],
									text: LEAN_TURBO_BANNER,
									tokens: estimateTokens(LEAN_TURBO_BANNER),
									priority: 1,
									metadata: { contentType: 'prose' as ContentType },
								});
							}
						}

						try {
							const currentPhaseNum_b = plan?.current_phase ?? 1;
							const retroText_b = await buildRetroInjection(
								directory,
								currentPhaseNum_b,
								plan?.title ?? undefined,
							);
							if (retroText_b) {
								const text =
									retroText_b.length <= 1600
										? retroText_b
										: `${retroText_b.substring(0, 1597)}...`;
								candidates.push({
									id: `candidate-${idCounter++}`,
									kind: 'phase' as ContextCandidate['kind'],
									text,
									tokens: estimateTokens(text),
									priority: 2,
									metadata: { contentType: 'prose' as ContentType },
								});
							}
						} catch {
							// Silently skip if evidence dir missing or unreadable
						}

						// v6.2: Soft compaction advisory
						if (mode_b !== 'DISCOVER') {
							const compactionConfig_b = config.compaction_advisory;
							if (compactionConfig_b?.enabled !== false && sessionId_retro_b) {
								const session_b =
									swarmState.agentSessions.get(sessionId_retro_b);
								if (session_b) {
									const totalToolCalls_b = Array.from(
										swarmState.toolAggregates.values(),
									).reduce((sum, agg) => sum + agg.count, 0);

									const thresholds_b = compactionConfig_b?.thresholds ?? [
										50, 75, 100, 125, 150,
									];
									const lastHint_b = session_b.lastCompactionHint || 0;

									for (const threshold of thresholds_b) {
										if (
											totalToolCalls_b >= threshold &&
											lastHint_b < threshold
										) {
											const totalToolCallsPlaceholder_b =
												'$' + '{totalToolCalls}';
											const messageTemplate_b =
												compactionConfig_b?.message ??
												`[SWARM HINT] Session has ${totalToolCallsPlaceholder_b} tool calls. Consider compacting at next phase boundary to maintain context quality.`;
											const compactionText = messageTemplate_b.replace(
												totalToolCallsPlaceholder_b,
												String(totalToolCalls_b),
											);
											candidates.push({
												id: `candidate-${idCounter++}`,
												kind: 'phase' as ContextCandidate['kind'],
												text: compactionText,
												tokens: estimateTokens(compactionText),
												priority: 1,
												metadata: { contentType: 'prose' as ContentType },
											});
											session_b.lastCompactionHint = threshold;
											break;
										}
									}
								}
							}
						}
					}

					// v6.13.3: Coder retrospective injection (Path B) — condensed Tier 1 lessons only
					const activeAgent_coder_b = swarmState.activeAgent.get(
						_input.sessionID ?? '',
					);
					const isCoder_b =
						activeAgent_coder_b &&
						stripKnownSwarmPrefix(activeAgent_coder_b) === 'coder';
					if (isCoder_b) {
						try {
							const currentPhaseNum_coder_b = plan?.current_phase ?? 1;
							const coderRetro_b = await buildCoderRetroInjection(
								directory,
								currentPhaseNum_coder_b,
							);
							if (coderRetro_b) {
								candidates.push({
									id: `candidate-${idCounter++}`,
									kind: 'agent_context' as ContextCandidate['kind'],
									text: coderRetro_b,
									tokens: estimateTokens(coderRetro_b),
									priority: 2,
									metadata: { contentType: 'prose' as ContentType },
								});
							}
						} catch {
							// Silently skip
						}
					}

					// v6.16: Language-specific coder constraints injection (Path B)
					if (isCoder_b) {
						const taskText_lang_b =
							plan && plan.migration_status !== 'migration_failed'
								? extractCurrentTaskFromPlan(plan)
								: null;
						const langConstraints_b =
							buildLanguageCoderConstraints(taskText_lang_b);
						if (langConstraints_b) {
							candidates.push({
								id: `candidate-${idCounter++}`,
								kind: 'agent_context' as ContextCandidate['kind'],
								text: langConstraints_b,
								tokens: estimateTokens(langConstraints_b),
								priority: 2,
								metadata: { contentType: 'prose' as ContentType },
							});
						}
					}

					// v6.16: Language-specific reviewer checklist injection (Path B)
					const isReviewer_b =
						activeAgent_coder_b &&
						stripKnownSwarmPrefix(activeAgent_coder_b) === 'reviewer';
					if (isReviewer_b) {
						const taskText_rev_b =
							plan && plan.migration_status !== 'migration_failed'
								? extractCurrentTaskFromPlan(plan)
								: null;
						const revChecklist_b =
							buildLanguageReviewerChecklist(taskText_rev_b);
						if (revChecklist_b) {
							candidates.push({
								id: `candidate-${idCounter++}`,
								kind: 'agent_context' as ContextCandidate['kind'],
								text: revChecklist_b,
								tokens: estimateTokens(revChecklist_b),
								priority: 2,
								metadata: { contentType: 'prose' as ContentType },
							});
						}
					}

					// v6.x: Semantic diff summary injection (Path B) — reviewer-only
					if (isReviewer_b) {
						try {
							const semDiffSessionId_b = _input.sessionID ?? '';
							const semDiffSession_b =
								swarmState.agentSessions.get(semDiffSessionId_b);
							const semDiffChanged_b =
								semDiffSession_b?.declaredCoderScope ?? [];
							if (semDiffChanged_b.length > 0) {
								const semDiffBlock_b = await buildSemanticDiffBlock(
									directory,
									semDiffChanged_b,
								);
								if (semDiffBlock_b) {
									candidates.push({
										id: `candidate-${idCounter++}`,
										kind: 'agent_context' as ContextCandidate['kind'],
										text: semDiffBlock_b,
										tokens: estimateTokens(semDiffBlock_b),
										priority: 2,
										metadata: { contentType: 'prose' as ContentType },
									});
								}
							}
						} catch {
							// Silently skip semantic diff injection failures
						}
					}

					// v6.46: Language-specific test-engineer constraints injection (Path B)
					const isTestEngineer_b =
						activeAgent_coder_b &&
						stripKnownSwarmPrefix(activeAgent_coder_b) === 'test_engineer';
					if (isTestEngineer_b) {
						const taskText_te_b =
							plan && plan.migration_status !== 'migration_failed'
								? extractCurrentTaskFromPlan(plan)
								: null;
						const testConstraints_b =
							buildLanguageTestConstraints(taskText_te_b);
						if (testConstraints_b) {
							candidates.push({
								id: `candidate-${idCounter++}`,
								kind: 'agent_context' as ContextCandidate['kind'],
								text: testConstraints_b,
								tokens: estimateTokens(testConstraints_b),
								priority: 2,
								metadata: { contentType: 'prose' as ContentType },
							});
						}
					}

					// v6.7: Decision drift detection — architect-only
					const automationCapabilities_b = config.automation?.capabilities;
					if (
						automationCapabilities_b?.decision_drift_detection === true &&
						sessionId_retro_b
					) {
						const activeAgentForDrift_b = swarmState.activeAgent.get(
							sessionId_retro_b ?? '',
						);
						const isArchitectForDrift_b =
							!activeAgentForDrift_b ||
							stripKnownSwarmPrefix(activeAgentForDrift_b) === 'architect';

						if (isArchitectForDrift_b) {
							try {
								const driftResult_b = await analyzeDecisionDrift(directory);
								if (driftResult_b.hasDrift) {
									const driftText_b = formatDriftForContext(driftResult_b);
									if (driftText_b) {
										candidates.push({
											id: `candidate-${idCounter++}`,
											kind: 'phase' as ContextCandidate['kind'],
											text: driftText_b,
											tokens: estimateTokens(driftText_b),
											priority: 2, // High priority for drift signals
											metadata: { contentType: 'prose' as ContentType },
										});
									}
								}
							} catch {
								// Silently skip if drift analysis fails
							}
						}
					}

					// Pre-flight binary advisory (architect-only) — mirrors Path A
					try {
						const activeAgent_binary_b = swarmState.activeAgent.get(
							_input.sessionID ?? '',
						);
						const isArchitect_binary_b =
							!activeAgent_binary_b ||
							stripKnownSwarmPrefix(activeAgent_binary_b) === 'architect';
						if (isArchitect_binary_b) {
							const { getBinaryReadinessAdvisory } = await import(
								'../services/tool-doctor.js'
							);
							const advisory_b = getBinaryReadinessAdvisory();
							if (advisory_b) {
								candidates.push({
									id: `candidate-${idCounter++}`,
									kind: 'agent_context' as ContextCandidate['kind'],
									text: advisory_b,
									tokens: estimateTokens(advisory_b),
									priority: 3,
									metadata: { contentType: 'prose' as ContentType },
								});
							}
						}
					} catch {
						// Non-blocking — binary check failure must not prevent system enhancement
					}

					// Environment profile injection (coder/test_engineer) — mirrors Path A
					try {
						const activeAgent_env_b = swarmState.activeAgent.get(
							_input.sessionID ?? '',
						);
						const agentBase_env_b = stripKnownSwarmPrefix(
							activeAgent_env_b ?? '',
						).toLowerCase();
						if (
							agentBase_env_b === 'coder' ||
							agentBase_env_b === 'test_engineer'
						) {
							const { ensureSessionEnvironment } = await import('../state.js');
							const { renderEnvironmentPrompt } = await import(
								'../environment/prompt-renderer.js'
							);
							const envSessionId_b = _input.sessionID ?? 'unknown';
							const profile_b = ensureSessionEnvironment(envSessionId_b);
							const audience_b =
								agentBase_env_b === 'coder' ? 'coder' : 'testengineer';
							const envPrompt_b = renderEnvironmentPrompt(
								profile_b,
								audience_b as 'coder' | 'testengineer',
							);
							candidates.push({
								id: `candidate-${idCounter++}`,
								kind: 'agent_context' as ContextCandidate['kind'],
								text: envPrompt_b,
								tokens: estimateTokens(envPrompt_b),
								priority: 2,
								metadata: { contentType: 'prose' as ContentType },
							});
						}
					} catch {
						// Non-blocking — environment injection failure must not break the hook
					}

					// Rank candidates
					const ranked = rankCandidates(candidates, effectiveConfig);

					// Inject in ranked order under budget
					for (const candidate of ranked) {
						if (injectedTokens + candidate.tokens > maxInjectionTokens) {
							continue; // Skip if over budget
						}
						output.system.push(candidate.text);
						injectedTokens += candidate.tokens;
					}

					// Context budget check - run after all other assembly, architect-only
					const userConfig_b = config.context_budget;
					const defaultConfig_b = {
						enabled: true,
						budgetTokens: 40000,
						warningPct: 70,
						criticalPct: 90,
						warningMode: 'once' as const,
						warningIntervalTurns: 20,
					};
					// Map schema config to service config format
					const contextBudgetConfig_b = userConfig_b
						? {
								// biome-ignore lint/suspicious/noExplicitAny: config spreading requires any
								...(defaultConfig_b as any),
								// biome-ignore lint/suspicious/noExplicitAny: config spreading requires any
								...(userConfig_b as any),
								warningPct: userConfig_b.warn_threshold
									? userConfig_b.warn_threshold * 100
									: defaultConfig_b.warningPct,
								criticalPct: userConfig_b.critical_threshold
									? userConfig_b.critical_threshold * 100
									: defaultConfig_b.criticalPct,
								budgetTokens:
									userConfig_b.model_limits?.default ??
									defaultConfig_b.budgetTokens,
							}
						: defaultConfig_b;

					if (contextBudgetConfig_b.enabled !== false) {
						const assembledSystemPrompt_b = output.system.join('\n');
						const budgetReport_b = await getContextBudgetReport(
							directory,
							assembledSystemPrompt_b,
							contextBudgetConfig_b,
						);
						swarmState.lastBudgetPct = budgetReport_b.budgetPct;
						telemetry.budgetUpdated(
							_input.sessionID ?? 'unknown',
							budgetReport_b.budgetPct,
							'architect',
						);
						const budgetWarning_b = await formatBudgetWarning(
							budgetReport_b,
							directory,
							contextBudgetConfig_b,
						);
						if (budgetWarning_b) {
							// Check if architect
							const sessionId_cb_b = _input.sessionID;
							const activeAgent_cb_b = sessionId_cb_b
								? swarmState.activeAgent.get(sessionId_cb_b)
								: null;
							const isArchitect_cb_b =
								!activeAgent_cb_b ||
								stripKnownSwarmPrefix(activeAgent_cb_b) === 'architect';
							if (isArchitect_cb_b) {
								output.system.push(`[FOR: architect]\n${budgetWarning_b}`);
							}
						}
					}
				} catch (error) {
					warn('System enhancer failed:', error);
				}
			},
		),
	};
}

/**
 * Extracts relevant cross-agent context based on the active agent.
 * Returns a truncated string of context relevant to the current agent.
 */
function extractAgentContext(
	contextContent: string,
	activeAgent: string,
	maxChars: number,
): string | null {
	// Find the ## Agent Activity section
	const activityMatch = contextContent.match(
		/## Agent Activity\n([\s\S]*?)(?=\n## |$)/,
	);
	if (!activityMatch) return null;

	const activitySection = activityMatch[1].trim();
	if (!activitySection || activitySection === 'No tool activity recorded yet.')
		return null;

	// Build context summary based on which agent is currently active
	// The mapping tells agents what context from other agents is relevant to them
	// Strip swarm prefix to get the base agent name (e.g., "enterprise_coder" -> "coder")
	const agentName = stripKnownSwarmPrefix(activeAgent);

	let contextSummary: string;
	switch (agentName) {
		case 'coder':
			contextSummary = `Recent tool activity for review context:\n${activitySection}`;
			break;
		case 'reviewer':
			contextSummary = `Tool usage to review:\n${activitySection}`;
			break;
		case 'test_engineer':
			contextSummary = `Tool activity for test context:\n${activitySection}`;
			break;
		default:
			contextSummary = `Agent activity summary:\n${activitySection}`;
			break;
	}

	// Truncate to max chars
	if (contextSummary.length > maxChars) {
		return `${contextSummary.substring(0, maxChars - 3)}...`;
	}

	return contextSummary;
}

/**
 * Architect operational mode derived from plan state.
 */
export type ArchitectMode =
	| 'DISCOVER'
	| 'PLAN'
	| 'EXECUTE'
	| 'PHASE-WRAP'
	| 'UNKNOWN';

/**
 * Detect the current architect operational mode based on plan state.
 *
 * @param directory - The project directory to check
 * @returns The current architect mode based on plan state
 */
export async function detectArchitectMode(
	directory: string,
): Promise<ArchitectMode> {
	try {
		const plan = await loadPlan(directory);

		if (!plan) {
			// No plan exists yet
			return 'DISCOVER';
		}

		// Check if there are any in-progress tasks
		const hasActiveTask =
			plan.phases?.some((phase) =>
				phase.tasks?.some((task) => task.status === 'in_progress'),
			) ?? false;

		if (hasActiveTask) {
			return 'EXECUTE';
		}

		// Check if all tasks are complete (no pending tasks)
		const hasPendingTask =
			plan.phases?.some((phase) =>
				phase.tasks?.some((task) => task.status === 'pending'),
			) ?? false;

		if (!hasPendingTask) {
			return 'PHASE-WRAP';
		}

		// Plan exists but no active task - still planning
		return 'PLAN';
	} catch (error) {
		// Fallback for any parsing errors
		warn(
			`Failed to detect architect mode: ${error instanceof Error ? error.message : String(error)}`,
		);
		return 'UNKNOWN';
	}
}
