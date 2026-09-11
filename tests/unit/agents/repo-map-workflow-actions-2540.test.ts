import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_MANIFEST } from '../../../src/tools/manifest.js';
import { repo_map } from '../../../src/tools/repo-map.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../..',
);

const PRODUCER_ROOTS = [
	'src/agents',
	'.opencode/skills',
	'src/commands',
] as const;

const REQUIRED_ACTIONS = [
	'symbol_search',
	'symbol_context',
	'graph_explain',
	'preflight_packet',
	'dead_exports',
	'ontology',
] as const;

type RequiredAction = (typeof REQUIRED_ACTIONS)[number];

type InvocationConstraint = {
	required: readonly RegExp[];
	anyOf?: readonly RegExp[];
};

const BOUNDED_ARGUMENTS: Record<RequiredAction, InvocationConstraint> = {
	symbol_search: {
		required: [/\bsymbol\s*[=:]/i, /\btop_n\s*[=:]/i],
	},
	symbol_context: {
		required: [
			/\bfile\s*[=:]/i,
			/\bsymbol\s*[=:]/i,
			/\binclude_source\s*[=:]/i,
			/\btop_n\s*[=:]/i,
		],
	},
	graph_explain: {
		required: [/\bfile\s*[=:]/i, /\btop_n\s*[=:]/i],
		anyOf: [/\bsymbol\s*[=:]/i, /\bline\s*[=:]/i],
	},
	preflight_packet: {
		required: [/\bfiles\s*[=:]/i, /\btop_n\s*[=:]/i],
	},
	ontology: { required: [/\bfile\s*[=:]/i] },
	dead_exports: { required: [/\btop_n\s*[=:]/i] },
};

/**
 * The workflow contract must be authored where an agent is told what to do.
 * This deliberately excludes implementation code, tests, and documentation
 * outside the producer roots; the ratchet therefore cannot pass from a tool
 * enum or a comment that merely repeats an action name.
 */
function producerFiles(relativeRoot: string): string[] {
	const absoluteRoot = path.join(REPO_ROOT, relativeRoot);
	const files: string[] = [];

	function visit(directory: string): void {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (
				entry.isDirectory() &&
				!['.git', 'docs', 'implementation', 'node_modules', 'tests'].includes(
					entry.name,
				)
			) {
				visit(path.join(directory, entry.name));
				continue;
			}

			if (!entry.isFile()) continue;
			const absolute = path.join(directory, entry.name);
			const isSource =
				entry.name.endsWith('.ts') &&
				!entry.name.endsWith('.test.ts') &&
				!entry.name.endsWith('.spec.ts');
			const isSkill =
				relativeRoot === '.opencode/skills' && entry.name === 'SKILL.md';
			if (isSource || isSkill) files.push(absolute);
		}
	}

	visit(absoluteRoot);
	return files;
}

function isCommentOnly(line: string): boolean {
	return /^\s*(?:\/\/|\/\*|\*|<!--)/.test(line);
}

function isWorkflowAnchor(line: string): boolean {
	return (
		/^\s*ACTIONS:\s*$/i.test(line) ||
		/^\s*(?:#{1,6}\s+)?GRAPH-FIRST(?:\s+(?:EVIDENCE|REVIEW))?/i.test(line) ||
		/^\s*DO \(explicitly\):\s*$/i.test(line) ||
		/^\s*Before\s+(?:planning|reviewing|editing).*\brepo_map\b/i.test(line)
	);
}

function isSectionEnd(line: string): boolean {
	return (
		/^\s*#{1,6}\s+/.test(line) ||
		/^\s*(?:RULES|OUTPUT FORMAT|CONFIG STRICTNESS VERIFICATION):\s*$/i.test(
			line,
		)
	);
}

/** Return only anchored workflow sections, with comment-only lines removed. */
function workflowSections(content: string): string[] {
	const lines = content.split(/\r?\n/);
	const sections: string[] = [];

	for (let index = 0; index < lines.length; index++) {
		if (!isWorkflowAnchor(lines[index])) continue;
		const section: string[] = [];
		for (let cursor = index; cursor < lines.length; cursor++) {
			if (cursor > index && isSectionEnd(lines[cursor])) break;
			if (!isCommentOnly(lines[cursor])) section.push(lines[cursor]);
		}
		sections.push(section.join('\n'));
	}

	return sections;
}

function workflowProducerSections(): Array<{ file: string; section: string }> {
	const sections: Array<{ file: string; section: string }> = [];
	for (const root of PRODUCER_ROOTS) {
		for (const file of producerFiles(root)) {
			const content = readFileSync(file, 'utf8');
			for (const section of workflowSections(content)) {
				sections.push({ file: path.relative(REPO_ROOT, file), section });
			}
		}
	}
	return sections;
}

function hasConcreteInvocation(
	section: string,
	action: RequiredAction,
): boolean {
	const escaped = action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const invocation = new RegExp(
		`\\brepo_map\\b[^\\r\\n]{0,160}(?:action\\s*=\\s*["'\`]${escaped}["'\`]|["'\`]${escaped}["'\`])`,
		'i',
	);
	const constraint = BOUNDED_ARGUMENTS[action];
	return section
		.split(/\r?\n/)
		.some(
			(line) =>
				invocation.test(line) &&
				constraint.required.every((argument) => argument.test(line)) &&
				(constraint.anyOf === undefined ||
					constraint.anyOf.some((argument) => argument.test(line))),
		);
}

describe('repo_map workflow producer coverage (issue #2540)', () => {
	test('comments and enum-only mentions are not workflow instructions', () => {
		const decoy = workflowSections(
			[
				'// ACTIONS:',
				'// repo_map action="symbol_search"',
				'ACTIONS:',
				'const VALID_ACTIONS = ["symbol_context"];',
			].join('\n'),
		);

		expect(
			decoy.some((section) => hasConcreteInvocation(section, 'symbol_search')),
		).toBe(false);
		expect(
			decoy.some((section) => hasConcreteInvocation(section, 'symbol_context')),
		).toBe(false);
	});

	test('an action token without bounded arguments is not a workflow instruction', () => {
		const decoy = workflowSections(
			[
				'ACTIONS:',
				'- Call `repo_map action="symbol_search"` when useful',
				'- Call `repo_map action="dead_exports"` as needed',
			].join('\n'),
		);

		expect(
			decoy.some((section) => hasConcreteInvocation(section, 'symbol_search')),
		).toBe(false);
		expect(
			decoy.some((section) => hasConcreteInvocation(section, 'dead_exports')),
		).toBe(false);
	});

	test('partial bounded argument sets are not workflow instructions', () => {
		const decoy = workflowSections(
			[
				'ACTIONS:',
				'- `repo_map action="symbol_search" symbol="<name>"`',
				'- `repo_map action="symbol_context" file="<path>" symbol="<name>" include_source=true`',
				'- `repo_map action="graph_explain" file="<path>" top_n=20`',
				'- `repo_map action="preflight_packet" files=["<path>"]`',
				'- `repo_map action="ontology"`',
				'- `repo_map action="dead_exports"`',
			].join('\n'),
		);

		for (const action of REQUIRED_ACTIONS) {
			expect(
				decoy.some((section) => hasConcreteInvocation(section, action)),
				`Partial arguments unexpectedly satisfied ${action}`,
			).toBe(false);
		}
	});

	test('every new action is a concrete, anchored workflow instruction', () => {
		const sections = workflowProducerSections();
		const missing = REQUIRED_ACTIONS.filter(
			(action) =>
				!sections.some(({ section }) => hasConcreteInvocation(section, action)),
		);

		expect(
			missing,
			`Missing concrete repo_map workflow instructions for: ${missing.join(', ')}. ` +
				'Action names in comments, enums, or unanchored prose do not satisfy this ratchet.',
		).toEqual([]);
	});

	test('bounded workflow instructions require source verification and fallback guidance', () => {
		const sections = workflowProducerSections();
		for (const action of REQUIRED_ACTIONS) {
			const owner = sections.find(({ section }) =>
				hasConcreteInvocation(section, action),
			);
			expect(owner, `No bounded producer section for ${action}`).toBeDefined();
			expect(owner?.section).toMatch(/source|provenance/i);
			expect(owner?.section).toMatch(/fallback|search|grep/i);
		}
	});

	test('actions remain advertised by the public registered repo_map tool', () => {
		const registered = TOOL_MANIFEST.repo_map();
		expect(registered).toBe(repo_map);
		expect(typeof registered.execute).toBe('function');

		for (const action of REQUIRED_ACTIONS) {
			expect(registered.description).toContain(`"${action}"`);
		}
		expect(registered.args.action).toBeDefined();
	});

	test('the registered tool executes a retained action through its fallback path', async () => {
		const directory = canonicalMkdtemp('repo-map-2540-');
		const registered = TOOL_MANIFEST.repo_map() as unknown as {
			execute: (
				args: Record<string, unknown>,
				ctx: { directory: string; sessionID: string },
			) => Promise<string>;
		};

		try {
			const output = await registered.execute(
				{ action: 'symbol_search', symbol: 'repo_map', top_n: 1 },
				{ directory, sessionID: 'repo-map-2540-acceptance' },
			);
			const result = JSON.parse(output) as {
				success: boolean;
				action: string;
				error?: string;
			};

			expect(result).toMatchObject({
				success: false,
				action: 'symbol_search',
			});
			expect(result.error).toContain('No repo graph found');
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
