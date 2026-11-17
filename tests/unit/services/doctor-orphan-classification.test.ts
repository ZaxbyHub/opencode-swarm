/**
 * #3554: /swarm doctor must not report derived non-task writer subtrees under
 * .swarm/evidence/ as "Orphaned Evidence". At base, listEvidenceTaskIds skips
 * only `receipts`, so gate-audit/, task-gate-requirements/,
 * task-gate-quarantine/ and phase-numbered dirs are enumerated as task ids
 * and the orphan check goes red with a misleading cleanup suggestion.
 *
 * Runs the REAL doctor surface (getDiagnoseData) against a fixture project.
 *
 * RED at base (check reports ❌ naming the derived dirs), GREEN after the
 * classification fix (check reports ✅ and the detail names none of them).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { getDiagnoseData } from '../../../src/services/diagnose-service';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let dir: string;

beforeEach(() => {
	dir = canonicalMkdtemp('doctor-orphan-3554-');
	const swarm = path.join(dir, '.swarm');
	mkdirSync(swarm, { recursive: true });
	// Valid PlanSchema v1.0.0 plan with one task (1.1). Must survive
	// loadPlanJsonOnly's PlanSchema.parse — an invalid plan would make the
	// orphan check vacuously report "No plan to cross-reference".
	writeFileSync(
		path.join(swarm, 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Doctor orphan classification fixture',
			swarm: 'fixture-swarm',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					tasks: [{ id: '1.1', phase: 1, description: 'Exercise task 1.1' }],
				},
			],
		}),
	);

	const evidence = path.join(swarm, 'evidence');
	// Derived writer subtrees (PR #3550 FB-008 class, critic-amended scope):
	// gate-audit (src/evaluation/store.ts), task-gate-requirements
	// (src/evidence/task-gate-requirements.ts), task-gate-quarantine
	// (src/evidence/task-gate-repair.ts).
	mkdirSync(path.join(evidence, 'gate-audit', 'run-1'), { recursive: true });
	writeFileSync(
		path.join(evidence, 'gate-audit', 'run-1', 'results.json'),
		'{}',
	);
	mkdirSync(path.join(evidence, 'task-gate-requirements'), { recursive: true });
	mkdirSync(path.join(evidence, 'task-gate-quarantine'), { recursive: true });
	// Phase-numbered dirs, one per REAL phase-writer artifact shape (plan-critic
	// rounds 1+2 F4: every in-scope writer must be recognized — the registry
	// below is the verified producer sweep, each row cites its source; the
	// parallel review of PR #3677 (PB F-2) added the two last rows):
	// 1 sast-baseline.json (src/tools/sast-baseline.ts:192)
	// 2 epic-phase-review.json (src/epic/phase-readiness.ts:78)
	// 3 lean-turbo-critic.json (src/turbo/lean/integration.ts:411)
	// 4 lean-turbo-reviewer.json (src/turbo/lean/integration.ts:121)
	// 5 curator-findings.json (src/hooks/curator.ts:1967)
	// 6 completion-verify.json (src/tools/completion-verify.ts:471)
	// 7 full-auto-7.json (src/full-auto/evidence-names.ts grammar)
	// 8 auto-review.json (src/review/evidence.ts:145 — phase-scoped arm)
	// 9 phase-architecture-summary.json (src/summaries/store.ts:32)
	// 10 architecture-supervisor.json (src/summaries/store.ts:33)
	// 11 drift-verifier.json (src/tools/write-drift-evidence.ts)
	// 12 hallucination-guard.json (src/tools/write-hallucination-evidence.ts)
	// 13 mutation-gate.json (src/tools/write-mutation-evidence.ts)
	// 14 nested lean-turbo/ dir only (src/turbo/lean/evidence.ts:96/:202)
	// 15 phase-council.json (src/tools/submit-phase-council-verdicts.ts:391-393,
	//     phase_council opt-in — default off — but a real writer when enabled)
	const phaseArtifacts: Array<[string, string]> = [
		['1', 'sast-baseline.json'],
		['2', 'epic-phase-review.json'],
		['3', 'lean-turbo-critic.json'],
		['4', 'lean-turbo-reviewer.json'],
		['5', 'curator-findings.json'],
		['6', 'completion-verify.json'],
		['7', 'full-auto-7.json'],
		['8', 'auto-review.json'],
		['9', 'phase-architecture-summary.json'],
		['10', 'architecture-supervisor.json'],
		['11', 'drift-verifier.json'],
		['12', 'hallucination-guard.json'],
		['13', 'mutation-gate.json'],
		['15', 'phase-council.json'],
	];
	for (const [phaseDir, artifact] of phaseArtifacts) {
		mkdirSync(path.join(evidence, phaseDir), { recursive: true });
		writeFileSync(path.join(evidence, phaseDir, artifact), '{}');
	}
	// Nested shape: numeric dir holding ONLY the lean-turbo subdir.
	mkdirSync(path.join(evidence, '14', 'lean-turbo'), { recursive: true });
	writeFileSync(
		path.join(evidence, '14', 'lean-turbo', 'lean-turbo-phase.json'),
		'{}',
	);
	// Named derived root from the non-phase arm of auto-review
	// (src/review/evidence.ts:135-151: evidence/auto-review/<trigger>-<hash>.json).
	mkdirSync(path.join(evidence, 'auto-review'), { recursive: true });
	writeFileSync(
		path.join(evidence, 'auto-review', 'session-end-abc.json'),
		'{}',
	);
	// Named derived root from the SBOM writer (PB F-2b, PR #3677 review):
	// src/tools/sbom-generate.ts:36 defaults to .swarm/evidence/sbom.
	mkdirSync(path.join(evidence, 'sbom'), { recursive: true });
	writeFileSync(path.join(evidence, 'sbom', 'cdx-1.json'), '{}');
});

afterEach(() => {
	safeRmRecursive(dir);
});

describe('doctor — Orphaned Evidence classification for derived writer subtrees (#3554)', () => {
	test('gate-audit / task-gate-requirements / task-gate-quarantine subtrees are not plan orphans (RED at base, GREEN after the fix)', async () => {
		const data = await getDiagnoseData(dir);
		const check = data.checks.find(
			(entry) => entry.name === 'Orphaned Evidence',
		);
		expect(check).toBeDefined();
		expect(check?.status).toBe('✅');
		const detail = check?.detail ?? '';
		expect(detail).not.toContain('gate-audit');
		expect(detail).not.toContain('task-gate-requirements');
		expect(detail).not.toContain('task-gate-quarantine');
		expect(detail).not.toContain('sbom');
	});

	test('a real plan-task evidence bundle for a plan task stays non-orphaned (control leg)', async () => {
		// Control: the legitimate task bundle 1.1 (with the real evidence.json
		// artifact shape) must keep the check green for the RIGHT reason once
		// the derived dirs are exempted — the detail must not name 1.1 either.
		const taskBundle = path.join(dir, '.swarm', 'evidence', '1.1');
		mkdirSync(taskBundle, { recursive: true });
		writeFileSync(
			path.join(taskBundle, 'evidence.json'),
			JSON.stringify({ taskId: '1.1' }),
		);
		const data = await getDiagnoseData(dir);
		const check = data.checks.find(
			(entry) => entry.name === 'Orphaned Evidence',
		);
		expect(check).toBeDefined();
		expect(check?.status).toBe('✅');
		expect(check?.detail).not.toContain('1.1');
	});

	test('numeric dir carrying BOTH a real evidence.json bundle and a phase marker stays a task id (GREEN at base and after the fix — precedence anti-mutant leg)', async () => {
		// Plan-critic round 1 (F5): a numeric task id whose bundle also holds
		// a phase artifact must NOT be exempted by the marker. Task id 9 is
		// not in the plan, so the check must report ❌ naming 9 — marker-only
		// classification would wrongly hide a real bundle.
		const numeric = path.join(dir, '.swarm', 'evidence', '9');
		mkdirSync(numeric, { recursive: true });
		writeFileSync(
			path.join(numeric, 'evidence.json'),
			JSON.stringify({ taskId: '9' }),
		);
		writeFileSync(path.join(numeric, 'sast-baseline.json'), '{}');

		const data = await getDiagnoseData(dir);
		const check = data.checks.find(
			(entry) => entry.name === 'Orphaned Evidence',
		);
		expect(check).toBeDefined();
		expect(check?.status).toBe('❌');
		expect(check?.detail).toContain('9');
	});

	test('a bare numeric dir WITHOUT a marker stays a task id (GREEN at base and after the fix — marker-gate anti-mutant leg)', async () => {
		// Final-critic round 1 (surviving-mutant closure), corrected round 2:
		// the marker gate is what distinguishes a phase directory from a
		// numeric task id — a mutant returning true for ANY numeric name must
		// go red here. The dir deliberately carries NEITHER a bundle
		// (evidence.json would hit the bundle-precedence check first, which
		// the sibling legs already pin) NOR a phase artifact — only a plain
		// non-marker file, so the numeric branch's marker gate is the sole
		// decider.
		const numeric = path.join(dir, '.swarm', 'evidence', '42');
		mkdirSync(numeric, { recursive: true });
		writeFileSync(path.join(numeric, 'notes.txt'), 'plain task note\n');

		const data = await getDiagnoseData(dir);
		const check = data.checks.find(
			(entry) => entry.name === 'Orphaned Evidence',
		);
		expect(check).toBeDefined();
		expect(check?.status).toBe('❌');
		expect(check?.detail).toContain('42');
	});

	test('named derived dir carrying a real evidence.json bundle stays a task id (GREEN at base and after the fix — precedence anti-mutant leg)', async () => {
		// F5 precedence applied to the named set with the EXACT derived name
		// (plan-critic round 2, finding 5): a directory literally named
		// gate-audit that holds a real task bundle must outrank the
		// derived-name exemption and stay enumerated — reported as an orphan
		// here because no plan task carries that id.
		const named = path.join(dir, '.swarm', 'evidence', 'gate-audit');
		writeFileSync(
			path.join(named, 'evidence.json'),
			JSON.stringify({ taskId: 'gate-audit' }),
		);

		const data = await getDiagnoseData(dir);
		const check = data.checks.find(
			(entry) => entry.name === 'Orphaned Evidence',
		);
		expect(check).toBeDefined();
		expect(check?.status).toBe('❌');
		expect(check?.detail).toContain('gate-audit');
	});
});
