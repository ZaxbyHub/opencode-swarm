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
import { atomicWriteFile } from '../evidence/task-file.js';
import { tryAcquireLock } from '../parallel/file-locks.js';
import { loadPlanJsonOnly } from '../plan/manager.js';
import { derivePlanId } from '../plan/utils.js';
import type { CuratorLLMDelegate } from './curator.js';
import { readKnowledgeEvents } from './knowledge-events.js';
import { resolveKnowledgeStoreDir } from './knowledge-link.js';
import { readKnowledge, resolveSwarmKnowledgePath } from './knowledge-store.js';
import type { KnowledgeRecommendation } from './curator-types.js';
import type {
	KnowledgeConfig,
	KnowledgeEntryBase,
	KnowledgeCategory,
	SwarmKnowledgeEntry,
} from './knowledge-types.js';
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
): Promise<KnowledgeEventSummary[]> {
	const entries = await readKnowledge<KnowledgeEntryBase>(
		resolveSwarmKnowledgePath(directory),
		MAX_KNOWLEDGE_ENTRIES,
	);
	let events = await readKnowledgeEvents(directory, MAX_KNOWLEDGE_ENTRIES * 4);
	if (scope === 'session' && sessionID) {
		events = events.filter(
			(e) => (e as { session_id?: string }).session_id === sessionID,
		);
	}

	const countsMap = new Map<
		string,
		{ applied: number; violated: number; ignored: number }
	>();
	for (const e of events) {
		if (e.type !== 'applied' && e.type !== 'violated' && e.type !== 'ignored')
			continue;
		const kid =
			(e as { knowledge_id?: string }).knowledge_id ??
			(e as { entry_id?: string }).entry_id;
		if (!kid) continue;
		const c = countsMap.get(kid) ?? { applied: 0, violated: 0, ignored: 0 };
		if (e.type === 'applied') c.applied++;
		else if (e.type === 'violated') c.violated++;
		else if (e.type === 'ignored') c.ignored++;
		countsMap.set(kid, c);
	}

	return entries.map((entry) => {
		const c = countsMap.get(entry.id) ?? {
			applied: 0,
			violated: 0,
			ignored: 0,
		};
		return {
			id: entry.id,
			lesson: entry.lesson,
			applied: c.applied,
			violated: c.violated,
			ignored: c.ignored,
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
						typeof rec.entry_id === 'string' && rec.entry_id.trim()
							? rec.entry_id.trim()
							: undefined,
					lesson: (lesson || reason).slice(0, 280),
					reason: reason.slice(0, 280),
					category:
						typeof rec.category === 'string'
							? (rec.category as KnowledgeCategory)
							: undefined,
					confidence:
						typeof rec.confidence === 'number' ? rec.confidence : undefined,
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
		for (const line of curation.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed.startsWith('-')) continue;
			const body = trimmed.replace(/^-\s*/, '');
			const [head, reasonPart = ''] = body.split(/\s+—\s+|\s+-\s+/, 2);
			const [rawAction, rest = ''] = head.split(/:\s*/, 2);
			const action = normalizeRecommendationAction(rawAction);
			if (!action) continue;
			const idMatch = rest.match(
				/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
			);
			const reason = (reasonPart || rest).trim();
			if (!reason) continue;
			parsed.recommendations.push({
				action,
				entry_id: idMatch?.[0],
				lesson: reason.slice(0, 280),
				reason: reason.slice(0, 280),
			});
		}
	}
	const queue = extractSection(llmOutput, 'QUEUE_TRIAGE');
	if (queue) {
		for (const line of queue.split('\n')) {
			const match = line
				.trim()
				.match(/^-\s*([^:]+):\s*(APPLY|REJECT)\b\s*(?:—|-)?\s*(.*)$/i);
			if (!match) continue;
			parsed.queueTriage.push({
				proposal_id: match[1].trim().slice(0, 120),
				action: match[2].toLowerCase() as 'apply' | 'reject',
				reason: match[3].trim().slice(0, 280),
			});
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
		diagnostics: structured.diagnostics,
	};
}

async function executePostMortemActions(
	directory: string,
	parsed: ParsedPostMortemActions,
	options: PostMortemOptions,
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
		options.knowledgeConfig ?? (await _internals.loadDefaultKnowledgeConfig());
	if (parsed.recommendations.length > 0) {
		try {
			const knowledgeResult = await _internals.applyCuratorKnowledgeUpdates(
				directory,
				parsed.recommendations,
				knowledgeConfig,
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
): string {
	const now = new Date().toISOString();
	const lines: string[] = [];

	lines.push(`# Post-Mortem Report: ${planId}`);
	lines.push(`Generated: ${now}`);
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
	const neverApplied = knowledgeSummary.filter(
		(e) => e.applied === 0 && e.violated === 0 && e.ignored === 0,
	);

	lines.push(`- Total entries: ${totalEntries}`);
	lines.push(
		`- Application events: ${totalApplied} applied, ${totalViolated} violated, ${totalIgnored} ignored`,
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

	const eventsSummary = knowledgeSummary
		.map(
			(e) =>
				`${e.id}: applied=${e.applied} violated=${e.violated} ignored=${e.ignored} confidence=${e.confidence.toFixed(2)} status=${e.status}`,
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
	try {
		const plan = await loadPlanJsonOnly(directory);
		if (plan) {
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

	// Check for existing report (dedup protection)
	// When planId is 'unknown' (plan.json absent/unreadable), use a distinct
	// timestamped identifier so a stale post-mortem-unknown.md from a prior
	// run cannot permanently block regeneration.
	const effectivePlanId =
		planId === 'unknown' ? `unknown-${Date.now()}` : planId;
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
		try {
			knowledgeSummary = await collectKnowledgeSummary(
				directory,
				scope,
				options.sessionID,
			);
		} catch {
			warnings.push('Failed to collect knowledge summary.');
		}
		if (knowledgeSummary.length > MAX_KNOWLEDGE_ENTRIES) {
			warnings.push(
				`Knowledge entries capped at ${MAX_KNOWLEDGE_ENTRIES} (had ${knowledgeSummary.length}); older entries truncated.`,
			);
			knowledgeSummary = knowledgeSummary.slice(0, MAX_KNOWLEDGE_ENTRIES);
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
				);
				actionResult = executed.result;
				warnings.push(...executed.warnings);
				const actionSummary = [
					'## Executed Post-Mortem Actions',
					`- Knowledge actions: ${actionResult.knowledge_applied} applied, ${actionResult.knowledge_skipped} skipped`,
					`- Hive actions: ${actionResult.hive_promotions} new promotions, ${actionResult.hive_encounters_incremented} encounters incremented, ${actionResult.hive_advancements} advancements`,
					`- Proposal actions: ${actionResult.proposals_approved} approved, ${actionResult.proposals_rejected} rejected, ${actionResult.proposals_skipped} skipped`,
				].join('\n');
				reportContent = `# Post-Mortem Report: ${effectivePlanId}\nGenerated: ${new Date().toISOString()}\nScope: ${scope}\n\n${llmOutput}\n\n${actionSummary}`;
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
	isReportValid,
	parsePostMortemActions,
	executePostMortemActions,
	repairPostMortemActions,
	loadDefaultKnowledgeConfig: async (): Promise<KnowledgeConfig> => {
		const { KnowledgeConfigSchema } = await import('../config/schema.js');
		return KnowledgeConfigSchema.parse({});
	},
	applyCuratorKnowledgeUpdates: async (
		directory: string,
		recommendations: KnowledgeRecommendation[],
		knowledgeConfig: KnowledgeConfig,
	) => {
		const { applyCuratorKnowledgeUpdates } = await import('./curator.js');
		return applyCuratorKnowledgeUpdates(
			directory,
			recommendations,
			knowledgeConfig,
		);
	},
	checkHivePromotions: async (
		entries: SwarmKnowledgeEntry[],
		knowledgeConfig: KnowledgeConfig,
	) => {
		const { checkHivePromotions } = await import('./hive-promoter.js');
		return checkHivePromotions(entries, knowledgeConfig);
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
