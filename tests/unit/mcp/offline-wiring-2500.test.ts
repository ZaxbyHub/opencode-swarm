import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
	_internals as cliInternals,
	handleMcpCommand,
	parseMcpServeArgs,
} from '../../../src/cli/mcp';
import { buildMcpToolRegistry } from '../../../src/mcp/registry';
import { runMcpServer } from '../../../src/mcp/server';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * The parser tests in the #2499 suite stop before the dynamic import. These
 * checks keep the complete production path covered by injecting only the
 * transport at the runner seam:
 *
 * handleMcpCommand -> runMcpServer -> createMcpServer -> registry
 */
describe('MCP explicitly-authorized write wiring (#2500)', () => {
	const root = canonicalMkdtemp('mcp-wiring-2500-');
	const originalRunner = cliInternals.runMcpServer;

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	afterEach(() => {
		cliInternals.runMcpServer = originalRunner;
	});

	test('legacy parser shape omits writeTools when no write was requested', () => {
		expect(parseMcpServeArgs(['--dir', root])).toEqual({
			root,
			allowWrite: false,
		});
		expect(parseMcpServeArgs(['--dir', root, '--allow-write'])).toEqual({
			root,
			allowWrite: true,
		});
	});

	test('parser rejects policy without startup capability, duplicates, and unreviewed names', () => {
		expect(
			parseMcpServeArgs(['--dir', root, '--write-tool', 'knowledge_add']),
		).toEqual({ error: '--write-tool requires --allow-write' });
		expect(
			parseMcpServeArgs([
				'--dir',
				root,
				'--allow-write',
				'--write-tool',
				'knowledge_add',
				'--write-tool',
				'knowledge_add',
			]),
		).toEqual({ error: 'duplicate --write-tool: knowledge_add' });
		expect(
			parseMcpServeArgs([
				'--dir',
				root,
				'--allow-write',
				'--write-tool',
				'scope_validate',
			]),
		).toEqual({ error: 'unknown or unauthorized write tool: scope_validate' });
	});

	test('registry rejects invalid programmatic policies and composes the reviewed write only with both gates', () => {
		expect(() =>
			buildMcpToolRegistry({ root, writeTools: ['knowledge_add'] }),
		).toThrow(/require.*allowWrite/i);
		expect(() =>
			buildMcpToolRegistry({
				root,
				allowWrite: true,
				writeTools: ['scope_validate'],
			}),
		).toThrow(/unknown or unauthorized/i);
		expect(() =>
			buildMcpToolRegistry({
				root,
				allowWrite: true,
				writeTools: ['knowledge_add', 'knowledge_add'],
			}),
		).toThrow(/duplicate/i);
		const complete = buildMcpToolRegistry({
			root,
			allowWrite: true,
			writeTools: ['knowledge_add'],
		});
		expect(complete.tools.map((tool) => tool.name)).toContain('knowledge_add');
	});

	test.each([
		{ label: 'absent', args: ['serve', '--dir', root] },
		{ label: 'partial', args: ['serve', '--dir', root, '--allow-write'] },
		{
			label: 'complete',
			args: [
				'serve',
				'--dir',
				root,
				'--allow-write',
				'--write-tool',
				'knowledge_add',
			],
		},
	])('forwards $label policy through the real server construction path', async ({
		args,
		label,
	}) => {
		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair();
		let captured: Record<string, unknown> | undefined;
		cliInternals.runMcpServer = async (options) => {
			captured = options as unknown as Record<string, unknown>;
			return runMcpServer({ ...options, transport: serverTransport });
		};

		const client = new Client({ name: `wiring-${label}`, version: '0.0.0' });
		const command = handleMcpCommand(args);
		await client.connect(clientTransport);
		await expect(command).resolves.toBe(0);
		try {
			const listed = await client.listTools();
			const names = listed.tools.map((tool) => tool.name);
			expect(names).toContain('scope_validate');
			if (label === 'complete') {
				expect(names).toContain('knowledge_add');
				expect(captured?.writeTools).toEqual(['knowledge_add']);
			} else {
				expect(names).not.toContain('knowledge_add');
				expect(captured && 'writeTools' in captured).toBe(false);
			}
		} finally {
			await client.close();
		}
	}, 30000);
});
