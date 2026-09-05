/**
 * Capped JSONL append + bounded tail read (issue #2483 §1).
 *
 * `appendCappedJsonl` enforces the entry/byte caps on EVERY completed state:
 * when an append would push the file past its caps, the compacted prefix
 * (newest whole records that fit, minus the incoming record) is first
 * swapped in crash-atomically (temp file + rename with a Windows
 * transient-error retry), then the new record is appended — so an
 * interleaved reader never observes more than the caps. Compaction has a
 * whole-record floor: a non-empty stream is never emptied by compaction —
 * at least the newest single record always survives, whatever the effective
 * cap (the #2483 acceptance contract).
 *
 * Concurrency: all calls for the same `filePath` serialize through a
 * per-file async mutex, so in-process concurrent appenders can never lose a
 * line to the compaction rename (review finding FB-4). Cross-process
 * writers remain best-effort by the documented fail-open contract (audit
 * streams; the one lockfile-guarded writer predates this module).
 *
 * `readTailJsonl` reads only the last `maxBytes` bytes (newline-aligned) and
 * parses at most `maxEntries` records from the end, so every reader that
 * routes through it is O(cap), not O(history). `readTailJsonlDetailed`
 * additionally reports whether a torn trailing line was skipped, for
 * callers whose conservative decisions depend on tail completeness.
 *
 * Plumbing module: callers own their streams (retention-registry exemption;
 * callers' rows carry the citations).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const RENAME_MAX_ATTEMPTS = 4;
const RENAME_RETRY_DELAY_MS = 50;

export interface CappedJsonlOptions {
	maxEntries: number;
	/** Optional byte cap for the compacted file. */
	maxBytes?: number;
	/**
	 * Invoked when compaction drops `droppedCount` oldest records to enforce
	 * the caps. Lets stream owners surface truncation (review finding FB-5)
	 * instead of failing silently; failures thrown here are swallowed.
	 */
	onPrune?: (droppedCount: number) => void;
}

/**
 * Per-file async mutex: chains every append/compaction for one file so
 * in-process concurrent writers serialize instead of racing the
 * read-modify-rename compaction window. Entries are pruned when the chain
 * tail settles and no waiter remains (bounded growth, session-state
 * invariant 8).
 */
const appendChains = new Map<string, Promise<void>>();

function withFileLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
	const key = path.resolve(filePath);
	const tail = appendChains.get(key) ?? Promise.resolve();
	const run = tail.then(task, task);
	const settled = run.then(
		() => {
			if ((appendChains.get(key) ?? settled) === settled) {
				appendChains.delete(key);
			}
		},
		() => {
			if ((appendChains.get(key) ?? settled) === settled) {
				appendChains.delete(key);
			}
		},
	);
	appendChains.set(key, settled);
	return run;
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Synchronous retry: reserved for sync-only writers (divergence-recorder). */
function renameWithRetrySync(from: string, to: string): void {
	let lastError: unknown;
	for (let attempt = 1; attempt <= RENAME_MAX_ATTEMPTS; attempt++) {
		try {
			fs.renameSync(from, to);
			return;
		} catch (error) {
			lastError = error;
			const code =
				typeof error === 'object' && error !== null && 'code' in error
					? String((error as { code?: unknown }).code)
					: '';
			if (
				code !== 'EBUSY' &&
				code !== 'EPERM' &&
				code !== 'EEXIST' &&
				code !== 'ENOTEMPTY'
			) {
				throw error;
			}
			if (attempt < RENAME_MAX_ATTEMPTS) {
				sleepSync(RENAME_RETRY_DELAY_MS);
			}
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Async retry: does not block the plugin-host event loop (review FB-13). */
async function renameWithRetry(from: string, to: string): Promise<void> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= RENAME_MAX_ATTEMPTS; attempt++) {
		try {
			await fs.promises.rename(from, to);
			return;
		} catch (error) {
			lastError = error;
			const code =
				typeof error === 'object' && error !== null && 'code' in error
					? String((error as { code?: unknown }).code)
					: '';
			if (
				code !== 'EBUSY' &&
				code !== 'EPERM' &&
				code !== 'EEXIST' &&
				code !== 'ENOTEMPTY'
			) {
				throw error;
			}
			if (attempt < RENAME_MAX_ATTEMPTS) {
				await sleep(RENAME_RETRY_DELAY_MS);
			}
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Split text into whole non-empty trimmed lines. */
function wholeLines(content: string): string[] {
	return content
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

/**
 * Select the records compaction keeps: walk newest → oldest, take at most
 * `maxEntries`, stop when the byte budget (when set) is exhausted, and
 * always keep at least the newest single record.
 */
function selectCompactionSurvivors(
	lines: string[],
	opts: CappedJsonlOptions,
): string[] {
	const kept: string[] = [];
	let keptBytes = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (kept.length >= opts.maxEntries) break;
		const line = lines[i];
		const lineBytes = Buffer.byteLength(`${line}\n`, 'utf-8');
		if (
			kept.length > 0 &&
			opts.maxBytes !== undefined &&
			keptBytes + lineBytes > opts.maxBytes
		) {
			break;
		}
		kept.unshift(line);
		keptBytes += lineBytes;
	}
	return kept;
}

async function appendAndCap(
	filePath: string,
	line: string,
	opts: CappedJsonlOptions,
): Promise<void> {
	const directory = path.dirname(filePath);
	fs.mkdirSync(directory, { recursive: true });
	const record = `${line.trim()}\n`;
	// Compact BEFORE appending: survivors are computed for the file AS IF the
	// new record were already present, the compacted prefix (everything kept
	// except the new record) is swapped in via tmp+rename, and only then is
	// the new record appended. An interleaved reader therefore never observes
	// more than the caps — the append-first ordering used previously left a
	// cap+1 window between the append and the compaction rename landing
	// (flush-boundary flakes in the #2483 width tests).
	let existing = '';
	try {
		existing = await fs.promises.readFile(filePath, 'utf-8');
	} catch {
		/* new file: nothing to compact */
	}
	const lines = wholeLines(existing);
	const combined = [...lines, line.trim()];
	// selectCompactionSurvivors always returns a contiguous suffix of its
	// input (it walks newest→oldest and only ever stops early), so the kept
	// prefix excluding the new record is `combined.slice(k, len-1)`.
	const survivors = selectCompactionSurvivors(combined, opts);
	const dropped = combined.length - survivors.length;
	if (dropped > 0) {
		const compactedLines = combined.slice(dropped, combined.length - 1);
		const compacted =
			compactedLines.length > 0 ? `${compactedLines.join('\n')}\n` : '';
		const tmp = path.join(
			directory,
			`.${path.basename(filePath)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
		);
		fs.writeFileSync(tmp, compacted, 'utf-8');
		try {
			await renameWithRetry(tmp, filePath);
		} catch (error) {
			try {
				fs.unlinkSync(tmp);
			} catch {
				/* best-effort residue cleanup */
			}
			throw error instanceof Error ? error : new Error(String(error));
		}
		if (opts.onPrune) {
			try {
				opts.onPrune(dropped);
			} catch {
				/* surfacing must never break the append */
			}
		}
	}
	await fs.promises.appendFile(filePath, record, 'utf-8');
}

/**
 * Test/inspection seam (review round 2): exposes the mutex so the
 * concurrent-append test can assert the chain fully drains instead of
 * reasoning about the self-deletion logic.
 */
export const _internals = {
	appendChains,
	withFileLock,
};

/**
 * Append `line` (a bare JSON record without the trailing newline) to
 * `filePath`, enforcing the caps with a crash-atomic compaction when
 * exceeded. Calls for the same file serialize through a per-file async
 * mutex (in-process writers never lose lines to the compaction rename);
 * the compaction rewrite is temp+rename, so a crash mid-compaction leaves
 * either the old complete file or the new complete file — never a torn one.
 */
export async function appendCappedJsonl(
	filePath: string,
	line: string,
	opts: CappedJsonlOptions,
): Promise<void> {
	return withFileLock(filePath, () => appendAndCap(filePath, line, opts));
}

export interface TailJsonlOptions {
	maxEntries?: number;
	maxBytes?: number;
}

export interface TailJsonlResult<T> {
	records: T[];
	/**
	 * True when a torn (unterminated) trailing line was skipped by the
	 * newline-alignment or whole-line filter. Conservative callers (e.g.
	 * evolution terminal detection) treat this as "state uncertain".
	 */
	tailTruncated: boolean;
}

async function readTailInternal<T>(
	filePath: string,
	opts: TailJsonlOptions,
): Promise<TailJsonlResult<T>> {
	let content: string;
	let tailTruncated = false;
	try {
		if (opts.maxBytes !== undefined) {
			const stat = await fs.promises.stat(filePath);
			if (stat.size > opts.maxBytes) {
				const handle = await fs.promises.open(filePath, 'r');
				try {
					const start = Math.max(0, stat.size - opts.maxBytes);
					const buf = Buffer.alloc(opts.maxBytes);
					await handle.read(buf, 0, opts.maxBytes, start);
					content = buf.toString('utf-8');
				} finally {
					await handle.close();
				}
				// Align to the first whole line inside the window.
				const firstNewline = content.indexOf('\n');
				if (firstNewline >= 0) content = content.slice(firstNewline + 1);
			} else {
				content = await fs.promises.readFile(filePath, 'utf-8');
			}
		} else {
			content = await fs.promises.readFile(filePath, 'utf-8');
		}
	} catch {
		return { records: [], tailTruncated: false };
	}
	if (content.length > 0 && !content.endsWith('\n')) {
		tailTruncated = true;
	}
	const lines = wholeLines(content);
	const take =
		opts.maxEntries !== undefined ? lines.slice(-opts.maxEntries) : lines;
	const records: T[] = [];
	for (const line of take) {
		try {
			records.push(JSON.parse(line) as T);
		} catch {
			/* skip malformed line */
		}
	}
	return { records, tailTruncated };
}

/**
 * Bounded tail read: returns at most `maxEntries` records parsed from the
 * end of the file, reading no more than `maxBytes` bytes. Malformed lines
 * are skipped (they can be a torn final write); a missing file is `[]`.
 */
export async function readTailJsonl<T>(
	filePath: string,
	opts: TailJsonlOptions,
): Promise<T[]> {
	const { records } = await readTailInternal<T>(filePath, opts);
	return records;
}

/**
 * Bounded tail read that also reports whether a torn trailing line was
 * skipped, so conservative callers can distinguish "no record" from
 * "state uncertain" (review FB-11).
 */
export async function readTailJsonlDetailed<T>(
	filePath: string,
	opts: TailJsonlOptions,
): Promise<TailJsonlResult<T>> {
	return readTailInternal<T>(filePath, opts);
}
