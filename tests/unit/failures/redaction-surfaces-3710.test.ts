import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * #3710 AC7 — widened-surface legs for the redaction-hardening fix.
 *
 * Executable legs:
 *   1. The parity suite (tests/unit/failures/redaction-family-parity-3710.test.ts)
 *      carries the widened CORPUS rows for every new family (gsk_, GOCSPX-,
 *      ya29., eyJ JWT, sk-ant-api03-, sk-or-v1-, azure AccountKey= contextual
 *      form, base64-wrapped) plus the per-family placeholder entries and the
 *      mirror-parity loops. This leg is GREEN from the moment the new suite
 *      lands and pins it against silent narrowing.
 *   2. A docs/releases/pending/ release fragment for this fix exists
 *      (mandatory per AGENTS.md invariant 12 / contributing.md). This leg is
 *      RED at base (no fragment for #3710/#3711/#3712/redaction-hardening
 *      exists yet) and turns GREEN when the implementer ships the fragment.
 *
 * The invariant-9 audit line in the PR description is a reviewed, non-file
 * surface and is deliberately not executable here (disclosed in the
 * acceptance-table notes). No token material is needed by this file.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../');
const PARITY_SUITE_PATH = path.join(
	REPO_ROOT,
	'tests',
	'unit',
	'failures',
	'redaction-family-parity-3710.test.ts',
);
const PENDING_DIR = path.join(REPO_ROOT, 'docs', 'releases', 'pending');
const FRAGMENT_NAME_RE = /(3710|3711|3712|redaction)/i;

const REQUIRED_CORPUS_MARKERS: ReadonlyArray<{ marker: string; why: string }> =
	[
		{ marker: 'gsk_', why: 'groq family corpus row' },
		{ marker: 'GOCSPX-', why: 'google oauth family corpus row' },
		{ marker: 'ya29.', why: 'google ya29 family corpus row' },
		{ marker: 'eyJ', why: 'jwt family corpus row' },
		{ marker: 'sk-ant-api03-', why: 'anthropic family corpus row' },
		{ marker: 'sk-or-v1-', why: 'openrouter family corpus row' },
		{ marker: 'AccountKey=', why: 'azure contextual corpus row' },
		{ marker: "family: 'groq'", why: 'groq placeholder expectation' },
		{ marker: "family: 'google'", why: 'google placeholder expectation' },
		{ marker: "family: 'jwt'", why: 'jwt placeholder expectation' },
		{ marker: "family: 'anthropic'", why: 'anthropic placeholder expectation' },
		{
			marker: "family: 'openrouter'",
			why: 'openrouter placeholder expectation',
		},
		{ marker: "family: 'azure'", why: 'azure placeholder expectation' },
		{ marker: "family: 'base64'", why: 'base64 placeholder expectation' },
		{ marker: 'const CORPUS', why: 'corpus declaration' },
		{ marker: 'mirror parity', why: 'mirror-parity loops' },
	];

describe('redaction-hardening widened surfaces (#3710 AC7)', () => {
	test('parity suite carries the widened new-family corpus rows', () => {
		const content = fs.readFileSync(PARITY_SUITE_PATH, 'utf-8');
		const missing = REQUIRED_CORPUS_MARKERS.filter(
			(entry) => !content.includes(entry.marker),
		);
		expect(
			missing.map((entry) => `${entry.marker} (${entry.why})`),
			'parity suite is missing required corpus markers',
		).toEqual([]);
	}, 30_000);

	test('docs/releases/pending fragment for the redaction-hardening fix exists', () => {
		expect(fs.existsSync(PENDING_DIR)).toBe(true);
		const fragments = fs
			.readdirSync(PENDING_DIR)
			.filter((name) => name.endsWith('.md') && FRAGMENT_NAME_RE.test(name));
		expect(
			fragments.length,
			`no docs/releases/pending fragment matching /${FRAGMENT_NAME_RE.source}/ (expected one for the 3710-3712 redaction-hardening fix)`,
		).toBeGreaterThan(0);
	}, 30_000);
});
