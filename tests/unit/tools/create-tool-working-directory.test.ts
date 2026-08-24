import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { z } from 'zod';

import { createSwarmTool } from '../../../src/tools/create-tool';
import { knowledge_add } from '../../../src/tools/knowledge-add';
import { write_retro } from '../../../src/tools/write-retro';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function makeContext(directory: string): ToolContext {
	return {
		sessionID: 'working-directory-test',
		messageID: 'message-1',
		agent: 'test-agent',
		directory,
		worktree: directory,
		abort: new AbortController().signal,
		metadata: () => {},
		askID: 'task-1',
	} as ToolContext;
}

describe('createSwarmTool working_directory injection (issue #2171)', () => {
	let container: string;
	let fallbackRoot: string;
	let overrideRoot: string;
	let fallbackSubdirectory: string;

	beforeEach(() => {
		container = canonicalMkdtemp('swarm-create-tool-wd-');
		fallbackRoot = join(container, 'fallback-project');
		overrideRoot = join(container, 'linked-worktree');
		fallbackSubdirectory = join(fallbackRoot, 'src');

		mkdirSync(join(fallbackRoot, '.git'), { recursive: true });
		mkdirSync(join(fallbackRoot, '.swarm'), { recursive: true });
		mkdirSync(fallbackSubdirectory, { recursive: true });
		mkdirSync(join(overrideRoot, '.swarm'), { recursive: true });
		writeFileSync(
			join(overrideRoot, '.git'),
			'gitdir: ../git/worktrees/test\n',
		);
	});

	afterEach(() => {
		rmSync(container, {
			recursive: true,
			force: true,
			maxRetries: 3,
			retryDelay: 25,
		});
	});

	it('adds an optional working_directory schema only to tools that opt in', () => {
		const config = createSwarmTool({
			description: 'schema test',
			allowWorkingDirectoryOverride: true,
			args: { value: z.string() },
			execute: async () => 'ok',
		});

		const schemas = config.args as Record<string, z.ZodTypeAny>;
		expect(schemas.working_directory).toBeDefined();
		expect(schemas.working_directory.safeParse(undefined).success).toBe(true);
		expect(schemas.working_directory.safeParse(overrideRoot).success).toBe(
			true,
		);
		expect(schemas.working_directory.safeParse(42).success).toBe(false);
	});

	it('preserves exact argument and context references when no override is supplied', async () => {
		let receivedArgs: unknown;
		let receivedContext: ToolContext | undefined;
		const config = createSwarmTool({
			description: 'reference test',
			allowWorkingDirectoryOverride: true,
			args: { value: z.string() },
			execute: async (args, _directory, context) => {
				receivedArgs = args;
				receivedContext = context;
				return 'ok';
			},
		});
		const args = { value: 'unchanged' };
		const context = makeContext(fallbackRoot);

		await config.execute(args, context);

		expect(receivedArgs).toBe(args);
		expect(receivedContext).toBe(context);
	});

	it('preserves null and undefined args for established executor validation', async () => {
		const received: unknown[] = [];
		const strictTool = createSwarmTool({
			description: 'strict invalid-args compatibility',
			args: {},
			async execute(args) {
				received.push(args);
				return JSON.stringify({ error: 'invalid arguments' });
			},
		});
		for (const args of [undefined, null]) {
			const raw = await strictTool.execute(args as never, undefined as never);
			expect(JSON.parse(raw as string).error).toBe('invalid arguments');
		}
		expect(received).toEqual([undefined, null]);
	});

	it('resolves an explicit override, strips it from strict args, and forwards a coherent context', async () => {
		let receivedArgs: unknown;
		let receivedDirectory: string | undefined;
		let receivedContext: ToolContext | undefined;
		const config = createSwarmTool({
			description: 'override test',
			allowWorkingDirectoryOverride: true,
			args: { value: z.string() },
			execute: async (args, directory, context) => {
				receivedArgs = args;
				receivedDirectory = directory;
				receivedContext = context;
				return 'ok';
			},
		});
		const context = makeContext(fallbackRoot);

		await config.execute(
			{ value: 'strict', working_directory: overrideRoot },
			context,
		);

		expect(receivedArgs).toEqual({ value: 'strict' });
		expect(receivedDirectory).toBe(overrideRoot);
		expect(receivedContext).not.toBe(context);
		expect(receivedContext?.directory).toBe(overrideRoot);
		expect(receivedContext?.worktree).toBe(overrideRoot);
	});

	it('rejects a subdirectory override before invoking the executor', async () => {
		let invoked = false;
		const config = createSwarmTool({
			description: 'invalid override test',
			allowWorkingDirectoryOverride: true,
			args: { value: z.string() },
			execute: async () => {
				invoked = true;
				return 'unexpected';
			},
		});

		const result = await config.execute(
			{ value: 'strict', working_directory: fallbackSubdirectory },
			makeContext(fallbackRoot),
		);

		expect(invoked).toBe(false);
		const parsed = JSON.parse(result as string);
		expect(parsed.success).toBe(false);
		expect(parsed.errors[0]).toContain('project root');
	});

	it('keeps the overridden context root across a nested tool invocation', async () => {
		let nestedDirectory: string | undefined;
		let nestedContext: ToolContext | undefined;
		const nested = createSwarmTool({
			description: 'nested tool',
			args: { value: z.string() },
			execute: async (_args, directory, context) => {
				nestedDirectory = directory;
				nestedContext = context;
				return 'nested-ok';
			},
		});
		const outer = createSwarmTool({
			description: 'outer tool',
			allowWorkingDirectoryOverride: true,
			args: { value: z.string() },
			execute: async (_args, _directory, context) =>
				nested.execute({ value: 'nested' }, context),
		});

		const result = await outer.execute(
			{ value: 'outer', working_directory: overrideRoot },
			makeContext(fallbackRoot),
		);

		expect(result).toBe('nested-ok');
		expect(nestedDirectory).toBe(overrideRoot);
		expect(nestedContext?.directory).toBe(overrideRoot);
		expect(nestedContext?.worktree).toBe(overrideRoot);
	});

	it('leaves a tool-owned working_directory schema and execution contract untouched', async () => {
		const ownedSchema = z.string().min(3);
		let receivedArgs: unknown;
		let receivedDirectory: string | undefined;
		const config = createSwarmTool({
			description: 'owned field test',
			allowWorkingDirectoryOverride: true,
			args: { value: z.string(), working_directory: ownedSchema },
			execute: async (args, directory) => {
				receivedArgs = args;
				receivedDirectory = directory;
				return 'ok';
			},
		});
		const args = { value: 'owned', working_directory: overrideRoot };

		await config.execute(args, makeContext(fallbackRoot));

		expect((config.args as Record<string, unknown>).working_directory).toBe(
			ownedSchema,
		);
		expect(receivedArgs).toBe(args);
		expect(receivedDirectory).toBe(fallbackRoot);
	});

	it('wires the injected schema and root through the issue-listed write_retro tool', async () => {
		const schemas = write_retro.args as Record<string, z.ZodTypeAny>;
		expect(schemas.working_directory).toBeDefined();

		const result = await write_retro.execute(
			{
				phase: 1,
				verdict: 'pass',
				summary: 'wrapper integration',
				task_count: 1,
				task_complexity: 'simple',
				total_tool_calls: 1,
				coder_revisions: 0,
				reviewer_rejections: 0,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
				working_directory: overrideRoot,
			},
			makeContext(fallbackRoot),
		);

		expect(JSON.parse(result as string).success).toBe(true);
		expect(
			existsSync(
				join(overrideRoot, '.swarm', 'evidence', 'retro-1', 'evidence.json'),
			),
		).toBe(true);
		expect(
			existsSync(
				join(fallbackRoot, '.swarm', 'evidence', 'retro-1', 'evidence.json'),
			),
		).toBe(false);
	});

	it('wires the injected schema and root through the issue-listed knowledge_add tool', async () => {
		const schemas = knowledge_add.args as Record<string, z.ZodTypeAny>;
		expect(schemas.working_directory).toBeDefined();

		const result = await knowledge_add.execute(
			{
				lesson:
					'Run focused wrapper validation from the active worktree before merge.',
				category: 'process',
				applies_to_agents: ['coder'],
				required_actions: ['Run focused tests for changed wrappers.'],
				working_directory: overrideRoot,
			},
			makeContext(fallbackRoot),
		);

		expect(JSON.parse(result as string).success).toBe(true);
		expect(existsSync(join(overrideRoot, '.swarm', 'knowledge.jsonl'))).toBe(
			true,
		);
		expect(existsSync(join(fallbackRoot, '.swarm', 'knowledge.jsonl'))).toBe(
			false,
		);
	});
});
