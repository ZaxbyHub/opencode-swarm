/**
 * Shared "## Decisions" section extractor for `.swarm/context.md`.
 *
 * Issue #1661 residual, consolidated under #2493 (W9a): four independent
 * parsers of the same section had drifted apart —
 *
 *   - `src/services/decision-drift-analyzer.ts` (line-scan, rich Decision[])
 *   - `src/hooks/extractors.ts` (line-scan, joined/truncated text)
 *   - `src/services/handoff-service.ts` (line-scan, cleaned strings)
 *   - `src/hooks/curator.ts` (inline regex, raw keyDecisions)
 *
 * The three line-scanners already agreed on boundary semantics (exact
 * `## Decisions` header line; section ends at the next `## ` header; a
 * repeated `## Decisions` header re-enters the section instead of ending
 * it because the start check runs before the end check). Only the curator's
 * inline regex diverged: it matched `## Decisions` anywhere in a line
 * (so a prose mention or `### Decisions` started a bogus section) and ended
 * the section at any `\n##` (so a `###` subheading truncated the list).
 *
 * This module is that line-scan, lifted verbatim from the drift analyzer
 * (the richest consumer) and extended with a `raw` field so each consumer
 * can reconstruct its historical output exactly. It imports nothing —
 * keeping it dependency-free makes it safe for both `src/services` and
 * `src/hooks` consumers without import cycles.
 *
 * Consumers map to their own output shapes in-place; per-consumer quirks
 * (indentation intolerance, marker stripping, first-5 vs last-5 windows)
 * live in the consumers, not here.
 */

/**
 * A single decision extracted from the `## Decisions` section of
 * `.swarm/context.md`.
 */
export interface ContextDecision {
	/**
	 * The decision line exactly as it appears in the source file, bullet
	 * prefix (`- `), indentation, confirmation markers and timestamps
	 * preserved. Consumers that historically returned raw text
	 * (hooks/extractors, curator keyDecisions) reconstruct their output
	 * from this; consumers that never needed it ignore it.
	 */
	raw: string;
	/**
	 * Decision text with bracketed markers (timestamps, `[confirmed]`)
	 * removed. The ✅ marker is preserved — it is not bracketed. This is
	 * the drift analyzer's historical `text` semantics.
	 */
	text: string;
	/**
	 * Phase the decision belongs to: an explicit `Phase N` inside the
	 * decision text, else the most recent `## Phase N` heading seen before
	 * the decision, else null.
	 */
	phase: number | null;
	/** Whether the decision carries a confirmation marker (✅ or [confirmed]) */
	confirmed: boolean;
	/** Timestamp parsed from a `[YYYY-MM-DDTHH:MM:SSZ]` marker, else null */
	timestamp: string | null;
	/** 1-based line number of the decision bullet in the source content */
	line: number;
}

/**
 * Extract decisions from `## Decisions` section content.
 *
 * Boundary semantics (strict, shared by every consumer post-#2493):
 * - The section starts at a line whose trimmed content is exactly
 *   `## Decisions` (trailing whitespace / CRLF tolerated).
 * - The section ends at the next line starting with `## ` (a repeated
 *   `## Decisions` header re-enters the section rather than ending it —
 *   the start check precedes the end check, preserving the historical
 *   line-scanner behavior all three scanner consumers shared).
 * - Decision items are lines whose trimmed content starts with `- `
 *   (indentation-tolerant). Consumers with stricter historical item
 *   matching (hooks/extractors required non-indented `- ` lines) filter
 *   on `raw` in their mapping layer.
 */
export function extractContextDecisions(content: string): ContextDecision[] {
	const decisions: ContextDecision[] = [];
	// #2493 review F-12: bound the whole-input split. Context files are
	// human-authored plan markdown (writers bound them far below this); a
	// larger input is treated as pathological and scanned as a capped prefix
	// instead of ballooning into an unbounded line array. The regexes below
	// are linear-time, so the scan itself was never ReDoS-susceptible.
	const MAX_CONTENT_CHARS = 1_000_000;
	const bounded =
		content.length > MAX_CONTENT_CHARS
			? content.slice(0, MAX_CONTENT_CHARS)
			: content;
	const lines = bounded.split('\n');
	let inDecisionsSection = false;
	let currentPhase: number | null = null;
	let lineNumber = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		lineNumber = i + 1;

		// Track current phase
		const phaseMatch = line.match(/^## Phase (\d+)/);
		if (phaseMatch) {
			currentPhase = parseInt(phaseMatch[1], 10);
		}

		// Start of decisions section
		if (line.trim() === '## Decisions') {
			inDecisionsSection = true;
			continue;
		}

		// End of decisions section
		if (inDecisionsSection && line.startsWith('## ')) {
			break;
		}

		// Extract decision items
		if (inDecisionsSection && line.trim().startsWith('- ')) {
			const text = line.trim().substring(2); // Remove "- "
			const confirmed = text.includes('✅') || text.includes('[confirmed]');
			const timestampMatch = text.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]/);
			const timestamp = timestampMatch ? timestampMatch[1] : null;

			// Extract phase from decision if present
			const decisionPhaseMatch = text.match(/Phase (\d+)/);
			const decisionPhase = decisionPhaseMatch
				? parseInt(decisionPhaseMatch[1], 10)
				: currentPhase;

			decisions.push({
				raw: line,
				text: text.replace(/\s*\[.*?\]\s*/g, '').trim(), // Remove timestamp/confirm markers
				phase: decisionPhase,
				confirmed,
				timestamp,
				line: lineNumber,
			});
		}
	}

	return decisions;
}
