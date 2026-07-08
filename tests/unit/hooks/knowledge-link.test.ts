import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	getLinkedLocalKnowledgeStatus,
	invalidateKnowledgeStoreDirCache,
	isLinked,
	type LinkPointer,
	readLinkPointer,
	removeLinkPointer,
	resolveKnowledgeStoreDir,
	resolveLinkBaseDir,
	resolveLinkDir,
	sanitizeLinkId,
	writeLinkPointer,
} from '../../../src/hooks/knowledge-link.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

describe('knowledge-link', () => {
	let platformSpy: ReturnType<typeof spyOn> | undefined;
	const prevXdg = process.env.XDG_DATA_HOME;
	let dataHome: string;
	let dataCleanup: () => void;

	beforeEach(() => {
		invalidateKnowledgeStoreDirCache();
		// Force a deterministic, isolated data dir for the shared link store.
		platformSpy = spyOn(process, 'platform', 'get').mockReturnValue('linux');
		const d = createSafeTestDir('knowledge-link-data-');
		dataHome = d.dir;
		dataCleanup = d.cleanup;
		process.env.XDG_DATA_HOME = dataHome;
	});

	afterEach(() => {
		platformSpy?.mockRestore();
		if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = prevXdg;
		invalidateKnowledgeStoreDirCache();
		dataCleanup?.();
	});

	describe('sanitizeLinkId', () => {
		test('keeps safe characters and lowercases', () => {
			expect(sanitizeLinkId('My-Feature_1.2')).toBe('my-feature_1.2');
		});
		test('collapses unsafe runs into single hyphen', () => {
			expect(sanitizeLinkId('a b/c@@d')).toBe('a-b-c-d');
		});
		test('strips leading/trailing separators', () => {
			expect(sanitizeLinkId('--foo--')).toBe('foo');
			expect(sanitizeLinkId('...bar...')).toBe('bar');
		});
		test('returns null for empty / all-unsafe input', () => {
			expect(sanitizeLinkId('')).toBeNull();
			expect(sanitizeLinkId('///')).toBeNull();
			expect(sanitizeLinkId('   ')).toBeNull();
		});
		test('rejects Windows reserved device names', () => {
			expect(sanitizeLinkId('con')).toBeNull();
			expect(sanitizeLinkId('NUL')).toBeNull();
			expect(sanitizeLinkId('com1')).toBeNull();
			expect(sanitizeLinkId('LPT9')).toBeNull();
			// reserved name as the pre-extension base is also rejected
			expect(sanitizeLinkId('con.txt')).toBeNull();
			// non-reserved names that merely contain the substring are fine
			expect(sanitizeLinkId('console')).toBe('console');
			expect(sanitizeLinkId('comms')).toBe('comms');
		});
		test('bounds length to a single path segment', () => {
			const long = 'a'.repeat(200);
			const out = sanitizeLinkId(long);
			expect(out).not.toBeNull();
			expect((out as string).length).toBeLessThanOrEqual(64);
		});
		test('does not leave a path separator after truncation', () => {
			// 63 'a's then a separator at index 63 — truncation must not expose it.
			const input = `${'a'.repeat(63)}-bbbbb`;
			const out = sanitizeLinkId(input) as string;
			expect(out.endsWith('-')).toBe(false);
		});
	});

	describe('resolveKnowledgeStoreDir', () => {
		test('returns local .swarm when not linked (byte-identical to legacy join)', () => {
			const { dir, cleanup } = createSafeTestDir('knowledge-link-unlinked-');
			try {
				const expected = path.join(dir, '.swarm');
				expect(resolveKnowledgeStoreDir(dir)).toBe(expected);
				expect(isLinked(dir)).toBe(false);
			} finally {
				cleanup();
			}
		});

		test('redirects to the shared link dir when linked', async () => {
			const { dir, cleanup } = createSafeTestDir('knowledge-link-linked-');
			try {
				const pointer: LinkPointer = {
					version: 1,
					linkId: 'shared-proj',
					createdAt: new Date().toISOString(),
					source: 'manual',
				};
				await writeLinkPointer(dir, pointer);
				expect(isLinked(dir)).toBe(true);
				expect(resolveKnowledgeStoreDir(dir)).toBe(
					resolveLinkDir('shared-proj'),
				);
				expect(resolveLinkDir('shared-proj')).toBe(
					path.join(resolveLinkBaseDir(), 'shared-proj'),
				);
			} finally {
				cleanup();
			}
		});

		test('reports a regular local knowledge.jsonl as orphaned when linked', async () => {
			const { dir, cleanup } = createSafeTestDir('knowledge-link-orphan-');
			try {
				await writeLinkPointer(dir, {
					version: 1,
					linkId: 'shared-proj',
					createdAt: new Date().toISOString(),
					source: 'manual',
				});
				fs.writeFileSync(
					path.join(dir, '.swarm', 'knowledge.jsonl'),
					`${JSON.stringify({ id: 'stale-local' })}\n`,
				);

				const status = getLinkedLocalKnowledgeStatus(dir);

				expect(status.linked).toBe(true);
				expect(status.orphaned).toBe(true);
				expect(status.reason).toBe('local_regular_file');
				expect(status.resolvedKnowledgePath).toBe(
					path.join(resolveLinkDir('shared-proj'), 'knowledge.jsonl'),
				);
			} finally {
				cleanup();
			}
		});

		test('does not report an orphan when linked local knowledge.jsonl is absent', async () => {
			const { dir, cleanup } = createSafeTestDir('knowledge-link-no-orphan-');
			try {
				await writeLinkPointer(dir, {
					version: 1,
					linkId: 'shared-proj',
					createdAt: new Date().toISOString(),
					source: 'manual',
				});

				const status = getLinkedLocalKnowledgeStatus(dir);

				expect(status.linked).toBe(true);
				expect(status.orphaned).toBe(false);
				expect(status.reason).toBe('local_missing');
			} finally {
				cleanup();
			}
		});

		test('two worktrees linked to the same id resolve to the same store dir', async () => {
			const a = createSafeTestDir('knowledge-link-a-');
			const b = createSafeTestDir('knowledge-link-b-');
			try {
				const mk = (): LinkPointer => ({
					version: 1,
					linkId: 'team-store',
					createdAt: new Date().toISOString(),
					source: 'manual',
				});
				await writeLinkPointer(a.dir, mk());
				await writeLinkPointer(b.dir, mk());
				expect(resolveKnowledgeStoreDir(a.dir)).toBe(
					resolveKnowledgeStoreDir(b.dir),
				);
			} finally {
				a.cleanup();
				b.cleanup();
			}
		});

		test('fail-open: a corrupt pointer resolves to local .swarm', () => {
			const { dir, cleanup } = createSafeTestDir('knowledge-link-corrupt-');
			try {
				fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
				fs.writeFileSync(
					path.join(dir, '.swarm', 'link.json'),
					'{ not valid json',
				);
				invalidateKnowledgeStoreDirCache(dir);
				expect(resolveKnowledgeStoreDir(dir)).toBe(path.join(dir, '.swarm'));
				expect(readLinkPointer(dir)).toBeNull();
			} finally {
				cleanup();
			}
		});

		test('a pointer missing linkId is rejected (resolves to local)', () => {
			const { dir, cleanup } = createSafeTestDir('knowledge-link-nolinkid-');
			try {
				fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
				fs.writeFileSync(
					path.join(dir, '.swarm', 'link.json'),
					JSON.stringify({ version: 1, source: 'manual' }),
				);
				invalidateKnowledgeStoreDirCache(dir);
				expect(readLinkPointer(dir)).toBeNull();
				expect(resolveKnowledgeStoreDir(dir)).toBe(path.join(dir, '.swarm'));
			} finally {
				cleanup();
			}
		});
	});

	describe('pointer lifecycle', () => {
		test('write then remove reverts resolution and clears the cache', async () => {
			const { dir, cleanup } = createSafeTestDir('knowledge-link-lifecycle-');
			try {
				// Prime the cache with the unlinked result first.
				expect(resolveKnowledgeStoreDir(dir)).toBe(path.join(dir, '.swarm'));

				await writeLinkPointer(dir, {
					version: 1,
					linkId: 'lc',
					createdAt: new Date().toISOString(),
					source: 'manual',
				});
				// writeLinkPointer invalidates the cache, so this reflects immediately.
				expect(resolveKnowledgeStoreDir(dir)).toBe(resolveLinkDir('lc'));

				await removeLinkPointer(dir);
				expect(resolveKnowledgeStoreDir(dir)).toBe(path.join(dir, '.swarm'));
				expect(isLinked(dir)).toBe(false);
			} finally {
				cleanup();
			}
		});

		test('re-sanitizes a hand-edited linkId on read', () => {
			const { dir, cleanup } = createSafeTestDir('knowledge-link-resan-');
			try {
				fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
				fs.writeFileSync(
					path.join(dir, '.swarm', 'link.json'),
					JSON.stringify({ version: 1, linkId: '../escape', source: 'manual' }),
				);
				invalidateKnowledgeStoreDirCache(dir);
				const p = readLinkPointer(dir);
				expect(p).not.toBeNull();
				// '../escape' must be sanitized to a single safe segment.
				expect((p as LinkPointer).linkId).toBe('escape');
				const resolved = resolveKnowledgeStoreDir(dir);
				expect(resolved).toBe(resolveLinkDir('escape'));
				expect(resolved.includes('..')).toBe(false);
			} finally {
				cleanup();
			}
		});
	});
});
