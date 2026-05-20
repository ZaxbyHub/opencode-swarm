/**
 * Tests for injection budget defaults in system-enhancer.ts.
 *
 * Verifies that tryInject respects the 4000 token default cap
 * when context_budget config is absent or empty.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSystemEnhancerHook } from '../../../src/hooks/system-enhancer.js';
import { resetSwarmState } from '../../../src/state.js';

describe('Injection budget default', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'swarm-test-'));
		resetSwarmState();
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it('default 4000 token cap is enforced when context_budget is absent', async () => {
		const swarmDir = join(tempDir, '.swarm');
		await mkdir(swarmDir, { recursive: true });
		const planContent = `
# Project Plan

## Phase 1: Setup [IN PROGRESS]
- [ ] 1.1: Initial task
`;
		await writeFile(join(swarmDir, 'plan.md'), planContent);
		// 600 decision lines to exceed 4000 token budget
		const decisions = Array.from(
			{ length: 600 },
			(_, i) =>
				`- Decision ${i}: Use TypeScript strict mode with exactOptionalPropertyTypes`,
		).join('\n');
		await writeFile(
			join(swarmDir, 'context.md'),
			`## Decisions\n${decisions}\n## Agent Activity\n- coder: no tool activity`,
		);

		const config = {
			hooks: {
				system_enhancer: true,
				agent_activity: true,
				agent_awareness_max_chars: 300,
				compaction: true,
				delegation_tracker: false,
			},
		} as any;
		const hook = createSystemEnhancerHook(config, tempDir);
		const transform = hook['experimental.chat.system.transform'] as any;
		const output = { system: [''] };
		await transform({ sessionID: 'test-session' }, output);

		// All injected content should be within budget (~4000 tokens = ~12121 chars, use 4500 buffer)
		const injected = output.system.slice(1).join('\n');
		const tokens = Math.ceil(injected.length * 0.33);
		expect(tokens).toBeLessThanOrEqual(4500);
	});

	it('empty context_budget object uses 4000 default', async () => {
		const swarmDir = join(tempDir, '.swarm');
		await mkdir(swarmDir, { recursive: true });
		const planContent = `
# Project Plan

## Phase 1: Setup [IN PROGRESS]
- [ ] 1.1: Initial task
`;
		await writeFile(join(swarmDir, 'plan.md'), planContent);
		const decisions = Array.from(
			{ length: 600 },
			(_, i) =>
				`- Decision ${i}: Use TypeScript strict mode with exactOptionalPropertyTypes`,
		).join('\n');
		await writeFile(
			join(swarmDir, 'context.md'),
			`## Decisions\n${decisions}\n## Agent Activity\n- coder: no tool activity`,
		);

		const config = {
			context_budget: {} as any,
			hooks: {
				system_enhancer: true,
				agent_activity: true,
				agent_awareness_max_chars: 300,
				compaction: true,
				delegation_tracker: false,
			},
		} as any;
		const hook = createSystemEnhancerHook(config, tempDir);
		const transform = hook['experimental.chat.system.transform'] as any;
		const output = { system: [''] };
		await transform({ sessionID: 'test-session' }, output);

		const injected = output.system.slice(1).join('\n');
		const tokens = Math.ceil(injected.length * 0.33);
		expect(tokens).toBeLessThanOrEqual(4500);
	});
});
