import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { repo_map } from '../../../src/tools/repo-map';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

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
	root = canonicalMkdtemp('repo-map-dart-ruby-php-');
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe('repo_map dart/ruby/php context surfaces (#1531)', () => {
	test('build resolves dart alias imports as namespace edges, not fake symbol imports', async () => {
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
		const mainNode = Object.values(graph.nodes).find(
			(node: any) => node.moduleName === 'main.dart',
		) as any;
		expect(mainNode.imports).toContain('./helper.dart');
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

	test('ruby require_relative resolves to the target file and context_pack returns class/singleton spans', async () => {
		write(
			'helper.rb',
			`module Helper
	def self.run
	end
end
`,
		);
		write(
			'billing.rb',
			`require_relative 'helper'

module Billing
class Service
  def self.build; end
  private
  def token; end
end
end
`,
		);

		const build = await callRepoMap({ action: 'build' });
		expect(build.success).toBe(true);

		const graph = JSON.parse(
			fs.readFileSync(path.join(root, '.swarm', 'repo-graph.json'), 'utf-8'),
		);
		const billing = Object.values(graph.nodes).find(
			(node: any) => node.moduleName === 'billing.rb',
		) as any;
		expect(billing.imports).toContain('./helper');

		const classContext = await callRepoMap({
			action: 'context_pack',
			file: 'billing.rb',
			symbol: 'Service',
			top_n: 3,
		});
		expect(classContext.success).toBe(true);
		expect(classContext.spans).toContainEqual(
			expect.objectContaining({
				file: 'billing.rb',
				symbol: 'Service',
				startLine: 4,
			}),
		);

		// Singleton methods are keyed by their literal `self.`-prefixed name.
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
				startLine: 5,
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

		const traitContext = await callRepoMap({
			action: 'context_pack',
			file: 'Service.php',
			symbol: 'Logs',
			top_n: 3,
		});
		expect(traitContext.success).toBe(true);
		expect(traitContext.spans).toContainEqual(
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

	test('context_pack returns dart type spans', async () => {
		write(
			'model.dart',
			`class Model {}
mixin Renderable {}
`,
		);

		const build = await callRepoMap({ action: 'build' });
		expect(build.success).toBe(true);

		const context = await callRepoMap({
			action: 'context_pack',
			file: 'model.dart',
			symbol: 'Renderable',
			top_n: 3,
		});
		expect(context.success).toBe(true);
		expect(context.spans).toContainEqual(
			expect.objectContaining({
				file: 'model.dart',
				symbol: 'Renderable',
				startLine: 2,
			}),
		);
	});
});
