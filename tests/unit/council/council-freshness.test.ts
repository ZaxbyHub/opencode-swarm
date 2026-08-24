/**
 * Issue #2102 contract D — centralized council freshness evaluator.
 */

import { describe, expect, test } from 'bun:test';
import {
	DEFAULT_FRESHNESS_MAX_AGE_MS,
	evaluateCouncilFreshness,
	resolveCouncilFreshnessMaxAgeMs,
} from '../../../src/council/council-freshness';
import type { CouncilConfig } from '../../../src/council/types';

const NOW = Date.parse('2026-08-23T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

describe('evaluateCouncilFreshness', () => {
	test('fresh evidence within the window passes', () => {
		const result = evaluateCouncilFreshness({
			nowMs: NOW,
			timestampMs: NOW - 2 * HOUR,
			maxAgeMs: 24 * HOUR,
		});
		expect(result.ok).toBe(true);
		expect(result.reason).toBeUndefined();
	});

	test.each([
		['missing timestamp', null],
		['unparseable timestamp', Number.NaN],
	])('%s fails closed with invalid_timestamp', (_name, timestampMs) => {
		const result = evaluateCouncilFreshness({
			nowMs: NOW,
			timestampMs: timestampMs as number | null,
			maxAgeMs: 24 * HOUR,
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('invalid_timestamp');
		expect(result.recovery.length).toBeGreaterThan(0);
	});

	test('future timestamp fails closed', () => {
		const result = evaluateCouncilFreshness({
			nowMs: NOW,
			timestampMs: NOW + HOUR,
			maxAgeMs: 24 * HOUR,
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('future_timestamp');
	});

	test('evidence older than the policy window fails closed', () => {
		const result = evaluateCouncilFreshness({
			nowMs: NOW,
			timestampMs: NOW - 25 * HOUR,
			maxAgeMs: 24 * HOUR,
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('stale_evidence');
	});

	test('evidence predating a later required input fails even when young', () => {
		const result = evaluateCouncilFreshness({
			nowMs: NOW,
			timestampMs: NOW - HOUR,
			maxAgeMs: 24 * HOUR,
			mustPostdateMs: NOW - 30 * 60 * 1000,
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('predates_required_input');
	});

	test('a future-dated required input fails closed with the distinct skew reason (PRR-014)', () => {
		const result = evaluateCouncilFreshness({
			nowMs: NOW,
			timestampMs: NOW - HOUR,
			maxAgeMs: 24 * HOUR,
			mustPostdateMs: NOW + HOUR,
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('invalid_required_input');
		expect(result.message).toContain('future');
	});

	test('null mustPostdateMs imposes no ordering constraint', () => {
		const result = evaluateCouncilFreshness({
			nowMs: NOW,
			timestampMs: NOW - HOUR,
			maxAgeMs: 24 * HOUR,
			mustPostdateMs: null,
		});
		expect(result.ok).toBe(true);
	});
});

describe('resolveCouncilFreshnessMaxAgeMs', () => {
	test('default is 24 hours with undefined config', () => {
		expect(resolveCouncilFreshnessMaxAgeMs(undefined)).toBe(
			DEFAULT_FRESHNESS_MAX_AGE_MS,
		);
	});

	test('explicit config value is honored', () => {
		const config = {
			enabled: true,
			maxRounds: 3,
			parallelTimeoutMs: 30_000,
			vetoPriority: true,
			requireAllMembers: false,
			minimumMembers: 3,
			phaseConcernsAllowComplete: true,
			finalCompletionPolicy: { mode: 'all_required' as const },
			freshnessMaxAgeHours: 48,
		} satisfies CouncilConfig;
		expect(resolveCouncilFreshnessMaxAgeMs(config)).toBe(48 * HOUR);
	});

	test('invalid values fail closed to the 24h default', () => {
		expect(
			resolveCouncilFreshnessMaxAgeMs({
				freshnessMaxAgeHours: 0,
			} as CouncilConfig),
		).toBe(DEFAULT_FRESHNESS_MAX_AGE_MS);
	});
});
