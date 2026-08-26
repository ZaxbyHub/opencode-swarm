import { type ZodIssue, z } from 'zod';

export const PR_REVIEW_REVIEWER_CLASSIFICATIONS = [
	'CONFIRMED',
	'DISPROVED',
	'UNVERIFIED',
	'PRE_EXISTING',
] as const;
export const PR_REVIEW_REVIEWER_EVIDENCE_TYPES = [
	'STRUCTURALLY_PROVEN',
	'EXECUTION_PROVEN',
	'STATIC_TRACE_PROVEN',
	'PLAUSIBLE_BUT_UNVERIFIED',
] as const;
export const PR_REVIEW_SEVERITIES = [
	'CRITICAL',
	'HIGH',
	'MEDIUM',
	'LOW',
	'INFO',
	'NONE',
] as const;
export const PR_REVIEW_CRITIC_STATUSES = [
	'UPHELD',
	'DOWNGRADED',
	'DISPROVED',
	'NEEDS_MORE_EVIDENCE',
] as const;
export const PR_REVIEW_FINDING_STATUSES = [
	'PENDING',
	'CONFIRMED',
	'DISPROVED',
	'PRE_EXISTING',
] as const;
export const PR_REVIEW_FINDING_ACTIONS = [
	'route_to_reviewer',
	'route_to_critic',
	'report',
	'suppress_with_reason',
	'handoff_to_feedback',
] as const;
export const PR_REVIEW_ARTIFACT_BOUNDARIES = [
	'post_explorer',
	'post_reviewer',
	'post_critic',
] as const;

export const PR_REVIEW_CONTRACT_CARD_HEADER = '[PR-REVIEW CONTRACT CARD]';
export const PR_REVIEW_FINDINGS_MAX_BYTES = 10 * 1024 * 1024;
export const PR_REVIEW_FINDINGS_WRITE_MAX_BYTES = 3 * 1024 * 1024;
export const PR_REVIEW_HANDOFF_MAX_BYTES = 128 * 1024;
export const PR_REVIEW_HANDOFF_WRITE_MAX_BYTES = 120 * 1024;
export const PR_REVIEW_DISCARDED_EXAMPLE_ITEM_ID = 'discarded-id';

export function serializedPrReviewArtifactInputBytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export const PrReviewRunIdSchema = z
	.string()
	.regex(
		/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
		'run_id must be a safe relative identifier',
	);

export const PrReviewFindingSchema = z
	.object({
		finding_id: z.string().trim().min(1).max(128),
		status: z.enum(PR_REVIEW_FINDING_STATUSES),
		file_line: z.string().trim().min(1).max(1000),
		evidence: z.string().trim().min(1).max(20_000),
		next_action: z.enum(PR_REVIEW_FINDING_ACTIONS),
		severity: z.enum(PR_REVIEW_SEVERITIES).optional(),
		category: z.string().trim().min(1).max(128).optional(),
	})
	.strict();

export const PrReviewHandoffSchema = z
	.object({
		pr_url: z.string().url().max(2000),
		finding_ids: z.array(z.string().trim().min(1).max(128)).min(1).max(1000),
		summary: z.string().trim().min(1).max(20_000),
		provenance: z.array(z.string().trim().min(1).max(4000)).min(1).max(1000),
	})
	.strict();

export const WritePrReviewArtifactArgsSchema = z
	.discriminatedUnion('kind', [
		z
			.object({
				kind: z.literal('findings'),
				run_id: PrReviewRunIdSchema.optional(),
				pr_head_sha: z
					.string()
					.trim()
					.regex(/^[0-9a-f]{6,64}$/i),
				boundary: z.enum(PR_REVIEW_ARTIFACT_BOUNDARIES),
				records: z.array(PrReviewFindingSchema).min(1).max(1000),
			})
			.strict(),
		z
			.object({
				kind: z.literal('handoff'),
				run_id: PrReviewRunIdSchema.optional(),
				pr_head_sha: z
					.string()
					.trim()
					.regex(/^[0-9a-f]{6,64}$/i),
				handoff: PrReviewHandoffSchema,
			})
			.strict(),
	])
	.superRefine((value, ctx) => {
		const bytes = serializedPrReviewArtifactInputBytes(value);
		const maxBytes =
			value.kind === 'findings'
				? PR_REVIEW_FINDINGS_WRITE_MAX_BYTES
				: PR_REVIEW_HANDOFF_WRITE_MAX_BYTES;
		if (bytes > maxBytes) {
			ctx.addIssue({
				code: 'custom',
				path: [value.kind === 'findings' ? 'records' : 'handoff'],
				message: `serialized UTF-8 payload must be at most ${maxBytes} bytes (got ${bytes})`,
			});
		}
	});

export type PrReviewVerdictKind = 'reviewer' | 'critic';

export interface PrReviewVerdictDescriptor {
	marker: '[REVIEWED]' | '[CRITIC]';
	fieldCount: number;
	fieldRoles: readonly string[];
	schema: z.ZodType<readonly string[]>;
}

const introducedByPrSchema = z
	.string()
	.regex(/^(?:introduced_by_pr\s*:\s*)?(?:YES|NO|UNKNOWN)$/i);

export const PrReviewReviewerVerdictFieldsSchema = z
	.tuple([
		z.literal('[REVIEWED]'),
		z.string().min(1),
		z.enum(PR_REVIEW_REVIEWER_CLASSIFICATIONS),
		z.enum(PR_REVIEW_REVIEWER_EVIDENCE_TYPES),
		z.enum(PR_REVIEW_SEVERITIES),
		introducedByPrSchema,
		z.string().min(1),
		z.string().min(8),
		z.string().min(5),
		z.string().min(3),
	])
	.superRefine((fields, ctx) => {
		if (fields[2] === 'DISPROVED' && fields[4] !== 'NONE') {
			ctx.addIssue({
				code: 'custom',
				path: [4],
				message: 'DISPROVED reviewer severity must be NONE',
			});
		}
	});

export const PrReviewCriticVerdictFieldsSchema = z
	.tuple([
		z.literal('[CRITIC]'),
		z.string().min(1),
		z.enum(PR_REVIEW_CRITIC_STATUSES),
		z.enum(PR_REVIEW_SEVERITIES),
		z.string().min(6),
		z.string().min(6),
	])
	.superRefine((fields, ctx) => {
		const status = fields[2];
		const severity = fields[3];
		if (status === 'NEEDS_MORE_EVIDENCE') {
			ctx.addIssue({
				code: 'custom',
				path: [2],
				message: 'NEEDS_MORE_EVIDENCE is not a terminal transport verdict',
			});
		}
		if (status === 'DISPROVED' && severity !== 'NONE') {
			ctx.addIssue({
				code: 'custom',
				path: [3],
				message: 'DISPROVED critic severity must be NONE',
			});
		}
		if (
			status === 'UPHELD' &&
			!(['CRITICAL', 'HIGH', 'MEDIUM'] as const).includes(
				severity as 'CRITICAL' | 'HIGH' | 'MEDIUM',
			)
		) {
			ctx.addIssue({
				code: 'custom',
				path: [3],
				message: 'UPHELD critic severity must be CRITICAL, HIGH, or MEDIUM',
			});
		}
		if (status === 'DOWNGRADED' && severity === 'CRITICAL') {
			ctx.addIssue({
				code: 'custom',
				path: [3],
				message: 'DOWNGRADED critic severity cannot be CRITICAL',
			});
		}
	});

export const PR_REVIEW_VERDICT_ROW_DESCRIPTORS: Record<
	PrReviewVerdictKind,
	PrReviewVerdictDescriptor
> = {
	reviewer: {
		marker: '[REVIEWED]',
		fieldCount: 10,
		fieldRoles: [
			'marker',
			'item_id',
			'classification',
			'evidence_type',
			'severity',
			'introduced_by_pr',
			'file:line',
			'rationale',
			'probe',
			'reviewer_notes',
		],
		schema: PrReviewReviewerVerdictFieldsSchema,
	},
	critic: {
		marker: '[CRITIC]',
		fieldCount: 6,
		fieldRoles: [
			'marker',
			'item_id',
			'status',
			'severity',
			'rationale',
			'required_change',
		],
		schema: PrReviewCriticVerdictFieldsSchema,
	},
};

export type PrReviewVerdictOverflowClass =
	| 'canonical'
	| 'legacy-fidelity-safe'
	| 'legacy-lossy';

export interface ParsedPrReviewVerdictRow {
	marker: string;
	fields: string[];
	overflowClass: PrReviewVerdictOverflowClass;
	recoveredOverflow: boolean;
}

function quoted(value: string): string {
	return `"${value}"`;
}

function formatEnum(values: readonly string[]): string {
	return values.map((value) => quoted(value)).join(' | ');
}

function getPathValue(input: unknown, path: readonly PropertyKey[]): unknown {
	let current = input;
	for (const segment of path) {
		if (current === null || current === undefined) return undefined;
		if (typeof segment === 'number') {
			if (!Array.isArray(current)) return undefined;
			current = current[segment];
			continue;
		}
		if (typeof segment === 'symbol' || typeof current !== 'object')
			return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function formatActualValue(value: unknown): string {
	if (value === undefined) return '(omitted)';
	if (typeof value === 'string') return quoted(value);
	try {
		const json = JSON.stringify(value);
		if (!json) return String(value);
		return json.length <= 160 ? json : `${json.slice(0, 157)}...`;
	} catch {
		return String(value);
	}
}

function formatIssueExpected(issue: ZodIssue): string {
	if (issue.code === 'invalid_value' && 'values' in issue) {
		return formatEnum((issue as ZodIssue & { values: string[] }).values);
	}
	if (issue.code === 'invalid_type') {
		return `${issue.expected}`;
	}
	if (issue.code === 'too_small' && issue.minimum === 1) {
		return 'a non-empty value';
	}
	return issue.message;
}

export function formatPrReviewValidationIssues(
	issues: readonly ZodIssue[],
	input: unknown,
): string[] {
	const rendered: string[] = [];
	for (const issue of issues) {
		if (issue.code === 'unrecognized_keys') {
			const parent = getPathValue(input, issue.path);
			for (const key of issue.keys) {
				const parentPath = issue.path.map(String);
				const value =
					parent && typeof parent === 'object'
						? (parent as Record<string, unknown>)[key]
						: undefined;
				rendered.push(
					`field ${[...parentPath, key].join('.')}: expected no unknown key, got ${formatActualValue(value)}`,
				);
			}
			continue;
		}
		const path =
			issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
		rendered.push(
			`field ${path}: expected ${formatIssueExpected(issue)}, got ${formatActualValue(
				getPathValue(input, issue.path),
			)}`,
		);
	}
	return rendered;
}

export function buildPrReviewContractCard(): string {
	const reviewer = PR_REVIEW_VERDICT_ROW_DESCRIPTORS.reviewer;
	const critic = PR_REVIEW_VERDICT_ROW_DESCRIPTORS.critic;
	const positiveReviewer = encodePrReviewVerdictRow('reviewer', [
		reviewer.marker,
		'C-1',
		'CONFIRMED',
		'STRUCTURALLY_PROVEN',
		'HIGH',
		'YES',
		'src/index.ts:1',
		'rationale with | pipe',
		'probe with \\ backslash',
		'reviewer notes',
	]);
	const positiveCritic = encodePrReviewVerdictRow('critic', [
		critic.marker,
		'C-1',
		'UPHELD',
		'HIGH',
		'rationale with\nline break',
		'required change with\rcarriage return',
	]);
	const discardedReviewer = encodePrReviewVerdictRow('reviewer', [
		reviewer.marker,
		PR_REVIEW_DISCARDED_EXAMPLE_ITEM_ID,
		'DISPROVED',
		'STRUCTURALLY_PROVEN',
		'NONE',
		'YES',
		'src/example.ts:1',
		'illustrative only',
		'not routable',
		'not routable',
	]);
	const discardedCritic = encodePrReviewVerdictRow('critic', [
		critic.marker,
		PR_REVIEW_DISCARDED_EXAMPLE_ITEM_ID,
		'DISPROVED',
		'NONE',
		'illustrative only',
		'not routable',
	]);
	return [
		PR_REVIEW_CONTRACT_CARD_HEADER,
		'Live markers:',
		`REVIEWED row: ${reviewer.fieldRoles.map((role, index) => (index === 0 ? reviewer.marker : role)).join(' | ')}`,
		`REVIEWED classifications: ${PR_REVIEW_REVIEWER_CLASSIFICATIONS.join(', ')}`,
		`REVIEWED evidence types: ${PR_REVIEW_REVIEWER_EVIDENCE_TYPES.join(', ')}`,
		`REVIEWED severities: ${PR_REVIEW_SEVERITIES.join(', ')}`,
		`CRITIC row: ${critic.fieldRoles.map((role, index) => (index === 0 ? critic.marker : role)).join(' | ')}`,
		`CRITIC statuses: ${PR_REVIEW_CRITIC_STATUSES.join(', ')}`,
		`CRITIC severities: ${PR_REVIEW_SEVERITIES.join(', ')}`,
		'Escapes inside free-text fields only: \\\\ => backslash, \\| => literal pipe, \\n => newline, \\r => carriage return',
		'Literal backslash before a real delimiter must be written as \\\\| (backslash, then delimiter).',
		'DISCOVERY and FEEDBACK rows keep their existing row grammars; this card governs REVIEWED and CRITIC rows only.',
		`Positive REVIEWED example: ${positiveReviewer}`,
		`Positive CRITIC example: ${positiveCritic}`,
		`DISCARDED REVIEWED EXAMPLE: ${discardedReviewer}`,
		`DISCARDED CRITIC EXAMPLE: ${discardedCritic}`,
		'Routing rules:',
		'- Emit exactly one live REVIEWED row per assigned item in reviewer lanes.',
		'- Emit exactly one live CRITIC row per assigned item in critic lanes.',
		'- DISPROVED requires severity NONE.',
		'- NEEDS_MORE_EVIDENCE is not a terminal critic transport row.',
		'- DISCARDED examples above are documentation only; they are not routable live rows.',
		'Defaults and ownership:',
		'- assigned_item_ids and workflow_lane come only from the controller block.',
		'- Omit no assigned row; emit no row for an unassigned or discarded example ID.',
		'- A settled lane is immutable and is never reprocessed on later collection.',
		'Transition matrix:',
		'- reviewer lane: assigned item -> exactly one REVIEWED row -> critic routing or terminal disposition.',
		'- critic lane: assigned reviewer claim -> exactly one CRITIC row -> final finding disposition.',
		'- malformed, duplicate, missing, or discarded rows -> contract failure and bounded retry; never acceptance.',
		'Retry and deadline semantics:',
		'- Malformed live rows fail closed and may be retried only within the controller retry bound.',
		'- A waited collection deadline terminalizes active lanes as error after bounded partial salvage.',
		'- Partial discovery salvage never turns an incomplete REVIEWED or CRITIC verdict into acceptance.',
	].join('\n');
}

function encodePrReviewVerdictField(value: string): string {
	return value
		.replace(/\\/g, '\\\\')
		.replace(/\|/g, '\\|')
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r');
}

export function encodePrReviewVerdictRow(
	kind: PrReviewVerdictKind,
	fields: readonly string[],
): string {
	const descriptor = PR_REVIEW_VERDICT_ROW_DESCRIPTORS[kind];
	const parsed = descriptor.schema.safeParse(fields);
	if (!parsed.success) {
		throw new Error(
			`${kind} verdict row requires ${descriptor.fieldCount} schema-valid fields beginning with ${descriptor.marker}: ${formatPrReviewValidationIssues(parsed.error.issues, fields).join('; ')}`,
		);
	}
	return parsed.data.map(encodePrReviewVerdictField).join(' | ');
}

export function parsePrReviewVerdictRow(
	line: string,
	kind: PrReviewVerdictKind,
): ParsedPrReviewVerdictRow | null {
	const descriptor = PR_REVIEW_VERDICT_ROW_DESCRIPTORS[kind];
	const fields: string[] = [];
	let current = '';
	let usedCanonicalEscape = false;
	for (let index = 0; index < line.length; index++) {
		const char = line[index];
		if (char === '\\') {
			const next = line[index + 1];
			if (next === '\\') {
				current += '\\';
				usedCanonicalEscape = true;
				index++;
				continue;
			}
			if (next === '|') {
				current += '|';
				usedCanonicalEscape = true;
				index++;
				continue;
			}
			if (next === 'n') {
				current += '\n';
				usedCanonicalEscape = true;
				index++;
				continue;
			}
			if (next === 'r') {
				current += '\r';
				usedCanonicalEscape = true;
				index++;
				continue;
			}
			current += '\\';
			continue;
		}
		if (char === '|') {
			fields.push(current.trim());
			current = '';
			continue;
		}
		current += char;
	}
	fields.push(current.trim());
	if (fields[0] !== descriptor.marker) return null;
	if (fields.length > descriptor.fieldCount) {
		const retained = fields.slice(0, descriptor.fieldCount - 1);
		retained.push(fields.slice(descriptor.fieldCount - 1).join('|'));
		return {
			marker: descriptor.marker,
			fields: retained,
			recoveredOverflow: true,
			overflowClass:
				fields.length === descriptor.fieldCount + 1 &&
				fields[fields.length - 1] === ''
					? 'legacy-fidelity-safe'
					: 'legacy-lossy',
		};
	}
	return {
		marker: descriptor.marker,
		fields,
		recoveredOverflow: false,
		overflowClass:
			fields.length === descriptor.fieldCount
				? usedCanonicalEscape
					? 'canonical'
					: 'legacy-fidelity-safe'
				: 'legacy-lossy',
	};
}

export function formatPrReviewRuntimeFieldError(
	field: string,
	expected: string,
	got: unknown,
): string {
	return `field ${field}: expected ${expected}, got ${formatActualValue(got)}`;
}

function pad(value: number, width: number): string {
	return `${value}`.padStart(width, '0');
}

export function generatePrReviewRunId(now: Date = new Date()): string {
	return (
		`pr-review-${now.getUTCFullYear()}` +
		`${pad(now.getUTCMonth() + 1, 2)}` +
		`${pad(now.getUTCDate(), 2)}` +
		`${pad(now.getUTCHours(), 2)}` +
		`${pad(now.getUTCMinutes(), 2)}` +
		`${pad(now.getUTCSeconds(), 2)}` +
		`${pad(now.getUTCMilliseconds(), 3)}`
	);
}
