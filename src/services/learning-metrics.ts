import { readRecentEscalations } from '../hooks/knowledge-escalator.js';
import {
	type CounterRollup,
	type KnowledgeEvent,
	readKnowledgeCounterRollups,
	readKnowledgeEvents,
} from '../hooks/knowledge-events.js';
import {
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../hooks/knowledge-store.js';
import type { SwarmKnowledgeEntry } from '../hooks/knowledge-types.js';

export interface LearningMetrics {
	violationTrends: ViolationTrend[];
	overallViolationRate: { window7d: number; window30d: number };
	applicationRateByPriority: Record<
		string,
		{ applied: number; total: number; rate: number }
	>;
	timeToLatestApplication: TimeToApply[];
	escalationFrequency: { total: number; last7d: number; last30d: number };
	unacknowledgedCriticalCount: number;
	entryROI: EntryROI[];
	neverApplied: NeverAppliedEntry[];
	learningSummary: string;
	sessionCount: number;
}

export interface ViolationTrend {
	entryId: string;
	lesson: string;
	priority: string;
	violationRate7d: number;
	violationRate30d: number;
	trend: 'improving' | 'worsening' | 'stable' | 'no_data';
}

export interface EntryROI {
	entryId: string;
	lesson: string;
	appliedCount: number;
	shownCount: number;
	succeededCount: number;
	failedCount: number;
	roi: 'high' | 'medium' | 'low' | 'unused';
}

export interface TimeToApply {
	entryId: string;
	lesson: string;
	daysToApply: number | null;
}

export interface NeverAppliedEntry {
	entryId: string;
	lesson: string;
	phasesAlive: number;
}

export interface LearningMetricsOptions {
	now?: Date;
	currentPhase?: number;
	signal?: AbortSignal;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_PHASES_ALIVE_THRESHOLD = 3;
const MAX_LESSON_DISPLAY_CHARS = 60;

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw new Error('Learning metrics computation aborted');
}

function safeDivide(numerator: number, denominator: number): number {
	return denominator === 0 ? 0 : numerator / denominator;
}

function truncateLesson(lesson: string): string {
	if (lesson.length <= MAX_LESSON_DISPLAY_CHARS) return lesson;
	return `${lesson.slice(0, MAX_LESSON_DISPLAY_CHARS - 3)}...`;
}

function isReceiptType(
	event: KnowledgeEvent,
): event is KnowledgeEvent & { type: string; knowledge_id: string } {
	return (
		event.type === 'acknowledged' ||
		event.type === 'applied' ||
		event.type === 'ignored' ||
		event.type === 'contradicted' ||
		event.type === 'violated' ||
		event.type === 'n_a' ||
		event.type === 'override'
	);
}

function countWindowedReceipts(
	events: KnowledgeEvent[],
	entryId: string,
	windowMs: number,
	nowMs: number,
): { violations: number; totalReceipts: number } {
	const cutoff = nowMs - windowMs;
	let violations = 0;
	let totalReceipts = 0;
	for (const e of events) {
		if (!isReceiptType(e)) continue;
		if (e.knowledge_id !== entryId) continue;
		const t = Date.parse(e.timestamp);
		if (Number.isNaN(t) || t < cutoff) continue;
		totalReceipts++;
		if (e.type === 'violated') violations++;
	}
	return { violations, totalReceipts };
}

function determineTrend(
	rate7d: number,
	rate30d: number,
	hasData: boolean,
): ViolationTrend['trend'] {
	if (!hasData) return 'no_data';
	if (rate7d < rate30d) return 'improving';
	if (rate7d > rate30d) return 'worsening';
	return 'stable';
}

function classifyROI(rollup: CounterRollup): EntryROI['roi'] {
	if (
		rollup.applied_explicit_count > 0 &&
		rollup.succeeded_after_shown_count > rollup.failed_after_shown_count
	) {
		return 'high';
	}
	if (rollup.applied_explicit_count > 0) {
		return 'medium';
	}
	if (rollup.shown_count > 0) {
		return 'low';
	}
	return 'unused';
}

export async function computeLearningMetrics(
	directory: string,
	options?: LearningMetricsOptions,
): Promise<LearningMetrics> {
	throwIfAborted(options?.signal);
	const now = options?.now ?? new Date();
	const nowMs = now.getTime();
	const phasesThreshold =
		options?.currentPhase ?? DEFAULT_PHASES_ALIVE_THRESHOLD;

	const [events, entries, rollups] = await Promise.all([
		readKnowledgeEvents(directory),
		readKnowledge<SwarmKnowledgeEntry>(resolveSwarmKnowledgePath(directory)),
		readKnowledgeCounterRollups(directory),
	]);
	throwIfAborted(options?.signal);

	if (events.length === 0 && entries.length === 0) {
		return emptyMetrics();
	}

	const entryMap = new Map<string, SwarmKnowledgeEntry>();
	for (const entry of entries) {
		throwIfAborted(options?.signal);
		entryMap.set(entry.id, entry);
	}

	const sessionIds = new Set<string>();
	for (const e of events) {
		throwIfAborted(options?.signal);
		if ('session_id' in e && typeof e.session_id === 'string') {
			sessionIds.add(e.session_id);
		}
	}
	const sessionCount = sessionIds.size;

	// Violation trends
	const violationTrends: ViolationTrend[] = [];
	for (const [entryId, rollup] of rollups) {
		throwIfAborted(options?.signal);
		if (rollup.violated_count === 0) continue;
		const entry = entryMap.get(entryId);
		const lesson = entry?.lesson ?? entryId;
		const priority = entry?.directive_priority ?? 'medium';

		const w7 = countWindowedReceipts(events, entryId, SEVEN_DAYS_MS, nowMs);
		const w30 = countWindowedReceipts(events, entryId, THIRTY_DAYS_MS, nowMs);

		const rate7d = safeDivide(w7.violations, w7.totalReceipts);
		const rate30d = safeDivide(w30.violations, w30.totalReceipts);
		const hasData = w7.totalReceipts > 0 || w30.totalReceipts > 0;

		violationTrends.push({
			entryId,
			lesson,
			priority,
			violationRate7d: rate7d,
			violationRate30d: rate30d,
			trend: determineTrend(rate7d, rate30d, hasData),
		});
	}

	// Overall violation rate
	let totalViolations7d = 0;
	let totalReceipts7d = 0;
	let totalViolations30d = 0;
	let totalReceipts30d = 0;
	for (const e of events) {
		throwIfAborted(options?.signal);
		if (!isReceiptType(e)) continue;
		const t = Date.parse(e.timestamp);
		if (Number.isNaN(t)) continue;
		if (t >= nowMs - SEVEN_DAYS_MS) {
			totalReceipts7d++;
			if (e.type === 'violated') totalViolations7d++;
		}
		if (t >= nowMs - THIRTY_DAYS_MS) {
			totalReceipts30d++;
			if (e.type === 'violated') totalViolations30d++;
		}
	}
	const overallViolationRate = {
		window7d: safeDivide(totalViolations7d, totalReceipts7d),
		window30d: safeDivide(totalViolations30d, totalReceipts30d),
	};

	// Application rate by priority
	const priorityGroups = new Map<string, { applied: number; total: number }>();
	for (const entry of entries) {
		throwIfAborted(options?.signal);
		const priority = entry.directive_priority ?? 'medium';
		const rollup = rollups.get(entry.id);
		if (!rollup) continue;
		let group = priorityGroups.get(priority);
		if (!group) {
			group = { applied: 0, total: 0 };
			priorityGroups.set(priority, group);
		}
		group.applied += rollup.applied_explicit_count;
		group.total += rollup.shown_count;
	}
	const applicationRateByPriority: Record<
		string,
		{ applied: number; total: number; rate: number }
	> = {};
	for (const [priority, group] of priorityGroups) {
		applicationRateByPriority[priority] = {
			applied: group.applied,
			total: group.total,
			rate: safeDivide(group.applied, group.total),
		};
	}

	// Time to first application
	const timeToLatestApplication: TimeToApply[] = [];
	for (const entry of entries) {
		const rollup = rollups.get(entry.id);
		let daysToApply: number | null = null;
		if (rollup?.last_applied_at && entry.created_at) {
			const appliedMs = Date.parse(rollup.last_applied_at);
			const createdMs = Date.parse(entry.created_at);
			if (
				!Number.isNaN(appliedMs) &&
				!Number.isNaN(createdMs) &&
				appliedMs >= createdMs
			) {
				daysToApply = (appliedMs - createdMs) / MS_PER_DAY;
			}
		}
		timeToLatestApplication.push({
			entryId: entry.id,
			lesson: entry.lesson,
			daysToApply,
		});
	}

	// Escalation frequency
	const recentEscalations30d = await readRecentEscalations(directory, 30, now);
	throwIfAborted(options?.signal);
	const last7dCutoff = nowMs - SEVEN_DAYS_MS;
	const last7d = recentEscalations30d.filter((esc) => {
		const t = Date.parse(esc.at);
		return !Number.isNaN(t) && t >= last7dCutoff;
	}).length;
	let totalEscalations = 0;
	for (const e of events) {
		throwIfAborted(options?.signal);
		if (e.type === 'escalation') totalEscalations++;
	}
	const escalationFrequency = {
		total: totalEscalations,
		last7d,
		last30d: recentEscalations30d.length,
	};

	// Unacknowledged critical
	let unacknowledgedCriticalCount = 0;
	for (const entry of entries) {
		throwIfAborted(options?.signal);
		if (entry.directive_priority !== 'critical') continue;
		const rollup = rollups.get(entry.id);
		if (!rollup) continue;
		if (
			rollup.shown_count > 0 &&
			rollup.acknowledged_count === 0 &&
			rollup.applied_explicit_count === 0
		) {
			unacknowledgedCriticalCount++;
		}
	}

	// Entry ROI
	const entryROI: EntryROI[] = [];
	for (const entry of entries) {
		throwIfAborted(options?.signal);
		const rollup = rollups.get(entry.id);
		if (!rollup) {
			entryROI.push({
				entryId: entry.id,
				lesson: entry.lesson,
				appliedCount: 0,
				shownCount: 0,
				succeededCount: 0,
				failedCount: 0,
				roi: 'unused',
			});
			continue;
		}
		entryROI.push({
			entryId: entry.id,
			lesson: entry.lesson,
			appliedCount: rollup.applied_explicit_count,
			shownCount: rollup.shown_count,
			succeededCount: rollup.succeeded_after_shown_count,
			failedCount: rollup.failed_after_shown_count,
			roi: classifyROI(rollup),
		});
	}

	// Never applied
	const neverApplied: NeverAppliedEntry[] = [];
	for (const entry of entries) {
		throwIfAborted(options?.signal);
		const rollup = rollups.get(entry.id);
		const applied = rollup?.applied_explicit_count ?? 0;
		const phasesAlive = entry.phases_alive ?? 0;
		if (applied === 0 && phasesAlive >= phasesThreshold) {
			neverApplied.push({
				entryId: entry.id,
				lesson: entry.lesson,
				phasesAlive,
			});
		}
	}

	// Learning summary
	const learningSummary = buildLearningSummary(
		overallViolationRate,
		violationTrends,
		sessionCount,
	);

	return {
		violationTrends,
		overallViolationRate,
		applicationRateByPriority,
		timeToLatestApplication,
		escalationFrequency,
		unacknowledgedCriticalCount,
		entryROI,
		neverApplied,
		learningSummary,
		sessionCount,
	};
}

function emptyMetrics(): LearningMetrics {
	return {
		violationTrends: [],
		overallViolationRate: { window7d: 0, window30d: 0 },
		applicationRateByPriority: {},
		timeToLatestApplication: [],
		escalationFrequency: { total: 0, last7d: 0, last30d: 0 },
		unacknowledgedCriticalCount: 0,
		entryROI: [],
		neverApplied: [],
		learningSummary: 'No learning data yet',
		sessionCount: 0,
	};
}

function buildLearningSummary(
	overallRate: { window7d: number; window30d: number },
	trends: ViolationTrend[],
	sessionCount: number,
): string {
	const overallTrend =
		overallRate.window7d < overallRate.window30d
			? 'improving'
			: overallRate.window7d > overallRate.window30d
				? 'worsening'
				: 'stable';

	const rate7dPct = (overallRate.window7d * 100).toFixed(1);
	const rate30dPct = (overallRate.window30d * 100).toFixed(1);

	const line1 = `Learning trend: ${overallTrend} — ${rate7dPct}% violation rate (7d), ${rate30dPct}% (30d) across ${sessionCount} sessions`;

	// Top improvement: entry with biggest 30d→7d drop
	let line2 = 'No improvement data yet';
	let bestDrop = 0;
	let bestDropEntry: ViolationTrend | undefined;
	for (const t of trends) {
		if (t.trend !== 'improving') continue;
		const drop = t.violationRate30d - t.violationRate7d;
		if (drop > bestDrop) {
			bestDrop = drop;
			bestDropEntry = t;
		}
	}
	if (bestDropEntry) {
		line2 = `Top improvement: ${truncateLesson(bestDropEntry.lesson)}`;
	}

	// Watch: entry with worst violation trend
	let line3 = 'No concerns detected';
	let worstRise = 0;
	let worstEntry: ViolationTrend | undefined;
	for (const t of trends) {
		if (t.trend !== 'worsening') continue;
		const rise = t.violationRate7d - t.violationRate30d;
		if (rise > worstRise) {
			worstRise = rise;
			worstEntry = t;
		}
	}
	if (worstEntry) {
		line3 = `Watch: ${truncateLesson(worstEntry.lesson)}`;
	}

	return `${line1}\n${line2}\n${line3}`;
}

export function formatLearningMarkdown(metrics: LearningMetrics): string {
	const lines: string[] = [];

	lines.push('## Learning Summary', '', metrics.learningSummary, '');

	// Violation Trends
	lines.push('## Violation Trends', '');
	if (metrics.violationTrends.length === 0) {
		lines.push('No violation trends recorded.', '');
	} else {
		lines.push('| Entry | Priority | 7d Rate | 30d Rate | Trend |');
		lines.push('|-------|----------|---------|----------|-------|');
		for (const t of metrics.violationTrends) {
			lines.push(
				`| ${truncateLesson(t.lesson)} | ${t.priority} | ${(t.violationRate7d * 100).toFixed(1)}% | ${(t.violationRate30d * 100).toFixed(1)}% | ${t.trend} |`,
			);
		}
		lines.push('');
	}

	// Application Rates by Priority
	lines.push('## Application Rates by Priority', '');
	const priorities = Object.keys(metrics.applicationRateByPriority);
	if (priorities.length === 0) {
		lines.push('No application data recorded.', '');
	} else {
		lines.push('| Priority | Applied | Total | Rate |');
		lines.push('|----------|---------|-------|------|');
		for (const p of priorities) {
			const g = metrics.applicationRateByPriority[p];
			lines.push(
				`| ${p} | ${g.applied} | ${g.total} | ${(g.rate * 100).toFixed(1)}% |`,
			);
		}
		lines.push('');
	}

	// Escalation Activity
	lines.push('## Escalation Activity', '');
	lines.push(`- Total escalations: ${metrics.escalationFrequency.total}`);
	lines.push(`- Last 7 days: ${metrics.escalationFrequency.last7d}`);
	lines.push(`- Last 30 days: ${metrics.escalationFrequency.last30d}`);
	lines.push('');

	// Entry ROI
	lines.push('## Entry ROI', '');
	const sortedROI = [...metrics.entryROI].sort(
		(a, b) => b.shownCount - a.shownCount,
	);
	const top10 = sortedROI.slice(0, 10);
	const unused = metrics.entryROI.filter((r) => r.roi === 'unused');
	const roiEntries = [...top10];
	for (const u of unused) {
		if (!roiEntries.some((r) => r.entryId === u.entryId)) {
			roiEntries.push(u);
		}
	}
	if (roiEntries.length === 0) {
		lines.push('No ROI data recorded.', '');
	} else {
		lines.push('| Entry | Applied | Shown | Succeeded | Failed | ROI |');
		lines.push('|-------|---------|-------|-----------|--------|-----|');
		for (const r of roiEntries) {
			lines.push(
				`| ${truncateLesson(r.lesson)} | ${r.appliedCount} | ${r.shownCount} | ${r.succeededCount} | ${r.failedCount} | ${r.roi} |`,
			);
		}
		lines.push('');
	}

	// Never Applied
	lines.push('## Never Applied', '');
	if (metrics.neverApplied.length === 0) {
		lines.push(
			'All entries have been applied or are below the phase threshold.',
			'',
		);
	} else {
		lines.push('| Entry | Phases Alive |');
		lines.push('|-------|-------------|');
		for (const n of metrics.neverApplied) {
			lines.push(`| ${truncateLesson(n.lesson)} | ${n.phasesAlive} |`);
		}
		lines.push('');
	}

	lines.push('## Time to Latest Application', '');
	const applied = metrics.timeToLatestApplication
		.filter((t) => t.daysToApply !== null)
		.map((t) => t.daysToApply as number);
	if (applied.length === 0) {
		lines.push('No application timing data available.', '');
	} else {
		applied.sort((a, b) => a - b);
		const median =
			applied.length % 2 === 0
				? (applied[applied.length / 2 - 1] + applied[applied.length / 2]) / 2
				: applied[Math.floor(applied.length / 2)];
		const min = applied[0];
		const max = applied[applied.length - 1];
		lines.push(`- Median: ${median.toFixed(1)} days`);
		lines.push(`- Min: ${min.toFixed(1)} days`);
		lines.push(`- Max: ${max.toFixed(1)} days`);
		lines.push(`- Entries with data: ${applied.length}`);
		lines.push('');
	}

	return lines.join('\n');
}

export function formatLearningJSON(metrics: LearningMetrics): object {
	return metrics;
}

export function formatLearningSummary(metrics: LearningMetrics): string {
	return metrics.learningSummary;
}

export const _internals = {
	computeLearningMetrics,
	formatLearningMarkdown,
	formatLearningJSON,
	formatLearningSummary,
};
