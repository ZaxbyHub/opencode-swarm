import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	buildWorkspaceGraphAsync,
	clearCache,
	getContextPack,
	getDeadExports,
} from '../../../src/tools/repo-graph';

describe('repo-graph async builder TS/JS family behavior', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.realpath(
			await fs.mkdtemp(path.join(os.tmpdir(), 'repo-graph-js-family-')),
		);
	});

	afterEach(async () => {
		clearCache(tempDir);
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	async function write(rel: string, content: string): Promise<void> {
		const full = path.join(tempDir, rel);
		await fs.mkdir(path.dirname(full), { recursive: true });
		await fs.writeFile(full, content);
	}

	test('named re-exports create async edges and protect live exports from dead_exports', async () => {
		await write(
			'src/lib.ts',
			`export function used() { return 1; }
export function dead() { return 0; }`,
		);
		await write('src/barrel.ts', `export { used as publicUsed } from './lib';`);
		await write(
			'src/app.ts',
			`import { publicUsed } from './barrel';
export function main() { return publicUsed(); }`,
		);

		const graph = await buildWorkspaceGraphAsync(tempDir);
		const barrelEdge = graph.edges.find(
			(e) => e.source.endsWith('barrel.ts') && e.target.endsWith('lib.ts'),
		);
		expect(barrelEdge).toMatchObject({
			importType: 'named',
			importedSymbols: ['used'],
			usedSymbols: ['used'],
		});

		const barrelNode = Object.values(graph.nodes).find((n) =>
			n.filePath.endsWith('barrel.ts'),
		);
		expect(barrelNode?.exports).toEqual(['publicUsed']);
		expect(barrelNode?.exportRanges?.publicUsed).toEqual({
			startLine: 1,
			endLine: 1,
		});

		const dead = getDeadExports(graph);
		expect(dead.candidates).toContainEqual({
			file: 'src/lib.ts',
			symbol: 'dead',
			line: 2,
			importerCount: 1,
		});
		expect(dead.candidates).not.toContainEqual(
			expect.objectContaining({ file: 'src/lib.ts', symbol: 'used' }),
		);
	});

	test('context_pack follows a default re-export barrel to the original target', async () => {
		await write(
			'src/widget.ts',
			`export default function Widget() {
	return 1;
}`,
		);
		await write(
			'src/index.ts',
			`export { default as PublicWidget } from './widget';`,
		);
		await write(
			'src/page.ts',
			`import { PublicWidget } from './index';
export function render() {
	return PublicWidget();
}`,
		);

		const graph = await buildWorkspaceGraphAsync(tempDir);
		const pack = getContextPack(graph, 'src/widget.ts', 'default');
		expect(pack.schemaSupported).toBe(true);
		expect(pack.spans).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					file: expect.stringMatching(/widget\.ts$/),
					symbol: 'default',
				}),
				expect.objectContaining({
					file: expect.stringMatching(/index\.ts$/),
					symbol: 'PublicWidget',
				}),
				expect.objectContaining({
					file: expect.stringMatching(/page\.ts$/),
					symbol: 'render',
				}),
			]),
		);
	});

	test('side-effect imports create conservative edges without usedSymbols', async () => {
		await write('src/setup.ts', `export function init() { return 1; }`);
		await write(
			'src/app.ts',
			`import './setup';
export function main() { return 0; }`,
		);

		const graph = await buildWorkspaceGraphAsync(tempDir);
		const edge = graph.edges.find(
			(e) => e.source.endsWith('app.ts') && e.target.endsWith('setup.ts'),
		);
		expect(edge).toMatchObject({
			importType: 'sideeffect',
			importedSymbols: [],
		});
		expect(edge?.usedSymbols).toBeUndefined();

		const dead = getDeadExports(graph);
		expect(dead.candidates).not.toContainEqual(
			expect.objectContaining({ file: 'src/setup.ts', symbol: 'init' }),
		);
	});

	test('async graph extracts useful TSX/JSX ranges and symbol edges', async () => {
		await write(
			'src/Button.tsx',
			`export function Button() {
	return <button />;
}`,
		);
		await write(
			'src/Panel.tsx',
			`import { Button as UIButton } from './Button';
export function Panel() {
	const rendered = UIButton();
	return <section>{rendered}</section>;
}`,
		);

		const graph = await buildWorkspaceGraphAsync(tempDir);
		const buttonNode = Object.values(graph.nodes).find((n) =>
			n.filePath.endsWith('Button.tsx'),
		);
		expect(buttonNode?.exports).toEqual(['Button']);
		expect(buttonNode?.language).toBe('tsx');
		expect(buttonNode?.exportRanges?.Button).toEqual({
			startLine: 1,
			endLine: 3,
		});
		expect(graph.symbolEdges).toContainEqual(
			expect.objectContaining({
				fromSymbol: 'Panel',
				toSymbol: 'Button',
			}),
		);
	});

	test('async graph routes JSX files through the JavaScript grammar', async () => {
		await write(
			'src/Card.jsx',
			`export function Card() {
	return <article />;
}`,
		);
		await write(
			'src/CardPanel.jsx',
			`import { Card as UICard } from './Card';
export function CardPanel() {
	return <UICard />;
}`,
		);

		const graph = await buildWorkspaceGraphAsync(tempDir);
		const cardNode = Object.values(graph.nodes).find((n) =>
			n.filePath.endsWith('Card.jsx'),
		);
		expect(cardNode?.language).toBe('javascript');
		expect(cardNode?.exports).toEqual(['Card']);
		expect(cardNode?.exportRanges?.Card).toEqual({
			startLine: 1,
			endLine: 3,
		});
		expect(graph.symbolEdges).toContainEqual(
			expect.objectContaining({
				fromSymbol: 'CardPanel',
				toSymbol: 'Card',
			}),
		);
	});
});
