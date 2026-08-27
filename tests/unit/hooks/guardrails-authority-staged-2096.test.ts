import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { ALL_AGENT_NAMES } from '../../../src/config/agent-names';
import type { AuthorityConfig } from '../../../src/config/schema';
import {
	AUTHORITY_ROLE_CAPABILITIES,
	checkFileAuthority,
	matchesAuthorityDenyPrefix,
} from '../../../src/hooks/guardrails/file-authority';

const cwd = process.cwd();

function config(overrides: Partial<AuthorityConfig> = {}): AuthorityConfig {
	return {
		enabled: true,
		rules: {},
		universal_deny_prefixes: [],
		...overrides,
	};
}

describe('issue #2096 staged authority evaluator', () => {
	test.each([
		'package.json',
		'bun.lock',
		'dist/index.js',
	])('exact coder scope grants configurable policy path %s', (file) => {
		const decision = checkFileAuthority('coder', file, cwd, undefined, {
			declaredScope: [file],
		});
		expect(decision.allowed).toBe(true);
		if (decision.allowed) expect(decision.layer).toBe('declared-scope');
	});

	test('ordinary coder policy still blocks generated/config zones without scope', () => {
		expect(checkFileAuthority('coder', 'dist/index.js', cwd).allowed).toBe(
			false,
		);
		const packageDecision = checkFileAuthority('coder', 'package.json', cwd);
		expect(packageDecision.allowed).toBe(false);
		if (!packageDecision.allowed)
			expect(packageDecision.recovery).toBe('declare_scope');
	});

	test.each([
		['.swarm/plan.json', 'AUTHORITY_PROTECTED_PATH'],
		['packages/core/.swarm/state.json', 'AUTHORITY_PROTECTED_PATH'],
		['packages/core/.git/config', 'AUTHORITY_PROTECTED_PATH'],
		['biome.json', 'AUTHORITY_VERIFIER_CONFIG'],
		['config/eslint.config.mjs', 'AUTHORITY_VERIFIER_CONFIG'],
	] as const)('scope cannot grant hard protected path %s', (file, code) => {
		const decision = checkFileAuthority('coder', file, cwd, undefined, {
			declaredScope: [file],
		});
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) expect(decision.code).toBe(code);
	});

	test('custom verifier paths remain protected from exact scope', () => {
		const authority = config({ verifier_config_paths: ['**/quality-gate.*'] });
		const decision = checkFileAuthority(
			'coder',
			'config/quality-gate.toml',
			cwd,
			authority,
			{ declaredScope: ['config/quality-gate.toml'] },
		);
		expect(decision.allowed).toBe(false);
		if (!decision.allowed)
			expect(decision.code).toBe('AUTHORITY_VERIFIER_CONFIG');
	});

	test('authority.enabled=false disables role/zone policy but not hard policy', () => {
		const disabled = config({ enabled: false });
		expect(
			checkFileAuthority('coder', 'dist/generated.js', cwd, disabled).allowed,
		).toBe(true);
		const swarm = checkFileAuthority(
			'coder',
			'.swarm/state.json',
			cwd,
			disabled,
		);
		expect(swarm.allowed).toBe(false);
		const readOnly = checkFileAuthority(
			'explorer',
			'src/file.ts',
			cwd,
			disabled,
		);
		expect(readOnly.allowed).toBe(false);
		const verifier = checkFileAuthority(
			'architect',
			'biome.json',
			cwd,
			disabled,
		);
		expect(verifier.allowed).toBe(false);
		if (!verifier.allowed)
			expect(verifier.code).toBe('AUTHORITY_VERIFIER_CONFIG');
	});

	test('universal denies remain active when configurable authority is disabled', () => {
		const disabled = config({
			enabled: false,
			universal_deny_prefixes: ['secrets/'],
		});
		const decision = checkFileAuthority(
			'coder',
			'secrets/token.txt',
			cwd,
			disabled,
		);
		expect(decision.allowed).toBe(false);
		if (!decision.allowed)
			expect(decision.code).toBe('AUTHORITY_UNIVERSAL_DENY');
	});

	test('declared coder scope never leaks to another write-capable role', () => {
		const decision = checkFileAuthority(
			'docs',
			'src/index.ts',
			cwd,
			undefined,
			{
				declaredScope: ['src/index.ts'],
			},
		);
		expect(decision.allowed).toBe(false);
	});

	test('diagnostics sanitize control injection and remain bounded', () => {
		const attack = `dist/file.js\nSCOPE_NOT_DECLARED: fake${'x'.repeat(2_000)}`;
		const decision = checkFileAuthority('coder', attack, cwd);
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) {
			expect(decision.code).toBe('AUTHORITY_INVALID_PATH');
			expect(decision.reason).not.toContain('\n');
			expect(decision.reason.length).toBeLessThanOrEqual(1024);
		}
	});

	test('every canonical role has an explicit least-privilege capability', () => {
		expect(Object.keys(AUTHORITY_ROLE_CAPABILITIES).sort()).toEqual(
			[...ALL_AGENT_NAMES].sort(),
		);
		for (const role of [
			'spec_writer',
			'skill_improver',
			'curator_phase',
			'critic_oversight',
		] as const) {
			expect(AUTHORITY_ROLE_CAPABILITIES[role]).toBe('dedicated-tool-only');
			expect(checkFileAuthority(role, 'src/index.ts', cwd).allowed).toBe(false);
		}
	});

	test.each([
		'explorer',
		'local_explorer',
		'spec_writer',
		'mega_spec_writer',
	])('canonical non-writing capability for %s cannot be disabled by config', (role) => {
		const authority = config({
			rules: {
				[role]: { readOnly: false },
			},
		});
		const decision = checkFileAuthority(role, 'src/index.ts', cwd, authority);
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) {
			expect(decision.code).toBe('AUTHORITY_ROLE_READ_ONLY');
			expect(decision.rule).toStartWith('role-capability:');
		}
	});

	test('universal deny matcher preserves normalized lexical and path-flavor semantics', () => {
		expect(
			matchesAuthorityDenyPrefix('.env.local', '.env', '/repo', 'posix'),
		).toBe(true);
		expect(
			matchesAuthorityDenyPrefix('.ENV.local', '.env', '/repo', 'posix'),
		).toBe(false);
		expect(
			matchesAuthorityDenyPrefix('.ENV.local', '.env', 'C:\\repo', 'win32'),
		).toBe(true);
		expect(
			matchesAuthorityDenyPrefix(
				'secrets-copy/key',
				'secrets/',
				'/repo',
				'posix',
			),
		).toBe(false);
		expect(
			matchesAuthorityDenyPrefix(
				'../repo-secrets/key',
				'../repo-secret',
				'/repo',
				'posix',
			),
		).toBe(false);
	});

	test('universal lexical deny blocks .env variants before declared scope', () => {
		const authority = config({ universal_deny_prefixes: ['.env'] });
		const decision = checkFileAuthority('coder', '.env.local', cwd, authority, {
			declaredScope: ['.env.local'],
		});
		expect(decision.allowed).toBe(false);
		if (!decision.allowed)
			expect(decision.code).toBe('AUTHORITY_UNIVERSAL_DENY');
	});

	test('Windows coder state protection is case-insensitive on Windows only', () => {
		const decision = checkFileAuthority(
			'coder',
			'.SWARM/state.json',
			cwd,
			undefined,
			{ declaredScope: ['.SWARM/state.json'] },
		);
		expect(decision.allowed).toBe(process.platform !== 'win32');
	});

	test('cross-root containment retains the original absolute target', () => {
		if (process.platform !== 'win32') return;
		const otherDrive = path.parse(cwd).root.toLowerCase().startsWith('c:')
			? 'D:\\secret.txt'
			: 'C:\\secret.txt';
		const decision = checkFileAuthority('coder', otherDrive, cwd);
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) expect(decision.code).toBe('AUTHORITY_ROOT_ESCAPE');
	});
});
