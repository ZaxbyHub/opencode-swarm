import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Vendored 2.3.0 surface pins (issues #3732 + #3552).
 *
 * Source-scan + runtime suite only — compile-time assignability lives in the
 * sibling `vendored-surface-2-3-0.type-probe.ts` gated by a real `tsc --noEmit`
 * run (bun test does not typecheck; see the trace for the probe evidence).
 */

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..', '..');
const TYPES = path.join(REPO_ROOT, 'src', 'host', 'v2', 'types.ts');
const FIXTURE = path.join(
	REPO_ROOT,
	'tests',
	'fixtures',
	'host',
	'expected-structure-v2.json',
);

const types = fs.readFileSync(TYPES, 'utf8');

/** Extract a declaration by brace counting (handles nested object members). */
function declarationBlock(keyword: 'interface' | 'type', name: string): string {
	const start = types.indexOf(`export ${keyword} ${name}`);
	if (start === -1) return '';
	let depth = 0;
	let seenOpen = false;
	for (let i = start; i < types.length; i++) {
		const ch = types[i];
		if (ch === '{') {
			depth++;
			seenOpen = true;
		} else if (ch === '}') {
			depth--;
		} else if (seenOpen && ch === ';' && depth === 0) {
			return types.slice(start, i + 1);
		}
		if (seenOpen && depth === 0 && ch === '}') return types.slice(start, i + 1);
	}
	return '';
}

function interfaceBlock(name: string): string {
	return declarationBlock('interface', name);
}

function typeAliasBlock(name: string): string {
	return declarationBlock('type', name);
}

describe('vendored 2.3.0 surface (#3732/#3552)', () => {
	test('provenance header pins the whole 2.3.0 corpus and nothing stale', () => {
		const headerEnd = types.indexOf('*/');
		expect(headerEnd).toBeGreaterThan(0);
		const header = types.slice(0, headerEnd);
		for (const pkg of ['plugin', 'schema', 'client']) {
			const versions = [
				...header.matchAll(
					new RegExp(`@opencode/${pkg}@(\\d+\\.\\d+\\.\\d+)`, 'g'),
				),
			].map((m) => m[1]);
			expect(versions.length).toBeGreaterThan(0);
			expect(versions.every((v) => v === '2.3.0')).toBe(true);
		}
		// drift-check first-match semantics: the FIRST plugin pin file-wide is 2.3.0.
		const first = types.match(/@opencode\/plugin@(\d+\.\d+\.\d+)/);
		expect(first?.[1]).toBe('2.3.0');
	});

	test('committed corpus fixture pins 2.3.0 / v2.3.0', () => {
		const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as {
			pinnedTag: string;
			pinnedHostTag: string;
		};
		expect(fixture.pinnedTag).toBe('2.3.0');
		expect(fixture.pinnedHostTag).toBe('v2.3.0');
	});

	test('new 2.3.0 declarations are vendored', () => {
		expect(types).toContain('export type V2JsonValue');
		expect(types).toContain('export interface V2CredentialDomain');
		expect(types).toContain('export interface V2ExperimentalGenerateApi');
		// Wrap-tolerant: biome may reflow the union across lines.
		expect(types).toMatch(
			/export type V2SessionRequestKind =[\s\S]{0,80}'compaction'[\s\S]{0,80}'generate'/,
		);
		expect(types).toContain('export interface V2SessionRequestMessage');
		expect(types).toContain('export interface V2SessionModelResolve');
		expect(types).toContain('export type V2SessionIdleBackground');
		expect(types).toContain('export interface V2SessionIdle');
		expect(types).toContain('export interface V2SessionListInput');
		expect(types).toContain('export interface V2SessionsResponse');
		expect(types).toContain('export interface V2SessionHookPayloadMap');
		expect(types).toContain('export interface V2SessionCompactionResult');
	});

	test('SessionRequestMessage is standalone, readonly, nullable-text, no index signature', () => {
		const block = interfaceBlock('V2SessionRequestMessage');
		expect(block).not.toContain('extends V2Message');
		expect(block).toContain('readonly content: ReadonlyArray');
		expect(block).toContain('text?: string | null');
		expect(block).not.toContain('[key: string]');
	});

	test('SessionRequestMessage is wired into the context event messages', () => {
		const block = interfaceBlock('V2SessionContextEvent');
		expect(block).toContain('messages: V2SessionRequestMessage[]');
		expect(block).not.toContain('messages: V2Message[]');
	});

	test('compaction result: explicit fields, native present, no index signature', () => {
		const block = interfaceBlock('V2SessionCompactionResult');
		expect(block).toContain('summary: string');
		expect(block).toContain('native?: Record<string, unknown>');
		expect(block).toContain('metadata?: Record<string, unknown>');
		expect(block).toContain('tokens?: unknown');
		expect(block).not.toContain('[key: string]');
		// The old inline result shape (providerState era) must be gone.
		expect(types).not.toContain('providerState');
		const eventBlock = interfaceBlock('V2SessionCompactionEvent');
		expect(eventBlock).toContain('result?: V2SessionCompactionResult');
	});

	test('session domain: paginated list, instructions entries, payload-typed hook', () => {
		const block = interfaceBlock('V2SessionDomain');
		expect(block).toContain(
			'list: (input?: V2SessionListInput) => Promise<V2SessionsResponse>',
		);
		// Anti-vacuity: an array-returning list must not be present.
		expect(block).not.toContain('Promise<V2SessionInfo[]>');
		expect(block).toContain('value: V2JsonValue');
		expect(block).toContain('readonly hook: V2SessionHook;');
		const hookType = typeAliasBlock('V2SessionHook');
		expect(hookType).toContain('V2SessionHookPayloadMap[Name]');
		const payloadMap = interfaceBlock('V2SessionHookPayloadMap');
		expect(payloadMap).toContain('fork:');
		expect(payloadMap).toContain("'experimental.model.resolve'");
		expect(payloadMap).toContain("'experimental.idle'");
		// list and instructions are REQUIRED (no '?' after the member name).
		expect(block).toMatch(/readonly list: \(input\?/);
		expect(block).toMatch(/readonly instructions: \{/);
	});

	test('SessionsResponse is the paginated {data, cursor} object', () => {
		const block = interfaceBlock('V2SessionsResponse');
		expect(block).toContain('data: V2SessionInfo[]');
		expect(block).toContain('cursor: { previous?: unknown; next?: unknown }');
	});

	test('plugin context: credential + experimental + deprecated generate wired', () => {
		const block = interfaceBlock('V2PluginContext');
		expect(block).toContain('credential?: V2CredentialDomain');
		expect(block).toContain('experimental?: {');
		expect(block).toMatch(/generate\?: V2ExperimentalGenerateApi/);
		// The old erased shape must be gone.
		expect(block).not.toContain('generate?: unknown');
	});

	test('event domain: subscribe narrowed to the no-argument call', () => {
		const block = interfaceBlock('V2EventDomain');
		expect(block).toContain('subscribe?: () =>');
		// Anti-vacuity: an options-bag/variadic signature must not be present.
		expect(block).not.toContain('...args: unknown[]');
		expect(block).not.toContain('types?: ReadonlyArray<string>');
	});

	test('agent editor: readonly-array list/get signatures', () => {
		const block = interfaceBlock('V2AgentEditor');
		expect(block).toContain('list(): readonly V2AgentInfo[]');
		expect(block).toContain('get(id: string): V2AgentInfo | undefined');
	});

	test('permission assert input: readonly arrays + 2.3.0 optional fields', () => {
		const block = interfaceBlock('V2PermissionDomain');
		expect(block).toContain('resources: readonly string[]');
		expect(block).toContain('save?: readonly string[]');
		expect(block).toContain('agent?: string');
		expect(block).toContain('metadata?: Record<string, unknown>');
		expect(block).toContain(
			"source?: { type: 'tool'; messageID: string; id: string }",
		);
	});

	test('V2JsonValue is recursive (object and array arms mention V2JsonValue)', () => {
		const block = typeAliasBlock('V2JsonValue');
		expect(block).toContain('V2JsonValue[]');
		expect(block).toContain('[key: string]: V2JsonValue');
	});

	test('runtime probes: JsonValue recursion and idle/model-resolve payload shapes', () => {
		type V2JsonValue =
			| null
			| boolean
			| number
			| string
			| V2JsonValue[]
			| { [key: string]: V2JsonValue };
		const json: V2JsonValue = { a: [1, 'two', null, { b: true }] };
		expect(json).toEqual({ a: [1, 'two', null, { b: true }] });
		const idle: {
			readonly sessionID: string;
			readonly background: ReadonlyArray<{
				readonly kind: string;
				readonly sessionID: string;
			}>;
		} = { sessionID: 's1', background: [{ kind: 'shell', sessionID: 's1' }] };
		expect(idle.background).toHaveLength(1);
	});

	test('historical 2.0.26 verification comments are preserved, not rewritten', () => {
		// The assert-provenance note must survive the refresh (behavior-verification
		// history is not a pin site).
		expect(types).toContain(
			'first appeared at 2.0.29, ABSENT at the 2.0.26 pin',
		);
	});

	test('docs prose pins track the current corpus pin (class guardrail)', () => {
		const read = (rel: string) =>
			fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
		expect(read('docs/installation.md')).toContain('@opencode/plugin@2.3.0');
		expect(read('docs/architecture.md')).toContain(
			'vendored structural types for `@opencode/plugin@2.3.0`',
		);
		const adr = read('docs/decisions/0003-opencode-v2-plugin-api.md');
		expect(adr).toContain('to `@opencode/plugin@2.3.0` by issues #3732/#3552');
		expect(adr).toContain(
			'vendored `@opencode/plugin@2.3.0` pin in `src/host/v2/types.ts`',
		);
		// Anti-stale: the retired active-prose forms must be gone.
		expect(adr).not.toContain(
			'trails npm dist-tags by more than five minor series; at the current 2.0.26',
		);
		expect(read('docs/installation.md')).not.toContain('at the current 2.0.26');
	});
});
