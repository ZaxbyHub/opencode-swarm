import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolvePrompt } from './_prompt-helpers.js';

// Read the source file directly since prompts are not individually exported
const EXPLORER_SOURCE = readFileSync(
	resolve(import.meta.dir, '../../src/agents/explorer.ts'),
	'utf-8',
);

// Extract a prompt block from the source by name (closing backtick-semicolon anchor).
function extractPromptBlock(source: string, promptName: string): string {
	const regex = new RegExp(
		`export\\s+const\\s+${promptName}\\s*=\\s*\x60([\\s\\S]*?)\x60;`,
		'm',
	);
	const match = source.match(regex);
	return match ? match[1] : '';
}

const EXPLORER_PROMPT = extractPromptBlock(EXPLORER_SOURCE, 'EXPLORER_PROMPT');
const CURATOR_INIT_PROMPT = extractPromptBlock(
	EXPLORER_SOURCE,
	'CURATOR_INIT_PROMPT',
);
const CURATOR_PHASE_PROMPT = extractPromptBlock(
	EXPLORER_SOURCE,
	'CURATOR_PHASE_PROMPT',
);

// Extract a section from the OUTPUT FORMAT portion of EXPLORER_PROMPT
function extractOutputSection(sectionName: string): string | null {
	const outputFormatStart = EXPLORER_PROMPT.indexOf('OUTPUT FORMAT (MANDATORY');
	const integrationImpactStart = EXPLORER_PROMPT.indexOf(
		'## INTEGRATION IMPACT ANALYSIS MODE',
	);
	const documentationModeStart = EXPLORER_PROMPT.indexOf(
		'## DOCUMENTATION DISCOVERY MODE',
	);

	// Determine which section we're in based on the section name
	if (
		sectionName === 'BREAKING_CHANGES' ||
		sectionName === 'COMPATIBLE_CHANGES' ||
		sectionName === 'CONSUMERS_AFFECTED' ||
		sectionName === 'COMPATIBILITY SIGNALS' ||
		sectionName === 'MIGRATION_SURFACE'
	) {
		// Integration impact mode section
		const integrationSection = EXPLORER_PROMPT.substring(
			integrationImpactStart,
			documentationModeStart > 0 ? documentationModeStart : undefined,
		);
		const match = integrationSection.match(
			new RegExp(`${sectionName}:\\s*\\[(.*?)\\]`, 'i'),
		);
		return match ? match[0] : null;
	}

	// Main output format sections
	const mainOutput = EXPLORER_PROMPT.substring(
		outputFormatStart,
		integrationImpactStart > 0 ? integrationImpactStart : undefined,
	);
	const match = mainOutput.match(
		new RegExp(`${sectionName}:\\s*(.*?)(?=\\n\\S|$)`, 'i'),
	);
	return match ? match[0] : null;
}

describe('EXPLORER_PROMPT Consumer Contract — Output Sections', () => {
	describe('Required sections in standard OUTPUT FORMAT', () => {
		test('COMPLEXITY INDICATORS section exists and has format "COMPLEXITY INDICATORS:"', () => {
			const section = extractOutputSection('COMPLEXITY INDICATORS');
			expect(section).not.toBeNull();
			expect(section).toMatch(/^COMPLEXITY INDICATORS:/i);
		});

		test('FOLLOW-UP CANDIDATE AREAS section exists and has format "FOLLOW-UP CANDIDATE AREAS:"', () => {
			const section = extractOutputSection('FOLLOW-UP CANDIDATE AREAS');
			expect(section).not.toBeNull();
			expect(section).toMatch(/^FOLLOW-UP CANDIDATE AREAS:/i);
		});

		test('DOMAINS section exists and has format "DOMAINS:"', () => {
			const section = extractOutputSection('DOMAINS');
			expect(section).not.toBeNull();
			expect(section).toMatch(/^DOMAINS:/i);
		});

		test('CONSUMERS_AFFECTED section exists in OUTPUT FORMAT', () => {
			const section = extractOutputSection('CONSUMERS_AFFECTED');
			expect(section).not.toBeNull();
			expect(section).toMatch(/^CONSUMERS_AFFECTED:/i);
		});

		test('COMPATIBILITY SIGNALS appears in integration impact mode (not main OUTPUT FORMAT)', () => {
			// COMPATIBILITY SIGNALS is in the integration impact mode section, not the main output format
			// This test verifies the section exists at all
			const integrationSection = EXPLORER_PROMPT.substring(
				EXPLORER_PROMPT.indexOf('## INTEGRATION IMPACT ANALYSIS MODE'),
			);
			expect(integrationSection).toContain('COMPATIBILITY SIGNALS:');
		});
	});

	describe('FOLLOW-UP CANDIDATE AREAS format verification', () => {
		test('FOLLOW-UP CANDIDATE AREAS section includes example format with path and domain', () => {
			// The section should show: - [path]: [observable condition, relevant domain]
			const followUpSection = EXPLORER_PROMPT.substring(
				EXPLORER_PROMPT.indexOf('FOLLOW-UP CANDIDATE AREAS:'),
			).split('## ')[0];
			expect(followUpSection).toContain('[path]:');
			expect(followUpSection).toContain(
				'[observable condition, relevant domain]',
			);
		});
	});

	describe('DOMAINS format verification', () => {
		test('DOMAINS section shows example format with SME domains', () => {
			// DOMAINS section spans multiple lines, look at the whole section
			const domainsFull = EXPLORER_PROMPT.substring(
				EXPLORER_PROMPT.indexOf('DOMAINS:'),
			).split('## ')[0];
			// Should show something like: DOMAINS: [relevant SME domains: powershell, security, python, etc.]
			expect(domainsFull).toContain('DOMAINS:');
			expect(domainsFull).toMatch(/Example:/i); // "Example:" appears on next line
		});
	});

	describe('CONSUMERS_AFFECTED format in integration impact mode', () => {
		test('CONSUMERS_AFFECTED in integration impact shows example with file paths', () => {
			const integrationSection = EXPLORER_PROMPT.substring(
				EXPLORER_PROMPT.indexOf('## INTEGRATION IMPACT ANALYSIS MODE'),
			);
			const consumersSection = integrationSection.substring(
				integrationSection.indexOf('CONSUMERS_AFFECTED:'),
				integrationSection.indexOf('COMPATIBILITY SIGNALS:'),
			);
			expect(consumersSection).toContain('src/agents/coder.ts');
			expect(consumersSection).toContain('src/agents/reviewer.ts');
		});
	});
});

describe('CURATOR_INIT_PROMPT Consumer Contract', () => {
	describe('Output format sections', () => {
		test('contains BRIEFING: section', () => {
			expect(CURATOR_INIT_PROMPT).toContain('BRIEFING:');
		});

		test('contains CONTRADICTIONS: section', () => {
			expect(CURATOR_INIT_PROMPT).toContain('CONTRADICTIONS:');
		});

		test('contains OBSERVATIONS: section', () => {
			expect(CURATOR_INIT_PROMPT).toContain('OBSERVATIONS:');
		});

		test('contains KNOWLEDGE_STATS: section', () => {
			expect(CURATOR_INIT_PROMPT).toContain('KNOWLEDGE_STATS:');
		});
	});

	describe('OBSERVATIONS format verification', () => {
		test('OBSERVATIONS uses observational language patterns', () => {
			const obsSection =
				CURATOR_INIT_PROMPT.split('OBSERVATIONS:')[1]?.split(
					'KNOWLEDGE_STATS:',
				)[0] ?? '';
			// Should use "appears" observational language, not imperative
			expect(obsSection).toContain('appears high-confidence');
			expect(obsSection).toContain('appears stale');
			expect(obsSection).toContain('could be tighter');
			expect(obsSection).toContain('contradicts project state');
			expect(obsSection).toContain('new candidate:');
		});

		test('OBSERVATIONS references entries by UUID format', () => {
			const obsSection =
				CURATOR_INIT_PROMPT.split('OBSERVATIONS:')[1]?.split(
					'KNOWLEDGE_STATS:',
				)[0] ?? '';
			expect(obsSection).toContain('entry <uuid>');
		});
	});

	describe('Curator role identity', () => {
		test('IDENTITY declares CURATOR_INIT mode', () => {
			expect(CURATOR_INIT_PROMPT).toContain('CURATOR_INIT mode');
		});

		test('INPUT FORMAT expects TASK: CURATOR_INIT', () => {
			expect(CURATOR_INIT_PROMPT).toContain('TASK: CURATOR_INIT');
		});

		test('RULES mention output under 2000 chars', () => {
			expect(CURATOR_INIT_PROMPT).toContain('Output under 2000 chars');
		});
	});
});

describe('CURATOR_PHASE_PROMPT Consumer Contract', () => {
	describe('Output format sections', () => {
		test('contains PHASE_DIGEST: section', () => {
			expect(CURATOR_PHASE_PROMPT).toContain('PHASE_DIGEST:');
		});

		test('contains COMPLIANCE: section', () => {
			expect(CURATOR_PHASE_PROMPT).toContain('COMPLIANCE:');
		});

		test('contains OBSERVATIONS: section', () => {
			expect(CURATOR_PHASE_PROMPT).toContain('OBSERVATIONS:');
		});

		test('contains EXTENDED_DIGEST: section', () => {
			expect(CURATOR_PHASE_PROMPT).toContain('EXTENDED_DIGEST:');
		});
	});

	describe('PHASE_DIGEST format verification', () => {
		test('PHASE_DIGEST includes expected sub-fields', () => {
			const digestSection =
				CURATOR_PHASE_PROMPT.split('PHASE_DIGEST:')[1]?.split(
					'COMPLIANCE:',
				)[0] ?? '';
			expect(digestSection).toContain('phase:');
			expect(digestSection).toContain('summary:');
			expect(digestSection).toContain('agents_used:');
			expect(digestSection).toContain('tasks_completed:');
			expect(digestSection).toContain('key_decisions:');
			expect(digestSection).toContain('blockers_resolved:');
		});
	});

	describe('OBSERVATIONS format verification', () => {
		test('OBSERVATIONS uses observational language patterns', () => {
			const obsSection =
				CURATOR_PHASE_PROMPT.split('OBSERVATIONS:')[1]?.split(
					'EXTENDED_DIGEST:',
				)[0] ?? '';
			expect(obsSection).toContain('appears high-confidence');
			expect(obsSection).toContain('appears stale');
			expect(obsSection).toContain('could be tighter');
			expect(obsSection).toContain('contradicts project state');
			expect(obsSection).toContain('new candidate:');
		});

		test('OBSERVATIONS references entries by UUID format', () => {
			const obsSection =
				CURATOR_PHASE_PROMPT.split('OBSERVATIONS:')[1]?.split(
					'EXTENDED_DIGEST:',
				)[0] ?? '';
			expect(obsSection).toContain('entry <uuid>');
		});
	});

	describe('COMPLIANCE format verification', () => {
		test('COMPLIANCE section uses observational "observed" language', () => {
			const complianceSection =
				CURATOR_PHASE_PROMPT.split('COMPLIANCE:')[1]?.split(
					'OBSERVATIONS:',
				)[0] ?? '';
			expect(complianceSection).toContain('observed');
		});
	});

	describe('Curator role identity', () => {
		test('IDENTITY declares CURATOR_PHASE mode', () => {
			expect(CURATOR_PHASE_PROMPT).toContain('CURATOR_PHASE mode');
		});

		test('INPUT FORMAT expects TASK: CURATOR_PHASE [phase_number]', () => {
			expect(CURATOR_PHASE_PROMPT).toContain(
				'TASK: CURATOR_PHASE [phase_number]',
			);
		});

		test('RULES mention output under 2000 chars', () => {
			expect(CURATOR_PHASE_PROMPT).toContain('Output under 2000 chars');
		});

		test('RULES specify "Extend the digest, never replace it"', () => {
			expect(CURATOR_PHASE_PROMPT).toContain(
				'Extend the digest, never replace it',
			);
		});
	});
});

describe('INTEGRATION IMPACT MODE Output Format Contract', () => {
	const INTEGRATION_START = EXPLORER_PROMPT.indexOf(
		'## INTEGRATION IMPACT ANALYSIS MODE',
	);
	const DOCUMENTATION_START = EXPLORER_PROMPT.indexOf(
		'## DOCUMENTATION DISCOVERY MODE',
	);
	const integrationSection = EXPLORER_PROMPT.substring(
		INTEGRATION_START,
		DOCUMENTATION_START > 0 ? DOCUMENTATION_START : undefined,
	);

	describe('Required output sections', () => {
		test('BREAKING_CHANGES section exists', () => {
			expect(integrationSection).toContain('BREAKING_CHANGES:');
		});

		test('COMPATIBLE_CHANGES section exists', () => {
			expect(integrationSection).toContain('COMPATIBLE_CHANGES:');
		});

		test('CONSUMERS_AFFECTED section exists', () => {
			expect(integrationSection).toContain('CONSUMERS_AFFECTED:');
		});

		test('COMPATIBILITY SIGNALS section exists', () => {
			expect(integrationSection).toContain('COMPATIBILITY SIGNALS:');
		});

		test('MIGRATION_SURFACE section exists', () => {
			expect(integrationSection).toContain('MIGRATION_SURFACE:');
		});
	});

	describe('BREAKING_CHANGES format', () => {
		test('BREAKING_CHANGES shows example with file path and description', () => {
			// Example is on the next line after BREAKING_CHANGES:
			const breakingSection =
				integrationSection.split('BREAKING_CHANGES:')[1] ?? '';
			expect(breakingSection).toContain('src/agents/explorer.ts');
			expect(breakingSection).toContain('Example:');
		});
	});

	describe('COMPATIBLE_CHANGES format', () => {
		test('COMPATIBLE_CHANGES shows example with file path and description', () => {
			// Example is on the next line after COMPATIBLE_CHANGES:
			const compatibleSection =
				integrationSection.split('COMPATIBLE_CHANGES:')[1] ?? '';
			expect(compatibleSection).toContain('src/config/constants.ts');
			expect(compatibleSection).toContain('Example:');
		});
	});

	describe('COMPATIBILITY SIGNALS format', () => {
		test('COMPATIBILITY SIGNALS shows expected values: COMPATIBLE | INCOMPATIBLE | UNCERTAIN', () => {
			// Values are on the same line as the section header
			const signalsSection =
				integrationSection.split('COMPATIBILITY SIGNALS:')[1] ?? '';
			expect(signalsSection).toContain('COMPATIBLE');
			expect(signalsSection).toContain('INCOMPATIBLE');
			expect(signalsSection).toContain('UNCERTAIN');
		});

		test('COMPATIBILITY SIGNALS shows example with INCOMPATIBLE verdict and reason', () => {
			// Example is on the next line after COMPATIBILITY SIGNALS:
			const signalsSection =
				integrationSection.split('COMPATIBILITY SIGNALS:')[1] ?? '';
			expect(signalsSection).toContain('INCOMPATIBLE');
			expect(signalsSection).toContain('Example:');
			expect(signalsSection).toContain('removeExport');
		});
	});

	describe('MIGRATION_SURFACE format', () => {
		test('MIGRATION_SURFACE shows "yes" or "no" format', () => {
			// The section header line contains [yes | no]
			const migrationSection =
				integrationSection.split('MIGRATION_SURFACE:')[1] ?? '';
			expect(migrationSection).toMatch(/yes|no/);
		});

		test('MIGRATION_SURFACE shows example with before/after signature when yes', () => {
			// Example is on the next line with → arrow
			const migrationSection =
				integrationSection.split('MIGRATION_SURFACE:')[1] ?? '';
			expect(migrationSection).toContain('yes —');
			expect(migrationSection).toContain('→');
		});
	});

	describe('Integration impact activation', () => {
		test('Section is activated by "Integration impact analysis" or INPUT lists contract changes', () => {
			expect(integrationSection).toContain('Integration impact analysis');
			expect(integrationSection).toContain('INPUT: List of contract changes');
		});
	});
});

describe('DOCUMENTATION DISCOVERY MODE Output Format Contract', () => {
	const DOC_START = EXPLORER_PROMPT.indexOf('## DOCUMENTATION DISCOVERY MODE');
	const docSection = DOC_START > 0 ? EXPLORER_PROMPT.substring(DOC_START) : '';

	describe('Manifest output format', () => {
		test('manifest uses schema_version 1', () => {
			expect(docSection).toContain('schema_version": 1');
		});

		test('manifest uses ISO timestamp format for scanned_at', () => {
			expect(docSection).toContain('scanned_at": "ISO timestamp"');
		});

		test('manifest files array structure defined', () => {
			// The files array is shown in the JSON example: "files": [...]
			expect(docSection).toContain('"files"');
			expect(docSection).toContain('[...]');
		});
	});

	describe('Document entry fields', () => {
		test('Each doc entry includes path, title, summary, lines, mtime', () => {
			expect(docSection).toContain('path: relative to project root');
			expect(docSection).toContain('title: first # heading');
			expect(docSection).toContain('summary: first non-empty paragraph');
			expect(docSection).toContain('lines: total line count');
			expect(docSection).toContain('mtime: file modification timestamp');
		});
	});

	describe('Constraints output format', () => {
		test('Constraints written to .swarm/knowledge/doc-constraints.jsonl', () => {
			expect(docSection).toContain('.swarm/knowledge/doc-constraints.jsonl');
		});

		test('Constraints have source: "doc-scan" and category: "architecture"', () => {
			expect(docSection).toContain('source: "doc-scan"');
			expect(docSection).toContain('category: "architecture"');
		});

		test('Each doc yields up to 5 actionable constraints (max 200 chars each)', () => {
			expect(docSection).toContain('up to 5 actionable constraints per doc');
			expect(docSection).toContain('max 200 chars');
		});
	});

	describe('Invalidation rule', () => {
		test('Only re-scan if any doc file mtime is newer than manifest scanned_at', () => {
			expect(docSection).toContain('mtime is newer than the manifest');
			expect(docSection).toContain('Otherwise reuse the cached manifest');
		});
	});

	describe('Rules verification', () => {
		test('manifest must be small (<100 lines) — pointers only', () => {
			expect(docSection).toContain('<100 lines');
			expect(docSection).toContain('Pointers only, not full content');
		});

		test('Do NOT rephrase or summarize — use actual text from file', () => {
			expect(docSection).toContain('NOT rephrase or summarize');
			expect(docSection).toContain('use the actual text');
		});
	});

	describe('Discovery targets', () => {
		test('Root documentation files specified', () => {
			expect(docSection).toContain('README.md');
			expect(docSection).toContain('CONTRIBUTING.md');
			expect(docSection).toContain('CHANGELOG.md');
		});

		test('docs/**/*.md and doc/**/*.md specified', () => {
			expect(docSection).toContain('docs/**/*.md');
			expect(docSection).toContain('doc/**/*.md');
		});
	});
});

describe('createExplorerAgent factory function contract', () => {
	test('createExplorerAgent is exported from explorer.ts', () => {
		expect(EXPLORER_SOURCE).toMatch(/export\s+function\s+createExplorerAgent/);
	});

	test('createExplorerAgent accepts model, customPrompt?, customAppendPrompt?', () => {
		const fnMatch = EXPLORER_SOURCE.match(
			/export\s+function\s+createExplorerAgent\s*\(\s*model:\s*string,\s*customPrompt\?:\s*string,\s*customAppendPrompt\?:\s*string/,
		);
		expect(fnMatch).not.toBeNull();
	});

	test('createExplorerAgent returns AgentDefinition with name "explorer"', () => {
		const returnMatch = EXPLORER_SOURCE.match(/name:\s*'explorer'/);
		expect(returnMatch).not.toBeNull();
	});

	test('createExplorerAgent sets tools.write, tools.edit, tools.patch to false (read-only)', () => {
		expect(EXPLORER_SOURCE).toContain('write: false');
		expect(EXPLORER_SOURCE).toContain('edit: false');
		expect(EXPLORER_SOURCE).toContain('patch: false');
	});

	test('createExplorerAgent supports customAppendPrompt to extend default prompt', () => {
		// Verify the append logic exists - customAppendPrompt is used to extend the prompt
		expect(EXPLORER_SOURCE).toContain('customAppendPrompt');
		// resolvePrompt(prompt, customPrompt, customAppendPrompt) encapsulates the
		// append logic: when customAppendPrompt is set, it appends to the base prompt
		expect(EXPLORER_SOURCE).toContain(
			'resolvePrompt(prompt, customPrompt, customAppendPrompt)',
		);

		// Behavioral check — verify the helper composes correctly
		expect(resolvePrompt('base', 'custom', 'append')).toBe('custom');
		expect(resolvePrompt('base', 'custom', '')).toBe('custom');
		expect(resolvePrompt('base', '', 'append')).toBe('base\n\nappend');
		expect(resolvePrompt('base', '', '')).toBe('base');
	});
});
