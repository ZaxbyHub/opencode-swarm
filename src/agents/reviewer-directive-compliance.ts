/**
 * Reviewer DIRECTIVE_COMPLIANCE support (Swarm Learning System, Change 2 /
 * Task 2.1).
 *
 * The reviewer must emit a per-ID verdict for every knowledge directive shown
 * during the phase. This module owns:
 *   - DIRECTIVE_COMPLIANCE_OUTPUT_SPEC: the static format documentation embedded
 *     in the reviewer system prompt (always present).
 *   - buildDirectiveComplianceBlock: the dynamic, per-phase list of directive IDs
 *     to verify (with priorities + any verification_predicate), injected into the
 *     reviewer's delegation prompt at runtime.
 *
 * The verdict grammar is intentionally parser-friendly and mirrors the ack
 * markers used elsewhere so a single reviewer-verdict parser can consume it.
 */

import type { DirectivePriority } from '../hooks/knowledge-types.js';

/** Marker tag wrapping the per-phase "directives to verify" block. */
export const DIRECTIVES_TO_VERIFY_TAG = '<directives_to_verify>';

/** A directive the reviewer must produce a verdict for. */
export interface DirectiveToVerify {
	id: string;
	priority: DirectivePriority;
	lesson?: string;
	verification_predicate?: string;
}

/**
 * Static spec embedded in the reviewer system prompt. Documents the mandatory
 * DIRECTIVE_COMPLIANCE output section and its verdict grammar.
 */
export const DIRECTIVE_COMPLIANCE_OUTPUT_SPEC = `DIRECTIVE_COMPLIANCE: one line per knowledge directive shown during this phase (the IDs are listed in the DIRECTIVES TO VERIFY block of your prompt). Use exactly one of:
  VERIFIED:<id> evidence=<file:line | predicate_passed>
  VIOLATED:<id> evidence=<file:line | failing_predicate>
  N/A:<id> reason=<why it does not apply to this change>
Every listed directive ID MUST appear exactly once. If a directive carries a verification_predicate, you MUST run it and report predicate_passed / failing_predicate as the evidence. Omitting a listed directive ID is itself a VIOLATED verdict.`;

const PRIORITY_RANK: Record<DirectivePriority, number> = {
	critical: 0,
	high: 1,
	medium: 2,
	low: 3,
};

/**
 * Render the per-phase "DIRECTIVES TO VERIFY" block injected into the reviewer's
 * delegation prompt. Deterministic (sorted by priority then ID). Returns null
 * when there is nothing to verify (no block emitted).
 */
export function buildDirectiveComplianceBlock(
	directives: DirectiveToVerify[],
): string | null {
	if (directives.length === 0) return null;
	const sorted = [...directives].sort((a, b) => {
		const pr =
			(PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2);
		if (pr !== 0) return pr;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
	const lines: string[] = [];
	lines.push('<directives_to_verify>');
	lines.push(
		'Produce a DIRECTIVE_COMPLIANCE verdict for EVERY id below. Run any verification_predicate provided.',
	);
	for (const d of sorted) {
		lines.push(`- id: ${d.id}`);
		lines.push(`  priority: ${d.priority}`);
		if (d.lesson) lines.push(`  lesson: ${d.lesson}`);
		if (d.verification_predicate) {
			lines.push(`  verification_predicate: ${d.verification_predicate}`);
		}
	}
	lines.push('</directives_to_verify>');
	lines.push('');
	lines.push(DIRECTIVE_COMPLIANCE_OUTPUT_SPEC);
	return lines.join('\n');
}

/**
 * Recover the directives a reviewer was asked to verify by parsing a
 * `<directives_to_verify>` block back out of its delegation prompt. Used by the
 * after-hook so reconciliation honors exactly what was shown (anti-spoofing).
 * Returns [] when no block is present.
 */
export function parseDirectivesToVerifyBlock(
	text: string,
): DirectiveToVerify[] {
	if (!text || !text.includes(DIRECTIVES_TO_VERIFY_TAG)) return [];
	const start = text.indexOf(DIRECTIVES_TO_VERIFY_TAG);
	const end = text.indexOf('</directives_to_verify>', start);
	const body = end >= 0 ? text.slice(start, end) : text.slice(start);
	const out: DirectiveToVerify[] = [];
	for (const line of body.split('\n')) {
		const idM = /^- id:\s*(\S+)\s*$/.exec(line);
		if (idM) {
			out.push({ id: idM[1], priority: 'medium' });
			continue;
		}
		if (out.length === 0) continue;
		const current = out[out.length - 1];
		const prM = /^\s+priority:\s*(low|medium|high|critical)\s*$/.exec(line);
		if (prM) {
			current.priority = prM[1] as DirectivePriority;
			continue;
		}
		const predM = /^\s+verification_predicate:\s*(.+?)\s*$/.exec(line);
		if (predM) {
			current.verification_predicate = predM[1];
			continue;
		}
		const lessonM = /^\s+lesson:\s*(.+?)\s*$/.exec(line);
		if (lessonM) current.lesson = lessonM[1];
	}
	return out;
}
