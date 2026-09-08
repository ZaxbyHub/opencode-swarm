import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../../src/mcp/server';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * #2499 review feedback: composition-level coverage for the MCP server —
 * a containment rejection surfacing as an MCP isError RESULT (not a thrown
 * protocol error), the host root path never appearing in client-visible
 * text, and error text taking the same redaction pipeline as success
 * payloads. Uses the SDK's in-memory transport pair so the full
 * containment -> catch -> pipeline path runs in-process.
 */

async function withServer(
	root: string,
	run: (client: Client) => Promise<void>,
): Promise<void> {
	const server = createMcpServer({ root, allowWrite: false });
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	const client = new Client({ name: 'compose-test', version: '0.0.0' });
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

describe('MCP server composition (#2499 review feedback)', () => {
	test('containment rejection surfaces as isError and never leaks the host root path', async () => {
		const root = canonicalMkdtemp('mcp-compose-2499-');
		mkdirSync(path.join(root, 'in-root'), { recursive: true });
		writeFileSync(path.join(root, 'in-root', 'a.ts'), 'export const a = 1;\n');
		await withServer(root, async (client) => {
			const result = await client.callTool({
				name: 'placeholder_scan',
				arguments: {
					changed_files: [`${root}/../outside/secret.ts`],
				},
			});
			expect(result.isError).toBe(true);
			const text = JSON.stringify(result.content);
			expect(text).toContain('path rejected by containment');
			expect(text).not.toContain(root);
		});
	}, 30000);

	test('error text takes the redaction pipeline (secret-shaped path material is redacted)', async () => {
		const root = canonicalMkdtemp('mcp-compose-err-2499-');
		mkdirSync(path.join(root, 'changed'), { recursive: true });
		await withServer(root, async (client) => {
			const result = await client.callTool({
				name: 'placeholder_scan',
				arguments: {
					changed_files: [
						{
							path: 'changed/ghp_0123456789abcdefghijklmnopqrstuvwxyzAB.ts',
							additions: 1,
						},
					],
				},
			});
			const text = JSON.stringify(result.content);
			expect(text).not.toContain('ghp_0123456789');
		});
	}, 30000);
});
