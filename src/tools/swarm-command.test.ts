import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import type { AgentDefinition } from '../agents/index.js';
import { _internals as reviewCommandInternals } from '../commands/review.js';
import { resolveAutoReviewConfig } from '../config/schema.js';
import type { ReviewModelDispatcher } from '../review/contracts.js';
import type { RunReviewEngineInput } from '../review/engine.js';
import * as swarmCommandModule from './swarm-command.js';
import { createSwarmCommandTool } from './swarm-command.js';

let tmpDir: string;
const originalRunReviewEngine = reviewCommandInternals.runReviewEngine;

beforeEach(() => {
	tmpDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'swarm-command-')));
});

afterEach(() => {
	reviewCommandInternals.runReviewEngine = originalRunReviewEngine;
	rmSync(tmpDir, { recursive: true, force: true });
});

function toolContext(): ToolContext {
	return {
		directory: tmpDir,
		sessionID: 'session-1',
	} as unknown as ToolContext;
}

function agents(): Record<string, AgentDefinition> {
	return {
		Standard_architect: {
			name: 'Standard_architect',
			config: { model: 'openai/gpt-5.5-pro' },
		},
		Standard_coder: {
			name: 'Standard_coder',
			config: { model: 'opencode/minimax-m2.5-free' },
		},
		Standard_reviewer: {
			name: 'Standard_reviewer',
			config: { model: 'openai/reviewer-model' },
		},
		Standard_critic_finding_validator: {
			name: 'Standard_critic_finding_validator',
			config: { model: 'anthropic/validator-model' },
		},
	};
}

describe('swarm_command tool', () => {
	test('exports a static singleton for registration conformance', () => {
		expect('swarm_command' in swarmCommandModule).toBe(true);
		expect(swarmCommandModule.swarm_command).toBeDefined();
	});

	test('returns canonical agents output using the runtime agent map', async () => {
		const tool = createSwarmCommandTool(agents());

		const result = await tool.execute(
			{ command: 'agents', args: [] },
			toolContext(),
		);

		expect(String(result)).toContain('## Registered Agents');
		expect(String(result)).toContain('Standard_architect');
		expect(String(result)).toContain('Standard_coder');
	});

	test('allows config doctor only in scan mode', async () => {
		const tool = createSwarmCommandTool(agents());

		const scan = await tool.execute(
			{ command: 'config doctor', args: [] },
			toolContext(),
		);
		const fix = await tool.execute(
			{ command: 'config doctor', args: ['--fix'] },
			toolContext(),
		);

		expect(String(scan)).toContain('Config Doctor');
		expect(String(fix)).toContain('not available through swarm_command');
	});

	test('allows approved diagnostic and status commands', async () => {
		const tool = createSwarmCommandTool(agents());

		for (const [command, expectedText] of [
			['status', 'No active swarm plan found.'],
			['sync-plan', '## Plan Sync Report'],
			['preflight', '## Preflight Report'],
			['diagnose', '## Swarm Health Check'],
			['doctor tools', '## Tool Doctor Report'],
		] as const) {
			const result = await tool.execute({ command, args: [] }, toolContext());
			expect(String(result)).not.toContain(
				'not available through the chat tool',
			);
			expect(String(result)).toContain(expectedText);
		}
	});

	test('refuses the human-only review command without dispatching', async () => {
		let captured: RunReviewEngineInput | undefined;
		reviewCommandInternals.runReviewEngine = async (input) => {
			captured = input;
			return {
				status: 'clean',
				blocked: false,
				message: 'Review scope is clean.',
				findings: [],
				blockingFindings: [],
				validationComplete: true,
				scopeHash: 'a'.repeat(64),
				modelCalls: 0,
			};
		};
		const dispatcher: ReviewModelDispatcher = {
			dispatch: async () => Promise.reject(new Error('not called')),
		};
		const config = resolveAutoReviewConfig({
			enabled: false,
			min_confidence: 0.8,
		});
		const tool = createSwarmCommandTool(
			agents(),
			undefined,
			dispatcher,
			config,
		);

		const result = await tool.execute(
			{ command: 'review', args: ['--working-tree'] },
			toolContext(),
		);

		expect(String(result)).toContain('human-only');
		expect(captured).toBeUndefined();
	});
});
