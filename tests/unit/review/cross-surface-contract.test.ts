import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMAND_REGISTRY } from '../../../src/commands/registry';
import { ALL_AGENT_NAMES } from '../../../src/config/constants';
import {
	AUTO_REVIEW_V8_BURN_IN_DECISION,
	type PluginConfig,
	resolveAutoReviewConfig,
} from '../../../src/config/schema';
import type { ReviewModelDispatcher } from '../../../src/review/contracts';
import { runFinalReviewGate } from '../../../src/tools/phase-complete/gates';
import { buildPluginToolObject } from '../../../src/tools/plugin-registration';

import { canonicalMkdtemp } from '../../helpers/tmpdir';

const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../..',
);

function read(relativePath: string): string {
	return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

// Consumption-aware source resolution for the #1675 fragment (#3511, the
// merged-#3507 pattern): pending present -> pending is the sole authority;
// absent -> scan the materialized docs/releases/vX.Y.Z.md history. Returns
// null when neither surface carries the fragment.
function autoReviewFragmentText(root: string): string | null {
	const pendingFragment = path.join(
		root,
		'docs/releases/pending/1675-default-auto-review-engine.md',
	);
	if (fs.existsSync(pendingFragment)) {
		return fs.readFileSync(pendingFragment, 'utf8');
	}
	// #3519 feedback: the consumed obligation resolves through the fragment's
	// MANIFEST CLAIM (the claiming tag's vX.md carries it), never through a
	// name-blind aggregate of every release body (the aggregate arm could
	// satisfy the pin from unrelated history).
	const manifestsDir = path.join(root, 'docs/releases/manifests');
	if (!fs.existsSync(manifestsDir)) return null;
	const claims: Array<{ tag: string; manifest: string }> = [];
	for (const name of fs.readdirSync(manifestsDir)) {
		if (!name.toLowerCase().endsWith('.json')) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(
				fs.readFileSync(path.join(manifestsDir, name), 'utf8'),
			);
		} catch {
			continue;
		}
		const manifest = parsed as {
			schemaVersion?: unknown;
			tag?: unknown;
			fragments?: Array<{ path?: unknown }>;
		};
		if (
			manifest?.schemaVersion !== 1 ||
			!Array.isArray(manifest.fragments) ||
			typeof manifest.tag !== 'string'
		) {
			continue;
		}
		const claimed = manifest.fragments.some(
			(fragment) =>
				fragment?.path ===
				'docs/releases/pending/1675-default-auto-review-engine.md',
		);
		if (claimed) claims.push({ tag: manifest.tag, manifest: name });
	}
	if (claims.length === 0) return null;
	claims.sort(
		(a, b) =>
			tagOrderOf(b.tag) - tagOrderOf(a.tag) ||
			(a.manifest < b.manifest ? 1 : a.manifest > b.manifest ? -1 : 0),
	);
	const archivedBody = path.join(root, 'docs/releases', `${claims[0].tag}.md`);
	if (!fs.existsSync(archivedBody)) return null;
	return fs.readFileSync(archivedBody, 'utf8');
}

/** Parse `v?X.Y.Z` into a comparable number; unparseable tags sort lowest. */
function tagOrderOf(tag: string): number {
	const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag);
	if (!m) return -1;
	return Number(m[1]) * 1_000_000 + Number(m[2]) * 1_000 + Number(m[3]);
}

describe('auto-review cross-surface contract', () => {
	test('keeps config, agent, command, runtime factories, docs, and release wired', () => {
		const config = resolveAutoReviewConfig({ enabled: true });
		expect(config).toMatchObject({
			enabled: true,
			trigger: 'phase_boundary',
			min_confidence: 0.7,
			structured_findings: true,
			validate_findings: false,
			final_review: { mode: 'advisory' },
		});
		expect(ALL_AGENT_NAMES).toContain('critic_finding_validator');
		expect(COMMAND_REGISTRY.review.toolPolicy).toBe('human-only');
		expect(COMMAND_REGISTRY.review.args).toContain('--working-tree');
		expect(typeof runFinalReviewGate).toBe('function');

		const dispatcher: ReviewModelDispatcher = {
			async dispatch() {
				throw new Error('contract test does not execute the runtime');
			},
		};
		const tools = buildPluginToolObject(
			{},
			{ auto_review: config } as PluginConfig,
			undefined,
			dispatcher,
		);
		expect(tools.swarm_command).toBeDefined();
		expect(tools.phase_complete).toBeDefined();
		expect(tools.lean_turbo_review).toBeDefined();

		expect(read('README.md')).toContain('/swarm review');
		expect(read('docs/commands.md')).toContain('### `/swarm review');
		expect(read('docs/configuration.md')).toContain(
			AUTO_REVIEW_V8_BURN_IN_DECISION.artifact_sha256,
		);
		expect(read('docs/architecture.md')).toContain(
			'Independent Auto-Review Engine',
		);
		expect(read('docs/proposals/auto-review-by-review-model.md')).toContain(
			'Status: implemented by issue #1675',
		);
		// Consumption-aware (#3511, the merged-#3507 pattern): while the pending
		// fragment exists it is the sole authority; once a release-fragment
		// cleanup consumes it, the sentence must be found in the materialized
		// release history instead. Exclusive arms — never a union.
		expect(autoReviewFragmentText(repositoryRoot)).toContain('/swarm review');
	});

	test('consumption-aware fragment resolution fails closed when neither surface carries it', () => {
		// Strength leg (#3511): consumed + unarchived must read as null, so the
		// pin above fails rather than passing vacuously; the archive arm must
		// carry the sentence once materialized.
		const neitherDir = canonicalMkdtemp('swarm-cross-surface-neither-');
		try {
			expect(autoReviewFragmentText(neitherDir)).toBeNull();
		} finally {
			fs.rmSync(neitherDir, { recursive: true, force: true });
		}
		const exclusive = canonicalMkdtemp('swarm-cross-surface-excl-');
		try {
			fs.mkdirSync(path.join(exclusive, 'docs/releases/pending'), {
				recursive: true,
			});
			fs.mkdirSync(path.join(exclusive, 'docs/releases'), {
				recursive: true,
			});
			// Pending present but missing '/swarm review' while a stale
			// archive carries it: pending is the sole authority — a union
			// resolver would leak the archive sentence and pass vacuously.
			fs.writeFileSync(
				path.join(
					exclusive,
					'docs/releases/pending/1675-default-auto-review-engine.md',
				),
				'# auto-review engine record without the command pin',
			);
			fs.writeFileSync(
				path.join(exclusive, 'docs/releases/v0.0.0.md'),
				'# stale archive hit documenting /swarm review surface',
			);
			expect(autoReviewFragmentText(exclusive)).not.toContain('/swarm review');
		} finally {
			fs.rmSync(exclusive, { recursive: true, force: true });
		}
		const archivedDir = canonicalMkdtemp('swarm-cross-surface-arch-');
		try {
			fs.mkdirSync(path.join(archivedDir, 'docs/releases/manifests'), {
				recursive: true,
			});
			fs.writeFileSync(
				path.join(archivedDir, 'docs/releases/v0.0.0.md'),
				'auto-review engine documented /swarm review surface',
			);
			// #3519 feedback: a stray vX.md WITHOUT a manifest claim for this
			// exact path must NOT satisfy the pin — resolution requires the
			// claim (the name-blind aggregate defect this round fixes).
			expect(autoReviewFragmentText(archivedDir)).toBeNull();
			fs.writeFileSync(
				path.join(archivedDir, 'docs/releases/manifests/v0.0.0.json'),
				JSON.stringify({
					schemaVersion: 1,
					tag: 'v0.0.0',
					tagCommit: 'a'.repeat(40),
					targetCommitish: 'a'.repeat(40),
					releaseBodySha256: '0'.repeat(64),
					fragments: [
						{
							prNumber: null,
							order: 0,
							path: 'docs/releases/pending/1675-default-auto-review-engine.md',
							sha256: '4'.repeat(64),
						},
					],
				}),
			);
			expect(autoReviewFragmentText(archivedDir)).toContain('/swarm review');
			// Claim-without-body fails closed: the claiming tag's vX.md missing
			// must not fabricate an obligation.
			fs.rmSync(path.join(archivedDir, 'docs/releases/v0.0.0.md'));
			expect(autoReviewFragmentText(archivedDir)).toBeNull();
		} finally {
			fs.rmSync(archivedDir, { recursive: true, force: true });
		}
	});
});
