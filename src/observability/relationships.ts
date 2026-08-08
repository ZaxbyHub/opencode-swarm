/**
 * Relationship validation for observability events (issue #2029 item 3 / AC1).
 *
 * `validateEventRelationships` RETURNS a verdict and NEVER THROWS. It is called
 * from `createObservation`, which itself must never throw and must never reject
 * an emit — a validation failure records a violation, it does not drop an event.
 *
 * Scope of what this proves, stated honestly: in production the envelope is
 * currently discarded after the legacy line is written (its consumer lands in
 * #2047), so these violations do not bite at runtime today. They bite in unit
 * tests and in the static contract check.
 *
 * Import rules: no filesystem, network, subprocess, or OTel SDK.
 */
import { getCatalogEntry } from './catalog.js';
import type { ObservabilityEvent, SpanLink } from './envelope.js';

/** 32 lowercase hex characters — a W3C `trace-id`. */
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;

/** 16 lowercase hex characters — a W3C span id. */
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;

/** Verdict from {@link validateEventRelationships}. */
export type RelationshipValidationResult =
	| { ok: true }
	| { ok: false; violations: string[] };

/**
 * Stable violation codes.
 *
 * Codes are machine-readable and must not be renamed once emitted — they are the
 * join key a downstream consumer will group on. The suffix after `:` is the
 * offending identifier or link index.
 */
export const RELATIONSHIP_VIOLATION_CODES = Object.freeze({
	unknownKind: 'unknown_kind',
	requiredWorkflowIdMissing: 'required_workflow_id_missing',
	forbiddenWorkflowIdPresent: 'forbidden_workflow_id_present',
	parentSpanNotAllowed: 'parent_span_not_allowed',
	parentSpanMissing: 'parent_span_missing',
	malformedParentSpanId: 'malformed_parent_span_id',
	linksNotAllowed: 'links_not_allowed',
	malformedLinkTraceId: 'malformed_link_trace_id',
	malformedLinkSpanId: 'malformed_link_span_id',
	validationFailed: 'relationship_validation_failed',
});

/**
 * Validate an event against its catalogued relationship rules.
 *
 * Checks, in order:
 *   (a) the kind is catalogued;
 *   (b) every `requiredWorkflowIds` entry is present;
 *   (c) no `forbiddenWorkflowIds` entry is present (a present one means an ID
 *       was manufactured upstream — issue #2029 item 2);
 *   (d) a parent span is absent when the kind does not take one;
 *   (e) a parent span is present when the kind requires one;
 *   (f) a present parent span is a well-formed W3C span id;
 *   (g) links are absent when the kind does not allow them;
 *   (h) every link carries a well-formed trace/span id pair.
 *
 * @returns `{ ok: true }` or `{ ok: false, violations }`. Never throws.
 */
export function validateEventRelationships(
	event: ObservabilityEvent,
): RelationshipValidationResult {
	const violations: string[] = [];
	try {
		const entry = getCatalogEntry(event.kind);
		const links: readonly SpanLink[] = Array.isArray(event.trace?.links)
			? event.trace.links
			: [];

		if (entry === undefined) {
			// (a) An uncatalogued kind is classified, never dropped.
			violations.push(
				`${RELATIONSHIP_VIOLATION_CODES.unknownKind}:${event.kind}`,
			);
		} else {
			const workflow = event.workflow ?? {};

			// (b) A required ID that the producer did not supply.
			for (const id of entry.requiredWorkflowIds) {
				if (workflow[id] === undefined) {
					violations.push(
						`${RELATIONSHIP_VIOLATION_CODES.requiredWorkflowIdMissing}:${id}`,
					);
				}
			}

			// (c) An ID this producer genuinely never holds turning up anyway.
			for (const id of entry.forbiddenWorkflowIds) {
				if (workflow[id] !== undefined) {
					violations.push(
						`${RELATIONSHIP_VIOLATION_CODES.forbiddenWorkflowIdPresent}:${id}`,
					);
				}
			}

			const parentSpanId = event.trace?.parentSpanId;
			// (d) / (e) parent-span presence must match the catalogued rule.
			if (!entry.requiresParent && parentSpanId !== undefined) {
				violations.push(RELATIONSHIP_VIOLATION_CODES.parentSpanNotAllowed);
			}
			if (entry.requiresParent && parentSpanId === undefined) {
				violations.push(RELATIONSHIP_VIOLATION_CODES.parentSpanMissing);
			}

			// A PRESENT parent span must also be W3C-shaped. Link ids are already
			// format-validated below; checking presence only here would let a
			// malformed `parentSpanId` — the one id a consumer joins a span tree
			// on — pass unreported.
			if (
				parentSpanId !== undefined &&
				!SPAN_ID_PATTERN.test(String(parentSpanId))
			) {
				violations.push(RELATIONSHIP_VIOLATION_CODES.malformedParentSpanId);
			}

			// (g) links on a kind that does not admit them.
			if (!entry.allowsLinks && links.length > 0) {
				violations.push(RELATIONSHIP_VIOLATION_CODES.linksNotAllowed);
			}
		}

		// (h) Link ids must be W3C-shaped regardless of whether the kind is
		// catalogued — a malformed link is unusable to any consumer.
		for (let index = 0; index < links.length; index++) {
			const link = links[index];
			if (link === undefined || link === null) continue;
			if (!TRACE_ID_PATTERN.test(String(link.traceId))) {
				violations.push(
					`${RELATIONSHIP_VIOLATION_CODES.malformedLinkTraceId}:${index}`,
				);
			}
			if (!SPAN_ID_PATTERN.test(String(link.spanId))) {
				violations.push(
					`${RELATIONSHIP_VIOLATION_CODES.malformedLinkSpanId}:${index}`,
				);
			}
		}
	} catch {
		// A structurally broken event still yields a verdict rather than a throw.
		return {
			ok: false,
			violations: [RELATIONSHIP_VIOLATION_CODES.validationFailed],
		};
	}

	return violations.length === 0 ? { ok: true } : { ok: false, violations };
}
