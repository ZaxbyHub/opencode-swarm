import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	forgeIssueCreateRoutingHint,
	forgePrCreateRoutingHint,
	resolveForgePublicationTool,
} from '../../../src/providers/forge-publication.js';

function engineRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pub-engine-'));
	fs.mkdirSync(path.join(root, '.jj'));
	fs.mkdirSync(path.join(root, '.purpose'), { recursive: true });
	fs.writeFileSync(
		path.join(root, '.purpose', 'commands.json'),
		'{}',
		'utf-8',
	);
	fs.mkdirSync(path.join(root, 'bin'));
	fs.writeFileSync(path.join(root, 'bin', 'repo'), '#!/bin/sh\n', {
		mode: 0o755,
	});
	return root;
}

describe('resolveForgePublicationTool', () => {
	test('Engine markers → repo', () => {
		const root = engineRoot();
		expect(resolveForgePublicationTool(root)).toBe('repo');
	});

	test('without directory, issue hint lists all three surfaces', () => {
		const hint = forgeIssueCreateRoutingHint();
		expect(hint).toContain('repo issue create');
		expect(hint).toContain('fj issue create');
		expect(hint).toContain('gh issue create');
	});

	test('without directory, pr hint lists all three surfaces', () => {
		const hint = forgePrCreateRoutingHint();
		expect(hint).toContain('repo pr create');
		expect(hint).toContain('fj pr create');
		expect(hint).toContain('gh pr create');
	});
});
