/**
 * Issue #2279 — recurrence guardrail for the presence-guarded-integrity-check class.
 *
 * THE DEFECT CLASS: a mechanical integrity gate compares a caller-supplied field
 * against an authoritative value, but wraps the comparison in a presence guard
 * (`if (record.field && record.field !== authority.field)`). Absence then means
 * "skip verification" rather than "violation", so any caller can bypass the gate
 * by omitting the field. In #2279 all four severity comparisons in
 * `assertPrReviewArtifactRecordsMatchAuthoritativeVerdicts` had this shape, and
 * the gate's own error message actively instructed callers to exploit it.
 *
 * GUARDRAIL LADDER (AGENTS.md Phase 4.2): a type-level constraint (rung 2) is
 * NOT available here, and the reason is recorded rather than assumed. Making
 * `PrReviewArtifactRecord.severity` non-optional would be the stronger rung, but
 * the same type is the read shape for `findings.jsonl` rows persisted before
 * severity became mandatory, and `readFindings` JSON-parses those rows without
 * re-validating them. A required field in the type would therefore be a lie about
 * data already on disk. A lint rule (rung 1) cannot express "this identifier is
 * an authority" either. So this lands on rung 4: a source-scan CI check, paired
 * with the behavioural coverage in the write-pr-review-artifact suites.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FINDINGS_SEVERITIES } from '../../../src/background/candidate-contract';

const GATE_PATH = path.join(
	import.meta.dir,
	'..',
	'..',
	'..',
	'src',
	'hooks',
	'pr-workflow-gate.ts',
);

const readGateSource = (): string => fs.readFileSync(GATE_PATH, 'utf8');

/** Extract the artifact-verdict validator body by brace matching. */
function extractValidator(source: string): string {
	const marker =
		'export async function assertPrReviewArtifactRecordsMatchAuthoritativeVerdicts(';
	const start = source.indexOf(marker);
	if (start === -1) {
		throw new Error(
			'assertPrReviewArtifactRecordsMatchAuthoritativeVerdicts not found — ' +
				'if it was renamed, update this guardrail rather than deleting it',
		);
	}
	const bodyStart = source.indexOf('{', source.indexOf(')', start));
	let depth = 0;
	for (let i = bodyStart; i < source.length; i++) {
		if (source[i] === '{') depth++;
		else if (source[i] === '}') {
			depth--;
			if (depth === 0) return source.slice(bodyStart, i + 1);
		}
	}
	throw new Error('could not brace-match the validator body');
}

/**
 * Remove block and line comments so a prose scan sees only executable text.
 * Deliberately simple — the validator body contains no comment-like sequences
 * inside string literals, and the brace matcher above would already have failed
 * if the function's shape had changed that much.
 */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('severity-omission bypass cannot return (#2279 recurrence guardrail)', () => {
	test('no presence guard wraps a severity comparison in the validator', () => {
		// Comments stripped: the `reportSeverity` JSDoc deliberately quotes the
		// removed `if (record.severity && …)` shape, and only its leading `*`
		// keeps the pattern below from matching it. A reflow that joined that
		// line would turn this guardrail into a false CI failure.
		const body = stripComments(extractValidator(readGateSource()));

		// `if (record.severity && …)` — the exact shape of the bypass. Also catches
		// the optional-chained and explicit-undefined variants a refactor might
		// reach for.
		const presenceGuards = [
			/if\s*\(\s*record\??\.severity\s*&&/g,
			/if\s*\(\s*record\??\.severity\s*!==?\s*(?:undefined|null)\s*&&/g,
			/if\s*\(\s*typeof\s+record\??\.severity\s*===?\s*'string'\s*&&/g,
			// `if (!record.severity) continue;` skips verification just as
			// effectively as the `&&` form — an early-exit variant of the bypass.
			/if\s*\(\s*!\s*record\??\.severity\s*\)\s*(?:continue|return)/g,
		].flatMap((pattern) => [...body.matchAll(pattern)].map((m) => m[0]));

		expect(presenceGuards).toEqual([]);
	});

	test('the validator never instructs a caller to omit a field', () => {
		// Comments are stripped first: this check is about the REMEDY TEXT the gate
		// hands a caller, not about prose. The code comments deliberately describe
		// the removed omission rule so a future reader knows why it is gone, and
		// that history must not trip the guardrail.
		const body = stripComments(extractValidator(readGateSource()));

		// The pre-#2279 gate told callers `expected NONE (omit field; …)`. Any
		// resurrection of omission-as-a-remedy is the class returning.
		expect(body).not.toContain('omit field');
		expect(body).not.toMatch(/omit(ting)?\s+the\s+(optional\s+)?field/i);
	});

	test('severity is compared through the single unconditional helper', () => {
		const body = stripComments(extractValidator(readGateSource()));

		// Every severity verdict comparison must route through reportSeverity,
		// which compares unconditionally and reports `(omitted)` for an absent
		// value. A hand-rolled `record.severity !== x` comparison outside the
		// helper is how the guard would creep back in one branch at a time.
		const helperDefinition = /const\s+reportSeverity\s*=/;
		expect(body).toMatch(helperDefinition);

		const helperBodyEnd = body.indexOf('};', body.search(helperDefinition));
		const afterHelper = body.slice(helperBodyEnd);
		// Both operand orders and both equality strengths. A reintroduced check
		// written as `reviewer.severity !== record.severity`, or with loose `!=`,
		// is the same defect wearing a different shape.
		const adHocComparisons = [
			...afterHelper.matchAll(/record\.severity\s*(?:!==?|===?)/g),
			...afterHelper.matchAll(/(?:!==?|===?)\s*record\.severity/g),
		].map((match) => match[0].replace(/\s+/g, ' '));

		expect(adHocComparisons).toEqual([]);
	});

	test('FINDINGS_SEVERITIES stays set-equal to the gate REVIEW_SEVERITIES', () => {
		// THE LOAD-BEARING INVARIANT of issue #2279. Requiring `severity` is only
		// safe because every authoritative verdict severity is representable in the
		// findings schema. `REVIEW_SEVERITIES` is module-private, so the two
		// constants cannot be compared by import — but an unpinned invariant is one
		// a future edit silently breaks: adding a member to REVIEW_SEVERITIES would
		// make the gate demand a value `FindingSchema` rejects, i.e. an
		// unsatisfiable gate. Parse it out of the source instead.
		const source = readGateSource();
		const match = source.match(
			/const\s+REVIEW_SEVERITIES\s*=\s*new\s+Set\(\s*\[([\s\S]*?)\]\s*\)/,
		);
		if (!match) {
			throw new Error(
				'REVIEW_SEVERITIES not found — if it was renamed or restructured, update ' +
					'this invariant check rather than deleting it',
			);
		}
		const reviewSeverities = [...match[1].matchAll(/'([A-Z_]+)'/g)].map(
			(entry) => entry[1],
		);

		expect(reviewSeverities.length).toBeGreaterThan(0);
		expect([...reviewSeverities].sort()).toEqual(
			[...FINDINGS_SEVERITIES].sort(),
		);
	});

	test('an omitted severity is reported as a violation, not skipped', () => {
		const body = extractValidator(readGateSource());

		// The remedy text must name what was owed. `(omitted)` is the actual-value
		// rendering that makes the rejection actionable in one round trip.
		expect(body).toContain("'(omitted)'");
	});
});
