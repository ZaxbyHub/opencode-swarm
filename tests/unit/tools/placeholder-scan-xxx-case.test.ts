import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { placeholderScan } from '../../../src/tools/placeholder-scan';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function createTempDir(): string {
	return canonicalMkdtemp('ps-xxx-test-');
}

function createTestFile(
	dir: string,
	filename: string,
	content: string,
): string {
	const filePath = path.join(dir, filename);
	const parentDir = path.dirname(filePath);
	if (!fs.existsSync(parentDir)) {
		fs.mkdirSync(parentDir, { recursive: true });
	}
	fs.writeFileSync(filePath, content, 'utf-8');
	return filePath;
}

describe('placeholder_scan XXX case-sensitivity (issue #2301)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createTempDir();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it('lowercase xxx in path-shape comment is NOT flagged', async () => {
		createTestFile(
			tempDir,
			'paths.ts',
			'// path/to/xxx/example is a placeholder\nfunction clean() {}\n',
		);
		const result = await placeholderScan(
			{ changed_files: ['paths.ts'] },
			tempDir,
		);
		// No placeholder-comment finding at all.
		const commentFindings = result.findings.filter(
			(f) => f.rule_id === 'placeholder/comment-other',
		);
		expect(commentFindings.length).toBe(0);
	});

	it('uppercase XXX placeholder still flagged (regression guard)', async () => {
		createTestFile(
			tempDir,
			'xxx.ts',
			'// XXX: refactor this\nfunction clean() {}\n',
		);
		const result = await placeholderScan(
			{ changed_files: ['xxx.ts'] },
			tempDir,
		);
		expect(result.verdict).toBe('fail');
		expect(
			result.findings.some((f) => f.rule_id === 'placeholder/comment-other'),
		).toBe(true);
	});

	it('mixed-case Xxx is not flagged (case-sensitive now)', async () => {
		createTestFile(
			tempDir,
			'mixed.ts',
			'// Xxx: refactor this\nfunction clean() {}\n',
		);
		const result = await placeholderScan(
			{ changed_files: ['mixed.ts'] },
			tempDir,
		);
		const commentFindings = result.findings.filter(
			(f) => f.rule_id === 'placeholder/comment-other',
		);
		expect(commentFindings.length).toBe(0);
	});
});
