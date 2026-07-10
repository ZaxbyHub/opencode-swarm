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

	test('does not flag the generated/ directory as an unclassified pair', () => {
		const root = makeTempRoot();
		writeFile(root, '.opencode/skills/generated/x/SKILL.md', 'a\n');
		writeFile(root, '.claude/skills/generated/SKILL.md', 'a\n');

		const findings = detectSkillMirrorDrift(root);
		const hit = findings.find((f) => f.message.includes('"generated"'));
		expect(hit).toBeUndefined();
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
		writeFile(
			root,
			'docs/planning.md',
			'- Each task runs through a full 12-step QA gate\n',
		);
		writeFile(
			root,
			'docs/swarm-briefing.md',
			[
				'After every task a 15-step QA gate verifies quality.',
				'',
				'## Pipeline (15 Steps)',
			].join('\n'),
		);

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
		// Write only swarm-briefing.md — do NOT write docs/planning.md
		writeFile(
			root,
			'docs/swarm-briefing.md',
			[
				'After every task a 15-step QA gate verifies quality.',
				'',
				'## Pipeline (15 Steps)',
			].join('\n'),
		);

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
		writeFile(root, 'docs/planning.md', 'No steps here in the planning doc.\n');
		writeFile(
			root,
			'docs/swarm-briefing.md',
			[
				'After every task a 15-step QA gate verifies quality.',
				'',
				'## Pipeline (15 Steps)',
			].join('\n'),
		);

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
