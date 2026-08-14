/**
 * Tests for the record_issue_reproduction and record_issue_publication tools
 * (issue #2131 findings 2.6 and 2.4).
 *
 * These tools are the WRITER side of the issue-trace reproduction and
 * publication gates; the reader side is covered by issue-trace-state.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AGENT_TOOL_MAP } from '../../../src/config/constants.js';
import {
	publicationReceiptExists,
	reproductionReceiptExists,
} from '../../../src/hooks/issue-trace-state';
import {
	record_issue_publication,
	record_issue_reproduction,
} from '../../../src/tools/index.js';
import { TOOL_MANIFEST } from '../../../src/tools/manifest.js';
import { executeRecordIssuePublication } from '../../../src/tools/record-issue-publication';
import { executeRecordIssueReproduction } from '../../../src/tools/record-issue-reproduction';
import { TOOL_NAMES } from '../../../src/tools/tool-names.js';

function makeTempDir(): string {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'record-receipts-')),
	);
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	return dir;
}

let dir = '';
beforeEach(() => {
	dir = makeTempDir();
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('receipt tool registration (invariant 11)', () => {
	test('record_issue_reproduction is a registered architect tool', () => {
		expect(TOOL_NAMES).toContain('record_issue_reproduction');
		expect(TOOL_MANIFEST.record_issue_reproduction).toBeDefined();
		expect(AGENT_TOOL_MAP.architect).toContain('record_issue_reproduction');
		expect(record_issue_reproduction.args.issueNumber).toBeDefined();
	});

	test('record_issue_publication is a registered architect tool', () => {
		expect(TOOL_NAMES).toContain('record_issue_publication');
		expect(TOOL_MANIFEST.record_issue_publication).toBeDefined();
		expect(AGENT_TOOL_MAP.architect).toContain('record_issue_publication');
		expect(record_issue_publication.args.issueNumber).toBeDefined();
	});
});

describe('record_issue_reproduction', () => {
	test('writes a performed receipt (with evidence) that satisfies the gate', async () => {
		const result = await executeRecordIssueReproduction(
			{
				issueNumber: 42,
				performed: true,
				commands: ['bun test x.test.ts'],
				output_summary: '1 pass',
			},
			dir,
			{ sessionID: 'sess-1' },
		);
		expect(JSON.parse(result).success).toBe(true);

		const written = JSON.parse(
			fs.readFileSync(path.join(dir, '.swarm', 'reproduction.json'), 'utf-8'),
		);
		expect(written.performed).toBe(true);
		expect(written.issueNumber).toBe(42);
		expect(written.sessionId).toBe('sess-1');
		expect(await reproductionReceiptExists(dir, 42)).toBe(true);
	});

	test('performed=true WITHOUT commands/output_summary is rejected', async () => {
		const result = await executeRecordIssueReproduction(
			{ issueNumber: 42, performed: true },
			dir,
		);
		expect(JSON.parse(result).success).toBe(false);
		expect(JSON.parse(result).message).toContain('commands and output_summary');
		expect(await reproductionReceiptExists(dir, 42)).toBe(false);
	});

	test('performed=false is recorded but does NOT satisfy the gate', async () => {
		await executeRecordIssueReproduction(
			{ issueNumber: 42, performed: false },
			dir,
		);
		expect(await reproductionReceiptExists(dir, 42)).toBe(false);
	});

	test('receipt bound to a different issue does NOT satisfy the gate', async () => {
		await executeRecordIssueReproduction(
			{
				issueNumber: 999,
				performed: true,
				commands: ['x'],
				output_summary: 'y',
			},
			dir,
		);
		expect(await reproductionReceiptExists(dir, 42)).toBe(false);
	});

	test('rejects invalid arguments', async () => {
		const result = await executeRecordIssueReproduction(
			{ issueNumber: -1, performed: true },
			dir,
		);
		expect(JSON.parse(result).success).toBe(false);
	});
});

describe('record_issue_publication', () => {
	const PR_URL = 'https://github.com/owner/repo/pull/7';

	test('writes an issue-bound publication receipt that satisfies the gate', async () => {
		const result = await executeRecordIssuePublication(
			{
				issueNumber: 42,
				prNumber: 7,
				prUrl: PR_URL,
				headSha: 'abc123',
			},
			dir,
		);
		expect(JSON.parse(result).success).toBe(true);

		const written = JSON.parse(
			fs.readFileSync(
				path.join(dir, '.swarm', 'issue-publication.json'),
				'utf-8',
			),
		);
		expect(written.published).toBe(true);
		expect(written.issueNumber).toBe(42);
		expect(written.prNumber).toBe(7);
		expect(await publicationReceiptExists(dir, 42)).toBe(true);
	});

	test('a publication receipt for a DIFFERENT issue does NOT satisfy the gate', async () => {
		await executeRecordIssuePublication(
			{ issueNumber: 999, prNumber: 7, prUrl: PR_URL },
			dir,
		);
		expect(await publicationReceiptExists(dir, 42)).toBe(false);
	});

	test('rejects a non-GitHub PR URL', async () => {
		const result = await executeRecordIssuePublication(
			{ issueNumber: 42, prNumber: 7, prUrl: 'https://example.com/notapr' },
			dir,
		);
		expect(JSON.parse(result).success).toBe(false);
	});
});
