import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../../src/mcp/server';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const root = canonicalMkdtemp('mcp-scope-posix-greatand-2500-');
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
		name: 'scope-validate-posix-greatand-2500',
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

function callScopeValidate(client: Client, command: string) {
	return client.callTool({
		name: 'scope_validate',
		arguments: {
			command,
			shell: 'posix',
			scope_files: ['in-root/note.md'],
		},
	});
}

describe('MCP scope_validate POSIX GREATAND redirections (#2500)', () => {
	test('real server accepts in-scope file targets and descriptor copies', async () => {
		await withClient(async (client) => {
			for (const command of [
				'echo x >&in-root/note.md',
				'echo x 2>&in-root/note.md',
				'echo x 2>&1',
			]) {
				const result = await callScopeValidate(client, command);
				expect(result.isError).not.toBe(true);
			}
		});
	});

	test('real server rejects out-of-scope, malformed, and dynamic targets', async () => {
		await withClient(async (client) => {
			for (const command of [
				'echo x >&outside.txt',
				'echo x 2>&outside.txt',
				'echo x >&',
				'echo x >&$TARGET',
			]) {
				const result = await callScopeValidate(client, command);
				expect(result.isError).toBe(true);
			}
		});
	});
});
