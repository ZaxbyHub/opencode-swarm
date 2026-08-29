/**
 * #2107 §2 (final-critic finding): every string the system-enhancer pushes
 * to output.system must be attributed EXACTLY ONCE in the turn ledger's
 * system-surface accounting. The closed push-site set is: tryInject (counted
 * in system-enhancer's injectedTokens), the two budget-warning direct pushes
 * (also injectedTokens), the linked-cohort line (its own producer), and the
 * spec-drift advisory (its own producer). The invariant under test: the sum
 * of ALL system-surface ledger emissions equals the canonical estimate of the
 * strings actually present in output.system — no string double-attributed,
 * none missing.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import {
	_test_exports,
	createSystemEnhancerHook,
} from '../../../src/hooks/system-enhancer';
import { estimateTokens } from '../../../src/hooks/utils';
import {
	beginTurnLedger,
	clearTurnLedger,
	getTurnLedgerSummary,
} from '../../../src/services/injection-budget';
import { resetSwarmState } from '../../../src/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const SESSION = 'ledger-attribution-session';

const PLAN_JSON = JSON.stringify({
	schema_version: '1.0.0',
	swarm: 'attribution-test',
	title: 'Attribution Test',
	current_phase: 1,
	phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
});

function makeConfig(): PluginConfig {
	return {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		context_budget: {
			enabled: true,
			warn_threshold: 0.7,
			critical_threshold: 0.9,
			model_limits: { default: 100_000 },
		},
	} as PluginConfig;
}

describe('system-enhancer ledger attribution — exact-once system surface (#2107 §2)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('se-attribution-');
		const swarmDir = path.join(tempDir, '.swarm');
		mkdirSync(swarmDir, { recursive: true });
		writeFileSync(path.join(swarmDir, 'plan.json'), PLAN_JSON);
		writeFileSync(
			path.join(swarmDir, 'plan.md'),
			'# Plan\n\n## Phase 1: Setup [IN PROGRESS]\n- [ ] 1.1 task\n',
		);
		writeFileSync(path.join(swarmDir, 'context.md'), '# Context\n');
		resetSwarmState();
		clearTurnLedger(SESSION);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		resetSwarmState();
		clearTurnLedger(SESSION);
	});

	test('Σ system-surface ledger emissions == estimate of every output.system string (exact once)', async () => {
		const hook = createSystemEnhancerHook(makeConfig(), tempDir);
		const transform = hook['experimental.chat.system.transform'] as (
			input: { sessionID?: string },
			output: { system: string[] },
		) => Promise<void>;
		const output = { system: ['seeded base prompt'] as string[] };
		await transform({ sessionID: SESSION }, output);

		expect(output.system.length).toBeGreaterThan(1); // injections happened
		const ledger = getTurnLedgerSummary(SESSION);
		expect(ledger).not.toBeNull();
		const systemSurfaceEmitted = (ledger?.producers ?? [])
			.filter((p) => p.surface === 'system')
			.reduce((sum, p) => sum + p.emitted, 0);

		const measured = output.system.reduce(
			(sum, text) => sum + estimateTokens(text),
			0,
		);
		// The seeded base prompt is NOT produced by the plugin (the host owns
		// it), so subtract its estimate from the measured side.
		const seeded = estimateTokens(output.system[0] ?? '');
		expect(systemSurfaceEmitted).toBe(measured - seeded);
	});

	test('the per-turn ledger begins BEFORE the first possible system injection', async () => {
		// The linked-cohort line is the earliest system-surface push; with no
		// link configured it is skipped, but the ledger must exist by the time
		// ANY injection could run. Driving one normal turn and asserting a
		// system-enhancer producer exists proves the begin ran before the
		// injection phase (an emission cannot be recorded into a ledger that
		// was begun later than the producer's finally — more importantly, the
		// ordering is pinned structurally by the source-scan test; here we pin
		// the behavioral consequence: attribution sums hold even though the
		// begin precedes the FR-002 pre-allocation).
		const hook = createSystemEnhancerHook(makeConfig(), tempDir);
		const transform = hook['experimental.chat.system.transform'] as (
			input: { sessionID?: string },
			output: { system: string[] },
		) => Promise<void>;
		const output = { system: [] as string[] };
		await transform({ sessionID: SESSION }, output);
		const se = getTurnLedgerSummary(SESSION)?.producers.find(
			(p) => p.producer === 'system-enhancer',
		);
		expect(se?.emitted).toBeGreaterThan(0);
		expect(se?.surface).toBe('system');
	});

	test('spec-drift advisory records its own emission exactly once (direct helper drive)', () => {
		const output = { system: [] as string[] };
		const plan = {
			_specStale: true,
			_specStaleReason: 'spec.md changed since plan was saved',
		} as never;
		_test_exports.maybeAppendSpecDriftAdvisory(output, tempDir, plan, SESSION);
		expect(output.system).toHaveLength(1);
		const advisory = output.system[0] as string;
		clearTurnLedger(SESSION);
		beginTurnLedger(SESSION, 4000, false);
		_test_exports.maybeAppendSpecDriftAdvisory(output, tempDir, plan, SESSION);
		const producer = getTurnLedgerSummary(SESSION)?.producers.find(
			(p) => p.producer === 'spec-drift-advisory',
		);
		expect(producer?.emitted).toBe(estimateTokens(advisory));
		expect(producer?.surface).toBe('system');
		// No system-enhancer emission for the same bytes → no double attribution.
		const se = getTurnLedgerSummary(SESSION)?.producers.find(
			(p) => p.producer === 'system-enhancer',
		);
		expect(se).toBeUndefined();
	});

	test('spec-drift helper without a session records nothing and does not throw', () => {
		const output = { system: [] as string[] };
		const plan = { _specStale: true } as never;
		beginTurnLedger(SESSION, 4000, false);
		expect(() =>
			_test_exports.maybeAppendSpecDriftAdvisory(output, tempDir, plan),
		).not.toThrow();
		expect(output.system).toHaveLength(1);
		expect(
			getTurnLedgerSummary(SESSION)?.producers.find(
				(p) => p.producer === 'spec-drift-advisory',
			),
		).toBeUndefined();
	});
});
