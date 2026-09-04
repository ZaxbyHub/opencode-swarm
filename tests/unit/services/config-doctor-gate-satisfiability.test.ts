/**
 * Config-doctor gate-satisfiability lint tests (issue #2470 / #2007).
 *
 * Every enabled evidence-requiring Lean Turbo gate must have its producer
 * tool in the registered tool set. Healthy build: no findings. If a producer
 * is ever unregistered while the gate stays default-true, the lint errors.
 */

import { describe, expect, test } from 'bun:test';
import type { PluginConfig } from '../../../src/config/schema';
import {
	collectLeanTurboGateSatisfiabilityFindings,
	LEAN_TURBO_GATE_PRODUCERS,
} from '../../../src/services/config-doctor';
import { TOOL_NAME_SET } from '../../../src/tools/tool-metadata';

const EMPTY_CONFIG = {} as PluginConfig;

describe('collectLeanTurboGateSatisfiabilityFindings (issue #2470/#2007)', () => {
	test('healthy build: all producers registered → no findings (defaults, no turbo block)', () => {
		const findings = collectLeanTurboGateSatisfiabilityFindings(
			EMPTY_CONFIG,
			TOOL_NAME_SET,
		);
		expect(findings).toEqual([]);
	});

	test('healthy build: explicit turbo.lean config with all gates enabled → no findings', () => {
		const config = {
			turbo: {
				lean: {
					phase_critic: true,
					phase_reviewer: true,
					integrated_diff_required: true,
				},
			},
		} as unknown as PluginConfig;
		expect(
			collectLeanTurboGateSatisfiabilityFindings(config, TOOL_NAME_SET),
		).toEqual([]);
	});

	test('missing producer: registry set without lean_turbo_critic → error naming the gate and evidence path', () => {
		const shrunken = new Set(TOOL_NAME_SET);
		shrunken.delete('lean_turbo_critic');
		const findings = collectLeanTurboGateSatisfiabilityFindings(
			EMPTY_CONFIG,
			shrunken,
		);
		expect(findings.length).toBe(1);
		expect(findings[0].severity).toBe('error');
		expect(findings[0].id).toBe('lean-turbo-gate-unsatisfiable-phase_critic');
		expect(findings[0].description).toContain('lean_turbo_critic');
		expect(findings[0].description).toContain(
			'.swarm/evidence/{phase}/lean-turbo-critic.json',
		);
	});

	test('missing producer: registry set without lean_turbo_review → phase_reviewer error', () => {
		const shrunken = new Set(TOOL_NAME_SET);
		shrunken.delete('lean_turbo_review');
		const findings = collectLeanTurboGateSatisfiabilityFindings(
			EMPTY_CONFIG,
			shrunken,
		);
		expect(findings.length).toBe(1);
		expect(findings[0].id).toBe('lean-turbo-gate-unsatisfiable-phase_reviewer');
	});

	test('disabled gate does not require its producer', () => {
		const shrunken = new Set(TOOL_NAME_SET);
		shrunken.delete('lean_turbo_critic');
		const config = {
			turbo: { lean: { phase_critic: false } },
		} as unknown as PluginConfig;
		expect(
			collectLeanTurboGateSatisfiabilityFindings(config, shrunken),
		).toEqual([]);
	});

	test('the producer registry covers every evidence-requiring lean turbo gate', () => {
		// phase_critic, phase_reviewer, integrated_diff_required — the gates
		// verifyLeanTurboPhaseReady enforces against evidence files.
		expect(LEAN_TURBO_GATE_PRODUCERS.map((e) => e.gate).sort()).toEqual([
			'integrated_diff_required',
			'phase_critic',
			'phase_reviewer',
		]);
		for (const entry of LEAN_TURBO_GATE_PRODUCERS) {
			expect(entry.producerTool.length).toBeGreaterThan(0);
			expect(entry.evidencePathConvention).toContain('.swarm/evidence/');
		}
	});
});
