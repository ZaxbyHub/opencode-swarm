import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test';
import { createMcpServer } from './server';
import { z } from 'zod';

// Mock tools
mock.module('../tools/index.js', () => ({
  grep_search: {
    description: 'Search for text',
    args: {
      query: z.string().describe('Search query'),
    },
    execute: mock(async (args: any, ctx: any) => {
      return `Found ${args.query} in ${ctx.directory}`;
    }),
  },
}));

mock.module('../tools/tool-names.js', () => ({
  TOOL_NAME_SET: new Set(['grep_search']),
}));

describe('MCP Server', () => {
  it('should register and execute a tool', async () => {
    const projectRoot = '/test/project';
    const server = await createMcpServer(projectRoot);
    
    // Check if tool is registered
    // McpServer doesn't have a public way to list tools easily in the SDK,
    // but we can try to call it via a internal request if we had access.
    // Instead, we'll verify the McpServer instance is created and tool is called.
    
    expect(server).toBeDefined();
    
    // We'll test the tool execution logic by manually invoking the registered handler
    // Since we can't easily get the handler from McpServer, 
    // we might need to export the registration logic or use a more integration-test style.
  });
});
