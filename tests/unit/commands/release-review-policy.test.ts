import { expect, test } from 'bun:test';
import { createSwarmCommandHandler } from '../../../src/commands';
import { readPrWorkflowGateState } from '../../../src/hooks/pr-workflow-gate';
import { createSwarmCommandTool } from '../../../src/tools/swarm-command';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

test('release review rejects invalid typed and tool commands before activating', async () => {
	const directory = canonicalMkdtemp('release-review-policy-');
	const sessionID = 'release-review-policy';
	const url = 'https://github.com/example/project/pull/42';
	const head = 'a'.repeat(40);
	const flag = '--release-head';
	const architect = () => 'architect';
	const typed = createSwarmCommandHandler(
		directory,
		{},
		{
			getActiveAgentName: architect,
			registeredAgents: { architect: { tools: { swarm_command: true } } },
		},
	);
	const tool = (agent: () => string) =>
		createSwarmCommandTool(
			{},
			undefined,
			undefined,
			undefined,
			undefined,
			agent,
		);
	const context = { directory, sessionID } as Parameters<
		ReturnType<typeof tool>['execute']
	>[1];
	try {
		const architectTool = tool(architect);
		for (const args of [
			[url, flag],
			[url, flag, head, 'extra'],
			[url, flag, head.slice(1)],
			[url, flag, head.toUpperCase()],
			['https://gitlab.com/example/project/-/merge_requests/42', flag, head],
			[`${url}?from=link`, flag, head],
			[flag, url, head],
		]) {
			const result = await architectTool.execute(
				{ command: 'pr-review', args },
				context,
			);
			expect(result).toContain('Usage through swarm_command: pr-review');
			const output: { parts: { text?: string }[] } = { parts: [] };
			await typed(
				{
					command: 'swarm',
					arguments: ['pr-review', ...args].join(' '),
					sessionID,
				},
				output,
			);
			expect(output.parts[0]?.text).toContain(
				'Usage through swarm_command: pr-review',
			);
			await expect(
				readPrWorkflowGateState(directory, sessionID),
			).resolves.toBeNull();
		}
		const coder = tool(() => 'coder');
		const blocked = await coder.execute(
			{ command: 'pr-review', args: [url, flag, head] },
			context,
		);
		expect(blocked).toContain('BLOCKED: release review requires the architect');
		await expect(
			readPrWorkflowGateState(directory, sessionID),
		).resolves.toBeNull();
	} finally {
		safeRmRecursive(directory);
	}
});
