import { describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { parseMcpServeArgs } from '../../../src/cli/mcp';
import { createMcpServer, runMcpServer } from '../../../src/mcp/server';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * Acceptance checks for #2500.  The write options and hooks below are a
 * deliberately small public contract: tests do not import the write
 * implementation or its storage.  A missing write surface is therefore a
 * valid NEW-SURFACE failure on the pre-#2500 base.
 */
type WriteHooks = {
	persistReceipt?: (receipt: unknown) => Promise<void>;
	afterPrepare?: (receipt: unknown) => Promise<void>;
	afterMutation?: (receipt: unknown) => Promise<void>;
	now?: () => number;
};

type AuthorizedOptions = Parameters<typeof createMcpServer>[0] & {
	writeTools?: string[];
	writeHooks?: WriteHooks;
};

/** Exactly one executable mapping per issue acceptance criterion. */
export const ACCEPTANCE_CRITERIA = {
	AC1: 'default and allowWrite-alone expose no knowledge_add',
	AC2: 'allowWrite plus writeTools exposes only the reviewed knowledge_add write',
	AC3: 'scope_validate enforces inline root containment and rejects unsafe intent',
	AC4: 'knowledge_add retries are idempotent and conflicting arguments reject',
	AC5: 'receipts are durable and persistence faults never claim success',
	AC6: 'destructive and unreviewed write names remain absent',
	AC7: 'client setup documentation names four clients and retry/in_doubt policy',
	AC8: 'createMcpServer and stdio wiring exercise the shipped registry',
	AC9: 'release fragment is present; PR invariant audit is a named non-executable substitute',
} as const;

const root = canonicalMkdtemp('mcp-acceptance-2500-');
mkdirSync(path.join(root, 'in-root'), { recursive: true });
writeFileSync(path.join(root, 'in-root', 'note.md'), 'acceptance fixture\n');

function options(extra: Partial<AuthorizedOptions> = {}): AuthorizedOptions {
	return {
		root,
		allowWrite: true,
		writeTools: ['knowledge_add'],
		...extra,
	};
}

async function withClient(
	serverOptions: AuthorizedOptions,
	run: (client: Client) => Promise<void>,
): Promise<void> {
	const server = createMcpServer(
		serverOptions as Parameters<typeof createMcpServer>[0],
	);
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	const client = new Client({ name: 'acceptance-2500', version: '0.0.0' });
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

async function call(
	client: Client,
	name: string,
	arguments_: Record<string, unknown> = {},
) {
	return client.callTool({ name, arguments: arguments_ });
}

describe('MCP explicitly authorized writes (#2500)', () => {
	test('AC1: default and allowWrite alone expose no knowledge_add', async () => {
		for (const serverOptions of [
			{ root },
			{ root, allowWrite: true },
		] as Parameters<typeof createMcpServer>[0][]) {
			const server = createMcpServer(serverOptions);
			const [clientTransport, serverTransport] =
				InMemoryTransport.createLinkedPair();
			const client = new Client({ name: 'ac1', version: '0.0.0' });
			await Promise.all([
				server.connect(serverTransport),
				client.connect(clientTransport),
			]);
			try {
				const listed = await client.listTools();
				expect(listed.tools.some((tool) => tool.name === 'knowledge_add')).toBe(
					false,
				);
			} finally {
				await client.close();
				await server.close();
			}
		}
	});

	test('AC2: explicit policy exposes exactly knowledge_add through InMemoryTransport', async () => {
		await withClient(options(), async (client) => {
			const listed = await client.listTools();
			const names = listed.tools.map((tool) => tool.name);
			expect(names).toContain('knowledge_add');
			expect(names.filter((name) => name === 'knowledge_add')).toHaveLength(1);
			expect(names).not.toContain('knowledge_remove');
			expect(names).not.toContain('save_plan');
		});
	});

	test('AC3: inline scope allows an in-root path and rejects traversal, outside, dynamic, destructive', async () => {
		// scope_validate is a read-only policy check and must not require a
		// writeTools allowlist entry.
		await withClient({ root }, async (client) => {
			const allowed = await call(client, 'scope_validate', {
				command: 'printf x > in-root/note.md',
				shell: 'posix',
				scope_files: ['in-root/note.md'],
			});
			expect(JSON.stringify(allowed.content)).not.toContain(
				'Tool scope_validate not found',
			);
			expect(allowed.isError).not.toBe(true);

			for (const unsafe of [
				{
					command: 'printf x > ../outside.txt',
					shell: 'posix',
					scope_files: ['../outside.txt'],
				},
				{
					command: 'printf x > outside.txt',
					shell: 'posix',
					scope_files: [path.join(root, '..', 'outside.txt')],
				},
				{
					command: 'printf x > "$TARGET"',
					shell: 'posix',
					scope_files: ['in-root/note.md'],
				},
				{
					command: 'rm -rf in-root',
					shell: 'posix',
					scope_files: ['in-root/note.md'],
				},
			]) {
				const result = await call(client, 'scope_validate', unsafe);
				expect(result.isError).toBe(true);
			}
		});
	});

	test('AC4: same idempotency key commits once, replays truthfully, conflicts reject', async () => {
		await withClient(options(), async (client) => {
			const args = {
				idempotency_key: 'ac4-knowledge-001',
				lesson: 'one durable acceptance fact',
				category: 'testing',
				applies_to_tools: ['knowledge_add'],
				required_actions: ['replay safely'],
			};
			const first = await call(client, 'knowledge_add', args);
			const receiptPath = path.join(root, '.swarm', 'mcp-write-receipts.jsonl');
			const replay = await call(client, 'knowledge_add', args);
			const conflict = await call(client, 'knowledge_add', {
				...args,
				lesson: 'different lesson for the same key',
			});
			expect(JSON.stringify(first.content)).not.toContain(
				'Tool knowledge_add not found',
			);
			expect(first.isError).not.toBe(true);
			expect(replay.isError).not.toBe(true);
			expect(JSON.stringify(replay.content)).toMatch(
				/duplicate|replay|committed/i,
			);
			expect(conflict.isError).toBe(true);
			expect(JSON.stringify(conflict.content)).toMatch(/conflict/i);
			expect(existsSync(receiptPath)).toBe(true);
			const receiptText = readFileSync(receiptPath, 'utf8');
			expect(receiptText).not.toContain(args.lesson);
			expect(receiptText).not.toContain(args.idempotency_key);
			expect(receiptText).toMatch(/hash|COMMITTED|committed/i);
		});
	});

	test('AC5a: stale PREPARED receipts return IN_DOUBT', async () => {
		let now = 1_000;
		const args = {
			idempotency_key: 'ac5-stale',
			lesson: 'must not be silently retried',
			category: 'testing',
			applies_to_tools: ['knowledge_add'],
			required_actions: ['stop and inspect'],
		};
		await withClient(
			options({
				writeHooks: {
					now: () => now,
					afterPrepare: async () => {
						throw new Error('simulated client disconnect after PREPARED');
					},
				},
			}),
			async (client) => {
				const interrupted = await call(client, 'knowledge_add', args);
				expect(interrupted.isError).toBe(true);
			},
		);
		now += 60_000;
		await withClient(
			options({ writeHooks: { now: () => now } }),
			async (client) => {
				const result = await call(client, 'knowledge_add', args);
				expect(result.isError).toBe(true);
				expect(JSON.stringify(result.content)).toMatch(/IN_DOUBT|in_doubt/i);
			},
		);
	});

	test('AC5b: receipt persistence before mutation blocks the write', async () => {
		await withClient(
			options({
				writeHooks: {
					persistReceipt: async () => {
						throw new Error('injected receipt persistence failure');
					},
				},
			}),
			async (client) => {
				const result = await call(client, 'knowledge_add', {
					idempotency_key: 'ac5-before-mutation',
					lesson: 'must not be stored',
					category: 'testing',
					applies_to_tools: ['knowledge_add'],
					required_actions: ['do not store'],
				});
				expect(result.isError).toBe(true);
				expect(JSON.stringify(result.content)).not.toMatch(
					/success|committed/i,
				);
				const knowledgePath = path.join(root, '.swarm', 'knowledge.jsonl');
				if (existsSync(knowledgePath)) {
					expect(readFileSync(knowledgePath, 'utf8')).not.toContain(
						'must not be stored',
					);
				}
			},
		);
	});

	test('AC5c: post-mutation receipt failure never reports success', async () => {
		await withClient(
			options({
				writeHooks: {
					afterMutation: async () => {
						throw new Error('injected post-commit persistence failure');
					},
				},
			}),
			async (client) => {
				const result = await call(client, 'knowledge_add', {
					idempotency_key: 'ac5-after-mutation',
					lesson: 'mutation may have happened but receipt did not',
					category: 'testing',
					applies_to_tools: ['knowledge_add'],
					required_actions: ['return in doubt'],
				});
				expect(result.isError).toBe(true);
				expect(JSON.stringify(result.content)).not.toMatch(
					/status.?[:=].?COMMITTED/i,
				);
				expect(JSON.stringify(result.content)).toMatch(
					/IN_DOUBT|in_doubt|failed/i,
				);
			},
		);
	});

	test('AC6: destructive and unreviewed write names remain absent', async () => {
		await withClient(options(), async (client) => {
			const names = (await client.listTools()).tools.map((tool) => tool.name);
			for (const forbidden of [
				'save_plan',
				'update_task_status',
				'swarm_apply_patch',
				'knowledge_remove',
				'knowledge_archive',
				'swarm_command',
			]) {
				expect(names).not.toContain(forbidden);
			}
		});
	});

	test('AC7: docs name four clients and retry/in_doubt policy', () => {
		const text = readFileSync(path.resolve('docs/mcp.md'), 'utf8');
		for (const client of ['Claude Code', 'Cursor', 'VS Code', 'JetBrains']) {
			expect(text).toContain(client);
		}
		expect(text).toMatch(/allow-write|explicit.{0,20}write/i);
		expect(text).toMatch(/retry|idempotenc/i);
		expect(text).toMatch(/in_doubt|IN_DOUBT/);
	});

	test('AC8: production createMcpServer and stdio entry are wired', async () => {
		const parsed = parseMcpServeArgs([
			'--dir',
			root,
			'--allow-write',
			'--write-tool',
			'knowledge_add',
		]);
		expect(parsed).toEqual({
			root,
			allowWrite: true,
			writeTools: ['knowledge_add'],
		});
		const readOnlyWriteAttempt = parseMcpServeArgs([
			'--dir',
			root,
			'--allow-write',
			'--write-tool',
			'scope_validate',
		]);
		expect('error' in readOnlyWriteAttempt).toBe(true);
		expect(typeof createMcpServer).toBe('function');
		expect(typeof runMcpServer).toBe('function');
		await withClient(options(), async (client) => {
			const listed = await client.listTools();
			expect(listed.tools.some((tool) => tool.name === 'knowledge_add')).toBe(
				true,
			);
		});
	});

	test('AC9: pending release fragment exists and describes the feature', () => {
		const pending = path.resolve('docs/releases/pending');
		expect(existsSync(pending)).toBe(true);
		const fragment = '2500-authorized-mcp-writes.md';
		expect(existsSync(path.join(pending, fragment))).toBe(true);
		const body = readFileSync(path.join(pending, fragment), 'utf8');
		expect(body).toMatch(/explicitly authorized|MCP/i);
	});
});
