import { describe, expect, test } from 'bun:test';
import { WRITE_TOOL_NAMES } from '../../../src/config/constants';
import {
	MAX_PATCH_AGGREGATE_BYTES,
	MAX_PATCH_FIELD_BYTES,
	resolveWriteTargets,
	WRITE_TARGET_RESOLVERS,
} from '../../../src/hooks/write-target-resolver';

describe('write-target resolver registry — issue #1875', () => {
	test('has exact bidirectional parity with WRITE_TOOL_NAMES', () => {
		expect(Object.keys(WRITE_TARGET_RESOLVERS).sort()).toEqual(
			[...WRITE_TOOL_NAMES].sort(),
		);
	});

	test('generic resolvers collect every supported scalar and array target', () => {
		const result = resolveWriteTargets(
			'write',
			{
				path: 'src/a.ts',
				filePath: 'src/b.ts',
				file: 'src/c.ts',
				target: 'src/d.ts',
				files: ['src/e.ts'],
				paths: ['src/f.ts'],
				targetFiles: ['src/g.ts'],
			},
			{ directory: process.cwd() },
		);

		expect(result).toEqual({
			status: 'resolved',
			paths: [
				'src/a.ts',
				'src/b.ts',
				'src/c.ts',
				'src/d.ts',
				'src/e.ts',
				'src/f.ts',
				'src/g.ts',
			],
		});
	});

	test('generic resolver fails closed on malformed target fields', () => {
		for (const args of [
			{ filePath: 'src/a.ts', files: ['src/b.ts', 7] },
			{ filePath: 'src/a.ts\0hidden' },
		]) {
			const result = resolveWriteTargets('edit', args, {
				directory: process.cwd(),
			});
			expect(result.status).toBe('unverifiable');
		}
	});

	test.each([
		[
			'input',
			'*** Begin Patch\n*** Update File: src/old.ts\n*** Move to: src/new.ts\n*** End Patch',
			['src/old.ts', 'src/new.ts'],
		],
		[
			'patch',
			'*** Begin Patch\n*** Add File: src/new.ts\n*** Delete File: src/gone.ts\n*** End Patch',
			['src/new.ts', 'src/gone.ts'],
		],
		[
			'diff',
			'diff --git a/src/a.ts b/src/b.ts\nrename from src/a.ts\nrename to src/b.ts\n--- a/src/a.ts\n+++ b/src/b.ts',
			['src/a.ts', 'src/b.ts'],
		],
	] as const)('resolves every %s patch target form', (field, payload, paths) => {
		const result = resolveWriteTargets(
			'apply_patch',
			{ [field]: payload },
			{ directory: process.cwd() },
		);
		expect(result).toEqual({ status: 'resolved', paths: [...paths] });
	});

	test('resolves native cmd payload and both /dev/null diff sides safely', () => {
		const payload = [
			'--- /dev/null',
			'+++ b/src/created.ts',
			'--- a/src/deleted.ts',
			'+++ /dev/null',
		].join('\n');
		const result = resolveWriteTargets(
			'patch',
			{ cmd: ['apply_patch', payload] },
			{ directory: process.cwd() },
		);
		expect(result).toEqual({
			status: 'resolved',
			paths: ['src/created.ts', 'src/deleted.ts'],
		});
	});

	test('rejects conflicting cross-field patch payloads', () => {
		const result = resolveWriteTargets(
			'apply_patch',
			{
				input: '*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch',
				patch: '*** Begin Patch\n*** Update File: src/b.ts\n*** End Patch',
			},
			{ directory: process.cwd() },
		);
		expect(result.status).toBe('unverifiable');
	});

	test('rejects zero-target, quoted-path, and oversized patch payloads', () => {
		for (const patch of [
			'*** Begin Patch\n*** End Patch',
			'--- "a/src/a file.ts"\n+++ "b/src/a file.ts"',
			'--- a/src/a.ts 2026-07-17\n+++ b/src/a.ts 2026-07-17',
			`*** Update File: src/a.ts\n${'x'.repeat(MAX_PATCH_FIELD_BYTES + 1)}`,
		]) {
			const result = resolveWriteTargets(
				'apply_patch',
				{ patch },
				{ directory: process.cwd() },
			);
			expect(result.status).toBe('unverifiable');
		}
	});

	test('rejects unframed, duplicated, reordered, and out-of-frame native operations', () => {
		for (const patch of [
			'*** Update File: ../../../etc/passwd\n--- a/test\n+++ b/test',
			'*** End Patch\n*** Update File: src/a.ts',
			'*** Begin Patch\n*** Update File: src/a.ts',
			'*** End Patch\n*** Begin Patch\n*** Update File: src/a.ts',
			'*** Begin Patch\n*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch',
			'*** Update File: ../../../etc/passwd\n*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch',
			'*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch\n*** Delete File: ../../../etc/passwd',
		]) {
			const result = resolveWriteTargets(
				'apply_patch',
				{ patch },
				{ directory: process.cwd() },
			);
			expect(result.status).toBe('unverifiable');
		}
	});

	test('enforces an aggregate cap across multiple cmd payloads', () => {
		const payload = `--- a/src/a.ts\n+++ b/src/a.ts\n${'x'.repeat(
			Math.floor(MAX_PATCH_AGGREGATE_BYTES / 3) + 1,
		)}`;
		const result = resolveWriteTargets(
			'patch',
			{ cmd: ['apply_patch', payload, payload, payload] },
			{ directory: process.cwd() },
		);
		expect(result).toEqual({
			status: 'unverifiable',
			reason: 'Aggregate patch payload exceeds size limit',
		});
	});

	test('cross-checks swarm_apply_patch files against parsed targets', () => {
		const patch = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b';
		const missing = resolveWriteTargets(
			'swarm_apply_patch',
			{ patch, files: ['src/other.ts'] },
			{ directory: process.cwd() },
		);
		expect(missing.status).toBe('unverifiable');

		const extra = resolveWriteTargets(
			'swarm_apply_patch',
			{ patch, files: ['src/a.ts', 'src/extra.ts'] },
			{ directory: process.cwd() },
		);
		expect(extra).toEqual({ status: 'resolved', paths: ['src/a.ts'] });
	});
});

describe('write-target resolver patch payload aliases — issue #2059', () => {
	// Models and tool wrappers commonly emit patch content under alternative
	// field names. The resolver must recognize each of them.
	test.each([
		['patchText'],
		['patch_text'],
		['patchPayload'],
		['text'],
		['content'],
	] as const)('resolves a unified diff carried under the %s alias', (field) => {
		const payload = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b';
		const result = resolveWriteTargets(
			'apply_patch',
			{ [field]: payload },
			{ directory: process.cwd() },
		);
		expect(result).toEqual({ status: 'resolved', paths: ['src/a.ts'] });
	});

	test('a unified diff with a trailing *** End Patch trailer (no begin) resolves as a unified diff', () => {
		// Issue #2059 repro: a model emits a standard unified diff but appends
		// "*** End Patch" at the bottom. The bare End marker must not classify
		// the payload as a malformed Native Vibe Patch.
		const payload =
			'--- a/src/main.cpp\n+++ b/src/main.cpp\n@@ -1 +1 @@\n-old\n+new\n*** End Patch';
		const result = resolveWriteTargets(
			'patch',
			{ patch: payload },
			{ directory: process.cwd() },
		);
		expect(result).toEqual({ status: 'resolved', paths: ['src/main.cpp'] });
	});

	test('a unified diff with a stray *** Update File line but no begin marker still fails closed (security guard preserved)', () => {
		// A payload carrying an operation marker (Update/Add/Delete File,
		// Move to|from) without a begin marker must stay classified as a
		// malformed native patch and fail closed, never fall through to the
		// unified-diff parser (which would silently drop the operation target,
		// including a path-traversal target). This case pins the column-0 form;
		// the indented form is pinned by the F-002 block below.
		const payload =
			'*** Update File: ../../../etc/passwd\n--- a/test\n+++ b/test';
		const result = resolveWriteTargets(
			'apply_patch',
			{ patch: payload },
			{ directory: process.cwd() },
		);
		expect(result.status).toBe('unverifiable');
		if (result.status === 'unverifiable') {
			expect(result.reason).toContain('*** Begin Patch');
		}
	});

	test('a genuine native patch (begin + operation + end) still resolves', () => {
		// Regression guard for the native classification change: a real native
		// patch must continue to resolve after relaxing the bare-End case.
		const payload = '*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch';
		const result = resolveWriteTargets(
			'patch',
			{ patch: payload },
			{ directory: process.cwd() },
		);
		expect(result).toEqual({ status: 'resolved', paths: ['src/a.ts'] });
	});
});

describe('write-target resolver — regression: CRLF patch payloads (F-011)', () => {
	// Previous code split the payload with `payload.split('\n')`, leaving a
	// trailing `\r` on every line. JS `.` does not match `\r`, so every
	// `(.+)$` / `(.*)$` path-extraction regex failed and EVERY CRLF patch —
	// unified or native — resolved to
	// `unverifiable: '<field>: Patch contains no recognizable write targets'`.
	test('a CRLF unified diff resolves its target', () => {
		const payload =
			'--- a/src/a.ts\r\n+++ b/src/a.ts\r\n@@ -1 +1 @@\r\n-a\r\n+b';
		const result = resolveWriteTargets(
			'patch',
			{ patch: payload },
			{ directory: process.cwd() },
		);
		expect(result).toEqual({ status: 'resolved', paths: ['src/a.ts'] });
	});

	test('a CRLF native patch resolves its targets', () => {
		const payload =
			'*** Begin Patch\r\n*** Update File: src/old.ts\r\n*** Move to: src/new.ts\r\n*** End Patch';
		const result = resolveWriteTargets(
			'apply_patch',
			{ patch: payload },
			{ directory: process.cwd() },
		);
		expect(result).toEqual({
			status: 'resolved',
			paths: ['src/old.ts', 'src/new.ts'],
		});
	});
});

describe('write-target resolver — regression: indented operation markers (F-002)', () => {
	// Previous code matched the `*** Begin/End Patch` framing markers against
	// the TRIMMED line but the operation markers against the RAW line. A single
	// leading space or tab therefore hid an operation marker from both
	// classification and extraction, so a correctly framed patch carrying a
	// column-0 marker plus an indented traversal marker resolved to
	// `['src/safe.ts']` only — the traversal target was silently dropped from
	// the set the guardrail layer later validates.
	test.each([
		['space-indented', ' '],
		['tab-indented', '\t'],
	] as const)('a framed native patch surfaces a %s marker beside a column-0 one', (_label, indent) => {
		// Both marker families are covered: `*** Update File:` and
		// `*** Move to:` have separate regexes at both the classification and
		// the extraction site, so each needs its own indented target.
		const payload = [
			'*** Begin Patch',
			'*** Update File: src/safe.ts',
			`${indent}*** Update File: ../../../etc/passwd`,
			`${indent}*** Move to: src/moved.ts`,
			'*** End Patch',
		].join('\n');
		const result = resolveWriteTargets(
			'apply_patch',
			{ patch: payload },
			{ directory: process.cwd() },
		);
		expect(result).toEqual({
			status: 'resolved',
			paths: ['src/safe.ts', '../../../etc/passwd', 'src/moved.ts'],
		});
	});

	// Unframed (no begin marker) so that CLASSIFICATION is what decides the
	// outcome — a framed payload would be forced native by the begin marker and
	// would therefore pin nothing about the operation-marker regexes. Previously
	// each of these classified as a unified diff (the raw-anchored marker test
	// missed the indented line and `hasUnifiedHeaders` suppressed the bare-End
	// native tolerance), resolving to ['src/a.ts'] while silently dropping the
	// traversal target. Both marker families must now fail closed.
	test.each([
		['Update File', ' *** Update File: ../../../etc/passwd'],
		['Move from', ' *** Move from: ../../../etc/passwd'],
	] as const)('an indented %s marker with unified headers and a bare End Patch fails closed', (_label, markerLine) => {
		const payload = [
			'--- a/src/a.ts',
			'+++ b/src/a.ts',
			'@@ -1 +1 @@',
			markerLine,
			'*** End Patch',
		].join('\n');
		const result = resolveWriteTargets(
			'patch',
			{ patch: payload },
			{ directory: process.cwd() },
		);
		expect(result).toEqual({
			status: 'unverifiable',
			reason: 'patch: Native patch is missing *** Begin Patch',
		});
	});
});

describe('write-target resolver — multi-field and non-string payload guards (F-006)', () => {
	// The alias `test.each` above supplies exactly one payload field per case.
	// These two pre-existing guards are what keep the widened
	// PATCH_PAYLOAD_KEYS list from admitting a conflicting or malformed
	// payload, so they are pinned explicitly.
	test('two alias fields with conflicting targets fail closed', () => {
		const result = resolveWriteTargets(
			'apply_patch',
			{
				patch: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b',
				content: '--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1 +1 @@\n-a\n+b',
			},
			{ directory: process.cwd() },
		);
		expect(result).toEqual({
			status: 'unverifiable',
			reason: 'Conflicting targets across patch payload fields',
		});
	});

	test('a non-string alias value fails closed before parsing', () => {
		const result = resolveWriteTargets(
			'apply_patch',
			{ content: 123 },
			{ directory: process.cwd() },
		);
		expect(result).toEqual({
			status: 'unverifiable',
			reason: 'Malformed content payload',
		});
	});
});

describe('write-target resolver — uniformly indented payloads (#2206)', () => {
	// Models emit diffs indented inside fenced markdown / YAML / JSON blocks.
	// The resolver dedents the min common leading whitespace before the
	// column-0 anchored classification/extraction regexes run.
	test('a 2-space-indented unified diff resolves its target', () => {
		const payload = [
			'  --- a/src/a.ts',
			'  +++ b/src/a.ts',
			'  @@ -1 +1 @@',
			'  -a',
			'  +b',
		].join('\n');
		const result = resolveWriteTargets(
			'patch',
			{ patch: payload },
			{ directory: process.cwd() },
		);
		expect(result).toEqual({ status: 'resolved', paths: ['src/a.ts'] });
	});

	test('a 2-space-indented native patch classifies native and resolves its targets', () => {
		const payload = [
			'  *** Begin Patch',
			'  *** Update File: src/old.ts',
			'  *** Move to: src/new.ts',
			'  *** End Patch',
		].join('\n');
		const result = resolveWriteTargets(
			'apply_patch',
			{ patch: payload },
			{ directory: process.cwd() },
		);
		expect(result).toEqual({
			status: 'resolved',
			paths: ['src/old.ts', 'src/new.ts'],
		});
	});

	test('an indented unified diff with a stray *** End Patch trailer resolves as unified (no native misclassification)', () => {
		const payload = [
			'  --- a/src/a.ts',
			'  +++ b/src/a.ts',
			'  @@ -1 +1 @@',
			'  -a',
			'  +b',
			'  *** End Patch',
		].join('\n');
		const result = resolveWriteTargets(
			'patch',
			{ patch: payload },
			{ directory: process.cwd() },
		);
		expect(result).toEqual({ status: 'resolved', paths: ['src/a.ts'] });
	});
});
