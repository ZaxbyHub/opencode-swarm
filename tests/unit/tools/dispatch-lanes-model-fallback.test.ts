import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getAgentConfigs } from '../../../src/agents/index.js';
import type { PluginConfig } from '../../../src/config/index.js';
import {
	_internals,
	executeDispatchLanes,
	executeDispatchLanesAsync,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes.js';

function makeTempDir(): string {
	const directory = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-lanes-model-fallback-')),
	);
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	return directory;
}

function seedReviewerFallback(): void {
	getAgentConfigs({
		agents: {
			reviewer: {
				model: 'prov/primary-reviewer',
				fallback_models: ['prov/fb1'],
			},
		},
	} as unknown as PluginConfig);
}

afterEach(() => {
	getAgentConfigs({ agents: {} } as unknown as PluginConfig);
});

describe('dispatch-lanes model fallback request wiring', () => {
	test('blocking lane passes the fallback model into the actual prompt body', async () => {
		seedReviewerFallback();
		const directory = makeTempDir();
		const seenModels: Array<
			| {
					providerID: string;
					modelID: string;
			  }
			| undefined
		> = [];
		const ops: SessionOps = {
			create: mock(async () => ({
				data: { id: 'session-1' },
				error: undefined,
			})),
			prompt: mock(async (input) => {
				seenModels.push(input.body.model);
				if (input.body.model?.modelID === 'primary-reviewer') {
					return {
						data: undefined,
						error: { message: '429 rate_limit_exceeded: too many requests' },
					};
				}
				return {
					data: {
						parts: [{ type: 'text' as const, text: 'review ok' }],
					},
					error: undefined,
				};
			}),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		const result = await executeDispatchLanes(
			{
				timeout_ms: 5_000,
				lanes: [{ id: 'r1', agent: 'reviewer', prompt: 'inspect this change' }],
			},
			directory,
		);

		expect(result.success).toBe(true);
		expect(seenModels).toEqual([
			{ providerID: 'prov', modelID: 'primary-reviewer' },
			{ providerID: 'prov', modelID: 'fb1' },
		]);
	});

	test('async lane passes the fallback model into the actual promptAsync body', async () => {
		seedReviewerFallback();
		const directory = makeTempDir();
		const seenModels: Array<
			| {
					providerID: string;
					modelID: string;
			  }
			| undefined
		> = [];
		const ops: SessionOps = {
			create: mock(async () => ({
				data: { id: 'session-async-1' },
				error: undefined,
			})),
			prompt: mock(async () => ({
				data: { parts: [{ type: 'text' as const, text: 'unused' }] },
				error: undefined,
			})),
			promptAsync: mock(async (input) => {
				seenModels.push(input.body.model);
				if (input.body.model?.modelID === 'primary-reviewer') {
					return {
						data: undefined,
						error: { message: '429 insufficient_quota: usage limit exceeded' },
					};
				}
				return { data: { accepted: true }, error: undefined };
			}),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		const result = await executeDispatchLanesAsync(
			{
				batch_id: 'batch-model-fallback',
				timeout_ms: 5_000,
				lanes: [{ id: 'r1', agent: 'reviewer', prompt: 'inspect this change' }],
			},
			directory,
		);

		expect(result.success).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(seenModels).toEqual([
			{ providerID: 'prov', modelID: 'primary-reviewer' },
			{ providerID: 'prov', modelID: 'fb1' },
		]);
	});
});
