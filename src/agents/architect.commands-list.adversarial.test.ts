import { describe, expect, it } from 'bun:test';
import { COMMAND_REGISTRY } from '../commands/registry';
import type { CommandEntry } from '../commands/registry.js';
import { createArchitectAgent } from './architect';

describe('buildSlashCommandsList adversarial tests', () => {
	const agent = createArchitectAgent('test-model');
	const prompt = agent.config.prompt ?? '';

	// Extract just the slash commands section from the prompt
	const slashCommandsSection = extractSlashCommandsSection(prompt);

	function extractSlashCommandsSection(text: string): string {
		// The slash commands section starts after "{{SLASH_COMMANDS}}" is replaced
		// Find the section that starts with **Session Lifecycle** and ends before
		// the next {{...}} placeholder or AGENTS section
		const start = text.indexOf('**Session Lifecycle**');
		if (start === -1) return '';
		// Find the next template placeholder or section marker
		const nextPlaceholder = text.indexOf('{{', start);
		const nextAgentsHeader = text.indexOf('## AGENTS', start);
		const endMarkers = [nextPlaceholder, nextAgentsHeader].filter(
			(x) => x !== -1,
		);
		const end = endMarkers.length > 0 ? Math.min(...endMarkers) : text.length;
		return text.slice(start, end);
	}

	// ============ 1. DEDUPLICATION TEST ============

	it('no command appears twice in the output', () => {
		// Extract all command names from the output
		const commandMatches = slashCommandsSection.matchAll(/`\/swarm ([^`]+)`/g);
		const commands: string[] = [];
		for (const match of commandMatches) {
			commands.push(match[1]);
		}

		// Check for duplicates using a frequency count
		const frequency = new Map<string, number>();
		for (const cmd of commands) {
			frequency.set(cmd, (frequency.get(cmd) ?? 0) + 1);
		}

		const duplicates: string[] = [];
		for (const [cmd, count] of frequency.entries()) {
			if (count > 1) {
				duplicates.push(`${cmd} (appears ${count} times)`);
			}
		}

		expect(
			duplicates,
			`Duplicate commands found: ${duplicates.join(', ')}`,
		).toHaveLength(0);
	});

	// ============ 2. OLD FORMAT REGRESSION TEST ============

	it('output does not end with a bare period', () => {
		// The old format was comma-separated ending with a period: "close, reset, ..."
		// New format should not end with a bare period after the last command
		const trimmed = slashCommandsSection.trim();
		const lines = trimmed.split('\n');
		const lastLine = lines[lines.length - 1]?.trim() ?? '';

		// The last line should not be just a period
		expect(lastLine).not.toBe('.');

		// Also check there's no line that looks like old format: /swarm cmd, /swarm cmd, ....
		const oldFormatPattern = /^\/swarm \w+(, \/swarm \w+)+ *\.$/m;
		expect(slashCommandsSection).not.toMatch(oldFormatPattern);
	});

	// ============ 3. EMPTY CATEGORY HEADERS TEST ============

	it('no empty category headers (every category has at least one command)', () => {
		const categoryHeaders = [
			'**Session Lifecycle**',
			'**Planning**',
			'**Execution Modes**',
			'**Observation**',
			'**Knowledge**',
			'**State Management**',
			'**Diagnostics**',
		];

		for (const header of categoryHeaders) {
			const headerIndex = slashCommandsSection.indexOf(header);
			expect(headerIndex, `Category header "${header}" not found`).not.toBe(-1);

			// Find the next category header or end of section
			const nextHeaderIndex = categoryHeaders
				.map((h) =>
					slashCommandsSection.indexOf(h, headerIndex + header.length),
				)
				.filter((idx) => idx !== -1)
				.sort((a, b) => a - b)[0];

			const sectionEnd = nextHeaderIndex ?? slashCommandsSection.length;
			const categoryContent = slashCommandsSection.slice(
				headerIndex,
				sectionEnd,
			);

			// Count command lines in this category (lines that start with "- `/swarm" or "  - `/swarm")
			const commandLines = categoryContent.match(
				/(?:^|\n)(?:- | {2}- )`\/swarm/g,
			);
			const commandCount = commandLines?.length ?? 0;

			expect(
				commandCount,
				`Category "${header}" has no commands`,
			).toBeGreaterThan(0);
		}
	});

	// ============ 4. COMMAND NAMES MATCH REGISTRY KEYS ============

	it('all command names in output match actual COMMAND_REGISTRY keys', () => {
		// Only command ENTRY lines advertise a command name; extract from those
		// (bullet-anchored, first backtick token), matching the line-prefix
		// convention used by the subcommand-duplication test below. A blanket
		// scan would also catch `/swarm ...` usage examples embedded in a
		// command's `details` prose (e.g. turbo's details reference
		// `/swarm turbo epic on`), which are documentation, not command entries.
		const invalidCommands: string[] = [];

		for (const line of slashCommandsSection.split('\n')) {
			const entryMatch = line.match(/^\s*-\s+`\/swarm ([^`]+)`/);
			if (!entryMatch) continue;
			const cmdName = entryMatch[1];

			// Check if this command exists in COMMAND_REGISTRY
			if (!Object.hasOwn(COMMAND_REGISTRY, cmdName)) {
				invalidCommands.push(cmdName);
			}
		}

		expect(
			invalidCommands,
			`Commands in output not found in COMMAND_REGISTRY: ${invalidCommands.join(', ')}`,
		).toHaveLength(0);
	});

	// ============ 5. MARKDOWN INJECTION TEST ============

	it('description text does not contain unescaped HTML/markdown injection', () => {
		// Look for raw HTML tags that could be injection vectors
		// These should be escaped or the markdown renderer should handle them safely
		const dangerousPatterns = [
			/<script/i,
			/<iframe/i,
			/<object/i,
			/<embed/i,
			/<link/i,
			/<style/i,
			/on\w+=/i, // onclick, onerror, etc.
		];

		// Extract all description text (after "— " following command entries)
		const descriptionMatches = slashCommandsSection.matchAll(/— ([^\n]+)/g);
		const descriptions = [...descriptionMatches].map(
			(m: RegExpExecArray) => m[1],
		);

		for (const desc of descriptions) {
			for (const pattern of dangerousPatterns) {
				expect(
					desc,
					`Potential HTML injection in description: "${desc}" matches ${pattern}`,
				).not.toMatch(pattern);
			}
		}
	});

	// ============ 6. SUBCOMMAND DUPLICATION TEST ============

	it('subcommands do not appear as both parent-level and subcommand-level entries', () => {
		// Build set of subcommands from registry
		const subcommands = new Set<string>();
		for (const [cmdName, cmdEntry] of Object.entries(COMMAND_REGISTRY)) {
			if ((cmdEntry as CommandEntry).subcommandOf) {
				subcommands.add(cmdName);
			}
		}

		// Find subcommands that appear at parent level (not indented)
		// Parent-level entries have format: "- `/swarm X` — description"
		// Subcommand entries have format: "  - `/swarm X` — description"
		const lines = slashCommandsSection.split('\n');

		const parentLevelCommands = new Set<string>();
		const subcommandLevelCommands = new Set<string>();

		let _isInSubcommandBlock = false;
		for (const line of lines) {
			const trimmed = line.trim();

			// Track indentation state
			if (trimmed.startsWith('- `/swarm') && line.startsWith('  ')) {
				// Subcommand-level command (indented)
				const match = trimmed.match(/`\/swarm ([^`]+)`/);
				if (match) {
					subcommandLevelCommands.add(match[1]);
					_isInSubcommandBlock = true;
				}
			} else if (trimmed.startsWith('- `/swarm')) {
				// Parent-level command
				const match = trimmed.match(/`\/swarm ([^`]+)`/);
				if (match) {
					parentLevelCommands.add(match[1]);
				}
				_isInSubcommandBlock = false;
			} else if (trimmed.startsWith('**') && trimmed.endsWith('**')) {
				// New category header
				_isInSubcommandBlock = false;
			} else if (!trimmed.startsWith('-') && !trimmed.startsWith('`/swarm')) {
				_isInSubcommandBlock = false;
			}
		}

		// A command should not appear at both parent and subcommand levels
		// (this would indicate it's being shown as a main entry AND as a subcommand under another)
		const appearingAtBothLevels: string[] = [];
		for (const sub of subcommands) {
			if (parentLevelCommands.has(sub) && subcommandLevelCommands.has(sub)) {
				appearingAtBothLevels.push(sub);
			}
		}

		expect(
			appearingAtBothLevels,
			`Subcommands appearing at both parent and subcommand levels: ${appearingAtBothLevels.join(', ')}`,
		).toHaveLength(0);
	});

	// ============ 7. TOKEN BUDGET TEST ============

	it('output does not exceed 200 lines', () => {
		const lineCount = slashCommandsSection.split('\n').length;
		expect(
			lineCount,
			`Slash commands section has ${lineCount} lines, exceeds 200 line budget`,
		).toBeLessThanOrEqual(200);
	});
});
