import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	activatePrWorkflow,
	enforcePrWorkflowToolBefore,
} from '../../../src/hooks/pr-workflow-gate.js';
import { createPrWorkflowSessionResolver } from '../../../src/hooks/pr-workflow-session-resolver.js';

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
