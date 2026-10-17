import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { HooksConfigSchema } from '../../../src/config/schema';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import {
	createDelegationGateHook,
	makeConfig,
} from './_delegation-gate-helpers';

const DEFAULT_REQUIREMENT =
	'- Complete verification of changes, tests, and documentation';

describe('delegation-gate acceptance auto-injection', () => {
	let directory = '';
	let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;
	const SESSION_ID = 'test-session-autoinject';
	let callCounter = 0;

	beforeEach(async () => {
		isolatedEnv = createIsolatedTestEnv();
		resetSwarmState();
		directory = canonicalMkdtemp('swarm-autoinject-test-');
		await mkdir(join(directory, '.swarm'), { recursive: true });
		// Project-boundary marker. createIsolatedTestEnv redirects HOME, so on a
		// host whose real home holds .swarm + .opencode the fixture dir would be
		// claimed by that home project and the reviewer-route receipt write would
		// throw, returning from toolBefore before the acceptance gate runs.
		await mkdir(join(directory, '.opencode'), { recursive: true });
	});

	afterEach(async () => {
		resetSwarmState();
		if (directory) {
			await rm(directory, { recursive: true, force: true });
		}
		isolatedEnv?.cleanup();
		isolatedEnv = undefined;
	});

	function makeHook(autoInject: boolean | undefined) {
		return createDelegationGateHook(
			makeConfig(
				autoInject === undefined
					? undefined
					: { hooks: { auto_inject_acceptance: autoInject } },
			),
			directory,
		);
	}

	async function dispatch(
		hook: ReturnType<typeof makeHook>,
		args: Record<string, unknown>,
	): Promise<Error | undefined> {
		callCounter += 1;
		try {
			await hook.toolBefore(
				{
					tool: 'Task',
					sessionID: SESSION_ID,
					callID: `autoinject-call-${callCounter}`,
				},
				{ args },
			);
			return undefined;
		} catch (error) {
			return error as Error;
		}
	}

	describe('schema', () => {
		test('defaults to false and accepts an explicit opt-in', () => {
			expect(HooksConfigSchema.parse({}).auto_inject_acceptance).toBe(false);
			expect(
				HooksConfigSchema.parse({ auto_inject_acceptance: true })
					.auto_inject_acceptance,
			).toBe(true);
		});
	});

	describe('flag on', () => {
		test('coder dispatch with no ACCEPTANCE gets a marked default block and passes the acceptance gate', async () => {
			ensureAgentSession(SESSION_ID, 'architect', directory);
			const args = {
				subagent_type: 'coder',
				prompt: 'Implement the feature on branch feat/xyz',
			};

			const error = await dispatch(makeHook(true), args);

			// The acceptance gate passed: the dispatch is stopped by the NEXT gate
			// (no plan/scope in this fixture), never by ACCEPTANCE_FIELD_REQUIRED.
			expect(error?.message).toContain('SCOPE_NOT_DECLARED');
			expect(error?.message).not.toContain('ACCEPTANCE_FIELD_REQUIRED');
			expect(args.prompt).toBe(
				`Implement the feature on branch feat/xyz\n\nACCEPTANCE:\n${DEFAULT_REQUIREMENT} (auto-injected default: no task-specific acceptance criteria were supplied)\n`,
			);
		});

		test('reviewer dispatch with an empty ACCEPTANCE header gets the default under the header', async () => {
			const session = ensureAgentSession(SESSION_ID, 'architect', directory);
			const args = {
				subagent_type: 'reviewer',
				prompt: 'Review the changes\nACCEPTANCE:\n',
			};

			const error = await dispatch(makeHook(true), args);

			expect(error).toBeUndefined();
			expect(args.prompt).toContain(`ACCEPTANCE:\n${DEFAULT_REQUIREMENT}`);
			// The advisory carries the validator reason that triggered the injection.
			expect(
				(session.pendingAdvisoryMessages ?? []).some((m) =>
					m.includes('(acceptance_field_empty)'),
				),
			).toBe(true);
		});

		test('an explicit ACCEPTANCE block is left byte-identical', async () => {
			ensureAgentSession(SESSION_ID, 'architect', directory);
			const original = 'Review the changes\nACCEPTANCE: FR-001 holds\n';
			const args = { subagent_type: 'reviewer', prompt: original };

			const error = await dispatch(makeHook(true), args);

			expect(error).toBeUndefined();
			expect(args.prompt).toBe(original);
		});

		test('an empty header in a non-prompt field is filled in that field, not appended to prompt', async () => {
			ensureAgentSession(SESSION_ID, 'architect', directory);
			const args = {
				subagent_type: 'reviewer',
				prompt: 'Review the changes',
				description: 'ACCEPTANCE:',
			};

			const error = await dispatch(makeHook(true), args);

			expect(error).toBeUndefined();
			expect(args.prompt).toBe('Review the changes');
			expect(args.description).toContain(`ACCEPTANCE:\n${DEFAULT_REQUIREMENT}`);
		});

		test('a header followed by a non-breaking space counts as empty and is filled', async () => {
			ensureAgentSession(SESSION_ID, 'architect', directory);
			const args = {
				subagent_type: 'reviewer',
				prompt: 'Review the changes\nACCEPTANCE: \n',
			};

			const error = await dispatch(makeHook(true), args);

			expect(error).toBeUndefined();
			expect(args.prompt).toContain(`ACCEPTANCE:\n${DEFAULT_REQUIREMENT}`);
			expect(args.prompt).not.toContain(' ');
		});

		test('CRLF line endings are preserved when filling an empty header', async () => {
			ensureAgentSession(SESSION_ID, 'architect', directory);
			const args = {
				subagent_type: 'reviewer',
				prompt: 'Review\r\nACCEPTANCE:\r\nCONSTRAINT: none',
			};

			const error = await dispatch(makeHook(true), args);

			expect(error).toBeUndefined();
			const prompt = args.prompt;
			expect(prompt.startsWith('Review\r\nACCEPTANCE:\r\n- Complete')).toBe(
				true,
			);
			expect(prompt.endsWith('\r\nCONSTRAINT: none')).toBe(true);
			// No bare LF was introduced into a CRLF prompt.
			expect(prompt.replace(/\r\n/g, '')).not.toContain('\n');
		});

		test('with no prompt, the block is appended to the first string field', async () => {
			ensureAgentSession(SESSION_ID, 'architect', directory);
			const args = {
				subagent_type: 'reviewer',
				description: 'Review the changes',
			};

			const error = await dispatch(makeHook(true), args);

			expect(error).toBeUndefined();
			expect(args).not.toHaveProperty('prompt');
			expect(args.description).toContain(`ACCEPTANCE:\n${DEFAULT_REQUIREMENT}`);
		});

		test('a lowercase acceptance: header is recognised and filled (validator is case-insensitive)', async () => {
			ensureAgentSession(SESSION_ID, 'architect', directory);
			const args = {
				subagent_type: 'reviewer',
				prompt: 'Review the changes\nacceptance:\n',
			};

			const error = await dispatch(makeHook(true), args);

			expect(error).toBeUndefined();
			expect(args.prompt).toContain(`acceptance:\n${DEFAULT_REQUIREMENT}`);
			expect(args.prompt).not.toContain('ACCEPTANCE:');
		});

		test.each([
			['U+2028', 'ACCEPTANCE: keepme\n'],
			['a lone CR', 'ACCEPTANCE:\rkeepme\n'],
		] as const)('a line the validator does not treat as a header (%s) is never rewritten', async (_label, nonHeaderLine) => {
			ensureAgentSession(SESSION_ID, 'architect', directory);
			const args = {
				subagent_type: 'reviewer',
				prompt: `${nonHeaderLine}ACCEPTANCE:\n`,
			};

			const error = await dispatch(makeHook(true), args);

			expect(error).toBeUndefined();
			// The text after the non-header "ACCEPTANCE:" survives untouched; the real
			// (second) empty header is the one that is filled.
			expect(args.prompt).toBe(
				`${nonHeaderLine}ACCEPTANCE:\n${DEFAULT_REQUIREMENT} (auto-injected default: no task-specific acceptance criteria were supplied)\n`,
			);
		});

		test('with an empty header in two fields only the first (validator order) is filled', async () => {
			ensureAgentSession(SESSION_ID, 'architect', directory);
			const args = {
				subagent_type: 'reviewer',
				prompt: 'ACCEPTANCE:',
				description: 'ACCEPTANCE:',
			};

			const error = await dispatch(makeHook(true), args);

			expect(error).toBeUndefined();
			expect(args.prompt).toContain(`ACCEPTANCE:\n${DEFAULT_REQUIREMENT}`);
			expect(args.description).toBe('ACCEPTANCE:');
		});

		test('a missing header is appended to prompt and other text fields are left untouched', async () => {
			ensureAgentSession(SESSION_ID, 'architect', directory);
			const args = {
				subagent_type: 'reviewer',
				prompt: 'Review',
				description: 'desc',
			};

			const error = await dispatch(makeHook(true), args);

			expect(error).toBeUndefined();
			expect(args.prompt).toContain(`ACCEPTANCE:\n${DEFAULT_REQUIREMENT}`);
			expect(args.description).toBe('desc');
		});

		test('without a prompt, the first text field (not the last) receives the block', async () => {
			ensureAgentSession(SESSION_ID, 'architect', directory);
			const args = {
				subagent_type: 'reviewer',
				description: 'desc',
				task: 'tsk',
			};

			const error = await dispatch(makeHook(true), args);

			expect(error).toBeUndefined();
			expect(args.description).toContain(`ACCEPTANCE:\n${DEFAULT_REQUIREMENT}`);
			expect(args.task).toBe('tsk');
		});

		test('an injection that does not satisfy the gate is rolled back, rejected, and not announced', async () => {
			const session = ensureAgentSession(SESSION_ID, 'architect', directory);
			// The validator joins fields with "\n", so the lone-CR prompt line reads
			// as an empty header whose "next line" is the description's header: the
			// dispatch is still empty after the (description) fill.
			const args = {
				subagent_type: 'reviewer',
				prompt: 'ACCEPTANCE:\r',
				description: 'ACCEPTANCE:',
			};

			const error = await dispatch(makeHook(true), args);

			expect(error?.message).toContain('ACCEPTANCE_FIELD_REQUIRED');
			expect(args.prompt).toBe('ACCEPTANCE:\r');
			expect(args.description).toBe('ACCEPTANCE:');
			expect(
				(session.pendingAdvisoryMessages ?? []).some((m) =>
					m.includes('ACCEPTANCE AUTO-INJECTED'),
				),
			).toBe(false);
		});

		test('with no string field at all nothing is fabricated and the gate still rejects', async () => {
			const session = ensureAgentSession(SESSION_ID, 'architect', directory);
			const args: Record<string, unknown> = { subagent_type: 'reviewer' };

			const error = await dispatch(makeHook(true), args);

			expect(error?.message).toContain('ACCEPTANCE_FIELD_REQUIRED');
			expect(args).toEqual({ subagent_type: 'reviewer' });
			// toEqual ignores keys whose value is undefined; a rollback that wrote
			// one (for example args["null"]) must not slip through.
			expect(Object.keys(args)).toEqual(['subagent_type']);
			expect(
				(session.pendingAdvisoryMessages ?? []).some((m) =>
					m.includes('ACCEPTANCE AUTO-INJECTED'),
				),
			).toBe(false);
		});

		test('an empty header only the cross-field join can see is rejected and left untouched (issue 3381 AC3 will revisit)', async () => {
			// The validator joins fields with a newline, so description "ACCEPTANCE:\r"
			// plus the next field reads as a CRLF-terminated empty header, while the
			// per-field injector sees no header line in any single field. The strict
			// rejection stands and no field is changed, even though prompt exists.
			const session = ensureAgentSession(SESSION_ID, 'architect', directory);
			const args = {
				subagent_type: 'reviewer',
				prompt: 'Review',
				description: 'ACCEPTANCE:\r',
				task: 'TASK: x',
			};

			const error = await dispatch(makeHook(true), args);

			expect(error?.message).toContain('ACCEPTANCE_FIELD_REQUIRED');
			expect(args.prompt).toBe('Review');
			expect(args.description).toBe('ACCEPTANCE:\r');
			expect(args.task).toBe('TASK: x');
			expect(
				(session.pendingAdvisoryMessages ?? []).some((m) =>
					m.includes('ACCEPTANCE AUTO-INJECTED'),
				),
			).toBe(false);
		});

		test('the advisory names the field that actually received the block', async () => {
			const session = ensureAgentSession(SESSION_ID, 'architect', directory);
			const args = {
				subagent_type: 'reviewer',
				description: 'Review the changes',
			};

			const error = await dispatch(makeHook(true), args);

			expect(error).toBeUndefined();
			expect(
				(session.pendingAdvisoryMessages ?? []).some((m) =>
					m.includes('wrote a generic default into description'),
				),
			).toBe(true);
		});

		test('an injection from a session that is not registered still succeeds (no advisory, no throw)', async () => {
			// No ensureAgentSession(): the dispatching session is unknown to the
			// swarm state, so there is nowhere to queue the advisory.
			const args = { subagent_type: 'reviewer', prompt: 'Review the changes' };

			const error = await dispatch(makeHook(true), args);

			expect(error).toBeUndefined();
			expect(args.prompt).toContain(`ACCEPTANCE:\n${DEFAULT_REQUIREMENT}`);
			expect(args.prompt).toContain('(auto-injected default:');
			// toolBefore registers the session later in the same call; it must not
			// have been handed an advisory for an injection made before that.
			expect(
				(
					swarmState.agentSessions.get(SESSION_ID)?.pendingAdvisoryMessages ??
					[]
				).some((m) => m.includes('ACCEPTANCE AUTO-INJECTED')),
			).toBe(false);
		});

		test('a successful injection queues a model-visible advisory on the dispatching session', async () => {
			const session = ensureAgentSession(SESSION_ID, 'architect', directory);
			const args = { subagent_type: 'reviewer', prompt: 'Review the changes' };

			const error = await dispatch(makeHook(true), args);

			expect(error).toBeUndefined();
			const advisories = session.pendingAdvisoryMessages ?? [];
			expect(
				advisories.some(
					(m) =>
						m.includes('ACCEPTANCE AUTO-INJECTED') &&
						m.includes('acceptance_field_missing'),
				),
			).toBe(true);
		});
	});

	describe('flag off (default)', () => {
		test.each([
			['unset', undefined],
			['explicit false', false],
		] as const)('%s keeps the strict rejection and does not touch args', async (_label, flag) => {
			const session = ensureAgentSession(SESSION_ID, 'architect', directory);
			const args = {
				subagent_type: 'reviewer',
				prompt: 'Review the changes\nACCEPTANCE:\n',
			};
			const original = args.prompt;

			const error = await dispatch(makeHook(flag), args);

			expect(error?.message).toContain('ACCEPTANCE_FIELD_REQUIRED');
			expect(args.prompt).toBe(original);
			expect(session.pendingAdvisoryMessages ?? []).toEqual([]);
		});
	});
});
