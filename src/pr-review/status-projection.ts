/**
 * Issue #3095: pure projection builders for the `pr_workflow_status`
 * `gate.reviewProjection` section (candidate inventory, per-boundary
 * settlement, per-lane coverage).
 *
 * This module is PURE: no `fs`, no async, no I/O, no side effects. The tool
 * executor (src/tools/pr-workflow-status.ts) performs every read (delegations,
 * lane artifacts, trigger receipts) and hands plain data to these builders.
 * The only gate dependency is a TYPE import under `import type`, which is
 * erased at build time — the gate never imports this module, so no cycle can
 * exist and the caps below are the single truncation authority.
 *
 * Container key order is part of the contract (plan N2/R3-2):
 * `candidateInventory` FIRST, then `boundaries`, then `lanes` — key-name
 * tolerant consumers that locate the inventory container by smallest-subtree
 * search must find the id-bearing arm before the lanes subtree.
 */
import type { PrReviewCandidateInventoryForStatus } from '../hooks/pr-workflow-gate.js';

/** Cap on projected inventory ids (matches the gate's dirty-file bound). */
export const MAX_STATUS_INVENTORY_IDS = 50;
/** Cap on projected lane coverage rows. */
export const MAX_STATUS_LANES = 50;
/** Cap on projected finding summaries per lane row. */
export const MAX_STATUS_FINDINGS_PER_LANE = 5;
/**
 * Parse bound for artifact-sourced finding summaries. Lane artifacts can be
 * up to 10 MiB (`MAX_LANE_OUTPUT_STORED_BYTES`); row parsing stops at this
 * many characters and flags the truncation instead of scanning the full file.
 */
export const MAX_STATUS_ARTIFACT_PARSE_CHARS = 200_000;
/** Bound for any single projected author-influenced string field. */
export const MAX_STATUS_FIELD_CHARS = 240;
/** Bound for structured finding ids/severities. */
export const MAX_STATUS_ID_CHARS = 128;

const PR_REVIEW_STATUS_BOUNDARY_ORDER = [
	'post_explorer',
	'post_reviewer',
	'post_critic',
] as const;

export type PrReviewStatusBoundaryName =
	(typeof PR_REVIEW_STATUS_BOUNDARY_ORDER)[number];

/**
 * Evidence-status signal (plan N1/R3-1). Pinned to RECORDED evidence, of
 * which a receipt envelope is only one of two sources (the other is the lane
 * artifact's `[CANDIDATE]`/`[CLEAN]` rows). `'no-evidence'` asserts
 * positively-observed absence; an unreadable/uncertain source reports
 * `'unknown-evidence'` instead of claiming absence.
 */
export type PrReviewStatusEvidenceMarker =
	| 'finding'
	| 'clean'
	| 'no-evidence'
	| 'unknown-evidence';

export interface PrReviewStatusFindingSummary {
	id: string;
	severity: string | null;
	title: string | null;
}

/** Bounding for author-influenced projected fields (ids, severities, titles). */
export function boundStatusField(value: string, maxLen: number): string {
	const cleaned = value
		.replace(/[\p{Cc}]/gu, ' ')
		.replace(/[`<>]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen)}…` : cleaned;
}

/**
 * The projected candidate-inventory arm. `inventory` exists ONLY on the
 * available arm, so a consumer cannot misread an empty array as "clean
 * review" without destructuring the union first; the available arm is never
 * empty because the derivation yields the 'CLEAN-REVIEW' sentinel.
 */
export type PrReviewStatusInventorySection =
	| {
			state: 'available';
			inventory: string[];
			total: number;
			truncated: boolean;
			truncationNote: string | null;
	  }
	| { state: 'unavailable'; reason: string };

export function projectCandidateInventoryForStatus(
	read: PrReviewCandidateInventoryForStatus,
): PrReviewStatusInventorySection {
	if (read.state !== 'available') {
		return { state: 'unavailable', reason: read.reason };
	}
	const total = read.inventory.length;
	const truncated = total > MAX_STATUS_INVENTORY_IDS;
	const shown = truncated
		? read.inventory.slice(0, MAX_STATUS_INVENTORY_IDS)
		: read.inventory;
	return {
		state: 'available',
		inventory: shown,
		total,
		truncated,
		truncationNote: truncated ? `+${total - shown.length} more` : null,
	};
}

export interface PrReviewStatusBoundariesSection {
	boundaries: Array<{
		boundary: PrReviewStatusBoundaryName;
		/** Literal words, not a boolean flag — a settled row must never contain a pending marker. */
		status: 'settled' | 'pending';
	}>;
	/**
	 * Shared persisted run reference current at read time, or null when no
	 * boundary is settled. `prReviewArtifactBoundaries` is a flat string[] with
	 * no per-boundary path/digest, so this is the honest maximum (issue #3095
	 * AC1 refinement; per-boundary attribution is deferred to #3098).
	 */
	checkpoint: { runId: string | null; findingsPath: string | null } | null;
	checkpointScope: 'shared-last-write-wins';
}

export function projectBoundariesForStatus(input: {
	settledBoundaries: readonly string[] | null | undefined;
	artifactRunId?: string | null;
	findingsPath?: string | null;
}): PrReviewStatusBoundariesSection {
	const settled = new Set(input.settledBoundaries ?? []);
	const anySettled = settled.size > 0;
	return {
		boundaries: PR_REVIEW_STATUS_BOUNDARY_ORDER.map((boundary) => ({
			boundary,
			status: settled.has(boundary) ? 'settled' : 'pending',
		})),
		checkpoint: anySettled
			? {
					runId: input.artifactRunId
						? boundStatusField(input.artifactRunId, MAX_STATUS_FIELD_CHARS)
						: null,
					findingsPath: input.findingsPath
						? boundStatusField(input.findingsPath, MAX_STATUS_FIELD_CHARS)
						: null,
				}
			: null,
		checkpointScope: 'shared-last-write-wins',
	};
}

/** One lane coverage row input; the executor has already performed every read. */
export interface PrReviewStatusLaneInput {
	batchId: string;
	phase: string;
	laneId: string;
	workflowLane: string;
	/**
	 * Count of `reviewItemIds` where the source record has that field
	 * (validation batches only); null — not 0 — for base and micro rows, whose
	 * record types do not carry item identity.
	 */
	itemCount: number | null;
	readState: 'ok' | 'uncertain' | 'unavailable';
	hasFinding: boolean;
	hasClean: boolean;
	findings: PrReviewStatusFindingSummary[];
	findingsTruncated: boolean;
	artifactTruncated: boolean;
}

export interface PrReviewStatusLaneRow {
	batchId: string;
	phase: string;
	laneId: string;
	workflowLane: string;
	itemCount: number | null;
	marker: PrReviewStatusEvidenceMarker;
	findings: PrReviewStatusFindingSummary[];
	findingsTruncated: boolean;
	artifactTruncated: boolean;
}

export type PrReviewStatusSourceState = 'ok' | 'uncertain' | 'unavailable';

export interface PrReviewStatusLaneSource {
	/** Source-level read outcome; 'unavailable' yields no rows for that source. */
	state: PrReviewStatusSourceState;
	/** Bounded reason; present only when state is not 'ok'. */
	reason?: string;
	rows: PrReviewStatusLaneInput[];
}

export interface PrReviewStatusLanesSection {
	lanes: PrReviewStatusLaneRow[];
	lanesTruncated: boolean;
	laneCount: number;
	/** Typed per-source disclosure: a degraded source never erases the others. */
	sourceState: {
		base: PrReviewStatusSourceState;
		validation: PrReviewStatusSourceState;
		micro: PrReviewStatusSourceState;
	};
	sourceNotes: {
		base?: string;
		validation?: string;
		micro?: string;
	};
}

function projectMarker(
	row: PrReviewStatusLaneInput,
): PrReviewStatusEvidenceMarker {
	if (row.readState !== 'ok') return 'unknown-evidence';
	if (row.hasFinding) return 'finding';
	if (row.hasClean) return 'clean';
	return 'no-evidence';
}

function sourceStateOf(
	source: PrReviewStatusLaneSource,
): PrReviewStatusSourceState {
	if (source.state !== 'ok') return source.state;
	return source.rows.some((row) => row.readState !== 'ok') ? 'uncertain' : 'ok';
}

export function projectLanesForStatus(input: {
	base: PrReviewStatusLaneSource;
	validation: PrReviewStatusLaneSource;
	micro: PrReviewStatusLaneSource;
}): PrReviewStatusLanesSection {
	const all = [
		...input.base.rows,
		...input.validation.rows,
		...input.micro.rows,
	];
	const rows = all.slice(0, MAX_STATUS_LANES).map((row) => ({
		batchId: boundStatusField(row.batchId, MAX_STATUS_ID_CHARS),
		phase: boundStatusField(row.phase, 64),
		laneId: boundStatusField(row.laneId, MAX_STATUS_ID_CHARS),
		workflowLane: boundStatusField(row.workflowLane, MAX_STATUS_ID_CHARS),
		itemCount: row.itemCount,
		marker: projectMarker(row),
		findings: row.findings,
		findingsTruncated: row.findingsTruncated,
		artifactTruncated: row.artifactTruncated,
	}));
	return {
		lanes: rows,
		lanesTruncated: all.length > rows.length,
		laneCount: all.length,
		sourceState: {
			base: sourceStateOf(input.base),
			validation: sourceStateOf(input.validation),
			micro: sourceStateOf(input.micro),
		},
		sourceNotes: {
			...(input.base.state !== 'ok' || input.base.reason
				? {
						base:
							input.base.reason ?? `base lane source is ${input.base.state}`,
					}
				: {}),
			...(input.validation.state !== 'ok' || input.validation.reason
				? {
						validation:
							input.validation.reason ??
							`validation lane source is ${input.validation.state}`,
					}
				: {}),
			...(input.micro.state !== 'ok' || input.micro.reason
				? {
						micro:
							input.micro.reason ?? `micro lane source is ${input.micro.state}`,
					}
				: {}),
		},
	};
}

export interface PrReviewStatusReviewProjection {
	/** FIRST key by contract — see the module doc. */
	candidateInventory: PrReviewStatusInventorySection;
	boundaries: PrReviewStatusBoundariesSection;
	/** LAST key by contract — see the module doc. */
	lanes: PrReviewStatusLanesSection;
}

/**
 * Bounded row-parse of a lane artifact's `[CANDIDATE]`/`[CLEAN]` rows.
 * Parses ROWS, never a substring test: artifacts open with a literal
 * `[CANDIDATE] | candidate_id | …` HEADER line, and a bare
 * `includes('[CANDIDATE]')` would misread a findings-free artifact as a
 * findings-bearing one. Markerless rows (the common emitted shape: the
 * `[CANDIDATE]` prefix appears only in the header) are recognized only after
 * a header has been seen, mirroring the gate's own parser family logic.
 */
export interface PrReviewStatusArtifactParse {
	candidateRows: PrReviewStatusFindingSummary[];
	cleanRowCount: number;
	/** True when the artifact exceeded the declared parse bound. */
	truncatedAtBound: boolean;
}

function candidateRowFromFields(
	fields: readonly string[],
): PrReviewStatusFindingSummary | null {
	const id = fields[0];
	const workflowLane = fields[1];
	if (!id || !workflowLane) return null;
	const severity = fields[2] || null;
	// [candidateId, lane, severity, category, file:line, claim, evidence, …]
	const title = fields[5] || fields[4] || null;
	return {
		id: boundStatusField(id, MAX_STATUS_ID_CHARS),
		severity: severity ? boundStatusField(severity, 32) : null,
		title: title ? boundStatusField(title, MAX_STATUS_FIELD_CHARS) : null,
	};
}

export function parseStatusArtifactRows(
	text: string,
): PrReviewStatusArtifactParse {
	const truncatedAtBound = text.length > MAX_STATUS_ARTIFACT_PARSE_CHARS;
	const scan = truncatedAtBound
		? text.slice(0, MAX_STATUS_ARTIFACT_PARSE_CHARS)
		: text;
	const candidateRows: PrReviewStatusFindingSummary[] = [];
	let cleanRowCount = 0;
	let headerSeen = false;
	for (const line of scan.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const fields = line.split('|').map((field) => field.trim());
		const first = fields[0] ?? '';
		if (first === '[CANDIDATE]' && fields[1] === 'candidate_id') {
			headerSeen = true;
			continue;
		}
		if (first === '[CLEAN]') {
			if (fields.length >= 2 && fields[1]) cleanRowCount += 1;
			continue;
		}
		if (first === '[CANDIDATE]') {
			const row = candidateRowFromFields(fields.slice(1));
			if (row) candidateRows.push(row);
			continue;
		}
		if (headerSeen && first && !first.startsWith('[')) {
			const row = candidateRowFromFields(fields);
			if (row) candidateRows.push(row);
		}
	}
	return { candidateRows, cleanRowCount, truncatedAtBound };
}
