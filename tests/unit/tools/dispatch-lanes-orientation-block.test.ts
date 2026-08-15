import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	buildLaneOrientationBlock,
	_internals as injectionInternals,
	resetGraphInjectionCache,
	resetLaneOrientationDedupe,
} from '../../../src/hooks/repo-graph-injection';
import {
	buildWorkspaceGraphAsync,
	saveGraph,
	writeFingerprint,
} from '../../../src/tools/repo-graph';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const ORIENTATION_HEADING = '## REPO GRAPH — LANE ORIENTATION';

let tmp: string;

beforeEach(() => {
	resetLaneOrientationDedupe();
	resetGraphInjectionCache();
	tmp = canonicalMkdtemp('lanes-orientation-');
	fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
	fs.writeFileSync(
		path.join(tmp, 'src', 'payment-validator.ts'),
		'export function validatePayment(amount: number): boolean {\n\treturn amount > 0;\n}\n',
	);
	fs.writeFileSync(
		path.join(tmp, 'src', 'payment-routes.ts'),
		"import { validatePayment } from './payment-validator';\nexport function routePayment(a: number): string {\n\treturn validatePayment(a) ? 'ok' : 'reject';\n}\n",
	);
	fs.writeFileSync(
		path.join(tmp, 'src', 'payment-store.ts'),
		"import { validatePayment } from './payment-validator';\nexport function storePayment(a: number): number {\n\treturn validatePayment(a) ? a : 0;\n}\n",
	);
	fs.writeFileSync(
		path.join(tmp, 'src', 'invoice-renderer.ts'),
		'export function renderInvoice(label: string): string {\n\treturn label.toUpperCase();\n}\n',
	);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

async function buildAndSaveStartupGraph(): Promise<void> {
	const graph = await buildWorkspaceGraphAsync(tmp);
	await saveGraph(tmp, graph);
	await writeFingerprint(tmp, graph);
}

describe('buildLaneOrientationBlock — gating policy (issue #1988 C2/C6)', () => {
	test('emits a deterministic block when the floor is cleared on a fresh graph', async () => {
		await buildAndSaveStartupGraph();
		const block = await buildLaneOrientationBlock(tmp, [
			'Audit the payment validation flow and its consumers.',
		]);
		expect(block).not.toBeNull();
		expect(block?.startsWith(ORIENTATION_HEADING)).toBe(true);
		expect(block).toContain('Mission-relevant files');
		expect(block).toContain('payment-validator.ts');
		expect(block).toContain('Repo hubs');
		expect(block).toContain('Freshness: fresh (probe clean)');
		expect(block).not.toContain('elapsedMs');
		expect(block).not.toContain('probedFiles');
	});

	test('suppressed on repeat dispatch (dedupe) — separate test', async () => {
		await buildAndSaveStartupGraph();
		const missions = ['Audit the payment validation flow.'];
		const first = await buildLaneOrientationBlock(tmp, missions, {
			sessionID: 'session-a',
		});
		expect(first).not.toBeNull();
		// Second identical dispatch in the same session, NO reset: the file
		// pointers are all already delivered, so nothing is emitted.
		const second = await buildLaneOrientationBlock(tmp, missions, {
			sessionID: 'session-a',
		});
		expect(second).toBeNull();
	});

	test('scale-free floor: concentrated ranking emits even with tiny absolute scores (large-graph behavior)', async () => {
		// On a 3463-node graph a perfectly-targeted mission yields raw top
		// scores of ~0.01, so the 0.35 floor must be applied to the
		// normalized top-3 share, not the absolute score (real-repo evidence
		// in the PR body). One strongly-matching file among many weakly-
		// matching ones concentrates the share and must emit.
		const big = canonicalMkdtemp('lanes-orient-scale-');
		try {
			fs.mkdirSync(path.join(big, 'src'), { recursive: true });
			fs.writeFileSync(
				path.join(big, 'src', 'target-flow.ts'),
				'export function workflowTargetStep() {}\nexport function workflowTargetGuard() {}\nexport function workflowTargetAudit() {}\n',
			);
			for (let i = 0; i < 9; i++) {
				fs.writeFileSync(
					path.join(big, 'src', `neighbor-${i}.ts`),
					`export function workflowNeighborStep${i}() {}\n`,
				);
			}
			const graph = await buildWorkspaceGraphAsync(big);
			await saveGraph(big, graph);
			await writeFingerprint(big, graph);
			const block = await buildLaneOrientationBlock(big, [
				'workflow target audit guard step',
			]);
			expect(block).not.toBeNull();
			expect(block).toContain('target-flow.ts');
		} finally {
			fs.rmSync(big, { recursive: true, force: true });
		}
	});

	test('scale-free floor: diffuse ranking is suppressed', async () => {
		// Six files all matching the same single term equally produce a
		// near-uniform ranking: the top file owns ~1/3 of the top-3 mass,
		// below the 0.35 concentration floor — no orientation is pushed.
		const diffuse = canonicalMkdtemp('lanes-orient-diffuse-');
		try {
			fs.mkdirSync(path.join(diffuse, 'src'), { recursive: true });
			for (let i = 0; i < 6; i++) {
				fs.writeFileSync(
					path.join(diffuse, 'src', `uniform-${i}.ts`),
					'export function sharedzzTerm() {}\n',
				);
			}
			const graph = await buildWorkspaceGraphAsync(diffuse);
			await saveGraph(diffuse, graph);
			await writeFingerprint(diffuse, graph);
			const block = await buildLaneOrientationBlock(diffuse, [
				'sharedzzTerm lookup',
			]);
			expect(block).toBeNull();
		} finally {
			fs.rmSync(diffuse, { recursive: true, force: true });
		}
	});

	test('determinism — identical dispatches from reset dedupe state are byte-identical', async () => {
		await buildAndSaveStartupGraph();
		const missions = ['Audit the payment validation flow and routing.'];
		const first = await buildLaneOrientationBlock(tmp, missions, {
			sessionID: 'session-det',
		});
		resetLaneOrientationDedupe();
		resetGraphInjectionCache();
		const second = await buildLaneOrientationBlock(tmp, missions, {
			sessionID: 'session-det',
		});
		expect(second).not.toBeNull();
		expect(second).toBe(first);
	});

	test('suppressed when the graph is stale beyond refresh_cap', async () => {
		await buildAndSaveStartupGraph();
		// Drift the graph: touch a tracked file so the probe reports 'drifted'.
		fs.writeFileSync(
			path.join(tmp, 'src', 'payment-validator.ts'),
			'export function validatePayment(amount: number): boolean {\n\treturn amount >= 0;\n}\n',
		);
		const block = await buildLaneOrientationBlock(
			tmp,
			['Audit the payment validation flow.'],
			{ refreshCap: 0 },
		);
		expect(block).toBeNull();
	});

	test('suppressed when no fingerprint exists (uncertified graph)', async () => {
		const graph = await buildWorkspaceGraphAsync(tmp);
		await saveGraph(tmp, graph);
		const block = await buildLaneOrientationBlock(tmp, [
			'Audit the payment validation flow.',
		]);
		expect(block).toBeNull();
	});

	test('suppressed when no graph exists at all', async () => {
		const block = await buildLaneOrientationBlock(tmp, [
			'Audit the payment validation flow.',
		]);
		expect(block).toBeNull();
	});

	test('suppressed when repo graph injection is disabled (enabled: false gate)', async () => {
		await buildAndSaveStartupGraph();
		const block = await buildLaneOrientationBlock(
			tmp,
			['Audit the payment validation flow.'],
			{ enabled: false },
		);
		expect(block).toBeNull();
	});

	test('same-session mission whose pointers were all already delivered is suppressed', async () => {
		await buildAndSaveStartupGraph();
		const first = await buildLaneOrientationBlock(
			tmp,
			['Audit the payment validation flow.'],
			{ sessionID: 'session-novel' },
		);
		expect(first).not.toBeNull();
		// In this 4-file fixture every file is either a mission hit or a
		// top-4 hub, so the first block delivered ALL pointers — including
		// invoice-renderer.ts as a hub. The invoice mission therefore has no
		// novel pointer and emits nothing (novelty dedupe by design).
		const second = await buildLaneOrientationBlock(
			tmp,
			['Audit the invoice rendering.'],
			{ sessionID: 'session-novel' },
		);
		expect(second).toBeNull();
	});

	test('per-session dedupe: the same mission in a different session emits again', async () => {
		await buildAndSaveStartupGraph();
		const first = await buildLaneOrientationBlock(
			tmp,
			['Audit the payment validation flow.'],
			{ sessionID: 'session-one' },
		);
		expect(first).not.toBeNull();
		const second = await buildLaneOrientationBlock(
			tmp,
			['Audit the payment validation flow.'],
			{ sessionID: 'session-two' },
		);
		expect(second).not.toBeNull();
		// Same graph state and mission ⇒ byte-identical block in the fresh
		// session (empty dedupe state).
		expect(second).toBe(first);
	});

	test('token gate — a rendered block over the 600-token budget is dropped', async () => {
		// Long file and export names push the rendered block past the
		// LANE_ORIENTATION_MAX_TOKENS budget (estimateTokens = ceil(len*0.33),
		// so >1818 chars exceeds 600 tokens).
		const longDir = canonicalMkdtemp('lanes-orient-big-');
		try {
			fs.mkdirSync(path.join(longDir, 'src'), { recursive: true });
			const longName = 'a'.repeat(120);
			for (let i = 0; i < 6; i++) {
				fs.writeFileSync(
					path.join(longDir, 'src', `${longName}${i}.ts`),
					`import { exportFunctionWithLongExportName${(i + 1) % 6}_0 } from './${longName}${(i + 1) % 6}';\nexport function exportFunctionWithLongExportName${i}_0() {}\nexport function exportFunctionWithLongExportName${i}_1() {}\nexport function exportFunctionWithLongExportName${i}_2() {}\n`,
				);
			}
			const graph = await buildWorkspaceGraphAsync(longDir);
			await saveGraph(longDir, graph);
			await writeFingerprint(longDir, graph);
			const block = await buildLaneOrientationBlock(longDir, [
				'exportFunctionWithLongExportName audit',
			]);
			expect(block).toBeNull();
		} finally {
			fs.rmSync(longDir, { recursive: true, force: true });
		}
	});
});

describe('orientation render seam — pure render and freshness mapping', () => {
	test('render includes sections only when non-empty', () => {
		const both = injectionInternals.renderLaneOrientationBlock(
			[{ file: 'src/a.ts', score: 0.42, exports: ['x', 'y', 'z', 'w'] }],
			['src/hub1.ts', 'src/hub2.ts'],
			'fresh (probe clean)',
		);
		expect(both.startsWith(ORIENTATION_HEADING)).toBe(true);
		expect(both).toContain('- src/a.ts (score 0.42; exports: x, y, z)');
		expect(both).toContain(
			'Repo hubs (most imported): src/hub1.ts, src/hub2.ts',
		);
		expect(both.endsWith('Freshness: fresh (probe clean)')).toBe(true);

		const askOnly = injectionInternals.renderLaneOrientationBlock(
			[{ file: 'src/a.ts', score: 0.42, exports: [] }],
			[],
			'fresh (probe clean)',
		);
		expect(askOnly).not.toContain('Repo hubs');
		expect(askOnly).toContain('(score 0.42)');

		const hubsOnly = injectionInternals.renderLaneOrientationBlock(
			[],
			['src/hub1.ts'],
			'fresh (probe clean)',
		);
		expect(hubsOnly).not.toContain('Mission-relevant files');
	});

	test('freshness line covers every probe state deterministically', () => {
		const { orientationFreshnessLine } = injectionInternals;
		expect(orientationFreshnessLine('clean', 0, 0)).toBe('fresh (probe clean)');
		expect(orientationFreshnessLine('drifted', 3, 1)).toBe(
			'drifted within refresh cap (3 changed, 1 removed)',
		);
		expect(orientationFreshnessLine('inconclusive', 0, 0)).toBe(
			'freshness unknown (probe inconclusive)',
		);
	});
});
