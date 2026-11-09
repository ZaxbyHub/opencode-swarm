// Issue #3358 (trace AC8, issue AC7) — a critic lane's reviewer-severity
// annotation must render on its own line, never decorating the
// assigned_item_ids token.
//
// Today applyPrWorkflowPromptContract renders `assigned_item_ids: c1 (HIGH)`:
// the severity rides on the id token the transport uses as its join key, so a
// model copying the decorated token verbatim emits a verdict row whose id is
// `c1 (HIGH)` and the lane is voided as an unassigned id. The fix renders the
// assigned_item_ids line with BARE ids only, and each severity on its own
// separate line pairing the id with its severity.
//
// Pins:
//   1. (discriminating) with reviewerSeverities supplied, the
//      assigned_item_ids line lists bare ids (no parenthesised decoration on
//      the id token), and each id+severity pairing renders on a line OTHER
//      than the assigned_item_ids line — one distinct pairing line per item.
//   2. (preserving) with reviewerSeverities absent, the assigned_item_ids line
//      keeps the plain bare-id byte shape (backward compatibility of the
//      option's absent case).
//
// RED at base, GREEN after the fix.
import { describe, expect, test } from 'bun:test';
import { _test_exports } from '../../../src/tools/dispatch-lanes.js';

type ContractOptions = Parameters<
	typeof _test_exports.applyPrWorkflowPromptContract
>[1];
type ContractLane = Parameters<
	typeof _test_exports.applyPrWorkflowPromptContract
>[0][number];

// Distinctive ids that appear nowhere in the static contract card examples
// (the card uses C-1-style example ids), so line-level assertions cannot be
// satisfied accidentally by card documentation text.
const criticLane: ContractLane = {
	id: 'critic-sev-own-line-3358',
	agent: 'critic',
	prompt: 'Caller-authored critic prompt',
	workflow_lane: 'critic-chunk-1',
	review_item_ids: ['zz9a', 'zz9b'],
};

const criticOptions = (extra: Record<string, unknown> = {}): ContractOptions =>
	({
		mode: 'swarm-pr-review:critic',
		prHeadSha: 'abc123',
		revisionDigest: 'revision-1',
		...extra,
	}) as ContractOptions;

function composedLines(options: ContractOptions): string[] {
	const result = _test_exports.applyPrWorkflowPromptContract(
		[criticLane],
		options,
	);
	if (!result.ok) {
		throw new Error(`contract rejected: ${result.errors.join('; ')}`);
	}
	const prompt = result.lanes[0]?.prompt ?? '';
	if (prompt === '') throw new Error('contract returned no prompt');
	return prompt.split(/\r?\n/);
}

function assignedItemIdsLine(lines: string[]): string {
	const line = lines.find((candidate) =>
		candidate.startsWith('assigned_item_ids:'),
	);
	if (line === undefined) {
		throw new Error('no assigned_item_ids line in composed prompt');
	}
	return line;
}

function severityPairingLine(
	lines: string[],
	exclude: string,
	itemId: string,
	severity: string,
): string | undefined {
	return lines.find(
		(candidate) =>
			candidate !== exclude &&
			candidate.includes(itemId) &&
			candidate.includes(severity),
	);
}

describe('critic-lane severity rendering on its own line (issue #3358 trace AC8)', () => {
	test('assigned_item_ids lists bare ids; each severity pairs with its id on a separate line', () => {
		const lines = composedLines(
			criticOptions({ reviewerSeverities: { zz9a: 'HIGH', zz9b: 'LOW' } }),
		);
		const assignedLine = assignedItemIdsLine(lines);

		// The assigned_item_ids line carries BARE id tokens only — no
		// parenthesised severity decoration on the id token.
		const idTokens = assignedLine
			.slice('assigned_item_ids:'.length)
			.split(',')
			.map((token) => token.trim());
		expect(idTokens).toEqual(['zz9a', 'zz9b']);
		expect(assignedLine.includes('(')).toBe(false);

		// Each severity renders on a line of its own, pairing the id with its
		// severity — never on the assigned_item_ids line.
		const highLine = severityPairingLine(lines, assignedLine, 'zz9a', 'HIGH');
		const lowLine = severityPairingLine(lines, assignedLine, 'zz9b', 'LOW');
		expect(highLine).toBeDefined();
		expect(lowLine).toBeDefined();
		// "Each severity on a separate line": the two pairings are distinct
		// lines, not one combined line.
		expect(highLine).not.toBe(lowLine);
	});

	test('preserving: absent reviewerSeverities keeps the bare-id assigned_item_ids byte shape', () => {
		const lines = composedLines(criticOptions());
		expect(assignedItemIdsLine(lines)).toBe('assigned_item_ids: zz9a, zz9b');
	});
});
