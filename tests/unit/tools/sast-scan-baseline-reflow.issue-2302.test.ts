/**
 * Issue #2302 — end-to-end sastScan baseline reflow + audited absorption.
 *
 * Runs the REAL scan pipeline (Tier A rules, real baseline files) through the
 * issue's acceptance criteria:
 * 1. move/relocate a flagged line without changing it → moved, verdict pass,
 *    no recapture needed
 * 2. genuinely new exec()/eval() site → verdict fail; bare recapture BLOCKED
 *    with the baseline untouched; audited recapture absorbs with triage
 * 3. identical same-rule insertion above → exactly the duplicate stays NEW
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sastScan } from '../../../src/tools/sast-scan';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tempDir = '';
let baselineBytes = '';

function baselinePath(): string {
	return path.join(tempDir, '.swarm', 'evidence', '1', 'sast-baseline.json');
}

function readBaseline(): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(baselinePath(), 'utf-8')) as Record<
		string,
		unknown
	>;
}

function latestEvidenceEntry(): Record<string, unknown> {
	const raw = JSON.parse(
		fs.readFileSync(
			path.join(tempDir, '.swarm', 'evidence', 'sast_scan', 'evidence.json'),
			'utf-8',
		),
	) as { entries?: Record<string, unknown>[] };
	const entries = raw.entries ?? [];
	return entries[entries.length - 1] ?? {};
}

beforeEach(() => {
	tempDir = canonicalMkdtemp('sast-scan-reflow-2302-');
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('sastScan baseline reflow (#2302)', () => {
	it('adjacent-line edit: unchanged finding reports moved and the verdict passes without recapture', async () => {
		const file = path.join(tempDir, 'app.js');
		fs.writeFileSync(file, 'function a() {\n  eval(userInput);\n}\n');

		const cap = await sastScan(
			{ changed_files: [file], capture_baseline: true, phase: 1 },
			tempDir,
		);
		expect(cap.status).toBe('baseline_captured');

		// Edit only the neighbor line; the flagged line is byte-identical.
		fs.writeFileSync(file, 'function aRenamed() {\n  eval(userInput);\n}\n');

		const rescan = await sastScan({ changed_files: [file], phase: 1 }, tempDir);
		expect(rescan.verdict).toBe('pass');
		expect(rescan.baseline_used).toBe(true);
		expect(rescan.new_findings ?? []).toHaveLength(0);
		expect(rescan.moved_findings ?? []).toHaveLength(1);
		expect(rescan.moved_findings?.[0]?.location.line).toBe(2);

		// The evidence payload carries moved_findings (schema round-trip).
		const entry = latestEvidenceEntry();
		expect((entry.moved_findings as unknown[]).length).toBe(1);
		expect(entry.baseline_used).toBe(true);
	});

	it('criterion 1: flagged line relocated below other code reports moved, not new', async () => {
		const file = path.join(tempDir, 'relocate.js');
		fs.writeFileSync(file, 'eval(userInput);\nfoo();\nbar();\n');

		await sastScan(
			{ changed_files: [file], capture_baseline: true, phase: 1 },
			tempDir,
		);

		fs.writeFileSync(file, 'foo();\nbar();\nbaz();\neval(userInput);\n');

		const rescan = await sastScan({ changed_files: [file], phase: 1 }, tempDir);
		expect(rescan.verdict).toBe('pass');
		expect(rescan.moved_findings ?? []).toHaveLength(1);
		expect(rescan.moved_findings?.[0]?.location.line).toBe(4);
		expect(rescan.new_findings ?? []).toHaveLength(0);
	});

	it('identical duplicate inserted above: exactly the duplicate stays NEW (index decoupling)', async () => {
		const file = path.join(tempDir, 'dup.js');
		fs.writeFileSync(file, 'function run() {\n  eval(userInput);\n}\n');

		await sastScan(
			{ changed_files: [file], capture_baseline: true, phase: 1 },
			tempDir,
		);

		fs.writeFileSync(
			file,
			'function run() {\n  eval(userInput);\n  eval(userInput);\n}\n',
		);

		const rescan = await sastScan({ changed_files: [file], phase: 1 }, tempDir);
		expect(rescan.verdict).toBe('fail');
		expect(rescan.new_findings ?? []).toHaveLength(1);
		expect(rescan.moved_findings ?? []).toHaveLength(1);
	});

	it('moved and exact pre-existing findings coexist in one scan', async () => {
		const fileA = path.join(tempDir, 'a.js');
		const fileB = path.join(tempDir, 'b.js');
		fs.writeFileSync(fileA, 'function old() {\n  eval(userInput);\n}\n');
		fs.writeFileSync(fileB, 'eval(userInput);\n');

		await sastScan(
			{ changed_files: [fileA, fileB], capture_baseline: true, phase: 1 },
			tempDir,
		);

		// fileA: adjacent edit → moved. fileB: untouched → exact pre-existing.
		fs.writeFileSync(fileA, 'function renamed() {\n  eval(userInput);\n}\n');

		const rescan = await sastScan(
			{ changed_files: [fileA, fileB], phase: 1 },
			tempDir,
		);
		expect(rescan.verdict).toBe('pass');
		expect(rescan.moved_findings ?? []).toHaveLength(1);
		expect(rescan.pre_existing_findings ?? []).toHaveLength(1);
	});
});

describe('sastScan audited absorption (#2302)', () => {
	it('genuinely new exec site fails; bare recapture is BLOCKED and leaves the baseline untouched', async () => {
		const file = path.join(tempDir, 'grow.js');
		fs.writeFileSync(file, 'const a = 1;\nconst b = 2;\n');

		await sastScan(
			{ changed_files: [file], capture_baseline: true, phase: 1 },
			tempDir,
		);
		baselineBytes = fs.readFileSync(baselinePath(), 'utf-8');

		// Coder introduces a genuinely new vulnerable call site.
		fs.writeFileSync(
			file,
			'const a = 1;\nconst b = 2;\nfunction late() {\n  eval(userInput);\n}\n',
		);

		const failed = await sastScan({ changed_files: [file], phase: 1 }, tempDir);
		expect(failed.verdict).toBe('fail');
		expect(failed.new_findings ?? []).toHaveLength(1);

		// Failure-response recapture WITHOUT a rationale: blocked, baseline
		// byte-identical (acceptance criterion 2).
		const bareRecapture = await sastScan(
			{
				changed_files: [file],
				capture_baseline: true,
				phase: 1,
			},
			tempDir,
		);
		expect(bareRecapture.status).toBe('baseline_absorption_blocked');
		expect(fs.readFileSync(baselinePath(), 'utf-8')).toBe(baselineBytes);

		// Audited recapture: absorbs with who/when/rationale, then passes.
		const auditedRecapture = await sastScan(
			{
				changed_files: [file],
				capture_baseline: true,
				phase: 1,
				baseline_refresh_rationale:
					'finding verified pre-existing before this task',
				session_id: 'session-2302-e2e',
			},
			tempDir,
		);
		expect(auditedRecapture.status).toBe('baseline_merged');
		expect(auditedRecapture.absorbed_finding_count).toBe(1);

		const bundle = readBaseline();
		const triage = bundle.triage_log as Array<Record<string, unknown>>;
		expect(triage).toHaveLength(1);
		expect(triage[0]?.rationale).toBe(
			'finding verified pre-existing before this task',
		);
		expect(triage[0]?.actor).toBe('session-2302-e2e');
		expect(typeof triage[0]?.absorbed_at).toBe('string');

		const after = await sastScan({ changed_files: [file], phase: 1 }, tempDir);
		expect(after.verdict).toBe('pass');
		expect(after.new_findings ?? []).toHaveLength(0);
	});

	it('new-file absorption is gated too: bare recapture BLOCKED, audited rationale absorbs (#2302)', async () => {
		const fileA = path.join(tempDir, 'first-a.js');
		const fileB = path.join(tempDir, 'first-b.js');
		fs.writeFileSync(fileA, 'eval(userInput);\n');
		fs.writeFileSync(fileB, 'eval(otherInput);\n');

		await sastScan(
			{ changed_files: [fileA], capture_baseline: true, phase: 1 },
			tempDir,
		);
		baselineBytes = fs.readFileSync(baselinePath(), 'utf-8');

		// A merge that would absorb a finding from a file NOT previously in
		// the baseline is still a novel absorption — the tool cannot tell a
		// pre-delegation capture from a failure-response recapture, so the
		// bare capture is blocked and the baseline stays byte-identical.
		const bare = await sastScan(
			{ changed_files: [fileB], capture_baseline: true, phase: 1 },
			tempDir,
		);
		expect(bare.status).toBe('baseline_absorption_blocked');
		expect(fs.readFileSync(baselinePath(), 'utf-8')).toBe(baselineBytes);

		// The routine per-task flow passes a truthful pre-delegation rationale.
		const merge = await sastScan(
			{
				changed_files: [fileB],
				capture_baseline: true,
				phase: 1,
				baseline_refresh_rationale:
					'pre-delegation capture for task 2.1; finding verified pre-existing',
				session_id: 'session-2302-newfile',
			},
			tempDir,
		);
		expect(merge.status).toBe('baseline_merged');
		expect(merge.absorbed_finding_count).toBe(1);

		const bundle = readBaseline();
		const triage = bundle.triage_log as Array<Record<string, unknown>>;
		expect(triage[0]?.rationale).toBe(
			'pre-delegation capture for task 2.1; finding verified pre-existing',
		);
		expect(triage[0]?.actor).toBe('session-2302-newfile');

		// A diff scan over both files now passes.
		const after = await sastScan(
			{ changed_files: [fileA, fileB], phase: 1 },
			tempDir,
		);
		expect(after.verdict).toBe('pass');
		expect(after.new_findings ?? []).toHaveLength(0);
	});
});
