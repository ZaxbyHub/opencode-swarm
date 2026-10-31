import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (relativePath: string): string =>
	readFileSync(join(process.cwd(), relativePath), 'utf8');

/**
 * Consumption-aware fragment resolution (issue #3511; tightened per the
 * #3519 feedback): pending is the sole authority while present; once
 * consumed, the obligation resolves through the fragment's MANIFEST CLAIM —
 * the claiming manifest's tag names the materialized body carrying the
 * obligation — never through a name-blind aggregate of every release body.
 * No claim → null → the pins fail (never vacuous).
 */
function fragmentTextOrArchive(name: string): string | null {
	// Repo root from this file's location (tests/unit/skills/* → root);
	// FR-011 forbids new fixture roots anchored at the checkout cwd.
	const root = join(import.meta.dir, '..', '..', '..');
	const pendingFragment = join(root, 'docs/releases/pending', name);
	if (existsSync(pendingFragment)) return readFileSync(pendingFragment, 'utf8');
	const manifestsDir = join(root, 'docs/releases/manifests');
	if (!existsSync(manifestsDir)) return null;
	const claims: Array<{ tag: string; manifest: string }> = [];
	for (const entry of readdirSync(manifestsDir)) {
		if (!entry.toLowerCase().endsWith('.json')) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(join(manifestsDir, entry), 'utf8'));
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
			(fragment) => fragment?.path === `docs/releases/pending/${name}`,
		);
		if (claimed) claims.push({ tag: manifest.tag, manifest: entry });
	}
	if (claims.length === 0) return null;
	claims.sort(
		(a, b) =>
			tagOrderOf(b.tag) - tagOrderOf(a.tag) ||
			(a.manifest < b.manifest ? 1 : a.manifest > b.manifest ? -1 : 0),
	);
	const archivedBody = join(root, 'docs/releases', `${claims[0].tag}.md`);
	if (!existsSync(archivedBody)) return null;
	return readFileSync(archivedBody, 'utf8');
}

/** Parse `v?X.Y.Z` into a comparable number; unparseable tags sort lowest. */
function tagOrderOf(tag: string): number {
	const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag);
	if (!m) return -1;
	return Number(m[1]) * 1_000_000 + Number(m[2]) * 1_000 + Number(m[3]);
}

function pendingText(name: string): string | null {
	const pendingFragment = join(process.cwd(), 'docs/releases/pending', name);
	return existsSync(pendingFragment)
		? readFileSync(pendingFragment, 'utf8')
		: null;
}

describe('swarm-pr-review runtime friction guidance', () => {
	test('uses Windows-portable exact-commit verification on every guidance surface', () => {
		const sources = [
			read('src/agents/architect.ts'),
			read('src/hooks/pr-workflow-gate.ts'),
			read('.opencode/skills/swarm-pr-review/SKILL.md'),
		];

		for (const source of sources) {
			expect(source).not.toContain('cat-file -e <full_pr_head_sha>^{commit}');
			expect(source).not.toContain('rev-parse --verify HEAD^{commit}');
			expect(source).not.toContain('HEAD^0;');
			expect(source).toContain('rev-parse --verify <full_pr_head_sha>^0');
			expect(source).toContain('cat-file -t <full_pr_head_sha>');
		}

		const dispatchRuntime = read('src/tools/dispatch-lanes.ts');
		expect(dispatchRuntime).not.toContain('fetch origin <base-branch> &&');
		expect(dispatchRuntime).toContain('two separate standalone commands');
		expect(dispatchRuntime).toContain(
			'First run: git -C "${directory}" fetch origin <base-branch>. Then run:',
		);

		// Consumption-aware (#3511 class, #3507 pattern): the positive pin
		// resolves pending OR materialized history; the negative pin applies to
		// pending text only (aggregate history can legitimately contain the
		// scanned phrase in unrelated release notes).
		const diagnostic = fragmentTextOrArchive(
			'1931-pr-review-diagnostic-errors.md',
		);
		expect(diagnostic).not.toBeNull();
		expect(diagnostic).toContain('git switch --detach <sha>');
		const pendingDiagnostic = pendingText(
			'1931-pr-review-diagnostic-errors.md',
		);
		if (pendingDiagnostic !== null) {
			expect(pendingDiagnostic).not.toContain(
				'git -C "<directory>" switch --detach',
			);
		}
	});

	test('Profile A keeps context in dispatch prompts instead of requiring blocked scratch writes', () => {
		const source = read('.opencode/skills/swarm-pr-review/SKILL.md');
		const phase0 = source.slice(
			source.indexOf('## Phase 0: Context Pack and Review Signal Collection'),
			source.indexOf('## Phase 1:', source.indexOf('## Phase 0:')),
		);
		const compact = phase0.replace(/\s+/g, ' ');

		expect(compact).toContain('Under Profile A');
		expect(compact).toContain('do not create a scratch context-pack file');
		expect(compact).toContain('common_prompt');
		expect(compact).toContain('exact bound diff');
	});

	test('keeps child settlement out of controller-tool detection in every skill tree', () => {
		const canonical = read('.opencode/skills/swarm-pr-review/SKILL.md');
		const profileAStart = canonical.indexOf(
			'**Profile A — structured PR-workflow controller.**',
		);
		const profileA = canonical.slice(
			profileAStart,
			canonical.indexOf('The child-bound', profileAStart),
		);
		expect(profileA).not.toContain('submit_pr_review_result');
		expect(canonical).toContain(
			'ensure each base/micro child lane submits exactly one child-bound structured',
		);
		const controllerOrder = canonical.slice(
			canonical.indexOf('Controller order is exact:'),
			canonical.indexOf('All machine-readable candidate headers'),
		);
		expect(controllerOrder).not.toContain('receipt and then stop');

		for (const adapter of [
			'.agents/skills/swarm-pr-review/SKILL.md',
			'.claude/skills/swarm-pr-review/SKILL.md',
		]) {
			expect(read(adapter)).not.toContain('submit_pr_review_result');
		}
	});

	test('reconciles stale checks against the latest same-head run and exits exhausted retries cleanly', () => {
		const source = read('.opencode/skills/swarm-pr-review/SKILL.md').replace(
			/\s+/g,
			' ',
		);

		expect(source).toContain('latest run for the exact bound head SHA');
		expect(source).toContain('supersedes an older same-check run');
		// Issue #2383: the exhausted-retry exit now routes through the terminal
		// N-of-6 settlement guidance instead of the old "After the second
		// failed retry" abort-first phrasing.
		expect(source).toContain(
			'the terminal N-of-6 settlement (issue #2383) is the truthful exit — not abort',
		);
		expect(source).toContain('abort_pr_workflow');
		expect(source).toContain('mode: "PR_REVIEW"');
		expect(source).toContain('kind: "recovery"');
		expect(source).toContain('non-empty one-line `reason`');
		expect(source).toContain(
			'Use it only when the bind/checkout path is genuinely unreachable;',
		);
		expect(source).toContain('operation: "restore"');

		const architect = read('src/agents/architect.ts').replace(/\s+/g, ' ');
		const retryRule = architect.slice(
			architect.indexOf('- RETRY STRUCTURALLY:'),
			architect.indexOf(
				'- USE ASYNC DISPATCH',
				architect.indexOf('- RETRY STRUCTURALLY:'),
			),
		);
		expect(retryRule).toContain(
			'if the second retry still cannot close coverage',
		);
		expect(retryRule).toContain('settle N-of-6 truthfully');
		expect(retryRule).not.toContain('call `abort_pr_workflow`');
		expect(retryRule).toContain(
			'do not probe downstream writers or micro lanes',
		);
		expect(source).toContain('mode: "PR_REVIEW"');
		expect(source).toContain('kind: "recovery"');
		expect(source).toContain('non-empty one-line `reason`');
	});

	test('surfaces exact restore inventory and legacy receipt recovery', () => {
		for (const relativePath of [
			'.opencode/skills/swarm-pr-review/SKILL.md',
			'.opencode/skills/swarm-pr-feedback/SKILL.md',
		]) {
			const source = read(relativePath).replace(/\s+/g, ' ');
			expect(source).toContain('checkout_restore_receipts');
			expect(source).toContain('stash_oid');
			expect(source).toContain('Legacy receipts derive');
			expect(source).toContain('uniquely matching local branch');
		}
	});
});
