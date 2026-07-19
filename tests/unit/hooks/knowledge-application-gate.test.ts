/**
 * Tests for the v2 knowledge-application enforcement gate as wired into
 * runtime via knowledgeApplicationGateBefore + knowledgeApplicationTransformScan.
 *
 * Notes:
 *  - The gate consults swarmState.currentCriticalShownIds and
 *    swarmState.knowledgeAckDedup. Tests prime/clear them between cases.
 *  - In `enforce` mode the gate throws KNOWLEDGE_ENFORCE_GATE_DENY.
 *  - In `warn` mode the gate appends to .swarm/events.jsonl and returns.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	buildAckDedupKey,
	DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
	resolveApplicationLogPath,
} from '../../../src/hooks/knowledge-application';
import {
	_internals,
	knowledgeApplicationGateBefore,
	knowledgeApplicationTransformScan,
} from '../../../src/hooks/knowledge-application-gate';
import type { MessageWithParts } from '../../../src/hooks/knowledge-types';
import { swarmState } from '../../../src/state';
import { knowledge_receipt } from '../../../src/tools/knowledge-receipt';

let tmp: string;
beforeEach(() => {
	mock.restore();
	tmp = mkdtempSync(path.join(tmpdir(), 'swarm-gate-'));
	swarmState.currentCriticalShownIds.clear();
	swarmState.knowledgeAckDedup.clear();
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	mock.restore();
});

const ID_A = 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb';

describe('knowledgeApplicationGateBefore', () => {
	it('does nothing when disabled', async () => {
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A],
			generatedAt: Date.now(),
		});
		await knowledgeApplicationGateBefore(
			tmp,
			{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
			{
				...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
				enabled: false,
				mode: 'enforce',
			},
		);
		// no throw
	});

	it('does nothing for non-high-risk tool', async () => {
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A],
			generatedAt: Date.now(),
		});
		await knowledgeApplicationGateBefore(
			tmp,
			{ tool: 'search', agent: 'architect', sessionID: 's1' },
			{ ...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG, mode: 'enforce' },
		);
		// no throw
	});

	it('does nothing for non-architect agents', async () => {
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A],
			generatedAt: Date.now(),
		});
		await knowledgeApplicationGateBefore(
			tmp,
			{ tool: 'save_plan', agent: 'coder', sessionID: 's1' },
			{ ...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG, mode: 'enforce' },
		);
		// no throw — only architect is gated
	});

	it('does nothing when there are no shown critical ids in scope', async () => {
		await knowledgeApplicationGateBefore(
			tmp,
			{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
			{ ...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG, mode: 'enforce' },
		);
		// no throw
	});

	it('throws in enforce mode when sessionID is missing (contract violation)', async () => {
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A],
			generatedAt: Date.now(),
		});
		await expect(
			knowledgeApplicationGateBefore(
				tmp,
				{ tool: 'save_plan', agent: 'architect' },
				{ ...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG, mode: 'enforce' },
			),
		).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY.*missing sessionID/);
	});

	it('throws in enforce mode when sessionID is an empty string', async () => {
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A],
			generatedAt: Date.now(),
		});
		await expect(
			knowledgeApplicationGateBefore(
				tmp,
				{ tool: 'save_plan', agent: 'architect', sessionID: '' },
				{ ...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG, mode: 'enforce' },
			),
		).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY.*missing sessionID/);
	});

	it('returns silently in warn mode when sessionID is missing AND writes a warning event', async () => {
		const { _internals } = await import(
			'../../../src/hooks/knowledge-application-gate'
		);
		const origWriteWarnEvent = _internals.writeWarnEvent;
		const writeSpy = mock(() => Promise.resolve());
		_internals.writeWarnEvent = writeSpy;
		try {
			swarmState.currentCriticalShownIds.set('s1', {
				ids: [ID_A],
				generatedAt: Date.now(),
			});
			await knowledgeApplicationGateBefore(
				tmp,
				{ tool: 'save_plan', agent: 'architect' },
				{ ...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG, mode: 'warn' },
			);
			// gate must NOT throw
			expect(writeSpy).toHaveBeenCalledTimes(1);
			const call = writeSpy.mock.calls[0]!;
			expect(call[0]).toBe(tmp);
			expect(call[1]).toMatchObject({
				event: 'knowledge_application_gate_warn',
				tool: 'save_plan',
				reason: 'missing_sessionID',
			});
		} finally {
			// restore original so other tests are unaffected
			_internals.writeWarnEvent = origWriteWarnEvent;
			mock.restore();
		}
	});

	it('warn mode does not throw and writes events.jsonl', async () => {
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A, ID_B],
			generatedAt: Date.now(),
		});
		await mkdir(path.join(tmp, '.swarm'), { recursive: true });
		await knowledgeApplicationGateBefore(
			tmp,
			{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
			{ ...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG, mode: 'warn' },
		);
		// give the fire-and-forget write a moment
		await new Promise((r) => setTimeout(r, 30));
		const eventsPath = path.join(tmp, '.swarm', 'events.jsonl');
		expect(existsSync(eventsPath)).toBe(true);
		const body = readFileSync(eventsPath, 'utf-8');
		expect(body).toContain('knowledge_application_gate_warn');
		expect(body).toContain(ID_A);
	});

	it('enforce mode throws KNOWLEDGE_ENFORCE_GATE_DENY', async () => {
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A],
			generatedAt: Date.now(),
		});
		await expect(
			knowledgeApplicationGateBefore(
				tmp,
				{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
				{ ...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG, mode: 'enforce' },
			),
		).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);
	});

	it('enforce denial text lists all accepted terminal ack markers', async () => {
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A],
			generatedAt: Date.now(),
		});
		await expect(
			knowledgeApplicationGateBefore(
				tmp,
				{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
				{ ...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG, mode: 'enforce' },
			),
		).rejects.toThrow(
			/KNOWLEDGE_APPLIED.*KNOWLEDGE_IGNORED.*KNOWLEDGE_VIOLATED/,
		);
	});

	it('enforce mode allows when dedup set already records an ack for the id', async () => {
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A],
			generatedAt: Date.now(),
		});
		swarmState.knowledgeAckDedup.add(buildAckDedupKey('s1', ID_A, 'applied'));
		await knowledgeApplicationGateBefore(
			tmp,
			{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
			{ ...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG, mode: 'enforce' },
		);
		// no throw
	});

	it('enforce mode allows when ack is "ignored" (architect chose)', async () => {
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A],
			generatedAt: Date.now(),
		});
		swarmState.knowledgeAckDedup.add(buildAckDedupKey('s1', ID_A, 'ignored'));
		await knowledgeApplicationGateBefore(
			tmp,
			{ tool: 'phase_complete', agent: 'architect', sessionID: 's1' },
			{ ...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG, mode: 'enforce' },
		);
		// no throw
	});

	it('enforce mode allows when ack is "violated" (architect chose)', async () => {
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A],
			generatedAt: Date.now(),
		});
		swarmState.knowledgeAckDedup.add(buildAckDedupKey('s1', ID_A, 'violated'));
		await knowledgeApplicationGateBefore(
			tmp,
			{ tool: 'phase_complete', agent: 'architect', sessionID: 's1' },
			{ ...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG, mode: 'enforce' },
		);
		// no throw
	});

	it('regression GATE-002: prior-day ack still satisfies same-session gate', async () => {
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A],
			generatedAt: Date.now(),
		});
		swarmState.knowledgeAckDedup.add(
			buildAckDedupKey('s1', ID_A, 'applied', new Date('2024-01-01T00:00:00Z')),
		);

		await knowledgeApplicationGateBefore(
			tmp,
			{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
			{ ...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG, mode: 'enforce' },
		);
		// no throw
	});

	it('enforce mode blocks when SOME but not all critical ids are acked', async () => {
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A, ID_B],
			generatedAt: Date.now(),
		});
		swarmState.knowledgeAckDedup.add(buildAckDedupKey('s1', ID_A, 'applied'));
		// ID_B is not acked
		await expect(
			knowledgeApplicationGateBefore(
				tmp,
				{ tool: 'update_task_status', agent: 'architect', sessionID: 's1' },
				{ ...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG, mode: 'enforce' },
			),
		).rejects.toThrow(new RegExp(ID_B));
	});

	it('respects swarm-prefixed architect names', async () => {
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A],
			generatedAt: Date.now(),
		});
		await expect(
			knowledgeApplicationGateBefore(
				tmp,
				{ tool: 'save_plan', agent: 'paid_architect', sessionID: 's1' },
				{ ...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG, mode: 'enforce' },
			),
		).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);
	});

	it('gates Task delegations as well', async () => {
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A],
			generatedAt: Date.now(),
		});
		await expect(
			knowledgeApplicationGateBefore(
				tmp,
				{ tool: 'Task', agent: 'architect', sessionID: 's1' },
				{ ...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG, mode: 'enforce' },
			),
		).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);
	});

	it('uses config.high_risk_tools when provided instead of default set', async () => {
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A],
			generatedAt: Date.now(),
		});
		// Custom config: only 'custom_tool' is high-risk — NOT 'save_plan'
		const customConfig = {
			...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
			mode: 'enforce',
			high_risk_tools: ['custom_tool'],
		};
		// Gate MUST throw for 'custom_tool' (it's in the custom set)
		await expect(
			knowledgeApplicationGateBefore(
				tmp,
				{
					tool: 'custom_tool',
					agent: 'architect',
					sessionID: 's1',
				},
				customConfig,
			),
		).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);
		// Gate must NOT throw for 'save_plan' (it's NOT in the custom set)
		await knowledgeApplicationGateBefore(
			tmp,
			{
				tool: 'save_plan',
				agent: 'architect',
				sessionID: 's1',
			},
			customConfig,
		);
	});
});

describe('knowledgeApplicationTransformScan', () => {
	function archMessage(text: string, agent = 'architect'): MessageWithParts {
		return {
			info: { role: 'assistant', agent },
			parts: [{ type: 'text', text }],
		};
	}

	it('records inline acks and bumps dedup set', async () => {
		const out = {
			messages: [
				archMessage(
					`KNOWLEDGE_APPLIED: ${ID_A}\nKNOWLEDGE_IGNORED: ${ID_B} reason=not relevant`,
				),
			],
		};
		await knowledgeApplicationTransformScan(tmp, out, 's1');
		const dedup = swarmState.knowledgeAckDedup;
		expect(dedup.has(buildAckDedupKey('s1', ID_A, 'applied'))).toBe(true);
		expect(dedup.has(buildAckDedupKey('s1', ID_B, 'ignored'))).toBe(true);
		// audit log written
		expect(existsSync(resolveApplicationLogPath(tmp))).toBe(true);
	});

	it('does not double-record on a second transform pass with same text', async () => {
		const out = {
			messages: [archMessage(`KNOWLEDGE_APPLIED: ${ID_A}`)],
		};
		await knowledgeApplicationTransformScan(tmp, out, 's1');
		await knowledgeApplicationTransformScan(tmp, out, 's1');
		const log = readFileSync(resolveApplicationLogPath(tmp), 'utf-8')
			.trim()
			.split('\n');
		expect(log.length).toBe(1);
	});

	it('ignores non-architect messages', async () => {
		const out = {
			messages: [archMessage(`KNOWLEDGE_APPLIED: ${ID_A}`, 'coder')],
		};
		await knowledgeApplicationTransformScan(tmp, out, 's1');
		expect(existsSync(resolveApplicationLogPath(tmp))).toBe(false);
	});

	it('handles swarm-prefixed architect agent', async () => {
		const out = {
			messages: [archMessage(`KNOWLEDGE_APPLIED: ${ID_A}`, 'paid_architect')],
		};
		await knowledgeApplicationTransformScan(tmp, out, 's1');
		expect(
			swarmState.knowledgeAckDedup.has(buildAckDedupKey('s1', ID_A, 'applied')),
		).toBe(true);
	});

	it('no-op when sessionID missing', async () => {
		const out = { messages: [archMessage(`KNOWLEDGE_APPLIED: ${ID_A}`)] };
		await knowledgeApplicationTransformScan(tmp, out, undefined);
		expect(swarmState.knowledgeAckDedup.size).toBe(0);
	});

	describe('knowledge_receipt does NOT satisfy the enforcement gate', () => {
		it('does not populate knowledgeAckDedup when recording a receipt', async () => {
			const baselineSize = swarmState.knowledgeAckDedup.size;
			await knowledge_receipt.execute(
				{
					trace_id: 'trace-receipt-gate-test',
					applied: [
						{
							id: ID_A,
							how: 'used in plan review',
							evidence_files: ['src/agents/architect.ts'],
							verified_by: 'reviewer',
						},
					],
				} as never,
				{ directory: tmp, sessionID: 's1', agent: 'architect' },
			);
			// knowledge_receipt writes audit events only; it must NOT touch the
			// dedup set that the enforcement gate consults.
			expect(swarmState.knowledgeAckDedup.size).toBe(baselineSize);
			expect(
				swarmState.knowledgeAckDedup.has(
					buildAckDedupKey('s1', ID_A, 'applied'),
				),
			).toBe(false);
		});
	});
});

describe('gate escape hatches (#1690)', () => {
	beforeEach(() => {
		_internals.resetGateDenialCounts();
	});

	afterEach(() => {
		_internals.resetGateDenialCounts();
	});

	it('auto-clears after max_gate_denials exceeded (default 5)', async () => {
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A],
			generatedAt: Date.now(),
		});
		const cfg = { ...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG, mode: 'enforce' as const };

		// First 5 calls should throw
		for (let i = 0; i < 5; i++) {
			await expect(
				knowledgeApplicationGateBefore(
					tmp,
					{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
					cfg,
				),
			).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);
		}

		// 6th call should pass (escape hatch fires)
		await knowledgeApplicationGateBefore(
			tmp,
			{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
			cfg,
		);
		// no throw
	});

	it('respects custom max_gate_denials from config', async () => {
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A],
			generatedAt: Date.now(),
		});
		const cfg = {
			...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
			mode: 'enforce' as const,
			max_gate_denials: 2,
		};

		// First 2 calls throw
		await expect(
			knowledgeApplicationGateBefore(
				tmp,
				{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
				cfg,
			),
		).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);
		await expect(
			knowledgeApplicationGateBefore(
				tmp,
				{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
				cfg,
			),
		).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);

		// 3rd call passes
		await knowledgeApplicationGateBefore(
			tmp,
			{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
			cfg,
		);
	});

	it('auto-clears stale directives older than gate_staleness_ms', async () => {
		const staleTime = Date.now() - 700_000; // 700s ago > 600s default
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A],
			generatedAt: staleTime,
		});
		const cfg = { ...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG, mode: 'enforce' as const };

		// Should NOT throw — directive is stale
		await knowledgeApplicationGateBefore(
			tmp,
			{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
			cfg,
		);
	});

	it('respects custom gate_staleness_ms from config', async () => {
		const staleTime = Date.now() - 15_000; // 15s ago
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A],
			generatedAt: staleTime,
		});
		const cfg = {
			...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
			mode: 'enforce' as const,
			gate_staleness_ms: 10_000, // 10s staleness
		};

		// Should NOT throw — 15s > 10s
		await knowledgeApplicationGateBefore(
			tmp,
			{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
			cfg,
		);
	});

	it('still throws when within staleness threshold', async () => {
		const recentTime = Date.now() - 1_000; // 1s ago
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A],
			generatedAt: recentTime,
		});
		const cfg = { ...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG, mode: 'enforce' as const };

		await expect(
			knowledgeApplicationGateBefore(
				tmp,
				{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
				cfg,
			),
		).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);
	});

	it('populates knowledgeAckDedup after escape hatch fires', async () => {
		const staleTime = Date.now() - 700_000;
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A, ID_B],
			generatedAt: staleTime,
		});
		const cfg = { ...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG, mode: 'enforce' as const };

		await knowledgeApplicationGateBefore(
			tmp,
			{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
			cfg,
		);

		// Both IDs should now be in the dedup set as 'applied'
		expect(
			swarmState.knowledgeAckDedup.has(buildAckDedupKey('s1', ID_A, 'applied')),
		).toBe(true);
		expect(
			swarmState.knowledgeAckDedup.has(buildAckDedupKey('s1', ID_B, 'applied')),
		).toBe(true);
	});

	it('clears currentCriticalShownIds for session after escape hatch', async () => {
		const staleTime = Date.now() - 700_000;
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A],
			generatedAt: staleTime,
		});
		const cfg = { ...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG, mode: 'enforce' as const };

		await knowledgeApplicationGateBefore(
			tmp,
			{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
			cfg,
		);

		expect(swarmState.currentCriticalShownIds.has('s1')).toBe(false);
	});

	it('writes warning event to events.jsonl on staleness clear', async () => {
		const staleTime = Date.now() - 700_000;
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A],
			generatedAt: staleTime,
		});
		await mkdir(path.join(tmp, '.swarm'), { recursive: true });
		const cfg = { ...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG, mode: 'enforce' as const };

		await knowledgeApplicationGateBefore(
			tmp,
			{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
			cfg,
		);

		await new Promise((r) => setTimeout(r, 30));
		const eventsPath = path.join(tmp, '.swarm', 'events.jsonl');
		expect(existsSync(eventsPath)).toBe(true);
		const body = readFileSync(eventsPath, 'utf-8');
		expect(body).toContain('knowledge_application_gate_staleness_clear');
		expect(body).toContain(ID_A);
	});

	it('writes warning event to events.jsonl on denial limit clear', async () => {
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A],
			generatedAt: Date.now(),
		});
		await mkdir(path.join(tmp, '.swarm'), { recursive: true });
		const cfg = {
			...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
			mode: 'enforce' as const,
			max_gate_denials: 1,
		};

		// First call throws
		await expect(
			knowledgeApplicationGateBefore(
				tmp,
				{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
				cfg,
			),
		).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);

		// Second call triggers escape
		await knowledgeApplicationGateBefore(
			tmp,
			{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
			cfg,
		);

		await new Promise((r) => setTimeout(r, 30));
		const eventsPath = path.join(tmp, '.swarm', 'events.jsonl');
		expect(existsSync(eventsPath)).toBe(true);
		const body = readFileSync(eventsPath, 'utf-8');
		expect(body).toContain('knowledge_application_gate_denial_limit_clear');
	});

	it('denial counter resets after successful ack', async () => {
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A],
			generatedAt: Date.now(),
		});
		const cfg = {
			...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
			mode: 'enforce' as const,
			max_gate_denials: 3,
		};

		// Accumulate 2 denials
		await expect(
			knowledgeApplicationGateBefore(
				tmp,
				{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
				cfg,
			),
		).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);
		await expect(
			knowledgeApplicationGateBefore(
				tmp,
				{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
				cfg,
			),
		).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);

		// Simulate successful ack
		swarmState.knowledgeAckDedup.add(buildAckDedupKey('s1', ID_A, 'applied'));

		// This should pass (acked) and clear the counter
		await knowledgeApplicationGateBefore(
			tmp,
			{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
			cfg,
		);

		// Now remove ack and add new critical ID — counter should be fresh
		swarmState.knowledgeAckDedup.clear();
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_B],
			generatedAt: Date.now(),
		});

		// Should need full 3 denials again before escape
		await expect(
			knowledgeApplicationGateBefore(
				tmp,
				{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
				cfg,
			),
		).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);
		await expect(
			knowledgeApplicationGateBefore(
				tmp,
				{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
				cfg,
			),
		).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);
		await expect(
			knowledgeApplicationGateBefore(
				tmp,
				{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
				cfg,
			),
		).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);

		// 4th call passes (escape fires)
		await knowledgeApplicationGateBefore(
			tmp,
			{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
			cfg,
		);
	});
});
