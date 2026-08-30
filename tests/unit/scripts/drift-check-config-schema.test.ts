import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	detectConfigDocsKeysDrift,
	detectConfigSchemaDrift,
} from '../../../scripts/drift-check';
import {
	buildConfigDocsSection,
	CONFIG_DOCS_MARKER_BEGIN,
	CONFIG_DOCS_MARKER_END,
	CONFIG_SCHEMA_RELATIVE_PATH,
	serializeConfigSchema,
} from '../../../scripts/generate-config-schema';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Issue #1663 — drift detectors for the two generated config artifacts.
 * Each detector takes an injectable root so tampering can be exercised on a
 * temp tree without touching the real repo files.
 */

describe('drift-check — config-schema detector', () => {
	let root: string;

	beforeEach(() => {
		root = canonicalMkdtemp('drift-config-schema-');
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('clean tree produces no findings', () => {
		fs.writeFileSync(
			path.join(root, CONFIG_SCHEMA_RELATIVE_PATH),
			serializeConfigSchema(),
		);
		expect(detectConfigSchemaDrift(root)).toEqual([]);
	});

	test('stale schema file produces an error finding naming the fix command', () => {
		fs.writeFileSync(
			path.join(root, CONFIG_SCHEMA_RELATIVE_PATH),
			serializeConfigSchema().replace('"title"', '"titleX"'),
		);
		const findings = detectConfigSchemaDrift(root);
		expect(findings).toHaveLength(1);
		expect(findings[0].category).toBe('config-schema');
		expect(findings[0].severity).toBe('error');
		expect(findings[0].message).toContain('generate-config-schema');
	});

	test('missing schema file produces an error finding', () => {
		const findings = detectConfigSchemaDrift(root);
		expect(findings).toHaveLength(1);
		expect(findings[0].severity).toBe('error');
		expect(findings[0].message).toContain('missing');
	});
});

describe('drift-check — config-docs detector', () => {
	let root: string;

	beforeEach(() => {
		root = canonicalMkdtemp('drift-config-docs-');
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	function writeDocs(sectionBody: string | null): void {
		const docsDir = path.join(root, 'docs');
		fs.mkdirSync(docsDir, { recursive: true });
		const section =
			sectionBody === null
				? ''
				: `${CONFIG_DOCS_MARKER_BEGIN}\n${sectionBody}\n${CONFIG_DOCS_MARKER_END}`;
		fs.writeFileSync(
			path.join(docsDir, 'configuration.md'),
			`# Configuration\n\n${section}\n`,
		);
	}

	test('clean tree produces no findings', () => {
		// buildConfigDocsSection() includes the markers itself.
		writeDocs(null);
		fs.writeFileSync(
			path.join(root, 'docs', 'configuration.md'),
			`# Configuration\n\n${buildConfigDocsSection()}\n`,
		);
		expect(detectConfigDocsKeysDrift(root)).toEqual([]);
	});

	test('stale generated section produces an error finding', () => {
		writeDocs('## stale hand-edited table');
		const findings = detectConfigDocsKeysDrift(root);
		expect(findings).toHaveLength(1);
		expect(findings[0].category).toBe('config-docs');
		expect(findings[0].severity).toBe('error');
		expect(findings[0].message).toContain('generate-config-schema');
	});

	test('missing markers produce an error finding', () => {
		const docsDir = path.join(root, 'docs');
		fs.mkdirSync(docsDir, { recursive: true });
		fs.writeFileSync(
			path.join(docsDir, 'configuration.md'),
			'# Configuration without markers\n',
		);
		const findings = detectConfigDocsKeysDrift(root);
		expect(findings).toHaveLength(1);
		expect(findings[0].severity).toBe('error');
		expect(findings[0].message).toContain('markers missing');
	});

	test('missing docs file produces an error finding', () => {
		const findings = detectConfigDocsKeysDrift(root);
		expect(findings).toHaveLength(1);
		expect(findings[0].severity).toBe('error');
	});
});

describe('drift-check — detector registration', () => {
	test('both new categories are registered in the sync detector list', async () => {
		const drift = await import('../../../scripts/drift-check.ts');
		const categories = drift.DETECTORS.map(([name]) => name);
		expect(categories).toContain('config-schema');
		expect(categories).toContain('config-docs');
	});

	test('on the real repo tree both new detectors are clean', () => {
		// Complements drift-check.test.ts's zero-findings assertion, which would
		// also pass if these detectors were dropped from DETECTORS.
		expect(detectConfigSchemaDrift()).toEqual([]);
		expect(detectConfigDocsKeysDrift()).toEqual([]);
	});
});
