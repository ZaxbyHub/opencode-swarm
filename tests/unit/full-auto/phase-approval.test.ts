/**
 * Unit tests for src/full-auto/phase-approval.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { verifyFullAutoPhaseApproval } from '../../../src/full-auto/phase-approval';
import {
	saveFullAutoRunState,
	startFullAutoRun,
} from '../../../src/full-auto/state';

let tmpDir: string;

function makeConfig(enabled: boolean, failClosed = true): PluginConfig {
	return {
		full_auto: {
			enabled,
			fail_closed: failClosed,
			mode: 'supervised',
		},
	} as unknown as PluginConfig;
}

function writeEvidence(
	tmp: string,
	phase: number,
	event: Record<string, unknown>,
	seq = 1,
): void {
	const dir = path.join(tmp, '.swarm', 'evidence', String(phase));
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, `full-auto-${seq}.json`),
		JSON.stringify(event),
		'utf-8',
	);
}

beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'full-auto-phase-')),
	);
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

describe('verifyFullAutoPhaseApproval', () => {
	test('no-op when full_auto disabled', () => {
		const r = verifyFullAutoPhaseApproval(tmpDir, 'sess', 1, makeConfig(false));
		expect(r.ok).toBe(true);
	});

	test('no-op when no Full-Auto run is active', () => {
		const r = verifyFullAutoPhaseApproval(tmpDir, 'sess', 1, makeConfig(true));
		expect(r.ok).toBe(true);
	});

	test('blocks when active Full-Auto and no evidence', () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		const r = verifyFullAutoPhaseApproval(
			tmpDir,
			'sess-1',
			1,
			makeConfig(true),
		);
		expect(r.ok).toBe(false);
		expect(r.reason).toContain('no full-auto oversight evidence');
	});

	test('passes with fresh APPROVED phase-boundary evidence', () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		writeEvidence(tmpDir, 2, {
			type: 'full_auto_oversight',
			phase: 2,
			verdict: 'APPROVED',
			trigger_source: 'phase_boundary',
			timestamp: new Date().toISOString(),
			evidence_checked: ['diff', 'test_impact'],
		});
		const r = verifyFullAutoPhaseApproval(
			tmpDir,
			'sess-1',
			2,
			makeConfig(true),
		);
		expect(r.ok).toBe(true);
		expect(r.evidence?.verdict).toBe('APPROVED');
	});

	test('blocks when APPROVED phase-boundary evidence omits phase field', () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		writeEvidence(tmpDir, 12, {
			type: 'full_auto_oversight',
			verdict: 'APPROVED',
			trigger_source: 'phase_boundary',
			timestamp: new Date().toISOString(),
			evidence_checked: ['diff'],
		});
		const r = verifyFullAutoPhaseApproval(
			tmpDir,
			'sess-1',
			12,
			makeConfig(true),
		);
		expect(r.ok).toBe(false);
		expect(r.reason).toContain('no phase-boundary oversight record found');
	});

	test('blocks on stale evidence (>24h)', () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
		writeEvidence(tmpDir, 3, {
			type: 'full_auto_oversight',
			phase: 3,
			verdict: 'APPROVED',
			trigger_source: 'phase_boundary',
			timestamp: stale,
			evidence_checked: ['diff'],
		});
		const r = verifyFullAutoPhaseApproval(
			tmpDir,
			'sess-1',
			3,
			makeConfig(true),
		);
		expect(r.ok).toBe(false);
		expect(r.reason).toContain('stale');
	});

	test('blocks on REJECTED verdict', () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		writeEvidence(tmpDir, 4, {
			type: 'full_auto_oversight',
			phase: 4,
			verdict: 'REJECTED',
			trigger_source: 'phase_boundary',
			timestamp: new Date().toISOString(),
			evidence_checked: ['diff'],
		});
		const r = verifyFullAutoPhaseApproval(
			tmpDir,
			'sess-1',
			4,
			makeConfig(true),
		);
		expect(r.ok).toBe(false);
	});

	test('blocks on NEEDS_REVISION verdict', () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		writeEvidence(tmpDir, 5, {
			type: 'full_auto_oversight',
			phase: 5,
			verdict: 'NEEDS_REVISION',
			trigger_source: 'phase_boundary',
			timestamp: new Date().toISOString(),
		});
		const r = verifyFullAutoPhaseApproval(
			tmpDir,
			'sess-1',
			5,
			makeConfig(true),
		);
		expect(r.ok).toBe(false);
	});

	test('passes when fail_closed=false and no evidence', () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		const r = verifyFullAutoPhaseApproval(
			tmpDir,
			'sess-1',
			6,
			makeConfig(true, false),
		);
		expect(r.ok).toBe(true);
	});

	test('Turbo does not bypass: gate runs on fresh active session and blocks without evidence', () => {
		// Even if Turbo were active in the runtime, this gate consults durable
		// Full-Auto state and the evidence dir directly. Without evidence the
		// answer is not-ok.
		startFullAutoRun(tmpDir, 'sess-turbo', { enabled: true });
		const r = verifyFullAutoPhaseApproval(
			tmpDir,
			'sess-turbo',
			7,
			makeConfig(true),
		);
		expect(r.ok).toBe(false);
	});

	// TASK 5: enforce evidence_checked
	test('APPROVED phase_boundary with evidence_checked: [] blocks for normal phase', () => {
		startFullAutoRun(tmpDir, 'sess-ec', { enabled: true });
		writeEvidence(tmpDir, 8, {
			type: 'full_auto_oversight',
			phase: 8,
			verdict: 'APPROVED',
			trigger_source: 'phase_boundary',
			timestamp: new Date().toISOString(),
			evidence_checked: [],
		});
		const r = verifyFullAutoPhaseApproval(
			tmpDir,
			'sess-ec',
			8,
			makeConfig(true),
		);
		expect(r.ok).toBe(false);
		expect(r.reason).toMatch(/evidence_checked/);
	});

	test('APPROVED phase_boundary with evidence_checked missing blocks', () => {
		startFullAutoRun(tmpDir, 'sess-em', { enabled: true });
		writeEvidence(tmpDir, 9, {
			type: 'full_auto_oversight',
			phase: 9,
			verdict: 'APPROVED',
			trigger_source: 'phase_boundary',
			timestamp: new Date().toISOString(),
			// evidence_checked omitted entirely
		});
		const r = verifyFullAutoPhaseApproval(
			tmpDir,
			'sess-em',
			9,
			makeConfig(true),
		);
		expect(r.ok).toBe(false);
	});

	test('APPROVED phase_boundary with evidence_checked: ["diff"] passes', () => {
		startFullAutoRun(tmpDir, 'sess-ef', { enabled: true });
		writeEvidence(tmpDir, 10, {
			type: 'full_auto_oversight',
			phase: 10,
			verdict: 'APPROVED',
			trigger_source: 'phase_boundary',
			timestamp: new Date().toISOString(),
			evidence_checked: ['diff'],
		});
		const r = verifyFullAutoPhaseApproval(
			tmpDir,
			'sess-ef',
			10,
			makeConfig(true),
		);
		expect(r.ok).toBe(true);
	});

	test('non-code phase exception passes only when plan.json marks the phase non-code', () => {
		startFullAutoRun(tmpDir, 'sess-nc', { enabled: true });
		// Plan.json marks phase 11 as docs/non-code.
		fs.writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			JSON.stringify({
				phases: [{ id: 11, kind: 'docs' }],
			}),
		);
		writeEvidence(tmpDir, 11, {
			type: 'full_auto_oversight',
			phase: 11,
			verdict: 'APPROVED',
			trigger_source: 'phase_boundary',
			timestamp: new Date().toISOString(),
			evidence_checked: [],
		});
		const r = verifyFullAutoPhaseApproval(
			tmpDir,
			'sess-nc',
			11,
			makeConfig(true),
		);
		expect(r.ok).toBe(true);
		expect(r.reason).toMatch(/non-code phase exception/);
	});

	test('non-code phase exception still requires no observed code work', () => {
		// Even though plan.json marks the phase as non-code, if the run-state
		// counters show coderDelegations > 0, the exception is denied — code
		// work was performed and demands evidence.
		const state = startFullAutoRun(tmpDir, 'sess-mix', { enabled: true });
		state.counters.coderDelegations = 1;
		saveFullAutoRunState(tmpDir, state);

		fs.writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			JSON.stringify({ phases: [{ id: 12, kind: 'docs' }] }),
		);
		writeEvidence(tmpDir, 12, {
			type: 'full_auto_oversight',
			phase: 12,
			verdict: 'APPROVED',
			trigger_source: 'phase_boundary',
			timestamp: new Date().toISOString(),
			evidence_checked: [],
		});
		const r = verifyFullAutoPhaseApproval(
			tmpDir,
			'sess-mix',
			12,
			makeConfig(true),
		);
		expect(r.ok).toBe(false);
	});
});
