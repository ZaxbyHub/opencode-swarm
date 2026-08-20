import type { MemoryAnchor, MemoryOutcome, MemoryRecord } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HALF_LIFE_DAYS = 30;
const SCORE_PRECISION = 1_000_000;
const MAX_CATEGORY_ITEMS = 200;
const MAX_DISPLAY_CHARS = 512;

export interface ReflectionAnchorStatus {
	alive: boolean;
	packageBoundary?: string;
}

export interface ReflectionDigestItem {
	memoryId: string;
	text: string;
	anchor?: MemoryAnchor;
	group?: string;
	score: number;
	positiveOutcomes: number;
	negativeOutcomes: number;
	latestAt: string;
	resolution?: MemoryOutcome['outcome'];
}

export interface ReflectionCorrection {
	memoryId: string;
	correction: string;
	at: string;
	anchor?: MemoryAnchor;
	group?: string;
}

export interface ReflectionDigest {
	preferred: ReflectionDigestItem[];
	tentative: ReflectionDigestItem[];
	contested: ReflectionDigestItem[];
	deadEnds: ReflectionDigestItem[];
	corrections: ReflectionCorrection[];
	deadAnchorMemoryIds: string[];
	generatedFrom: { entries: number; asOf: string };
}

export interface BuildReflectionOptions {
	halfLifeDays?: number;
	resolveAnchor?: (anchor: MemoryAnchor) => ReflectionAnchorStatus;
}

interface OutcomeWithId {
	id: string;
	value: MemoryOutcome;
}

export function buildReflectionDigest(
	entries: readonly MemoryRecord[],
	now: Date,
	opts: BuildReflectionOptions = {},
): ReflectionDigest {
	const halfLifeDays =
		Number.isFinite(opts.halfLifeDays) && (opts.halfLifeDays ?? 0) > 0
			? (opts.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS)
			: DEFAULT_HALF_LIFE_DAYS;
	const preferred: ReflectionDigestItem[] = [];
	const tentative: ReflectionDigestItem[] = [];
	const contested: ReflectionDigestItem[] = [];
	const deadEnds: ReflectionDigestItem[] = [];
	const corrections: ReflectionCorrection[] = [];
	const deadAnchorMemoryIds = new Set<string>();

	for (const record of [...entries].sort((a, b) => compareText(a.id, b.id))) {
		const outcomes = outcomesWithIds(record);
		if (outcomes.length === 0) continue;
		const anchors = record.anchors?.length ? record.anchors : [undefined];
		const statuses = anchors.map((anchor) =>
			anchor && opts.resolveAnchor
				? opts.resolveAnchor(anchor)
				: ({ alive: true } satisfies ReflectionAnchorStatus),
		);
		const allDead = anchors.every(
			(anchor, index) =>
				anchor !== undefined && statuses[index]?.alive === false,
		);
		if (allDead) deadAnchorMemoryIds.add(record.id);
		const firstLiveAnchorIndex = statuses.findIndex((status) => status.alive);
		if (firstLiveAnchorIndex >= 0) {
			for (const outcome of outcomes) {
				if (outcome.value.outcome === 'corrected' && outcome.value.correction) {
					corrections.push({
						memoryId: record.id,
						correction: clip(outcome.value.correction),
						at: outcome.value.at,
						anchor: anchors[firstLiveAnchorIndex],
						group: statuses[firstLiveAnchorIndex]?.packageBoundary,
					});
				}
			}
		}

		for (const [index, anchor] of anchors.entries()) {
			const status = statuses[index] ?? { alive: true };
			if (!status.alive) continue;
			const item = scoreItem(
				record,
				anchor,
				status,
				outcomes,
				now,
				halfLifeDays,
			);
			const hasPositive = item.positiveOutcomes > 0;
			const hasNegative = item.negativeOutcomes > 0;
			if (hasPositive && hasNegative) contested.push(item);
			else if (hasPositive && item.positiveOutcomes >= 2 && !allDead)
				preferred.push(item);
			else if (hasPositive && !allDead) tentative.push(item);
			else if (hasNegative) deadEnds.push(item);
		}
	}

	return {
		preferred: stableItems(preferred),
		tentative: stableItems(tentative),
		contested: stableItems(contested),
		deadEnds: stableItems(deadEnds),
		corrections: corrections
			.sort(
				(a, b) =>
					compareText(b.at, a.at) ||
					compareText(a.group ?? '', b.group ?? '') ||
					compareText(a.memoryId, b.memoryId) ||
					compareText(a.anchor?.file ?? '', b.anchor?.file ?? ''),
			)
			.slice(0, MAX_CATEGORY_ITEMS),
		deadAnchorMemoryIds: [...deadAnchorMemoryIds].sort(),
		generatedFrom: {
			entries: entries.length,
			asOf: now.toISOString(),
		},
	};
}

export function renderReflectionMarkdown(digest: ReflectionDigest): string {
	const lines = [
		'# Swarm Memory Lessons',
		'',
		`Generated from ${digest.generatedFrom.entries} entries as of ${digest.generatedFrom.asOf}.`,
	];
	renderItems(lines, 'Preferred sources', digest.preferred);
	renderItems(lines, 'Tentative sources', digest.tentative);
	renderItems(lines, 'Contested sources', digest.contested);
	renderItems(lines, 'Known dead ends', digest.deadEnds);
	lines.push('', '## Prior corrections');
	if (digest.corrections.length === 0) lines.push('', '- None.');
	else {
		for (const correction of digest.corrections) {
			const location = correction.anchor?.file
				? ` (${correction.anchor.file})`
				: '';
			lines.push(
				`- [${correction.memoryId}]${location} ${correction.correction}`,
			);
		}
	}
	if (digest.deadAnchorMemoryIds.length > 0) {
		lines.push('', '## Structurally stale memories', '');
		for (const id of digest.deadAnchorMemoryIds) lines.push(`- ${id}`);
	}
	return `${lines.join('\n')}\n`;
}

function outcomesWithIds(record: MemoryRecord): OutcomeWithId[] {
	const ids = Array.isArray(record.metadata.outcomeEventIds)
		? record.metadata.outcomeEventIds.filter(
				(value): value is string => typeof value === 'string',
			)
		: [];
	const distinct = new Map<string, OutcomeWithId>();
	for (const [index, value] of (record.outcomes ?? []).entries()) {
		const id =
			ids[index] ?? `${record.id}:${index}:${value.at}:${value.outcome}`;
		if (!distinct.has(id)) distinct.set(id, { id, value });
	}
	return [...distinct.values()];
}

function scoreItem(
	record: MemoryRecord,
	anchor: MemoryAnchor | undefined,
	status: ReflectionAnchorStatus,
	outcomes: OutcomeWithId[],
	now: Date,
	halfLifeDays: number,
): ReflectionDigestItem {
	let score = 0;
	let positiveOutcomes = 0;
	let negativeOutcomes = 0;
	const positiveIds = new Set<string>();
	let latest = outcomes[0]!;
	for (const outcome of outcomes) {
		if (
			compareText(outcome.value.at, latest.value.at) > 0 ||
			(outcome.value.at === latest.value.at &&
				compareText(outcome.id, latest.id) > 0)
		) {
			latest = outcome;
		}
		const atMs = Date.parse(outcome.value.at);
		const ageDays = Number.isFinite(atMs)
			? Math.max(0, (now.getTime() - atMs) / DAY_MS)
			: 0;
		const weight = 0.5 ** (ageDays / halfLifeDays);
		if (outcome.value.outcome === 'useful') {
			score += weight;
			positiveIds.add(outcome.id);
		} else {
			score -= weight;
			negativeOutcomes++;
		}
	}
	positiveOutcomes = positiveIds.size;
	return {
		memoryId: record.id,
		text: clip(record.text),
		anchor,
		group: status.packageBoundary,
		score: normalizeZero(Math.round(score * SCORE_PRECISION) / SCORE_PRECISION),
		positiveOutcomes,
		negativeOutcomes,
		latestAt: latest.value.at,
		resolution: latest.value.outcome,
	};
}

function stableItems(items: ReflectionDigestItem[]): ReflectionDigestItem[] {
	return items
		.sort(
			(a, b) =>
				b.score - a.score ||
				compareText(a.group ?? '', b.group ?? '') ||
				compareText(a.memoryId, b.memoryId) ||
				compareText(a.anchor?.file ?? '', b.anchor?.file ?? '') ||
				compareText(a.anchor?.symbol ?? '', b.anchor?.symbol ?? ''),
		)
		.slice(0, MAX_CATEGORY_ITEMS);
}

function renderItems(
	lines: string[],
	title: string,
	items: readonly ReflectionDigestItem[],
): void {
	lines.push('', `## ${title}`);
	if (items.length === 0) {
		lines.push('', '- None.');
		return;
	}
	const groups = new Map<string, ReflectionDigestItem[]>();
	for (const item of items) {
		const group = item.group ?? '';
		const members = groups.get(group) ?? [];
		members.push(item);
		groups.set(group, members);
	}
	for (const group of [...groups.keys()].sort(compareText)) {
		if (group) lines.push('', `### ${group}`, '');
		for (const item of groups.get(group) ?? []) {
			const location = item.anchor?.file ? ` (${item.anchor.file})` : '';
			lines.push(
				`- [${item.memoryId}]${location} score=${item.score.toFixed(6)} — ${item.text}`,
			);
		}
	}
}

function clip(value: string): string {
	return value.length <= MAX_DISPLAY_CHARS
		? value
		: `${value.slice(0, MAX_DISPLAY_CHARS - 1)}…`;
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeZero(value: number): number {
	return Object.is(value, -0) ? 0 : value;
}
