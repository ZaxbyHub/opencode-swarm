import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { knowledgeAddAdapter } from '../../../src/mcp/adapters/knowledge-add';
import {
	buildKnowledgeAddRequest,
	canonicalArguments,
	commitReceipt,
	executeWithReceipt,
	getWriteReceiptPath,
	knowledgeAddInput,
	MAX_RECEIPT_JOURNAL_BYTES,
	MAX_RECEIPT_RESPONSE_BYTES,
	PREPARED_LEASE_MS,
	prepareReceipt,
	sanitizeReceiptResponse,
	WriteReceiptError,
	type WriteReceiptRequest,
} from '../../../src/mcp/write-receipts';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const testRoots = new Set<string>();

function makeTestRoot(prefix: string): string {
	const root = canonicalMkdtemp(prefix);
	testRoots.add(root);
	return root;
}

afterEach(() => {
	mock.restore();
	for (const root of testRoots) {
		rmSync(root, { recursive: true, force: true });
	}
	testRoots.clear();
});

function request(root: string, suffix = 'one'): WriteReceiptRequest {
	return {
		root,
		tool: 'knowledge_add',
		idempotencyKey: 'receipt-test-' + suffix,
		arguments: {
			lesson: 'A durable lesson with enough characters for validation',
			category: 'testing',
			applies_to_tools: ['knowledge_add'],
			required_actions: ['verify receipt'],
		},
	};
}

describe('MCP write receipts (#2500)', () => {
	test('replays the original settlement after a conflicting request', async () => {
		const root = makeTestRoot('mcp-receipts-');
		const first = await prepareReceipt(request(root));
		expect(first.kind).toBe('prepared');
		if (first.kind !== 'prepared') return;
		await commitReceipt(request(root), first.receipt, {
			success: true,
			id: 'knowledge-entry',
		});

		const conflictRequest = request(root);
		conflictRequest.arguments = {
			...conflictRequest.arguments,
			lesson: 'A different durable lesson for the same key',
		};
		const conflict = await prepareReceipt(conflictRequest);
		expect(conflict.kind).toBe('conflict');
		await expect(
			executeWithReceipt(conflictRequest, async () => {
				throw new Error('conflicting production call must not run');
			}),
		).rejects.toThrow(/conflict/i);

		const replay = await prepareReceipt(request(root));
		expect(replay.kind).toBe('replay');
		if (replay.kind === 'replay') {
			expect(replay.response).toEqual({
				success: true,
				id: 'knowledge-entry',
			});
		}

		const journal = readFileSync(getWriteReceiptPath(root), 'utf8');
		expect(journal).not.toContain('receipt-test-one');
		expect(journal).not.toContain('A durable lesson');
		expect(journal).not.toContain(root);
	});

	test('durable preparation precedes a failed afterPrepare handoff', async () => {
		const root = makeTestRoot('mcp-receipts-');
		let calls = 0;
		await expect(
			executeWithReceipt(
				request(root, 'interrupted'),
				async () => {
					calls++;
					return { success: true };
				},
				{
					afterPrepare: async () => {
						throw new Error('disconnect');
					},
				},
			),
		).rejects.toBeInstanceOf(WriteReceiptError);
		expect(calls).toBe(0);
		const journal = readFileSync(getWriteReceiptPath(root), 'utf8');
		expect(journal).toContain('PREPARED');
	});

	test('stale PREPARED becomes IN_DOUBT without re-executing', async () => {
		const root = makeTestRoot('mcp-receipts-');
		let now = 1_000;
		let calls = 0;
		const hooks = { now: () => now };
		await expect(
			executeWithReceipt(
				request(root, 'stale'),
				async () => {
					calls++;
					return { success: true };
				},
				{
					...hooks,
					afterPrepare: async () => {
						throw new Error('disconnect');
					},
				},
			),
		).rejects.toBeInstanceOf(WriteReceiptError);
		now += PREPARED_LEASE_MS;
		await expect(
			executeWithReceipt(
				request(root, 'stale'),
				async () => {
					calls++;
					return { success: true };
				},
				hooks,
			),
		).rejects.toThrow(/IN_DOUBT/);
		expect(calls).toBe(0);
		expect(readFileSync(getWriteReceiptPath(root), 'utf8')).toContain(
			'IN_DOUBT',
		);
	});

	test('receipt persistence failure blocks the production call', async () => {
		const root = makeTestRoot('mcp-receipts-');
		let calls = 0;
		await expect(
			executeWithReceipt(
				request(root, 'before-mutation'),
				async () => {
					calls++;
					return { success: true };
				},
				{
					persistReceipt: async () => {
						throw new Error('disk full');
					},
				},
			),
		).rejects.toThrow();
		expect(calls).toBe(0);
		expect(existsSync(getWriteReceiptPath(root))).toBe(false);
	});

	test('false production results are settled and replayed without re-execution', async () => {
		const root = makeTestRoot('mcp-receipts-');
		let calls = 0;
		const write = async () => {
			calls++;
			return { success: false, error: 'validation failed' };
		};
		const first = await executeWithReceipt(request(root, 'false'), write);
		const replay = await executeWithReceipt(request(root, 'false'), write);
		expect(first).toEqual({ success: false, error: 'validation failed' });
		expect(replay).toMatchObject({
			success: false,
			error: 'validation failed',
			receipt_status: 'replayed',
			replayed: true,
			duplicate: true,
			committed: true,
		});
		expect(calls).toBe(1);
		expect(readFileSync(getWriteReceiptPath(root), 'utf8')).toContain(
			'COMMITTED',
		);
	});

	test('preserves a closed category across commit and same-key replay', async () => {
		const root = makeTestRoot('mcp-receipts-');
		const liveRequest = request(root, 'category-replay');
		liveRequest.arguments = {
			...liveRequest.arguments,
			category: 'security',
		};
		const rawLesson = 'A durable lesson with enough characters for validation';
		const rawIdempotencyKey = liveRequest.idempotencyKey;

		const live = await executeWithReceipt(liveRequest, async () => ({
			success: true,
			category: 'security',
			lesson: rawLesson,
			idempotency_key: rawIdempotencyKey,
		}));
		const replay = await executeWithReceipt(liveRequest, async () => {
			throw new Error('same-key replay must not execute production code');
		});

		expect(live).toMatchObject({ success: true, category: 'security' });
		expect(replay).toMatchObject({
			success: true,
			category: 'security',
			receipt_status: 'replayed',
		});
		expect(replay).not.toHaveProperty('lesson');
		expect(replay).not.toHaveProperty('idempotency_key');

		const journal = readFileSync(getWriteReceiptPath(root), 'utf8');
		const committed = journal
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as { response?: string; state: string })
			.find((record) => record.state === 'COMMITTED');
		expect(committed).toBeDefined();
		expect(JSON.parse(committed?.response ?? '{}')).toEqual({
			success: true,
			category: 'security',
		});
		expect(journal).not.toContain(rawLesson);
		expect(journal).not.toContain(rawIdempotencyKey);
	});

	test('production exceptions are uncertain and cannot be retried', async () => {
		const root = makeTestRoot('mcp-receipts-');
		let calls = 0;
		const failing = () => {
			calls++;
			return Promise.reject(new Error('failed lesson secret'));
		};
		await expect(
			executeWithReceipt(request(root, 'throws'), failing),
		).rejects.toThrow(/IN_DOUBT/);
		await expect(
			executeWithReceipt(request(root, 'throws'), failing),
		).rejects.toThrow(/IN_DOUBT/);
		expect(calls).toBe(1);
		const journal = readFileSync(getWriteReceiptPath(root), 'utf8');
		expect(journal).not.toContain('A durable lesson');
		expect(journal).not.toContain('receipt-test-throws');
	});

	test('receipt lock is released while production work is running', async () => {
		const root = makeTestRoot('mcp-receipts-');
		let release!: () => void;
		let operationStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			operationStarted = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = executeWithReceipt(
			request(root, 'outside-lock'),
			async () => {
				operationStarted();
				await gate;
				return { success: true };
			},
		);
		await started;
		const second = await prepareReceipt(request(root, 'outside-lock'));
		expect(second.kind).toBe('in_progress');
		release();
		await first;
	});

	test('a concurrent conflicting request cannot mask the live exact attempt', async () => {
		const root = makeTestRoot('mcp-receipts-');
		const originalRequest = request(root, 'concurrent-conflict');
		const original = await prepareReceipt(originalRequest);
		expect(original.kind).toBe('prepared');
		if (original.kind !== 'prepared') return;
		const conflictingRequest = request(root, 'concurrent-conflict');
		conflictingRequest.arguments = {
			...conflictingRequest.arguments,
			lesson: 'A different concurrent lesson for the same key',
		};
		expect((await prepareReceipt(conflictingRequest)).kind).toBe('conflict');
		expect((await prepareReceipt(originalRequest)).kind).toBe('in_progress');
		await commitReceipt(originalRequest, original.receipt, { success: true });
		expect((await prepareReceipt(originalRequest)).kind).toBe('replay');
	});

	test('corrupt and truncated journals fail closed', async () => {
		const root = makeTestRoot('mcp-receipts-');
		const journal = getWriteReceiptPath(root);
		mkdirSync(path.dirname(journal), { recursive: true });
		writeFileSync(journal, '{"version":1}\n{"truncated":true}', 'utf8');
		await expect(
			prepareReceipt(request(root, 'corrupt')),
		).rejects.toMatchObject({ code: 'JOURNAL_CORRUPT' });
	});

	test('response bounds are measured in UTF-8 bytes', () => {
		const response = sanitizeReceiptResponse(
			'x'.repeat(MAX_RECEIPT_RESPONSE_BYTES) + '😀',
		);
		expect(Buffer.byteLength(response, 'utf8')).toBeLessThanOrEqual(
			MAX_RECEIPT_RESPONSE_BYTES,
		);
		expect(response).not.toContain('\uFFFD');
	});

	test('canonical arguments retain an own __proto__ key distinction', () => {
		const withProto = JSON.parse('{"__proto__":{"value":1},"name":"x"}');
		expect(canonicalArguments(withProto)).not.toBe(
			canonicalArguments({ name: 'x' }),
		);
	});

	test('oversized journals are rejected before unbounded reads', async () => {
		const root = makeTestRoot('mcp-receipts-');
		const journal = getWriteReceiptPath(root);
		mkdirSync(path.dirname(journal), { recursive: true });
		writeFileSync(journal, 'x'.repeat(MAX_RECEIPT_JOURNAL_BYTES + 1), 'utf8');
		await expect(
			prepareReceipt(request(root, 'oversized')),
		).rejects.toMatchObject({
			code: 'JOURNAL_CAPACITY',
		});
	});

	test('receipt paths reject a symlinked .swarm boundary where supported', async () => {
		if (process.platform === 'win32') return;
		const root = makeTestRoot('mcp-receipts-');
		const outside = makeTestRoot('mcp-receipts-outside-');
		symlinkSync(outside, path.join(root, '.swarm'), 'dir');
		await expect(
			prepareReceipt(request(root, 'symlink')),
		).rejects.toMatchObject({
			code: 'JOURNAL_UNAVAILABLE',
		});
	});

	test('knowledge_add input bounds arrays before production cloning', () => {
		const root = makeTestRoot('mcp-receipts-');
		const base = {
			idempotency_key: 'bounded',
			lesson: 'A durable lesson with enough characters for validation',
			category: 'testing',
		};
		expect(() =>
			buildKnowledgeAddRequest(root, {
				...base,
				required_actions: Array.from({ length: 21 }, () => 'verify'),
			}),
		).toThrow(/bounded capacity/);
		expect(() =>
			buildKnowledgeAddRequest(root, {
				...base,
				lesson: 'x'.repeat(281),
			}),
		).toThrow(/too long/);
	});

	test('knowledge_add schema rejects control characters in idempotency_key', () => {
		for (const idempotency_key of ['key\u0000null', 'key\u007Fdelete']) {
			expect(
				knowledgeAddInput.safeParse({
					idempotency_key,
					lesson: 'A durable lesson with enough characters for validation',
					category: 'testing',
				}).success,
			).toBe(false);
		}
	});

	test('receipt sanitizer keeps only the bounded production result schema', () => {
		const root = makeTestRoot('mcp-receipts-');
		const response = sanitizeReceiptResponse(
			{
				success: false,
				error: 'bounded',
				secret_field: 'must not persist',
			},
			{
				root,
				idempotencyKey: 'sanitize-key',
				arguments: { lesson: 'bounded', scope: 'private' },
			},
		);
		expect(JSON.parse(response)).toEqual({
			success: false,
			error: '[redacted]',
		});
		expect(response).not.toContain('secret_field');
	});

	test('knowledge adapter requires and strips idempotency_key', () => {
		const root = makeTestRoot('mcp-receipts-');
		const args = {
			idempotency_key: 'adapter-key',
			lesson: 'A durable lesson with enough characters for validation',
			category: 'testing',
			applies_to_tools: ['knowledge_add'],
			required_actions: ['verify receipt'],
		};
		const built = buildKnowledgeAddRequest(root, args);
		expect(built.productionArgs).not.toHaveProperty('idempotency_key');
		expect(built.request.idempotencyKey).toBe('adapter-key');
		expect(knowledgeAddAdapter.name).toBe('knowledge_add');
		expect(knowledgeAddAdapter.kind).toBe('write');
	});
});
