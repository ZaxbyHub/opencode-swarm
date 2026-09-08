/**
 * Issue #2486: the durable, separately-consented training-content grant.
 *
 * Training-content capture is OFF by default and CANNOT be enabled by
 * repository config, environment variables, prompts, agents, tools, or
 * auto-proceed (source contract #2050 §1-2; re-baselined by #2486 as "separate
 * training consent from observability config" + "opt-out default"). The ONLY
 * enabler is this consent record, written under
 * `<root>/.swarm/training/v1/consent.json` by a human-only command flow, bound
 * to the canonical project root so a copied/cloned record is inert elsewhere
 * (cross-project isolation, AC3).
 *
 * `readActiveTrainingConsent` is the single gating read for capture: it fails
 * closed (returns null, never throws) on a missing, malformed, schema-mismatched,
 * withdrawn, expired, or foreign-project record.
 */
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { pseudonymousRef, resolveLineageSalt } from '../observability/ids';
import { atomicWriteSwarmFileSync } from '../utils/atomic-write';
import { trainingConsentPath } from './paths';

export const TRAINING_CONSENT_SCHEMA_VERSION = 1;
/** Version of the consent TERMS presented to the human (bump when terms change). */
export const TRAINING_CONSENT_CURRENT_VERSION = 1;

/** Hard per-project vault maxima (source contract #2050 §6). Lower is allowed; higher is not. */
export const TRAINING_QUOTA_CEILINGS = {
	maxBytes: 1_073_741_824,
	maxRecords: 250_000,
	retentionDays: 30,
} as const;

/** Hard per-project export maxima. */
export const TRAINING_EXPORT_QUOTA_CEILINGS = {
	maxBytes: 1_073_741_824,
	maxExports: 20,
	retentionDays: 30,
} as const;

const DAY_MS = 86_400_000;

export const TrainingProjectBindingSchema = z
	.object({
		rootDigest: z.string().regex(/^[0-9a-f]{16}$/),
		projectRef: z.string().regex(/^[0-9a-f]{16}$/),
	})
	.strict();

export const TrainingConsentSchema = z
	.object({
		schema_version: z.literal(TRAINING_CONSENT_SCHEMA_VERSION),
		consent_id: z.string().min(1),
		state: z.enum(['granted', 'withdrawn']),
		consent_version: z.literal(TRAINING_CONSENT_CURRENT_VERSION),
		granted_at: z.string().datetime(),
		withdrawn_at: z.string().datetime().optional(),
		expires_at: z.string().datetime(),
		purpose: z.string().min(1),
		content_classes: z.array(z.string().min(1)).min(1),
		quotas: z.object({
			maxBytes: z.number().int().positive(),
			maxRecords: z.number().int().positive(),
			retentionDays: z.number().int().positive(),
		}),
		redaction_version: z.literal(1),
		project_binding: TrainingProjectBindingSchema,
	})
	.strict();

export type TrainingConsent = z.infer<typeof TrainingConsentSchema>;

export interface GrantTrainingConsentInput {
	quotas?: Partial<{
		maxBytes: number;
		maxRecords: number;
		retentionDays: number;
	}>;
	expiresAt?: string;
	now?: Date;
}

/** Deterministic 16-hex digest binding a consent to its canonical project root. */
function rootDigestOf(directory: string): string {
	let canonical = directory;
	try {
		canonical = fs.realpathSync.native(directory);
	} catch {
		// A not-yet-created directory still binds to its spelled path.
	}
	return createHash('sha256')
		.update(`training-project-binding-v1\0${canonical}`)
		.digest('hex')
		.slice(0, 16);
}

/**
 * The project identity a consent is bound to. `rootDigest` pins the canonical
 * absolute root (clone/copy produces a different digest); `projectRef` reuses
 * the observability lineage pseudonym so vault records correlate with the
 * metadata-only event stream without carrying raw paths.
 */
export function computeProjectBinding(directory: string): {
	rootDigest: string;
	projectRef: string;
} {
	return {
		rootDigest: rootDigestOf(directory),
		projectRef: pseudonymousRef(directory, resolveLineageSalt()),
	};
}

function clampQuotas(
	quotas: NonNullable<GrantTrainingConsentInput['quotas']>,
): TrainingConsent['quotas'] {
	return {
		maxBytes: Math.max(
			1,
			Math.min(
				Math.trunc(quotas.maxBytes ?? TRAINING_QUOTA_CEILINGS.maxBytes),
				TRAINING_QUOTA_CEILINGS.maxBytes,
			),
		),
		maxRecords: Math.max(
			1,
			Math.min(
				Math.trunc(quotas.maxRecords ?? TRAINING_QUOTA_CEILINGS.maxRecords),
				TRAINING_QUOTA_CEILINGS.maxRecords,
			),
		),
		retentionDays: Math.max(
			1,
			Math.min(
				Math.trunc(
					quotas.retentionDays ?? TRAINING_QUOTA_CEILINGS.retentionDays,
				),
				TRAINING_QUOTA_CEILINGS.retentionDays,
			),
		),
	};
}

/**
 * Write a new granted consent record (atomically). A prior record — granted or
 * withdrawn — is replaced; each grant carries a fresh consent_id so vault
 * records remain attributable to the exact grant they were captured under.
 */
export function grantTrainingConsent(
	directory: string,
	input: GrantTrainingConsentInput = {},
): TrainingConsent {
	const now = input.now ?? new Date(Date.now());
	const quotas = clampQuotas(input.quotas ?? {});
	const grantedAt = new Date(now.getTime());
	const expiresAt =
		input.expiresAt ??
		new Date(grantedAt.getTime() + quotas.retentionDays * DAY_MS).toISOString();
	const consent: TrainingConsent = {
		schema_version: TRAINING_CONSENT_SCHEMA_VERSION,
		consent_id: randomUUID(),
		state: 'granted',
		consent_version: TRAINING_CONSENT_CURRENT_VERSION,
		granted_at: grantedAt.toISOString(),
		expires_at: expiresAt,
		purpose: 'model-training-content-capture',
		content_classes: [
			'user_message',
			'assistant_message',
			'tool_call',
			'tool_result',
		],
		quotas,
		redaction_version: 1,
		project_binding: computeProjectBinding(directory),
	};
	const target = trainingConsentPath(directory);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	atomicWriteSwarmFileSync(target, JSON.stringify(consent, null, 2));
	return consent;
}

/**
 * Mark the consent withdrawn. Capture stops immediately (every observation
 * re-reads the active consent); physical content deletion is the withdraw
 * command's confirmed step, not this write.
 */
export function revokeTrainingConsent(
	directory: string,
	options: { now?: Date } = {},
): void {
	const target = trainingConsentPath(directory);
	let existing: TrainingConsent | null = null;
	try {
		existing = TrainingConsentSchema.parse(
			JSON.parse(fs.readFileSync(target, 'utf-8')),
		);
	} catch {
		existing = null;
	}
	const withdrawnAt = (options.now ?? new Date(Date.now())).toISOString();
	const withdrawn: TrainingConsent = existing
		? { ...existing, state: 'withdrawn', withdrawn_at: withdrawnAt }
		: {
				schema_version: TRAINING_CONSENT_SCHEMA_VERSION,
				consent_id: randomUUID(),
				state: 'withdrawn',
				consent_version: TRAINING_CONSENT_CURRENT_VERSION,
				granted_at: withdrawnAt,
				withdrawn_at: withdrawnAt,
				expires_at: withdrawnAt,
				purpose: 'model-training-content-capture',
				content_classes: ['user_message'],
				quotas: { ...TRAINING_QUOTA_CEILINGS },
				redaction_version: 1,
				project_binding: computeProjectBinding(directory),
			};
	fs.mkdirSync(path.dirname(target), { recursive: true });
	atomicWriteSwarmFileSync(target, JSON.stringify(withdrawn, null, 2));
}

/**
 * The capture-gating consent read. Fail-closed: missing file, malformed JSON,
 * schema mismatch, `state !== 'granted'`, expiry, or a project binding issued
 * for a different canonical root all return null.
 */
export function readActiveTrainingConsent(
	directory: string,
	options: { now?: Date } = {},
): TrainingConsent | null {
	let raw: string;
	try {
		raw = fs.readFileSync(trainingConsentPath(directory), 'utf-8');
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	const consent = TrainingConsentSchema.safeParse(parsed);
	if (!consent.success) {
		return null;
	}
	if (consent.data.state !== 'granted') {
		return null;
	}
	const now = options.now ?? new Date(Date.now());
	if (now.getTime() >= Date.parse(consent.data.expires_at)) {
		return null;
	}
	if (consent.data.project_binding.rootDigest !== rootDigestOf(directory)) {
		return null;
	}
	return consent.data;
}

/**
 * Read a granted, project-bound consent WITHOUT the wall-clock expiry check.
 * The capture observer uses `readActiveTrainingConsent` (expiry-aware); the
 * vault's append gate instead validates that the consent was active AT THE
 * RECORD'S captured_at, so a record legitimately captured before expiry still
 * lands while any capture attempted under an expired grant is refused.
 */
export function readGrantedTrainingConsent(
	directory: string,
): TrainingConsent | null {
	try {
		const consent = TrainingConsentSchema.parse(
			JSON.parse(fs.readFileSync(trainingConsentPath(directory), 'utf-8')),
		);
		if (consent.state !== 'granted') return null;
		if (consent.project_binding.rootDigest !== rootDigestOf(directory)) {
			return null;
		}
		return consent;
	} catch {
		return null;
	}
}

/** Read the raw consent state for status reporting (never throws). */
export function readTrainingConsentState(
	directory: string,
): 'granted' | 'withdrawn' | 'absent' {
	try {
		const parsed = TrainingConsentSchema.parse(
			JSON.parse(fs.readFileSync(trainingConsentPath(directory), 'utf-8')),
		);
		return parsed.state;
	} catch {
		return 'absent';
	}
}
