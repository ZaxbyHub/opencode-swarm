import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import {
	buildReviewerTaskScope,
	_internals as receiptScopeInternals,
} from '../../../src/hooks/review-receipt-scope';
import {
	captureReviewerScopeFileFingerprint,
	_internals as fingerprintInternals,
} from '../../../src/hooks/reviewer-scope-file-fingerprint';

let directory: string;
const realRead = fingerprintInternals.read;

function git(args: string[]): string {
	const result = spawnSync('git', args, {
		cwd: directory,
		encoding: 'utf-8',
		timeout: 5_000,
		maxBuffer: 64 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || `git ${args.join(' ')} failed`);
	}
	return result.stdout;
}

beforeEach(() => {
	directory = fs.realpathSync(
		fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'review-scope-races-')),
		),
	);
	git(['init']);
	fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, 'src', 'a.ts'),
		'export const n = 1;\n',
	);
	git(['add', 'src/a.ts']);
	git([
		'-c',
		'user.name=Race Test',
		'-c',
		'user.email=race@example.invalid',
		'commit',
		'-m',
		'baseline',
	]);
});

afterEach(() => {
	fingerprintInternals.read = realRead;
	receiptScopeInternals.spawn = originalReceiptSpawn;
	fs.rmSync(directory, { recursive: true, force: true });
});

const originalReceiptSpawn = receiptScopeInternals.spawn;

describe('reviewer scope capture races (v2)', () => {
	test('rejects a same-size content replacement during streaming; no partial digest', () => {
		let streamReads = 0;
		fingerprintInternals.read = ((
			fd: number,
			buffer: Buffer,
			offset: number,
			length: number,
			position: number | null,
		) => {
			streamReads += 1;
			const bytesRead = realRead(fd, buffer, offset, length, position);
			if (streamReads === 1) {
				// Swap in different content of the SAME size mid-stream.
				fs.writeFileSync(
					path.join(directory, 'src/a.ts'),
					'export const m = 1;\n',
				);
			}
			return bytesRead;
		}) as typeof realRead;

		const captured = captureReviewerScopeFileFingerprint(directory, 'src/a.ts');
		expect(streamReads).toBeGreaterThan(0);
		expect(captured).toMatchObject({
			kind: 'capture_failed',
			code: 'file_changed_during_capture',
			retryable: true,
		});
	});

	test('rejects a full file replacement after streaming via final path identity', () => {
		let streamReads = 0;
		fingerprintInternals.read = ((
			fd: number,
			buffer: Buffer,
			offset: number,
			length: number,
			position: number | null,
		) => {
			streamReads += 1;
			const bytesRead = realRead(fd, buffer, offset, length, position);
			if (streamReads === 1) {
				// Replace with different content AND size after the descriptor
				// streamed its first chunk: the final path stat must disagree.
				fs.writeFileSync(
					path.join(directory, 'src/a.ts'),
					'replaced with different length content\n',
				);
			}
			return bytesRead;
		}) as typeof realRead;

		const captured = captureReviewerScopeFileFingerprint(directory, 'src/a.ts');
		expect(captured).toMatchObject({
			kind: 'capture_failed',
			code: 'file_changed_during_capture',
			retryable: true,
		});
	});

	test('a stable file still captures exactly across the same hooks', () => {
		const captured = captureReviewerScopeFileFingerprint(directory, 'src/a.ts');
		expect(captured).toMatchObject({ kind: 'captured_file', size: 20 });
	});

	test('HEAD advance between initial SHA and capture recheck is typed retryable', async () => {
		// Fake spawn: the first rev-parse returns the real HEAD; the second
		// (final recheck) returns a different valid SHA — a HEAD race.
		const realSha = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
			cwd: directory,
			encoding: 'utf-8',
			timeout: 5_000,
		}).stdout.trim();
		let spawnCalls = 0;
		receiptScopeInternals.spawn = (() => {
			spawnCalls += 1;
			const sha = spawnCalls <= 1 ? realSha : 'f'.repeat(40);
			const stdout = new PassThrough();
			const fakeChild = Object.assign(new EventEmitter(), {
				stdin: null,
				stdout,
				stderr: null,
				kill: () => true,
			}) as unknown as ReturnType<typeof originalReceiptSpawn>;
			queueMicrotask(() => {
				stdout.write(`${sha}\n`);
				stdout.end();
				fakeChild.emit('close', 0);
			});
			return fakeChild;
		}) as typeof originalReceiptSpawn;

		const result = await buildReviewerTaskScope(directory, ['src/a.ts']);
		expect(spawnCalls).toBeGreaterThanOrEqual(2);
		expect(result).toMatchObject({
			ok: false,
			code: 'head_changed',
			retryable: true,
		});
	});
});
