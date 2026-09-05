/**
 * Capped JSONL append + bounded tail read (issue #2483 §1).
 *
 * `appendCappedJsonl` appends one JSONL line and, when the durable file
 * exceeds its entry/byte cap, rewrites it crash-atomically (temp file +
 * rename with a Windows transient-error retry) keeping the NEWEST whole
 * records that fit. Compaction has a whole-record floor: a non-empty stream
 * is never emptied by compaction — at least the newest single record always
 * survives, whatever the effective cap (the #2483 acceptance contract).
 *
 * `readTailJsonl` reads only the last `maxBytes` bytes (newline-aligned) and
 * parses at most `maxEntries` records from the end, so every reader that
 * routes through it is O(cap), not O(history).
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
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(from: string, to: string): void {
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

/**
 * Append `line` (a bare JSON record without the trailing newline) to
 * `filePath`, enforcing the caps with a crash-atomic compaction when
 * exceeded. The append itself is a single `appendFile`; the compaction
 * rewrite is temp+rename, so a crash mid-compaction leaves either the old
 * complete file or the new complete file — never a torn one (a stale `.tmp`
 * residue, if any, is never read by any consumer).
 */
export async function appendCappedJsonl(
	filePath: string,
	line: string,
	opts: CappedJsonlOptions,
): Promise<void> {
	const directory = path.dirname(filePath);
	fs.mkdirSync(directory, { recursive: true });
	const record = `${line.trim()}\n`;
	await fs.promises.appendFile(filePath, record, 'utf-8');

	let existing: string;
	try {
		existing = await fs.promises.readFile(filePath, 'utf-8');
	} catch {
		// The append succeeded but the read raced a concurrent prune; the next
		// append re-checks the caps.
		return;
	}
	const lines = wholeLines(existing);
	const overEntries = lines.length > opts.maxEntries;
	const overBytes =
		opts.maxBytes !== undefined &&
		Buffer.byteLength(existing, 'utf-8') > opts.maxBytes;
	if (!overEntries && !overBytes) {
		return;
	}

	const survivors = selectCompactionSurvivors(lines, opts);
	const compacted = `${survivors.join('\n')}\n`;
	const tmp = path.join(
		directory,
		`.${path.basename(filePath)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
	);
	fs.writeFileSync(tmp, compacted, 'utf-8');
	try {
		renameWithRetry(tmp, filePath);
	} catch (error) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* best-effort residue cleanup */
		}
		throw error instanceof Error ? error : new Error(String(error));
	}
}

export interface TailJsonlOptions {
	maxEntries?: number;
	maxBytes?: number;
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
	let content: string;
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
		return [];
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
	return records;
}
