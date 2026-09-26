/**
 * j07 — executed-cells report + documentation contract (AC7, issue #2666):
 * the journey report carries the exact command, runtime and host versions,
 * fixture class, per-stage start AND end status, executed cells and labeled
 * unexecuted cells; docs/testing/execute-journey.md documents the journey
 * state machine, fixture setup, executed cells, completion evidence, and
 * the PR-review breadth boundary; the release fragment exists (as pending,
 * or archived by the release that consumed it).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
	JOURNEY_REPORT_SCHEMA_VERSION,
	type JourneyReport,
	validateJourneyReport,
} from '../../helpers/execute-journey-driver';

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..');
const DOCS = path.join(REPO_ROOT, 'docs', 'testing', 'execute-journey.md');
const FRAGMENT_RELATIVE =
	'docs/releases/pending/2666-execute-journey-registered-host.md';
const FRAGMENT = path.join(REPO_ROOT, ...FRAGMENT_RELATIVE.split('/'));
const RELEASES_DIR = path.join(REPO_ROOT, 'docs', 'releases');

/** A structurally complete driver-produced report (the shape writeReport emits). */
function completeReport(): JourneyReport {
	return {
		schemaVersion: JOURNEY_REPORT_SCHEMA_VERSION,
		fixture_class: 'deterministic',
		command: 'bun test j01-happy-path-registered',
		runtime: { bun: '1.3.14', node: 'n/a' },
		host: {
			platform: process.platform,
			arch: process.arch,
			pluginVersion: 'test',
		},
		startedAt: '2026-01-01T00:00:00.000Z',
		endedAt: '2026-01-01T00:00:05.000Z',
		stages: [
			{
				name: 'configure',
				startStatus: 'started',
				endStatus: 'agent-session-active',
				evidence: {
					durableArtifacts: [],
					toolCallIds: ['configure-call-1'],
					resultIds: ['chat.message:ok'],
				},
			},
			{
				name: 'finish',
				startStatus: 'tests_run',
				endStatus: 'task_completed',
				evidence: {
					durableArtifacts: ['.swarm/evidence/1.1.json'],
					toolCallIds: ['finish-call-1'],
					resultIds: ['update_task_status:completed'],
				},
			},
		],
		planBinding: { planId: 'p1', approvedPayloadHash: 'h1' },
		executedCells: ['bun/win32'],
		labeledUnexecutedCells: ['node/full-journey', 'live-model canary'],
		transport: 'scripted-client',
	};
}

describe('journey report schema (#2666)', () => {
	test('a complete report carries every required field and validates', () => {
		const report = completeReport();
		expect(report.schemaVersion).toBe(JOURNEY_REPORT_SCHEMA_VERSION);
		expect(typeof report.command).toBe('string');
		expect(report.command.length).toBeGreaterThan(0);
		expect(typeof report.runtime.bun).toBe('string');
		expect(typeof report.runtime.node).toBe('string');
		expect(typeof report.host.platform).toBe('string');
		expect(typeof report.host.arch).toBe('string');
		expect(report.fixture_class).toBe('deterministic');
		expect(report.transport).toBe('scripted-client');
		// Per-stage start AND end status.
		for (const stage of report.stages) {
			expect(stage.startStatus.length).toBeGreaterThan(0);
			expect(stage.endStatus.length).toBeGreaterThan(0);
		}
		// Executed cells AND labeled unexecuted cells — no extrapolation.
		expect(report.executedCells.length).toBeGreaterThan(0);
		expect(report.labeledUnexecutedCells.length).toBeGreaterThan(0);
		expect(validateJourneyReport(report).valid).toBe(true);
	});

	test('report timestamps and plan binding are present for a completed journey', () => {
		const report = completeReport();
		expect(report.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(report.endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(report.planBinding).not.toBeNull();
		expect(report.planBinding?.planId.length).toBeGreaterThan(0);
		expect(report.planBinding?.approvedPayloadHash.length).toBeGreaterThan(0);
	});
});

describe('docs/testing/execute-journey.md contract (#2666)', () => {
	const content = readFileSync(DOCS, 'utf8');

	test('documents the journey state machine', () => {
		const section = sectionOf(content, '## Journey state machine');
		expect(section).toContain('coder_delegated');
		expect(section).toContain('pre_check_passed');
		expect(section).toContain('reviewer_run');
		expect(section).toContain('tests_run');
		expect(section).toContain('complete');
		expect(section).toContain('generation');
	});

	test('documents the fixture setup', () => {
		const section = sectionOf(content, '## Fixture setup');
		expect(section).toContain('execute-journey-driver.ts');
		expect(section).toContain('createIsolatedTestEnv');
		expect(section).toContain('ScriptedHostClient');
	});

	test('documents executed and labeled-unexecuted cells without extrapolation', () => {
		const section = sectionOf(content, '## Executed host/runtime cells');
		expect(section).toContain('Bun');
		expect(section).toContain('LABELED UNEXECUTED');
		expect(section).toContain('full journey under Node');
	});

	test('documents the evidence needed to call a run complete', () => {
		const section = sectionOf(
			content,
			'## Evidence needed to call a run complete',
		);
		expect(section).toContain('validateJourneyReport');
		expect(section).toContain('stdout');
		expect(section).toContain('approved-plan binding');
	});

	test('states the PR-review breadth boundary (#2585/#2586)', () => {
		expect(content).toContain('#2585/#2586');
		expect(content).toContain('out of scope');
	});

	test('documents the deterministic-transport vs canary separation', () => {
		const section = sectionOf(
			content,
			'## Deterministic transport vs model-backed canary',
		);
		expect(section).toContain('SWARM_EXECUTE_JOURNEY_CANARY');
		expect(section).toContain('model-canary');
		expect(section).toContain('scripted-client');
		// The docs phrase it with emphasis: "is NOT transport evidence".
		expect(section.toLowerCase()).toContain('not transport evidence');
	});

	test('documents the EXECUTE-scope cancellation labeled gap', () => {
		expect(content).toContain('Labeled gap');
		expect(content).toContain('cancel_pending');
	});
});

describe('release fragment contract (#2666)', () => {
	test('the #2666 fragment is present as pending or archived by its release', () => {
		// The fragment ships as pending until the release that consumed it
		// archives it (v7.186.8 materialization moves the bytes into
		// docs/releases/v7.186.8.md + a manifests/ provenance entry), so the
		// contract pins the deliverable in whichever form the tree holds.
		if (existsSync(FRAGMENT)) {
			const fragment = readFileSync(FRAGMENT, 'utf8');
			expect(fragment).toContain('#2666');
			expect(fragment.length).toBeGreaterThan(400);
			return;
		}
		const manifestsDir = path.join(RELEASES_DIR, 'manifests');
		const archiving = readdirSync(manifestsDir)
			.filter((name) => name.endsWith('.json'))
			.map(
				(name) =>
					JSON.parse(readFileSync(path.join(manifestsDir, name), 'utf8')) as {
						tag: string;
						fragments: { path: string }[];
					},
			)
			.filter((manifest) =>
				manifest.fragments.some((f) => f.path === FRAGMENT_RELATIVE),
			);
		expect(archiving.length).toBeGreaterThan(0);
		for (const manifest of archiving) {
			const releaseDoc = readFileSync(
				path.join(RELEASES_DIR, `${manifest.tag}.md`),
				'utf8',
			);
			expect(releaseDoc).toContain('#2666');
		}
	});
});

function sectionOf(content: string, heading: string): string {
	const start = content.indexOf(heading);
	if (start === -1) return '';
	const next = content.indexOf('\n## ', start + heading.length);
	return content.slice(start, next === -1 ? undefined : next);
}
