/**
 * Guardrail G1 for issue #1619 — source scan: no hook handler may REBIND
 * `output.system` / `output.messages`.
 *
 * The OpenCode host invokes each plugin hook as `M(input, output)`, DISCARDS the
 * handler's return value, and afterwards reads its OWN local array:
 *
 *   - `experimental.chat.system.transform` (host binary ~100,587,200,
 *     `LLMRequestPrep.prepare`): `let l=[…]; trigger(…,{system:l}); …uses l`.
 *   - `experimental.chat.messages.transform` (host binary ~100,667,665):
 *     `yield* d.trigger("experimental.chat.messages.transform",{},{messages:C})`
 *     followed by `Me.toModelMessagesEffect(C,Z)`.
 *
 * So `output.system = …` / `output.messages = …` is invisible to the host —
 * only in-place mutation (`push`, `splice`, `length = 0`, index assignment) is
 * observable. Two shipped "fixes" were silently dead for exactly this reason
 * (the #628 system collapse, and the message consolidation this repo's docs
 * claimed was running). This scan stops a third.
 *
 * NOTE — `chat.params` / `chat.headers` DO consume the returned object, so this
 * rule is scoped to the two chat transform chains, not to plugin hooks in
 * general.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const SRC_DIR = join(REPO_ROOT, 'src');

/**
 * Assignment to a `.system` / `.messages` property, receiver-agnostic so the
 * guard cannot be bypassed by aliasing (`const out = output as {…};
 * out.messages = …`) or by Biome wrapping the receiver onto a previous line.
 * `(?!=)` keeps `===` / `==` comparisons out. `messages.length = 0` does not
 * match (the assignment target there is `.length`), which is exactly right —
 * that IS the in-place form. `messages[0] = merged` likewise does not match:
 * the bracket alternative requires a QUOTE inside the brackets, so index
 * assignment (also an in-place form) stays unflagged.
 *
 * Both dot and computed member access are covered. The computed branch was
 * added for issue #1619 review round 4 (F4): the original
 * `/\.\s*(?:system|messages)\s*=(?!=)/` required a literal `.`, so the
 * semantically identical `output['messages'] = x` rebound the host's array
 * while the guard reported clean — and the release note enumerated only two
 * evading shapes, neither of them this one.
 */
const REBIND_RE =
	/(?:\.\s*|\[\s*['"])(?:system|messages)(?:['"]\s*\])?\s*=(?!=)/;

/**
 * Deliberately-kept rebinds. Each entry must state WHY. `count` is exact, so
 * both a new sibling rebind and the silent removal of an allowlisted one fail
 * the test and force a conscious decision.
 */
const ALLOWLIST: ReadonlyArray<{
	file: string;
	snippet: string;
	count: number;
	reason: string;
}> = [
	{
		file: 'src/index.ts',
		snippet: 'output.system = system;',
		count: 2,
		reason:
			'createSwarmCommandSystemRuleHook (`src/index.ts`), which does ' +
			'`const system = Array.isArray(output.system) ? output.system : []`. ' +
			'The HOST always supplies an array, so in production `system` IS ' +
			'`output.system`, the rule reaches the model through the in-place ' +
			'`system.push(...)`, and both assignments are self-assignments the host ' +
			'never observes. DO NOT delete them: when `output.system` is absent or ' +
			'not an array (non-host callers, and tests), `system` is a fresh local ' +
			'and the assignment is the ONLY thing that attaches it to `output`. ' +
			'The sentinel scan above them is a separate decision, kept because ' +
			'double plugin registration across plugin instances cannot be excluded ' +
			'from the host binary (issue #1619 fix plan, revision 2, B5).',
	},
	{
		file: 'src/index.ts',
		snippet: 'output.messages = messagesBefore;',
		count: 1,
		reason:
			'The `else` arm of the durable-background-advisory rollback in ' +
			'`durableBackgroundAdvisoryMessagesTransform`. The `if` arm restores ' +
			'IN PLACE and is the production path — the host always hands us an ' +
			'array, so `Array.isArray(output.messages)` is true and this line never ' +
			'runs against the host. It is reached only when `output.messages` is ' +
			'absent or is not an array (non-host callers, and tests), where there ' +
			'is no host-owned array to mutate and the assignment is the ONLY thing ' +
			'that restores the pre-attempt value. DO NOT delete it: removing the ' +
			'arm silently drops the rollback for those callers (F4, issue #1619 ' +
			'review round 2).',
	},
];

/**
 * Strip comments so prose describing the defect (this repo documents it in
 * several places) is not mistaken for the defect. Block comments go first; the
 * line-comment strip deliberately does not fire on `://` so URLs inside string
 * literals survive. Limitation: a rebind placed on the same line AFTER a string
 * containing `//` would be missed — no such line exists, and Biome's formatter
 * would split it.
 */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function listScannedFiles(): string[] {
	const entries = readdirSync(SRC_DIR, { recursive: true }) as string[];
	return entries
		.filter((rel) => rel.endsWith('.ts'))
		.filter((rel) => !rel.endsWith('.test.ts') && !rel.endsWith('.spec.ts'))
		.map((rel) => `src/${rel.split(/[\\/]/).join('/')}`)
		.sort();
}

type Hit = { file: string; line: number; text: string };

function findRebinds(): Hit[] {
	const hits: Hit[] = [];
	for (const rel of listScannedFiles()) {
		const source = stripComments(readFileSync(join(REPO_ROOT, rel), 'utf-8'));
		const lines = source.split(/\r?\n/);
		for (let i = 0; i < lines.length; i++) {
			if (REBIND_RE.test(lines[i])) {
				hits.push({ file: rel, line: i + 1, text: lines[i].trim() });
			}
		}
	}
	return hits;
}

describe('no output.system / output.messages rebind in chat transforms (#1619)', () => {
	test('sanity: the scan actually walks a non-trivial source tree', () => {
		const files = listScannedFiles();
		expect(files.length).toBeGreaterThan(50);
		expect(files).toContain('src/index.ts');
		expect(files).toContain('src/hooks/messages-transform.ts');
		expect(files).toContain('src/memory/injector.ts');
	});

	test('every .system / .messages assignment in src/ is allowlisted', () => {
		const hits = findRebinds();
		const violations = hits
			.filter(
				(hit) =>
					!ALLOWLIST.some(
						(entry) => entry.file === hit.file && entry.snippet === hit.text,
					),
			)
			.map((hit) => `${hit.file}:${hit.line}  ${hit.text}`);

		expect(
			violations,
			'Rebinding `output.system` / `output.messages` inside an ' +
				'`experimental.chat.system.transform` or ' +
				'`experimental.chat.messages.transform` handler is INVISIBLE to the ' +
				'OpenCode host: it discards the hook return value and reads its own ' +
				'array reference. Mutate in place instead (`arr.length = 0` + push, ' +
				'`splice`, `push`) — see `consolidateSystemMessagesInPlace` in ' +
				'src/hooks/messages-transform.ts. If a match is genuinely unrelated ' +
				`to the hook chains, add it to ALLOWLIST with a reason.\nOffenders:\n${violations.join('\n')}`,
		).toEqual([]);
	});

	test('each allowlisted rebind still occurs exactly the expected number of times', () => {
		const hits = findRebinds();
		for (const entry of ALLOWLIST) {
			const actual = hits.filter(
				(hit) => hit.file === entry.file && hit.text === entry.snippet,
			).length;
			expect(
				actual,
				`ALLOWLIST drift for ${entry.file} :: ${entry.snippet}. Expected ` +
					`${entry.count}, found ${actual}. Update the allowlist deliberately.`,
			).toBe(entry.count);
		}
	});

	test('the consolidation is wired to the in-place helper in production', () => {
		const indexSource = readFileSync(
			join(REPO_ROOT, 'src', 'index.ts'),
			'utf-8',
		);
		expect(indexSource).toContain('consolidateSystemMessagesInPlace(');
		const transformSource = readFileSync(
			join(REPO_ROOT, 'src', 'hooks', 'messages-transform.ts'),
			'utf-8',
		);
		expect(transformSource).toContain(
			'export function consolidateSystemMessagesInPlace(',
		);
	});

	// Falsifiability: without this the guard could pass while silently failing to
	// catch a reintroduction. Every form below is a real rebind shape observed in
	// (or reachable from) this codebase.
	test('the pattern flags every rebind form, and only real ones', () => {
		const mustFlag = [
			'output.system = [output.system.join(String())];',
			'output.messages = consolidateSystemMessages(output.messages);',
			'output.messages = messagesBefore;',
			'out.messages = cloned;', // aliased receiver (issue-trace idiom)
			'\t\t.messages = next;', // receiver wrapped onto the previous line
			'ctx.output.system = entries;', // nested receiver
			'output.messages =', // assignment wrapped onto the next line
			"output['messages'] = x;", // computed access (F4, round 4)
			'output["system"] = entries;', // computed access, double-quoted
			"out[ 'messages' ] = cloned;", // computed access with inner padding
		];
		for (const src of mustFlag) {
			expect(REBIND_RE.test(src), `must flag: ${JSON.stringify(src)}`).toBe(
				true,
			);
		}

		const mustNotFlag = [
			'output.messages.length = 0;', // the in-place clear
			'output.messages.push(message);',
			'output.messages.splice(idx, 0, message);',
			'output.messages[0] = merged;',
			'if (output.messages === undefined) return;',
			'expect(output.system == null).toBe(true);',
			'const system = Array.isArray(output.system) ? output.system : [];',
			'if (messages.length >= 2) return;',
			// The computed branch must not swallow the in-place forms it sits
			// next to, nor an unrelated map keyed by a similar name (F4, round 4).
			"output['messages'].push(message);",
			"output['messages'].length = 0;",
			"if (output['messages'] === undefined) return;",
			"const n = counts['messages'] + 1;",
			'const { messages } = output;',
			'let messages = [];',
		];
		for (const src of mustNotFlag) {
			expect(REBIND_RE.test(src), `must NOT flag: ${JSON.stringify(src)}`).toBe(
				false,
			);
		}
	});

	test('comment stripping hides prose about the defect but not the defect', () => {
		expect(
			REBIND_RE.test(
				stripComments('// previously: output.messages = consolidate(x);'),
			),
		).toBe(false);
		expect(
			REBIND_RE.test(
				stripComments('/** rebinding output.system = x is invisible */'),
			),
		).toBe(false);
		expect(
			REBIND_RE.test(stripComments('output.messages = x; // restore')),
		).toBe(true);
		// A `://` inside a string literal must not swallow the rest of the line.
		expect(
			REBIND_RE.test(
				stripComments("const u = 'https://x'; output.messages = y;"),
			),
		).toBe(true);
	});
});
