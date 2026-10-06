import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..');
const GATE = path.join(REPO_ROOT, 'scripts', 'check-config-consumption.ts');

type RunResult = { status: number; out: string };

function runGate(root: string, env: Record<string, string> = {}): RunResult {
	const res = spawnSync('bun', [GATE, '--root', root], {
		cwd: REPO_ROOT,
		env: { ...process.env, ...env },
		encoding: 'utf8',
		timeout: 180_000,
		maxBuffer: 64 * 1024 * 1024,
	});
	const status = res.status ?? (res.error ? 1 : 0);
	return { status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

const SCHEMA =
	'export const PluginConfigSchema = { shape: { alpha: {}, beta: {} } } as const;\n';

const DECL = (alphaCitation: string) =>
	`import type { PluginConfigSchema } from './schema';\n` +
	`type TopLevelKey = keyof typeof PluginConfigSchema.shape;\n` +
	`export const CONFIG_CONSUMERS = {\n` +
	`\talpha: ${alphaCitation},\n` +
	`\tbeta: { inert: 'fixture inert key by design' },\n` +
	`} as Record<TopLevelKey, { consumers: string[] } | { inert: string }>;\n`;

const READER =
	'export function readAlpha(config: { alpha?: { enabled?: boolean } }): boolean {\n\treturn config.alpha?.enabled === true;\n}\n';

function writeFixture(
	dir: string,
	alphaCitation: string,
	readerSrc: string,
): void {
	fs.mkdirSync(path.join(dir, 'src', 'config'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, 'src', 'config', 'schema.ts'),
		SCHEMA,
		'utf8',
	);
	fs.writeFileSync(
		path.join(dir, 'src', 'config', 'consumers.ts'),
		DECL(alphaCitation),
		'utf8',
	);
	fs.writeFileSync(path.join(dir, 'src', 'reader.ts'), readerSrc, 'utf8');
}

describe('check-config-consumption — CLI surface (issue #2904 F-003)', () => {
	it('exits 0 with the verified-count line on the real repository root', () => {
		const res = runGate(REPO_ROOT);
		expect(res.status).toBe(0);
		// Deliberate tripwire: this pin breaks on any future schema-key addition,
		// forcing the count here and in src/config/consumers.ts to move together.
		expect(res.out).toContain('84 keys verified');
	});

	it('exits 0 on a clean --root fixture', () => {
		const fx = canonicalMkdtemp('2904-cli-clean-');
		try {
			writeFixture(fx, "{ consumers: ['src/reader.ts:readAlpha'] }", READER);
			const res = runGate(fx);
			expect(res.status).toBe(0);
			expect(res.out).toContain('2 keys verified');
		} finally {
			fs.rmSync(fx, { recursive: true, force: true });
		}
	});

	it('exits 1 under enforced mode on a stale citation, naming it as stale', () => {
		const fx = canonicalMkdtemp('2904-cli-stale-');
		try {
			writeFixture(
				fx,
				"{ consumers: ['src/reader.ts:readAlpha'] }",
				// Symbol declared but the key never referenced — the true stale-citation shape.
				'export function readAlpha(): boolean {\n\treturn true;\n}\n',
			);
			const res = runGate(fx, { CONFIG_CONSUMPTION_ENFORCE: '1' });
			expect(res.status).toBe(1);
			expect(res.out).toContain('stale');
		} finally {
			fs.rmSync(fx, { recursive: true, force: true });
		}
	});

	it('soft-warns (exit 0, finding still printed) under CONFIG_CONSUMPTION_ENFORCE=0', () => {
		const fx = canonicalMkdtemp('2904-cli-softwarn-');
		try {
			writeFixture(
				fx,
				"{ consumers: ['src/reader.ts:readAlpha'] }",
				'export function readAlpha(): boolean {\n\treturn true;\n}\n',
			);
			const res = runGate(fx, { CONFIG_CONSUMPTION_ENFORCE: '0' });
			expect(res.status).toBe(0);
			expect(res.out).toContain('stale');
			expect(res.out).toContain('soft-warn');
		} finally {
			fs.rmSync(fx, { recursive: true, force: true });
		}
	});

	it('exits 1 with a path-not-allowed finding on a declaration self-citation', () => {
		const fx = canonicalMkdtemp('2904-cli-selfcite-');
		try {
			writeFixture(
				fx,
				"{ consumers: ['src/config/consumers.ts:CONFIG_CONSUMERS'] }",
				READER,
			);
			const res = runGate(fx, { CONFIG_CONSUMPTION_ENFORCE: '1' });
			expect(res.status).toBe(1);
			expect(res.out).toContain('path-not-allowed');
		} finally {
			fs.rmSync(fx, { recursive: true, force: true });
		}
	});
});
