import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	captureReviewerScopeFileFingerprint,
	_internals as fingerprintInternals,
	REVIEWER_SCOPE_CAPTURE_CHUNK_BYTES,
	reviewerScopeCaptureToFingerprint,
	reviewerScopeFileFingerprintsEqual,
} from '../../../src/hooks/reviewer-scope-file-fingerprint';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let directory = '';
const realRead = fingerprintInternals.read;

beforeEach(() => {
	directory = canonicalMkdtemp('reviewer-scope-capture-v2-');
	fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
});

afterEach(() => {
	fingerprintInternals.read = realRead;
	fs.rmSync(directory, { recursive: true, force: true });
});

describe('reviewer scope capture v2 (issue #2100 acceptance)', () => {
	test('files below, at, and above 1 MiB receive the same complete SHA-256 semantics', () => {
		const cases = [
			{ name: 'src/under.bin', size: 1_048_576 - 1 },
			{ name: 'src/at.bin', size: 1_048_576 },
			{ name: 'src/over.bin', size: 1_048_576 + 1 },
		];
		for (const { name, size } of cases) {
			const content = Buffer.alloc(size, 0x61);
			fs.writeFileSync(path.join(directory, name), content);
			const captured = captureReviewerScopeFileFingerprint(directory, name);
			expect(captured).toMatchObject({ kind: 'captured_file', size });
			if (captured.kind === 'captured_file') {
				expect(captured.hash).toBe(
					crypto.createHash('sha256').update(content).digest('hex'),
				);
			}
		}
	});

	test('a scope above the old 4 MiB aggregate cap is fully fingerprinted (no aggregate identity bound)', () => {
		let total = 0;
		const hashes: string[] = [];
		for (let index = 0; index < 5; index += 1) {
			const name = `src/agg-${index}.bin`;
			const content = Buffer.alloc(1_048_576 - 1, 0x61 + index);
			fs.writeFileSync(path.join(directory, name), content);
			const captured = captureReviewerScopeFileFingerprint(directory, name);
			expect(captured.kind).toBe('captured_file');
			if (captured.kind === 'captured_file') {
				total += captured.size;
				hashes.push(captured.hash);
			}
		}
		expect(total).toBe(5 * (1_048_576 - 1));
		expect(new Set(hashes).size).toBe(5);
	});

	test('bounded memory: an 8 MiB file is hashed in fixed chunks, never whole-file', () => {
		fs.writeFileSync(
			path.join(directory, 'src/huge.bin'),
			Buffer.alloc(8 * 1_048_576, 0x62),
		);
		const readBufferSizes: number[] = [];
		fingerprintInternals.read = ((
			fd: number,
			buffer: Buffer,
			offset: number,
			length: number,
			position: number | null,
		) => {
			readBufferSizes.push(buffer.byteLength);
			return realRead(fd, buffer, offset, length, position);
		}) as typeof realRead;

		const captured = captureReviewerScopeFileFingerprint(
			directory,
			'src/huge.bin',
		);
		expect(captured.kind).toBe('captured_file');
		expect(readBufferSizes.length).toBeGreaterThanOrEqual(
			Math.ceil((8 * 1_048_576) / REVIEWER_SCOPE_CAPTURE_CHUNK_BYTES),
		);
		for (const size of readBufferSizes) {
			expect(size).toBe(REVIEWER_SCOPE_CAPTURE_CHUNK_BYTES);
		}
	});

	test('changing one byte while preserving file size invalidates equality', () => {
		fs.writeFileSync(path.join(directory, 'src/a.ts'), 'export const a = 1;\n');
		const before = reviewerScopeCaptureToFingerprint(
			captureReviewerScopeFileFingerprint(directory, 'src/a.ts'),
		)!;
		fs.writeFileSync(path.join(directory, 'src/a.ts'), 'export const a = 2;\n');
		const after = reviewerScopeCaptureToFingerprint(
			captureReviewerScopeFileFingerprint(directory, 'src/a.ts'),
		)!;
		expect(after.size).toBe(before.size);
		expect(after.hash).not.toBe(before.hash);
		expect(reviewerScopeFileFingerprintsEqual(before, after)).toBe(false);
	});

	test('traversal, absolute, and control-character paths fail closed as outside_workspace/invalid_request', () => {
		expect(
			captureReviewerScopeFileFingerprint(directory, '../escape.ts'),
		).toMatchObject({ kind: 'capture_failed', code: 'outside_workspace' });
		expect(captureReviewerScopeFileFingerprint(directory, '')).toMatchObject({
			kind: 'capture_failed',
			code: 'outside_workspace',
		});
		expect(
			captureReviewerScopeFileFingerprint(directory, 'src/\u0000a.ts'),
		).toMatchObject({ kind: 'capture_failed', code: 'invalid_request' });
	});

	test('a deleted file under a removed directory is captured_deleted when contained', () => {
		fs.mkdirSync(path.join(directory, 'src/gone'), { recursive: true });
		fs.writeFileSync(path.join(directory, 'src/gone/a.ts'), 'x\n');
		const present = captureReviewerScopeFileFingerprint(
			directory,
			'src/gone/a.ts',
		);
		expect(present.kind).toBe('captured_file');
		fs.rmSync(path.join(directory, 'src/gone'), { recursive: true });
		expect(
			captureReviewerScopeFileFingerprint(directory, 'src/gone/a.ts'),
		).toMatchObject({ kind: 'captured_deleted', file: 'src/gone/a.ts' });
	});

	test('non-regular files fail closed as non_regular', () => {
		fs.mkdirSync(path.join(directory, 'src/dir'));
		expect(
			captureReviewerScopeFileFingerprint(directory, 'src/dir'),
		).toMatchObject({ kind: 'capture_failed', code: 'non_regular' });
	});

	test('symlinks fail closed as symlink_or_reparse (posix-only creation)', () => {
		const outsidePath = path.join(directory, 'outside.ts');
		fs.writeFileSync(outsidePath, 'outside\n');
		const linkPath = path.join(directory, 'src/link.ts');
		let created = true;
		try {
			fs.symlinkSync(outsidePath, linkPath);
		} catch {
			created = false;
		}
		if (!created) return; // Windows without symlink privilege: skip
		expect(
			captureReviewerScopeFileFingerprint(directory, 'src/link.ts'),
		).toMatchObject({ kind: 'capture_failed', code: 'symlink_or_reparse' });
	});

	test('retryability classification is exact', () => {
		fs.writeFileSync(path.join(directory, 'src/a.ts'), 'x\n');
		let calls = 0;
		fingerprintInternals.read = ((
			fd: number,
			buffer: Buffer,
			offset: number,
			length: number,
			position: number | null,
		) => {
			calls += 1;
			const bytesRead = realRead(fd, buffer, offset, length, position);
			if (calls === 1) {
				fs.writeFileSync(path.join(directory, 'src/a.ts'), 'yy\n');
			}
			return bytesRead;
		}) as typeof realRead;
		const raced = captureReviewerScopeFileFingerprint(directory, 'src/a.ts');
		expect(raced).toMatchObject({
			kind: 'capture_failed',
			code: 'file_changed_during_capture',
			retryable: true,
		});

		fingerprintInternals.read = realRead;
		fs.mkdirSync(path.join(directory, 'src/notregular'));
		const nonRegular = captureReviewerScopeFileFingerprint(
			directory,
			'src/notregular',
		);
		expect(nonRegular).toMatchObject({
			kind: 'capture_failed',
			code: 'non_regular',
			retryable: false,
		});
	});
});
