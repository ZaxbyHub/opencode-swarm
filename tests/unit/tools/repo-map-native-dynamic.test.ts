import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { repo_map } from '../../../src/tools/repo-map';

let root: string;

async function callRepoMap(args: Record<string, unknown>): Promise<any> {
	type Executable = {
		execute: (
			args: Record<string, unknown>,
			ctx: { directory: string },
		) => Promise<string | { output: string }>;
	};
	const out = await (repo_map as unknown as Executable).execute(args, {
		directory: root,
	});
	return JSON.parse(typeof out === 'string' ? out : out.output);
}

function write(rel: string, content: string): void {
	const full = path.join(root, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, 'utf-8');
}

beforeEach(() => {
	root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'repo-map-native-dynamic-')),
	);
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe('repo_map native and dynamic language context surfaces', () => {
	test('build resolves quoted C++ includes and context_pack returns header symbol spans', async () => {
		write(
			'api.h',
			`#pragma once
struct Widget {};
int make_widget();
`,
		);
		write(
			'app.cpp',
			`#include "api.h"
int make_widget() { return 1; }
`,
		);

		const build = await callRepoMap({ action: 'build' });
		expect(build.success).toBe(true);
		expect(build.fileCount).toBe(2);

		const graph = JSON.parse(
			fs.readFileSync(path.join(root, '.swarm', 'repo-graph.json'), 'utf-8'),
		);
		const app = Object.values(graph.nodes).find(
			(node: any) => node.moduleName === 'app.cpp',
		) as any;
		expect(app.imports).toContain('./api.h');
		expect(graph.edges).toContainEqual(
			expect.objectContaining({
				importSpecifier: './api.h',
			}),
		);

		const context = await callRepoMap({
			action: 'context_pack',
			file: 'api.h',
			symbol: 'Widget',
			top_n: 3,
		});
		expect(context.success).toBe(true);
		expect(context.spans).toContainEqual(
			expect.objectContaining({
				file: 'api.h',
				symbol: 'Widget',
				startLine: 2,
			}),
		);
	});

	test('context_pack returns PHP trait and method spans from the tool path', async () => {
		write(
			'Service.php',
			`<?php
namespace App\\Services;
trait Logs {}
class Service {
	function run() {}
	static function build() {}
}
`,
		);

		const build = await callRepoMap({ action: 'build' });
		expect(build.success).toBe(true);

		const context = await callRepoMap({
			action: 'context_pack',
			file: 'Service.php',
			symbol: 'Logs',
			top_n: 3,
		});
		expect(context.success).toBe(true);
		expect(context.spans).toContainEqual(
			expect.objectContaining({
				file: 'Service.php',
				symbol: 'Logs',
				startLine: 3,
			}),
		);
		const methodContext = await callRepoMap({
			action: 'context_pack',
			file: 'Service.php',
			symbol: 'run',
			top_n: 3,
		});
		expect(methodContext.success).toBe(true);
		expect(methodContext.spans).toContainEqual(
			expect.objectContaining({
				file: 'Service.php',
				symbol: 'run',
				startLine: 5,
			}),
		);
		const staticMethodContext = await callRepoMap({
			action: 'context_pack',
			file: 'Service.php',
			symbol: 'build',
			top_n: 3,
		});
		expect(staticMethodContext.success).toBe(true);
		expect(staticMethodContext.spans).toContainEqual(
			expect.objectContaining({
				file: 'Service.php',
				symbol: 'build',
				startLine: 6,
			}),
		);
	});

	test('context_pack returns Swift public type spans from the tool path', async () => {
		write(
			'Model.swift',
			`import Foundation
public struct Model {}
public extension Model {
	public func render() {}
}
`,
		);

		const build = await callRepoMap({ action: 'build' });
		expect(build.success).toBe(true);

		const context = await callRepoMap({
			action: 'context_pack',
			file: 'Model.swift',
			symbol: 'Model',
			top_n: 3,
		});
		expect(context.success).toBe(true);
		expect(context.spans).toContainEqual(
			expect.objectContaining({
				file: 'Model.swift',
				symbol: 'Model',
				startLine: 2,
			}),
		);
	});

	test('context_pack returns Ruby class and method spans from the tool path', async () => {
		write(
			'billing.rb',
			`module Billing
class Service
  def self.build; end
  private
  def token; end
end
class Other
  def visible; end
end
end
`,
		);

		const build = await callRepoMap({ action: 'build' });
		expect(build.success).toBe(true);

		const context = await callRepoMap({
			action: 'context_pack',
			file: 'billing.rb',
			symbol: 'Service',
			top_n: 3,
		});
		expect(context.success).toBe(true);
		expect(context.spans).toContainEqual(
			expect.objectContaining({
				file: 'billing.rb',
				symbol: 'Service',
				startLine: 2,
			}),
		);
		const methodContext = await callRepoMap({
			action: 'context_pack',
			file: 'billing.rb',
			symbol: 'self.build',
			top_n: 3,
		});
		expect(methodContext.success).toBe(true);
		expect(methodContext.spans).toContainEqual(
			expect.objectContaining({
				file: 'billing.rb',
				symbol: 'self.build',
				startLine: 3,
			}),
		);
	});

	test('build records Dart alias imports as namespace edges, not fake symbol imports', async () => {
		write(
			'helper.dart',
			`void run() {}
`,
		);
		write(
			'main.dart',
			`import './helper.dart' as helper;

void main() {
	helper.run();
}
`,
		);

		const build = await callRepoMap({ action: 'build' });
		expect(build.success).toBe(true);

		const graph = JSON.parse(
			fs.readFileSync(path.join(root, '.swarm', 'repo-graph.json'), 'utf-8'),
		);
		expect(graph.edges).toContainEqual(
			expect.objectContaining({
				importSpecifier: './helper.dart',
				importType: 'namespace',
				importedSymbols: [],
			}),
		);
		expect(graph.edges).not.toContainEqual(
			expect.objectContaining({
				importSpecifier: './helper.dart',
				importedSymbols: ['./helper.dart'],
			}),
		);
	});
});
