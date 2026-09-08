import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../tests/helpers/tmpdir';
import {
	createIncrementalVerifyHook,
	type IncrementalVerifyConfig,
} from './incremental-verify';

/**
 * Issue #2529: the incremental-verify hook must fire for the host's REAL task
 * tool id (lowercase `task`), not only the legacy capitalised `Task` fixture
 * spelling. Sibling of incremental-verify.test.ts (which is over the FR-006
 * 500-line cap and cannot grow).
 */

function makeConfig(overrides: Partial<IncrementalVerifyConfig> = {}) {
	return {
		enabled: true,
		// Same explicit passing command as the parent suite's PASS_CMD — an
		// explicit command avoids TS-project detection entirely.
		command: process.platform === 'win32' ? 'cmd /c exit 0' : 'true',
		timeoutMs: 5000,
		triggerAgents: ['coder'],
		...overrides,
	} satisfies IncrementalVerifyConfig;
}

function makeTsProject(dir: string) {
	fs.writeFileSync(
		path.join(dir, 'sample.ts'),
		'const answer: number = 42;\nexport default answer;\n',
	);
}

describe('incremental-verify fires for the host task tool id (#2529)', () => {
	let directory = '';
	const injected: { sessionId: string; message: string }[] = [];

	beforeEach(() => {
		directory = canonicalMkdtemp('incremental-verify-2529-');
		makeTsProject(directory);
		injected.length = 0;
	});

	afterEach(() => {
		try {
			fs.rmSync(directory, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	});

	test('fires after coder delegation dispatched with the host lowercase task id', async () => {
		const hook = createIncrementalVerifyHook(
			makeConfig(),
			directory,
			(sessionId, message) => {
				injected.push({ sessionId, message });
			},
		);
		await hook.toolAfter(
			{ tool: 'task', sessionID: 's1', args: { subagent_type: 'coder' } },
			{ output: 'done' },
		);
		expect(injected.length).toBeGreaterThanOrEqual(1);
	}, 30000);

	test('still fires for the legacy capitalised spelling', async () => {
		const hook = createIncrementalVerifyHook(
			makeConfig(),
			directory,
			(sessionId, message) => {
				injected.push({ sessionId, message });
			},
		);
		await hook.toolAfter(
			{ tool: 'Task', sessionID: 's1', args: { subagent_type: 'coder' } },
			{ output: 'done' },
		);
		expect(injected.length).toBeGreaterThanOrEqual(1);
	}, 30000);

	test('colon-namespaced id fires; dotted custom id does not', async () => {
		const hook = createIncrementalVerifyHook(
			makeConfig(),
			directory,
			(sessionId, message) => {
				injected.push({ sessionId, message });
			},
		);
		await hook.toolAfter(
			{
				tool: 'opencode:task',
				sessionID: 's1',
				args: { subagent_type: 'coder' },
			},
			{ output: 'done' },
		);
		expect(injected.length).toBeGreaterThanOrEqual(1);
		injected.length = 0;
		await hook.toolAfter(
			{ tool: 'notes.task', sessionID: 's1', args: { subagent_type: 'coder' } },
			{ output: 'done' },
		);
		expect(injected).toEqual([]);
	}, 30000);
});
