/**
 * Curator post-mortem — project-end synthesis agent (WP7, issue #1234).
 *
 * Reads structured .swarm/ evidence (knowledge entries, events, curator digests,
 * pending proposals, retrospectives, drift reports) and produces a post-mortem
 * report with: improvement agenda, final curation pass, queue triage, and
 * learning metrics summary.
 *
 * Triggers: phase_complete plan completion, /swarm finalize, /swarm post-mortem.
 * Fail-open: errors never block finalize or phase completion.
 * Outputs route through existing gated paths (knowledge_add, skill proposals,
 * hive promotion) — no new ungated injection source.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { listPendingInsightCandidatesDb } from '../db/insight-candidate-store.js';
import { projectDbExists } from '../db/project-db.js';
import { atomicWriteFile } from '../evidence/task-file.js';
import { claimNextScanBatch } from '../knowledge/scan-cursor.js';
import { tryAcquireLock } from '../parallel/file-locks.js';
import { loadPlanJsonOnly } from '../plan/manager.js';
import { derivePlanId } from '../plan/utils.js';
import {
	type CuratorLLMDelegate,
	normalizeRecommendationEntryIdToken,
} from './curator.js';
import type { KnowledgeRecommendation } from './curator-types.js';
import { readKnowledgeEvents } from './knowledge-events.js';
import { resolveKnowledgeStoreDir } from './knowledge-link.js';
import { readKnowledge, resolveSwarmKnowledgePath } from './knowledge-store.js';
import type {
	KnowledgeCategory,
	KnowledgeConfig,
	SwarmKnowledgeEntry,
} from './knowledge-types.js';
import { isActiveStatus } from './knowledge-types.js';
import { readSwarmFileAsync, validateSwarmPath } from './utils.js';

const MAX_INPUT_TEXT_CHARS = 500;
const MAX_KNOWLEDGE_ENTRIES = 500;
const MAX_PROPOSALS = 50;
const MAX_RETROSPECTIVES = 50;
const MAX_DRIFT_REPORTS = 50;
const MAX_UNACTIONABLE = 1000;

// ============================================================================
// Types
// ============================================================================

export interface PostMortemResult {
	success: boolean;
	planId: string | null;
	reportPath: string | null;
	summary: string | null;
	warnings: string[];
	actions?: PostMortemActionResult;
}

export interface PostMortemOptions {
	llmDelegate?: CuratorLLMDelegate;
	force?: boolean;
	scope?: 'session' | 'project';
	sessionID?: string;
	knowledgeConfig?: KnowledgeConfig;
	llmTimeoutMs?: number;
}

interface KnowledgeEventSummary {
	id: string;
	lesson: string;
	applied: number;
	violated: number;
	ignored: number;
	/**
	 * Shown to a delegate that ended its Task without any ack marker or receipt.
	 * Audit-only silence, NOT a verdict — kept strictly separate from
	 * applied/violated/ignored so it never enters an application- or
	 * violation-rate calculation. Surfaced so a post-mortem can say
	 * "entry X: shown N times, unacknowledged M times" instead of nothing.
	 */
	unacknowledged: number;
	confidence: number;
	status: string;
}

interface ParsedPostMortemActions {
	summary: string | null;
	recommendations: KnowledgeRecommendation[];
	queueTriage: Array<{
		proposal_id: string;
		action: 'apply' | 'reject';
		reason: string;
	}>;
	diagnostics: string[];
}

type KnowledgeActionVerificationStatus =
	| 'new_entry'
	| 'exact_match'
	| 'prefix_match'
	| 'not_found'
	| 'ambiguous_prefix'
	| 'missing_entry_id';

interface KnowledgeActionVerification {
	action: KnowledgeRecommendation['action'];
	input_entry_id: string | null;
	resolved_entry_id: string | null;
	status: KnowledgeActionVerificationStatus;
	reason: string;
}

export interface PostMortemActionResult {
	knowledge_applied: number;
	knowledge_skipped: number;
	hive_promotions: number;
	hive_encounters_incremented: number;
	hive_advancements: number;
	proposals_approved: number;
	proposals_rejected: number;
	proposals_skipped: number;
}

// ============================================================================
// Data collection helpers
// ============================================================================

async function collectKnowledgeSummary(
	directory: string,
	scope: 'session' | 'project' = 'project',
	sessionID?: string,
	out?: { generation?: number },
): Promise<KnowledgeEventSummary[]> {
	// #1848 §4: replace the fixed oldest-~500 window with a durable, fair scan
	// cursor. Every eligible record is eventually visited; progress survives
	// restart; concurrent append/update does not permanently skip entries. The
	// cursor atomically claims a batch (read+advance in one step) so concurrent
	// cohort postmortems do not duplicate work.
	const batch = await claimNextScanBatch(directory, MAX_KNOWLEDGE_ENTRIES);
	// #1848 §4 (F-09): surface the claimed batch's generation so the curation
	// apply path can stamp `last_curated_generation` on mutated entries. This is
	// an out-param (not a return-shape change) to keep the array contract callers
	// and tests depend on.
	if (out) out.generation = batch.generation;
	const entries = batch.entries;
	// Read events scoped to this batch's entry ids (not a fixed 4× window).
	const batchIds = new Set(entries.map((e) => e.id));
	let events = (await readKnowledgeEvents(directory)).filter((e) => {
		const kid =
			(e as { knowledge_id?: string }).knowledge_id ??
			(e as { entry_id?: string }).entry_id;
		return kid != null && batchIds.has(kid);
	});
	if (scope === 'session' && sessionID) {
		events = events.filter(
			(e) => (e as { session_id?: string }).session_id === sessionID,
		);
	}

	const countsMap = new Map<
		string,
		{
			applied: number;
			violated: number;
			ignored: number;
			unacknowledged: number;
		}
	>();
	for (const e of events) {
		if (
			e.type !== 'applied' &&
			e.type !== 'violated' &&
			e.type !== 'ignored' &&
			// Audit-only silence signal: a shown non-critical directive whose
			// delegate Task ended with no ack marker and no receipt. Tallied
			// SEPARATELY (never folded into applied/violated/ignored) so the
			// post-mortem can report unanswered delivery without it reading as a
			// verdict on the entry.
			e.type !== 'unacknowledged'
		)
			continue;
		const kid =
			(e as { knowledge_id?: string }).knowledge_id ??
			(e as { entry_id?: string }).entry_id;
		if (!kid) continue;
		const c = countsMap.get(kid) ?? {
			applied: 0,
			violated: 0,
			ignored: 0,
			unacknowledged: 0,
		};
		if (e.type === 'applied') c.applied++;
		else if (e.type === 'violated') c.violated++;
		else if (e.type === 'ignored') c.ignored++;
		else c.unacknowledged++;
		countsMap.set(kid, c);
	}

	return entries.map((entry) => {
		const c = countsMap.get(entry.id) ?? {
			applied: 0,
			violated: 0,
			ignored: 0,
			unacknowledged: 0,
		};
		return {
			id: entry.id,
			lesson: entry.lesson,
			applied: c.applied,
			violated: c.violated,
			ignored: c.ignored,
			unacknowledged: c.unacknowledged,
			confidence: entry.confidence ?? 0.5,
			status: entry.status ?? 'active',
		};
	});
}

function extractSection(text: string, sectionName: string): string | null {
	const pattern = new RegExp(
		`^${sectionName}:\\s*\\n([\\s\\S]*?)(?=\\n[A-Z_]+:\\s*(?:\\n|$)|$)`,
		'm',
	);
	const match = text.match(pattern);
	return match?.[1]?.trim() || null;
}

function normalizeRecommendationAction(
	raw: unknown,
): KnowledgeRecommendation['action'] | null {
	const value = String(raw ?? '')
		.toLowerCase()
		.trim();
	if (value === 'promote' || value === 'promote_to_hive') return 'promote';
	if (value === 'archive' || value === 'flag_stale') return 'archive';
	if (value === 'rewrite') return 'rewrite';
	if (value === 'flag_contradiction') return 'flag_contradiction';
	if (value === 'merge') return null;
	return null;
}

function normalizeProposalSlug(raw: string): string {
	return raw
		.trim()
		.replace(/^proposals[\\/]/, '')
		.replace(/\.md$/i, '')
		.replace(/\.json$/i, '');
}

function parseStructuredPostMortemActions(
	llmOutput: string,
): ParsedPostMortemActions {
	const parsed: ParsedPostMortemActions = {
		summary: extractSection(llmOutput, 'SUMMARY'),
		recommendations: [],
		queueTriage: [],
		diagnostics: [],
	};
	const fence = /```(?:json|jsonc)?\s+postmortem_actions\s*\n([\s\S]*?)\n```/g;
	for (const match of llmOutput.matchAll(fence)) {
		let data: unknown;
		try {
			data = JSON.parse(match[1]);
		} catch (err) {
			parsed.diagnostics.push(
				`postmortem_actions malformed_json: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			continue;
		}
		if (!data || typeof data !== 'object' || Array.isArray(data)) {
			parsed.diagnostics.push('postmortem_actions expected object');
			continue;
		}
		const obj = data as {
			summary?: unknown;
			curation_recommendations?: unknown;
			queue_triage?: unknown;
		};
		if (typeof obj.summary === 'string' && obj.summary.trim()) {
			parsed.summary = obj.summary.trim().slice(0, 1000);
		}
		if (Array.isArray(obj.curation_recommendations)) {
			for (const [index, item] of obj.curation_recommendations.entries()) {
				if (!item || typeof item !== 'object') {
					parsed.diagnostics.push(
						`curation_recommendations[${index}] invalid object`,
					);
					continue;
				}
				const rec = item as {
					action?: unknown;
					entry_id?: unknown;
					lesson?: unknown;
					reason?: unknown;
					category?: unknown;
					confidence?: unknown;
					triggers?: unknown;
					required_actions?: unknown;
					forbidden_actions?: unknown;
					applies_to_agents?: unknown;
					applies_to_tools?: unknown;
					verification_checks?: unknown;
					directive_priority?: unknown;
				};
				const action = normalizeRecommendationAction(rec.action);
				const lesson = String(rec.lesson ?? rec.reason ?? '').trim();
				const reason = String(rec.reason ?? lesson).trim();
				if (!action || !reason) {
					parsed.diagnostics.push(
						`curation_recommendations[${index}] missing action/reason`,
					);
					continue;
				}
				if (action === 'rewrite' && lesson.length < 15) {
					parsed.diagnostics.push(
						`curation_recommendations[${index}] rewrite missing lesson`,
					);
					continue;
				}
				parsed.recommendations.push({
					action,
					entry_id:
						typeof rec.entry_id === 'string'
							? normalizeRecommendationEntryIdToken(rec.entry_id)
							: undefined,
					lesson: (lesson || reason).slice(0, 280),
					reason: reason.slice(0, 280),
					category:
						typeof rec.category === 'string'
							? (rec.category as KnowledgeCategory)
							: undefined,
					confidence:
						typeof rec.confidence === 'number' ? rec.confidence : undefined,
					triggers: stringArray(rec.triggers),
					required_actions: stringArray(rec.required_actions),
					forbidden_actions: stringArray(rec.forbidden_actions),
					applies_to_agents: stringArray(rec.applies_to_agents),
					applies_to_tools: stringArray(rec.applies_to_tools),
					verification_checks: stringArray(rec.verification_checks),
					directive_priority: directivePriority(rec.directive_priority),
				});
			}
		}
		if (Array.isArray(obj.queue_triage)) {
			for (const [index, item] of obj.queue_triage.entries()) {
				if (!item || typeof item !== 'object') {
					parsed.diagnostics.push(`queue_triage[${index}] invalid object`);
					continue;
				}
				const triage = item as {
					proposal_id?: unknown;
					action?: unknown;
					reason?: unknown;
				};
				const proposalId = String(triage.proposal_id ?? '').trim();
				const action = String(triage.action ?? '')
					.toLowerCase()
					.trim();
				if (!proposalId || (action !== 'apply' && action !== 'reject')) {
					parsed.diagnostics.push(
						`queue_triage[${index}] missing proposal_id/action`,
					);
					continue;
				}
				parsed.queueTriage.push({
					proposal_id: proposalId.slice(0, 120),
					action,
					reason: String(triage.reason ?? '').slice(0, 280),
				});
			}
		}
	}
	return parsed;
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const strings = value
		.filter((item): item is string => typeof item === 'string')
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	return strings.length > 0 ? strings : undefined;
}

function directivePriority(
	value: unknown,
): KnowledgeRecommendation['directive_priority'] | undefined {
	if (
		value === 'low' ||
		value === 'medium' ||
		value === 'high' ||
		value === 'critical'
	) {
		return value;
	}
	return undefined;
}

function parseLegacyPostMortemActions(
	llmOutput: string,
): ParsedPostMortemActions {
	const parsed: ParsedPostMortemActions = {
		summary: extractSection(llmOutput, 'SUMMARY'),
		recommendations: [],
		queueTriage: [],
		diagnostics: [],
	};
	const curation = extractSection(llmOutput, 'CURATION_RECOMMENDATIONS');
	if (curation) {
		let recIndex = 0;
		for (const line of curation.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed.startsWith('-')) continue;
			const body = trimmed.replace(/^-\s*/, '');
			const [head, reasonPart = ''] = body.split(/\s+—\s+|\s+-\s+/, 2);
			const [rawAction, rest = ''] = head.split(/:\s*/, 2);
			const lowerRaw = rawAction.toLowerCase().trim();
			const action = normalizeRecommendationAction(rawAction);
			if (!action) {
				if (lowerRaw === 'merge') {
					parsed.diagnostics.push(
						"legacy curation_recommendations unsupported action 'merge' — dropped",
					);
				} else if (lowerRaw) {
					parsed.diagnostics.push(
						`legacy curation_recommendations unrecognized action '${lowerRaw}'`,
					);
				}
				continue;
			}
			const idMatch = rest.match(
				/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
			);
			const reason = (reasonPart || rest).trim();
			if (!reason) {
				parsed.diagnostics.push(
					`legacy curation_recommendations[${recIndex}] missing reason`,
				);
				continue;
			}
			parsed.recommendations.push({
				action,
				entry_id: idMatch?.[0],
				lesson: reason.slice(0, 280),
				reason: reason.slice(0, 280),
			});
			recIndex++;
		}
	}
	const queue = extractSection(llmOutput, 'QUEUE_TRIAGE');
	if (queue) {
		for (const line of queue.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed.startsWith('-')) continue;
			if (trimmed.includes(':')) {
				const match = trimmed.match(
					/^-\s*([^:]+):\s*(APPLY|REJECT)\b\s*(?:—|-)?\s*(.*)$/i,
				);
				if (!match) {
					parsed.diagnostics.push('legacy queue_triage malformed line');
					continue;
				}
				parsed.queueTriage.push({
					proposal_id: match[1].trim().slice(0, 120),
					action: match[2].toLowerCase() as 'apply' | 'reject',
					reason: match[3].trim().slice(0, 280),
				});
			}
		}
	}
	return parsed;
}

function parsePostMortemActions(llmOutput: string): ParsedPostMortemActions {
	const structured = parseStructuredPostMortemActions(llmOutput);
	const legacy = parseLegacyPostMortemActions(llmOutput);
	return {
		summary: structured.summary ?? legacy.summary,
		recommendations:
			structured.recommendations.length > 0
				? structured.recommendations
				: legacy.recommendations,
		queueTriage:
			structured.queueTriage.length > 0
				? structured.queueTriage
				: legacy.queueTriage,
		diagnostics: [...structured.diagnostics, ...legacy.diagnostics],
	};
}

async function executePostMortemActions(
	directory: string,
	parsed: ParsedPostMortemActions,
	options: PostMortemOptions,
	generation?: number,
): Promise<{ result: PostMortemActionResult; warnings: string[] }> {
	const warnings: string[] = [];
	const result: PostMortemActionResult = {
		knowledge_applied: 0,
		knowledge_skipped: 0,
		hive_promotions: 0,
		hive_encounters_incremented: 0,
		hive_advancements: 0,
		proposals_approved: 0,
		proposals_rejected: 0,
		proposals_skipped: 0,
	};
	const knowledgeConfig =
		options.knowledgeConfig ??
		(await _internals.loadDefaultKnowledgeConfig(directory));
	if (parsed.recommendations.length > 0) {
		try {
			const knowledgeResult = await _internals.applyCuratorKnowledgeUpdates(
				directory,
				parsed.recommendations,
				knowledgeConfig,
				generation,
			);
			result.knowledge_applied = knowledgeResult.applied;
			result.knowledge_skipped = knowledgeResult.skipped;
		} catch (err) {
			warnings.push(
				`Post-mortem knowledge actions failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
		try {
			const entries = await _internals.readSwarmKnowledge(directory);
			const hiveResult = await _internals.checkHivePromotions(
				entries,
				knowledgeConfig,
				directory,
			);
			result.hive_promotions = hiveResult.new_promotions;
			result.hive_encounters_incremented = hiveResult.encounters_incremented;
			result.hive_advancements = hiveResult.advancements;
		} catch (err) {
			warnings.push(
				`Post-mortem hive promotion check failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}
	if (parsed.queueTriage.length > 0) {
		try {
			const proposalResult = await _internals.applyProposalTriage(
				directory,
				parsed.queueTriage,
			);
			result.proposals_approved = proposalResult.approved.length;
			result.proposals_rejected = proposalResult.rejected.length;
			result.proposals_skipped = proposalResult.skipped.length;
		} catch (err) {
			warnings.push(
				`Post-mortem proposal triage failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}
	return { result, warnings };
}

async function verifyPostMortemKnowledgeActions(
	directory: string,
	recommendations: KnowledgeRecommendation[],
): Promise<KnowledgeActionVerification[]> {
	if (recommendations.length === 0) return [];
	const entries = await _internals.readSwarmKnowledge(directory);
	const activeEntries = entries.filter((entry) => isActiveStatus(entry.status));
	const exactIds = new Set(activeEntries.map((entry) => entry.id));
	const prefixMatches = new Map<string, SwarmKnowledgeEntry[]>();
	return recommendations.map((rec) => {
		const inputId =
			typeof rec.entry_id === 'string'
				? (normalizeRecommendationEntryIdToken(rec.entry_id) ?? null)
				: null;
		if (!inputId) {
			const isNewPromote = rec.action === 'promote';
			return {
				action: rec.action,
				input_entry_id: null,
				resolved_entry_id: null,
				status: isNewPromote ? 'new_entry' : 'missing_entry_id',
				reason: isNewPromote
					? 'promote without entry_id will create a new candidate if actionable'
					: `${rec.action} requires an existing entry_id`,
			};
		}

		if (exactIds.has(inputId)) {
			return {
				action: rec.action,
				input_entry_id: inputId,
				resolved_entry_id: inputId,
				status: 'exact_match',
				reason: 'entry_id matched an existing knowledge entry exactly',
			};
		}

		let matches = prefixMatches.get(inputId);
		if (!matches) {
			matches = activeEntries.filter((entry) => entry.id.startsWith(inputId));
			prefixMatches.set(inputId, matches);
		}
		if (matches.length === 1) {
			return {
				action: rec.action,
				input_entry_id: inputId,
				resolved_entry_id: matches[0].id,
				status: 'prefix_match',
				reason: 'entry_id prefix resolved to one existing knowledge entry',
			};
		}

		return {
			action: rec.action,
			input_entry_id: inputId,
			resolved_entry_id: null,
			status: matches.length === 0 ? 'not_found' : 'ambiguous_prefix',
			reason:
				matches.length === 0
					? 'entry_id did not match any existing knowledge entry'
					: `entry_id prefix matched ${matches.length} knowledge entries`,
		};
	});
}

function buildStateFreshnessSection(args: {
	planId: string;
	scope: 'session' | 'project';
	sessionID?: string;
	planLoaded: boolean;
	knowledgeSummary: KnowledgeEventSummary[];
	proposals: Array<{ source: string; content: string }>;
	unactionable: unknown[];
	retrospectives: string[];
	driftReports: string[];
}): string {
	const planContext = args.planLoaded
		? `loaded (${args.planId})`
		: 'unavailable (plan_id: unknown; project-level fallback)';
	return [
		'## Generated Against State',
		`- Plan context: ${planContext}`,
		`- Scope: ${args.scope}${args.sessionID ? ` (${args.sessionID})` : ''}`,
		`- Knowledge entries summarized: ${args.knowledgeSummary.length}`,
		`- Pending proposals summarized: ${args.proposals.length}`,
		`- Unactionable entries summarized: ${args.unactionable.length}`,
		`- Retrospectives summarized: ${args.retrospectives.length}`,
		`- Drift reports summarized: ${args.driftReports.length}`,
	].join('\n');
}

function buildActionVerificationSection(
	verification: KnowledgeActionVerification[],
): string {
	const lines = ['## Post-Mortem Action Verification'];
	if (verification.length === 0) {
		lines.push('- Knowledge actions: none supplied.');
		return lines.join('\n');
	}
	for (const item of verification) {
		const input = item.input_entry_id ?? 'new';
		const resolved = item.resolved_entry_id
			? ` => ${item.resolved_entry_id}`
			: '';
		lines.push(
			`- ${item.action}: ${input}${resolved} [${item.status}] ${item.reason}`,
		);
	}
	return lines.join('\n');
}

async function repairPostMortemActions(
	llmOutput: string,
	diagnostics: string[],
	options: PostMortemOptions,
): Promise<ParsedPostMortemActions | null> {
	if (!options.llmDelegate || diagnostics.length === 0) return null;
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), 30_000);
	try {
		const repairPrompt = [
			'Repair the supplied CURATOR_POSTMORTEM output into one valid fenced JSON block.',
			'Return only this fence:',
			'```json postmortem_actions',
			'{"summary":"...","curation_recommendations":[],"queue_triage":[]}',
			'```',
			'Allowed curation action values: promote, archive, rewrite, flag_contradiction.',
			'For new promote recommendations, include at least one scope field (applies_to_agents or applies_to_tools) and at least one predicate field (required_actions, forbidden_actions, or verification_checks).',
			'Existing entry_id values may be full UUIDs or unique 8+ character hex prefixes copied from KNOWLEDGE_ENTRIES.',
			'Allowed queue_triage action values: apply, reject.',
			'Do not include unsupported actions such as merge.',
			'Diagnostics:',
			diagnostics.join('; '),
			'Original output:',
			llmOutput.slice(0, 8000),
		].join('\n');
		const repaired = await options.llmDelegate('', repairPrompt, ac.signal);
		const parsed = _internals.parsePostMortemActions(repaired);
		if (parsed.diagnostics.length === 0) {
			return parsed;
		}
		return null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

function readJsonlFile(filePath: string, maxLines?: number): unknown[] {
	try {
		if (!existsSync(filePath)) return [];
		const content = readFileSync(filePath, 'utf-8');
		const results: unknown[] = [];
		const max = maxLines !== undefined && maxLines > 0 ? maxLines : Infinity;
		for (const line of content.split('\n')) {
			if (results.length >= max) break;
			if (!line.trim()) continue;
			try {
				results.push(JSON.parse(line));
			} catch {
				// skip corrupted line, continue with remaining lines
			}
		}
		return results;
	} catch {
		return [];
	}
}

function collectRetrospectives(directory: string): string[] {
	const results: string[] = [];
	const evidenceDir = path.join(directory, '.swarm', 'evidence');
	try {
		if (!existsSync(evidenceDir)) return results;
		const retroDirs = readdirSync(evidenceDir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && e.name.startsWith('retro-'))
			.slice(0, MAX_RETROSPECTIVES);
		for (const entry of retroDirs) {
			const retroPath = path.join(evidenceDir, entry.name, 'evidence.json');
			if (existsSync(retroPath)) {
				try {
					results.push(readFileSync(retroPath, 'utf-8'));
				} catch {
					// skip unreadable
				}
			}
		}
	} catch {
		// fail-open
	}
	return results;
}

async function collectDriftReports(directory: string): Promise<string[]> {
	try {
		const reports = await _internals.readPriorDriftReports(directory);
		return reports
			.slice(-MAX_DRIFT_REPORTS)
			.map((report) => JSON.stringify(report, null, 2));
	} catch {
		return [];
	}
}

function collectPendingProposals(
	directory: string,
): Array<{ source: string; content: string }> {
	const results: Array<{ source: string; content: string }> = [];

	// #2480: the durable queue is the `insight_candidate` stream in
	// `.swarm/swarm.db`; the legacy `.jsonl` is the pre-migration fallback
	// (never opened-for-create from a postmortem read).
	try {
		if (projectDbExists(directory)) {
			const pending = listPendingInsightCandidatesDb(directory, MAX_PROPOSALS);
			if (pending.length > 0) {
				results.push({
					source: 'insight-candidates',
					content: pending.join('\n'),
				});
			}
			return results;
		}
	} catch {
		// fall through to the legacy file read
	}

	const insightPath = path.join(
		directory,
		'.swarm',
		'insight-candidates.jsonl',
	);
	if (existsSync(insightPath)) {
		try {
			results.push({
				source: 'insight-candidates',
				content: readFileSync(insightPath, 'utf-8'),
			});
		} catch {
			// skip
		}
	}

	const proposalsDir = path.join(directory, '.swarm', 'skills', 'proposals');
	try {
		if (existsSync(proposalsDir)) {
			const proposalFiles = readdirSync(proposalsDir)
				.filter((e) => e.endsWith('.md') || e.endsWith('.json'))
				.slice(0, MAX_PROPOSALS);
			for (const entry of proposalFiles) {
				try {
					results.push({
						source: `proposals/${entry}`,
						content: readFileSync(path.join(proposalsDir, entry), 'utf-8'),
					});
				} catch {
					// skip
				}
			}
		}
	} catch {
		// fail-open
	}
	return results;
}

function isReportValid(reportPath: string): boolean {
	try {
		if (!existsSync(reportPath)) return false;
		const content = readFileSync(reportPath, 'utf-8').trim();
		if (content.length === 0) return false;
		if (!content.startsWith('# Post-Mortem Report:')) return false;
		return true;
	} catch {
		return false;
	}
}

// ============================================================================
// Lock helper (FR-009)
// ============================================================================

async function acquirePostMortemLock(
	directory: string,
	planId: string,
): Promise<{ acquired: boolean; release?: () => Promise<void> }> {
	const result = await tryAcquireLock(
		directory,
		`post-mortem-${planId}.lock`,
		'curator-postmortem',
		planId,
	);
	if (result.acquired) {
		return { acquired: true, release: result.lock?._release };
	}
	return { acquired: false };
}

// ============================================================================
// Report generation
// ============================================================================

function buildDataOnlyReport(
	planId: string,
	planSummary: string,
	knowledgeSummary: KnowledgeEventSummary[],
	curatorDigest: string | null,
	proposals: Array<{ source: string; content: string }>,
	unactionable: unknown[],
	retrospectives: string[],
	driftReports: string[],
	context?: {
		scope: 'session' | 'project';
		sessionID?: string;
		planLoaded: boolean;
	},
): string {
	const now = new Date().toISOString();
	const lines: string[] = [];

	lines.push(`# Post-Mortem Report: ${planId}`);
	lines.push(`Generated: ${now}`);
	lines.push('');
	lines.push(
		buildStateFreshnessSection({
			planId,
			scope: context?.scope ?? 'project',
			sessionID: context?.sessionID,
			planLoaded: context?.planLoaded ?? planId !== 'unknown',
			knowledgeSummary,
			proposals,
			unactionable,
			retrospectives,
			driftReports,
		}),
	);
	lines.push('');

	// Plan summary
	lines.push('## Project Summary');
	lines.push(planSummary);
	lines.push('');

	// Knowledge metrics
	lines.push('## Knowledge Metrics');
	const totalEntries = knowledgeSummary.length;
	const totalApplied = knowledgeSummary.reduce((s, e) => s + e.applied, 0);
	const totalViolated = knowledgeSummary.reduce((s, e) => s + e.violated, 0);
	const totalIgnored = knowledgeSummary.reduce((s, e) => s + e.ignored, 0);
	const totalUnacknowledged = knowledgeSummary.reduce(
		(s, e) => s + e.unacknowledged,
		0,
	);
	// `unacknowledged` is deliberately NOT part of this predicate: an entry a
	// delegate never answered for is still never-applied, and folding silence in
	// here would change the long-standing meaning of the retirement-review list.
	const neverApplied = knowledgeSummary.filter(
		(e) => e.applied === 0 && e.violated === 0 && e.ignored === 0,
	);

	lines.push(`- Total entries: ${totalEntries}`);
	lines.push(
		`- Application events: ${totalApplied} applied, ${totalViolated} violated, ${totalIgnored} ignored`,
	);
	// Reported on its own line, outside the application-rate arithmetic below:
	// silence is not a verdict and must not move the application rate.
	lines.push(
		`- Unacknowledged deliveries: ${totalUnacknowledged} (shown to a delegate that filed no ack/receipt)`,
	);
	lines.push(`- Never-applied entries: ${neverApplied.length}`);
	if (totalApplied + totalViolated > 0) {
		const appRate = (
			(totalApplied / (totalApplied + totalViolated)) *
			100
		).toFixed(1);
		lines.push(`- Application rate: ${appRate}%`);
	}
	lines.push('');

	// Stale entries
	if (neverApplied.length > 0) {
		lines.push('### Never-Applied Entries (review for retirement)');
		for (const e of neverApplied.slice(0, 10)) {
			lines.push(
				`- \`${e.id}\` (confidence: ${e.confidence.toFixed(2)}): ${e.lesson.slice(0, 80)}`,
			);
		}
		if (neverApplied.length > 10) {
			lines.push(`- ... and ${neverApplied.length - 10} more`);
		}
		lines.push('');
	}

	// High-violation entries
	const highViolation = knowledgeSummary
		.filter((e) => e.violated > 0)
		.sort((a, b) => b.violated - a.violated)
		.slice(0, 5);
	if (highViolation.length > 0) {
		lines.push('### High-Violation Entries');
		for (const e of highViolation) {
			lines.push(
				`- \`${e.id}\` — ${e.violated} violations, ${e.applied} applied: ${e.lesson.slice(0, 80)}`,
			);
		}
		lines.push('');
	}

	// Queue status
	lines.push('## Queue Status');
	lines.push(`- Pending proposals: ${proposals.length}`);
	lines.push(`- Unactionable quarantine: ${unactionable.length}`);
	for (const p of proposals) {
		lines.push(`  - ${p.source}`);
	}
	lines.push('');

	// Retrospectives summary
	if (retrospectives.length > 0) {
		lines.push('## Retrospectives');
		lines.push(`${retrospectives.length} phase retrospective(s) recorded.`);
		lines.push('');
	}

	// Drift summary
	if (driftReports.length > 0) {
		lines.push('## Drift Reports');
		for (const dr of driftReports) {
			try {
				const parsed = JSON.parse(dr);
				lines.push(
					`- Phase ${parsed.phase}: ${parsed.alignment} (score: ${parsed.drift_score})`,
				);
			} catch {
				lines.push('- (unparseable drift report)');
			}
		}
		lines.push('');
	}

	// Curator digest
	if (curatorDigest) {
		lines.push('## Curator Digest Summary');
		const trimmed =
			curatorDigest.length > 1000
				? `${curatorDigest.slice(0, 1000)}...`
				: curatorDigest;
		lines.push(trimmed);
		lines.push('');
	}

	return lines.join('\n');
}

function assembleLLMInput(
	planId: string,
	scope: 'session' | 'project',
	sessionID: string | undefined,
	planSummary: string,
	knowledgeSummary: KnowledgeEventSummary[],
	curatorDigest: string | null,
	proposals: Array<{ source: string; content: string }>,
	unactionable: unknown[],
	retrospectives: string[],
	driftReports: string[],
): string {
	const sections: string[] = [];

	sections.push(`TASK: CURATOR_POSTMORTEM ${planId}`);
	sections.push(`SCOPE: ${scope}${sessionID ? ` (${sessionID})` : ''}`);
	sections.push(`PLAN_SUMMARY: ${planSummary}`);

	sections.push(`CURATOR_DIGESTS: ${curatorDigest ?? 'none'}`);

	// `unacknowledged` is rendered alongside the verdict counts but is explicitly
	// NOT one of them: it is the count of deliveries a delegate never answered.
	// Surfacing it lets the post-mortem reason about silent delivery ("shown N
	// times, unacknowledged M times") instead of seeing an all-zero row.
	const eventsSummary = knowledgeSummary
		.map(
			(e) =>
				`${e.id}: applied=${e.applied} violated=${e.violated} ignored=${e.ignored} unacknowledged=${e.unacknowledged} confidence=${e.confidence.toFixed(2)} status=${e.status}`,
		)
		.join('\n');
	sections.push(`KNOWLEDGE_EVENTS_SUMMARY:\n${eventsSummary || 'none'}`);

	const knEntries = knowledgeSummary
		.map((e) =>
			JSON.stringify({
				id: e.id,
				lesson: e.lesson.slice(0, MAX_INPUT_TEXT_CHARS),
			}),
		)
		.join('\n');
	sections.push(`KNOWLEDGE_ENTRIES:\n${knEntries || '[]'}`);

	const proposalText =
		proposals.length > 0
			? proposals
					.map(
						(p) => `[${p.source}]\n${p.content.slice(0, MAX_INPUT_TEXT_CHARS)}`,
					)
					.join('\n---\n')
			: 'none';
	sections.push(`PENDING_PROPOSALS:\n${proposalText}`);

	sections.push(`UNACTIONABLE_QUARANTINE: ${unactionable.length} entries`);

	const retroText =
		retrospectives.length > 0
			? retrospectives
					.map((r) => r.slice(0, MAX_INPUT_TEXT_CHARS))
					.join('\n---\n')
			: 'none';
	sections.push(`RETROSPECTIVES:\n${retroText}`);

	if (driftReports.length > 0) {
		const driftText = driftReports
			.map((r) => r.slice(0, MAX_INPUT_TEXT_CHARS))
			.join('\n---\n');
		sections.push(`DRIFT_REPORTS:\n${driftText}`);
	}

	return sections.join('\n\n');
}

// ============================================================================
// Main entry point
// ============================================================================

export async function runCuratorPostMortem(
	directory: string,
	options: PostMortemOptions = {},
): Promise<PostMortemResult> {
	const warnings: string[] = [];
	const scope = options.scope ?? 'project';

	// Load plan to derive the plan ID
	let planId = 'unknown';
	let planSummary = 'Plan data unavailable.';
	let planLoaded = false;
	try {
		const plan = await loadPlanJsonOnly(directory);
		if (plan) {
			planLoaded = true;
			planId = derivePlanId(plan);
			const phaseCount = plan.phases?.length ?? 0;
			const completedPhases =
				plan.phases?.filter((p: { status?: string }) => p.status === 'complete')
					.length ?? 0;
			planSummary = `Plan "${plan.title}" (${plan.swarm}): ${completedPhases}/${phaseCount} phases complete.`;
		} else {
			warnings.push('Plan not found — using fallback plan ID.');
		}
	} catch {
		warnings.push('Failed to load plan data.');
	}

	// Check for existing report (idempotent dedup).
	// For planless runs (planId === 'unknown') we keep the stable 'unknown'
	// identifier so the isReportValid dedup check below works idempotently;
	// isReportValid rejects empty/invalid/partial reports, and --force
	// overrides for explicit regeneration. /swarm finalize archives and
	// cleans post-mortem-*.md at project end.
	const effectivePlanId = planId;
	const reportFilename = `post-mortem-${effectivePlanId}.md`;
	let reportPath: string;
	try {
		reportPath = validateSwarmPath(directory, reportFilename);
	} catch {
		return {
			success: false,
			planId, // unknown planId: path validation failed before dedup check
			reportPath: null,
			summary: null,
			warnings: [...warnings, 'Invalid report path.'],
		};
	}

	if (!options.force && isReportValid(reportPath)) {
		return {
			success: true,
			planId: effectivePlanId, // effectivePlanId
			reportPath,
			summary: 'Post-mortem report already exists (idempotent skip).',
			warnings,
		};
	}

	// FR-009: Acquire a non-blocking advisory lock to prevent concurrent
	// post-mortem runs from silently overwriting each other's output.
	const lock = await _internals.acquirePostMortemLock(
		directory,
		effectivePlanId,
	); // effectivePlanId
	if (!lock.acquired) {
		return {
			success: false,
			planId: effectivePlanId, // effectivePlanId
			reportPath,
			summary: null,
			warnings: [
				...warnings,
				`Concurrent post-mortem run in progress for plan ${effectivePlanId}; skipped.`,
			],
		};
	}

	try {
		// Collect evidence
		let knowledgeSummary: KnowledgeEventSummary[] = [];
		// #1848 §4 (F-09): capture the fair-scan-cursor generation for the batch
		// curated this sweep so executePostMortemActions can stamp mutated entries.
		const scanCursor: { generation?: number } = {};
		try {
			knowledgeSummary = await collectKnowledgeSummary(
				directory,
				scope,
				options.sessionID,
				scanCursor,
			);
		} catch {
			warnings.push('Failed to collect knowledge summary.');
		}
		// #1848 §4: the fair scan cursor returns a bounded batch; report the
		// remaining eligible work so the operator knows future sweeps will visit
		// the rest. The old fixed-window silently starved entries beyond 500.
		try {
			const { getScanStatus } = await import('../knowledge/scan-cursor.js');
			const scanStatus = await getScanStatus(directory);
			if (scanStatus.remaining_estimate > 0) {
				warnings.push(
					`Fair scan: reviewed ${knowledgeSummary.length} entries this sweep ` +
						`(generation ${scanStatus.generation}); ${scanStatus.remaining_estimate} ` +
						`more eligible entries will be visited in future curation sweeps.`,
				);
			}
		} catch {
			/* scan status is best-effort diagnostics */
		}

		let curatorDigest: string | null = null;
		try {
			const raw = await readSwarmFileAsync(directory, 'curator-summary.json');
			if (raw) {
				const parsed = JSON.parse(raw);
				curatorDigest = parsed.digest ?? null;
			}
		} catch {
			warnings.push('Failed to read curator digest.');
		}

		let proposals = collectPendingProposals(directory);
		if (proposals.length > MAX_PROPOSALS) {
			warnings.push(
				`Pending proposals capped at ${MAX_PROPOSALS} (had ${proposals.length}); older entries truncated.`,
			);
			proposals = proposals.slice(0, MAX_PROPOSALS);
		}
		const unactionablePath = path.join(
			resolveKnowledgeStoreDir(directory),
			'knowledge-unactionable.jsonl',
		);
		let unactionable = readJsonlFile(unactionablePath, MAX_UNACTIONABLE);
		if (unactionable.length > MAX_UNACTIONABLE) {
			warnings.push(
				`Unactionable entries capped at ${MAX_UNACTIONABLE} (had ${unactionable.length}); older entries truncated.`,
			);
			unactionable = unactionable.slice(0, MAX_UNACTIONABLE);
		}
		let retrospectives = collectRetrospectives(directory);
		if (retrospectives.length > MAX_RETROSPECTIVES) {
			warnings.push(
				`Retrospectives capped at ${MAX_RETROSPECTIVES} (had ${retrospectives.length}); older entries truncated.`,
			);
			retrospectives = retrospectives.slice(0, MAX_RETROSPECTIVES);
		}
		let driftReports = await collectDriftReports(directory);
		if (driftReports.length > MAX_DRIFT_REPORTS) {
			warnings.push(
				`Drift reports capped at ${MAX_DRIFT_REPORTS} (had ${driftReports.length}); older entries truncated.`,
			);
			driftReports = driftReports.slice(0, MAX_DRIFT_REPORTS);
		}

		// Generate report
		let reportContent: string;
		let llmSummary: string | null = null;
		let actionResult: PostMortemActionResult | undefined;

		if (options.llmDelegate) {
			try {
				const { CURATOR_POSTMORTEM_PROMPT } = await import(
					'../agents/explorer.js'
				);
				const userInput = assembleLLMInput(
					effectivePlanId,
					scope,
					options.sessionID,
					planSummary,
					knowledgeSummary,
					curatorDigest,
					proposals,
					unactionable,
					retrospectives,
					driftReports,
				);
				const ac = new AbortController();
				const timer = setTimeout(
					() => ac.abort(),
					options.llmTimeoutMs ?? 300_000,
				);
				let llmOutput: string;
				try {
					// Hoist to attach no-op catch before race — prevents unhandled
					// rejection when timeout fires and the delegate later rejects.
					const delegatePromise = options.llmDelegate(
						CURATOR_POSTMORTEM_PROMPT,
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
				let parsedActions = _internals.parsePostMortemActions(llmOutput);
				if (parsedActions.diagnostics.length > 0) {
					warnings.push(
						`Post-mortem structured action parse diagnostics: ${parsedActions.diagnostics.join('; ')}`,
					);
					const repaired = await _internals.repairPostMortemActions(
						llmOutput,
						parsedActions.diagnostics,
						options,
					);
					if (repaired) {
						parsedActions = repaired;
						warnings.push('Post-mortem structured actions repaired by LLM.');
					}
				}
				llmSummary = parsedActions.summary;
				const executed = await _internals.executePostMortemActions(
					directory,
					parsedActions,
					options,
					scanCursor.generation,
				);
				actionResult = executed.result;
				warnings.push(...executed.warnings);
				const knowledgeVerification =
					await _internals.verifyPostMortemKnowledgeActions(
						directory,
						parsedActions.recommendations,
					);
				for (const item of knowledgeVerification) {
					if (
						item.status === 'not_found' ||
						item.status === 'ambiguous_prefix' ||
						item.status === 'missing_entry_id'
					) {
						warnings.push(
							`Post-mortem knowledge action ${item.action} for '${item.input_entry_id ?? 'new'}' ${item.status}: ${item.reason}`,
						);
					}
				}
				const freshnessSummary = buildStateFreshnessSection({
					planId: effectivePlanId,
					scope,
					sessionID: options.sessionID,
					planLoaded,
					knowledgeSummary,
					proposals,
					unactionable,
					retrospectives,
					driftReports,
				});
				const verificationSummary = buildActionVerificationSection(
					knowledgeVerification,
				);
				const actionSummary = [
					'## Executed Post-Mortem Actions',
					`- Knowledge actions: ${actionResult.knowledge_applied} applied, ${actionResult.knowledge_skipped} skipped`,
					`- Hive actions: ${actionResult.hive_promotions} new promotions, ${actionResult.hive_encounters_incremented} encounters incremented, ${actionResult.hive_advancements} advancements`,
					`- Proposal actions: ${actionResult.proposals_approved} approved, ${actionResult.proposals_rejected} rejected, ${actionResult.proposals_skipped} skipped`,
				].join('\n');
				reportContent = `# Post-Mortem Report: ${effectivePlanId}\nGenerated: ${new Date().toISOString()}\nScope: ${scope}\n\n${freshnessSummary}\n\n${llmOutput}\n\n${verificationSummary}\n\n${actionSummary}`;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				warnings.push(
					`LLM delegate failed, falling back to data-only report: ${msg}`,
				);
				reportContent = _internals.buildDataOnlyReport(
					effectivePlanId,
					planSummary,
					knowledgeSummary,
					curatorDigest,
					proposals,
					unactionable,
					retrospectives,
					driftReports,
					{ scope, sessionID: options.sessionID, planLoaded },
				);
			}
		} else {
			reportContent = _internals.buildDataOnlyReport(
				effectivePlanId,
				planSummary,
				knowledgeSummary,
				curatorDigest,
				proposals,
				unactionable,
				retrospectives,
				driftReports,
				{ scope, sessionID: options.sessionID, planLoaded },
			);
		}

		// Write report
		try {
			const { mkdirSync } = await import('node:fs');
			mkdirSync(path.dirname(reportPath), { recursive: true });
			await atomicWriteFile(reportPath, reportContent);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				success: false,
				planId: effectivePlanId,
				reportPath: null,
				summary: null,
				warnings: [...warnings, `Failed to write report: ${msg}`],
			};
		}

		// Build 3-line summary for briefing
		const totalEntries = knowledgeSummary.length;
		const neverAppliedCount = knowledgeSummary.filter(
			(e) => e.applied === 0 && e.violated === 0 && e.ignored === 0,
		).length;
		const totalViolations = knowledgeSummary.reduce(
			(s, e) => s + e.violated,
			0,
		);
		const mechanicalSummary = [
			`Post-mortem for plan "${effectivePlanId}": ${totalEntries} knowledge entries reviewed.`,
			`${neverAppliedCount} never-applied entries flagged; ${totalViolations} total violations recorded.`,
			`${proposals.length} pending proposals, ${unactionable.length} quarantined entries.`,
		].join(' ');
		const summary = llmSummary ?? mechanicalSummary;

		return {
			success: true,
			planId: effectivePlanId,
			reportPath,
			summary,
			warnings,
			actions: actionResult,
		};
	} finally {
		if (lock.release) {
			try {
				await lock.release();
			} catch {
				// Release failure is non-fatal; proper-lockfile TTL will clean up.
			}
		}
	}
}

// ============================================================================
// DI Seam
// ============================================================================

export const _internals = {
	acquirePostMortemLock,
	collectKnowledgeSummary,
	collectRetrospectives,
	collectDriftReports,
	collectPendingProposals,
	readJsonlFile,
	buildDataOnlyReport,
	assembleLLMInput,
	buildStateFreshnessSection,
	buildActionVerificationSection,
	isReportValid,
	parsePostMortemActions,
	executePostMortemActions,
	verifyPostMortemKnowledgeActions,
	repairPostMortemActions,
	loadDefaultKnowledgeConfig: async (
		directory: string,
	): Promise<KnowledgeConfig> => {
		const { KnowledgeConfigSchema } = await import('../config/schema.js');
		// F-06: load the project's real knowledge config instead of always
		// returning schema defaults. Best-effort: on any load/parse failure fall
		// back to defaults so the post-mortem never fails on config problems.
		try {
			const { loadPluginConfigWithMeta } = await import('../config/index.js');
			const loaded = loadPluginConfigWithMeta(directory);
			return KnowledgeConfigSchema.parse(loaded.config.knowledge ?? {});
		} catch {
			return KnowledgeConfigSchema.parse({});
		}
	},
	applyCuratorKnowledgeUpdates: async (
		directory: string,
		recommendations: KnowledgeRecommendation[],
		knowledgeConfig: KnowledgeConfig,
		generation?: number,
	) => {
		const { applyCuratorKnowledgeUpdates } = await import('./curator.js');
		return applyCuratorKnowledgeUpdates(
			directory,
			recommendations,
			knowledgeConfig,
			generation,
		);
	},
	checkHivePromotions: async (
		entries: SwarmKnowledgeEntry[],
		knowledgeConfig: KnowledgeConfig,
		directory: string,
	) => {
		const { checkHivePromotions } = await import('./hive-promoter.js');
		return checkHivePromotions(entries, knowledgeConfig, directory);
	},
	applyProposalTriage: async (
		directory: string,
		triage: ParsedPostMortemActions['queueTriage'],
	) => {
		const {
			_internals: skillInternals,
			activateProposal,
			listSkills,
			sanitizeSlug,
		} = await import('../services/skill-generator.js');
		const result = {
			approved: [] as string[],
			rejected: [] as string[],
			skipped: [] as string[],
		};
		const skills = await listSkills(directory);
		const proposalSlugs = new Set(skills.proposals.map((p) => p.slug));
		for (const item of triage) {
			const slug = sanitizeSlug(normalizeProposalSlug(item.proposal_id));
			if (!slug || !proposalSlugs.has(slug)) {
				result.skipped.push(slug || item.proposal_id);
				continue;
			}
			if (item.action === 'apply') {
				const activation = await activateProposal(directory, slug, false, {
					evaluate: true,
					operation: 'post_mortem_queue_triage',
					// G8 (issue #1717): headless auto path preserves existing
					// semantics — the surface-and-confirm gate is enforced for
					// the interactive skill_apply tool only.
					confirmUnevaluated: true,
				});
				if (activation.activated) {
					result.approved.push(slug);
				} else {
					result.skipped.push(slug);
				}
				continue;
			}
			const proposal = skills.proposals.find((p) => p.slug === slug);
			if (!proposal) {
				result.skipped.push(slug);
				continue;
			}
			try {
				skillInternals.unlinkSync(proposal.path);
				result.rejected.push(slug);
			} catch {
				result.skipped.push(slug);
			}
		}
		return result;
	},
	readPriorDriftReports: async (directory: string) => {
		const { readPriorDriftReports } = await import('./curator-drift.js');
		return readPriorDriftReports(directory);
	},
	readSwarmKnowledge: (directory: string) =>
		readKnowledge<SwarmKnowledgeEntry>(resolveSwarmKnowledgePath(directory)),
};
