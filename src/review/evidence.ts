import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type FindingValidation,
	FindingValidationSchema,
	type ReviewFinding,
	ReviewFindingSchema,
} from '../agents/agent-output-schema.js';
import {
	isScopeStale,
	type ReviewFindingSeverity,
	type ReviewReceipt,
	ReviewScopeStaleError,
	readReviewReceiptText,
} from '../hooks/review-receipt.js';
import { validateSwarmPath } from '../hooks/utils.js';
import { bunWrite } from '../utils/bun-compat.js';
import { invalidateCachedArtifact } from '../utils/swarm-artifact-cache.js';
import type {
	ReviewDiffCompleteness,
	ReviewDiffSelector,
} from './diff-source.js';
import { canonicalizeValidationCandidates } from './finding-validator.js';

export interface AutoReviewEvidenceFinding extends ReviewFinding {
	finding_id: string;
	duplicate_count: number;
	anchored: boolean;
	anchor_rejection?: string;
	effective_severity: ReviewFindingSeverity;
	validation?: FindingValidation;
}

export interface AutoReviewEvidence {
	schema_version: 1;
	timestamp: string;
	trigger:
		| 'task_completion'
		| 'phase_completion'
		| 'plan_completion'
		| 'manual';
	session_id: string;
	phase?: number;
	scope: {
		hash: string;
		selector: ReviewDiffSelector;
		head_sha: string;
		base_ref?: string;
		base_sha?: string;
		merge_base?: string;
		range_to_sha?: string;
		review_text_bytes: number;
		completeness: ReviewDiffCompleteness;
	};
	policy: {
		mode: 'advisory' | 'gate';
		min_confidence: number;
		structured_findings: boolean;
		validate_findings: boolean;
	};
	review: {
		status: 'completed' | 'clean' | 'error';
		output_mode?: 'structured' | 'legacy';
		overall_confidence?: number;
		error?: string;
		model?: string;
		duration_ms?: number;
	};
	findings: AutoReviewEvidenceFinding[];
	validation_complete: boolean;
	validation_error?: string;
	blocking_finding_ids: string[];
	receipt_path?: string;
	cost: {
		model_calls: number;
		diff_bytes: number;
		prompt_bytes: number;
		tokens_input: number;
		tokens_output: number;
		tokens_reasoning: number;
		tokens_cache: number;
		cost_usd: number | null;
		cost_source: 'reported' | 'estimated' | 'unavailable';
	};
}

export function autoReviewEvidenceRelativePath(
	trigger: AutoReviewEvidence['trigger'],
	scopeHash: string,
	phase?: number,
): string {
	if (
		(trigger === 'phase_completion' || trigger === 'plan_completion') &&
		Number.isInteger(phase) &&
		(phase ?? 0) > 0
	) {
		return path.join('evidence', String(phase), 'auto-review.json');
	}
	return path.join(
		'evidence',
		'auto-review',
		`${trigger}-${scopeHash.slice(0, 64)}.json`,
	);
}

export interface PersistAutoReviewEvidenceOptions {
	/** Rebuild the exact reviewed scope immediately before the atomic rename. */
	verifyCurrent?: () => Promise<boolean>;
}

export async function persistAutoReviewEvidence(
	directory: string,
	evidence: AutoReviewEvidence,
	options: PersistAutoReviewEvidenceOptions = {},
): Promise<string> {
	const target = validateSwarmPath(
		directory,
		autoReviewEvidenceRelativePath(
			evidence.trigger,
			evidence.scope.hash,
			evidence.phase,
		),
	);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const tempPath = `${target}.tmp.${Date.now()}.${Math.floor(Math.random() * 1e9)}`;
	try {
		await bunWrite(tempPath, `${JSON.stringify(evidence, null, 2)}\n`);
		const safeTemp = validateSwarmPath(
			directory,
			path.relative(path.join(directory, '.swarm'), tempPath),
		);
		const tempStat = fs.lstatSync(safeTemp);
		if (!tempStat.isFile() || tempStat.isSymbolicLink()) {
			throw new Error('auto-review evidence temp path must be a real file');
		}
		if (options.verifyCurrent && !(await options.verifyCurrent())) {
			throw new ReviewScopeStaleError(
				'auto-review scope became stale before evidence commit',
			);
		}
		// Revalidate containment synchronously after the awaited verifier and
		// immediately before rename so an ancestor swap cannot be committed.
		const safeTarget = validateSwarmPath(
			directory,
			path.relative(path.join(directory, '.swarm'), target),
		);
		const revalidatedTemp = validateSwarmPath(
			directory,
			path.relative(path.join(directory, '.swarm'), tempPath),
		);
		const revalidatedStat = fs.lstatSync(revalidatedTemp);
		if (!revalidatedStat.isFile() || revalidatedStat.isSymbolicLink()) {
			throw new Error('auto-review evidence temp path changed before commit');
		}
		fs.renameSync(revalidatedTemp, safeTarget);
		invalidateCachedArtifact(safeTarget);
		return safeTarget;
	} finally {
		try {
			fs.unlinkSync(tempPath);
		} catch {
			// Already renamed or never created.
		}
	}
}

export function readAutoReviewEvidenceForPhase(
	directory: string,
	phase: number,
): AutoReviewEvidence | null {
	try {
		const target = validateSwarmPath(
			directory,
			path.join('evidence', String(phase), 'auto-review.json'),
		);
		const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as unknown;
		if (!isAutoReviewEvidence(parsed)) return null;
		return parsed;
	} catch {
		return null;
	}
}

export function isAutoReviewEvidence(
	value: unknown,
): value is AutoReviewEvidence {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Partial<AutoReviewEvidence>;
	if (
		!(
			candidate.schema_version === 1 &&
			typeof candidate.timestamp === 'string' &&
			[
				'task_completion',
				'phase_completion',
				'plan_completion',
				'manual',
			].includes(String(candidate.trigger)) &&
			typeof candidate.session_id === 'string' &&
			Boolean(candidate.scope) &&
			typeof candidate.scope?.hash === 'string' &&
			typeof candidate.scope?.head_sha === 'string' &&
			Boolean(candidate.scope?.selector) &&
			Boolean(candidate.scope?.completeness) &&
			Boolean(candidate.policy) &&
			(candidate.policy?.mode === 'advisory' ||
				candidate.policy?.mode === 'gate') &&
			typeof candidate.policy?.min_confidence === 'number' &&
			typeof candidate.policy?.structured_findings === 'boolean' &&
			typeof candidate.policy?.validate_findings === 'boolean' &&
			Array.isArray(candidate.findings) &&
			Array.isArray(candidate.blocking_finding_ids) &&
			typeof candidate.validation_complete === 'boolean' &&
			Boolean(candidate.review) &&
			['completed', 'clean', 'error'].includes(String(candidate.review?.status))
		)
	) {
		return false;
	}
	return candidate.findings.every(isAutoReviewEvidenceFinding);
}

function baseFinding(finding: AutoReviewEvidenceFinding): ReviewFinding {
	return {
		title: finding.title,
		body: finding.body,
		severity: finding.severity,
		confidence: finding.confidence,
		file: finding.file,
		line_start: finding.line_start,
		line_end: finding.line_end,
	};
}

function isAutoReviewEvidenceFinding(
	value: unknown,
): value is AutoReviewEvidenceFinding {
	if (!value || typeof value !== 'object') return false;
	const finding = value as AutoReviewEvidenceFinding;
	if (
		!ReviewFindingSchema.safeParse(baseFinding(finding)).success ||
		!/^[a-f0-9]{64}$/.test(finding.finding_id) ||
		!Number.isInteger(finding.duplicate_count) ||
		finding.duplicate_count < 1 ||
		typeof finding.anchored !== 'boolean' ||
		!['critical', 'high', 'medium', 'low', 'info'].includes(
			finding.effective_severity,
		)
	) {
		return false;
	}
	return (
		finding.validation === undefined ||
		(FindingValidationSchema.safeParse(finding.validation).success &&
			finding.validation.finding_id === finding.finding_id)
	);
}

export interface AutoReviewEvidenceExpectation {
	scopeHash: string;
	phase: number;
	trigger: 'phase_completion' | 'plan_completion';
	policy: AutoReviewEvidence['policy'];
	/** Canonical diff text used to bind the independent receipt to this scope. */
	scopeContent?: string;
}

export type AutoReviewEvidenceIntegrityResult =
	| { ok: true; receipt?: ReviewReceipt }
	| {
			ok: false;
			code: 'evidence' | 'receipt_missing' | 'receipt';
			reason: string;
	  };

function failIntegrity(
	code: 'evidence' | 'receipt_missing' | 'receipt',
	reason: string,
): AutoReviewEvidenceIntegrityResult {
	return { ok: false, code, reason };
}

function readContainedReceipt(
	directory: string,
	receiptPath: string | undefined,
): ReviewReceipt | null {
	if (!receiptPath) return null;
	try {
		const content = readReviewReceiptText(directory, receiptPath);
		if (content === null) return null;
		const parsed = JSON.parse(content) as unknown;
		if (!parsed || typeof parsed !== 'object') return null;
		const receipt = parsed as ReviewReceipt;
		if (
			receipt.schema_version !== 1 ||
			!['approved', 'rejected'].includes(receipt.verdict) ||
			receipt.receipt_type !== receipt.verdict ||
			typeof receipt.id !== 'string' ||
			typeof receipt.reviewer?.agent !== 'string' ||
			typeof receipt.scope_fingerprint?.hash !== 'string' ||
			typeof receipt.scope_fingerprint?.scope_description !== 'string' ||
			!Array.isArray(receipt.structured_findings) ||
			!receipt.structured_findings.every(
				(finding) => ReviewFindingSchema.safeParse(finding).success,
			) ||
			!Array.isArray(receipt.finding_validations) ||
			!receipt.finding_validations.every(
				(validation) => FindingValidationSchema.safeParse(validation).success,
			)
		) {
			return null;
		}
		return receipt;
	} catch {
		return null;
	}
}

function sameValidation(
	left: FindingValidation,
	right: FindingValidation,
): boolean {
	return (
		left.finding_id === right.finding_id &&
		left.disposition === right.disposition &&
		left.confidence === right.confidence &&
		left.evidence === right.evidence
	);
}

/**
 * Cross-validates phase evidence against its independently persisted receipt.
 * Callers must fail closed on any non-ok result; this function never dispatches.
 */
export function validateAutoReviewEvidenceIntegrity(
	directory: string,
	evidence: AutoReviewEvidence,
	expected: AutoReviewEvidenceExpectation,
): AutoReviewEvidenceIntegrityResult {
	if (
		evidence.scope.hash !== expected.scopeHash ||
		evidence.phase !== expected.phase ||
		evidence.trigger !== expected.trigger
	) {
		return failIntegrity(
			'evidence',
			'phase, trigger, or scope binding mismatch',
		);
	}
	if (
		evidence.policy.mode !== expected.policy.mode ||
		evidence.policy.min_confidence !== expected.policy.min_confidence ||
		evidence.policy.structured_findings !==
			expected.policy.structured_findings ||
		evidence.policy.validate_findings !== expected.policy.validate_findings
	) {
		return failIntegrity('evidence', 'policy binding mismatch');
	}
	const canonicalEvidence = canonicalizeValidationCandidates(evidence.findings);
	if (
		canonicalEvidence.length !== evidence.findings.length ||
		canonicalEvidence.some((canonical, index) => {
			const recorded = [...evidence.findings].sort((a, b) =>
				a.finding_id.localeCompare(b.finding_id),
			)[index];
			return (
				canonical.finding_id !== recorded.finding_id ||
				canonical.duplicate_count !== recorded.duplicate_count
			);
		})
	) {
		return failIntegrity(
			'evidence',
			'finding IDs or duplicate counts are invalid',
		);
	}
	if (
		evidence.findings.some(
			(finding) =>
				finding.effective_severity !==
				(finding.confidence < expected.policy.min_confidence
					? 'info'
					: finding.severity),
		)
	) {
		return failIntegrity(
			'evidence',
			'effective finding severity does not match current policy',
		);
	}
	const derivedBlockingIds = evidence.findings
		.filter(
			(finding) =>
				finding.anchored &&
				(finding.effective_severity === 'high' ||
					finding.effective_severity === 'critical') &&
				finding.validation?.disposition === 'CONFIRMED',
		)
		.map((finding) => finding.finding_id)
		.sort();
	const recordedBlockingIds = [...evidence.blocking_finding_ids].sort();
	if (
		derivedBlockingIds.length !== recordedBlockingIds.length ||
		derivedBlockingIds.some(
			(findingId, index) => findingId !== recordedBlockingIds[index],
		)
	) {
		return failIntegrity(
			'evidence',
			'blocking finding IDs do not match derived confirmed findings',
		);
	}
	if (evidence.review.status !== 'completed') {
		return evidence.findings.length === 0 &&
			evidence.blocking_finding_ids.length === 0
			? { ok: true }
			: failIntegrity('evidence', 'non-completed evidence contains findings');
	}
	const receipt = readContainedReceipt(directory, evidence.receipt_path);
	if (!receipt) {
		return failIntegrity('receipt_missing', 'receipt is missing or malformed');
	}
	if (
		receipt.reviewer.session_id !== evidence.session_id ||
		receipt.scope_fingerprint.scope_description !==
			`${evidence.trigger}-review` ||
		(expected.scopeContent !== undefined &&
			isScopeStale(receipt, expected.scopeContent))
	) {
		return failIntegrity(
			'receipt',
			'receipt scope or session binding mismatch',
		);
	}
	const receiptCandidates = canonicalizeValidationCandidates(
		receipt.structured_findings ?? [],
	);
	const evidenceById = new Map(
		evidence.findings.map((finding) => [finding.finding_id, finding]),
	);
	if (
		receiptCandidates.length !== evidence.findings.length ||
		receiptCandidates.some((candidate) => {
			const recorded = evidenceById.get(candidate.finding_id);
			return (
				!recorded ||
				candidate.duplicate_count !== recorded.duplicate_count ||
				JSON.stringify(baseFinding(recorded)) !==
					JSON.stringify(baseFinding(candidate as AutoReviewEvidenceFinding))
			);
		})
	) {
		return failIntegrity('receipt', 'receipt finding IDs or payloads mismatch');
	}
	const evidenceValidations = evidence.findings
		.flatMap((finding) => (finding.validation ? [finding.validation] : []))
		.sort((a, b) => a.finding_id.localeCompare(b.finding_id));
	const receiptValidations = [...(receipt.finding_validations ?? [])].sort(
		(a, b) => a.finding_id.localeCompare(b.finding_id),
	);
	if (
		evidenceValidations.length !== receiptValidations.length ||
		evidenceValidations.some(
			(validation, index) =>
				!sameValidation(validation, receiptValidations[index]),
		)
	) {
		return failIntegrity('receipt', 'receipt finding validations mismatch');
	}
	if (receipt.receipt_type === 'rejected') {
		const receiptById = new Map(
			receipt.blocking_findings.map((finding) => [finding.finding_id, finding]),
		);
		if (receiptById.size !== evidence.findings.length) {
			return failIntegrity('receipt', 'rejected receipt finding IDs mismatch');
		}
		for (const finding of evidence.findings) {
			const recorded = receiptById.get(finding.finding_id);
			if (
				!recorded ||
				recorded.anchor_status !==
					(finding.anchored ? 'anchored' : 'unanchored') ||
				recorded.anchor_reason !== finding.anchor_rejection ||
				recorded.effective_severity !== finding.effective_severity ||
				recorded.validator_disposition !== finding.validation?.disposition ||
				recorded.validator_confidence !== finding.validation?.confidence ||
				recorded.validator_evidence !== finding.validation?.evidence
			) {
				return failIntegrity(
					'receipt',
					'rejected receipt derived finding state mismatch',
				);
			}
		}
	} else {
		const expectedCaveats = evidence.findings
			.filter((finding) => !finding.anchored)
			.map(
				(finding) =>
					`${finding.title}: ${finding.anchor_rejection ?? 'unanchored'}`,
			)
			.sort();
		const receiptCaveats = [...(receipt.caveats ?? [])].sort();
		if (
			expectedCaveats.length !== receiptCaveats.length ||
			expectedCaveats.some((caveat, index) => caveat !== receiptCaveats[index])
		) {
			return failIntegrity(
				'receipt',
				'approved receipt anchoring caveats mismatch',
			);
		}
	}
	return { ok: true, receipt };
}
