/**
 * Discovery-artifact salvage (issue: PR-review workflow could not complete).
 *
 * A lane's findings used to be discarded wholesale when its output was merely
 * mis-presented — a missing canonical header, or one malformed row beside valid
 * ones. Measured on PR #2090: 14 lanes failed, 59 findings were thrown away, and
 * none of the failures were analysis failures.
 *
 * Kept in a dedicated file because the sibling gate suites are close to the
 * FR-006 500-line cap (scripts/check-test-file-cap.sh).
 */
import { describe, expect, test } from 'bun:test';
import {
	analyzeCleanFields,
	CANDIDATE_HEADERS,
	normalizeCandidateArtifact,
	splitPipeFields,
} from '../../../src/background/candidate-contract.js';
import {
	_test_exports,
	prReviewDiscoveryArtifactCoversLane,
} from '../../../src/hooks/pr-workflow-gate.js';
import { EXPLORER_CANDIDATE_FORMAT_SUFFIX } from '../../../src/tools/dispatch-lanes.js';

const { extractCandidateIds, resolvePrReviewRowFamily } = _test_exports;

const BASE_HEADER = CANDIDATE_HEADERS.base_explorer;
const MICRO_HEADER = CANDIDATE_HEADERS.micro_lane;
const BASE_LANE = 'correctness-state';
const MICRO_LANE = 'concurrency-state';

const baseRow = (id: string, lane = BASE_LANE) =>
	`[CANDIDATE] | ${id} | ${lane} | HIGH | correctness | src/a.ts:1 | claim | evidence | impact | HIGH`;
const microRow = (id: string, lane = MICRO_LANE) =>
	`[CANDIDATE] | ${id} | ${lane} | HIGH | concurrency | src/a.ts:1 | claim | invariant | evidence | HIGH`;

describe('discovery artifact salvage', () => {
	test('repairs an absent header and reports the repair', () => {
		const text = `some prose the explorer wrote first\n${baseRow('C-1')}`;
		const normalized = normalizeCandidateArtifact(text, 'base_explorer');
		expect(normalized.synthesizedHeader).toBe(true);
		// The header is inserted immediately before the first salvageable row, not
		// at the top: prepending would push the explorer's leading prose below the
		// header, where every prose line counts as a malformed row.
		expect(normalized.text.split('\n')).toEqual([
			'some prose the explorer wrote first',
			BASE_HEADER,
			baseRow('C-1'),
		]);
		expect(prReviewDiscoveryArtifactCoversLane(text, BASE_LANE)).toBe(true);
	});

	test('repairs a headerless zero-findings CLEAN attestation', () => {
		// The shape that blocked the real PR #2090 run for three consecutive
		// attempts: a lane that correctly found nothing, wrote a well-formed
		// lane-bound CLEAN, and omitted only the canonical header. One unresolved
		// micro source fails the entire workflow, so this single lane was the
		// terminal blocker.
		const clean = `[CLEAN] | ${MICRO_LANE} | all changed concurrency paths | no candidate survived caller and sibling checks`;
		const text = `analysis prose from the lane\n${clean}`;
		const normalized = normalizeCandidateArtifact(text, 'micro_lane');
		expect(normalized.synthesizedHeader).toBe(true);
		expect(prReviewDiscoveryArtifactCoversLane(text, MICRO_LANE)).toBe(true);
		// A CLEAN lane legitimately contributes zero candidate ids.
		expect(extractCandidateIds(text, 'micro_lane', [MICRO_LANE])).toEqual([]);
	});

	test('does not repair a CLEAN attestation bound to a different lane', () => {
		const clean = `[CLEAN] | ${MICRO_LANE} | all changed concurrency paths | no candidate survived caller and sibling checks`;
		expect(
			prReviewDiscoveryArtifactCoversLane(clean, 'privacy-observability'),
		).toBe(false);
	});

	test('refuses to repair when no marker-bearing row is valid', () => {
		const text = 'prose only, no rows at all';
		expect(
			normalizeCandidateArtifact(text, 'base_explorer').synthesizedHeader,
		).toBe(false);
		expect(prReviewDiscoveryArtifactCoversLane(text, BASE_LANE)).toBe(false);
	});

	test('leaves a declared other-family header alone so family mismatch still fires', () => {
		// A micro lane that declared the base family must not be silently promoted
		// into the micro family by header synthesis.
		const text = `${BASE_HEADER}\n${microRow('M-1')}`;
		expect(
			normalizeCandidateArtifact(text, 'micro_lane').synthesizedHeader,
		).toBe(false);
		expect(prReviewDiscoveryArtifactCoversLane(text, MICRO_LANE)).toBe(false);
	});

	test('does not let a later canonical header rescue a malformed first marker', () => {
		const text = `[CANDIDATE] | not | a | header\n${BASE_HEADER}\n${baseRow('C-1')}`;
		expect(
			normalizeCandidateArtifact(text, 'base_explorer').synthesizedHeader,
		).toBe(false);
		expect(prReviewDiscoveryArtifactCoversLane(text, BASE_LANE)).toBe(false);
	});

	test('honours the family a fenced header declared, even though the fence deleted it', () => {
		// Fence-stripping removes the header before it can be read, so the family it
		// declared is recovered from the pre-strip source. A DIFFERENT family must
		// still fail closed.
		const conflicting = `\`\`\`text\n${BASE_HEADER}\n\`\`\`\n${microRow('M-1')}`;
		expect(
			normalizeCandidateArtifact(conflicting, 'micro_lane').synthesizedHeader,
		).toBe(false);
		expect(prReviewDiscoveryArtifactCoversLane(conflicting, MICRO_LANE)).toBe(
			false,
		);

		// The SAME family declares nothing in conflict, so refusing would discard
		// the lane's findings for no reason.
		const agreeing = `\`\`\`text\n${MICRO_HEADER}\n\`\`\`\n${microRow('M-1')}`;
		expect(
			normalizeCandidateArtifact(agreeing, 'micro_lane').synthesizedHeader,
		).toBe(true);
		expect(prReviewDiscoveryArtifactCoversLane(agreeing, MICRO_LANE)).toBe(
			true,
		);
	});

	test('retains valid rows when another row is malformed', () => {
		const text = [
			BASE_HEADER,
			baseRow('C-GOOD'),
			`[CANDIDATE] | C-BAD | ${BASE_LANE} | NOT_A_SEVERITY | correctness | src/a.ts:2 | claim | evidence | impact | HIGH`,
		].join('\n');
		expect(prReviewDiscoveryArtifactCoversLane(text, BASE_LANE)).toBe(true);
		expect(extractCandidateIds(text, 'base_explorer', [BASE_LANE])).toEqual([
			'C-GOOD',
		]);
	});

	test('never salvages duplicate candidate ids', () => {
		// The inventory these feed is asserted globally unique, so admitting them
		// would convert a lane defect into a late workflow-wide failure.
		const text = [BASE_HEADER, baseRow('C-DUP'), baseRow('C-DUP')].join('\n');
		expect(prReviewDiscoveryArtifactCoversLane(text, BASE_LANE)).toBe(false);
	});

	test('never salvages an id reused across an owned and a foreign row', () => {
		// Regression: the duplicate check once read the parser's diagnostics, but a
		// foreign-lane row is dropped before the parser's duplicate detector runs,
		// so no duplicate diagnostic existed — while extraction (deliberately
		// unscoped) kept BOTH rows and the id collision surfaced later as a
		// workflow-wide BLOCKED throw. The check must see what extraction sees.
		const text = [
			BASE_HEADER,
			baseRow('C-DUP'),
			baseRow('C-DUP', 'security-trust'),
		].join('\n');
		// Unscoped extraction is the production shape for full-ownership sources.
		expect(extractCandidateIds(text, 'base_explorer')).toEqual([
			'C-DUP',
			'C-DUP',
		]);
		expect(prReviewDiscoveryArtifactCoversLane(text, BASE_LANE)).toBe(false);
	});

	test('retains candidates when the CLEAN attestation is defective', () => {
		// A CLEAN row carrying a fourth field discredits the attestation, not the
		// findings beside it.
		const text = [
			MICRO_HEADER,
			microRow('M-1'),
			`[CLEAN] | ${MICRO_LANE} | coverage scope text | evidence text that is long enough | MEDIUM`,
		].join('\n');
		expect(prReviewDiscoveryArtifactCoversLane(text, MICRO_LANE)).toBe(true);
		expect(extractCandidateIds(text, 'micro_lane', [MICRO_LANE])).toEqual([
			'M-1',
		]);
	});
});

describe('coverage and inventory cannot disagree (recurrence guardrail)', () => {
	// The defect this pins: coverage validation and candidate-id extraction were
	// two separate parses of the same artifact under different rules, so a lane
	// could be judged "covered" while contributing zero findings — which would
	// have shipped a green review reporting nothing on a PR full of findings.
	const permutations: ReadonlyArray<readonly [string, string, string]> = [
		['canonical', BASE_LANE, `${BASE_HEADER}\n${baseRow('C-1')}`],
		['no header', BASE_LANE, baseRow('C-1')],
		['prose then rows', BASE_LANE, `analysis prose\n${baseRow('C-1')}`],
		[
			'valid plus malformed',
			BASE_LANE,
			`${BASE_HEADER}\n${baseRow('C-1')}\n[CANDIDATE] | C-2 | ${BASE_LANE} | BAD | c | src/a.ts:2 | x | y | z | HIGH`,
		],
		[
			'valid plus stray pipe row',
			BASE_LANE,
			`${BASE_HEADER}\n${baseRow('C-1')}\n[CANDIDATE] | C-3 | ${BASE_LANE} | HIGH | c | src/a.ts:3 | has | pipe | in | prose | HIGH`,
		],
		[
			'foreign lane row',
			BASE_LANE,
			`${BASE_HEADER}\n${baseRow('C-1')}\n${baseRow('C-F', 'security-trust')}`,
		],
		[
			'duplicate ids',
			BASE_LANE,
			`${BASE_HEADER}\n${baseRow('C-1')}\n${baseRow('C-1')}`,
		],
		['wrong family header', MICRO_LANE, `${BASE_HEADER}\n${microRow('M-1')}`],
		['micro no header', MICRO_LANE, microRow('M-1')],
		[
			'markerless only',
			BASE_LANE,
			`C-1 | ${BASE_LANE} | HIGH | c | src/a.ts:1 | x | y | z | HIGH`,
		],
		['empty', BASE_LANE, ''],
		[
			'headerless malformed row before a valid one',
			BASE_LANE,
			`[CANDIDATE] | C-BAD | ${BASE_LANE} | HIGH | c | src/a.ts:1 | has | a | stray | pipe | HIGH\n${baseRow('C-OK')}`,
		],
		[
			'headerless CLEAN',
			MICRO_LANE,
			`[CLEAN] | ${MICRO_LANE} | all changed concurrency paths | no candidate survived caller and sibling checks`,
		],
	];

	for (const [name, lane, text] of permutations) {
		test(`covered implies extractable findings — ${name}`, () => {
			const covered = prReviewDiscoveryArtifactCoversLane(text, lane);
			const ids = extractCandidateIds(text, resolvePrReviewRowFamily(lane), [
				lane,
			]);
			// A CLEAN-attested lane legitimately yields zero ids — that is what a
			// zero-findings attestation means — so the invariant is
			// `covered ∧ ¬cleanAttested ⟹ ids > 0`. The exemption is derived from a
			// VALIDATED, lane-matching attestation rather than any line that merely
			// starts with the marker: a syntactic check would let a contrived
			// fixture carrying a malformed [CLEAN] exempt itself and silently
			// weaken the table.
			const cleanAttested = text.split('\n').some((line) => {
				const fields = splitPipeFields(line.trim()).map((f) => f.trim());
				if (fields[0] !== '[CLEAN]') return false;
				return analyzeCleanFields(fields, resolvePrReviewRowFamily(lane), lane)
					.valid;
			});
			if (covered && !cleanAttested) expect(ids.length).toBeGreaterThan(0);
		});
	}

	test('a defective CLEAN no longer discards the candidate rows beside it', () => {
		// Pins the shared parser's acceptance behaviour through the gate boundary
		// (coverage + id extraction) rather than by calling parseCandidates itself,
		// so it exercises the path production uses. A CLEAN row carrying an extra
		// confidence field discredits the attestation; the independently validated
		// candidate row beside it must survive. Reverting
		// `acceptedCandidates = candidates` in candidate-parser.ts fails this.
		const text = [
			BASE_HEADER,
			baseRow('C-KEEP'),
			`[CLEAN] | ${BASE_LANE} | all changed correctness paths | no candidate survived caller checks | HIGH`,
		].join('\n');
		expect(prReviewDiscoveryArtifactCoversLane(text, BASE_LANE)).toBe(true);
		expect(extractCandidateIds(text, 'base_explorer', [BASE_LANE])).toEqual([
			'C-KEEP',
		]);
	});

	test('a headerless CLEAN covers its lane while contributing no ids', () => {
		// The newly-reachable branch: covered with an empty inventory. Pinned so a
		// future change that makes a CLEAN silently stop attesting is caught.
		const text = `[CLEAN] | ${MICRO_LANE} | all changed concurrency paths | no candidate survived caller and sibling checks`;
		expect(prReviewDiscoveryArtifactCoversLane(text, MICRO_LANE)).toBe(true);
		expect(extractCandidateIds(text, 'micro_lane', [MICRO_LANE])).toEqual([]);
	});

	test('salvages a valid row that sits behind a malformed marker line', () => {
		// Regression for the insertion-point choice: the header must go ABOVE the
		// first marker-bearing line, not above the first VALID one. Otherwise the
		// malformed marker stays authoritative and the whole artifact fails —
		// exactly where headerless and unescaped-pipe failures overlap.
		const text = `[CANDIDATE] | C-BAD | ${BASE_LANE} | HIGH | c | src/a.ts:1 | has | a | stray | pipe | HIGH\n${baseRow('C-OK')}`;
		expect(prReviewDiscoveryArtifactCoversLane(text, BASE_LANE)).toBe(true);
		expect(extractCandidateIds(text, 'base_explorer', [BASE_LANE])).toEqual([
			'C-OK',
		]);
	});

	test('both call sites derive the same row family for a lane', () => {
		expect(resolvePrReviewRowFamily(BASE_LANE)).toBe('base_explorer');
		expect(resolvePrReviewRowFamily(MICRO_LANE)).toBe('micro_lane');
	});

	test('a council lane named after a base dimension still resolves micro (M1)', () => {
		// Regression for the last coverage/extraction divergence. Council lanes emit
		// the MICRO row family whatever they are called, so a council lane labelled
		// with a base dimension id must not resolve base_explorer at the coverage
		// site while the extraction site resolves micro_lane — that mismatch let a
		// lane be judged covered while contributing nothing to the inventory.
		expect(resolvePrReviewRowFamily(BASE_LANE, 'swarm-pr-review:council')).toBe(
			'micro_lane',
		);
		// Mode is authoritative over the lane label in both directions.
		expect(resolvePrReviewRowFamily(MICRO_LANE, 'swarm-pr-review:base')).toBe(
			'base_explorer',
		);
		// A micro-family artifact from a council lane named after a base dimension
		// is now accepted, because coverage resolves the same family extraction will.
		const text = microRow('M-1', BASE_LANE);
		expect(
			prReviewDiscoveryArtifactCoversLane(
				text,
				BASE_LANE,
				[BASE_LANE],
				'swarm-pr-review:council',
			),
		).toBe(true);
		expect(extractCandidateIds(text, 'micro_lane', [BASE_LANE])).toEqual([
			'M-1',
		]);
	});

	test('resolves the dispatch-mode fallback the way each mode actually emits rows', () => {
		// Sources without a workflowLane carry only a dispatch laneId, which is not
		// a dimension id. The fallback must follow the dispatch output contract:
		// council lanes emit the MICRO row family, not the base one. Getting this
		// wrong re-opens the coverage/extraction split for council lanes.
		expect(resolvePrReviewRowFamily(undefined, 'swarm-pr-review:base')).toBe(
			'base_explorer',
		);
		expect(resolvePrReviewRowFamily(undefined, 'swarm-pr-review:micro')).toBe(
			'micro_lane',
		);
		expect(resolvePrReviewRowFamily(undefined, 'swarm-pr-review:council')).toBe(
			'micro_lane',
		);
	});
});

describe('explorer output contract as rendered', () => {
	test('teaches escaping with a real backslash, not a dropped one', () => {
		// `\|` in a template literal renders as a bare `|` — which would instruct
		// lanes to emit precisely the character that splits a row into an extra
		// field. This asserts the RENDERED string, which is what lanes receive.
		expect(EXPLORER_CANDIDATE_FORMAT_SUFFIX).toContain('\\|');
	});

	test('leads with the canonical header and a worked example', () => {
		const headerIndex = EXPLORER_CANDIDATE_FORMAT_SUFFIX.indexOf(BASE_HEADER);
		expect(headerIndex).toBeGreaterThan(-1);
		expect(EXPLORER_CANDIDATE_FORMAT_SUFFIX).toContain('WORKED EXAMPLE');
		// The worked example must precede the per-family reference blocks, because
		// a header restated only as a format spec was measured at ~1/6 compliance.
		expect(
			EXPLORER_CANDIDATE_FORMAT_SUFFIX.indexOf('WORKED EXAMPLE'),
		).toBeLessThan(
			EXPLORER_CANDIDATE_FORMAT_SUFFIX.indexOf('Micro-lane format'),
		);
	});

	test('states the CLEAN row shape and its zero-findings-only rule', () => {
		expect(EXPLORER_CANDIDATE_FORMAT_SUFFIX).toContain('NO\nconfidence field');
		expect(EXPLORER_CANDIDATE_FORMAT_SUFFIX).toContain('never alongside');
	});
});
