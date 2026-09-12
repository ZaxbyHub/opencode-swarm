import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../../src/mcp/server';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const root = canonicalMkdtemp('mcp-scope-cmd-2500-');
mkdirSync(path.join(root, 'in-root'), { recursive: true });
writeFileSync(path.join(root, 'in-root', 'note.md'), 'fixture\n');

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

async function withClient(
	run: (client: Client) => Promise<void>,
): Promise<void> {
	const server = createMcpServer({ root });
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	const client = new Client({
		name: 'scope-validate-cmd-2500',
		version: '0.0.0',
	});
	await Promise.all([
		server.connect(serverTransport),
		client.connect(clientTransport),
	]);
	try {
		await run(client);
	} finally {
		await client.close();
		await server.close();
	}
}

async function callScopeValidate(
	client: Client,
	command: string,
): Promise<Awaited<ReturnType<Client['callTool']>>> {
	return client.callTool({
		name: 'scope_validate',
		arguments: {
			command,
			shell: 'cmd',
			scope_files: ['in-root/note.md'],
		},
	});
}

describe('MCP scope_validate CMD redirections (#2500)', () => {
	test('real server accepts in-scope writes and rejects unsafe forms', async () => {
		await withClient(async (client) => {
			for (const command of [
				'echo x>in-root/note.md',
				'echo x>>in-root/note.md',
				'echo x 1>in-root/note.md',
				'echo x 2>>in-root/note.md',
				'echo x>in-root/note.md && echo y>in-root/note.md',
			]) {
				const result = await callScopeValidate(client, command);
				expect(result.isError).not.toBe(true);
			}

			for (const command of [
				'echo x>outside.txt',
				'echo x>>outside.txt',
				'echo x 2>outside.txt',
				'echo x 2>>outside.txt',
				'echo x>in-root/note.md && echo y>outside.txt',
				"echo can't>outside.txt",
				'echo "x>outside.txt',
				'echo x 2>&outside.txt',
				'echo x>in-root/note.md 2>outside.txt',
			]) {
				const result = await callScopeValidate(client, command);
				expect(result.isError).toBe(true);
			}
		});
	});

	test('real server excludes descriptor copies and escaped or quoted content', async () => {
		await withClient(async (client) => {
			for (const command of [
				'echo x 2>&1',
				'echo x 1>&2',
				'echo x >& 1',
				'echo x ^>outside.txt',
				'echo "x > outside.txt"',
			]) {
				const result = await callScopeValidate(client, command);
				expect(result.isError).not.toBe(true);
			}
		});
	});
});
