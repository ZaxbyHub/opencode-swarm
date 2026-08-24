import { createHash } from 'node:crypto';
import { z } from 'zod';

export const PR_REVIEW_COLLECTION_RECEIPT_PREFIX =
	'[PR_REVIEW_COLLECTION_RECEIPT_V1] ';
export const PR_REVIEW_COLLECTION_RECEIPT_SHED_PREFIX =
	'[PR_REVIEW_COLLECTION_RECEIPT_SHED_V1] ';
/** Bound durable receipt metadata even when a malformed producer supplies text. */
export const MAX_PR_REVIEW_COLLECTION_RECEIPT_CHARS = 64 * 1024;
/** Keep public assignment schemas aligned with the largest durable receipt. */
export const MAX_PR_REVIEW_COLLECTION_RECEIPT_ITEM_IDS = 10_000;

const PrReviewCollectionReceiptPayloadSchema = z
	.object({
		schemaVersion: z.literal(1),
		parentSessionId: z.string().min(1).max(256),
		batchId: z.string().min(1).max(120),
		laneId: z.string().min(1).max(120),
		mode: z.enum(['swarm-pr-review:reviewer', 'swarm-pr-review:critic']),
		workflowLane: z.string().min(1).max(120),
		outputDigest: z.string().regex(/^[a-f0-9]{64}$/),
		disposition: z.enum(['accepted', 'rejected']),
		reviewItemIds: z
			.array(z.string().min(1).max(160))
			.min(1)
			.max(MAX_PR_REVIEW_COLLECTION_RECEIPT_ITEM_IDS),
	})
	.strict()
	.superRefine((payload, context) => {
		if (new Set(payload.reviewItemIds).size !== payload.reviewItemIds.length) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'review item IDs must be unique',
			});
		}
	});

export type PrReviewCollectionReceiptPayload = z.infer<
	typeof PrReviewCollectionReceiptPayloadSchema
>;

const PrReviewCollectionReceiptShedMarkerSchema = z
	.object({
		schemaVersion: z.literal(1),
		parentSessionId: z.string().min(1).max(256),
		batchId: z.string().min(1).max(120),
		laneId: z.string().min(1).max(120),
		mode: z.enum(['swarm-pr-review:reviewer', 'swarm-pr-review:critic']),
		workflowLane: z.string().min(1).max(120),
		outputDigest: z.string().regex(/^[a-f0-9]{64}$/),
		disposition: z.enum(['accepted', 'rejected']),
		reviewItemCount: z
			.number()
			.int()
			.positive()
			.max(MAX_PR_REVIEW_COLLECTION_RECEIPT_ITEM_IDS),
		reviewItemDigest: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();

export type PrReviewCollectionReceiptShedMarker = z.infer<
	typeof PrReviewCollectionReceiptShedMarkerSchema
>;

export interface PrReviewCollectionReceiptBinding {
	parentSessionId: string;
	batchId?: string;
	callID: string;
	laneId?: string;
	correlationId: string;
	mode?: string;
	workflowLane?: string;
}

export interface PrReviewCollectionReceiptResult {
	text?: string;
	digest: string;
}

export interface PrReviewCollectionReceiptPartition {
	assignedReviewItemIds: string[];
	acceptedReviewItemIds: string[];
	rejectedReviewItemIds: string[];
}

function resolveLaneAtomicDisposition(
	receipt: PrReviewCollectionReceiptPartition,
): 'accepted' | 'rejected' | null {
	if (
		new Set(receipt.assignedReviewItemIds).size !==
		receipt.assignedReviewItemIds.length
	) {
		return null;
	}
	const acceptedAll =
		receipt.rejectedReviewItemIds.length === 0 &&
		receipt.acceptedReviewItemIds.length ===
			receipt.assignedReviewItemIds.length &&
		receipt.acceptedReviewItemIds.every(
			(itemId, index) => itemId === receipt.assignedReviewItemIds[index],
		);
	const rejectedAll =
		receipt.acceptedReviewItemIds.length === 0 &&
		receipt.rejectedReviewItemIds.length ===
			receipt.assignedReviewItemIds.length &&
		receipt.rejectedReviewItemIds.every(
			(itemId, index) => itemId === receipt.assignedReviewItemIds[index],
		);
	return acceptedAll ? 'accepted' : rejectedAll ? 'rejected' : null;
}

export function encodePrReviewCollectionReceiptFooter(
	binding: PrReviewCollectionReceiptBinding,
	result: PrReviewCollectionReceiptResult,
	receipt: PrReviewCollectionReceiptPartition,
): string | null {
	const payload = buildPrReviewCollectionReceiptPayload(
		binding,
		result,
		receipt,
	);
	if (!payload) return null;
	const footer = `${PR_REVIEW_COLLECTION_RECEIPT_PREFIX}${JSON.stringify(payload)}`;
	return footer.length <= MAX_PR_REVIEW_COLLECTION_RECEIPT_CHARS
		? footer
		: null;
}

function buildPrReviewCollectionReceiptPayload(
	binding: PrReviewCollectionReceiptBinding,
	result: PrReviewCollectionReceiptResult,
	receipt: PrReviewCollectionReceiptPartition,
): PrReviewCollectionReceiptPayload | null {
	const disposition = resolveLaneAtomicDisposition(receipt);
	if (!disposition) return null;
	const parsed = PrReviewCollectionReceiptPayloadSchema.safeParse({
		schemaVersion: 1,
		parentSessionId: binding.parentSessionId,
		batchId: binding.batchId ?? binding.callID,
		laneId: binding.laneId ?? binding.correlationId,
		mode: binding.mode,
		workflowLane: binding.workflowLane,
		outputDigest: result.digest,
		disposition,
		reviewItemIds: receipt.assignedReviewItemIds,
	});
	if (!parsed.success) return null;
	return parsed.data;
}

export function projectPrReviewCollectionReceipt(
	payload: PrReviewCollectionReceiptPayload,
): PrReviewCollectionReceiptPartition {
	const assignedReviewItemIds = [...payload.reviewItemIds];
	return {
		assignedReviewItemIds,
		acceptedReviewItemIds:
			payload.disposition === 'accepted' ? [...assignedReviewItemIds] : [],
		rejectedReviewItemIds:
			payload.disposition === 'rejected' ? [...assignedReviewItemIds] : [],
	};
}

function reviewItemDigest(reviewItemIds: readonly string[]): string {
	return createHash('sha256')
		.update(JSON.stringify(reviewItemIds))
		.digest('hex');
}

export function encodePrReviewCollectionReceiptShedMarker(
	payload: PrReviewCollectionReceiptPayload,
): string {
	const marker: PrReviewCollectionReceiptShedMarker = {
		schemaVersion: 1,
		parentSessionId: payload.parentSessionId,
		batchId: payload.batchId,
		laneId: payload.laneId,
		mode: payload.mode,
		workflowLane: payload.workflowLane,
		outputDigest: payload.outputDigest,
		disposition: payload.disposition,
		reviewItemCount: payload.reviewItemIds.length,
		reviewItemDigest: reviewItemDigest(payload.reviewItemIds),
	};
	return `${PR_REVIEW_COLLECTION_RECEIPT_SHED_PREFIX}${JSON.stringify(marker)}`;
}

export function encodePrReviewCollectionReceiptShedMarkerFromReceipt(
	binding: PrReviewCollectionReceiptBinding,
	result: PrReviewCollectionReceiptResult,
	receipt: PrReviewCollectionReceiptPartition,
): string | null {
	const payload = buildPrReviewCollectionReceiptPayload(
		binding,
		result,
		receipt,
	);
	return payload ? encodePrReviewCollectionReceiptShedMarker(payload) : null;
}

export function parsePrReviewCollectionReceiptShedMarker(
	binding: PrReviewCollectionReceiptBinding,
	result: PrReviewCollectionReceiptResult,
): PrReviewCollectionReceiptShedMarker | null {
	if (!result.text) return null;
	const lines = result.text.split(/\r?\n/);
	const markerLines = lines.filter((line) =>
		line.startsWith(PR_REVIEW_COLLECTION_RECEIPT_SHED_PREFIX),
	);
	const finalLine = lines.at(-1);
	if (
		markerLines.length !== 1 ||
		!finalLine?.startsWith(PR_REVIEW_COLLECTION_RECEIPT_SHED_PREFIX) ||
		finalLine.length > MAX_PR_REVIEW_COLLECTION_RECEIPT_CHARS
	) {
		return null;
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(
			finalLine.slice(PR_REVIEW_COLLECTION_RECEIPT_SHED_PREFIX.length),
		);
	} catch {
		return null;
	}
	const parsed = PrReviewCollectionReceiptShedMarkerSchema.safeParse(decoded);
	if (!parsed.success) return null;
	const marker = parsed.data;
	return marker.parentSessionId === binding.parentSessionId &&
		marker.batchId === (binding.batchId ?? binding.callID) &&
		marker.laneId === (binding.laneId ?? binding.correlationId) &&
		marker.mode === binding.mode &&
		marker.workflowLane === binding.workflowLane &&
		marker.outputDigest === result.digest
		? marker
		: null;
}

export function projectPrReviewCollectionReceiptShedMarker(
	marker: PrReviewCollectionReceiptShedMarker,
	reviewItemIds: readonly string[],
): PrReviewCollectionReceiptPartition | null {
	if (
		marker.reviewItemCount !== reviewItemIds.length ||
		marker.reviewItemDigest !== reviewItemDigest(reviewItemIds)
	) {
		return null;
	}
	const assignedReviewItemIds = [...reviewItemIds];
	return {
		assignedReviewItemIds,
		acceptedReviewItemIds:
			marker.disposition === 'accepted' ? [...assignedReviewItemIds] : [],
		rejectedReviewItemIds:
			marker.disposition === 'rejected' ? [...assignedReviewItemIds] : [],
	};
}

export function parsePrReviewCollectionReceiptFooter(
	binding: PrReviewCollectionReceiptBinding,
	result: PrReviewCollectionReceiptResult,
): PrReviewCollectionReceiptPayload | null {
	if (!result.text) return null;
	const lines = result.text.split(/\r?\n/);
	const receiptLines = lines.filter((line) =>
		line.startsWith(PR_REVIEW_COLLECTION_RECEIPT_PREFIX),
	);
	const finalLine = lines.at(-1);
	if (
		receiptLines.length !== 1 ||
		!finalLine?.startsWith(PR_REVIEW_COLLECTION_RECEIPT_PREFIX) ||
		finalLine.length > MAX_PR_REVIEW_COLLECTION_RECEIPT_CHARS
	) {
		return null;
	}

	let decoded: unknown;
	try {
		decoded = JSON.parse(
			finalLine.slice(PR_REVIEW_COLLECTION_RECEIPT_PREFIX.length),
		);
	} catch {
		return null;
	}
	const parsed = PrReviewCollectionReceiptPayloadSchema.safeParse(decoded);
	if (!parsed.success) return null;
	const payload = parsed.data;
	return payload.parentSessionId === binding.parentSessionId &&
		payload.batchId === (binding.batchId ?? binding.callID) &&
		payload.laneId === (binding.laneId ?? binding.correlationId) &&
		payload.mode === binding.mode &&
		payload.workflowLane === binding.workflowLane &&
		payload.outputDigest === result.digest
		? payload
		: null;
}
