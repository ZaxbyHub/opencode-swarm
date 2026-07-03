import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractSymbolsForFile } from '../../../src/tools/symbols';

let root: string;

function write(rel: string, content: string): void {
	const full = path.join(root, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, 'utf-8');
}

beforeEach(() => {
	root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'symbols-native-')),
	);
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe('extractSymbolsForFile - native and dynamic languages', () => {
	test('extracts public C++ header declarations and hides static internals', () => {
		write(
			'api.h',
			`#pragma once
struct Widget {};
int make_widget();
static int hidden();
`,
		);

		const symbols = extractSymbolsForFile('api.h', root);
		expect(symbols).not.toBeNull();
		expect(symbols).toContainEqual(
			expect.objectContaining({
				name: 'Widget',
				kind: 'type',
				exported: true,
			}),
		);
		expect(symbols).toContainEqual(
			expect.objectContaining({
				name: 'make_widget',
				kind: 'function',
				exported: true,
			}),
		);
		expect(symbols).toContainEqual(
			expect.objectContaining({
				name: 'hidden',
				kind: 'function',
				exported: false,
			}),
		);
	});

	test('extracts Dart class and method symbols while filtering private members', () => {
		write(
			'model.dart',
			`class Foo {
  void bar() {}
  final int _privateField = 0;
  static void staticBaz() {}
}
`,
		);

		const symbols = extractSymbolsForFile('model.dart', root);
		expect(symbols).toContainEqual(
			expect.objectContaining({ name: 'Foo', exported: true }),
		);
		expect(symbols).toContainEqual(
			expect.objectContaining({ name: 'bar', exported: true }),
		);
		expect(symbols).toContainEqual(
			expect.objectContaining({ name: 'staticBaz', exported: true }),
		);
		expect(symbols).not.toContainEqual(
			expect.objectContaining({ name: '_privateField' }),
		);
	});

	test('extracts Swift public types and methods while hiding private functions', () => {
		write(
			'Model.swift',
			`public struct Model {
  public func render() {}
}
fileprivate func hidden() {}
`,
		);

		const symbols = extractSymbolsForFile('Model.swift', root);
		expect(symbols).toContainEqual(
			expect.objectContaining({ name: 'Model', exported: true }),
		);
		expect(symbols).toContainEqual(
			expect.objectContaining({ name: 'Model.render', exported: true }),
		);
		expect(symbols).toContainEqual(
			expect.objectContaining({ name: 'hidden', exported: false }),
		);
	});

	test('extracts Ruby and PHP public dynamic symbols conservatively', () => {
		write(
			'service.rb',
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
		write(
			'Service.php',
			`<?php
namespace App\\Billing;
trait Logs {}
class Service {
  function run() {}
  static function build() {}
  private function token() {}
}
`,
		);

		expect(extractSymbolsForFile('service.rb', root)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: 'Billing',
					kind: 'type',
					exported: true,
				}),
				expect.objectContaining({
					name: 'Service',
					kind: 'class',
					exported: true,
				}),
				expect.objectContaining({
					name: 'build',
					kind: 'method',
					exported: true,
				}),
				expect.objectContaining({
					name: 'token',
					kind: 'method',
					exported: false,
				}),
				expect.objectContaining({
					name: 'visible',
					kind: 'method',
					exported: true,
				}),
			]),
		);
		expect(extractSymbolsForFile('Service.php', root)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: 'App\\Billing',
					kind: 'type',
					exported: true,
				}),
				expect.objectContaining({
					name: 'Logs',
					kind: 'interface',
					exported: true,
				}),
				expect.objectContaining({
					name: 'Service',
					kind: 'class',
					exported: true,
				}),
				expect.objectContaining({
					name: 'run',
					kind: 'method',
					exported: true,
				}),
				expect.objectContaining({
					name: 'build',
					kind: 'method',
					exported: true,
				}),
				expect.objectContaining({
					name: 'token',
					kind: 'method',
					exported: false,
				}),
			]),
		);
	});
});
