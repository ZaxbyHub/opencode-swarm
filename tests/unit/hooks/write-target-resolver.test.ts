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
