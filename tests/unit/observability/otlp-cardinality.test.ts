/**
 * OTLP exporter cardinality tests (issue #2485 / #2049 item 8): the exported
 * attribute-key set is CLOSED (pinned tables + swarm.* enum); high-cardinality
 * producer payloads can never widen it; ID-bearing values only travel through
 * the mapped correlation fields.
 */
import { describe, expect, test } from 'bun:test';
import {
	OPENINFERENCE_ATTRIBUTES,
	OTEL_GENAI_ATTRIBUTES,
} from '../../../src/observability/otel-mapping.js';
import {
	projectOtlpAttributes,
} from '../../../src/observability/otlp-exporter.js';
import { createObservation } from '../../../src/observability/observe.js';

const SWARM_EXTENSION_KEYS = new Set([
	'swarm.event.kind',
	'swarm.event.category',
	'swarm.event.severity',
	'swarm.outcome.status',
	'swarm.outcome.duration_ms',
]);

function closedKeySet(convention: 'genai' | 'openinference'): Set<string> {
	return new Set([
		...Object.values(
			convention === 'genai'
				? OTEL_GENAI_ATTRIBUTES
				: OPENINFERENCE_ATTRIBUTES,
		),
		...SWARM_EXTENSION_KEYS,
	]);
}

describe('attribute key set closure', () => {
	test('both conventions project only their pinned table plus the swarm.* enum', () => {
		for (const convention of ['genai', 'openinference'] as const) {
			const allowed = closedKeySet(convention);
			for (const kind of [
				'delegation_begin',
				'delegation_begin',
				'session_started',
				'phase_complete_gate_passed',
			]) {
				const attrs = projectOtlpAttributes(
					createObservation(kind, {
						tokens_input: 1,
						sessionId: 'card-1',
						taskId: 'card-task',
						model: 'cm',
					}),
					convention,
				);
				for (const key of Object.keys(attrs)) {
					expect(allowed.has(key)).toBe(true);
				}
			}
		}
	});
});

describe('cardinality attack: producer payloads cannot widen the export', () => {
	test('many distinct payload keys never become attribute keys', () => {
		const hostilePayload: Record<string, unknown> = {
			tokens_input: 7,
			model: 'card-model',
		};
		for (let i = 0; i < 200; i++) {
			hostilePayload[`dynamic_key_${i}`] = `dynamic_value_${i}`;
		}
		const attrs = projectOtlpAttributes(
			createObservation('delegation_begin', hostilePayload),
			'genai',
		);
		expect(Object.keys(attrs).length).toBeLessThanOrEqual(
			closedKeySet('genai').size,
		);
		const serialized = JSON.stringify(attrs);
		expect(serialized.includes('dynamic_key_0')).toBe(false);
		expect(serialized.includes('dynamic_value_199')).toBe(false);
	});

	test('unknown/unrecognized event kinds still cannot inject keys', () => {
		const attrs = projectOtlpAttributes(
			createObservation('totally_unknown_kind_xyz' as never, {
				sessionId: 's',
				anything: 'else',
			}),
			'openinference',
		);
		const allowed = closedKeySet('openinference');
		for (const key of Object.keys(attrs)) {
			expect(allowed.has(key)).toBe(true);
		}
		// Unrecognized kinds classify as 'unrecognized' category (envelope
		// contract) and still export structural swarm.* fields only.
		expect(attrs['swarm.event.kind']).toBe('totally_unknown_kind_xyz');
	});

	test('per-emit key-count is stable across wildly different payloads (bounded set)', () => {
		const lean = Object.keys(
			projectOtlpAttributes(
				createObservation('delegation_begin', {}),
				'genai',
			),
		).length;
		const rich = Object.keys(
			projectOtlpAttributes(
				createObservation('delegation_begin', {
					tokens_input: 1,
					tokens_output: 2,
					tokens_cache: 3,
					tokens_reasoning: 4,
					cost_usd: 0.5,
					model: 'm',
					agentName: 'a',
					sessionId: 's',
				}),
				'genai',
			),
		).length;
		expect(rich).toBeLessThanOrEqual(closedKeySet('genai').size);
		expect(lean).toBeLessThanOrEqual(rich);
	});
});
