import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	linkSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_HARNESS_EVOLUTION_CONFIG } from '../../../src/config/schema.js';
import { sha256 } from '../../../src/harness/hash.js';
import {
	_internals,
	type SourceCandidateValidationResult,
	validateSourceCandidate,
} from '../../../src/harness/source-candidate.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const originalRunGit = _internals.runGitCommand;
const originalRunGitBinary = _internals.runGitBinaryCommand;
const originalLstatSync = _internals.lstatSync;

function gitBlobId(text: string | Buffer): string {
	const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text);
	return createHash('sha1')
		.update(Buffer.from(`blob ${bytes.byteLength}\0`))
		.update(bytes)
		.digest('hex');
}

describe('harness source candidate validation', () => {
	let root = '';
	let gitEntries = new Map<string, { mode: string; objectId: string }>();
	let gitBlobs = new Map<string, Buffer>();

	beforeEach(() => {
		root = canonicalMkdtemp('harness-source-candidate-');
		gitEntries = new Map<string, { mode: string; objectId: string }>();
		gitBlobs = new Map<string, Buffer>();

		for (const relativePath of [
			'src/agents/demo.ts',
			'src/agents/extra.ts',
			'src/security/deny.ts',
		]) {
			mkdirSync(path.join(root, path.dirname(relativePath)), {
				recursive: true,
			});
		}

		writeFileSync(
			path.join(root, 'src', 'agents', 'demo.ts'),
			'export const value = 1;\nexport const name = "demo";\n',
			'utf8',
		);
		writeFileSync(
			path.join(root, 'src', 'agents', 'extra.ts'),
			'export const extra = true;\n',
			'utf8',
		);
		writeFileSync(
			path.join(root, 'src', 'security', 'deny.ts'),
			'export const sentinel = true;\n',
			'utf8',
		);

		const demoText = 'export const value = 1;\nexport const name = "demo";\n';
		const extraText = 'export const extra = true;\n';
		const denyText = 'export const sentinel = true;\n';
		gitEntries.set('src/agents/demo.ts', {
			mode: '100644',
			objectId: gitBlobId(demoText),
		});
		gitBlobs.set('src/agents/demo.ts', Buffer.from(demoText));
		gitEntries.set('src/agents/extra.ts', {
			mode: '100644',
			objectId: gitBlobId(extraText),
		});
		gitBlobs.set('src/agents/extra.ts', Buffer.from(extraText));
		gitEntries.set('src/security/deny.ts', {
			mode: '100644',
			objectId: gitBlobId(denyText),
		});
		gitBlobs.set('src/security/deny.ts', Buffer.from(denyText));

		_internals.runGitCommand = async (directory, args) => {
			if (directory !== root) {
				return { ok: false, code: 1, stdout: '', stderr: 'wrong cwd' };
			}
			if (args[0] === 'rev-parse') {
				return { ok: true, code: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' };
			}
			if (args[0] === 'ls-tree') {
				const relativePath = String(args[args.length - 1] ?? '');
				const entry = gitEntries.get(relativePath);
				return {
					ok: true,
					code: 0,
					stdout: entry
						? `${entry.mode} blob ${entry.objectId}\t${relativePath}\0`
						: '',
					stderr: '',
				};
			}
			return {
				ok: false,
				code: 1,
				stdout: '',
				stderr: `unexpected ${args.join(' ')}`,
			};
		};
		_internals.runGitBinaryCommand = async (directory, args) => {
			if (directory !== root) {
				return {
					ok: false,
					code: 1,
					stdout: Buffer.alloc(0),
					stderr: 'wrong cwd',
				};
			}
			if (args[0] === 'show') {
				const spec = String(args[2] ?? '');
				const relativePath = spec.split(':').slice(1).join(':');
				const blob = gitBlobs.get(relativePath);
				return {
					ok: Boolean(blob),
					code: blob ? 0 : 1,
					stdout: blob ?? Buffer.alloc(0),
					stderr: blob ? '' : `missing ${relativePath}`,
				};
			}
			return {
				ok: false,
				code: 1,
				stdout: Buffer.alloc(0),
				stderr: `unexpected ${args.join(' ')}`,
			};
		};
	});

	afterEach(() => {
		_internals.runGitCommand = originalRunGit;
		_internals.runGitBinaryCommand = originalRunGitBinary;
		_internals.lstatSync = originalLstatSync;
		if (root) rmSync(root, { recursive: true, force: true });
		root = '';
		gitEntries = new Map();
		gitBlobs = new Map();
	});

	async function validate(
		overrides: Partial<Parameters<typeof validateSourceCandidate>[0]> = {},
	): Promise<SourceCandidateValidationResult> {
		const beforeText = 'export const value = 1;\nexport const name = "demo";\n';
		const afterText = 'export const value = 2;\nexport const name = "demo";\n';
		return validateSourceCandidate({
			directory: root,
			config: {
				...DEFAULT_HARNESS_EVOLUTION_CONFIG,
				source_allowlist: ['src/agents'],
			},
			candidateId: 'candidate-1',
			baseSha: 'a'.repeat(40),
			origin: 'issue-1825',
			patch: [
				'diff --git a/src/agents/demo.ts b/src/agents/demo.ts',
				`index ${gitBlobId(beforeText).slice(0, 7)}..${gitBlobId(afterText).slice(0, 7)} 100644`,
				'--- a/src/agents/demo.ts',
				'+++ b/src/agents/demo.ts',
				'@@ -1,2 +1,2 @@',
				'-export const value = 1;',
				'+export const value = 2;',
				' export const name = "demo";',
				'',
			].join('\n'),
			...overrides,
		});
	}

	it('accepts a tracked text patch and does not mutate the filesystem', async () => {
		const before = readFileSync(
			path.join(root, 'src', 'agents', 'demo.ts'),
			'utf8',
		);
		const result = await validate();
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.reason);
		expect(result.candidate.patchSha256).toHaveLength(64);
		expect(result.candidate.manifestHash).toHaveLength(64);
		expect(result.candidate.riskTier).toBe('low');
		expect(result.candidate.files).toHaveLength(1);
		expect(result.candidate.files[0]?.relativePath).toBe('src/agents/demo.ts');
		expect(result.candidate.files[0]?.trackedMode).toBe('100644');
		expect(result.candidate.files[0]?.beforeSha256).not.toBe(
			result.candidate.files[0]?.afterSha256,
		);
		expect(
			readFileSync(path.join(root, 'src', 'agents', 'demo.ts'), 'utf8'),
		).toBe(before);
	});

	it('rejects an empty allowlist, protected paths, and stale bases', async () => {
		const emptyAllowlist = await validate({
			config: { ...DEFAULT_HARNESS_EVOLUTION_CONFIG, source_allowlist: [] },
		});
		expect(emptyAllowlist.ok).toBe(false);
		if (emptyAllowlist.ok) throw new Error('expected rejection');
		expect(emptyAllowlist.code).toBe('ALLOWLIST_EMPTY');

		const protectedPath = await validate({
			config: {
				...DEFAULT_HARNESS_EVOLUTION_CONFIG,
				source_allowlist: ['src'],
			},
			patch: [
				'diff --git a/src/security/deny.ts b/src/security/deny.ts',
				`index ${'d'.repeat(7)}..${'e'.repeat(7)} 100644`,
				'--- a/src/security/deny.ts',
				'+++ b/src/security/deny.ts',
				'@@ -1 +1 @@',
				'-export const sentinel = true;',
				'+export const sentinel = false;',
				'',
			].join('\n'),
		});
		expect(protectedPath.ok).toBe(false);
		if (protectedPath.ok) throw new Error('expected rejection');
		expect(protectedPath.code).toBe('PROTECTED_PATH');

		const staleBase = await validate({ baseSha: 'f'.repeat(40) });
		expect(staleBase.ok).toBe(false);
		if (staleBase.ok) throw new Error('expected rejection');
		expect(staleBase.code).toBe('STALE_BASE');
	});

	it('rejects traversal, symlink, binary, and limit violations without mutating files', async () => {
		const demoPath = path.join(root, 'src', 'agents', 'demo.ts');
		const before = readFileSync(demoPath, 'utf8');

		const missing = await validate({
			patch: [
				'diff --git a/src/agents/missing.ts b/src/agents/missing.ts',
				`index ${'9'.repeat(7)}..${'8'.repeat(7)} 100644`,
				'--- a/src/agents/missing.ts',
				'+++ b/src/agents/missing.ts',
				'@@ -1 +1 @@',
				'-export const missing = true;',
				'+export const missing = false;',
				'',
			].join('\n'),
		});
		expect(missing.ok).toBe(false);
		if (missing.ok) throw new Error('expected rejection');
		expect(missing.code).toBe('UNTRACKED_PATH');

		const traversal = await validate({
			patch: [
				'diff --git a/../escape.ts b/../escape.ts',
				`index ${'b'.repeat(7)}..${'c'.repeat(7)} 100644`,
				'--- a/../escape.ts',
				'+++ b/../escape.ts',
				'@@ -1 +1 @@',
				'-export const nope = 1;',
				'+export const nope = 2;',
				'',
			].join('\n'),
		});
		expect(traversal.ok).toBe(false);
		if (traversal.ok) throw new Error('expected rejection');
		expect(traversal.code).toBe('PATH_REJECTED');

		const linkPath = path.join(root, 'src', 'agents', 'linked.ts');
		writeFileSync(linkPath, 'export const linked = true;\n', 'utf8');
		gitEntries.set('src/agents/linked.ts', {
			mode: '100644',
			objectId: '1'.repeat(40),
		});
		_internals.lstatSync = ((targetPath: string) => {
			const stat = originalLstatSync(targetPath);
			if (path.normalize(targetPath) === path.normalize(linkPath)) {
				return { ...stat, isSymbolicLink: () => true };
			}
			return stat;
		}) as typeof _internals.lstatSync;
		const symlink = await validate({
			patch: [
				'diff --git a/src/agents/linked.ts b/src/agents/linked.ts',
				`index ${'1'.repeat(7)}..${'2'.repeat(7)} 100644`,
				'--- a/src/agents/linked.ts',
				'+++ b/src/agents/linked.ts',
				'@@ -1 +1 @@',
				'-export const linked = true;',
				'+export const linked = false;',
				'',
			].join('\n'),
		});
		expect(symlink.ok).toBe(false);
		if (symlink.ok) throw new Error('expected rejection');
		expect(symlink.code).toBe('SYMLINK_PATH');
		_internals.lstatSync = originalLstatSync;

		const binaryPath = path.join(root, 'src', 'agents', 'binary.ts');
		writeFileSync(binaryPath, Buffer.from([0x00, 0x01, 0x02, 0x03]));
		gitEntries.set('src/agents/binary.ts', {
			mode: '100644',
			objectId: '3'.repeat(40),
		});
		gitBlobs.set('src/agents/binary.ts', Buffer.from([0x00, 0x01, 0x02, 0x03]));
		const binary = await validate({
			patch: [
				'diff --git a/src/agents/binary.ts b/src/agents/binary.ts',
				`index ${'3'.repeat(7)}..${'4'.repeat(7)} 100644`,
				'--- a/src/agents/binary.ts',
				'+++ b/src/agents/binary.ts',
				'@@ -1 +1 @@',
				'-ignored',
				'+still ignored',
				'',
			].join('\n'),
		});
		expect(binary.ok).toBe(false);
		if (binary.ok) throw new Error('expected rejection');
		expect(binary.code).toBe('BINARY_FILE');

		const patchTooLarge = await validate({
			config: {
				...DEFAULT_HARNESS_EVOLUTION_CONFIG,
				source_allowlist: ['src/agents'],
				max_patch_bytes: 8,
			},
		});
		expect(patchTooLarge.ok).toBe(false);
		if (patchTooLarge.ok) throw new Error('expected rejection');
		expect(patchTooLarge.code).toBe('PATCH_TOO_LARGE');

		const fileTooLarge = await validate({
			config: {
				...DEFAULT_HARNESS_EVOLUTION_CONFIG,
				source_allowlist: ['src/agents'],
				max_file_bytes: 4,
			},
		});
		expect(fileTooLarge.ok).toBe(false);
		if (fileTooLarge.ok) throw new Error('expected rejection');
		expect(fileTooLarge.code).toBe('FILE_TOO_LARGE');

		expect(readFileSync(demoPath, 'utf8')).toBe(before);
	});

	it('rejects hardlinked files and paths that change during validation', async () => {
		const canonicalTarget = path.join(root, 'demo-hardlink-target.ts');
		writeFileSync(canonicalTarget, 'export const linked = true;\n', 'utf8');
		const hardlinkPath = path.join(root, 'src', 'agents', 'hardlinked.ts');
		linkSync(canonicalTarget, hardlinkPath);
		gitEntries.set('src/agents/hardlinked.ts', {
			mode: '100644',
			objectId: gitBlobId('export const linked = true;\n'),
		});
		gitBlobs.set(
			'src/agents/hardlinked.ts',
			Buffer.from('export const linked = true;\n'),
		);

		const hardlink = await validate({
			patch: [
				'diff --git a/src/agents/hardlinked.ts b/src/agents/hardlinked.ts',
				`index ${gitBlobId('export const linked = true;\n').slice(0, 7)}..${gitBlobId('export const linked = false;\n').slice(0, 7)} 100644`,
				'--- a/src/agents/hardlinked.ts',
				'+++ b/src/agents/hardlinked.ts',
				'@@ -1 +1 @@',
				'-export const linked = true;',
				'+export const linked = false;',
				'',
			].join('\n'),
		});
		expect(hardlink.ok).toBe(false);
		if (hardlink.ok) throw new Error('expected rejection');
		expect(hardlink.code).toBe('HARDLINK_PATH');

		let swapped = false;
		const mockedRunGitBinary = _internals.runGitBinaryCommand;
		_internals.runGitBinaryCommand = async (directory, args) => {
			const result = await mockedRunGitBinary(directory, args);
			if (!swapped && directory === root && args[0] === 'show') {
				swapped = true;
				writeFileSync(
					path.join(root, 'src', 'agents', 'demo.ts'),
					'export const swapped = true;\n',
					'utf8',
				);
			}
			return result;
		};
		const changedPath = await validate();
		expect(changedPath.ok).toBe(false);
		if (changedPath.ok) throw new Error('expected rejection');
		expect(changedPath.code).toBe('PATH_CHANGED_DURING_VALIDATION');
	});

	it('reads tracked source from the declared git base instead of a dirty working tree', async () => {
		const baseText = 'export const value = 1;\nexport const name = "demo";\n';
		const dirtyText =
			'export const value = 999;\nexport const name = "demo";\n';
		const patchedText =
			'export const value = 2;\nexport const name = "demo";\n';
		writeFileSync(
			path.join(root, 'src', 'agents', 'demo.ts'),
			dirtyText,
			'utf8',
		);

		const result = await validate();
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.reason);
		expect(result.candidate.files[0]?.beforeSha256).toBe(sha256(baseText));
		expect(result.candidate.files[0]?.beforeSha256).not.toBe(sha256(dirtyText));
		expect(result.candidate.files[0]?.afterSha256).toBe(sha256(patchedText));
	});
});
