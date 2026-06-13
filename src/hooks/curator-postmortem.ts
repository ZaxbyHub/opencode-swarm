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
import { loadPlanJsonOnly } from '../plan/manager.js';
import { derivePlanId } from '../plan/utils.js';
import type { CuratorLLMDelegate } from './curator.js';
import { readKnowledgeEvents } from './knowledge-events.js';
import { readKnowledge, resolveSwarmKnowledgePath } from './knowledge-store.js';
import type { KnowledgeEntryBase } from './knowledge-types.js';
import { readSwarmFileAsync, validateSwarmPath } from './utils.js';

// ============================================================================
// Types
// ============================================================================

export interface PostMortemResult {
	success: boolean;
	planId: string | null;
	reportPath: string | null;
	summary: string | null;
	warnings: string[];
}

export interface PostMortemOptions {
	llmDelegate?: CuratorLLMDelegate;
	force?: boolean;
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

// ============================================================================
// Data collection helpers
// ============================================================================

async function collectKnowledgeSummary(
	directory: string,
): Promise<KnowledgeEventSummary[]> {
	const entries = await readKnowledge<KnowledgeEntryBase>(
		resolveSwarmKnowledgePath(directory),
	);
	const events = await readKnowledgeEvents(directory);

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

function readJsonlFile(filePath: string): unknown[] {
	try {
		if (!existsSync(filePath)) return [];
		const content = readFileSync(filePath, 'utf-8');
		return content
			.split('\n')
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}

function collectRetrospectives(directory: string): string[] {
	const results: string[] = [];
	const evidenceDir = path.join(directory, '.swarm', 'evidence');
	try {
		if (!existsSync(evidenceDir)) return results;
		for (const entry of readdirSync(evidenceDir, { withFileTypes: true })) {
			if (entry.isDirectory() && entry.name.startsWith('retro-')) {
				const retroPath = path.join(evidenceDir, entry.name, 'evidence.json');
				if (existsSync(retroPath)) {
					try {
						results.push(readFileSync(retroPath, 'utf-8'));
					} catch {
						// skip unreadable
					}
				}
			}
		}
	} catch {
		// fail-open
	}
	return results;
}

function collectDriftReports(directory: string): string[] {
	const results: string[] = [];
	const swarmDir = path.join(directory, '.swarm');
	try {
		if (!existsSync(swarmDir)) return results;
		for (const entry of readdirSync(swarmDir)) {
			if (entry.startsWith('drift-report-phase-') && entry.endsWith('.json')) {
				try {
					results.push(readFileSync(path.join(swarmDir, entry), 'utf-8'));
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
			for (const entry of readdirSync(proposalsDir)) {
				if (entry.endsWith('.md') || entry.endsWith('.json')) {
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
		}
	} catch {
		// fail-open
	}
	return results;
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
		.map((e) => JSON.stringify({ id: e.id, lesson: e.lesson }))
		.join('\n');
	sections.push(`KNOWLEDGE_ENTRIES:\n${knEntries || '[]'}`);

	const proposalText =
		proposals.length > 0
			? proposals
					.map((p) => `[${p.source}]\n${p.content.slice(0, 500)}`)
					.join('\n---\n')
			: 'none';
	sections.push(`PENDING_PROPOSALS:\n${proposalText}`);

	sections.push(`UNACTIONABLE_QUARANTINE: ${unactionable.length} entries`);

	const retroText =
		retrospectives.length > 0
			? retrospectives.map((r) => r.slice(0, 500)).join('\n---\n')
			: 'none';
	sections.push(`RETROSPECTIVES:\n${retroText}`);

	if (driftReports.length > 0) {
		const driftText = driftReports.map((r) => r.slice(0, 500)).join('\n---\n');
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
	const reportFilename = `post-mortem-${planId}.md`;
	let reportPath: string;
	try {
		reportPath = validateSwarmPath(directory, reportFilename);
	} catch {
		return {
			success: false,
			planId,
			reportPath: null,
			summary: null,
			warnings: [...warnings, 'Invalid report path.'],
		};
	}

	if (!options.force && existsSync(reportPath)) {
		return {
			success: true,
			planId,
			reportPath,
			summary: 'Post-mortem report already exists (idempotent skip).',
			warnings,
		};
	}

	// Collect evidence
	let knowledgeSummary: KnowledgeEventSummary[] = [];
	try {
		knowledgeSummary = await collectKnowledgeSummary(directory);
	} catch {
		warnings.push('Failed to collect knowledge summary.');
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

	const proposals = collectPendingProposals(directory);
	const unactionablePath = path.join(
		directory,
		'.swarm',
		'knowledge-unactionable.jsonl',
	);
	const unactionable = readJsonlFile(unactionablePath);
	const retrospectives = collectRetrospectives(directory);
	const driftReports = collectDriftReports(directory);

	// Generate report
	let reportContent: string;

	if (options.llmDelegate) {
		try {
			const { CURATOR_POSTMORTEM_PROMPT } = await import(
				'../agents/explorer.js'
			);
			const userInput = assembleLLMInput(
				planId,
				planSummary,
				knowledgeSummary,
				curatorDigest,
				proposals,
				unactionable,
				retrospectives,
				driftReports,
			);
			const llmOutput = await options.llmDelegate(
				CURATOR_POSTMORTEM_PROMPT,
				userInput,
			);
			reportContent = `# Post-Mortem Report: ${planId}\nGenerated: ${new Date().toISOString()}\n\n${llmOutput}`;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			warnings.push(
				`LLM delegate failed, falling back to data-only report: ${msg}`,
			);
			reportContent = buildDataOnlyReport(
				planId,
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
		reportContent = buildDataOnlyReport(
			planId,
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
		const { mkdirSync, writeFileSync } = await import('node:fs');
		mkdirSync(path.dirname(reportPath), { recursive: true });
		writeFileSync(reportPath, reportContent, 'utf-8');
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			success: false,
			planId,
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
	const totalViolations = knowledgeSummary.reduce((s, e) => s + e.violated, 0);
	const summary = [
		`Post-mortem for plan "${planId}": ${totalEntries} knowledge entries reviewed.`,
		`${neverAppliedCount} never-applied entries flagged; ${totalViolations} total violations recorded.`,
		`${proposals.length} pending proposals, ${unactionable.length} quarantined entries.`,
	].join(' ');

	return {
		success: true,
		planId,
		reportPath,
		summary,
		warnings,
	};
}

// ============================================================================
// DI Seam
// ============================================================================

export const _internals = {
	collectKnowledgeSummary,
	collectRetrospectives,
	collectDriftReports,
	collectPendingProposals,
	readJsonlFile,
	buildDataOnlyReport,
	assembleLLMInput,
};
