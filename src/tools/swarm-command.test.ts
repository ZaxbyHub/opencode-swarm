import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import type { AgentDefinition } from '../agents/index.js';
import * as swarmCommandModule from './swarm-command.js';
import { createSwarmCommandTool } from './swarm-command.js';

let tmpDir: string;

beforeEach(() => {
	tmpDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'swarm-command-')));
});

afterEach(() => {
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
	};
}

describe('swarm_command tool', () => {
	test('does not export a module-level singleton with an empty agent map', () => {
		expect('swarm_command' in swarmCommandModule).toBe(false);
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

	test('canonicalizes allowed aliases', async () => {
		const tool = createSwarmCommandTool(agents());

		const configDoctor = await tool.execute(
			{ command: 'config-doctor', args: [] },
			toolContext(),
		);
		const listAgents = await tool.execute(
			{ command: 'list-agents', args: [] },
			toolContext(),
		);

		expect(String(configDoctor)).toContain('Config Doctor');
		expect(String(listAgents)).toContain('## Registered Agents');
	});
});
