/**
 * Tests for createSwarmTool
 * Covers directory injection, fallback behavior, args passthrough, and return values
 */

import { describe, expect, it } from 'bun:test';

import type { ToolContext } from '@opencode-ai/plugin';
import { z } from 'zod';

import { createSwarmTool } from '../../../src/tools/create-tool';

describe('createSwarmTool', () => {
	describe('Group 1: Directory from ctx', () => {
		it('When execute is called with ctx = { directory: "/project" }, the execute callback receives "/project" as directory', async () => {
			const testArgs = { foo: 'bar' };
			const receivedArgs: Array<{ args: unknown; directory: string }> = [];

			// Create a swarm tool with an execute callback that captures the arguments
			const toolConfig = createSwarmTool({
				description: 'Test tool',
				args: {
					foo: z.string(),
				},
				execute: async (args, directory) => {
					receivedArgs.push({ args, directory });
					return 'result';
				},
			});

			// Call execute with a context containing a directory
			const result = await toolConfig.execute(testArgs, {
				directory: '/project',
			} as ToolContext);

			// Verify the execute callback received the correct directory
			expect(receivedArgs).toHaveLength(1);
			expect(receivedArgs[0].directory).toBe('/project');
			expect(result).toBe('result');
		});
	});

	describe('Group 2: Fallback to process.cwd()', () => {
		it('When execute is called with ctx = undefined, the execute callback receives process.cwd() as directory', async () => {
			const testArgs = { foo: 'bar' };
			const receivedArgs: Array<{ args: unknown; directory: string }> = [];

			const expectedCwd = process.cwd();

			const toolConfig = createSwarmTool({
				description: 'Test tool',
				args: {
					foo: z.string(),
				},
				execute: async (args, directory) => {
					receivedArgs.push({ args, directory });
					return 'result';
				},
			});

			// Call execute without a context
			const result = await toolConfig.execute(testArgs, undefined);

			// Verify the execute callback received process.cwd()
			expect(receivedArgs).toHaveLength(1);
			expect(receivedArgs[0].directory).toBe(expectedCwd);
			expect(result).toBe('result');
		});
	});

	describe('Group 3: Fallback when ctx.directory is undefined', () => {
		it('When ctx = {} (no directory field), fallback to process.cwd()', async () => {
			const testArgs = { foo: 'bar' };
			const receivedArgs: Array<{ args: unknown; directory: string }> = [];

			const expectedCwd = process.cwd();

			const toolConfig = createSwarmTool({
				description: 'Test tool',
				args: {
					foo: z.string(),
				},
				execute: async (args, directory) => {
					receivedArgs.push({ args, directory });
					return 'result';
				},
			});

			// Call execute with an empty context object
			const result = await toolConfig.execute(testArgs, {} as ToolContext);

			// Verify the execute callback received process.cwd() as fallback
			expect(receivedArgs).toHaveLength(1);
			expect(receivedArgs[0].directory).toBe(expectedCwd);
			expect(result).toBe('result');
		});
	});

	describe('Group 4: Args passthrough', () => {
		it('The args object is correctly passed through to the execute callback', async () => {
			const testArgs = {
				name: 'test',
				count: 42,
				enabled: true,
			};
			const receivedArgs: Array<unknown> = [];

			const toolConfig = createSwarmTool({
				description: 'Test tool',
				args: {
					name: z.string(),
					count: z.number(),
					enabled: z.boolean(),
				},
				execute: async (args) => {
					receivedArgs.push(args);
					return 'result';
				},
			});

			// Call execute with test args
			await toolConfig.execute(testArgs, { directory: '/test' } as ToolContext);

			// Verify the execute callback received the exact args object
			expect(receivedArgs).toHaveLength(1);
			expect(receivedArgs[0]).toEqual(testArgs);
		});
	});

	describe('Group 5: Return value', () => {
		it('The string returned by the execute callback is returned by the tool', async () => {
			const expectedReturnValue = 'test return value';

			const toolConfig = createSwarmTool({
				description: 'Test tool',
				args: {
					foo: z.string(),
				},
				execute: async () => {
					return expectedReturnValue;
				},
			});

			// Call execute
			const result = await toolConfig.execute({ foo: 'bar' }, {
				directory: '/test',
			} as ToolContext);

			// Verify the return value matches
			expect(result).toBe(expectedReturnValue);
		});
	});

	describe('Additional edge cases', () => {
		it('Multiple execute calls each receive correct directory', async () => {
			const receivedArgs: Array<{ args: unknown; directory: string }> = [];

			const toolConfig = createSwarmTool({
				description: 'Test tool',
				args: { foo: z.string() },
				execute: async (args, directory) => {
					receivedArgs.push({ args, directory });
					return 'result';
				},
			});

			// First call with directory from context
			await toolConfig.execute({ foo: '1' }, {
				directory: '/dir1',
			} as ToolContext);

			// Second call with no context (should fallback to cwd)
			await toolConfig.execute({ foo: '2' }, undefined);

			// Third call with different directory
			await toolConfig.execute({ foo: '3' }, {
				directory: '/dir3',
			} as ToolContext);

			// Verify all calls received correct directories
			expect(receivedArgs).toHaveLength(3);
			expect(receivedArgs[0].directory).toBe('/dir1');
			expect(receivedArgs[1].directory).toBe(process.cwd());
			expect(receivedArgs[2].directory).toBe('/dir3');
		});

		it('Description and declared args are passed through unchanged by default', () => {
			const description = 'Test tool description';
			const args = { foo: z.string(), bar: z.number() };

			const toolConfig = createSwarmTool({
				description,
				args,
				execute: async () => 'result',
			});

			expect(toolConfig.description).toBe(description);
			const configuredArgs = toolConfig.args as Record<string, z.ZodTypeAny>;
			expect(configuredArgs.foo).toBe(args.foo);
			expect(configuredArgs.bar).toBe(args.bar);
			expect(configuredArgs.working_directory).toBeUndefined();
		});

		it('publishes working_directory only when explicitly opted in', () => {
			const toolConfig = createSwarmTool({
				description: 'opted-in tool',
				allowWorkingDirectoryOverride: true,
				args: { foo: z.string() },
				execute: async () => 'result',
			});

			const configuredArgs = toolConfig.args as Record<string, z.ZodTypeAny>;
			expect(configuredArgs.working_directory).toBeDefined();
		});

		it('Empty args object is handled correctly', async () => {
			const receivedArgs: Array<unknown> = [];

			const toolConfig = createSwarmTool({
				description: 'Test tool',
				args: {},
				execute: async (args) => {
					receivedArgs.push(args);
					return 'result';
				},
			});

			await toolConfig.execute({}, { directory: '/test' } as ToolContext);

			// Verify empty args object is passed through
			expect(receivedArgs).toHaveLength(1);
			expect(receivedArgs[0]).toEqual({});
		});

		it('Async execute callback works correctly', async () => {
			let resolveExecute: ((value: string) => void) | undefined;

			const toolConfig = createSwarmTool({
				description: 'Test tool',
				args: { foo: z.string() },
				execute: async () => {
					return new Promise((resolve) => {
						resolveExecute = resolve;
					});
				},
			});

			const resultPromise = toolConfig.execute({ foo: 'bar' }, {
				directory: '/test',
			} as ToolContext);

			// Resolve the async operation
			if (resolveExecute) {
				resolveExecute('async result');
			}

			const result = await resultPromise;
			expect(result).toBe('async result');
		});
	});

	describe('Group 6: ToolContext forwarding', () => {
		it('createSwarmTool passes the ToolContext as the third argument to execute callback', async () => {
			const receivedCtx: Array<ToolContext | undefined> = [];

			const toolConfig = createSwarmTool({
				description: 'Test tool',
				args: { foo: z.string() },
				execute: async (args, directory, ctx) => {
					receivedCtx.push(ctx);
					return 'result';
				},
			});

			const mockContext: ToolContext = {
				sessionID: 'test-session-123',
				messageID: 'test-message-id',
				agent: 'test-agent',
				directory: '/test',
				worktree: '/test',
				abort: new AbortController().signal,
				metadata: () => {},
				ask: async () => {},
			};

			await toolConfig.execute({ foo: 'bar' }, mockContext);

			expect(receivedCtx).toHaveLength(1);
			expect(receivedCtx[0]).toBe(mockContext); // same reference
			expect(receivedCtx[0]?.sessionID).toBe('test-session-123');
		});
	});

	describe('Group 7: error classification guard (issue #1931)', () => {
		// The diagnostic-rich PR-workflow error messages introduced in #1931
		// mention causes like "Git binary may not be on PATH". The
		// createSwarmTool wrapper classifies thrown errors into failure_class
		// via substring matching. These tests lock in that the new diagnostic
		// wording is classified as `execution_error` (not `binary_missing`,
		// `not_registered`, etc.) so a future wording tweak cannot silently
		// change the failure classification.
		it('classifies the #1931 null-HEAD diagnostic as execution_error', async () => {
			const toolConfig = createSwarmTool({
				description: 'Test tool',
				args: { foo: z.string() },
				execute: async () => {
					throw new Error(
						'BLOCKED: cannot resolve the current Git HEAD in "/repo" to verify against PR head "abc". ' +
							'This means Git could not resolve HEAD (the working directory may not be a Git repository, ' +
							'HEAD may be unborn, the commit object may be missing in a shallow clone, the Git binary may not be on PATH, ' +
							'or the bounded Git invocation may have timed out). ' +
							'Verify with: git -C "/repo" rev-parse --verify HEAD^{commit}',
					);
				},
			});

			const result = await toolConfig.execute({ foo: 'bar' }, {
				directory: '/repo',
			} as ToolContext);
			const parsed = JSON.parse(result as string);
			expect(parsed.success).toBe(false);
			expect(parsed.failure_class).toBe('execution_error');
		});

		it('classifies the #1931 HEAD-mismatch diagnostic as execution_error', async () => {
			const toolConfig = createSwarmTool({
				description: 'Test tool',
				args: { foo: z.string() },
				execute: async () => {
					throw new Error(
						'BLOCKED: current checkout HEAD "deadbeef" does not match PR head "abc" ' +
							'(working directory: "/repo"). ' +
							'Run these bare, standalone commands from that directory: if the commit is not present locally, ' +
							'`git fetch origin <pr-head-ref>`; then `git switch --detach abc`. ' +
							'Do not prefix the switch with `git -C`; the read-only shell classifier refuses `git -C ... switch`.',
					);
				},
			});

			const result = await toolConfig.execute({ foo: 'bar' }, {
				directory: '/repo',
			} as ToolContext);
			const parsed = JSON.parse(result as string);
			expect(parsed.success).toBe(false);
			expect(parsed.failure_class).toBe('execution_error');
		});

		it('classifies the #1931 no-active-gate diagnostic as execution_error', async () => {
			const toolConfig = createSwarmTool({
				description: 'Test tool',
				args: { foo: z.string() },
				execute: async () => {
					throw new Error(
						'BLOCKED: no active PR workflow gate for session "ses_x". ' +
							'The gate is activated by running `/swarm pr-review <pr-ref>` (PR_REVIEW) or `/swarm pr-feedback <pr-ref>` (PR_FEEDBACK), ' +
							'or by the first dispatch_lanes_async call with mode "swarm-pr-review:*" / "swarm-pr-feedback:*".',
					);
				},
			});

			const result = await toolConfig.execute({ foo: 'bar' }, {
				directory: '/repo',
			} as ToolContext);
			const parsed = JSON.parse(result as string);
			expect(parsed.success).toBe(false);
			expect(parsed.failure_class).toBe('execution_error');
		});
	});
});
