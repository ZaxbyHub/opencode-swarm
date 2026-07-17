import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveWriteTargets } from '../../../src/hooks/write-target-resolver';
import { extract_code_blocks } from '../../../src/tools/file-extractor';
import { planExtractCodeBlocks } from '../../../src/tools/file-extractor-planner';

const roots: string[] = [];

function makeWorkspace(): string {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'extract-transaction-')),
	);
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('extract_code_blocks transaction — issue #1875', () => {
	test('planner reserves deterministic in-batch collision names', () => {
		const workspace = makeWorkspace();
		const content = [
			'```typescript',
			'// filename: same.ts',
			'export const a = 1;',
			'```',
			'```typescript',
			'// filename: same.ts',
			'export const b = 2;',
			'```',
		].join('\n');

		const plan = planExtractCodeBlocks({ content }, workspace);
		expect(plan.status).toBe('ready');
		if (plan.status !== 'ready') return;
		expect(plan.files.map((file) => file.relativePath)).toEqual([
			'same.ts',
			'same_1.ts',
		]);
	});

	test('planner case-folds in-batch reservations for portable targets', () => {
		const workspace = makeWorkspace();
		const content = [
			'```typescript',
			'// filename: Same.ts',
			'export const a = 1;',
			'```',
			'```typescript',
			'// filename: same.ts',
			'export const b = 2;',
			'```',
		].join('\n');

		const plan = planExtractCodeBlocks({ content }, workspace);
		expect(plan.status).toBe('ready');
		if (plan.status !== 'ready') return;
		expect(plan.files.map((file) => file.relativePath)).toEqual([
			'Same.ts',
			'same_1.ts',
		]);
	});

	test('invalid later target causes zero directory and file mutations', async () => {
		const workspace = makeWorkspace();
		const content = [
			'```typescript',
			'// filename: good.ts',
			'export const good = true;',
			'```',
			'```typescript',
			'// filename: nested/escape.ts',
			'export const bad = true;',
			'```',
		].join('\n');

		const result = await extract_code_blocks.execute(
			{ content, output_dir: 'generated' },
			{ directory: workspace } as never,
		);

		expect(String(result)).toContain('Rejected unsafe filename');
		expect(fs.existsSync(path.join(workspace, 'generated'))).toBe(false);
		expect(fs.readdirSync(workspace)).toEqual([]);
	});

	test('no-code-block no-op does not create output_dir', async () => {
		const workspace = makeWorkspace();
		const result = await extract_code_blocks.execute(
			{ content: 'plain text', output_dir: 'generated' },
			{ directory: workspace } as never,
		);
		expect(result).toBe('No code blocks found in content.');
		expect(fs.existsSync(path.join(workspace, 'generated'))).toBe(false);
	});

	test('planner reserves names around existing collisions before writes', () => {
		const workspace = makeWorkspace();
		fs.writeFileSync(path.join(workspace, 'same.ts'), 'existing');
		fs.writeFileSync(path.join(workspace, 'same_1.ts'), 'existing');
		const content = '```typescript\n// filename: same.ts\nexport {};\n```';

		const plan = planExtractCodeBlocks({ content }, workspace);
		expect(plan.status).toBe('ready');
		if (plan.status !== 'ready') return;
		expect(plan.files[0]?.relativePath).toBe('same_2.ts');
	});

	test('execution consumes the authorized plan and rolls back every reserved file', async () => {
		const workspace = makeWorkspace();
		const args = {
			content: [
				'```typescript',
				'// filename: first.ts',
				'export const first = true;',
				'```',
				'```typescript',
				'// filename: second.ts',
				'export const second = true;',
				'```',
			].join('\n'),
		};
		const targets = resolveWriteTargets('extract_code_blocks', args, {
			directory: workspace,
		});
		expect(targets).toEqual({
			status: 'resolved',
			paths: ['first.ts', 'second.ts'],
		});

		// Simulate a collision after authorization. Execution must not re-plan to
		// an unchecked second_1.ts target, and must roll first.ts back.
		fs.writeFileSync(path.join(workspace, 'second.ts'), 'intruder');
		const result = await extract_code_blocks.execute(args, {
			directory: workspace,
		} as never);

		expect(String(result)).toContain('extraction transaction aborted');
		expect(fs.existsSync(path.join(workspace, 'first.ts'))).toBe(false);
		expect(fs.readFileSync(path.join(workspace, 'second.ts'), 'utf8')).toBe(
			'intruder',
		);
		expect(fs.existsSync(path.join(workspace, 'second_1.ts'))).toBe(false);
	});
});
