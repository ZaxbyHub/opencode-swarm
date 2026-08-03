import { createHash } from 'node:crypto';
import { z } from 'zod';

export const PR_REVIEW_TRIGGER_DEFINITIONS = [
	{
		id: 'auth-identity-secrets',
		scope: 'universal',
		trigger_row:
			'authentication, authorization, identity, sessions, permissions, secrets, cryptography',
		micro_lane: 'Identity and secret boundaries',
	},
	{
		id: 'untrusted-input-boundaries',
		scope: 'universal',
		trigger_row:
			'parsing, serialization, queries, templates/rendering, file or network input/output',
		micro_lane: 'Untrusted input and sink analysis',
	},
	{
		id: 'subprocess-platform',
		scope: 'universal',
		trigger_row:
			'subprocesses, shell commands, filesystem operations, OS/runtime-specific code',
		micro_lane: 'Subprocess and platform safety',
	},
	{
		id: 'concurrency-state',
		scope: 'universal',
		trigger_row:
			'queues, caches, retries, transactions, locks, state machines, async coordination',
		micro_lane: 'Concurrency and state transitions',
	},
	{
		id: 'dependencies-build-release',
		scope: 'universal',
		trigger_row:
			'dependency manifests, lockfiles, installers, build scripts, CI, packaging, deployment',
		micro_lane: 'Dependency and delivery integrity',
	},
	{
		id: 'api-schema-migrations',
		scope: 'universal',
		trigger_row:
			'public API, wire/schema/config/storage formats, migrations, feature flags',
		micro_lane: 'Compatibility and migration safety',
	},
	{
		id: 'test-infrastructure',
		scope: 'universal',
		trigger_row: 'tests, mocks, fixtures, harnesses, coverage, CI matrices',
		micro_lane: 'Test validity and isolation',
	},
	{
		id: 'ui-accessibility-i18n',
		scope: 'universal',
		trigger_row:
			'user interfaces, interaction flows, rendering, accessibility, localization',
		micro_lane: 'UI and human-interface quality',
	},
	{
		id: 'privacy-observability',
		scope: 'universal',
		trigger_row: 'telemetry, logs, analytics, traces, retention, diagnostics',
		micro_lane: 'Privacy and observability safety',
	},
	{
		id: 'generated-provenance',
		scope: 'universal',
		trigger_row:
			'generated, vendored, binary, model-produced, codegen or checked-in build artifacts',
		micro_lane: 'Generated artifact provenance',
	},
	{
		id: 'unclassified-risk',
		scope: 'universal',
		trigger_row:
			'any changed artifact or behavior not confidently classified by the rows above',
		micro_lane: 'Unclassified high-risk fallback',
	},
] as const;

export const PR_REVIEW_REQUIRED_TRIGGER_IDS = PR_REVIEW_TRIGGER_DEFINITIONS.map(
	(definition) => definition.id,
);

export type PrReviewTriggerId = (typeof PR_REVIEW_REQUIRED_TRIGGER_IDS)[number];

const TriggerIdSchema = z.enum(
	PR_REVIEW_REQUIRED_TRIGGER_IDS as [PrReviewTriggerId, ...PrReviewTriggerId[]],
	{ error: 'unknown PR_REVIEW trigger_id' },
);

const TriggerEvidenceSchema = z.string().trim().min(1).max(4000);

export const PrReviewInlineTriggerRowSchema = z.discriminatedUnion('result', [
	z
		.object({
			trigger_id: TriggerIdSchema,
			result: z.literal('MATCHED'),
			evidence: TriggerEvidenceSchema,
		})
		.strict(),
	z
		.object({
			trigger_id: TriggerIdSchema,
			result: z.literal('NOT_TRIGGERED'),
			evidence: TriggerEvidenceSchema,
		})
		.strict(),
]);

export const PrReviewPersistedInputRowSchema = z.discriminatedUnion('result', [
	z
		.object({
			trigger_id: TriggerIdSchema,
			result: z.literal('MATCHED'),
			evidence: TriggerEvidenceSchema,
			source_batch_id: z.string().trim().min(1),
			source_lane_id: z.string().trim().min(1),
		})
		.strict(),
	z
		.object({
			trigger_id: TriggerIdSchema,
			result: z.literal('NOT_TRIGGERED'),
			evidence: TriggerEvidenceSchema,
		})
		.strict(),
]);

export type PrReviewInlineTriggerRow = z.infer<
	typeof PrReviewInlineTriggerRowSchema
>;
export type PrReviewPersistedInputRow = z.infer<
	typeof PrReviewPersistedInputRowSchema
>;

interface ValidatedTriggerLedger<TRow> {
	rows: TRow[];
	matchedIds: PrReviewTriggerId[];
	notTriggeredIds: PrReviewTriggerId[];
}

function rawTriggerIds(input: unknown): string[] | null {
	if (!Array.isArray(input)) return null;
	const ids: string[] = [];
	for (const row of input) {
		if (typeof row !== 'object' || row === null) return null;
		const triggerId = (row as { trigger_id?: unknown }).trigger_id;
		if (typeof triggerId !== 'string' || !triggerId.trim()) return null;
		ids.push(triggerId.trim());
	}
	return ids;
}

function assertExactTriggerIdSet(input: unknown): void {
	const ids = rawTriggerIds(input);
	if (!ids) return;
	const expected = new Set<string>(PR_REVIEW_REQUIRED_TRIGGER_IDS);
	const seen = new Set<string>();
	const duplicate = new Set<string>();
	for (const id of ids) {
		if (seen.has(id)) duplicate.add(id);
		seen.add(id);
	}
	if (duplicate.size > 0) {
		throw new Error(`duplicate trigger IDs: ${[...duplicate].join(', ')}`);
	}
	const unknown = [...seen].filter((id) => !expected.has(id));
	if (unknown.length > 0) {
		throw new Error(
			`unknown trigger IDs: ${unknown.join(', ')}. ` +
				`trigger_id must be one of the 11 mandatory micro-lane IDs: ${[...expected].join(', ')}. ` +
				'Base-lane IDs and mode strings (e.g. swarm-pr-review:base) are NOT trigger IDs.',
		);
	}
	const missing = [...expected].filter((id) => !seen.has(id));
	if (missing.length > 0) {
		throw new Error(`missing trigger IDs: ${missing.join(', ')}`);
	}
}

function assertMatchedRowsHaveProvenance(input: unknown): void {
	if (!Array.isArray(input)) return;
	for (const row of input) {
		if (typeof row !== 'object' || row === null) continue;
		const value = row as Record<string, unknown>;
		if (value.result !== 'MATCHED') continue;
		if (
			typeof value.source_batch_id !== 'string' ||
			!value.source_batch_id.trim() ||
			typeof value.source_lane_id !== 'string' ||
			!value.source_lane_id.trim()
		) {
			throw new Error(
				`MATCHED rows require source_batch_id and source_lane_id: ${String(value.trigger_id ?? '(missing trigger_id)')}`,
			);
		}
	}
}

function assertNoLegacyNoMatchResult(input: unknown): void {
	if (!Array.isArray(input)) return;
	for (const row of input) {
		if (typeof row !== 'object' || row === null) continue;
		if ((row as { result?: unknown }).result === 'NO-MATCH') {
			throw new Error(
				'NO-MATCH is not a valid PR_REVIEW trigger result; use MATCHED or NOT_TRIGGERED with concrete evidence',
			);
		}
	}
}

function exactTriggerRows<TRow extends { trigger_id: PrReviewTriggerId }>(
	rows: readonly TRow[],
): TRow[] {
	const expected = new Set<string>(PR_REVIEW_REQUIRED_TRIGGER_IDS);
	const seen = new Set<string>();
	const duplicate = new Set<string>();
	for (const row of rows) {
		if (seen.has(row.trigger_id)) duplicate.add(row.trigger_id);
		seen.add(row.trigger_id);
	}
	const unknown = [...seen].filter((id) => !expected.has(id));
	const missing = [...expected].filter((id) => !seen.has(id));
	if (duplicate.size > 0 || unknown.length > 0 || missing.length > 0) {
		throw new Error(
			`PR_REVIEW trigger ledger must be exact; missing: ${missing.join(', ') || '(none)'}; duplicate: ${[...duplicate].join(', ') || '(none)'}; unknown: ${unknown.join(', ') || '(none)'}`,
		);
	}
	const byId = new Map(rows.map((row) => [row.trigger_id, row]));
	return PR_REVIEW_REQUIRED_TRIGGER_IDS.map((id) => {
		const row = byId.get(id);
		if (!row) throw new Error(`missing trigger row: ${id}`);
		return row;
	});
}

function summarizeTriggerRows<
	TRow extends { trigger_id: PrReviewTriggerId; result: string },
>(rows: readonly TRow[]): ValidatedTriggerLedger<TRow> {
	const orderedRows = exactTriggerRows(rows);
	if (
		orderedRows.find((row) => row.trigger_id === 'unclassified-risk')
			?.result !== 'MATCHED'
	) {
		throw new Error(
			'PR_REVIEW trigger ledger requires unclassified-risk to remain MATCHED as the fallback family',
		);
	}
	return {
		rows: orderedRows,
		matchedIds: orderedRows
			.filter((row) => row.result === 'MATCHED')
			.map((row) => row.trigger_id),
		notTriggeredIds: orderedRows
			.filter((row) => row.result === 'NOT_TRIGGERED')
			.map((row) => row.trigger_id),
	};
}

function parseRows<TRow>(
	input: unknown,
	schema: z.ZodType<TRow>,
	label: string,
): TRow[] {
	const parsed = z.array(schema).safeParse(input);
	if (!parsed.success) {
		throw new Error(
			`${label}: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')}`,
		);
	}
	return parsed.data;
}

export function validatePrReviewInlineTriggerLedger(
	input: unknown,
): ValidatedTriggerLedger<PrReviewInlineTriggerRow> {
	assertExactTriggerIdSet(input);
	assertNoLegacyNoMatchResult(input);
	return summarizeTriggerRows(
		parseRows(input, PrReviewInlineTriggerRowSchema, 'Invalid trigger ledger'),
	);
}

export function validatePrReviewPersistedInputLedger(
	input: unknown,
): ValidatedTriggerLedger<PrReviewPersistedInputRow> {
	assertExactTriggerIdSet(input);
	assertNoLegacyNoMatchResult(input);
	assertMatchedRowsHaveProvenance(input);
	return summarizeTriggerRows(
		parseRows(
			input,
			PrReviewPersistedInputRowSchema,
			'Invalid persisted trigger ledger',
		),
	);
}

const TriggerDefinitionFieldShape = {
	scope: z.literal('universal'),
	trigger_row: z.string().trim().min(1),
	micro_lane: z.string().trim().min(1),
} as const;

const V2MatchedRowSchema = z
	.object({
		trigger_id: TriggerIdSchema,
		...TriggerDefinitionFieldShape,
		result: z.literal('MATCHED'),
		evidence: TriggerEvidenceSchema,
		source_batch_id: z.string().trim().min(1),
		source_lane_id: z.string().trim().min(1),
	})
	.strict();
const V2NotTriggeredRowSchema = z
	.object({
		trigger_id: TriggerIdSchema,
		...TriggerDefinitionFieldShape,
		result: z.literal('NOT_TRIGGERED'),
		evidence: TriggerEvidenceSchema,
	})
	.strict();

const V2RowSchema = z.union([V2MatchedRowSchema, V2NotTriggeredRowSchema]);

const ReceiptEnvelopeSchema = z.object({
	run_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
	pr_head_sha: z
		.string()
		.trim()
		.regex(/^[0-9a-f]{6,64}$/i),
	base_ref: z
		.string()
		.trim()
		.regex(/^(?!-)[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/),
	base_sha: z
		.string()
		.trim()
		.regex(/^[0-9a-f]{6,64}$/i),
	evaluated_at: z.string().datetime(),
	dispatched_micro_lane_count: z.number().int().min(1),
});

const V2ReceiptSchema = ReceiptEnvelopeSchema.extend({
	schema_version: z.literal(2),
	trigger_count: z.number().int().min(0),
	matched_count: z.number().int().min(0),
	not_triggered_count: z.number().int().min(0),
	no_match_count: z.number().int().min(0),
	rows: z.array(V2RowSchema),
}).strict();

function assertCanonicalDefinitionFields(
	rows: ReadonlyArray<{
		trigger_id: PrReviewTriggerId;
		scope: 'universal';
		trigger_row: string;
		micro_lane: string;
	}>,
): void {
	const definitions = new Map(
		PR_REVIEW_TRIGGER_DEFINITIONS.map((definition) => [
			definition.id,
			definition,
		]),
	);
	for (const row of rows) {
		const definition = definitions.get(row.trigger_id);
		if (
			!definition ||
			row.scope !== definition.scope ||
			row.trigger_row !== definition.trigger_row ||
			row.micro_lane !== definition.micro_lane
		) {
			throw new Error(
				`PR_REVIEW trigger definition drift for ${row.trigger_id}: scope, trigger_row, and micro_lane must match the canonical definition`,
			);
		}
	}
}

export interface BuildPrReviewTriggerReceiptV2Args {
	run_id: string;
	pr_head_sha: string;
	base_ref: string;
	base_sha: string;
	evaluated_at: string;
	dispatched_micro_lane_count: number;
	rows: unknown;
}

function dispatchedMicroLaneCount(
	rows: readonly PrReviewPersistedInputRow[],
): number {
	return new Set(
		rows
			.filter((row) => row.result === 'MATCHED')
			.map((row) => `${row.source_batch_id}\0${row.source_lane_id}`),
	).size;
}

export function buildPrReviewTriggerReceiptV2(
	input: BuildPrReviewTriggerReceiptV2Args,
) {
	const envelope = ReceiptEnvelopeSchema.parse(input);
	const validated = validatePrReviewPersistedInputLedger(input.rows);
	const dispatchedCount = dispatchedMicroLaneCount(validated.rows);
	if (envelope.dispatched_micro_lane_count !== dispatchedCount) {
		throw new Error(
			`PR_REVIEW trigger receipt dispatched_micro_lane_count is inconsistent: expected ${dispatchedCount}`,
		);
	}
	const rows = validated.rows.map((row) => {
		const definition = PR_REVIEW_TRIGGER_DEFINITIONS.find(
			(candidate) => candidate.id === row.trigger_id,
		);
		if (!definition)
			throw new Error(`unknown trigger definition: ${row.trigger_id}`);
		return {
			trigger_id: row.trigger_id,
			scope: definition.scope,
			trigger_row: definition.trigger_row,
			micro_lane: definition.micro_lane,
			result: row.result,
			evidence: row.evidence,
			...(row.result === 'MATCHED'
				? {
						source_batch_id: row.source_batch_id,
						source_lane_id: row.source_lane_id,
					}
				: {}),
		};
	});
	return V2ReceiptSchema.parse({
		...envelope,
		schema_version: 2,
		trigger_count: rows.length,
		matched_count: validated.matchedIds.length,
		not_triggered_count: validated.notTriggeredIds.length,
		no_match_count: 0,
		rows,
	});
}

const LegacyRowFieldShape = {
	trigger_id: TriggerIdSchema,
	result: z.literal('MATCHED'),
	evidence: TriggerEvidenceSchema,
	source_batch_id: z.string().trim().min(1),
	source_lane_id: z.string().trim().min(1),
} as const;

const LegacyBasicRowSchema = z.object(LegacyRowFieldShape).strict();
const LegacyFullRowSchema = z
	.object({
		trigger_id: TriggerIdSchema,
		...TriggerDefinitionFieldShape,
		result: z.literal('MATCHED'),
		evidence: TriggerEvidenceSchema,
		source_batch_id: z.string().trim().min(1),
		source_lane_id: z.string().trim().min(1),
	})
	.strict();
const LegacyRowSchema = z.union([LegacyBasicRowSchema, LegacyFullRowSchema]);

const V1ReceiptSchema = ReceiptEnvelopeSchema.extend({
	schema_version: z.literal(1),
	trigger_count: z.number().int().min(0),
	matched_count: z.number().int().min(0),
	no_match_count: z.number().int().min(0),
	rows: z.array(LegacyRowSchema),
}).strict();

const UnversionedRowOnlyReceiptSchema = z
	.object({ rows: z.array(z.unknown()) })
	.strict();

export interface ParsedPrReviewTriggerReceipt {
	schemaVersion: 0 | 1 | 2;
	rows: PrReviewPersistedInputRow[];
	matchedRows: Extract<PrReviewPersistedInputRow, { result: 'MATCHED' }>[];
	notTriggeredRows: Extract<
		PrReviewPersistedInputRow,
		{ result: 'NOT_TRIGGERED' }
	>[];
}

/**
 * Bind every micro dispatch and the final receipt to one semantic ledger.
 * Callers pass rows after exact-set validation; the tuple representation makes
 * the identity stable and independent of post-dispatch provenance fields.
 */
export function prReviewTriggerLedgerDigest(
	rows: ReadonlyArray<{
		trigger_id: PrReviewTriggerId;
		result: 'MATCHED' | 'NOT_TRIGGERED';
		evidence: string;
	}>,
): string {
	const canonical = rows.map((row) => [
		row.trigger_id,
		row.result,
		row.evidence,
	]);
	return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function parsedReceipt(
	schemaVersion: 0 | 1 | 2,
	rows: PrReviewPersistedInputRow[],
): ParsedPrReviewTriggerReceipt {
	return {
		schemaVersion,
		rows,
		matchedRows: rows.filter(
			(row): row is Extract<PrReviewPersistedInputRow, { result: 'MATCHED' }> =>
				row.result === 'MATCHED',
		),
		notTriggeredRows: rows.filter(
			(
				row,
			): row is Extract<
				PrReviewPersistedInputRow,
				{ result: 'NOT_TRIGGERED' }
			> => row.result === 'NOT_TRIGGERED',
		),
	};
}

export function parsePrReviewTriggerReceipt(
	input: unknown,
): ParsedPrReviewTriggerReceipt {
	if (typeof input !== 'object' || input === null) {
		throw new Error('PR_REVIEW trigger receipt must be an object');
	}
	const schemaVersion = (input as { schema_version?: unknown }).schema_version;
	if (schemaVersion === 2) {
		const receipt = V2ReceiptSchema.parse(input);
		assertCanonicalDefinitionFields(receipt.rows);
		const normalizedRows = receipt.rows.map((row) => ({
			trigger_id: row.trigger_id,
			result: row.result,
			evidence: row.evidence,
			...(row.result === 'MATCHED'
				? {
						source_batch_id: row.source_batch_id,
						source_lane_id: row.source_lane_id,
					}
				: {}),
		})) as PrReviewPersistedInputRow[];
		const validated = validatePrReviewPersistedInputLedger(normalizedRows);
		const counts = {
			trigger_count: validated.rows.length,
			matched_count: validated.matchedIds.length,
			not_triggered_count: validated.notTriggeredIds.length,
			no_match_count: 0,
			dispatched_micro_lane_count: dispatchedMicroLaneCount(validated.rows),
		};
		for (const [field, expected] of Object.entries(counts)) {
			if (receipt[field as keyof typeof counts] !== expected) {
				throw new Error(
					`PR_REVIEW trigger receipt ${field} is inconsistent: expected ${expected}`,
				);
			}
		}
		return parsedReceipt(2, validated.rows);
	}

	if (schemaVersion !== undefined && schemaVersion !== 1) {
		throw new Error(
			`Unsupported PR_REVIEW trigger schema_version: ${schemaVersion}`,
		);
	}
	const legacyEnvelope =
		schemaVersion === 1
			? V1ReceiptSchema.parse(input)
			: UnversionedRowOnlyReceiptSchema.parse(input);
	const rowsInput = legacyEnvelope.rows;
	const parsedLegacyRows = parseRows(
		rowsInput,
		LegacyRowSchema,
		'Invalid legacy trigger ledger; all rows must be MATCHED with complete source provenance',
	);
	assertCanonicalDefinitionFields(
		parsedLegacyRows.filter(
			(row): row is z.infer<typeof LegacyFullRowSchema> => 'scope' in row,
		),
	);
	const legacyRows = parsedLegacyRows.map((row) => ({
		trigger_id: row.trigger_id,
		result: row.result,
		evidence: row.evidence,
		source_batch_id: row.source_batch_id,
		source_lane_id: row.source_lane_id,
	}));
	const validated = summarizeTriggerRows(legacyRows);
	if (schemaVersion === 1) {
		const receipt = legacyEnvelope as z.infer<typeof V1ReceiptSchema>;
		const countFields = {
			trigger_count: validated.rows.length,
			matched_count: validated.rows.length,
			no_match_count: 0,
			dispatched_micro_lane_count: dispatchedMicroLaneCount(validated.rows),
		};
		for (const [field, expected] of Object.entries(countFields)) {
			if (receipt[field as keyof typeof countFields] !== expected) {
				throw new Error(
					`Historical PR_REVIEW trigger receipt ${field} is inconsistent: expected ${expected}`,
				);
			}
		}
	}
	return parsedReceipt(schemaVersion === 1 ? 1 : 0, validated.rows);
}
