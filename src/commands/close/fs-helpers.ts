import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ACTIVE_STATE_UNLINK_RETRY_DELAYS_MS } from './constants.js';
import { _internals } from './internals.js';

export async function copyDirRecursiveWithFailures(
	src: string,
	dest: string,
): Promise<{ copied: number; failures: string[] }> {
	let count = 0;
	const failures: string[] = [];
	const entries = await fs.readdir(src);
	await fs.mkdir(dest, { recursive: true });
	for (const entry of entries) {
		const srcEntry = path.join(src, entry);
		const destEntry = path.join(dest, entry);
		try {
			const stat = await fs.stat(srcEntry);
			if (stat.isDirectory()) {
				const subResult = await copyDirRecursiveWithFailures(
					srcEntry,
					destEntry,
				);
				count += subResult.copied;
				failures.push(...subResult.failures);
			} else {
				try {
					await fs.copyFile(srcEntry, destEntry);
					count++;
				} catch (err) {
					const errno = (err as NodeJS.ErrnoException)?.code;
					if (errno !== 'ENOENT') {
						failures.push(
							`${srcEntry}: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
			}
		} catch (err) {
			const errno = (err as NodeJS.ErrnoException)?.code;
			if (errno !== 'ENOENT') {
				failures.push(
					`${srcEntry}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}
	return { copied: count, failures };
}
/**
 * Backward-compatible wrapper that returns only the copied count.
 * Direct callers (including tests) that expect a number continue to work.
 * Use copyDirRecursiveWithFailures when per-file failure tracking is needed.
 */
export async function copyDirRecursive(
	src: string,
	dest: string,
): Promise<number> {
	const result = await copyDirRecursiveWithFailures(src, dest);
	return result.copied;
}
/**
 * Delete one archived active-state artifact, tolerating the short-lived file
 * locks Windows antivirus and SQLite sidecars can retain after handle close.
 * Non-transient errors fail immediately; the retry budget is bounded to
 * 375 ms so `/swarm close` remains responsive.
 */
export async function unlinkActiveStateFileWithRetry(
	filePath: string,
): Promise<void> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			await _internals.unlink(filePath);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			const delay = ACTIVE_STATE_UNLINK_RETRY_DELAYS_MS[attempt];
			if ((code !== 'EBUSY' && code !== 'EPERM') || delay === undefined) {
				throw error;
			}
			if (attempt === 0) _internals.collectGarbageBestEffort();
			await _internals.sleep(delay);
		}
	}
}
