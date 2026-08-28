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

describe('harness source candidate patch forms', () => {
	let root = '';
	let gitEntries = new Map<string, { mode: string; objectId: string }>();
	let gitBlobs = new Map<string, Buffer>();

	beforeEach(() => {
		root = canonicalMkdtemp('harness-source-candidate-forms-');
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

	it('binds declared Git object ids and preserves exact EOF newline semantics', async () => {
		const forgedOld = await validate({
			patch: [
				'diff --git a/src/agents/demo.ts b/src/agents/demo.ts',
				`index ${'f'.repeat(7)}..${gitBlobId('export const value = 2;\nexport const name = "demo";\n').slice(0, 7)} 100644`,
				'--- a/src/agents/demo.ts',
				'+++ b/src/agents/demo.ts',
				'@@ -1,2 +1,2 @@',
				'-export const value = 1;',
				'+export const value = 2;',
				' export const name = "demo";',
				'',
			].join('\n'),
		});
		expect(forgedOld.ok).toBe(false);
		if (forgedOld.ok) throw new Error('expected rejection');
		expect(forgedOld.code).toBe('STALE_BASE');

		const forgedNew = await validate({
			patch: [
				'diff --git a/src/agents/demo.ts b/src/agents/demo.ts',
				`index ${gitBlobId('export const value = 1;\nexport const name = "demo";\n').slice(0, 7)}..${'f'.repeat(7)} 100644`,
				'--- a/src/agents/demo.ts',
				'+++ b/src/agents/demo.ts',
				'@@ -1,2 +1,2 @@',
				'-export const value = 1;',
				'+export const value = 2;',
				' export const name = "demo";',
				'',
			].join('\n'),
		});
		expect(forgedNew.ok).toBe(false);
		if (forgedNew.ok) throw new Error('expected rejection');
		expect(forgedNew.code).toBe('PATCH_DOES_NOT_APPLY');

		const noNewlineText = 'export const created = true;';
		const noNewline = await validate({
			patch: [
				'diff --git a/src/agents/no-newline.ts b/src/agents/no-newline.ts',
				'new file mode 100644',
				`index ${'0'.repeat(7)}..${gitBlobId(noNewlineText).slice(0, 7)}`,
				'--- /dev/null',
				'+++ b/src/agents/no-newline.ts',
				'@@ -0,0 +1 @@',
				'+export const created = true;',
				'\\ No newline at end of file',
				'',
			].join('\n'),
		});
		expect(noNewline.ok).toBe(true);
		if (!noNewline.ok) throw new Error(noNewline.reason);
		expect(noNewline.candidate.files[0]?.afterSha256).toBe(
			sha256(noNewlineText),
		);

		const earlierBase = 'export const first = 1;\nexport const last = true;';
		const earlierAfter = 'export const first = 2;\nexport const last = true;';
		gitEntries.set('src/agents/no-final-newline.ts', {
			mode: '100644',
			objectId: gitBlobId(earlierBase),
		});
		gitBlobs.set('src/agents/no-final-newline.ts', Buffer.from(earlierBase));
		const earlierHunk = await validate({
			patch: [
				'diff --git a/src/agents/no-final-newline.ts b/src/agents/no-final-newline.ts',
				`index ${gitBlobId(earlierBase).slice(0, 7)}..${gitBlobId(earlierAfter).slice(0, 7)} 100644`,
				'--- a/src/agents/no-final-newline.ts',
				'+++ b/src/agents/no-final-newline.ts',
				'@@ -1 +1 @@',
				'-export const first = 1;',
				'+export const first = 2;',
				'',
			].join('\n'),
		});
		expect(earlierHunk.ok).toBe(true);
		if (!earlierHunk.ok) throw new Error(earlierHunk.reason);
		expect(earlierHunk.candidate.files[0]?.afterSha256).toBe(
			sha256(earlierAfter),
		);
	});

	it('rejects malformed, miscounted, and overlapping hunks', async () => {
		for (const [patch, code] of [
			[
				[
					'diff --git a/src/agents/demo.ts b/src/agents/demo.ts',
					`index ${gitBlobId('export const value = 1;\nexport const name = "demo";\n').slice(0, 7)}..${gitBlobId('export const value = 2;\nexport const name = "demo";\n').slice(0, 7)} 100644`,
					'--- a/src/agents/demo.ts',
					'+++ b/src/agents/demo.ts',
					'@@ -1,1 +1,2 @@',
					'-export const value = 1;',
					'+export const value = 2;',
					'',
				].join('\n'),
				'UNSUPPORTED_PATCH',
			],
			[
				[
					'diff --git a/src/agents/demo.ts b/src/agents/demo.ts',
					`index ${gitBlobId('export const value = 1;\nexport const name = "demo";\n').slice(0, 7)}..${gitBlobId('export const value = 2;\nexport const name = "demo";\n').slice(0, 7)} 100644`,
					'--- a/src/agents/demo.ts',
					'+++ b/src/agents/demo.ts',
					'@@ -1,1 +1,1 @@',
					'-export const value = 1;',
					'+export const value = 2;',
					'@@ -1,1 +1,1 @@',
					'-export const name = "demo";',
					'+export const name = "dirty";',
					'',
				].join('\n'),
				'UNSUPPORTED_PATCH',
			],
			[
				[
					'diff --git a/src/agents/demo.ts b/src/agents/demo.ts',
					`index ${gitBlobId('export const value = 1;\nexport const name = "demo";\n').slice(0, 7)}..${gitBlobId('export const value = 2;\nexport const name = "demo";\n').slice(0, 7)} 100644`,
					'--- a/src/agents/demo.ts',
					'+++ b/src/agents/demo.ts',
					'@@ -1,1 +2,1 @@',
					'-export const value = 1;',
					'+export const value = 2;',
					'',
				].join('\n'),
				'PATCH_DOES_NOT_APPLY',
			],
		] as const) {
			const result = await validate({ patch });
			expect(result.ok).toBe(false);
			if (result.ok) throw new Error('expected rejection');
			expect(result.code).toBe(code);
		}
	});

	it('accepts git-quoted paths safely', async () => {
		const quotedPath = 'src/agents/space path.ts';
		const secondQuotedPath = 'src/agents/second path.ts';
		mkdirSync(path.join(root, 'src', 'agents'), { recursive: true });
		writeFileSync(
			path.join(root, 'src', 'agents', 'space path.ts'),
			'export const label = "space";\n',
			'utf8',
		);
		gitEntries.set(quotedPath, {
			mode: '100644',
			objectId: gitBlobId('export const label = "space";\n'),
		});
		gitBlobs.set(quotedPath, Buffer.from('export const label = "space";\n'));
		gitEntries.set(secondQuotedPath, {
			mode: '100644',
			objectId: gitBlobId('export const second = 1;\n'),
		});
		gitBlobs.set(secondQuotedPath, Buffer.from('export const second = 1;\n'));

		const result = await validate({
			patch: [
				'diff --git "a/src/agents/space path.ts" "b/src/agents/space path.ts"',
				`index ${gitBlobId('export const label = "space";\n').slice(0, 7)}..${gitBlobId('export const label = "patched";\n').slice(0, 7)} 100644`,
				'--- "a/src/agents/space path.ts"',
				'+++ "b/src/agents/space path.ts"',
				'@@ -1 +1 @@',
				'-export const label = "space";',
				'+export const label = "patched";',
				'diff --git "a/src/agents/second path.ts" "b/src/agents/second path.ts"',
				`index ${gitBlobId('export const second = 1;\n').slice(0, 7)}..${gitBlobId('export const second = 2;\n').slice(0, 7)} 100644`,
				'--- "a/src/agents/second path.ts"',
				'+++ "b/src/agents/second path.ts"',
				'@@ -1 +1 @@',
				'-export const second = 1;',
				'+export const second = 2;',
				'',
			].join('\n'),
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.reason);
		expect(result.candidate.files[0]?.relativePath).toBe(quotedPath);
		expect(result.candidate.files[1]?.relativePath).toBe(secondQuotedPath);
	});

	it('admits inert add, delete, rename, and mode-only patch forms without mutation', async () => {
		const admittedPatches = [
			[
				'diff --git a/src/agents/new.ts b/src/agents/new.ts',
				'new file mode 100644',
				`index ${'0'.repeat(7)}..${gitBlobId('export const created = true;\n').slice(0, 7)}`,
				'--- /dev/null',
				'+++ b/src/agents/new.ts',
				'@@ -0,0 +1 @@',
				'+export const created = true;',
				'',
			].join('\n'),
			[
				'diff --git a/src/agents/extra.ts b/src/agents/extra.ts',
				'deleted file mode 100644',
				`index ${gitBlobId('export const extra = true;\n').slice(0, 7)}..${'0'.repeat(7)}`,
				'--- a/src/agents/extra.ts',
				'+++ /dev/null',
				'@@ -1 +0,0 @@',
				'-export const extra = true;',
				'',
			].join('\n'),
			[
				'diff --git a/src/agents/demo.ts b/src/agents/demo-renamed.ts',
				'similarity index 100%',
				'rename from src/agents/demo.ts',
				'rename to src/agents/demo-renamed.ts',
				'',
			].join('\n'),
			[
				'diff --git a/src/agents/demo.ts b/src/agents/demo-copy.ts',
				'similarity index 100%',
				'copy from src/agents/demo.ts',
				'copy to src/agents/demo-copy.ts',
				'',
			].join('\n'),
			[
				'diff --git a/src/agents/demo.ts b/src/agents/demo.ts',
				'old mode 100644',
				'new mode 100755',
				`index ${gitBlobId('export const value = 1;\nexport const name = "demo";\n').slice(0, 7)}..${gitBlobId('export const value = 1;\nexport const name = "demo";\n').slice(0, 7)}`,
				'--- a/src/agents/demo.ts',
				'+++ b/src/agents/demo.ts',
				'',
			].join('\n'),
		];

		const expectedOperations = ['add', 'delete', 'rename', 'copy', 'mode'];
		for (const [index, admittedPatch] of admittedPatches.entries()) {
			const result = await validate({ patch: admittedPatch });
			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
			expect(result.candidate.files[0]?.operation).toBe(
				expectedOperations[index],
			);
		}

		expect(
			readFileSync(path.join(root, 'src', 'agents', 'demo.ts'), 'utf8'),
		).toContain('value = 1');
	});
});
