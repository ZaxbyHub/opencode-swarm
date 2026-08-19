import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	annotation,
	buildReport,
	type DriftFinding,
	detectAgentDrift,
	detectBundledSkillDrift,
	detectCommandDrift,
	detectDocsClaimDrift,
	detectSkillAudienceDrift,
	detectSkillMirrorDrift,
	detectToolRegistrationDrift,
	runSyncDetectors,
} from '../../../scripts/drift-check.ts';
import { MAX_LANES } from '../../../src/tools/dispatch-lanes';

// Issue #1497: the drift checker must (a) detect real drift in each category and
// (b) produce no error/warning false positives on the current repository tree.

const tempRoots: string[] = [];

function makeTempRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-check-test-'));
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
	'docs/planning.md': '- Each task runs through a full 15-step QA gate\n',
	'docs/swarm-briefing.md':
		'After every task a 15-step QA gate verifies quality.\n\n## Pipeline (15 Steps)\n',
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

describe('drift-check: no false positives on the real repository', () => {
	test('runSyncDetectors produces zero error/warning findings on the current tree', () => {
		const blocking = runSyncDetectors().filter((f) => f.severity !== 'notice');
		// If this fails, the message lists the offending findings for triage.
		expect(blocking.map((f) => `${f.category}: ${f.message}`)).toEqual([]);
	});

	test('the tool, command, agent, and docs-claim detectors are coherent on the real tree', () => {
		expect(detectToolRegistrationDrift()).toEqual([]);
		expect(detectCommandDrift()).toEqual([]);
		expect(detectAgentDrift()).toEqual([]);
		expect(detectDocsClaimDrift()).toEqual([]);
	});
});

describe('drift-check: skill-mirror detection', () => {
	test('detects a MIRRORED skill that is not byte-identical', () => {
		const root = makeTempRoot();
		writeFile(root, '.opencode/skills/brainstorm/SKILL.md', 'canonical body\n');
		writeFile(root, '.claude/skills/brainstorm/SKILL.md', 'DRIFTED body\n');

		const findings = detectSkillMirrorDrift(root);
		const hit = findings.find(
			(f) =>
				f.severity === 'error' &&
				f.message.includes('brainstorm') &&
				f.message.includes('byte-identical'),
		);
		expect(hit).toBeDefined();
	});

	test('detects a both-tree skill pair with no mirror contract', () => {
		const root = makeTempRoot();
		writeFile(root, '.opencode/skills/zzz-unclassified/SKILL.md', 'a\n');
		writeFile(root, '.claude/skills/zzz-unclassified/SKILL.md', 'a\n');

		const findings = detectSkillMirrorDrift(root);
		const hit = findings.find(
			(f) =>
				f.severity === 'warning' &&
				f.message.includes('zzz-unclassified') &&
				f.message.includes('no mirror contract'),
		);
		expect(hit).toBeDefined();
	});

	test('detects drift in an extra identical .agents mirror', () => {
		const root = makeTempRoot();
		const canonical = 'canonical body\n';
		writeFile(root, '.opencode/skills/test-file-split/SKILL.md', canonical);
		writeFile(root, '.claude/skills/test-file-split/SKILL.md', canonical);
		writeFile(
			root,
			'.agents/skills/test-file-split/SKILL.md',
			'DRIFTED body\n',
		);

		const findings = detectSkillMirrorDrift(root);
		const hit = findings.find(
			(f) =>
				f.severity === 'error' &&
				f.file === '.agents/skills/test-file-split/SKILL.md' &&
				f.message.includes('extra mirror drifted'),
		);
		expect(hit).toBeDefined();
	});

	test('detects a missing extra identical .agents mirror', () => {
		const root = makeTempRoot();
		const canonical = 'canonical body\n';
		writeFile(root, '.opencode/skills/fork-pr-operations/SKILL.md', canonical);
		writeFile(root, '.claude/skills/fork-pr-operations/SKILL.md', canonical);

		const findings = detectSkillMirrorDrift(root);
		const hit = findings.find(
			(f) =>
				f.severity === 'error' &&
				f.file === '.agents/skills/fork-pr-operations/SKILL.md' &&
				f.message.includes('missing extra identical mirror'),
		);
		expect(hit).toBeDefined();
	});

	test('detects a divergent pair missing a declared shared safety section (M13)', () => {
		const root = makeTempRoot();
		// engineering-conventions is a `divergent` ADDITIONAL contract that
		// declares `sharedSafetyHeadings`. Both trees exist and may diverge in
		// prose, but the .claude copy here omits "### Critical safety guard".
		writeFile(
			root,
			'.opencode/skills/engineering-conventions/SKILL.md',
			[
				'# Engineering Conventions',
				'',
				'## SAST baseline capturing (differential scanning)',
				'',
				'### Critical safety guard',
				'',
				'NEVER capture a baseline after code changes.',
				'',
				'## Agent prompt strings — escaping pitfalls',
				'',
				'Escape backticks.',
				'',
			].join('\n'),
		);
		writeFile(
			root,
			'.claude/skills/engineering-conventions/SKILL.md',
			[
				'# Engineering Conventions (Claude Code)',
				'',
				'## SAST baseline capturing (differential scanning)',
				'',
				// "### Critical safety guard" intentionally REMOVED here.
				'## Agent prompt strings — escaping pitfalls',
				'',
				'Escape backticks.',
				'',
			].join('\n'),
		);

		const findings = detectSkillMirrorDrift(root);
		const hit = findings.find(
			(f) =>
				f.severity === 'error' &&
				f.file === '.claude/skills/engineering-conventions/SKILL.md' &&
				f.message.includes('engineering-conventions') &&
				f.message.includes('### Critical safety guard') &&
				f.message.includes('safety section'),
		);
		expect(hit).toBeDefined();
	});

	test('accepts a divergent pair when every declared safety section is present in both trees', () => {
		const root = makeTempRoot();
		const bodyWithAllHeadings = [
			'# Engineering Conventions',
			'',
			'## SAST baseline capturing (differential scanning)',
			'',
			'### Critical safety guard',
			'',
			'NEVER capture a baseline after code changes.',
			'',
			'## Agent prompt strings — escaping pitfalls',
			'',
			'Escape backticks.',
			'',
		].join('\n');
		writeFile(
			root,
			'.opencode/skills/engineering-conventions/SKILL.md',
			bodyWithAllHeadings,
		);
		writeFile(
			root,
			'.claude/skills/engineering-conventions/SKILL.md',
			// Intentionally different prose in the title, but all safety headings present.
			bodyWithAllHeadings.replace(
				'# Engineering Conventions',
				'# Engineering Conventions (Claude Code)',
			),
		);

		const findings = detectSkillMirrorDrift(root);
		const safetyHits = findings.filter(
			(f) =>
				f.file?.includes('engineering-conventions') &&
				f.message.includes('safety section'),
		);
		expect(safetyHits).toEqual([]);
	});

	test('does not flag the generated/ directory as an unclassified pair', () => {
		const root = makeTempRoot();
		writeFile(root, '.opencode/skills/generated/x/SKILL.md', 'a\n');
		writeFile(root, '.claude/skills/generated/SKILL.md', 'a\n');

		const findings = detectSkillMirrorDrift(root);
		const hit = findings.find((f) => f.message.includes('"generated"'));
		expect(hit).toBeUndefined();
	});

	// ADDITIONAL_SKILL_MIRROR_CONTRACTS `adapter` kind — ci-fix-monitor is the
	// real (currently only) entry using this kind: .opencode is canonical,
	// .agents/skills/ci-fix-monitor is a thin adapter shim, no .claude copy.
	describe('adapter kind (ci-fix-monitor)', () => {
		test('passes when the canonical exists and the adapter shim references it', () => {
			const root = makeTempRoot();
			writeFile(
				root,
				'.opencode/skills/ci-fix-monitor/SKILL.md',
				'canonical protocol\n',
			);
			writeFile(
				root,
				'.agents/skills/ci-fix-monitor/SKILL.md',
				'Read `.opencode/skills/ci-fix-monitor/SKILL.md` for the full protocol.\n',
			);

			const findings = detectSkillMirrorDrift(root);
			const hit = findings.find((f) => f.message.includes('ci-fix-monitor'));
			expect(hit).toBeUndefined();
		});

		test('detects a missing canonical .opencode file', () => {
			const root = makeTempRoot();
			writeFile(
				root,
				'.agents/skills/ci-fix-monitor/SKILL.md',
				'Read `.opencode/skills/ci-fix-monitor/SKILL.md` for the full protocol.\n',
			);

			const findings = detectSkillMirrorDrift(root);
			const hit = findings.find(
				(f) =>
					f.severity === 'error' &&
					f.file === '.opencode/skills/ci-fix-monitor/SKILL.md' &&
					f.message.includes('missing canonical'),
			);
			expect(hit).toBeDefined();
		});

		test('detects a missing adapter shim', () => {
			const root = makeTempRoot();
			writeFile(
				root,
				'.opencode/skills/ci-fix-monitor/SKILL.md',
				'canonical protocol\n',
			);

			const findings = detectSkillMirrorDrift(root);
			const hit = findings.find(
				(f) =>
					f.severity === 'error' &&
					f.file === '.agents/skills/ci-fix-monitor/SKILL.md' &&
					f.message.includes('missing adapter shim'),
			);
			expect(hit).toBeDefined();
		});

		test('detects an adapter shim that no longer references the canonical file', () => {
			const root = makeTempRoot();
			writeFile(
				root,
				'.opencode/skills/ci-fix-monitor/SKILL.md',
				'canonical protocol\n',
			);
			writeFile(
				root,
				'.agents/skills/ci-fix-monitor/SKILL.md',
				'This shim no longer points anywhere useful.\n',
			);

			const findings = detectSkillMirrorDrift(root);
			const hit = findings.find(
				(f) =>
					f.severity === 'error' &&
					f.file === '.agents/skills/ci-fix-monitor/SKILL.md' &&
					f.message.includes('no longer references canonical'),
			);
			expect(hit).toBeDefined();
		});
	});
});

describe('drift-check: static skill audience metadata', () => {
	test('detects missing and invalid audience declarations', () => {
		const root = makeTempRoot();
		writeFile(
			root,
			'.opencode/skills/missing/SKILL.md',
			'---\nname: missing\ndescription: missing audience\n---\n',
		);
		writeFile(
			root,
			'.claude/skills/invalid/SKILL.md',
			'---\nname: invalid\naudience: []\ndescription: invalid audience\n---\n',
		);

		const findings = detectSkillAudienceDrift(root);
		expect(findings).toHaveLength(2);
		expect(findings.map((finding) => finding.file)).toEqual([
			'.opencode/skills/missing/SKILL.md',
			'.claude/skills/invalid/SKILL.md',
		]);
	});

	test('accepts valid static audiences and ignores generated skills', () => {
		const root = makeTempRoot();
		writeFile(
			root,
			'.agents/skills/codex-adapter/SKILL.md',
			'---\nname: codex-adapter\naudience: swarm-plugin\ndescription: valid\n---\n',
		);
		writeFile(
			root,
			'.opencode/skills/generated/dynamic/SKILL.md',
			'---\nname: dynamic\ndescription: intentionally unscoped\n---\n',
		);

		expect(detectSkillAudienceDrift(root)).toEqual([]);
	});
});

describe('drift-check: bundled-skill detection (issue #1496 class)', () => {
	test('detects an .opencode skill directory missing from BUNDLED_PROJECT_SKILLS', () => {
		const root = makeTempRoot();
		writeFile(root, '.opencode/skills/zzz-not-bundled/SKILL.md', 'x\n');
		writeFile(root, 'package.json', JSON.stringify({ files: [] }));

		const findings = detectBundledSkillDrift(root);
		const hit = findings.find(
			(f) =>
				f.severity === 'error' &&
				f.message.includes('zzz-not-bundled') &&
				f.message.includes('BUNDLED_PROJECT_SKILLS'),
		);
		expect(hit).toBeDefined();
	});

	test('detects a bundled skill missing from package.json#files', () => {
		const root = makeTempRoot();
		// Provide SKILL.md for a known bundled slug so the phantom check passes,
		// but omit it from package.json#files.
		writeFile(root, '.opencode/skills/brainstorm/SKILL.md', 'x\n');
		writeFile(root, 'package.json', JSON.stringify({ files: [] }));

		const findings = detectBundledSkillDrift(root);
		const hit = findings.find(
			(f) =>
				f.severity === 'error' &&
				f.file === 'package.json' &&
				f.message.includes('.opencode/skills/brainstorm'),
		);
		expect(hit).toBeDefined();
	});
});

describe('drift-check: docs numeric claim detection', () => {
	test('detects a QA gate step-count claim that drifted from the source registry', () => {
		const root = makeTempRoot();
		// Lane-cap files are provided at matching values; only the planning.md
		// QA-gate claim drifts, so exactly one finding is expected.
		writeDocsClaimFixture(root, {
			'docs/planning.md': '- Each task runs through a full 12-step QA gate\n',
		});

		const findings = detectDocsClaimDrift(root);
		expect(findings).toHaveLength(1);
		const hit = findings.find(
			(f) =>
				f.category === 'docs-claim' &&
				f.file === 'docs/planning.md' &&
				f.message.includes('says 12') &&
				f.message.includes('QA_GATE_PIPELINE_STEPS has 15'),
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

describe('drift-check: output helpers', () => {
	test('annotation emits GitHub Actions format with file and category', () => {
		const finding: DriftFinding = {
			category: 'skill-mirror',
			severity: 'error',
			file: '.claude/skills/x/SKILL.md',
			message: 'boom',
		};
		expect(annotation(finding)).toBe(
			'::error file=.claude/skills/x/SKILL.md::[drift:skill-mirror] boom',
		);
	});

	test('annotation handles a finding without a file', () => {
		const finding: DriftFinding = {
			category: 'agent',
			severity: 'notice',
			message: 'fyi',
		};
		expect(annotation(finding)).toBe('::notice::[drift:agent] fyi');
	});

	test('buildReport reports a clean run', () => {
		expect(buildReport([])).toContain('No drift detected');
	});

	test('buildReport summarizes counts and groups by category', () => {
		const report = buildReport([
			{ category: 'tool', severity: 'error', message: 'a' },
			{ category: 'tool', severity: 'warning', message: 'b' },
			{ category: 'agent', severity: 'notice', message: 'c' },
		]);
		expect(report).toContain('3** drift finding(s)');
		expect(report).toContain('1 error, 1 warning, 1 notice');
		expect(report).toContain('## tool (2)');
		expect(report).toContain('## agent (1)');
	});
});
