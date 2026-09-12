import { afterAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const CLI_PATH = path.join(import.meta.dir, '../../../src/cli/index.ts');
const root = canonicalMkdtemp('mcp-cli-stdio-2500-');

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

type Readable = ReadableStreamDefaultReader<Uint8Array>;

async function readJsonLines(
	reader: Readable,
	count: number,
	timeoutMs = 10_000,
): Promise<unknown[]> {
	const decoder = new TextDecoder();
	let buffered = '';
	const responses: unknown[] = [];
	while (responses.length < count) {
		let timerId: ReturnType<typeof setTimeout> | undefined;
		const timer = new Promise<never>((_, reject) => {
			timerId = setTimeout(
				() => reject(new Error('stdio response timeout')),
				timeoutMs,
			);
		});
		let result: Awaited<ReturnType<Readable['read']>>;
		try {
			result = await Promise.race([reader.read(), timer]);
		} finally {
			if (timerId !== undefined) clearTimeout(timerId);
		}
		if (result.done) throw new Error('stdio server exited before responding');
		buffered += decoder.decode(result.value, { stream: true });
		const lines = buffered.split('\n');
		buffered = lines.pop() ?? '';
		for (const line of lines) {
			if (line.trim() !== '') responses.push(JSON.parse(line));
		}
	}
	return responses;
}

describe('MCP production CLI stdio boundary (#2500)', () => {
	test('lazy-imported CLI starts the real stdio server and answers tools/list', async () => {
		const proc = Bun.spawn(
			[process.execPath, 'run', CLI_PATH, 'mcp', 'serve', '--dir', root],
			{
				cwd: path.resolve(import.meta.dir, '../../..'),
				stdin: 'pipe',
				stdout: 'pipe',
				stderr: 'pipe',
				timeout: 15_000,
			},
		);
		const reader = proc.stdout.getReader();
		try {
			const requests = [
				{
					jsonrpc: '2.0',
					id: 1,
					method: 'initialize',
					params: {
						protocolVersion: '2025-06-18',
						capabilities: {},
						clientInfo: { name: 'mcp-cli-smoke', version: '0.0.0' },
					},
				},
				{
					jsonrpc: '2.0',
					method: 'notifications/initialized',
					params: {},
				},
				{ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
			];
			proc.stdin.write(
				`${requests.map((request) => JSON.stringify(request)).join('\n')}\n`,
			);
			proc.stdin.end();
			const responses = await readJsonLines(reader, 2);
			const initialize = responses[0] as { result?: { serverInfo?: unknown } };
			const list = responses[1] as {
				result?: { tools?: Array<{ name?: string }> };
			};
			expect(initialize.result?.serverInfo).toBeDefined();
			expect(list.result?.tools?.map((tool) => tool.name)).toContain(
				'scope_validate',
			);
		} finally {
			reader.releaseLock();
			proc.kill();
			await proc.exited;
		}
	}, 30_000);
});
