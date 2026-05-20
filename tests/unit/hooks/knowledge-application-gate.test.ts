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
	knowledgeApplicationGateBefore,
	knowledgeApplicationTransformScan,
} from '../../../src/hooks/knowledge-application-gate';
import type { MessageWithParts } from '../../../src/hooks/knowledge-types';
import { swarmState } from '../../../src/state';

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

	it('returns silently in warn mode when sessionID is missing AND writes no event', async () => {
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A],
			generatedAt: Date.now(),
		});
		await mkdir(path.join(tmp, '.swarm'), { recursive: true });
		await knowledgeApplicationGateBefore(
			tmp,
			{ tool: 'save_plan', agent: 'architect' },
			{ ...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG, mode: 'warn' },
		);
		// give any fire-and-forget write a moment to land
		await new Promise((r) => setTimeout(r, 30));
		const eventsPath = path.join(tmp, '.swarm', 'events.jsonl');
		// Either the file does not exist OR it does not contain an entry
		// attributing this gate event to an unknown session.
		if (existsSync(eventsPath)) {
			const lines = readFileSync(eventsPath, 'utf-8').trim();
			expect(lines).toBe('');
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
});
