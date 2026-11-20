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
 *   2. The release-history leg: the shipped #3710-3712 fragment is pinned in
 *      the ARCHIVED release history — the v7.204.9 section markers plus the
 *      v7.204.9 manifest `fragments[].sha256` provenance for the consumed
 *      `3710-3712-redaction-hardening.md` pending fragment. Pending
 *      fragments are ROTATING artifacts (each release materializes and
 *      deletes them), so the original pin on `docs/releases/pending/` went
 *      red on every open PR the moment the last matching fragment shipped
 *      (#3745; the #3509 precedent re-pointed its seam test the same way).
 *      Future redaction work authors its own fragment and adds its own NEW
 *      archived pin at authoring time.
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
const ARCHIVED_RELEASE_DOC_PATH = path.join(
	REPO_ROOT,
	'docs',
	'releases',
	'v7.204.9.md',
);
const ARCHIVED_RELEASE_MANIFEST_PATH = path.join(
	REPO_ROOT,
	'docs',
	'releases',
	'manifests',
	'v7.204.9.json',
);
// The v7.204.9 release consumed the fix's pending fragment; the manifest's
// fragments[] entry is its immutable provenance record (issue #3745).
const CONSUMED_FRAGMENT_PENDING_PATH =
	'docs/releases/pending/3710-3712-redaction-hardening.md';
const CONSUMED_FRAGMENT_SHA256 =
	'6cb4cbdd8c071e94d1ef9447fc2cf9819560faf4c6652df519dd427372a48c27';

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

const REQUIRED_ARCHIVE_MARKERS: ReadonlyArray<{ marker: string; why: string }> =
	[
		{
			marker:
				'## Redaction-family hardening: widened bare-token corpus, persistence-boundary sanitization, and mock-target normalizer wedge fix',
			why: 'archived section heading for the 3710-3712 fix',
		},
		{
			marker: '### Widened credential corpus at BOTH redaction sites (#3712)',
			why: 'widened-corpus subsection heading',
		},
		{
			marker:
				'### Redacted provider-error text at every persistence boundary (#3710)',
			why: 'persistence-boundary subsection heading',
		},
		{
			marker: '### Mock-target normalizer wedge fix (#3710)',
			why: 'mock-target normalizer subsection heading',
		},
		{
			marker: 'sanitizeFailureEvidenceDisplay',
			why: 'persistence-boundary sanitization seam named in the archive',
		},
		{ marker: 'GOCSPX-', why: 'archived google family content marker' },
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

	test('archived release history (v7.204.9) carries the redaction-hardening fragment content and provenance', () => {
		const archived = fs.readFileSync(ARCHIVED_RELEASE_DOC_PATH, 'utf-8');
		const missing = REQUIRED_ARCHIVE_MARKERS.filter(
			(entry) => !archived.includes(entry.marker),
		);
		expect(
			missing.map((entry) => `${entry.marker} (${entry.why})`),
			'archived v7.204.9 release history is missing required redaction-hardening markers',
		).toEqual([]);

		const manifest = JSON.parse(
			fs.readFileSync(ARCHIVED_RELEASE_MANIFEST_PATH, 'utf-8'),
		) as { fragments?: Array<{ path?: string; sha256?: string }> };
		const consumed = (manifest.fragments ?? []).find(
			(fragment) =>
				fragment.path === CONSUMED_FRAGMENT_PENDING_PATH ||
				fragment.path?.endsWith('/3710-3712-redaction-hardening.md'),
		);
		expect(
			consumed,
			`v7.204.9 manifest fragments[] must list the consumed ${CONSUMED_FRAGMENT_PENDING_PATH} provenance entry`,
		).toBeTruthy();
		expect(consumed?.sha256).toBe(CONSUMED_FRAGMENT_SHA256);
	}, 30_000);
});
