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
	const releasesPath = path.join(root, 'docs/releases');
	if (!fs.existsSync(releasesPath)) return null;
	const parts: string[] = [];
	for (const name of fs.readdirSync(releasesPath)) {
		if (/^v\d+\.\d+\.\d+\.md$/.test(name)) {
			parts.push(fs.readFileSync(path.join(releasesPath, name), 'utf8'));
		}
	}
	return parts.length > 0 ? parts.join('\n') : null;
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
		const archivedDir = canonicalMkdtemp('swarm-cross-surface-arch-');
		try {
			fs.mkdirSync(path.join(archivedDir, 'docs/releases'), {
				recursive: true,
			});
			fs.writeFileSync(
				path.join(archivedDir, 'docs/releases/v0.0.0.md'),
				'auto-review engine documented /swarm review surface',
			);
			expect(autoReviewFragmentText(archivedDir)).toContain('/swarm review');
		} finally {
			fs.rmSync(archivedDir, { recursive: true, force: true });
		}
	});
});
