import { afterEach, describe, expect, test } from 'bun:test';
import { setPendingCoderScope } from '../../../src/hooks/delegation-gate';
import {
	_internals,
	createScopeGuardHook,
} from '../../../src/hooks/scope-guard';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import { installScopeGuardBindingSeam } from '../../helpers/scope-guard-binding-seam';

const directory = process.cwd();
let restoreBindingSeam = () => {};

function startCoder(sessionID: string, scope: string[] | null): void {
	startAgentSession(sessionID, 'coder');
	swarmState.activeAgent.set(sessionID, 'coder');
	const session = swarmState.agentSessions.get(sessionID);
	if (!session) throw new Error('session was not created');
	session.currentTaskId = '1.1';
	session.declaredCoderScope = scope;
	if (scope) setPendingCoderScope(directory, '1.1', scope);
}

afterEach(() => {
	restoreBindingSeam();
	restoreBindingSeam = () => {};
	resetSwarmState();
});

describe('scope guard shared write-target resolution — issue #1875', () => {
	test('fails closed on unverifiable nonarchitect writes even without scope', async () => {
		startCoder('unverifiable', null);
		const hook = createScopeGuardHook({ enabled: true }, directory);

		expect(
			hook.toolBefore(
				{ tool: 'apply_patch', sessionID: 'unverifiable', callID: 'call-1' },
				{ args: { patch: 'not a patch' } },
			),
		).rejects.toThrow('WRITE TARGET UNVERIFIABLE');
	});

	test('fails closed on resolved nonarchitect writes when scope is absent', async () => {
		startCoder('missing-scope', null);
		const hook = createScopeGuardHook({ enabled: true }, directory);
		expect(
			hook.toolBefore(
				{ tool: 'write', sessionID: 'missing-scope', callID: 'call-missing' },
				{ args: { path: 'src/missing.ts', content: 'export {}' } },
			),
		).rejects.toThrow('SCOPE_NOT_DECLARED');
	});

	test('blocks native patch payload targets outside declared scope', async () => {
		startCoder('patch-scope', ['src/hooks/']);
		restoreBindingSeam = installScopeGuardBindingSeam(_internals);
		const hook = createScopeGuardHook({ enabled: true }, directory);

		expect(
			hook.toolBefore(
				{ tool: 'apply_patch', sessionID: 'patch-scope', callID: 'call-2' },
				{
					args: {
						input:
							'*** Begin Patch\n*** Update File: src/tools/out.ts\n*** End Patch',
					},
				},
			),
		).rejects.toThrow('SCOPE VIOLATION');
	});

	test('uses final extract_code_blocks targets for scope checks', async () => {
		startCoder('extract-scope', ['docs/']);
		restoreBindingSeam = installScopeGuardBindingSeam(_internals);
		const hook = createScopeGuardHook({ enabled: true }, directory);

		expect(
			hook.toolBefore(
				{
					tool: 'extract_code_blocks',
					sessionID: 'extract-scope',
					callID: 'call-3',
				},
				{
					args: {
						content: '```typescript\n// filename: escaped.ts\nexport {};\n```',
						output_dir: 'src',
					},
				},
			),
		).rejects.toThrow('SCOPE VIOLATION');
	});
});
