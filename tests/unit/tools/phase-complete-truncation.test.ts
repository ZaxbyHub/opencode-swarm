/**
 * Verification test for phase-complete truncation behavior (F-002)
 *
 * Tests that when output exceeds MAX_OUTPUT_BYTES (512KB), the returned JSON
 * is always valid and contains _truncated: true marker.
 */

import { describe, expect, it } from 'bun:test';
import {
	_buildOutputJson,
	MAX_OUTPUT_BYTES,
} from '../../../src/tools/phase-complete.js';

describe('phase-complete truncation behavior', () => {
	describe('output serialization and truncation', () => {
		it('returns valid JSON with _truncated:true when output exceeds MAX_OUTPUT_BYTES', () => {
			// Build a result object large enough to exceed 512KB when serialized
			// Each agent name is ~50 chars, so 15000 agents = ~750KB of agent data alone
			const largeAgentNames = Array.from(
				{ length: 15_000 },
				(_, i) =>
					`agent_${i.toString().padStart(5, '0')}_with_a_very_long_name_that_adds_up`,
			);
			const largeWarnings = Array.from(
				{ length: 5_000 },
				(_, i) =>
					`This is warning number ${i} with enough text to really bulk up the output size`,
			);

			// This matches the structure of PhaseCompleteResult
			const result = {
				success: true,
				phase: 1,
				message: 'Phase 1 completed',
				agentsDispatched: largeAgentNames,
				agentsMissing: [],
				status: 'success' as const,
				warnings: largeWarnings,
			};

			const event = { timestamp: '2024-01-01T00:00:00.000Z' };
			const durationMs = 12345;

			const outputData = {
				...result,
				timestamp: event.timestamp,
				duration_ms: durationMs,
			};

			// Call the REAL production function
			const json = _buildOutputJson(outputData);

			// Verify the raw output exceeds the limit
			expect(JSON.stringify(outputData, null, 2).length).toBeGreaterThan(
				MAX_OUTPUT_BYTES,
			);

			// F-002: Verify output is valid JSON
			let parsed: Record<string, unknown>;
			expect(() => {
				parsed = JSON.parse(json);
			}).not.toThrow();
			expect(parsed).toBeDefined();

			// F-002: Verify _truncated marker is present
			expect(parsed!['_truncated']).toBe(true);

			// F-002: Verify _truncation_reason contains MAX_OUTPUT_BYTES value
			expect(parsed!['_truncation_reason']).toContain(
				MAX_OUTPUT_BYTES.toString(),
			);

			// Verify truncated agentsDispatched is limited to 10 items
			expect(Array.isArray(parsed!['agentsDispatched'])).toBe(true);
			expect((parsed!['agentsDispatched'] as unknown[]).length).toBe(10);

			// Verify warnings are replaced with truncation notice
			expect(Array.isArray(parsed!['warnings'])).toBe(true);
			expect((parsed!['warnings'] as string[]).length).toBe(1);
			expect((parsed!['warnings'] as string[])[0]).toContain('truncated');
		});

		it('returns small output unchanged (below MAX_OUTPUT_BYTES)', () => {
			const result = {
				success: true,
				phase: 1,
				message: 'Phase 1 completed',
				agentsDispatched: ['agent_1', 'agent_2'],
				agentsMissing: [],
				status: 'success' as const,
				warnings: [],
			};

			const event = { timestamp: '2024-01-01T00:00:00.000Z' };
			const durationMs = 123;

			const outputData = {
				...result,
				timestamp: event.timestamp,
				duration_ms: durationMs,
			};

			// Call the REAL production function
			const json = _buildOutputJson(outputData);

			// Should NOT be truncated
			expect(json.length).toBeLessThan(MAX_OUTPUT_BYTES);

			// Verify valid JSON
			const parsed = JSON.parse(json);
			expect(parsed).toBeDefined();
			expect(parsed['_truncated']).toBeUndefined();
			expect(parsed['agentsDispatched']).toEqual(['agent_1', 'agent_2']);
		});

		it('truncation reason includes the actual MAX_OUTPUT_BYTES value', () => {
			// This test verifies the _truncation_reason contains the specific limit
			// Need large enough data to actually trigger truncation
			const result = {
				success: true,
				phase: 1,
				message: 'Test',
				agentsDispatched: Array.from(
					{ length: 15_000 },
					(_, i) => `agent_${i.toString().padStart(5, '0')}_with_extra_padding`,
				),
				agentsMissing: [],
				status: 'success' as const,
				warnings: Array.from({ length: 5_000 }, (_, i) =>
					`Warning ${i}`.padEnd(100, 'x'),
				),
			};

			const outputData = {
				...result,
				timestamp: '2024-01-01T00:00:00.000Z',
				duration_ms: 0,
			};

			// Call the REAL production function
			const json = _buildOutputJson(outputData);

			// Verify it actually triggers truncation
			expect(JSON.stringify(outputData, null, 2).length).toBeGreaterThan(
				MAX_OUTPUT_BYTES,
			);

			const parsed = JSON.parse(json);
			// Verify the reason contains 512000
			expect(parsed['_truncation_reason']).toContain('512000');
			expect(parsed['_truncation_reason']).toContain('MAX_OUTPUT_BYTES');
		});
	});
});
