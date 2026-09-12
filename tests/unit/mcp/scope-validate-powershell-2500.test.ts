import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../../src/mcp/server';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const root = canonicalMkdtemp('mcp-scope-powershell-2500-');
mkdirSync(path.join(root, 'safe'), { recursive: true });
writeFileSync(path.join(root, 'safe', 'note.md'), 'fixture\n');

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
		name: 'scope-validate-powershell-2500',
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
			shell: 'powershell',
			scope_files: ['safe/note.md'],
		},
	});
}

describe('MCP scope_validate PowerShell redirections (#2500)', () => {
	test('real server accepts in-scope adjacent, append, and stream redirects', async () => {
		await withClient(async (client) => {
			for (const command of [
				'dir>safe/note.md',
				'Get-Process>>safe/note.md',
				'foo.exe bar 2>safe/note.md',
				'foo.exe bar 2>>safe/note.md',
				'Get-Process>"safe/note.md"',
				"Get-Process>'safe/note.md'",
				'foo.exe 2>&1',
			]) {
				const result = await callScopeValidate(client, command);
				expect(result.isError).not.toBe(true);
			}
		});
	});

	test('real server rejects adjacent, malformed, and out-of-scope redirects', async () => {
		await withClient(async (client) => {
			for (const command of [
				'dir>outside.txt',
				'Get-Process>>outside.txt',
				'foo.exe bar 2>outside.txt',
				'foo.exe 2>&outside.txt',
				'Get-Process>',
				'Get-Process>$TARGET',
				'Get-Process>"unterminated',
			]) {
				const result = await callScopeValidate(client, command);
				expect(result.isError).toBe(true);
			}
		});
	});
});
