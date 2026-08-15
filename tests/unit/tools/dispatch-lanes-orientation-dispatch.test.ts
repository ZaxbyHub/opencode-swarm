import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	resetGraphInjectionCache,
	resetLaneOrientationDedupe,
} from '../../../src/hooks/repo-graph-injection';
import {
	_internals,
	_test_exports,
	executeDispatchLanes,
	executeDispatchLanesAsync,
	MAX_PROMPT_CHARS,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes';
import {
	buildWorkspaceGraphAsync,
	saveGraph,
	writeFingerprint,
} from '../../../src/tools/repo-graph';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const originalInternals = { ..._internals };

const { DispatchLanesArgsSchema, DispatchLanesAsyncArgsSchema } = _test_exports;

const ORIENTATION_HEADING = '## REPO GRAPH — LANE ORIENTATION';

let tmp: string;

beforeEach(() => {
	resetLaneOrientationDedupe();
	resetGraphInjectionCache();
	tmp = canonicalMkdtemp('lanes-orientation-');
	fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
	fs.writeFileSync(
		path.join(tmp, 'src', 'payment-validator.ts'),
		'export function validatePayment(amount: number): boolean {\n\treturn amount > 0;\n}\n',
	);
	fs.writeFileSync(
		path.join(tmp, 'src', 'payment-routes.ts'),
		"import { validatePayment } from './payment-validator';\nexport function routePayment(a: number): string {\n\treturn validatePayment(a) ? 'ok' : 'reject';\n}\n",
	);
	fs.writeFileSync(
		path.join(tmp, 'src', 'payment-store.ts'),
		"import { validatePayment } from './payment-validator';\nexport function storePayment(a: number): number {\n\treturn validatePayment(a) ? a : 0;\n}\n",
	);
	fs.writeFileSync(
		path.join(tmp, 'src', 'invoice-renderer.ts'),
		'export function renderInvoice(label: string): string {\n\treturn label.toUpperCase();\n}\n',
	);
});

afterEach(() => {
	Object.assign(_internals, originalInternals);
	fs.rmSync(tmp, { recursive: true, force: true });
});

async function buildAndSaveStartupGraph(): Promise<void> {
	const graph = await buildWorkspaceGraphAsync(tmp);
	await saveGraph(tmp, graph);
	await writeFingerprint(tmp, graph);
}

function makeSessionOps(): { ops: SessionOps; prompts: string[] } {
	const prompts: string[] = [];
	const ops: SessionOps = {
		create: mock(async () => ({
			data: { id: `session-${prompts.length + 1}` },
			error: undefined,
		})),
		prompt: mock(async (input) => {
			prompts.push(input.body.parts[0]?.text ?? '');
			return {
				data: { parts: [{ type: 'text' as const, text: 'done' }] },
				error: undefined,
			};
		}),
		delete: mock(async () => undefined),
	};
	return { ops, prompts };
}

function lanePromptTexts(ops: SessionOps): string[] {
	return (ops.prompt as ReturnType<typeof mock>).mock.calls.map(
		(call) => call[0].body.parts[0].text as string,
	);
}

describe('augmentCommonPromptWithOrientation — resolution and overflow rule', () => {
	test('orientation false never probes the graph (DI seam proves zero builder calls)', async () => {
		const buildBlock = mock(
			async () => '## REPO GRAPH — LANE ORIENTATION\nshould not appear',
		);
		const result = await _test_exports.augmentCommonPromptWithOrientation(
			tmp,
			[{ prompt: 'lane one' }],
			'shared context',
			false,
			'session-x',
			{ buildBlock: buildBlock as never },
		);
		expect(result).toBe('shared context');
		expect(buildBlock).toHaveBeenCalledTimes(0);
	});

	test('orientation true appends the block after common_prompt', async () => {
		const block = `${ORIENTATION_HEADING}\nFreshness: fresh (probe clean)`;
		const result = await _test_exports.augmentCommonPromptWithOrientation(
			tmp,
			[{ prompt: 'lane one' }],
			'shared context',
			true,
			'session-x',
			{
				buildBlock: (async () => block) as never,
			},
		);
		expect(result).toBe(`shared context\n\n${block}`);
	});

	test('block becomes the common prefix when common_prompt is omitted', async () => {
		const block = `${ORIENTATION_HEADING}\nFreshness: fresh (probe clean)`;
		const result = await _test_exports.augmentCommonPromptWithOrientation(
			tmp,
			[{ prompt: 'lane one' }],
			undefined,
			undefined,
			undefined,
			{
				buildBlock: (async () => block) as never,
			},
		);
		expect(result).toBe(block);
	});

	test('overflow rule — block dropped when combined length would exceed MAX_PROMPT_CHARS', async () => {
		const common = 'c'.repeat(76_000);
		const lane = 'l'.repeat(2_000);
		// common + separator + lane fits; adding a 2000-char block does not.
		expect(common.length + 2 + lane.length).toBeLessThanOrEqual(
			MAX_PROMPT_CHARS,
		);
		const block = 'b'.repeat(2_000);
		const result = await _test_exports.augmentCommonPromptWithOrientation(
			tmp,
			[{ prompt: lane }],
			common,
			true,
			'session-x',
			{
				buildBlock: (async () => block) as never,
			},
		);
		expect(result).toBe(common);
	});

	test('builder errors fail open to the un-augmented common_prompt', async () => {
		const result = await _test_exports.augmentCommonPromptWithOrientation(
			tmp,
			[{ prompt: 'lane one' }],
			'shared context',
			true,
			'session-x',
			{
				buildBlock: (async () => {
					throw new Error('probe exploded');
				}) as never,
			},
		);
		expect(result).toBe('shared context');
	});
});

describe('dispatch_lanes schemas — orientation arg (issue #1988)', () => {
	test('orientation is optional with no zod default on both schemas', () => {
		expect(DispatchLanesArgsSchema.shape.orientation).toBeDefined();
		expect(DispatchLanesAsyncArgsSchema.shape.orientation).toBeDefined();
		const parsed =
			DispatchLanesArgsSchema.shape.orientation.safeParse(undefined);
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data).toBeUndefined();
	});

	test('both schemas accept args without orientation and with explicit values', () => {
		const lanes = [{ id: 'a', agent: 'explorer', prompt: 'p' }];
		expect(DispatchLanesArgsSchema.safeParse({ lanes }).success).toBe(true);
		expect(
			DispatchLanesArgsSchema.safeParse({ lanes, orientation: true }).success,
		).toBe(true);
		expect(
			DispatchLanesArgsSchema.safeParse({ lanes, orientation: false }).success,
		).toBe(true);
		expect(DispatchLanesAsyncArgsSchema.safeParse({ lanes }).success).toBe(
			true,
		);
		expect(
			DispatchLanesAsyncArgsSchema.safeParse({
				lanes,
				orientation: false,
			}).success,
		).toBe(true);
	});
});

describe('executeDispatchLanes — lane orientation delivery (issue #1988 C2)', () => {
	test('lane prompts receive the orientation block in the shared prefix position', async () => {
		await buildAndSaveStartupGraph();
		const { ops } = makeSessionOps();
		_internals.getSessionOps = () => ops;

		const result = await executeDispatchLanes(
			{
				common_prompt: 'SHARED MISSION CONTEXT',
				lanes: [
					{
						id: 'validator',
						agent: 'explorer',
						prompt: 'Audit the payment validation flow.',
					},
					{
						id: 'consumers',
						agent: 'explorer',
						prompt: 'Find consumers of validatePayment.',
					},
				],
			},
			tmp,
			{ sessionID: 'parent-orientation-1' },
		);

		expect(result.success).toBe(true);
		const texts = lanePromptTexts(ops);
		expect(texts).toHaveLength(2);
		const lanePrompts = [
			'Audit the payment validation flow.',
			'Find consumers of validatePayment.',
		];
		texts.forEach((text, i) => {
			const sharedIndex = text.indexOf('SHARED MISSION CONTEXT');
			const blockIndex = text.indexOf(ORIENTATION_HEADING);
			const laneIndex = text.indexOf(lanePrompts[i]);
			expect(sharedIndex).toBeGreaterThan(-1);
			expect(blockIndex).toBeGreaterThan(sharedIndex);
			expect(laneIndex).toBeGreaterThan(blockIndex);
			expect(text).toContain('Freshness: fresh (probe clean)');
		});
	});

	test('repeat dispatch in the same session is suppressed by dedupe', async () => {
		await buildAndSaveStartupGraph();
		const { ops } = makeSessionOps();
		_internals.getSessionOps = () => ops;

		const args = {
			common_prompt: 'SHARED MISSION CONTEXT',
			lanes: [
				{
					id: 'validator',
					agent: 'explorer',
					prompt: 'Audit the payment validation flow.',
				},
			],
		} as const;

		await executeDispatchLanes({ ...args }, tmp, {
			sessionID: 'parent-orientation-2',
		});
		expect(lanePromptTexts(ops)[0]).toContain(ORIENTATION_HEADING);

		const { ops: ops2 } = makeSessionOps();
		_internals.getSessionOps = () => ops2;
		await executeDispatchLanes({ ...args }, tmp, {
			sessionID: 'parent-orientation-2',
		});
		expect(lanePromptTexts(ops2)[0]).not.toContain(ORIENTATION_HEADING);
	});

	test('dispatch-level determinism — identical dispatches from reset state are byte-identical', async () => {
		await buildAndSaveStartupGraph();
		const args = {
			common_prompt: 'SHARED MISSION CONTEXT',
			lanes: [
				{
					id: 'validator',
					agent: 'explorer',
					prompt: 'Audit the payment validation flow.',
				},
			],
		} as const;

		const { ops } = makeSessionOps();
		_internals.getSessionOps = () => ops;
		await executeDispatchLanes({ ...args }, tmp, {
			sessionID: 'parent-orientation-3',
		});

		resetLaneOrientationDedupe();
		resetGraphInjectionCache();

		const { ops: ops2 } = makeSessionOps();
		_internals.getSessionOps = () => ops2;
		await executeDispatchLanes({ ...args }, tmp, {
			sessionID: 'parent-orientation-3',
		});

		expect(lanePromptTexts(ops2)[0]).toBe(lanePromptTexts(ops)[0]);
	});

	test('orientation false disables the block end to end', async () => {
		await buildAndSaveStartupGraph();
		const { ops } = makeSessionOps();
		_internals.getSessionOps = () => ops;

		await executeDispatchLanes(
			{
				orientation: false,
				common_prompt: 'SHARED MISSION CONTEXT',
				lanes: [
					{
						id: 'validator',
						agent: 'explorer',
						prompt: 'Audit the payment validation flow.',
					},
				],
			},
			tmp,
			{ sessionID: 'parent-orientation-4' },
		);
		expect(lanePromptTexts(ops)[0]).not.toContain(ORIENTATION_HEADING);
	});
});

describe('executeDispatchLanesAsync — lane orientation delivery', () => {
	test('async lane prompts receive the orientation block too', async () => {
		await buildAndSaveStartupGraph();
		const prompts: string[] = [];
		const ops: SessionOps = {
			create: mock(async () => ({
				data: { id: `session-${prompts.length + 1}` },
				error: undefined,
			})),
			prompt: mock(async () => ({
				data: { parts: [{ type: 'text' as const, text: 'unused' }] },
				error: undefined,
			})),
			promptAsync: mock(async (input) => {
				prompts.push(input.body.parts[0]?.text ?? '');
				return { data: undefined, error: undefined };
			}),
			status: mock(async () => ({ data: {}, error: undefined })),
			messages: mock(async () => {
				throw new Error('dispatch_lanes_async must not read lane output');
			}),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;
		_internals.now = () => 1_700_000_000_000;

		const result = await executeDispatchLanesAsync(
			{
				batch_id: 'batch-orientation-async-1',
				mode: 'deep-dive',
				common_prompt: 'SHARED MISSION CONTEXT',
				lanes: [
					{
						id: 'validator',
						agent: 'explorer',
						prompt: 'Audit the payment validation flow.',
					},
				],
			},
			tmp,
			{ sessionID: 'parent-orientation-async-1' },
		);

		expect(result.success).toBe(true);
		expect(prompts).toHaveLength(1);
		const sharedIndex = prompts[0].indexOf('SHARED MISSION CONTEXT');
		const blockIndex = prompts[0].indexOf(ORIENTATION_HEADING);
		expect(blockIndex).toBeGreaterThan(sharedIndex);
	});
});
