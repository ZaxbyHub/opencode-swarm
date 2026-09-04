import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../../tests/helpers/tmpdir';
import { _internals, buildWorkspaceGraph } from './builder';

const workspaces: string[] = [];
const realExtractFileOntology = _internals.extractFileOntology;

afterEach(() => {
	_internals.extractFileOntology = realExtractFileOntology;
	for (const workspace of workspaces) {
		rmSync(workspace, { recursive: true, force: true });
	}
	workspaces.length = 0;
});

describe('sync fallback builder diagnostics', () => {
	test('records a malformed post-parse failure as a stable skipped input', () => {
		const workspace = canonicalMkdtemp('repo-graph-fallback-diag-');
		workspaces.push(workspace);
		mkdirSync(path.join(workspace, '.opencode'), { recursive: true });
		mkdirSync(path.join(workspace, 'src'), { recursive: true });
		writeFileSync(
			path.join(workspace, 'src', 'main.ts'),
			'export const value = 1;',
			'utf-8',
		);
		_internals.extractFileOntology = () => {
			throw new Error('simulated ontology failure');
		};

		const graph = buildWorkspaceGraph(workspace);

		expect(Object.keys(graph.nodes)).toHaveLength(0);
		expect(graph.diagnostics?.extractionFailures).toEqual([
			{
				file: 'src/main.ts',
				language: 'typescript',
				reason: 'fallback_scan_failed',
			},
		]);
		expect(graph.diagnostics?.extractorInputWitnesses).toEqual([
			expect.objectContaining({
				file: 'src/main.ts',
				kind: 'stable-skip',
				sizeBytes: 23,
			}),
		]);
	});
});
