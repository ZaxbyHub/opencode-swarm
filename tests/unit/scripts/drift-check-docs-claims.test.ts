import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectDocsClaimDrift } from '../../../scripts/drift-check.ts';
import { QA_GATE_PIPELINE_STEP_COUNT } from '../../../src/config/qa-gate-pipeline';
import { MAX_LANES } from '../../../src/tools/dispatch-lanes';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// Docs numeric-claim detector tests (issue #1497 docs-claim category and
// issue #1645 lane-cap citations), split from drift-check.test.ts to stay
// under the FR-006 500-line test file cap. Numeric expectations interpolate
// the exported source constants so the fixtures exercise the real registry
// values, not hand-copied numbers.

const tempRoots: string[] = [];

function makeTempRoot(): string {
	const root = canonicalMkdtemp('drift-check-test-');
	tempRoots.push(root);
	return root;
}

function writeFile(root: string, relativePath: string, contents: string): void {
	const full = path.join(root, relativePath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, contents, 'utf-8');
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) fs.rmSync(root, { recursive: true, force: true });
	}
});

// Files pinned by the docs-claim detector (QA-gate counts + issue #1645
// lane-cap citations). Every synthetic fixture root must provide all of them,
// so baseline detectors stay silent and only the asserted findings surface.
// Lane numbers interpolate MAX_LANES imported from the tool source so the
// fixtures exercise the real exported constant, not a hand-copied 8.
const LANE_CAP_CLAIM_FILES: Record<string, string> = {
	'.opencode/skills/pre-phase-briefing/SKILL.md': `Large surface: dispatch cap of ${MAX_LANES} lanes per batch.\n`,
	'.claude/skills/pre-phase-briefing/SKILL.md': `Large surface: dispatch cap of ${MAX_LANES} lanes per batch.\n`,
	'.opencode/skills/swarm-pr-review/SKILL.md':
		`Base: dispatch_lanes_async accepts a maximum of ${MAX_LANES} lanes per call.\n` +
		`Micro: the dispatcher accepts at most ${MAX_LANES} lanes per call.\n`,
	'.opencode/skills/swarm-pr-feedback/SKILL.md': `Cap each batch at ${MAX_LANES} lanes (\`MAX_LANES\`); the ledger needs more than ${MAX_LANES} verification lanes.\n`,
	'.opencode/skills/codebase-review-swarm/references/review-protocol-v8.2.md': `Concurrency capped at 2 rather than scaled toward the ${MAX_LANES}-lane dispatch limit.\n`,
	'docs/architecture.md': `Lanes scaled to surface size up to the ${MAX_LANES}-lane cap.\n`,
};

const QA_GATE_CLAIM_FILES: Record<string, string> = {
	'docs/planning.md': `- Each task runs through a full ${QA_GATE_PIPELINE_STEP_COUNT}-step QA gate\n`,
	'docs/swarm-briefing.md': `After every task a ${QA_GATE_PIPELINE_STEP_COUNT}-step QA gate verifies quality.\n\n## Pipeline (${QA_GATE_PIPELINE_STEP_COUNT} Steps)\n`,
};

/** Writes every file the docs-claim detector pins, with optional overrides. */
function writeDocsClaimFixture(
	root: string,
	overrides: Partial<Record<string, string>> = {},
): void {
	const files = {
		...QA_GATE_CLAIM_FILES,
		...LANE_CAP_CLAIM_FILES,
		...overrides,
	};
	for (const [relative, contents] of Object.entries(files)) {
		writeFile(root, relative, contents);
	}
}

describe('drift-check: docs numeric claim detection', () => {
	test('detects a QA gate step-count claim that drifted from the source registry', () => {
		const root = makeTempRoot();
		const stale = String(QA_GATE_PIPELINE_STEP_COUNT - 1);
		// Lane-cap files are provided at matching values; only the planning.md
		// QA-gate claim drifts, so exactly one finding is expected.
		writeDocsClaimFixture(root, {
			'docs/planning.md': `- Each task runs through a full ${stale}-step QA gate\n`,
		});

		const findings = detectDocsClaimDrift(root);
		expect(findings).toHaveLength(1);
		const hit = findings.find(
			(f) =>
				f.category === 'docs-claim' &&
				f.file === 'docs/planning.md' &&
				f.message.includes(`says ${stale}`) &&
				f.message.includes(
					`QA_GATE_PIPELINE_STEPS has ${QA_GATE_PIPELINE_STEP_COUNT}`,
				),
		);
		expect(hit).toBeDefined();
	});

	test('detects a missing claimed file as an error', () => {
		const root = makeTempRoot();
		// Provide every pinned file EXCEPT docs/planning.md.
		const { ['docs/planning.md']: _omitted, ...rest } = {
			...QA_GATE_CLAIM_FILES,
			...LANE_CAP_CLAIM_FILES,
		};
		for (const [relative, contents] of Object.entries(rest)) {
			writeFile(root, relative, contents);
		}

		const findings = detectDocsClaimDrift(root);
		const hit = findings.find(
			(f) =>
				f.severity === 'error' &&
				f.category === 'docs-claim' &&
				f.file === 'docs/planning.md' &&
				f.message.toLowerCase().includes('missing'),
		);
		expect(hit).toBeDefined();
	});

	test('detects a file whose content does not match the expected numeric regex as a warning', () => {
		const root = makeTempRoot();
		// planning.md exists but does NOT contain the /full\s+(\d+)-step\s+QA gate/i pattern
		writeDocsClaimFixture(root, {
			'docs/planning.md': 'No steps here in the planning doc.\n',
		});

		const findings = detectDocsClaimDrift(root);
		const hit = findings.find(
			(f) =>
				f.severity === 'warning' &&
				f.category === 'docs-claim' &&
				f.file === 'docs/planning.md' &&
				f.message.toLowerCase().includes('missing numeric claim'),
		);
		expect(hit).toBeDefined();
	});
});

describe('drift-check: dispatch-lane MAX_LANES prose citations (issue #1645)', () => {
	test('all pinned lane-cap citations match the exported MAX_LANES', () => {
		const root = makeTempRoot();
		writeDocsClaimFixture(root);
		expect(detectDocsClaimDrift(root)).toEqual([]);
	});

	test('flags a skill whose pinned lane-cap citation diverges from MAX_LANES', () => {
		const root = makeTempRoot();
		const wrong = String(MAX_LANES + 1);
		writeDocsClaimFixture(root, {
			'.opencode/skills/swarm-pr-review/SKILL.md':
				`Base: dispatch_lanes_async accepts a maximum of ${wrong} lanes per call.\n` +
				`Micro: the dispatcher accepts at most eight lanes per call.\n`,
		});

		const findings = detectDocsClaimDrift(root);
		const hit = findings.find(
			(f) =>
				f.category === 'docs-claim' &&
				f.file === '.opencode/skills/swarm-pr-review/SKILL.md' &&
				f.message.includes(`says ${wrong}`) &&
				f.message.includes('MAX_LANES has'),
		);
		expect(hit).toBeDefined();
	});

	test('the spelled-out "eight" micro-lane citation parses rather than reading as missing', () => {
		const root = makeTempRoot();
		writeDocsClaimFixture(root, {
			'.opencode/skills/swarm-pr-review/SKILL.md':
				`Base: dispatch_lanes_async accepts a maximum of ${MAX_LANES} lanes per call.\n` +
				`Micro: the dispatcher accepts at most eight lanes per call.\n`,
		});

		// The real constant is 8 today, so a correct "eight" must be silent —
		// in particular it must NOT surface as a "missing numeric claim"
		// warning the way a reworded sentence would.
		const findings = detectDocsClaimDrift(root);
		const missing = findings.find(
			(f) =>
				f.category === 'docs-claim' &&
				f.file === '.opencode/skills/swarm-pr-review/SKILL.md' &&
				f.message.toLowerCase().includes('missing numeric claim'),
		);
		expect(missing).toBeUndefined();
		expect(findings).toEqual([]);
	});

	test('flags the .claude mirror copy independently of .opencode', () => {
		const root = makeTempRoot();
		const wrong = String(MAX_LANES + 1);
		writeDocsClaimFixture(root, {
			'.claude/skills/pre-phase-briefing/SKILL.md': `Large surface: dispatch cap of ${wrong} lanes per batch.\n`,
		});

		const findings = detectDocsClaimDrift(root);
		const hit = findings.find(
			(f) =>
				f.category === 'docs-claim' &&
				f.file === '.claude/skills/pre-phase-briefing/SKILL.md' &&
				f.message.includes(`says ${wrong}`),
		);
		expect(hit).toBeDefined();
	});

	test('flags a pending release fragment whose lane-cap citation diverges', () => {
		const root = makeTempRoot();
		const wrong = String(MAX_LANES + 1);
		writeDocsClaimFixture(root);
		writeFile(
			root,
			'docs/releases/pending/fixture-lane-cap-fragment.md',
			`What changed: the batch cap is now ${wrong} lanes per call.\n`,
		);

		const findings = detectDocsClaimDrift(root);
		const hit = findings.find(
			(f) =>
				f.category === 'docs-claim' &&
				f.file === 'docs/releases/pending/fixture-lane-cap-fragment.md' &&
				f.message.includes(`says ${wrong}`) &&
				f.message.includes('MAX_LANES has'),
		);
		expect(hit).toBeDefined();
	});

	test('a correct pending release fragment stays silent (no false positive)', () => {
		const root = makeTempRoot();
		writeDocsClaimFixture(root);
		writeFile(
			root,
			'docs/releases/pending/fixture-lane-cap-fragment.md',
			`What changed: caps batches at ${MAX_LANES} lanes per call (MAX_LANES=${MAX_LANES}).\n`,
		);

		expect(detectDocsClaimDrift(root)).toEqual([]);
	});

	test('a fragment citing the cap with two different wrong numbers yields two findings', () => {
		const root = makeTempRoot();
		const wrong = String(MAX_LANES + 1);
		const wrong2 = String(MAX_LANES + 2);
		writeDocsClaimFixture(root);
		writeFile(
			root,
			'docs/releases/pending/fixture-lane-cap-fragment.md',
			`Caps at ${wrong} lanes per call, i.e. the ${wrong2}-lane dispatch limit.\n`,
		);

		const findings = detectDocsClaimDrift(root).filter(
			(f) => f.file === 'docs/releases/pending/fixture-lane-cap-fragment.md',
		);
		expect(findings).toHaveLength(2);
		expect(findings.every((f) => f.severity === 'warning')).toBe(true);
	});

	test('a stale second occurrence of the same phrasing is still flagged', () => {
		const root = makeTempRoot();
		const wrong = String(MAX_LANES + 1);
		writeDocsClaimFixture(root);
		writeFile(
			root,
			'docs/releases/pending/fixture-lane-cap-fragment.md',
			`First: caps batches at ${MAX_LANES} lanes per call. Stale copy: caps batches at ${wrong} lanes per call.\n`,
		);

		// Regression (issue #1645 review): the same phrasing appearing twice —
		// first at the correct value, then stale — must still be caught. A
		// first-match-only scan sees the correct occurrence and misses the
		// stale one entirely.
		const findings = detectDocsClaimDrift(root).filter(
			(f) => f.file === 'docs/releases/pending/fixture-lane-cap-fragment.md',
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.message).toContain(`says ${wrong}`);
	});

	test('overlapping phrasings at one wrong number collapse to a single finding', () => {
		const root = makeTempRoot();
		const wrong = String(MAX_LANES + 1);
		writeDocsClaimFixture(root);
		writeFile(
			root,
			'docs/releases/pending/fixture-lane-cap-fragment.md',
			`The batch cap is now ${wrong} lanes per call (MAX_LANES=${wrong}).\n`,
		);

		// "99 lanes per call" and "MAX_LANES=99" are two regex hits on the
		// same wrong number in one sentence; the per-(file, number) dedupe
		// surfaces it exactly once instead of twice.
		const findings = detectDocsClaimDrift(root).filter(
			(f) => f.file === 'docs/releases/pending/fixture-lane-cap-fragment.md',
		);
		expect(findings).toHaveLength(1);
		expect(findings.every((f) => f.severity === 'warning')).toBe(true);
	});

	test('non-markdown files and subdirectories under pending are ignored', () => {
		const root = makeTempRoot();
		const wrong = String(MAX_LANES + 1);
		writeDocsClaimFixture(root);
		// A .txt fragment and a nested subdirectory must both be skipped:
		// only top-level *.md files in docs/releases/pending are scanned.
		writeFile(
			root,
			'docs/releases/pending/notes.txt',
			`Stale: caps at ${wrong} lanes per call.\n`,
		);
		writeFile(
			root,
			'docs/releases/pending/nested/fragment.md',
			`Stale: caps at ${wrong} lanes per call.\n`,
		);

		expect(detectDocsClaimDrift(root)).toEqual([]);
	});

	test('a missing pinned lane-cap skill file is an error', () => {
		const root = makeTempRoot();
		writeDocsClaimFixture(root);
		// Remove one pinned file to simulate deletion without contract update.
		fs.rmSync(path.join(root, '.opencode/skills/pre-phase-briefing/SKILL.md'));

		const findings = detectDocsClaimDrift(root);
		const hit = findings.find(
			(f) =>
				f.severity === 'error' &&
				f.file === '.opencode/skills/pre-phase-briefing/SKILL.md' &&
				f.message.toLowerCase().includes('missing'),
		);
		expect(hit).toBeDefined();
		// The .claude mirror entry for the same slug still parses fine.
		expect(
			findings.some(
				(f) => f.file === '.claude/skills/pre-phase-briefing/SKILL.md',
			),
		).toBe(false);
	});

	test('an absent docs/releases/pending directory is not drift', () => {
		const root = makeTempRoot();
		// writeDocsClaimFixture does NOT create docs/releases/pending.
		writeDocsClaimFixture(root);
		expect(detectDocsClaimDrift(root)).toEqual([]);
	});
});
