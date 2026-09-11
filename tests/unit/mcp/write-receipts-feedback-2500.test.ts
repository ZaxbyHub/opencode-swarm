import { afterEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
	buildKnowledgeAddRequest,
	commitReceipt,
	getWriteReceiptArchivePath,
	getWriteReceiptPath,
	prepareReceipt,
	readWriteReceiptStatus,
} from '../../../src/mcp/write-receipts';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function args(idempotency_key: string, scope?: string) {
	return {
		idempotency_key,
		lesson: 'A durable lesson with enough characters for validation',
		category: 'testing' as const,
		...(scope === undefined ? {} : { scope }),
		applies_to_tools: ['knowledge_add'],
		required_actions: ['verify receipt'],
	};
}

const testRoots = new Set<string>();

function makeTestRoot(prefix: string): string {
	const root = canonicalMkdtemp(prefix);
	testRoots.add(root);
	return root;
}

describe('MCP receipt feedback regressions (#2500)', () => {
	afterEach(() => {
		for (const root of testRoots)
			rmSync(root, { recursive: true, force: true });
		testRoots.clear();
	});

	test('FB-007: omitted and explicit global scopes share an identity', () => {
		const root = makeTestRoot('mcp-receipt-scope-');
		const omitted = buildKnowledgeAddRequest(root, args('same-key'));
		const explicit = buildKnowledgeAddRequest(root, args('same-key', 'global'));
		expect(omitted.request.arguments).toEqual(explicit.request.arguments);
		expect(omitted.request.policy).toBe(explicit.request.policy);
		expect(omitted.request.arguments).toHaveProperty('scope', 'global');
	});

	test('FB-008: status reads expose state but never response or error text', async () => {
		const root = makeTestRoot('mcp-receipt-status-');
		const key = 'status-key';
		const absent = await readWriteReceiptStatus(root, key);
		expect(absent).toEqual({
			found: false,
			status: 'NOT_FOUND',
			retryable: true,
		});
		expect(existsSync(path.join(root, '.swarm'))).toBe(false);

		const request = {
			root,
			tool: 'knowledge_add',
			idempotencyKey: key,
			arguments: { lesson: 'bounded' },
		};
		const prepared = await prepareReceipt(request);
		if (prepared.kind !== 'prepared') throw new Error('expected PREPARED');
		const status = await readWriteReceiptStatus(root, key);
		expect(status).toMatchObject({
			found: true,
			status: 'PREPARED',
			retryable: false,
			archived: false,
		});
		expect(status).not.toHaveProperty('response');
		expect(status).not.toHaveProperty('error');
		await commitReceipt(request, prepared.receipt, {
			success: true,
			secret: 'must not be returned',
		});
		expect(await readWriteReceiptStatus(root, key)).toMatchObject({
			status: 'COMMITTED',
		});
	});

	test('FB-009: receipt transitions reject an oversized serialized line', async () => {
		const root = makeTestRoot('mcp-receipt-line-');
		const request = {
			root,
			tool: 'knowledge_add',
			idempotencyKey: 'line-key',
			arguments: { lesson: 'bounded' },
		};
		// The public schema bounds all normal records below the line limit. This
		// fixture proves a malformed oversized record remains fail-closed when it
		// is encountered on the read path rather than being silently accepted.
		const journal = getWriteReceiptPath(root);
		const swarm = path.dirname(journal);
		mkdirSync(swarm, { recursive: true });
		writeFileSync(
			journal,
			`${JSON.stringify({ version: 1, receipt_id: 'x'.repeat(36), attempt_id: 'y'.repeat(36), tool: 'knowledge_add', root_hash: 'a'.repeat(64), idempotency_hash: 'b'.repeat(64), arguments_digest: 'c'.repeat(64), policy_digest: 'd'.repeat(64), state: 'PREPARED', prepared_at: 1, updated_at: 1, lease_expires_at: 2, error: 'x'.repeat(16_000) })}\n`,
		);
		expect(swarm).toContain('.swarm');
		await expect(prepareReceipt(request)).rejects.toMatchObject({
			code: 'JOURNAL_CAPACITY',
		});
		expect(existsSync(getWriteReceiptArchivePath(root))).toBe(false);
	});

	test('FB-018: terminal history rolls into an archive while status remains readable', async () => {
		const root = makeTestRoot('mcp-receipt-archive-');
		for (let index = 0; index < 251; index += 1) {
			const request = {
				root,
				tool: 'knowledge_add',
				idempotencyKey: `archive-${index}`,
				arguments: { index },
			};
			const prepared = await prepareReceipt(request);
			if (prepared.kind !== 'prepared') throw new Error(`prepare ${index}`);
			await commitReceipt(request, prepared.receipt, { success: true });
		}
		expect(existsSync(getWriteReceiptArchivePath(root))).toBe(true);
		const archive = readFileSync(getWriteReceiptArchivePath(root), 'utf8');
		expect(archive.length).toBeGreaterThan(0);
		// Superseded PREPARED records are terminal audit history once their
		// settlement remains in the active journal; they must not be discarded.
		expect(archive).toContain('PREPARED');
		expect(await readWriteReceiptStatus(root, 'archive-0')).toMatchObject({
			found: true,
			status: 'COMMITTED',
			archived: true,
		});
	}, 30_000);

	test('FB-018: archive failure preserves the prior active journal', async () => {
		const root = makeTestRoot('mcp-receipt-archive-failure-');
		for (let index = 0; index < 251; index += 1) {
			const request = {
				root,
				tool: 'knowledge_add',
				idempotencyKey: `archive-failure-${index}`,
				arguments: { index },
			};
			const prepared = await prepareReceipt(request);
			if (prepared.kind !== 'prepared') throw new Error(`prepare ${index}`);
			await commitReceipt(request, prepared.receipt, { success: true });
		}

		const activePath = getWriteReceiptPath(root);
		const archivePath = getWriteReceiptArchivePath(root);
		const activeBefore = readFileSync(activePath, 'utf8');
		const archiveBefore = existsSync(archivePath)
			? readFileSync(archivePath, 'utf8')
			: '';
		const writes: string[] = [];
		await expect(
			prepareReceipt(
				{
					root,
					tool: 'knowledge_add',
					idempotencyKey: 'archive-failure-next',
					arguments: { next: true },
				},
				{
					persistStorage: async (kind) => {
						writes.push(kind);
						if (kind === 'archive') {
							throw new Error('injected archive persistence failure');
						}
					},
				},
			),
		).rejects.toMatchObject({ code: 'JOURNAL_UNAVAILABLE' });
		expect(writes).toEqual(['archive']);
		expect(readFileSync(activePath, 'utf8')).toBe(activeBefore);
		expect(readFileSync(archivePath, 'utf8')).toBe(archiveBefore);
		expect(
			await readWriteReceiptStatus(root, 'archive-failure-250'),
		).toMatchObject({
			found: true,
			status: 'COMMITTED',
		});
	}, 30_000);

	test('FB-018: active failure leaves a recoverable PREPARED shadow', async () => {
		const root = makeTestRoot('mcp-receipt-active-failure-');
		const firstRequest = {
			root,
			tool: 'knowledge_add',
			idempotencyKey: 'active-failure-first',
			arguments: { first: true },
		};
		const first = await prepareReceipt(firstRequest);
		if (first.kind !== 'prepared') throw new Error('expected first PREPARED');
		await commitReceipt(firstRequest, first.receipt, { success: true });

		const activePath = getWriteReceiptPath(root);
		const archivePath = getWriteReceiptArchivePath(root);
		const activeBefore = readFileSync(activePath, 'utf8');
		const archiveBefore = existsSync(archivePath)
			? readFileSync(archivePath, 'utf8')
			: '';
		const writes: string[] = [];
		await expect(
			prepareReceipt(
				{
					root,
					tool: 'knowledge_add',
					idempotencyKey: 'active-failure-next',
					arguments: { next: true },
				},
				{
					persistStorage: async (kind) => {
						writes.push(kind);
						if (kind === 'active') {
							throw new Error('injected active persistence failure');
						}
					},
				},
			),
		).rejects.toMatchObject({ code: 'JOURNAL_UNAVAILABLE' });
		expect(writes).toEqual(['active']);
		expect(readFileSync(activePath, 'utf8')).toBe(activeBefore);
		expect(readFileSync(archivePath, 'utf8')).not.toBe(archiveBefore);
		expect(
			await readWriteReceiptStatus(root, 'active-failure-next'),
		).toMatchObject({
			found: true,
			status: 'PREPARED',
			archived: true,
			retryable: false,
		});
		expect(
			await readWriteReceiptStatus(root, 'active-failure-first'),
		).toMatchObject({ status: 'COMMITTED' });
	}, 30_000);

	test('FB-023: persistReceipt is not called for a settled no-op', async () => {
		const root = makeTestRoot('mcp-receipt-noop-');
		const request = {
			root,
			tool: 'knowledge_add',
			idempotencyKey: 'noop-key',
			arguments: { lesson: 'bounded' },
		};
		const prepared = await prepareReceipt(request);
		if (prepared.kind !== 'prepared') throw new Error('expected PREPARED');
		await commitReceipt(request, prepared.receipt, { success: true });
		let calls = 0;
		await commitReceipt(
			request,
			prepared.receipt,
			{ success: true },
			{
				persistReceipt: async () => {
					calls += 1;
				},
			},
		);
		expect(calls).toBe(0);
	});
});
