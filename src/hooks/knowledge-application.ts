/**
 * Knowledge application tracking — distinguishes shown / acknowledged / applied
 * / ignored / violated outcomes for injected knowledge directives.
 *
 * Writes one JSONL line per outcome to `.swarm/knowledge-application.jsonl`,
 * and updates per-entry retrieval-outcome counters on the source knowledge file.
 */

import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { warn } from '../utils/logger.js';
import {
	readKnowledge,
	resolveHiveKnowledgePath,
	resolveSwarmKnowledgePath,
	rewriteKnowledge,
} from './knowledge-store.js';
import type {
	HiveKnowledgeEntry,
	KnowledgeApplicationRecord,
	KnowledgeApplicationResult,
	SwarmKnowledgeEntry,
} from './knowledge-types.js';

// ============================================================================
// Paths
// ============================================================================

export function resolveApplicationLogPath(directory: string): string {
	return path.join(directory, '.swarm', 'knowledge-application.jsonl');
}

// ============================================================================
// Acknowledgment parser
// ============================================================================

/**
 * Parse explicit knowledge-acknowledgment markers from architect text.
 * Recognised forms (case-insensitive, line-anchored or inline):
 *   KNOWLEDGE_APPLIED: <id>
 *   KNOWLEDGE_IGNORED: <id> reason=<reason>
 *   KNOWLEDGE_VIOLATED: <id> reason=<reason>
 */
export interface ParsedAcknowledgment {
	id: string;
	result: 'applied' | 'ignored' | 'violated';
	reason?: string;
}

const ACK_PATTERN =
	/KNOWLEDGE_(APPLIED|IGNORED|VIOLATED)\s*:\s*([0-9a-fA-F-]{8,64})(?:\s+reason\s*=\s*([^\n\r]+?))?(?=$|[\n\r]|\s+KNOWLEDGE_)/g;

export function parseAcknowledgments(text: string): ParsedAcknowledgment[] {
	if (!text || typeof text !== 'string') return [];
	const out: ParsedAcknowledgment[] = [];
	for (const m of text.matchAll(ACK_PATTERN)) {
		const verb = m[1].toLowerCase();
		const id = m[2];
		const reason = m[3]?.trim().slice(0, 280);
		const result =
			verb === 'applied'
				? 'applied'
				: verb === 'ignored'
					? 'ignored'
					: 'violated';
		out.push({ id, result, reason });
	}
	return out;
}

// ============================================================================
// JSONL audit writer
// ============================================================================

async function appendAudit(
	directory: string,
	record: KnowledgeApplicationRecord,
): Promise<void> {
	const filePath = resolveApplicationLogPath(directory);
	await mkdir(path.dirname(filePath), { recursive: true });
	await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf-8');
}

// ============================================================================
// Counter updaters
// ============================================================================

type CounterField =
	| 'shown_count'
	| 'acknowledged_count'
	| 'applied_explicit_count'
	| 'ignored_count'
	| 'violated_count';

interface FieldBump {
	field: CounterField;
	ids: string[];
}

/**
 * Apply one or more field bumps to swarm + hive knowledge files in a single
 * read/write per file. F-008: previously each ack issued two sequential
 * bumpCounters calls (e.g. applied_explicit_count + acknowledged_count),
 * each doing its own read+write. Coalescing them halves the per-ack I/O
 * and makes the worst-case cost O(files) regardless of how many fields
 * are bumped. The caller is expected to coalesce its own field updates
 * via this API; cross-call batching across separate acks is intentionally
 * not done here so that tests reading file state immediately after a
 * record* call observe up-to-date counters.
 */
async function bumpCountersBatch(
	directory: string,
	bumps: FieldBump[],
): Promise<void> {
	const filteredBumps = bumps.filter((b) => b.ids.length > 0);
	if (filteredBumps.length === 0) return;

	// Pre-build an id → fields[] map so the per-entry inner loop is O(fields)
	// instead of O(bumps × ids_per_bump) (.includes on each entry would be
	// quadratic for large ids arrays — see PR #799 critic review).
	const idToFields = new Map<string, CounterField[]>();
	for (const b of filteredBumps) {
		for (const id of b.ids) {
			const list = idToFields.get(id);
			if (list) list.push(b.field);
			else idToFields.set(id, [b.field]);
		}
	}

	const now = new Date().toISOString();
	const applyOne = <T extends SwarmKnowledgeEntry | HiveKnowledgeEntry>(
		entries: T[],
	): boolean => {
		let updated = false;
		for (const e of entries) {
			const fields = idToFields.get(e.id);
			if (!fields) continue;
			const ro = e.retrieval_outcomes as unknown as Record<string, unknown>;
			for (const field of fields) {
				ro[field] = ((ro[field] as number) ?? 0) + 1;
				if (field === 'applied_explicit_count') {
					(e as unknown as Record<string, unknown>).last_applied_at = now;
				}
				if (field === 'acknowledged_count') {
					(e as unknown as Record<string, unknown>).last_acknowledged_at = now;
				}
				updated = true;
			}
		}
		return updated;
	};

	const swarmPath = resolveSwarmKnowledgePath(directory);
	const swarm = await readKnowledge<SwarmKnowledgeEntry>(swarmPath);
	if (applyOne(swarm)) await rewriteKnowledge(swarmPath, swarm);

	const hivePath = resolveHiveKnowledgePath();
	if (existsSync(hivePath)) {
		const hive = await readKnowledge<HiveKnowledgeEntry>(hivePath);
		if (applyOne(hive)) await rewriteKnowledge(hivePath, hive);
	}
}

async function bumpCounters(
	directory: string,
	ids: string[],
	field: CounterField,
): Promise<void> {
	return bumpCountersBatch(directory, [{ ids, field }]);
}

// ============================================================================
// Public recording API
// ============================================================================

export interface RecordContext {
	phase?: string;
	taskId?: string;
	action?: string;
	tool?: string;
	targetAgent?: string;
	sessionId?: string;
}

/** Record one or more knowledge IDs as "shown" (injected into context). */
export async function recordKnowledgeShown(
	directory: string,
	ids: string[],
	ctx: RecordContext,
): Promise<void> {
	if (ids.length === 0) return;
	try {
		const ts = new Date().toISOString();
		for (const id of ids) {
			await appendAudit(directory, {
				timestamp: ts,
				phase: ctx.phase,
				taskId: ctx.taskId,
				action: ctx.action,
				tool: ctx.tool,
				targetAgent: ctx.targetAgent,
				sessionId: ctx.sessionId,
				knowledgeId: id,
				result: 'shown',
			});
		}
		await bumpCounters(directory, ids, 'shown_count');
	} catch (err) {
		warn(
			`[knowledge-application] recordKnowledgeShown failed: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
}

/** Record an explicit acknowledgment outcome (applied / ignored / violated).
 *  Per-(sessionId, knowledgeId, result, dayKey) dedup is enforced by the
 *  caller via swarmState.knowledgeAckDedup; this fn always records when
 *  invoked, so test code can trigger duplicates if needed. The runtime
 *  integration in src/index.ts uses recordAcknowledgmentDeduped instead. */
export async function recordAcknowledgment(
	directory: string,
	ack: ParsedAcknowledgment,
	ctx: RecordContext,
): Promise<void> {
	try {
		const result: KnowledgeApplicationResult = ack.result;
		await appendAudit(directory, {
			timestamp: new Date().toISOString(),
			phase: ctx.phase,
			taskId: ctx.taskId,
			action: ctx.action,
			tool: ctx.tool,
			targetAgent: ctx.targetAgent,
			sessionId: ctx.sessionId,
			knowledgeId: ack.id,
			result,
			reason: ack.reason,
		});
		const field: CounterField =
			result === 'applied'
				? 'applied_explicit_count'
				: result === 'ignored'
					? 'ignored_count'
					: 'violated_count';
		// Coalesce the result-field bump and the acknowledged_count bump into
		// a single read+write per file (F-008).
		await bumpCountersBatch(directory, [
			{ ids: [ack.id], field },
			{ ids: [ack.id], field: 'acknowledged_count' },
		]);
	} catch (err) {
		warn(
			`[knowledge-application] recordAcknowledgment failed: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
}

/** Day key in UTC; matches the default skill_improver quota window. */
function utcDayKey(d: Date = new Date()): string {
	return d.toISOString().slice(0, 10);
}

/** Build the dedup key. Exported so test code and the runtime integration
 *  share the exact format. */
export function buildAckDedupKey(
	sessionId: string,
	id: string,
	result: KnowledgeApplicationResult,
	now: Date = new Date(),
): string {
	return `${sessionId}|${id}|${result}|${utcDayKey(now)}`;
}

/** Acknowledgment recording with dedup. Returns whether a record was actually
 *  written (false on dedup hit). dedupSet should be swarmState.knowledgeAckDedup
 *  in production; tests can pass a fresh Set. */
export async function recordAcknowledgmentDeduped(
	directory: string,
	ack: ParsedAcknowledgment,
	ctx: RecordContext,
	dedupSet: Set<string>,
	now: Date = new Date(),
): Promise<boolean> {
	const sessionId = ctx.sessionId ?? 'unknown';
	const key = buildAckDedupKey(sessionId, ack.id, ack.result, now);
	if (dedupSet.has(key)) return false;
	dedupSet.add(key);
	await recordAcknowledgment(directory, ack, ctx);
	return true;
}

/**
 * Process a chunk of architect text: extract any KNOWLEDGE_* markers and record
 * each as an outcome. Returns the parsed list (empty if none).
 */
export async function processArchitectText(
	directory: string,
	text: string,
	ctx: RecordContext,
): Promise<ParsedAcknowledgment[]> {
	const acks = parseAcknowledgments(text);
	for (const ack of acks) {
		await recordAcknowledgment(directory, ack, ctx);
	}
	return acks;
}

// ============================================================================
// Read shown-but-not-applied set (used by enforcement gate)
// ============================================================================

export interface ShownNotAppliedQuery {
	taskId?: string;
	phase?: string;
	knowledgeIds: string[];
}

/**
 * Returns the subset of `knowledgeIds` that have at least one "shown" record
 * in the audit log without a subsequent "applied"/"ignored"/"violated" record
 * in the same task or phase scope.
 */
export async function getShownButNotAcknowledged(
	directory: string,
	q: ShownNotAppliedQuery,
): Promise<string[]> {
	const filePath = resolveApplicationLogPath(directory);
	if (!existsSync(filePath)) return q.knowledgeIds;
	const content = await readFile(filePath, 'utf-8');
	const records: KnowledgeApplicationRecord[] = [];
	for (const line of content.split('\n')) {
		const t = line.trim();
		if (!t) continue;
		try {
			records.push(JSON.parse(t) as KnowledgeApplicationRecord);
		} catch {
			// skip corrupted line
		}
	}
	const inScope = (r: KnowledgeApplicationRecord): boolean => {
		if (q.taskId && r.taskId === q.taskId) return true;
		if (q.phase && r.phase === q.phase) return true;
		return false;
	};
	const acknowledgedIds = new Set<string>();
	for (const r of records) {
		if (!inScope(r)) continue;
		if (
			r.result === 'applied' ||
			r.result === 'ignored' ||
			r.result === 'violated' ||
			r.result === 'acknowledged'
		) {
			acknowledgedIds.add(r.knowledgeId);
		}
	}
	return q.knowledgeIds.filter((id) => !acknowledgedIds.has(id));
}

// ============================================================================
// Enforcement gate
// ============================================================================

export interface KnowledgeApplicationConfig {
	enabled: boolean;
	mode: 'warn' | 'enforce';
	min_confidence: number;
	critical_requires_ack: boolean;
	require_skill_refs: boolean;
}

export const DEFAULT_KNOWLEDGE_APPLICATION_CONFIG: KnowledgeApplicationConfig =
	{
		enabled: true,
		mode: 'warn',
		min_confidence: 0.85,
		critical_requires_ack: true,
		require_skill_refs: true,
	};

export interface GateResult {
	allowed: boolean;
	mode: 'warn' | 'enforce';
	violations: Array<{ id: string; reason: string }>;
	warnings: Array<{ id: string; reason: string }>;
}

/**
 * Enforce the knowledge-application contract before a high-risk action.
 * In 'warn' mode: never blocks; returns { allowed: true } with warnings.
 * In 'enforce' mode: returns { allowed: false } if any critical+matching
 * directive is in `criticalShownIds` and not present in `recentArchitectText`.
 */
export function gateKnowledgeApplication(args: {
	criticalShownIds: string[];
	recentArchitectText: string;
	config: KnowledgeApplicationConfig;
}): GateResult {
	const { criticalShownIds, recentArchitectText, config } = args;
	const acks = parseAcknowledgments(recentArchitectText);
	const ackIds = new Set(acks.map((a) => a.id));
	const violations: GateResult['violations'] = [];
	const warnings: GateResult['warnings'] = [];
	for (const id of criticalShownIds) {
		if (!ackIds.has(id)) {
			const reason = `critical directive ${id} requires KNOWLEDGE_APPLIED/IGNORED ack`;
			if (config.mode === 'enforce' && config.critical_requires_ack) {
				violations.push({ id, reason });
			} else {
				warnings.push({ id, reason });
			}
		}
	}
	return {
		allowed: violations.length === 0,
		mode: config.mode,
		violations,
		warnings,
	};
}

/**
 * Filter knowledge entries by minimum confidence threshold.
 * Used by the knowledge reinjection hook to surface high-confidence
 * knowledge after context compression events.
 *
 * @param entries - Array of knowledge entries (swarm or hive)
 * @param threshold - Minimum confidence score (default 0.8)
 * @returns Filtered entries with confidence >= threshold
 */
export function filterHighConfidenceKnowledge<T extends { confidence: number }>(
	entries: T[],
	threshold: number = 0.8,
): T[] {
	return entries.filter((entry) => entry.confidence >= threshold);
}

// ============================================================================
// DI seam
// ============================================================================

export const _internals = {
	parseAcknowledgments,
	recordKnowledgeShown,
	recordAcknowledgment,
	recordAcknowledgmentDeduped,
	processArchitectText,
	getShownButNotAcknowledged,
	gateKnowledgeApplication,
	resolveApplicationLogPath,
	buildAckDedupKey,
};

// Suppress unused warning for lockfile when tests stub it elsewhere.
void lockfile;
