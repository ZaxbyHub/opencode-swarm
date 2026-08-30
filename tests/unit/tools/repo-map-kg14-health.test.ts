import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { repo_map } from '../../../src/tools/repo-map';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tmp = '';

function call(args: Record<string, unknown>): Promise<string> {
	type Executable = {
		execute: (
			args: Record<string, unknown>,
			ctx: { directory: string },
		) => Promise<string>;
	};
	return (repo_map as unknown as Executable).execute(args, {
		directory: tmp,
	});
}

function parse(out: string): Record<string, unknown> {
	return JSON.parse(out) as Record<string, unknown>;
}

beforeEach(() => {
	tmp = canonicalMkdtemp('repo-map-kg14-health-');
	fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
	fs.writeFileSync(
		path.join(tmp, 'src/main.ts'),
		'export function main() { return 1; }\n',
	);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('repo_map: graph_health KG-14 summaries (issue #1535)', () => {
	it('returns the KG-14 summaries on a built graph', async () => {
		await call({ action: 'build' });
		const r = parse(await call({ action: 'graph_health' }));
		expect(r.success).toBe(true);
		expect(r.symbolEdgeSummary).toEqual({
			total: 0,
			withV2Fields: 0,
			lowConfidence: 0,
			unresolved: 0,
		});
		expect(r.resolutionBreakdown).toEqual({});
		expect(r.kindCoverage).toEqual({ nodesWithKinds: 1, nodesTotal: 1 });
		expect(r.staleSummary).toMatchObject({
			changed: 0,
			removed: 0,
		});
	});

	it('returns zero-valued summaries before any graph exists', async () => {
		const r = parse(await call({ action: 'graph_health' }));
		expect(r.success).toBe(true);
		expect(r.symbolEdgeSummary).toEqual({
			total: 0,
			withV2Fields: 0,
			lowConfidence: 0,
			unresolved: 0,
		});
		expect(r.kindCoverage).toEqual({ nodesWithKinds: 0, nodesTotal: 0 });
	});

	it('counts stale files in staleSummary after drift', async () => {
		fs.writeFileSync(path.join(tmp, 'src/extra.ts'), 'export const e = 1;\n');
		await call({ action: 'build' });
		fs.unlinkSync(path.join(tmp, 'src/extra.ts'));
		fs.appendFileSync(
			path.join(tmp, 'src/main.ts'),
			'\nexport const drift = 1;\n',
		);
		const r = parse(await call({ action: 'graph_health' }));
		expect(r.success).toBe(true);
		expect(r.fresh).toBe(false);
		const stale = r.staleSummary as Record<string, unknown>;
		expect(Number(stale.removed)).toBeGreaterThanOrEqual(1);
		expect(Number(stale.changed)).toBeGreaterThanOrEqual(1);
	});

	it('summarizes extraction failures by reason', async () => {
		await call({ action: 'build' });
		const graphPath = path.join(tmp, '.swarm/repo-graph.json');
		const graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8')) as {
			diagnostics?: {
				extractionFailures?: Array<{
					file: string;
					language: string;
					reason: string;
				}>;
			};
		};
		graph.diagnostics = {
			extractionFailures: [
				{ file: 'src/a.ts', language: 'typescript', reason: 'timeout' },
				{ file: 'src/b.ts', language: 'python', reason: 'timeout' },
			],
		};
		fs.writeFileSync(graphPath, JSON.stringify(graph));
		const r = parse(await call({ action: 'graph_health' }));
		expect(r.extractionFailureSummary).toEqual({ timeout: 2 });
	});
});
