import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { recordPendingDelegation } from '../../../src/background/pending-delegations.js';
import {
	activatePrWorkflow,
	enforcePrWorkflowToolBefore,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	createPrWorkflowSessionResolver,
	resolvePrWorkflowControllerSession,
} from '../../../src/hooks/pr-workflow-session-resolver.js';

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => fs.rm(directory, { recursive: true, force: true })),
	);
});

async function tempDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(
		path.join(os.tmpdir(), 'pr-session-resolver-'),
	);
	directories.push(directory);
	return directory;
}

describe('PR workflow child-session controller resolution', () => {
	test('maps a created coder child back to the parent durable gate', async () => {
		const directory = await tempDirectory();
		await activatePrWorkflow(directory, 'parent-session', 'PR_FEEDBACK');
		const get = mock(async () => ({ data: {}, error: undefined }));
		const resolver = createPrWorkflowSessionResolver({
			directory,
			client: { session: { get } },
		});
		resolver.observeEvent({
			event: {
				type: 'session.created',
				properties: {
					info: { id: 'coder-child', parentID: 'parent-session' },
				},
			},
		});

		const controllerSessionID = await resolver.resolve('coder-child');
		expect(controllerSessionID).toBe('parent-session');
		await expect(
			enforcePrWorkflowToolBefore(directory, controllerSessionID, 'shell', {
				command: 'git push origin HEAD',
			}),
		).rejects.toThrow(/publication is not armed/);
		expect(get).not.toHaveBeenCalled();
	});

	test('recovers ancestry from the session API after plugin restart', async () => {
		const directory = await tempDirectory();
		await activatePrWorkflow(directory, 'parent-session', 'PR_FEEDBACK');
		const get = mock(async ({ path: requestPath }: any) => ({
			data:
				requestPath.id === 'grandchild'
					? { id: 'grandchild', parentID: 'coder-child' }
					: { id: 'coder-child', parentID: 'parent-session' },
			error: undefined,
		}));
		const resolver = createPrWorkflowSessionResolver({
			directory,
			client: { session: { get } },
		});

		expect(await resolver.resolve('grandchild')).toBe('parent-session');
		expect(get).toHaveBeenCalledTimes(2);
	});

	test('leaves unrelated sessions isolated', async () => {
		const directory = await tempDirectory();
		await activatePrWorkflow(directory, 'parent-session', 'PR_FEEDBACK');
		const resolver = createPrWorkflowSessionResolver({
			directory,
			client: {
				session: {
					get: mock(async () => ({
						data: { id: 'ordinary' },
						error: undefined,
					})),
				},
			},
		});

		expect(await resolver.resolve('ordinary')).toBe('ordinary');
	});

	test('does not require a host session API when ancestry events are available', async () => {
		const directory = await tempDirectory();
		await activatePrWorkflow(directory, 'parent-session', 'PR_REVIEW');
		const resolver = createPrWorkflowSessionResolver({ directory });
		resolver.observeEvent({
			event: {
				type: 'session.created',
				properties: {
					info: { id: 'reviewer-child', parentID: 'parent-session' },
				},
			},
		});

		expect(await resolver.resolve('reviewer-child')).toBe('parent-session');
	});
});

describe('resolvePrWorkflowControllerSession — typed observation walk (issue #2511)', () => {
	const readDurableGate = (directory: string) => (sessionID: string) =>
		readPrWorkflowGateState(directory, sessionID);

	async function recordParent(
		directory: string,
		correlationId: string,
		parentSessionId: string,
	): Promise<void> {
		await recordPendingDelegation(directory, {
			correlationId,
			jobId: null,
			subagentSessionId: correlationId,
			parentSessionId,
			callID: `${correlationId}-call`,
			normalizedAgent: 'explorer',
			swarmPrefixedAgent: 'explorer',
			planTaskId: null,
			evidenceTaskId: null,
		});
	}

	test('first-hop host fallback resolves the direct-controller case', async () => {
		const directory = await tempDirectory();
		await activatePrWorkflow(directory, 'controller-session', 'PR_FEEDBACK');
		// host-child has NO durable correlation record — only the host knows its
		// parent. The fallback is allowed exactly here (first hop).
		const get = mock(async ({ path: requestPath }: any) => ({
			data:
				requestPath.id === 'host-child'
					? { id: 'host-child', parentID: 'controller-session' }
					: { id: requestPath.id },
			error: undefined,
		}));

		const outcome = await resolvePrWorkflowControllerSession({
			directory,
			sessionID: 'host-child',
			client: { session: { get } },
			readGate: readDurableGate(directory),
		});

		expect(outcome.kind).toBe('gate-owner');
		if (outcome.kind === 'gate-owner') {
			expect(outcome.sessionID).toBe('controller-session');
			expect(outcome.gate.mode).toBe('PR_FEEDBACK');
		}
		expect(get).toHaveBeenCalledTimes(1);
	});

	test('missing non-first hop stays uncertain BEFORE any host fallback is consulted', async () => {
		const directory = await tempDirectory();
		// chain-child -> chain-mid record exists; chain-mid has NO record and NO
		// gate. The host client WOULD claim chain-mid's parent is
		// 'host-invented-parent' (which even owns a gate) — consulting it at a
		// non-first hop would paper a broken chain into a resolved gate owner.
		await recordParent(directory, 'chain-child', 'chain-mid');
		await activatePrWorkflow(directory, 'host-invented-parent', 'PR_REVIEW');
		const get = mock(async () => ({
			data: { parentID: 'host-invented-parent' },
			error: undefined,
		}));

		const outcome = await resolvePrWorkflowControllerSession({
			directory,
			sessionID: 'chain-child',
			client: { session: { get } },
			readGate: readDurableGate(directory),
		});

		expect(outcome.kind).toBe('uncertain');
		if (outcome.kind === 'uncertain') {
			expect(outcome.sessionID).toBeNull();
		}
		// The discriminator: the host fallback must never be consulted for the
		// non-first hop. A wrongly-allowed fallback would resolve the walk to
		// gate-owner 'host-invented-parent'.
		expect(get).not.toHaveBeenCalled();
	});

	test('correlation cycle resolves to typed uncertainty without hanging', async () => {
		const directory = await tempDirectory();
		await recordParent(directory, 'cyc-a', 'cyc-b');
		await recordParent(directory, 'cyc-b', 'cyc-a');

		const outcome = await resolvePrWorkflowControllerSession({
			directory,
			sessionID: 'cyc-a',
			readGate: readDurableGate(directory),
		});

		expect(outcome.kind).toBe('uncertain');
		if (outcome.kind === 'uncertain') expect(outcome.sessionID).toBeNull();
	});

	test('a throwing readGate resolves to typed uncertain, never propagates', async () => {
		const directory = await tempDirectory();
		// FIX-6 (review P-005): before the try/catch around `options.readGate`,
		// a gate reader that THREW (corrupt or unreadable gate record) aborted
		// the whole observation walk and propagated the raw error to the caller
		// instead of honoring the typed contract — the exact "store uncertainty,
		// not a walk abort" case the uncertain variant exists for.
		const outcome = await resolvePrWorkflowControllerSession({
			directory,
			sessionID: 'gate-read-fails',
			readGate: async () => {
				throw new Error('gate record is corrupt');
			},
		});

		expect(outcome).toEqual({ kind: 'uncertain', sessionID: null });
	});

	test('no linkage at the first hop is an ordinary gate-less session, not uncertainty', async () => {
		const directory = await tempDirectory();
		const get = mock(async () => ({
			data: { id: 'lone-session' },
			error: undefined,
		}));

		const outcome = await resolvePrWorkflowControllerSession({
			directory,
			sessionID: 'lone-session',
			client: { session: { get } },
			readGate: readDurableGate(directory),
		});

		expect(outcome).toEqual({ kind: 'no-gate', sessionID: 'lone-session' });
	});
});
