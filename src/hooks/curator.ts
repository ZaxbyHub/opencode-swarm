/**
 * Curator core — file I/O for curator summary persistence.
 * Extended incrementally: filterPhaseEvents, checkPhaseCompliance,
 * runCuratorInit, runCuratorPhase, applyCuratorKnowledgeUpdates added in subsequent tasks.
 *
 * LLM delegation: runCuratorPhase and runCuratorInit accept an optional llmDelegate
 * callback for LLM-based analysis. When provided, the prepared data context is sent
 * to the explorer agent in CURATOR_PHASE/CURATOR_INIT mode for richer analysis.
 * When the delegate is absent or fails, falls back to data-only behavior.
 *
 * ## Curator Agent Dispatch Modes
 *
 * Curator agents are dispatched in two ways:
 *
 * 1. **Factory dispatch** (standard): Created via `createCuratorAgent` from curator-agent.ts,
 *    exposed through agents/index.ts. These appear in agent lists and are part of the
 *    standard agent factory.
 *
 * 2. **Hook dispatch** (internal): curator.ts imports CURATOR_INIT_PROMPT and CURATOR_PHASE_PROMPT
 *    from explorer.ts and dispatches curator analysis directly via hook callbacks. These
 *    hook-dispatched curators do NOT go through the standard agent factory and are NOT
 *    included in agent lists (e.g., AGENTS.md, agent discovery, the agent registry).
 *
 * This dual dispatch means agent lists are incomplete — they capture factory-dispatched
 * curators but omit hook-dispatched ones. This is by design for hook-internal operations.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	CURATOR_INIT_PROMPT,
	CURATOR_PHASE_PROMPT,
} from '../agents/explorer.js';
import { getGlobalEventBus } from '../background/event-bus.js';
import { getCanonicalAgentRole } from '../config/schema.js';
import { authorizeCuration } from '../knowledge/curation-policy.js';
import { alreadyCuratedThisGeneration } from '../knowledge/scan-cursor.js';
import { loadPlanJsonOnly } from '../plan/manager.js';
import {
	computeLearningMetrics,
	formatLearningSummary,
} from '../services/learning-metrics.js';
import {
	DEFAULT_SKILL_MIN_CONFIDENCE,
	listSkills,
	parseDraftFrontmatter,
	retireOrMarkStale,
	retireSkill,
} from '../services/skill-generator.js';
import {
	getSkillVersion,
	MAX_REVISION_CALLS_PER_PHASE,
	REVISION_VIOLATION_THRESHOLD,
	reviseSkill,
	type ViolationContext,
} from '../services/skill-reviser.js';
import { swarmState } from '../state.js';
import { bunWrite } from '../utils/bun-compat';
import * as logger from '../utils/logger';
import type {
	ComplianceObservation,
	CuratorConfig,
	CuratorInitResult,
	CuratorPhaseResult,
	CuratorSummary,
	KnowledgeRecommendation,
	PhaseDigestEntry,
} from './curator-types.js';
import { recordKnowledgeEvent } from './knowledge-events.js';
import {
	appendKnowledge,
	computeContentHash,
	dedupeCapped,
	getArchivedKnowledgeIds,
	readKnowledge,
	resolveSwarmKnowledgePath,
	transactFile,
	transactKnowledge,
} from './knowledge-store.js';
import type {
	KnowledgeConfig,
	SwarmKnowledgeEntry,
} from './knowledge-types.js';
import { isActiveStatus } from './knowledge-types.js';
import {
	appendUnactionable,
	validateActionability,
	validateLesson,
} from './knowledge-validator.js';
import { writeArchiveTombstoneAndInvalidateSkills } from './skill-invalidator.js';
import { readSkillUsageEntries } from './skill-usage-log.js';
import { readSwarmFileAsync, validateSwarmPath } from './utils.js';

/**
 * Optional LLM delegate callback type.
 * Takes a system prompt and user input, returns the LLM output text.
 * Used to delegate analysis to the explorer agent in CURATOR mode.
 */
export type CuratorLLMDelegate = (
	systemPrompt: string,
	userInput: string,
	signal?: AbortSignal,
) => Promise<string>;

/** Default timeout for curator LLM delegation calls (ms).
 * Used as fallback when config.llm_timeout_ms is not set. */
const DEFAULT_CURATOR_LLM_TIMEOUT_MS = 300_000;
const MAX_CURATOR_PHASE_DIGESTS = 50;
const MAX_CURATOR_COMPLIANCE_OBSERVATIONS = 200;
const MAX_CURATOR_RECOMMENDATIONS = 200;

// ============================================================================
// DI Seam — _internals (declared before functions that use it to avoid TDZ)
// ============================================================================

export const _internals = {
	parseKnowledgeRecommendations,
	parseKnowledgeRecommendationsWithDiagnostics,
	readCuratorSummary,
	writeCuratorSummary,
	appendCuratorRecommendation,
	mergeCuratorPhaseSummary,
	readCuratorSummaryState,
	writeCuratorSummaryState,
	transactFile,
	filterPhaseEvents,
	checkPhaseCompliance,
	normalizeAgentName,
	autoRetireSkills,
	readSkillUsageEntries,
	listSkills,
	parseDraftFrontmatter,
	retireOrMarkStale,
	retireSkill,
	getArchivedKnowledgeIds,
	readFileAsync: (filePath: string, encoding: string) =>
		import('node:fs/promises').then((fs) =>
			fs.readFile(filePath, encoding as BufferEncoding),
		),
	readKnowledge,
	reviseSkill,
	getSkillVersion,
	readLatestPostMortemDigest: (directory: string) =>
		readLatestPostMortemDigest(directory),
};

export interface RecommendationParseDiagnostic {
	section: 'OBSERVATIONS' | 'RECOMMENDATION_ID';
	line: string;
	reason: string;
}

const UUID_V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_ID_PREFIX = /^[0-9a-f]{8,}$/i;

export function normalizeRecommendationEntryIdToken(
	token: string,
): string | undefined {
	const trimmed = token.trim();
	if (UUID_V4.test(trimmed) || HEX_ID_PREFIX.test(trimmed)) return trimmed;
	return undefined;
}

function resolveKnowledgeRecommendationIds(
	recommendations: KnowledgeRecommendation[],
	entries: Pick<SwarmKnowledgeEntry, 'id' | 'status'>[],
): {
	recommendations: KnowledgeRecommendation[];
	diagnostics: RecommendationParseDiagnostic[];
} {
	const diagnostics: RecommendationParseDiagnostic[] = [];
	const activeEntries = entries.filter((entry) => isActiveStatus(entry.status));
	const resolved = recommendations
		.map((recommendation) => {
			const entryId =
				typeof recommendation.entry_id === 'string'
					? normalizeRecommendationEntryIdToken(recommendation.entry_id)
					: undefined;
			if (!entryId) return recommendation;
			if (activeEntries.some((entry) => entry.id === entryId)) {
				return { ...recommendation, entry_id: entryId };
			}

			const matches = activeEntries.filter((entry) =>
				entry.id.startsWith(entryId),
			);
			if (matches.length === 1) {
				return { ...recommendation, entry_id: matches[0].id };
			}

			diagnostics.push({
				section: 'RECOMMENDATION_ID',
				line: entryId,
				reason:
					matches.length === 0
						? 'entry_id not found'
						: 'entry_id prefix is ambiguous',
			});
			return null;
		})
		.filter((rec): rec is KnowledgeRecommendation => rec !== null);

	return { recommendations: resolved, diagnostics };
}

function capPhaseDigests(digests: PhaseDigestEntry[]): PhaseDigestEntry[] {
	return digests.slice(-MAX_CURATOR_PHASE_DIGESTS);
}

function capComplianceObservations(
	observations: ComplianceObservation[],
): ComplianceObservation[] {
	return observations.slice(-MAX_CURATOR_COMPLIANCE_OBSERVATIONS);
}

function canonicalizeJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalizeJson);
	if (value === null || typeof value !== 'object') return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, nested]) => [key, canonicalizeJson(nested)]),
	);
}

function recommendationIdentity(
	recommendation: KnowledgeRecommendation,
): string {
	const stable = { ...recommendation } as Record<string, unknown>;
	if (
		recommendation.action === 'promote' &&
		recommendation.lesson.startsWith('Hive promotion:')
	) {
		try {
			const parsedReason = JSON.parse(recommendation.reason) as unknown;
			if (
				parsedReason !== null &&
				typeof parsedReason === 'object' &&
				!Array.isArray(parsedReason)
			) {
				const { timestamp: _volatileTimestamp, ...stableReason } =
					parsedReason as Record<string, unknown>;
				stable.reason = stableReason;
			}
		} catch {
			// Keep an unparsable reason in the identity; only a recognized timestamp
			// field in a valid hive payload is intentionally volatile.
		}
	}
	return JSON.stringify(canonicalizeJson(stable));
}

function normalizeKnowledgeRecommendations(
	recommendations: unknown,
): KnowledgeRecommendation[] {
	const input = Array.isArray(recommendations)
		? recommendations.filter(
				(entry): entry is KnowledgeRecommendation =>
					entry !== null &&
					typeof entry === 'object' &&
					typeof (entry as { action?: unknown }).action === 'string' &&
					typeof (entry as { lesson?: unknown }).lesson === 'string' &&
					typeof (entry as { reason?: unknown }).reason === 'string',
			)
		: [];
	const seen = new Set<string>();
	const newestUnique: KnowledgeRecommendation[] = [];
	for (let index = input.length - 1; index >= 0; index--) {
		const recommendation = input[index];
		const identity = recommendationIdentity(recommendation);
		if (seen.has(identity)) continue;
		seen.add(identity);
		newestUnique.push(recommendation);
	}
	return newestUnique.reverse().slice(-MAX_CURATOR_RECOMMENDATIONS);
}

function buildDigestFromPhaseDigests(digests: PhaseDigestEntry[]): string {
	return digests
		.map((digest) => `### Phase ${digest.phase}\n${digest.summary}`)
		.join('\n\n');
}

/**
 * Auto-retire generated skills whose violation rate exceeds 30% or
 * whose source knowledge entries are all archived.
 *
 * Also marks skills stale when some (but not all) source knowledge entries
 * are archived.
 *
 * Non-blocking: errors are caught and logged but never propagated.
 * Returns an array of observation strings to include in the phase digest.
 */
async function autoRetireSkills(
	directory: string,
	_curatorKnowledgePath: string,
	excludeSlugs?: ReadonlySet<string>,
): Promise<string[]> {
	const observations: string[] = [];
	try {
		const skillListResult = await _internals.listSkills(directory);
		const usageEntries = _internals.readSkillUsageEntries(directory);
		const allArchivedIds = await _internals.getArchivedKnowledgeIds(directory);

		for (const active of skillListResult.active) {
			if (excludeSlugs?.has(active.slug)) continue;
			const skillUsage = usageEntries.filter((e) => {
				let p = e.skillPath;
				if (p.startsWith('file:')) p = p.slice(5);
				// Normalize both paths to forward slashes for comparison
				const normalizedUsage = p.replace(/\\/g, '/');
				const normalizedActive = active.path.replace(/\\/g, '/');
				// Exact match, or suffix match for relative vs absolute paths
				if (normalizedUsage === normalizedActive) return true;
				if (normalizedActive.endsWith(`/${normalizedUsage}`)) return true;
				if (normalizedUsage.endsWith(`/${normalizedActive}`)) return true;
				return false;
			});

			const violations = skillUsage.filter(
				(e) => e.complianceVerdict === 'violated',
			).length;
			const violationRate =
				skillUsage.length > 0 ? violations / skillUsage.length : 0;

			// #1848 review PRR-006: skill auto-retirement is a SKILL-lifecycle
			// action, not a knowledge-entry curation. A skill slug has no
			// producer / revision / entry_id, so authorizeCuration — which gates
			// destructive KNOWLEDGE-ENTRY actions — does not type-fit here, and
			// routing it through the policy would be a vacuous always-authorize.
			// Both retire triggers remain safe under issue #1848 criterion #8:
			//  (1) the violation-rate trigger below acts on skill compliance
			//      health and touches no knowledge entry;
			//  (2) the archived-source trigger further down fires only AFTER the
			//      source knowledge entries were archived — and that archival is
			//      itself already routed through authorizeCuration (the curator
			//      apply path and the knowledge_archive tool).
			// Skill retirement is therefore a downstream consequence of an
			// already-authorized knowledge action, never an independent bypass.
			if (violationRate > 0.3) {
				const reason = `auto-retire: violation rate ${(violationRate * 100).toFixed(0)}% exceeds 30% threshold`;
				await _internals.retireSkill(directory, active.slug, reason);
				observations.push(`Skill '${active.slug}' auto-retired: ${reason}`);
				logger.warn(`[curator] ${observations[observations.length - 1]}`);
				continue;
			}

			let archivedSourceMatched = false;
			if (allArchivedIds.size > 0) {
				try {
					const content = await _internals.readFileAsync(active.path, 'utf-8');
					const sourceIds =
						_internals.parseDraftFrontmatter(content)?.sourceKnowledgeIds ?? [];
					archivedSourceMatched = sourceIds.some((id) =>
						allArchivedIds.has(id),
					);
				} catch {
					archivedSourceMatched = false;
				}
			}

			if (archivedSourceMatched) {
				// Delegate archive-based retirement/stale decision to retireOrMarkStale
				const result = await _internals.retireOrMarkStale(
					directory,
					path.dirname(active.path),
					allArchivedIds,
				);
				if (result.action === 'retire') {
					observations.push(
						`Skill '${active.slug}' auto-retired: all source knowledge entries archived`,
					);
					logger.warn(`[curator] ${observations[observations.length - 1]}`);
				} else if (result.action === 'stale') {
					observations.push(
						`Skill '${active.slug}' marked stale: some source knowledge entries archived`,
					);
					logger.warn(`[curator] ${observations[observations.length - 1]}`);
				}
			}
		}
	} catch (autoRetireErr) {
		// Non-blocking — log but don't fail curator
		logger.warn(
			`[curator] auto-retire health check failed: ${autoRetireErr instanceof Error ? autoRetireErr.message : String(autoRetireErr)}`,
		);
	}
	return observations;
}

/**
 * Parse OBSERVATIONS section from curator LLM output.
 * Expected format per line: "- entry <uuid> (<observable>): [text]"
 * Observable types: appears high-confidence, appears stale, could be tighter,
 * contradicts project state, new candidate
 * Action hints are extracted from parenthetical directives like "(suggests boost confidence, mark hive_eligible)"
 */
export function parseKnowledgeRecommendations(
	llmOutput: string,
): KnowledgeRecommendation[] {
	return parseKnowledgeRecommendationsWithDiagnostics(llmOutput)
		.recommendations;
}

export function parseKnowledgeRecommendationsWithDiagnostics(
	llmOutput: string,
): {
	recommendations: KnowledgeRecommendation[];
	diagnostics: RecommendationParseDiagnostic[];
} {
	const recommendations: KnowledgeRecommendation[] = [];
	const diagnostics: RecommendationParseDiagnostic[] = [];

	// Parse OBSERVATIONS: section (legacy format: "- entry <uuid> (parenthetical): text")
	const obsSection = llmOutput.match(
		/OBSERVATIONS:\s*\n([\s\S]*?)(?:\n\n|\n[A-Z_]+:|$)/,
	);
	if (obsSection) {
		const lines = obsSection[1].split('\n');
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed.startsWith('-')) continue;

			// Match "- entry <uuid> (observable): text" or "- entry <uuid> (observable, directive hint): text"
			const match = trimmed.match(/^-\s+entry\s+(\S+)\s+\(([^)]+)\):\s+(.+)$/i);
			if (!match) {
				const newCandidate = trimmed.match(/^-\s+new candidate:\s+(.+)$/i);
				if (newCandidate) {
					const text = newCandidate[1].trim().replace(/\s+\([^)]+\)$/, '');
					recommendations.push({
						action: 'promote',
						entry_id: undefined,
						lesson: text,
						reason: text,
					});
					continue;
				}
				const staleEntry = trimmed.match(
					/^-\s+entry\s+(\S+)\s+appears stale:\s+(.+)$/i,
				);
				if (staleEntry) {
					const uuid = staleEntry[1];
					const text = staleEntry[2].trim().replace(/\s+\([^)]+\)$/, '');
					recommendations.push({
						action: 'archive',
						entry_id: normalizeRecommendationEntryIdToken(uuid),
						lesson: text,
						reason: text,
					});
					continue;
				}
				diagnostics.push({
					section: 'OBSERVATIONS',
					line: trimmed,
					reason: 'expected "- entry <uuid|new> (<observable>): <text>"',
				});
				continue;
			}

			const uuid = match[1];
			const parenthetical = match[2];
			const text = match[3].trim().replace(/\s+\([^)]+\)$/, '');

			const entryId =
				uuid === 'new' ? undefined : normalizeRecommendationEntryIdToken(uuid);

			// Extract action hint from parenthetical content
			let action: KnowledgeRecommendation['action'] = 'rewrite';
			const lowerParenthetical = parenthetical.toLowerCase();

			if (
				lowerParenthetical.includes('suggests boost confidence') ||
				lowerParenthetical.includes('mark hive_eligible') ||
				lowerParenthetical.includes('appears high-confidence')
			) {
				action = 'promote';
			} else if (
				lowerParenthetical.includes('suggests archive') ||
				lowerParenthetical.includes('appears stale')
			) {
				action = 'archive';
			} else if (lowerParenthetical.includes('contradicts project state')) {
				action = 'flag_contradiction';
			} else if (
				lowerParenthetical.includes('suggests rewrite') ||
				lowerParenthetical.includes('could be tighter')
			) {
				action = 'rewrite';
			} else if (lowerParenthetical.includes('new candidate')) {
				action = 'promote';
			}

			recommendations.push({
				action,
				entry_id: entryId,
				lesson: text,
				reason: text,
			});
		}
	}

	return { recommendations, diagnostics };
}

/**
 * v2: Strict-JSON parser for the new curator output blocks.
 *
 * Curator prompts may now emit JSON-fenced blocks like:
 *
 * ```json knowledge_application_findings
 * [{ "knowledge_id": "...", "expected_behavior": "...", ... }]
 * ```
 *
 * ```json skill_candidates
 * [{ "slug": "...", "title": "...", ... }]
 * ```
 *
 * Malformed JSON or unexpected types are skipped with diagnostics: no knowledge
 * or skill writes happen when curator output is malformed.
 */
export interface StructuredCuratorDiagnostic {
	block: 'knowledge_application_findings' | 'skill_candidates';
	reason:
		| 'malformed_json'
		| 'expected_array'
		| 'invalid_finding'
		| 'invalid_skill_candidate';
	index?: number;
	detail?: string;
}

export function parseStructuredCuratorBlocks(llmOutput: string): {
	findings: import('./curator-types.js').KnowledgeApplicationFinding[];
	candidates: import('./curator-types.js').SkillCandidate[];
	diagnostics: StructuredCuratorDiagnostic[];
} {
	const out: {
		findings: import('./curator-types.js').KnowledgeApplicationFinding[];
		candidates: import('./curator-types.js').SkillCandidate[];
		diagnostics: StructuredCuratorDiagnostic[];
	} = { findings: [], candidates: [], diagnostics: [] };
	if (!llmOutput || typeof llmOutput !== 'string') return out;

	const fences =
		/```(?:json|jsonc)?\s+(knowledge_application_findings|skill_candidates)\s*\n([\s\S]*?)\n```/g;
	for (const m of llmOutput.matchAll(fences)) {
		const kind = m[1] as StructuredCuratorDiagnostic['block'];
		const body = m[2];
		try {
			const parsed = JSON.parse(body);
			if (!Array.isArray(parsed)) {
				out.diagnostics.push({
					block: kind,
					reason: 'expected_array',
				});
				continue;
			}
			if (kind === 'knowledge_application_findings') {
				for (const [index, item] of parsed.entries()) {
					if (!item || typeof item !== 'object') {
						out.diagnostics.push({
							block: kind,
							reason: 'invalid_finding',
							index,
						});
						continue;
					}
					const knowledge_id = (item as { knowledge_id?: unknown })
						.knowledge_id;
					const verdict = (item as { verdict?: unknown }).verdict;
					if (
						typeof knowledge_id !== 'string' ||
						typeof verdict !== 'string' ||
						!['applied', 'ignored', 'violated', 'not_applicable'].includes(
							verdict,
						)
					) {
						out.diagnostics.push({
							block: kind,
							reason: 'invalid_finding',
							index,
						});
						continue;
					}
					const expected = String(
						(item as { expected_behavior?: unknown }).expected_behavior ?? '',
					).slice(0, 500);
					const observed = String(
						(item as { observed_behavior?: unknown }).observed_behavior ?? '',
					).slice(0, 500);
					// #1821: dedupe (case-insensitive, first casing wins) before the
					// cap so duplicate refs cannot evict distinct ones. No per-item
					// truncation here — matching this site's existing behavior.
					const refs = dedupeCapped(
						(item as { evidence_refs?: unknown }).evidence_refs,
						{ cap: 20 },
					);
					out.findings.push({
						knowledge_id,
						expected_behavior: expected,
						observed_behavior: observed,
						verdict: verdict as
							| 'applied'
							| 'ignored'
							| 'violated'
							| 'not_applicable',
						evidence_refs: refs,
					});
				}
			} else if (kind === 'skill_candidates') {
				for (const [index, item] of parsed.entries()) {
					if (!item || typeof item !== 'object') {
						out.diagnostics.push({
							block: kind,
							reason: 'invalid_skill_candidate',
							index,
						});
						continue;
					}
					const slug = (item as { slug?: unknown }).slug;
					const title = (item as { title?: unknown }).title;
					if (typeof slug !== 'string' || typeof title !== 'string') {
						out.diagnostics.push({
							block: kind,
							reason: 'invalid_skill_candidate',
							index,
						});
						continue;
					}
					const ids = Array.isArray(
						(item as { source_knowledge_ids?: unknown }).source_knowledge_ids,
					)
						? (
								(
									item as { source_knowledge_ids: unknown[] }
								).source_knowledge_ids.filter(
									(s) => typeof s === 'string',
								) as string[]
							).slice(0, 50)
						: [];
					if (ids.length === 0) {
						out.diagnostics.push({
							block: kind,
							reason: 'invalid_skill_candidate',
							index,
						});
						continue;
					}
					out.candidates.push({
						slug: String(slug).slice(0, 64),
						title: String(title).slice(0, 200),
						source_knowledge_ids: ids,
						trigger: String(
							(item as { trigger?: unknown }).trigger ?? '',
						).slice(0, 200),
						required_procedure: arrayOfStrings(
							(item as { required_procedure?: unknown }).required_procedure,
						),
						forbidden_shortcuts: arrayOfStrings(
							(item as { forbidden_shortcuts?: unknown }).forbidden_shortcuts,
						),
						target_agents: arrayOfStrings(
							(item as { target_agents?: unknown }).target_agents,
						),
						reviewer_checks: arrayOfStrings(
							(item as { reviewer_checks?: unknown }).reviewer_checks,
						),
						confidence: clampConf(
							(item as { confidence?: unknown }).confidence,
						),
						reason: String((item as { reason?: unknown }).reason ?? '').slice(
							0,
							280,
						),
					});
				}
			}
		} catch (err) {
			out.diagnostics.push({
				block: kind,
				reason: 'malformed_json',
				detail: err instanceof Error ? err.message.slice(0, 200) : String(err),
			});
		}
	}
	return out;
}

// #1821: truncate → dedupe (case-insensitive, first casing wins) → cap, in
// that order, so duplicates cannot evict distinct values off the end.
function arrayOfStrings(v: unknown): string[] {
	return dedupeCapped(v, { cap: 20, itemMaxChars: 200 });
}

function readLatestPostMortemDigest(directory: string): string | null {
	try {
		const swarmDir = path.join(directory, '.swarm');
		if (!fs.existsSync(swarmDir)) return null;
		const candidates = fs
			.readdirSync(swarmDir)
			.filter((name) => /^post-mortem-[^/\\]+\.md$/.test(name))
			.map((name) => {
				const filePath = path.join(swarmDir, name);
				return { name, filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
			})
			.sort((a, b) => b.mtimeMs - a.mtimeMs);
		const latest = candidates[0];
		if (!latest) return null;
		const content = fs.readFileSync(latest.filePath, 'utf-8');
		const summary = content.match(
			/SUMMARY:\s*\n([\s\S]*?)(?:\n[A-Z_]+:|\n##|$)/,
		);
		const body = (summary?.[1]?.trim() || content.slice(0, 1500)).slice(
			0,
			1500,
		);
		return `${latest.name}\n${body}`;
	} catch {
		return null;
	}
}

function clampConf(v: unknown): number {
	if (typeof v !== 'number') return 0.85;
	if (v < 0) return 0;
	if (v > 1) return 1;
	return v;
}

interface CuratorSummaryFileState {
	summary: CuratorSummary | null;
	dirty: boolean;
}

interface CuratorSummaryMutation<T> {
	next?: CuratorSummary | null;
	result: T;
}

interface CuratorSummaryTransaction<T> {
	invoked: boolean;
	result: T | undefined;
}

function normalizeCuratorSummary(summary: CuratorSummary): {
	summary: CuratorSummary;
	changed: boolean;
} {
	const recommendations = normalizeKnowledgeRecommendations(
		(summary as { knowledge_recommendations?: unknown })
			.knowledge_recommendations,
	);
	const original = Array.isArray(summary.knowledge_recommendations)
		? summary.knowledge_recommendations
		: [];
	const changed =
		!Array.isArray(summary.knowledge_recommendations) ||
		original.length !== recommendations.length ||
		original.some((entry, index) => entry !== recommendations[index]);
	return {
		summary: changed
			? { ...summary, knowledge_recommendations: recommendations }
			: summary,
		changed,
	};
}

async function readCuratorSummaryState(
	filePath: string,
): Promise<CuratorSummaryFileState> {
	let content: string;
	try {
		content = await fs.promises.readFile(filePath, 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return { summary: null, dirty: false };
		}
		throw error;
	}

	return parseCuratorSummaryContent(content);
}

function parseCuratorSummaryContent(content: string): CuratorSummaryFileState {
	try {
		const parsed = JSON.parse(content) as CuratorSummary;
		if (parsed.schema_version !== 1) {
			logger.warn(
				`Curator summary has unsupported schema version: ${parsed.schema_version}. Expected 1.`,
			);
			return { summary: null, dirty: false };
		}
		const normalized = normalizeCuratorSummary(parsed);
		return { summary: normalized.summary, dirty: normalized.changed };
	} catch {
		logger.warn('Failed to parse curator-summary.json: invalid JSON');
		return { summary: null, dirty: false };
	}
}

async function writeCuratorSummaryState(
	filePath: string,
	state: CuratorSummaryFileState,
): Promise<void> {
	if (!state.summary) return;
	await bunWrite(filePath, JSON.stringify(state.summary, null, 2));
}

async function transactCuratorSummary<T>(
	directory: string,
	mutate: (summary: CuratorSummary | null) => CuratorSummaryMutation<T>,
): Promise<CuratorSummaryTransaction<T>> {
	const resolvedPath = validateSwarmPath(directory, 'curator-summary.json');
	let invoked = false;
	let mutationResult: T | undefined;
	await _internals.transactFile<CuratorSummaryFileState>(
		resolvedPath,
		_internals.readCuratorSummaryState,
		_internals.writeCuratorSummaryState,
		(state) => {
			invoked = true;
			const mutation = mutate(state.summary);
			mutationResult = mutation.result;
			if (mutation.next === null) return null;
			const candidate = mutation.next ?? state.summary;
			if (!candidate) return null;
			const normalized = normalizeCuratorSummary(candidate).summary;
			const explicitlyChanged =
				mutation.next !== undefined &&
				JSON.stringify(normalized) !== JSON.stringify(state.summary);
			if (!state.dirty && !explicitlyChanged) return null;
			return { summary: normalized, dirty: false };
		},
	);
	return { invoked, result: mutationResult };
}

/**
 * Read and normalize curator summary from .swarm/curator-summary.json.
 * Legacy recommendation spam is deduplicated and capped on first successful read.
 * Cleanup failure is fail-open: callers still receive the normalized in-memory state.
 */
export async function readCuratorSummary(
	directory: string,
): Promise<CuratorSummary | null> {
	const content = await readSwarmFileAsync(directory, 'curator-summary.json');
	if (content === null) return null;
	const initial = parseCuratorSummaryContent(content);
	if (!initial.summary || !initial.dirty) return initial.summary;

	let normalized: CuratorSummary | null = initial.summary;
	try {
		await transactCuratorSummary(directory, (summary) => {
			if (summary) normalized = summary;
			return { result: normalized };
		});
	} catch (error) {
		logger.warn(
			`Failed to persist curator-summary cleanup: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return normalized;
}

/** Write a fully normalized curator summary under the shared summary lock. */
export async function writeCuratorSummary(
	directory: string,
	summary: CuratorSummary,
): Promise<void> {
	const transaction = await transactCuratorSummary(directory, () => ({
		next: summary,
		result: undefined,
	}));
	if (!transaction.invoked) {
		throw new Error('Failed to persist curator summary');
	}
}

/**
 * Append one recommendation through the shared locked persistence boundary.
 * Returns false when no summary exists or no persisted representation changes.
 * A semantic duplicate can return true when it replaces the retained representative
 * under the newest-wins policy (for example, a hive event with a newer timestamp).
 */
export async function appendCuratorRecommendation(
	directory: string,
	recommendation: KnowledgeRecommendation,
): Promise<boolean> {
	const transaction = await transactCuratorSummary(directory, (summary) => {
		if (!summary) return { next: null, result: false };
		const recommendations = normalizeKnowledgeRecommendations([
			...normalizeKnowledgeRecommendations(summary.knowledge_recommendations),
			recommendation,
		]);
		const current = normalizeKnowledgeRecommendations(
			summary.knowledge_recommendations,
		);
		const changed =
			current.length !== recommendations.length ||
			current.some((entry, index) => entry !== recommendations[index]);
		if (!changed) return { result: false };
		return {
			next: {
				...summary,
				last_updated: new Date().toISOString(),
				knowledge_recommendations: recommendations,
			},
			result: true,
		};
	});
	return transaction.invoked ? (transaction.result ?? false) : false;
}

interface CuratorPhaseSummaryMerge {
	phase: number;
	phaseDigest: PhaseDigestEntry;
	complianceObservations: ComplianceObservation[];
	knowledgeRecommendations: KnowledgeRecommendation[];
	sessionId: string;
	timestamp: string;
}

/** Merge a phase result against the latest on-disk summary under the shared lock. */
export async function mergeCuratorPhaseSummary(
	directory: string,
	merge: CuratorPhaseSummaryMerge,
): Promise<boolean> {
	const transaction = await transactCuratorSummary(directory, (current) => {
		if (
			current?.phase_digests?.some((digest) => digest.phase === merge.phase)
		) {
			return { result: false };
		}
		if (current) {
			const phaseDigests = capPhaseDigests([
				...(Array.isArray(current.phase_digests) ? current.phase_digests : []),
				merge.phaseDigest,
			]);
			return {
				next: {
					...current,
					last_updated: merge.timestamp,
					last_phase_covered: Math.max(
						typeof current.last_phase_covered === 'number'
							? current.last_phase_covered
							: 0,
						merge.phase,
					),
					digest: buildDigestFromPhaseDigests(phaseDigests),
					phase_digests: phaseDigests,
					compliance_observations: capComplianceObservations([
						...(Array.isArray(current.compliance_observations)
							? current.compliance_observations
							: []),
						...merge.complianceObservations,
					]),
					knowledge_recommendations: normalizeKnowledgeRecommendations([
						...normalizeKnowledgeRecommendations(
							current.knowledge_recommendations,
						),
						...merge.knowledgeRecommendations,
					]),
				},
				result: true,
			};
		}

		const phaseDigests = capPhaseDigests([merge.phaseDigest]);
		return {
			next: {
				schema_version: 1,
				session_id: merge.sessionId,
				last_updated: merge.timestamp,
				last_phase_covered: merge.phase,
				digest: buildDigestFromPhaseDigests(phaseDigests),
				phase_digests: phaseDigests,
				compliance_observations: capComplianceObservations(
					merge.complianceObservations,
				),
				knowledge_recommendations: normalizeKnowledgeRecommendations(
					merge.knowledgeRecommendations,
				),
			},
			result: true,
		};
	});
	if (!transaction.invoked) {
		throw new Error('Failed to persist curator phase summary');
	}
	return transaction.result ?? false;
}

/**
 * Normalize an agent name to its canonical role.
 *
 * v2 (Phase F′ remediation): use the repository's canonical resolver
 * `getCanonicalAgentRole`, registry-aware. When the generated-agent registry
 * is populated (post plugin-init), an arbitrary swarm id like
 * `banana_coder` resolves to `coder` IFF it appears in the registry.
 * Pre-init (registry empty), the resolver falls back to a permissive
 * suffix-match against ALL_AGENT_NAMES — preserving today's behaviour for
 * arbitrary user prefixes without the hard-coded
 * `(mega|paid|local|lowtier|modelrelay)_` whitelist.
 *
 * Lower-casing is preserved for backwards compatibility with the prior
 * comparator code paths in this file.
 */
function normalizeAgentName(name: string): string {
	const registry =
		swarmState.generatedAgentNames.length > 0
			? swarmState.generatedAgentNames
			: undefined;
	return getCanonicalAgentRole(name, registry).toLowerCase();
}

/**
 * Filter events from JSONL by phase or timestamp.
 * @param eventsJsonl - Raw JSONL string of events
 * @param phase - Phase number to filter by
 * @param sinceTimestamp - Optional ISO 8601 timestamp to filter events after
 * @returns Array of parsed event objects
 */
export function filterPhaseEvents(
	eventsJsonl: string,
	phase: number,
	sinceTimestamp?: string,
): object[] {
	const lines = eventsJsonl.split('\n');
	const filtered: object[] = [];

	for (const line of lines) {
		if (!line.trim()) continue;

		try {
			const event = JSON.parse(line);

			if (sinceTimestamp) {
				// Include all events after the timestamp
				if (event.timestamp > sinceTimestamp) {
					filtered.push(event);
				}
			} else {
				// Filter by phase
				if ((event as Record<string, unknown>).phase === phase) {
					filtered.push(event);
				}
			}
		} catch {
			logger.warn('filterPhaseEvents: skipping malformed line');
		}
	}

	return filtered;
}

/**
 * Check compliance for a phase based on events and dispatched agents.
 * @param phaseEvents - Array of events for the phase
 * @param agentsDispatched - List of agent names that were dispatched
 * @param requiredAgents - List of required agent names for this phase
 * @param phase - Phase number
 * @returns Array of compliance observations
 */
export function checkPhaseCompliance(
	phaseEvents: object[],
	agentsDispatched: string[],
	requiredAgents: string[],
	phase: number,
): ComplianceObservation[] {
	const observations: ComplianceObservation[] = [];
	const timestamp = new Date().toISOString();

	// Check 1: Missing required agents
	for (const agent of requiredAgents) {
		const normalizedAgent = _internals.normalizeAgentName(agent);
		const isDispatched = agentsDispatched.some(
			(a) => _internals.normalizeAgentName(a) === normalizedAgent,
		);

		if (!isDispatched) {
			observations.push({
				phase,
				timestamp,
				type: 'workflow_deviation',
				severity: 'warning',
				description: `Agent '${agent}' required but not dispatched in phase ${phase}`,
			});
		}
	}

	// Check 2: Reviewer after every coder delegation

	const coderDelegations: { event: object; index: number }[] = [];
	const reviewerDelegations: { event: object; index: number }[] = [];

	for (let i = 0; i < phaseEvents.length; i++) {
		const e = phaseEvents[i];
		try {
			if ((e as Record<string, unknown>).type === 'agent.delegation') {
				const agent = (e as Record<string, unknown>).agent;
				if (agent && typeof agent === 'string') {
					const normalized = _internals.normalizeAgentName(agent);
					if (normalized === 'coder') {
						coderDelegations.push({ event: e, index: i });
					} else if (normalized === 'reviewer') {
						reviewerDelegations.push({ event: e, index: i });
					}
				}
			}
		} catch {
			// Skip events that fail access
		}
	}

	for (const coderEvent of coderDelegations) {
		const hasSubsequentReviewer = reviewerDelegations.some(
			(r) => r.index > coderEvent.index,
		);

		if (!hasSubsequentReviewer) {
			observations.push({
				phase,
				timestamp,
				type: 'missing_reviewer',
				severity: 'warning',
				description: `Coder delegation in phase ${phase} has no subsequent reviewer delegation`,
			});
		}
	}

	// Check 3: Retrospective before phase_complete
	let phaseCompleteIndex = -1;
	let retroIndex = -1;

	for (let i = 0; i < phaseEvents.length; i++) {
		const e = phaseEvents[i];
		try {
			// v2 baseline fix: some emitters use {type: ...} and some use {event: ...}.
			// Accept either so phase events emitted under the legacy 'event' key are
			// still recognised (e.g. when phase_complete writes via different paths).
			const eventType =
				(e as Record<string, unknown>).type ??
				(e as Record<string, unknown>).event;
			const evidenceType = (e as Record<string, unknown>).evidence_type;

			if (
				typeof eventType === 'string' &&
				(eventType === 'phase_complete' || eventType === 'phase.complete')
			) {
				phaseCompleteIndex = i;
			}
			if (
				(typeof eventType === 'string' &&
					eventType === 'retrospective.written') ||
				(typeof evidenceType === 'string' && evidenceType === 'retrospective')
			) {
				retroIndex = i;
			}
		} catch {
			// Skip events that fail access
		}
	}

	if (phaseCompleteIndex !== -1 && retroIndex === -1) {
		observations.push({
			phase,
			timestamp,
			type: 'missing_retro',
			severity: 'warning',
			description: `Phase ${phase} completed without retrospective evidence`,
		});
	}

	// Check 4: SME after domain detection
	const domainDetectionEvents: { event: object; index: number }[] = [];
	const smeDelegations: { event: object; index: number }[] = [];

	for (let i = 0; i < phaseEvents.length; i++) {
		const e = phaseEvents[i];
		try {
			if ((e as Record<string, unknown>).type === 'domains.detected') {
				domainDetectionEvents.push({ event: e, index: i });
			}
			if (
				(e as Record<string, unknown>).type === 'agent.delegation' &&
				(e as Record<string, unknown>).agent
			) {
				const agent = (e as Record<string, unknown>).agent;
				if (agent && typeof agent === 'string') {
					const normalized = _internals.normalizeAgentName(agent);
					if (normalized === 'sme') {
						smeDelegations.push({ event: e, index: i });
					}
				}
			}
		} catch {
			// Skip events that fail access
		}
	}

	for (const domainEvent of domainDetectionEvents) {
		const hasSubsequentSme = smeDelegations.some(
			(s) => s.index > domainEvent.index,
		);

		if (!hasSubsequentSme) {
			observations.push({
				phase,
				timestamp,
				type: 'missing_sme',
				severity: 'info',
				description: `Domains detected in phase ${phase} but no SME consultation found`,
			});
		}
	}

	return observations;
}

/**
 * Prepare curator init data: reads prior summary, knowledge entries, and context.md.
 * When an llmDelegate is provided, delegates to the explorer agent in CURATOR_INIT mode
 * for LLM-based analysis that enhances the data-only briefing.
 * @param directory - The workspace directory
 * @param config - Curator configuration
 * @param llmDelegate - Optional LLM delegate for enhanced analysis
 * @returns CuratorInitResult with briefing text, contradictions, and stats
 */
export async function runCuratorInit(
	directory: string,
	config: CuratorConfig,
	llmDelegate?: CuratorLLMDelegate,
): Promise<CuratorInitResult> {
	try {
		// 1. Read prior curator summary
		const priorSummary = await _internals.readCuratorSummary(directory);

		// 2. Read high-confidence knowledge entries
		const knowledgePath = resolveSwarmKnowledgePath(directory);
		const allEntries = await readKnowledge<SwarmKnowledgeEntry>(knowledgePath);
		const highConfidenceEntries = allEntries.filter(
			(e) =>
				typeof e.confidence === 'number' &&
				e.confidence >= config.min_knowledge_confidence,
		);

		// 3. Read context.md
		const contextMd = await readSwarmFileAsync(directory, 'context.md');

		// 4. Build briefing text from available data
		const briefingParts: string[] = [];

		if (priorSummary) {
			briefingParts.push(
				`## Prior Session Summary (Phase ${priorSummary.last_phase_covered})`,
			);
			briefingParts.push(priorSummary.digest);

			if (
				priorSummary.compliance_observations.length > 0 &&
				!config.suppress_warnings
			) {
				briefingParts.push('\n## Compliance Observations');
				for (const obs of priorSummary.compliance_observations) {
					briefingParts.push(
						`- [${obs.severity.toUpperCase()}] Phase ${obs.phase}: ${obs.description}`,
					);
				}
			}

			if (priorSummary.knowledge_recommendations.length > 0) {
				briefingParts.push('\n## Knowledge Recommendations');
				for (const rec of priorSummary.knowledge_recommendations) {
					briefingParts.push(`- ${rec.action}: ${rec.lesson} (${rec.reason})`);
				}
			}
		} else {
			briefingParts.push('## First Session — No Prior Summary');
			briefingParts.push(
				'This is the first curator run for this project. No prior phase data available.',
			);
		}

		if (highConfidenceEntries.length > 0) {
			briefingParts.push('\n## High-Confidence Knowledge');
			for (const entry of highConfidenceEntries.slice(0, 10)) {
				// Cap at 10 entries to stay within token budget
				const lesson =
					typeof entry.lesson === 'string'
						? entry.lesson
						: JSON.stringify(entry.lesson);
				briefingParts.push(`- ${lesson}`);
			}
		}

		if (contextMd) {
			briefingParts.push('\n## Context Summary');
			// Truncate to stay within token budget (approx 4 chars per token)
			const maxContextChars = config.max_summary_tokens * 2;
			briefingParts.push(contextMd.slice(0, maxContextChars));
		}

		const latestPostMortemDigest =
			_internals.readLatestPostMortemDigest(directory);
		if (latestPostMortemDigest) {
			briefingParts.push('\n## Latest Post-Mortem');
			briefingParts.push(latestPostMortemDigest);
		}

		// 5. Find contradictions in knowledge entries (entries with 'contradiction' in tags)
		const contradictions = allEntries
			.filter(
				(e) =>
					Array.isArray(e.tags) &&
					e.tags.some((t: string) => t.includes('contradiction')),
			)
			.map((e) =>
				typeof e.lesson === 'string' ? e.lesson : JSON.stringify(e.lesson),
			);

		let briefingText = briefingParts.join('\n');

		// 6. LLM delegation: enhance briefing with CURATOR_INIT agent analysis
		// Pass all entries (capped at 30) with IDs for curator review
		const allEntriesForCurator = [...allEntries]
			.sort(
				(a, b) =>
					new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
			)
			.slice(0, 30)
			.map((e) => ({
				id: e.id,
				lesson: e.lesson,
				status: e.status,
				confidence: e.confidence,
				category: e.category,
			}));

		if (llmDelegate) {
			try {
				const userInput = [
					'TASK: CURATOR_INIT',
					`PRIOR_SUMMARY: ${priorSummary ? JSON.stringify(priorSummary) : 'none'}`,
					`KNOWLEDGE_ENTRIES: ${JSON.stringify(allEntriesForCurator)}`,
					`PROJECT_CONTEXT: ${contextMd?.slice(0, config.max_summary_tokens * 2) ?? 'none'}`,
					`POST_MORTEM_DIGEST: ${latestPostMortemDigest ?? 'none'}`,
				].join('\n');

				const systemPrompt = CURATOR_INIT_PROMPT;
				const timeoutMs =
					config.llm_timeout_ms ?? DEFAULT_CURATOR_LLM_TIMEOUT_MS;
				const ac = new AbortController();
				const timer = setTimeout(() => ac.abort(), timeoutMs);
				let llmOutput: string;
				try {
					// Hoist the delegate promise so we can attach a no-op catch
					// before the race. Without this, if the timeout fires first,
					// the delegate promise becomes the race loser and its
					// subsequent rejection (NotFoundError from the deleted
					// ephemeral session) would be an unhandled rejection.
					const delegatePromise = llmDelegate(
						systemPrompt,
						userInput,
						ac.signal,
					);
					void delegatePromise.catch(() => {});
					llmOutput = await Promise.race([
						delegatePromise,
						new Promise<never>((_, reject) => {
							ac.signal.addEventListener('abort', () =>
								reject(new Error('CURATOR_LLM_TIMEOUT')),
							);
						}),
					]);
				} finally {
					clearTimeout(timer);
				}

				// Enhance briefing with LLM output if available
				if (llmOutput?.trim()) {
					briefingText = `${briefingText}\n\n## LLM-Enhanced Analysis\n${llmOutput.trim()}`;
				}

				getGlobalEventBus().publish('curator.init.llm_completed', {
					enhanced: true,
				});
			} catch (err) {
				// LLM failure: fall back to data-only mode with warning
				logger.warn(
					`[curator] LLM delegation failed during CURATOR_INIT, using data-only mode: ${err instanceof Error ? err.message : String(err)}`,
				);
				getGlobalEventBus().publish('curator.init.llm_fallback', {
					error: String(err),
				});
			}
		}

		const result: CuratorInitResult = {
			briefing: briefingText,
			contradictions,
			knowledge_entries_reviewed: allEntries.length,
			prior_phases_covered: priorSummary ? priorSummary.last_phase_covered : 0,
		};

		// 7. Emit event
		getGlobalEventBus().publish('curator.init.completed', {
			prior_phases_covered: result.prior_phases_covered,
			knowledge_entries_reviewed: result.knowledge_entries_reviewed,
			contradictions_found: contradictions.length,
		});

		return result;
	} catch (err) {
		// Curator failures must NEVER block the caller
		getGlobalEventBus().publish('curator.error', {
			operation: 'init',
			error: String(err),
		});
		return {
			briefing: '## Curator Init Failed\nCould not load prior session context.',
			contradictions: [],
			knowledge_entries_reviewed: 0,
			prior_phases_covered: 0,
		};
	}
}

/**
 * Run curator phase analysis: reads events, runs compliance, updates and writes summary.
 * When an llmDelegate is provided, delegates to the explorer agent in CURATOR_PHASE mode
 * for LLM-based architectural drift analysis and knowledge recommendations.
 * @param directory - The workspace directory
 * @param phase - The phase number that just completed
 * @param agentsDispatched - List of agent names dispatched in this phase
 * @param config - Curator configuration
 * @param knowledgeConfig - Knowledge configuration (used for knowledge path resolution)
 * @param llmDelegate - Optional LLM delegate for enhanced analysis
 * @returns CuratorPhaseResult with digest, compliance, and recommendations
 */
export async function runCuratorPhase(
	directory: string,
	phase: number,
	agentsDispatched: string[],
	config: CuratorConfig,
	knowledgeConfig: { directory?: string },
	llmDelegate?: CuratorLLMDelegate,
): Promise<CuratorPhaseResult> {
	try {
		// 1. Read prior curator summary
		const priorSummary = await _internals.readCuratorSummary(directory);

		// 1b. Deduplication guard: skip if this phase was already digested.
		// Without this, repeated phase_complete or curator_analyze calls for
		// the same phase append duplicate digest entries and re-emit compliance
		// events, causing the summary to balloon and ephemeral sessions to leak.
		if (priorSummary?.phase_digests.some((d) => d.phase === phase)) {
			const existingDigest = priorSummary.phase_digests.find(
				(d) => d.phase === phase,
			)!;
			return {
				phase,
				digest: existingDigest,
				compliance: priorSummary.compliance_observations.filter(
					(c) => c.phase === phase,
				),
				knowledge_recommendations: [],
				summary_updated: false,
				already_digested: true,
			};
		}

		// 2. Read events.jsonl filtered to this phase window
		const eventsJsonlContent = await readSwarmFileAsync(
			directory,
			'events.jsonl',
		);
		const phaseEvents = eventsJsonlContent
			? _internals.filterPhaseEvents(eventsJsonlContent, phase)
			: [];

		// 3. Read context.md decisions
		const contextMd = await readSwarmFileAsync(directory, 'context.md');

		// 4. Run compliance check
		// Required agents for a standard phase: reviewer, test_engineer
		const requiredAgents = ['reviewer', 'test_engineer'];
		const complianceObservations = _internals.checkPhaseCompliance(
			phaseEvents,
			agentsDispatched,
			requiredAgents,
			phase,
		);

		// 5. Build phase digest entry from plan.json (source of truth for task status).
		// Previously this filtered events.jsonl for 'task.completed' events, but that
		// event type is never emitted — task status lives in plan.json only.
		const plan = await loadPlanJsonOnly(directory);
		const phaseData = plan?.phases.find((p) => p.id === phase);
		const tasksCompleted = phaseData
			? phaseData.tasks.filter((t) => t.status === 'completed').length
			: 0;
		const tasksTotal = phaseData ? phaseData.tasks.length : 0;

		// Extract key decisions from context.md (lines starting with '- ')
		const keyDecisions: string[] = [];
		if (contextMd) {
			const decisionSection = contextMd.match(
				/## Decisions\r?\n([\s\S]*?)(?:\r?\n##|$)/,
			);
			if (decisionSection) {
				const lines = decisionSection[1].split('\n');
				for (const line of lines) {
					const trimmed = line.trim();
					if (trimmed.startsWith('- ')) {
						keyDecisions.push(trimmed.slice(2));
					}
				}
			}
		}

		const phaseDigest: PhaseDigestEntry = {
			phase,
			timestamp: new Date().toISOString(),
			summary: `Phase ${phase} completed. ${tasksCompleted}/${tasksTotal} tasks completed. ${complianceObservations.length} compliance observations.`,
			agents_used: [
				...new Set(
					agentsDispatched.map((a) => _internals.normalizeAgentName(a)),
				),
			],
			tasks_completed: tasksCompleted,
			tasks_total: tasksTotal,
			key_decisions: keyDecisions.slice(0, 5),
			blockers_resolved: [],
		};

		// 6. LLM delegation: delegate to explorer agent in CURATOR_PHASE mode
		// for knowledge recommendations and enhanced phase analysis
		// Read current knowledge entries for curator review (capped to avoid context bloat)
		const knowledgeDirectory = knowledgeConfig.directory ?? directory;
		const curatorKnowledgePath = resolveSwarmKnowledgePath(knowledgeDirectory);
		const allKnowledgeEntries =
			await readKnowledge<SwarmKnowledgeEntry>(curatorKnowledgePath);
		const knownKnowledgeIds = new Set(allKnowledgeEntries.map((e) => e.id));
		const knowledgeForCurator = [...allKnowledgeEntries]
			.sort(
				(a, b) =>
					new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
			)
			.slice(0, 30)
			.map((e) => ({
				id: e.id,
				lesson: e.lesson,
				status: e.status,
				confidence: e.confidence,
				category: e.category,
			}));

		let knowledgeRecommendations: KnowledgeRecommendation[] = [];
		let knowledgeApplicationFindings: import('./curator-types.js').KnowledgeApplicationFinding[] =
			[];
		let skillCandidates: import('./curator-types.js').SkillCandidate[] = [];
		if (llmDelegate) {
			try {
				const priorDigest = priorSummary?.digest ?? 'none';
				const systemPrompt = CURATOR_PHASE_PROMPT;
				const userInput = [
					`TASK: CURATOR_PHASE ${phase}`,
					`PRIOR_DIGEST: ${priorDigest}`,
					`PHASE_EVENTS: ${JSON.stringify(phaseEvents.slice(0, 50))}`,
					`PHASE_DECISIONS: ${JSON.stringify(keyDecisions)}`,
					`AGENTS_DISPATCHED: ${JSON.stringify(agentsDispatched)}`,
					`AGENTS_EXPECTED: ["reviewer", "test_engineer"]`,
					`KNOWLEDGE_ENTRIES: ${JSON.stringify(knowledgeForCurator)}`,
				].join('\n');

				const timeoutMs =
					config.llm_timeout_ms ?? DEFAULT_CURATOR_LLM_TIMEOUT_MS;
				const ac = new AbortController();
				const timer = setTimeout(() => ac.abort(), timeoutMs);
				let llmOutput: string;
				try {
					// Hoist the delegate promise so we can attach a no-op catch
					// before the race. Without this, if the timeout fires first,
					// the delegate promise becomes the race loser and its
					// subsequent rejection (NotFoundError from the deleted
					// ephemeral session) would be an unhandled rejection.
					const delegatePromise = llmDelegate(
						systemPrompt,
						userInput,
						ac.signal,
					);
					void delegatePromise.catch(() => {});
					llmOutput = await Promise.race([
						delegatePromise,
						new Promise<never>((_, reject) => {
							ac.signal.addEventListener('abort', () =>
								reject(new Error('CURATOR_LLM_TIMEOUT')),
							);
						}),
					]);
				} finally {
					clearTimeout(timer);
				}

				if (llmOutput?.trim()) {
					const parsed =
						_internals.parseKnowledgeRecommendationsWithDiagnostics(llmOutput);
					for (const diagnostic of parsed.diagnostics) {
						logger.warn('[curator] skipped malformed recommendation line', {
							phase,
							...diagnostic,
						});
					}
					const resolvedRecommendations = resolveKnowledgeRecommendationIds(
						parsed.recommendations,
						allKnowledgeEntries,
					);
					for (const diagnostic of resolvedRecommendations.diagnostics) {
						logger.warn(
							'[curator] skipped recommendation for unknown knowledge entry',
							{
								phase,
								entry_id: diagnostic.line,
								reason: diagnostic.reason,
							},
						);
					}
					knowledgeRecommendations =
						resolvedRecommendations.recommendations.filter(
							(recommendation) =>
								!recommendation.entry_id ||
								knownKnowledgeIds.has(recommendation.entry_id),
						);
					const structured = parseStructuredCuratorBlocks(llmOutput);
					for (const diagnostic of structured.diagnostics) {
						logger.warn('[curator] skipped malformed structured block', {
							phase,
							block: diagnostic.block,
							reason: diagnostic.reason,
							index: diagnostic.index,
							detail: diagnostic.detail,
						});
					}
					knowledgeApplicationFindings = structured.findings;
					skillCandidates = structured.candidates;
				}

				getGlobalEventBus().publish('curator.phase.llm_completed', {
					phase,
					recommendations: knowledgeRecommendations.length,
					skill_candidates: skillCandidates.length,
					application_findings: knowledgeApplicationFindings.length,
				});
			} catch (err) {
				// LLM failure: fall back to data-only mode (empty recommendations)
				logger.warn(
					`[curator] LLM delegation failed during CURATOR_PHASE ${phase}, using data-only mode: ${err instanceof Error ? err.message : String(err)}`,
				);
				getGlobalEventBus().publish('curator.phase.llm_fallback', {
					phase,
					error: String(err),
				});
			}
		}

		// 7. Update and write curator summary
		const sessionId = `session-${Date.now()}`;
		const now = new Date().toISOString();

		const summaryUpdated = await _internals.mergeCuratorPhaseSummary(
			directory,
			{
				phase,
				phaseDigest,
				complianceObservations,
				knowledgeRecommendations,
				sessionId,
				timestamp: now,
			},
		);

		// 7b. Persist knowledge application findings to per-phase evidence.
		if (knowledgeApplicationFindings.length > 0) {
			try {
				const evidenceDir = path.join(
					directory,
					'.swarm',
					'evidence',
					String(phase),
				);
				fs.mkdirSync(evidenceDir, { recursive: true });
				const findingsPath = path.join(evidenceDir, 'curator-findings.json');
				await bunWrite(
					findingsPath,
					JSON.stringify({ findings: knowledgeApplicationFindings }, null, 2),
				);
			} catch (err) {
				logger.warn(
					`[curator] failed to persist application findings: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		// 8. Write compliance observations to events.jsonl as curator_compliance events
		const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
		for (const obs of complianceObservations) {
			await appendKnowledge(eventsPath, {
				type: 'curator_compliance',
				timestamp: obs.timestamp,
				phase: obs.phase,
				observation_type: obs.type,
				severity: obs.severity,
				description: obs.description,
			});
		}

		// v2: optional skill generation when curator returns skill_candidates and
		// the curator config opts in. Always uses 'draft' mode here — we never
		// auto-activate a generated skill from a curator pass; the architect or
		// a human must call skill_apply explicitly.
		if (
			(config as { skill_generation_enabled?: boolean })
				.skill_generation_enabled === true &&
			skillCandidates.length > 0
		) {
			try {
				const skillModule = await import('../services/skill-generator.js');
				for (const cand of skillCandidates) {
					if (
						cand.confidence <
						((config as { min_skill_confidence?: number })
							.min_skill_confidence ?? DEFAULT_SKILL_MIN_CONFIDENCE)
					) {
						continue;
					}
					await skillModule.generateSkills({
						directory,
						mode: 'draft',
						slug: cand.slug,
						sourceKnowledgeIds: cand.source_knowledge_ids,
					});
				}
			} catch (err) {
				logger.warn(
					`[curator] skill draft generation failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		// 8b. Skill revision: revise skills with violation rate in the
		// 15-30% range (soft threshold). Runs BEFORE auto-retire so
		// revised skills are not immediately retired. Non-blocking.
		const revisedSlugs = new Set<string>();
		try {
			const skillListResult = await _internals.listSkills(directory);
			const usageEntries = _internals.readSkillUsageEntries(directory);
			let revisionCallsThisPhase = 0;

			for (const active of skillListResult.active) {
				if (revisionCallsThisPhase >= MAX_REVISION_CALLS_PER_PHASE) break;

				const skillUsage = usageEntries.filter((e) => {
					let p = e.skillPath;
					if (p.startsWith('file:')) p = p.slice(5);
					const normalizedUsage = p.replace(/\\/g, '/');
					const normalizedActive = active.path.replace(/\\/g, '/');
					if (normalizedUsage === normalizedActive) return true;
					if (normalizedActive.endsWith(`/${normalizedUsage}`)) return true;
					if (normalizedUsage.endsWith(`/${normalizedActive}`)) return true;
					return false;
				});

				if (skillUsage.length === 0) continue;

				const violations = skillUsage.filter(
					(e) => e.complianceVerdict === 'violated',
				).length;
				const violationRate = violations / skillUsage.length;

				if (
					violationRate > REVISION_VIOLATION_THRESHOLD &&
					violationRate <= 0.3
				) {
					const content = await _internals.readFileAsync(active.path, 'utf-8');
					const fm = _internals.parseDraftFrontmatter(content);
					if (fm && fm.skillOrigin === 'promoted_external') continue;

					const currentVersion = fm?.version ?? 1;
					const violationContexts: ViolationContext[] = skillUsage
						.filter((e) => e.complianceVerdict === 'violated')
						.slice(-10)
						.map((e) => ({
							taskId: e.taskID,
							agent: e.agentName,
							verdict: e.complianceVerdict,
							reviewerNotes: e.reviewerNotes,
							timestamp: e.timestamp,
						}));

					const result = await _internals.reviseSkill({
						directory,
						slug: active.slug,
						skillPath: active.path,
						violationContexts,
						currentContent: content,
						currentVersion,
					});

					if (result.revised) {
						revisedSlugs.add(active.slug);
						phaseDigest.summary += ` [skill '${active.slug}' revised to v${result.newVersion}]`;
					}
					if (result.quotaConsumed) revisionCallsThisPhase++;
				}
			}
		} catch (revisionErr) {
			logger.warn(
				`[curator] skill revision check failed: ${revisionErr instanceof Error ? revisionErr.message : String(revisionErr)}`,
			);
		}

		// 9. Auto-retire health check for generated skills.
		// Retires skills whose violation rate exceeds 30% or whose source
		// knowledge entries are all archived. Non-blocking: errors are
		// caught internally and logged without failing the curator.
		const autoRetireObservations = await _internals.autoRetireSkills(
			directory,
			curatorKnowledgePath,
			revisedSlugs,
		);
		if (autoRetireObservations.length > 0) {
			const retireNote = ` [${autoRetireObservations.length} skill(s) auto-retired]`;
			phaseDigest.summary += retireNote;
		}

		// 9a. Process skill-stale-batch events as curator notifications.
		// These are emitted by the archive/purge hooks when multiple rapid
		// archives affect skills. We log/acknowledge them here — the actual
		// retire/stale action is already performed by the hooks that emitted
		// the events, so this is best-effort audit only.
		try {
			const eventsContent = await readSwarmFileAsync(
				directory,
				'knowledge-events.jsonl',
			);
			if (eventsContent) {
				const lines = eventsContent.split('\n').filter((l) => l.trim());
				const batchEvents: {
					skillIds: string[];
					retiredCount: number;
					staleCount: number;
				}[] = [];
				for (const line of lines) {
					try {
						const event = JSON.parse(line);
						if (event.type === 'skill-stale-batch') {
							batchEvents.push({
								skillIds: event.skillIds ?? [],
								retiredCount: event.retiredCount ?? 0,
								staleCount: event.staleCount ?? 0,
							});
						}
					} catch {
						// skip malformed lines
					}
				}
				for (const batch of batchEvents) {
					logger.warn(
						`[curator] skill-stale-batch: ${batch.skillIds.length} skills affected (${batch.retiredCount} retired, ${batch.staleCount} stale)`,
					);
				}
			}
		} catch {
			// best effort — events are already emitted by hooks
		}

		// 9b. Learning summary: compute lightweight learning metrics and
		// append a 3-line summary to the phase digest. Non-blocking.
		try {
			const metrics = await computeLearningMetrics(directory, {
				currentPhase: phase,
			});
			const summary = formatLearningSummary(metrics);
			if (summary && summary !== 'No learning data yet') {
				phaseDigest.summary += `\n\n--- Learning ---\n${summary}`;
			}
		} catch (learningErr) {
			logger.warn(
				`[curator] learning summary failed: ${learningErr instanceof Error ? learningErr.message : String(learningErr)}`,
			);
		}

		const result: CuratorPhaseResult = {
			phase,
			digest: phaseDigest,
			compliance: complianceObservations,
			knowledge_recommendations: knowledgeRecommendations,
			summary_updated: summaryUpdated,
			knowledge_application_findings: knowledgeApplicationFindings,
			skill_candidates: skillCandidates,
		};

		// 10. Emit event
		getGlobalEventBus().publish('curator.phase.completed', {
			phase,
			compliance_count: complianceObservations.length,
			summary_updated: summaryUpdated,
		});

		return result;
	} catch (err) {
		// Curator failures must NEVER block phase_complete
		getGlobalEventBus().publish('curator.error', {
			operation: 'phase',
			phase,
			error: String(err),
		});
		return {
			phase,
			digest: {
				phase,
				timestamp: new Date().toISOString(),
				summary: `Phase ${phase} curator run failed: ${String(err)}`,
				agents_used: [],
				tasks_completed: 0,
				tasks_total: 0,
				key_decisions: [],
				blockers_resolved: [],
			},
			compliance: [],
			knowledge_recommendations: [],
			summary_updated: false,
		};
	}
}

/**
 * Apply curator knowledge recommendations: promote, archive, or flag contradictions.
 * Uses transactKnowledge for atomic locked read-modify-write updates.
 * @param directory - The workspace directory
 * @param recommendations - Array of knowledge recommendations to apply
 * @param knowledgeConfig - Knowledge configuration (for path resolution)
 * @param generation - Optional fair-scan-cursor generation (#1848 §4). When
 *   provided, curation mutations stamp `last_curated_generation` on the mutated
 *   entry so a future sweep can detect it was already curated this generation.
 *   When undefined, no stamp is written (preserves callers that don't pass it).
 * @returns Counts of applied and skipped recommendations
 */
export async function applyCuratorKnowledgeUpdates(
	directory: string,
	recommendations: KnowledgeRecommendation[],
	knowledgeConfig: KnowledgeConfig,
	generation?: number,
): Promise<{ applied: number; skipped: number }> {
	let applied = 0;
	let skipped = 0;

	// #1848 §4: generation stamp for the fair scan cursor. Spread onto each
	// mutated entry so `alreadyCuratedThisGeneration` can skip re-curation of an
	// entry already handled in this generation. Undefined → `{...undefined}` is a
	// no-op, so callers that don't thread a generation are unaffected.
	const genStamp =
		generation !== undefined
			? { last_curated_generation: generation }
			: undefined;

	// Guard: treat null/undefined recommendations as empty
	if (!recommendations || recommendations.length === 0) {
		return { applied, skipped };
	}

	// Guard: return no-op when knowledgeConfig is null or undefined
	if (knowledgeConfig == null) {
		return { applied: 0, skipped: 0 };
	}

	// Filter out null/undefined recommendation items before processing
	let validRecommendations = recommendations.filter(
		(rec): rec is KnowledgeRecommendation => rec != null,
	);

	const knowledgePath = resolveSwarmKnowledgePath(directory);

	// #1848 §2 (C-4 fix): PRE-TRANSACTION cohort-safe authorization. The
	// synchronous `mutate` callback inside transactKnowledge cannot await the
	// async authorizeCuration (which reads cohort events), so we authorize over
	// the freshest snapshot here. Because that snapshot is unlocked, an entry can
	// change between authorize and apply. To close that gap we capture each
	// authorized destructive rec's expected revision (from the preSnapshot entry)
	// and re-check it inside the locked transaction: the per-entry revision CAS in
	// the archive/rewrite cases skips any entry whose fresh revision no longer
	// matches what was authorized. Destructive recommendations (archive/rewrite)
	// that are not authorized are filtered out and recorded as proposals by the
	// policy. Promote/flag_contradiction are non-destructive (they only enrich,
	// not remove/replace) and are not gated.
	const authorizedRevisions = new Map<string, number | undefined>();
	if (validRecommendations.length > 0) {
		const preSnapshot =
			await _internals.readKnowledge<SwarmKnowledgeEntry>(knowledgePath);
		const authorizedRecs: KnowledgeRecommendation[] = [];
		for (const rec of validRecommendations) {
			// Only gate destructive actions (archive/rewrite). Promote and
			// flag_contradiction enrich the entry without removing/replacing it.
			if (rec.action !== 'archive' && rec.action !== 'rewrite') {
				authorizedRecs.push(rec);
				continue;
			}
			// Skip authorization for recommendations without an entry_id — they
			// can't target an existing entry (handled as new-entry candidates
			// elsewhere). The existing not-found/id-resolution logic skips them.
			if (!rec.entry_id) {
				authorizedRecs.push(rec);
				continue;
			}
			const target = preSnapshot.find((e) => e.id === rec.entry_id) ?? null;
			const decision = await authorizeCuration(
				{
					directory,
					action: rec.action,
					entryId: rec.entry_id ?? '',
					reason: rec.reason,
					evidenceScope: 'cohort-wide',
				},
				{ config: knowledgeConfig, entry: target },
			);
			if (decision.authorized) {
				authorizedRecs.push(rec);
				// Capture the revision we authorized against so the in-transaction
				// CAS can detect drift if the entry mutates before apply. Legacy
				// entries (revision absent) record `undefined` → treated as 0 by
				// the CAS check, matching transactKnowledgeWithCas semantics.
				authorizedRevisions.set(rec.entry_id, target?.revision ?? undefined);
			} else {
				// Unauthorized destructive recommendation → the policy recorded a
				// non-destructive proposal. Count it as skipped HERE: it is
				// filtered out of `validRecommendations` below (via the
				// `authorizedRecs` reassignment), so the post-transaction skip
				// loop never sees it and would otherwise drop it from both the
				// applied AND skipped tallies (#1848 review F-12).
				skipped++;
				logger.warn(
					`[curator] ${rec.action} for '${rec.entry_id}' blocked by cohort-safety (basis: ${decision.basis})`,
				);
			}
		}
		validRecommendations = authorizedRecs;
	}

	// Closure variables written by the transactKnowledge callback so the
	// post-transaction code (skipped counting, new-entry append) can see them.
	const appliedIds = new Set<string>();
	const foundIds = new Set<string>();
	let idResolutionSkipped = 0;
	// #1848 §3 CAS: count destructive mutations skipped because the entry's fresh
	// revision drifted from the revision we authorized against. Added to `skipped`
	// after the transaction commits. `casDriftedIds` lets the post-transaction
	// skip loop exclude these ids so they are not counted a second time.
	let casDriftSkipped = 0;
	const casDriftedIds = new Set<string>();
	// G11 (issue #1717): capture the pre-mutation status of each archived
	// entry so the shared invalidator's tombstone records the real prior status.
	const archivedPrevStatus = new Map<string, string>();
	// G3 (#1715): collect (id, reason) for flag_contradiction actions so we can
	// emit `contradicted` events post-transaction. Emitting inline inside the
	// transactKnowledge callback would risk a directory-lock deadlock (the
	// events file lives in the same `.swarm/` dir the transaction locks).
	const contradictedEntries: Array<{ id: string; reason: string }> = [];

	// Atomically read, mutate, and rewrite existing entries under a directory lock
	// (CF-2 TOCTOU fix: concurrent appendKnowledge calls between an unlocked read
	// and a locked rewrite can no longer silently drop entries).
	await transactKnowledge<SwarmKnowledgeEntry>(knowledgePath, (entries) => {
		// Reset closure state on each call (in case of future retry semantics).
		appliedIds.clear();
		foundIds.clear();
		archivedPrevStatus.clear();
		contradictedEntries.length = 0;
		casDriftSkipped = 0;
		casDriftedIds.clear();
		let txApplied = 0;
		let modified = false;

		for (const e of entries) foundIds.add(e.id);
		const resolvedRecommendations = resolveKnowledgeRecommendationIds(
			validRecommendations,
			entries,
		);
		validRecommendations = resolvedRecommendations.recommendations;
		idResolutionSkipped = resolvedRecommendations.diagnostics.length;
		for (const diagnostic of resolvedRecommendations.diagnostics) {
			logger.warn(
				`[curator] applyCuratorKnowledgeUpdates: entry_id '${diagnostic.line}' ${diagnostic.reason} — skipping`,
			);
		}

		const updatedEntries = entries.map((entry) => {
			const rec = validRecommendations.find((r) => r.entry_id === entry.id);
			if (!rec) return entry;

			// #1848 §4 (F-09/PRR-003): second idempotency layer. If this entry was
			// already curated in the current fair-scan generation (e.g. the batch
			// was re-claimed after a crash/retry), skip re-applying the mutation so
			// non-idempotent effects (confidence deltas, revision bumps) do not
			// compound. No-op when `generation` is undefined, so callers that don't
			// thread a generation are unaffected.
			if (
				generation !== undefined &&
				alreadyCuratedThisGeneration(entry, generation)
			) {
				return entry;
			}

			switch (rec.action) {
				case 'promote':
					appliedIds.add(entry.id);
					txApplied++;
					modified = true;
					return {
						...entry,
						hive_eligible: true,
						confidence: Math.min(1.0, (entry.confidence ?? 0) + 0.1),
						updated_at: new Date().toISOString(),
						...genStamp,
					};
				case 'archive': {
					// #1848 §3 CAS: skip if the entry drifted since authorization.
					if (
						authorizedRevisions.has(entry.id) &&
						(entry.revision ?? 0) !== (authorizedRevisions.get(entry.id) ?? 0)
					) {
						casDriftSkipped++;
						casDriftedIds.add(entry.id);
						return entry;
					}
					// PRR-015: guard against re-archiving an already-archived entry.
					// A duplicate/late recommendation targeting an archived entry
					// would otherwise record `archived_from: 'archived'`
					// (self-referential), breaking unarchive's status recovery.
					// Preserve the existing archived_from and skip the rewrite.
					if (entry.status === 'archived') {
						return entry;
					}
					appliedIds.add(entry.id);
					// G11 (issue #1717): capture BEFORE mutation so the
					// tombstone records the real prior status.
					archivedPrevStatus.set(entry.id, entry.status);
					txApplied++;
					modified = true;
					return {
						...entry,
						status: 'archived' as const,
						// G6 (#1716): record prior status so `unarchiveEntry` can
						// restore the entry to its pre-archive lifecycle position.
						archived_from: entry.status,
						archived_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						...genStamp,
					};
				}
				case 'flag_contradiction':
					appliedIds.add(entry.id);
					txApplied++;
					modified = true;
					// G3 (#1715): capture for post-transaction event emission.
					contradictedEntries.push({
						id: entry.id,
						reason: (rec.reason ?? '').slice(0, 200),
					});
					return {
						...entry,
						tags: [
							...(entry.tags ?? []),
							`contradiction:${(rec.reason ?? '').slice(0, 50)}`,
						],
						updated_at: new Date().toISOString(),
						...genStamp,
					};
				case 'rewrite': {
					// #1848 §3 CAS: skip if the entry drifted since authorization.
					if (
						authorizedRevisions.has(entry.id) &&
						(entry.revision ?? 0) !== (authorizedRevisions.get(entry.id) ?? 0)
					) {
						casDriftSkipped++;
						casDriftedIds.add(entry.id);
						return entry;
					}
					const newLesson = (rec.lesson ?? '').trim();
					if (newLesson.length < 15 || newLesson.length > 280) {
						return entry;
					}
					// F-001: validate rewritten lesson text through the same
					// content-safety gates as the new-entry path
					// (INJECTION_PATTERNS, dangerous-command patterns,
					// security-degrading patterns). Pass [] for existingLessons
					// to skip dedup — cross-entry dedup is the new-entry path's job.
					if (knowledgeConfig.validation_enabled !== false) {
						const validation = validateLesson(newLesson, [], {
							category: entry.category,
							scope: entry.scope,
							confidence: entry.confidence ?? 0.5,
						});
						if (!validation.valid) {
							logger.warn(
								`[curator] rewrite for entry '${entry.id}' rejected by content validation`,
							);
							return entry;
						}
					}
					appliedIds.add(entry.id);
					txApplied++;
					modified = true;
					// #1848 §3: stamp revision + content_hash on rewrite so the
					// before/after is recoverable and CAS can detect drift.
					return {
						...entry,
						lesson: newLesson,
						updated_at: new Date().toISOString(),
						confidence: Math.max(0.1, (entry.confidence ?? 0.5) - 0.05),
						revision: (entry.revision ?? 0) + 1,
						content_hash: computeContentHash(newLesson),
						...genStamp,
					};
				}
				default:
					return entry;
			}
		});

		applied += txApplied;
		return modified ? updatedEntries : null;
	});
	skipped += idResolutionSkipped;
	// #1848 §3 CAS: entries skipped because their revision drifted between the
	// unlocked authorization snapshot and the locked apply are counted as skipped.
	skipped += casDriftSkipped;

	// G3 (#1715): emit `contradicted` events for flag_contradiction actions,
	// AFTER the transaction commits. This unifies the two previously-disconnected
	// contradiction signals: `contradicted_count` (incremented only via
	// knowledge_receipt) and the curator's tag-only `flag_contradiction`. Now
	// both paths feed the same event-sourced counter. The curator-attributed
	// context (agent: 'curator') makes these events distinguishable from
	// delegate/reviewer ones for audit.
	for (const { id, reason } of contradictedEntries) {
		try {
			await recordKnowledgeEvent(directory, {
				type: 'contradicted' as const,
				knowledge_id: id,
				trace_id: `curator-${randomUUID()}`,
				session_id: 'curator',
				agent: 'curator',
				reason: `flag_contradiction: ${reason}`,
				evidence: { summary: reason },
			});
		} catch {
			// best-effort — never fail the curator on event emission
		}
	}

	// G3: after emitting, check the threshold and quarantine if configured +
	// crossed. `tag_only` preserves legacy behavior; `quarantine` (default)
	// auto-quarantines entries whose in-window contradicted count crossed.
	if (
		contradictedEntries.length > 0 &&
		knowledgeConfig.contradiction_threshold_action === 'quarantine'
	) {
		const { maybeQuarantineOnContradiction } = await import(
			'./knowledge-escalator.js'
		);
		for (const { id } of contradictedEntries) {
			try {
				await maybeQuarantineOnContradiction(
					directory,
					id,
					knowledgeConfig.contradiction_quarantine_threshold,
					knowledgeConfig.contradiction_quarantine_window_days,
				);
			} catch {
				// best-effort
			}
		}
	}

	// Count skipped: recommendations that were not applied to existing entries
	for (const rec of validRecommendations) {
		if (rec.entry_id !== undefined && !appliedIds.has(rec.entry_id)) {
			// CAS-drifted recs are already counted via `casDriftSkipped` above;
			// skip them here so they are not double-counted.
			if (casDriftedIds.has(rec.entry_id)) continue;
			if (!foundIds.has(rec.entry_id)) {
				logger.warn(
					`[curator] applyCuratorKnowledgeUpdates: entry_id '${rec.entry_id}' not found — skipping`,
				);
			}
			skipped++;
		}
	}

	// G11 (issue #1717): route curator-archive recommendations through the
	// same tombstone + retire/stale invalidation path as the knowledge_archive
	// tool. Before this, curator-archived knowledge silently orphaned its
	// generated skills. Fail-open per-call.
	const archivedRecs = validRecommendations.filter(
		(r) => r.action === 'archive' && r.entry_id && appliedIds.has(r.entry_id),
	);
	// Batch the archived-ID scan once for the whole recommendation set instead
	// of once per entry (matches the sibling autoRetireSkills batching
	// pattern at the top of this file) — avoids O(K) full swarm+hive JSONL
	// re-scans when a single curator phase archives multiple entries.
	const precomputedArchivedIds =
		archivedRecs.length > 0
			? await getArchivedKnowledgeIds(directory)
			: undefined;
	for (const rec of archivedRecs) {
		try {
			await writeArchiveTombstoneAndInvalidateSkills({
				directory,
				entryId: rec.entry_id!,
				tier: 'swarm',
				actor: 'curator',
				reason: rec.reason ?? 'curator archive recommendation',
				mode: 'archive',
				previousStatus: archivedPrevStatus.get(rec.entry_id!),
				sourceLabel: 'curator',
				precomputedArchivedIds,
			});
		} catch (err) {
			logger.warn(
				`[curator] archive invalidation for entry '${rec.entry_id}' failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// Create new entries for recommendations that used the "new" token.
	// entry_id === undefined means the LLM requested a new knowledge entry.
	// Only 'promote' actions are meaningful without an existing entry_id —
	// 'archive' and 'flag_contradiction' require a real entry to operate on.
	// These are appended after the transaction to avoid nested locking.

	// Unlocked read for post-transaction dedup and validation.
	// The append below is independently locked, so a race with a concurrent
	// appendKnowledge is possible but benign (worst case: a duplicate lesson
	// appears and is cleaned up on the next curator pass).
	const currentEntries =
		await readKnowledge<SwarmKnowledgeEntry>(knowledgePath);
	const currentLessons: string[] = currentEntries.map((e) => e.lesson);

	for (const rec of validRecommendations) {
		if (rec.entry_id !== undefined) continue;
		if (rec.action !== 'promote') {
			skipped++;
			continue;
		}
		const lesson = (rec.lesson?.trim() ?? '').slice(0, 280);
		if (lesson.length < 15) {
			skipped++;
			continue;
		}
		if (
			currentLessons.some((el) => el.toLowerCase() === lesson.toLowerCase())
		) {
			skipped++;
			continue;
		}
		if (knowledgeConfig.validation_enabled !== false) {
			const validation = validateLesson(lesson, currentLessons, {
				category: rec.category ?? 'other',
				scope: 'global',
				confidence: rec.confidence ?? 0.5,
			});
			if (!validation.valid) {
				skipped++;
				continue;
			}
		}
		const now = new Date().toISOString();
		const newEntry: SwarmKnowledgeEntry = {
			id: randomUUID(),
			tier: 'swarm',
			lesson: lesson,
			category: rec.category ?? 'other',
			tags: [],
			scope: 'global',
			confidence: rec.confidence ?? 0.5,
			status: 'candidate',
			confirmed_by: [],
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
			},
			schema_version: 1,
			created_at: now,
			updated_at: now,
			auto_generated: true,
			project_name: path.basename(directory),
			triggers: rec.triggers,
			required_actions: rec.required_actions,
			forbidden_actions: rec.forbidden_actions,
			applies_to_agents: rec.applies_to_agents,
			applies_to_tools: rec.applies_to_tools,
			verification_checks: rec.verification_checks,
			directive_priority: rec.directive_priority,
		};
		// Layer-5 actionability gate (Change 4): prose "new candidate"
		// recommendations carry no predicate/scope fields, so they are routed to
		// the unactionable queue (recoverable by the hardening loop) instead of
		// the active store. No LLM delegate is available in this path.
		if (!validateActionability(newEntry).actionable) {
			try {
				await appendUnactionable(
					directory,
					newEntry,
					'curator_recommendation_unactionable',
				);
			} catch {
				// queue write is best-effort; the entry is still withheld
			}
			skipped++;
			continue;
		}
		await appendKnowledge(knowledgePath, newEntry);
		applied++;
		currentLessons.push(lesson);
	}

	return { applied, skipped };
}
