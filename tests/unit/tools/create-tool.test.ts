/**
 * Tests for createSwarmTool
 * Covers directory injection, fallback behavior, args passthrough, and return values
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

afterEach(() => {
	mock.restore();
});

import type { ToolContext } from '@opencode-ai/plugin';
import { z } from 'zod';

// Mock the tool function from @opencode-ai/plugin
const mockTool = mock();
mock.module('@opencode-ai/plugin', () => ({
	tool: (...args: unknown[]) => mockTool(...args),
	type: {},
}));

// Import after mock is set up
import { createSwarmTool } from '../../../src/tools/create-tool';

describe('createSwarmTool', () => {
	beforeEach(() => {
		mock.restore();
	});

	describe('Group 1: Directory from ctx', () => {
		it('When execute is called with ctx = { directory: "/project" }, the execute callback receives "/project" as directory', async () => {
			const testArgs = { foo: 'bar' };
			const receivedArgs: Array<{ args: unknown; directory: string }> = [];

			// Create a swarm tool with an execute callback that captures the arguments
			createSwarmTool({
				description: 'Test tool',
				args: {
					foo: z.string(),
				},
				execute: async (args, directory) => {
					receivedArgs.push({ args, directory });
					return 'result';
				},
			});

			// Get the execute function passed to tool()
			const toolCalls = mockTool.mock.calls;
			expect(toolCalls.length).toBeGreaterThan(0);

			const toolConfig = toolCalls[0][0] as {
				execute: (args: unknown, ctx?: ToolContext) => Promise<string>;
			};

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

			createSwarmTool({
				description: 'Test tool',
				args: {
					foo: z.string(),
				},
				execute: async (args, directory) => {
					receivedArgs.push({ args, directory });
					return 'result';
				},
			});

			const toolCalls = mockTool.mock.calls;
			expect(toolCalls.length).toBeGreaterThan(0);

			const toolConfig = toolCalls[0][0] as {
				execute: (args: unknown, ctx?: ToolContext) => Promise<string>;
			};

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

			createSwarmTool({
				description: 'Test tool',
				args: {
					foo: z.string(),
				},
				execute: async (args, directory) => {
					receivedArgs.push({ args, directory });
					return 'result';
				},
			});

			const toolCalls = mockTool.mock.calls;
			expect(toolCalls.length).toBeGreaterThan(0);

			const toolConfig = toolCalls[0][0] as {
				execute: (args: unknown, ctx?: ToolContext) => Promise<string>;
			};

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

			createSwarmTool({
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

			const toolCalls = mockTool.mock.calls;
			expect(toolCalls.length).toBeGreaterThan(0);

			const toolConfig = toolCalls[0][0] as {
				execute: (args: unknown, ctx?: ToolContext) => Promise<string>;
			};

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

			createSwarmTool({
				description: 'Test tool',
				args: {
					foo: z.string(),
				},
				execute: async () => {
					return expectedReturnValue;
				},
			});

			const toolCalls = mockTool.mock.calls;
			expect(toolCalls.length).toBeGreaterThan(0);

			const toolConfig = toolCalls[0][0] as {
				execute: (args: unknown, ctx?: ToolContext) => Promise<string>;
			};

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

			createSwarmTool({
				description: 'Test tool',
				args: { foo: z.string() },
				execute: async (args, directory) => {
					receivedArgs.push({ args, directory });
					return 'result';
				},
			});

			const toolCalls = mockTool.mock.calls;
			expect(toolCalls.length).toBeGreaterThan(0);

			const toolConfig = toolCalls[0][0] as {
				execute: (args: unknown, ctx?: ToolContext) => Promise<string>;
			};

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

		it('Description and args are passed correctly to tool()', () => {
			const description = 'Test tool description';
			const args = { foo: z.string(), bar: z.number() };

			createSwarmTool({
				description,
				args,
				execute: async () => 'result',
			});

			const toolCalls = mockTool.mock.calls;
			expect(toolCalls).toHaveLength(1);

			const toolConfig = toolCalls[0][0];
			expect(toolConfig.description).toBe(description);
			expect(toolConfig.args).toEqual(args);
		});

		it('Empty args object is handled correctly', async () => {
			const receivedArgs: Array<unknown> = [];

			createSwarmTool({
				description: 'Test tool',
				args: {},
				execute: async (args) => {
					receivedArgs.push(args);
					return 'result';
				},
			});

			const toolCalls = mockTool.mock.calls;
			expect(toolCalls.length).toBeGreaterThan(0);

			const toolConfig = toolCalls[0][0] as {
				execute: (args: unknown, ctx?: ToolContext) => Promise<string>;
			};

			await toolConfig.execute({}, { directory: '/test' } as ToolContext);

			// Verify empty args object is passed through
			expect(receivedArgs).toHaveLength(1);
			expect(receivedArgs[0]).toEqual({});
		});

		it('Async execute callback works correctly', async () => {
			let resolveExecute: ((value: string) => void) | undefined;

			createSwarmTool({
				description: 'Test tool',
				args: { foo: z.string() },
				execute: async () => {
					return new Promise((resolve) => {
						resolveExecute = resolve;
					});
				},
			});

			const toolCalls = mockTool.mock.calls;
			expect(toolCalls.length).toBeGreaterThan(0);

			const toolConfig = toolCalls[0][0] as {
				execute: (args: unknown, ctx?: ToolContext) => Promise<string>;
			};

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

			createSwarmTool({
				description: 'Test tool',
				args: { foo: z.string() },
				execute: async (args, directory, ctx) => {
					receivedCtx.push(ctx);
					return 'result';
				},
			});

			const toolCalls = mockTool.mock.calls;
			expect(toolCalls.length).toBeGreaterThan(0);

			const toolConfig = toolCalls[0][0] as {
				execute: (args: unknown, ctx?: ToolContext) => Promise<string>;
			};

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
});
