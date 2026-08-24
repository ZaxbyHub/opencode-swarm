import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import {
	deleteStoredInputArgs,
	getStoredInputArgs,
} from '../../src/hooks/guardrails.js';
import {
	_test_exports,
	activatePrWorkflow,
} from '../../src/hooks/pr-workflow-gate.js';
import { resetSwarmState } from '../../src/state.js';
import {
	bootKnowledgeHost,
	createKnowledgeProject,
} from '../helpers/knowledge-real-host.js';

const SESSION_ID = 'pr-workflow-real-host';

describe('PR workflow gate uses the real SDK output.args boundary', () => {
	let directory: string;
	let plugin: Awaited<ReturnType<typeof bootKnowledgeHost>>;

	beforeEach(async () => {
		resetSwarmState();
		_test_exports.resetTrackedStateCache();
		directory = createKnowledgeProject();
		plugin = await bootKnowledgeHost(directory);
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
	});

	afterEach(() => {
		deleteStoredInputArgs('read-call');
		deleteStoredInputArgs('mutation-call');
		_test_exports.resetTrackedStateCache();
		resetSwarmState();
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Windows may briefly retain a plugin-init handle in the temp project.
		}
	});

	test('allows safe shell args and rejects mutating connector args supplied only through output.args', async () => {
		const before = plugin.hooks['tool.execute.before'];
		const after = plugin.hooks['tool.execute.after'];

		await expect(
			before(
				{ tool: 'shell', sessionID: SESSION_ID, callID: 'read-call' },
				{ args: { command: 'git status --short' } },
			),
		).resolves.toBeUndefined();
		try {
			expect(getStoredInputArgs('read-call')).toEqual({
				command: 'git status --short',
			});
		} finally {
			await after(
				{ tool: 'shell', sessionID: SESSION_ID, callID: 'read-call' },
				{ output: '' },
			);
		}

		await expect(
			before(
				{
					tool: 'mcp__github__get_pull_request',
					sessionID: SESSION_ID,
					callID: 'mutation-call',
				},
				{
					args: {
						owner: 'example',
						repo: 'project',
						method: 'POST',
						body: { title: 'mutated' },
					},
				},
			),
		).rejects.toThrow(/read-only.*method.*GET or HEAD/i);
	});
});
