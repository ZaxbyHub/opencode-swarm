import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	abortDeadline,
	withAbortDeadline,
} from '../../../src/utils/abort-deadline.js';

describe('abortDeadline', () => {
	test('arms an abort with a TimeoutError reason when the deadline fires', async () => {
		const { signal, clear } = abortDeadline(5);
		expect(signal.aborted).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(signal.aborted).toBe(true);
		expect(signal.reason).toBeInstanceOf(DOMException);
		expect((signal.reason as DOMException).name).toBe('TimeoutError');
		clear();
	});

	test('clear() disarms the timer and is idempotent', async () => {
		const { signal, clear } = abortDeadline(5);
		clear();
		clear();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(signal.aborted).toBe(false);
	});
});

describe('withAbortDeadline', () => {
	test('returns the delegate value when it resolves in time and clears the timer', async () => {
		const result = await withAbortDeadline(1_000, async () => {
			await new Promise((resolve) => setTimeout(resolve, 1));
			return 'ok';
		});
		expect(result).toBe('ok');
	});

	test('rejects with TimeoutError when the delegate never resolves (Windows/Bun #1964 hang class)', async () => {
		let error: unknown;
		try {
			await withAbortDeadline(5, () => new Promise<string>(() => {}));
		} catch (err) {
			error = err;
		}
		expect(error).toBeInstanceOf(DOMException);
		expect((error as DOMException).name).toBe('TimeoutError');
	});

	test('propagates a real delegate error that is not a timeout', async () => {
		let error: unknown;
		try {
			await withAbortDeadline(1_000, async () => {
				throw new Error('boom');
			});
		} catch (err) {
			error = err;
		}
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe('boom');
	});

	test('delegate rejection after deadline fires surfaces TimeoutError, not the late error', async () => {
		let error: unknown;
		try {
			await withAbortDeadline(5, async (signal) => {
				await new Promise((resolve) => setTimeout(resolve, 30));
				if (signal.aborted) throw new Error('late abort error');
				return 'never';
			});
		} catch (err) {
			error = err;
		}
		expect(error).toBeInstanceOf(DOMException);
		expect((error as DOMException).name).toBe('TimeoutError');
	});

	test('the abort event actually fires on the signal passed to the delegate', async () => {
		let aborted = false;
		try {
			await withAbortDeadline(5, (signal) => {
				return new Promise<string>((_, reject) => {
					signal.addEventListener('abort', () => {
						aborted = true;
					});
					// Never settles on its own — simulates a hung delegate.
				});
			});
		} catch {
			// expected TimeoutError
		}
		expect(aborted).toBe(true);
	});
});

describe('no runtime AbortSignal.timeout remains (#1964)', () => {
	const repoRoot = path.resolve(import.meta.dir, '../../..');

	test('source tree contains zero runtime AbortSignal.timeout calls (comment mentions allowlisted)', () => {
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (entry.name === 'node_modules' || entry.name === '.git') continue;
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
					continue;
				}
				if (!entry.name.endsWith('.ts')) continue;
				const text = fs.readFileSync(full, 'utf-8');
				for (const line of text.split('\n')) {
					const trimmed = line.trim();
					if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
					if (trimmed.includes('AbortSignal.timeout(')) {
						offenders.push(`${full}: ${trimmed}`);
					}
				}
			}
		};
		walk(path.join(repoRoot, 'src'));
		expect(offenders).toEqual([]);
	});

	test('built bundle contains zero AbortSignal.timeout calls when dist exists', () => {
		const dist = path.join(repoRoot, 'dist', 'index.js');
		if (!fs.existsSync(dist)) return; // build-dependent; CI runs after build
		expect(fs.readFileSync(dist, 'utf-8')).not.toContain(
			'AbortSignal.timeout(',
		);
	});
});
