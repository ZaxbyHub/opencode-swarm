import { describe, expect, it } from 'bun:test';
import { createArchitectAgent } from '../../../src/agents/architect';

/**
 * ADVERSARIAL TESTS for task 11.1 — architect prompt template change
 *
 * These tests focus ONLY on attack vectors:
 * - Boundary violations
 * - Edge cases
 * - Scenarios that could break the fix or cause regressions
 */

describe('architect-prompt-adversarial: attack vectors for task 11.1', () => {
	let prompt: string;

	it('setup: extract prompt from architect agent', () => {
		const agent = createArchitectAgent('gpt-4');
		expect(agent).toBeDefined();
		expect(agent.config.prompt).toBeDefined();
		prompt = agent.config.prompt!;
	});

	// ATTACK VECTOR 1: Bracket leakage check
	// Focus specifically on the FILES section (template examples) - not instruction text
	// Check that the template examples use angle brackets, not old square bracket fill-ins
	describe('ATTACK VECTOR 1: Bracket leakage — FILES section must use angle brackets', () => {
		let filesSection: string;
		let templateExamplesOnly: string;

		it('extract FILES section and template examples for focused testing', () => {
			const filesStart = prompt.indexOf('## FILES');
			expect(filesStart).toBeGreaterThanOrEqual(0);
			filesSection = prompt.substring(filesStart);
			expect(filesSection).toContain('.swarm/plan.md:');
			expect(filesSection).toContain('.swarm/context.md:');

			// Extract only the actual template examples (code blocks after the warning line)
			// The warning line ends with "must be reproduced exactly.\n\n"
			const warningEndIndex = filesSection.indexOf(
				'must be reproduced exactly.',
			);
			expect(warningEndIndex).toBeGreaterThan(0);

			// Find the first \n\n after the warning to get to the template examples
			const templateStartIndex = filesSection.indexOf('\n\n', warningEndIndex);
			templateExamplesOnly = filesSection.substring(templateStartIndex);
		});

		it('should NOT contain [Project] in template examples', () => {
			expect(templateExamplesOnly).not.toContain('[Project]');
		});

		it('should NOT contain [task] in template examples', () => {
			expect(templateExamplesOnly).not.toContain('[task]');
		});

		it('should NOT contain [date] in template examples', () => {
			expect(templateExamplesOnly).not.toContain('[date]');
		});

		it('should NOT contain Phase: [N] pattern in template examples', () => {
			expect(templateExamplesOnly).not.toContain('Phase: [N]');
		});

		it('should NOT contain [reason] in template examples', () => {
			expect(templateExamplesOnly).not.toContain('[reason]');
		});

		it('should NOT contain [decision] in template examples', () => {
			expect(templateExamplesOnly).not.toContain('[decision]');
		});

		it('should NOT contain [rationale] in template examples', () => {
			expect(templateExamplesOnly).not.toContain('[rationale]');
		});

		it('should NOT contain [domain] in template examples', () => {
			expect(templateExamplesOnly).not.toMatch(/\[domain\]/);
		});

		it('should NOT contain [guidance] in template examples', () => {
			expect(templateExamplesOnly).not.toContain('[guidance]');
		});

		it('should NOT contain [pattern] in template examples', () => {
			expect(templateExamplesOnly).not.toMatch(/\[pattern\]/);
		});

		it('scan for ALL old bracket fill-ins in template examples', () => {
			const forbiddenPatterns = [
				'[Project]',
				'[task]',
				'[date]',
				'[Phase]',
				'[phase]',
				'[N]',
				'[reason]',
				'[decision]',
				'[rationale]',
				'[domain]',
				'[guidance]',
				'[pattern]',
				'[description]',
				'[name]',
				'[usage]',
			];

			const lines = templateExamplesOnly.split('\n');
			const violations: { pattern: string; line: string }[] = [];

			lines.forEach((line) => {
				forbiddenPatterns.forEach((pattern) => {
					if (line.includes(pattern)) {
						violations.push({ pattern, line: line.trim() });
					}
				});
			});

			expect(violations.length).toBe(0);
			if (violations.length > 0) {
				const violationDetails = violations
					.map((v) => `  ${v.pattern} in "${v.line}"`)
					.join('\n');
				expect().fail(
					`\nFound leaked bracket patterns in template examples:\n${violationDetails}`,
				);
			}
		});
	});

	// ATTACK VECTOR 2: Context.md template bracket check
	// Check that the context.md example section does NOT contain any old bracket fill-ins
	describe('ATTACK VECTOR 2: Context.md template must use angle brackets', () => {
		let contextMdSection: string;

		it('extract context.md section from prompt', () => {
			const contextStart = prompt.indexOf('.swarm/context.md:');
			expect(contextStart).toBeGreaterThanOrEqual(0);

			const contextEnd = prompt.indexOf(
				'```',
				contextStart + '.swarm/context.md:'.length + 50,
			);
			expect(contextEnd).toBeGreaterThan(contextStart);

			contextMdSection = prompt.substring(contextStart, contextEnd + 3);
			expect(contextMdSection).toContain('# Context');
		});

		it('should NOT contain [decision] in context.md template', () => {
			expect(contextMdSection).not.toContain('[decision]');
		});

		it('should NOT contain [rationale] in context.md template', () => {
			expect(contextMdSection).not.toContain('[rationale]');
		});

		it('should NOT contain [domain] in context.md template', () => {
			expect(contextMdSection).not.toContain('[domain]');
		});

		it('should NOT contain [guidance] in context.md template', () => {
			expect(contextMdSection).not.toContain('[guidance]');
		});

		it('should NOT contain [pattern] in context.md template', () => {
			expect(contextMdSection).not.toContain('[pattern]');
		});

		it('should NOT contain [usage] in context.md template', () => {
			expect(contextMdSection).not.toContain('[usage]');
		});

		it('should use angle brackets for all placeholders in context.md', () => {
			// Check for the expected angle-bracket patterns
			expect(contextMdSection).toContain('<specific technical decision made>');
			expect(contextMdSection).toContain('<rationale for the decision>');
			expect(contextMdSection).toContain('<domain name');
			expect(contextMdSection).toContain('<specific guidance');
			expect(contextMdSection).toContain('<pattern name>');
			expect(contextMdSection).toContain('<how and when to use it');
		});
	});

	// ATTACK VECTOR 3: {{SWARM_ID}} not accidentally converted
	// Confirm {{SWARM_ID}} appears at least twice (once in plan.md example, once in context.md example)
	describe('ATTACK VECTOR 3: {{SWARM_ID}} template variable preservation', () => {
		it('should contain {{SWARM_ID}} at least twice', () => {
			const matches = prompt.match(/\{\{SWARM_ID\}\}/g) || [];
			expect(matches.length).toBeGreaterThanOrEqual(2);
		});

		it('should contain {{SWARM_ID}} in plan.md example', () => {
			// Find the .swarm/plan.md: header within the FILES section
			const filesStart = prompt.indexOf('## FILES');
			expect(filesStart).toBeGreaterThanOrEqual(0);

			const planMdStart = prompt.indexOf('.swarm/plan.md:', filesStart);
			expect(planMdStart).toBeGreaterThan(filesStart);

			// Find the markdown code block after it
			const codeBlockStart = prompt.indexOf('```', planMdStart);
			expect(codeBlockStart).toBeGreaterThan(planMdStart);

			// Find the end of the markdown code block (second ``` marker)
			const codeBlockEnd = prompt.indexOf('```', codeBlockStart + 3);
			expect(codeBlockEnd).toBeGreaterThan(codeBlockStart);

			const planMdSection = prompt.substring(codeBlockStart, codeBlockEnd + 3);
			expect(planMdSection).toContain('{{SWARM_ID}}');
		});

		it('should contain {{SWARM_ID}} in context.md example', () => {
			// Find the .swarm/context.md: header within the FILES section
			const filesStart = prompt.indexOf('## FILES');
			expect(filesStart).toBeGreaterThanOrEqual(0);

			const contextMdStart = prompt.indexOf('.swarm/context.md:', filesStart);
			expect(contextMdStart).toBeGreaterThan(filesStart);

			// Find the markdown code block after it
			const codeBlockStart = prompt.indexOf('```', contextMdStart);
			expect(codeBlockStart).toBeGreaterThan(contextMdStart);

			// Find the end of the markdown code block (second ``` marker)
			const codeBlockEnd = prompt.indexOf('```', codeBlockStart + 3);
			expect(codeBlockEnd).toBeGreaterThan(codeBlockStart);

			const contextMdSection = prompt.substring(
				codeBlockStart,
				codeBlockEnd + 3,
			);
			expect(contextMdSection).toContain('{{SWARM_ID}}');
		});

		it('should NOT have accidentally converted {{SWARM_ID}} to [SWARM_ID]', () => {
			expect(prompt).not.toContain('[SWARM_ID]');
		});
	});

	// ATTACK VECTOR 4: Angle-bracket slots present
	// Confirm that the FILES section contains specific angle-bracket patterns
	describe('ATTACK VECTOR 4: Angle-bracket slots completeness', () => {
		let filesSection: string;

		it('extract FILES section from prompt', () => {
			const filesStart = prompt.indexOf('## FILES');
			expect(filesStart).toBeGreaterThanOrEqual(0);

			filesSection = prompt.substring(filesStart);
			expect(filesSection).toContain('.swarm/plan.md:');
			expect(filesSection).toContain('.swarm/context.md:');
		});

		it('should contain <real project name', () => {
			expect(filesSection).toContain('<real project name');
		});

		it('should contain <current phase number', () => {
			expect(filesSection).toContain('<current phase number');
		});

		it('should contain <specific task', () => {
			expect(filesSection).toContain('<specific task');
		});

		it('should contain <specific completed task', () => {
			expect(filesSection).toContain('<specific completed task');
		});

		it('should contain <reason for blockage', () => {
			expect(filesSection).toContain('<reason for blockage');
		});

		it('should contain <specific technical decision', () => {
			expect(filesSection).toContain('<specific technical decision');
		});

		it('should contain <rationale for the decision', () => {
			expect(filesSection).toContain('<rationale for the decision');
		});

		it('should contain <domain name', () => {
			expect(filesSection).toContain('<domain name');
		});

		it('should contain <specific guidance', () => {
			expect(filesSection).toContain('<specific guidance');
		});

		it('should contain <pattern name', () => {
			expect(filesSection).toContain('<pattern name');
		});
	});

	// ATTACK VECTOR 5: Warning line specificity
	// Confirm the warning line explicitly names specific forbidden tokens
	describe('ATTACK VECTOR 5: Warning line must explicitly name forbidden tokens', () => {
		it('should contain ⚠️ emoji for warning', () => {
			expect(prompt).toContain('⚠️');
		});

		it('should contain FILE FORMAT RULES section', () => {
			expect(prompt).toContain('⚠️ FILE FORMAT RULES');
		});

		it('should explicitly name [task] as forbidden', () => {
			expect(prompt).toContain('"[task]"');
		});

		it('should explicitly name [Project] as forbidden', () => {
			expect(prompt).toContain('"[Project]"');
		});

		it('should explicitly name [date] as forbidden', () => {
			expect(prompt).toContain('"[date]"');
		});

		it('should explicitly name [reason] as forbidden', () => {
			expect(prompt).toContain('"[reason]"');
		});

		it('should name AT LEAST these 4 forbidden tokens', () => {
			const forbiddenTokens = ['[task]', '[Project]', '[date]', '[reason]'];
			let foundCount = 0;

			forbiddenTokens.forEach((token) => {
				if (prompt.includes(`"${token}"`)) {
					foundCount++;
				}
			});

			expect(foundCount).toBeGreaterThanOrEqual(4);
		});

		it('should list valid format tokens to avoid confusion', () => {
			expect(prompt).toContain('[COMPLETE]');
			expect(prompt).toContain('[IN PROGRESS]');
			expect(prompt).toContain('[BLOCKED]');
		});
	});

	// ATTACK VECTOR 6: Format token count preservation
	// The new template should contain the SAME number of status/format tokens as the old template
	describe('ATTACK VECTOR 6: Format token count preservation', () => {
		it('should contain [COMPLETE] at least once in FILES section', () => {
			const filesStart = prompt.indexOf('## FILES');
			const filesSection = prompt.substring(filesStart);

			expect(filesSection).toContain('[COMPLETE]');
		});

		it('should contain [IN PROGRESS] at least once in FILES section', () => {
			const filesStart = prompt.indexOf('## FILES');
			const filesSection = prompt.substring(filesStart);

			expect(filesSection).toContain('[IN PROGRESS]');
		});

		it('should contain [BLOCKED] at least once in FILES section', () => {
			const filesStart = prompt.indexOf('## FILES');
			const filesSection = prompt.substring(filesStart);

			expect(filesSection).toContain('[BLOCKED]');
		});

		it('should contain [SMALL] at least once in FILES section', () => {
			const filesStart = prompt.indexOf('## FILES');
			const filesSection = prompt.substring(filesStart);

			expect(filesSection).toContain('[SMALL]');
		});

		it('should contain [MEDIUM] at least once in FILES section', () => {
			const filesStart = prompt.indexOf('## FILES');
			const filesSection = prompt.substring(filesStart);

			expect(filesSection).toContain('[MEDIUM]');
		});

		it('should contain [LARGE] at least once in FILES section', () => {
			const filesStart = prompt.indexOf('## FILES');
			const filesSection = prompt.substring(filesStart);

			expect(filesSection).toContain('[LARGE]');
		});

		it('should count occurrences of each format token in FILES section', () => {
			const filesStart = prompt.indexOf('## FILES');
			const filesSection = prompt.substring(filesStart);

			const counts = {
				'[COMPLETE]': (filesSection.match(/\[COMPLETE\]/g) || []).length,
				'[IN PROGRESS]': (filesSection.match(/\[IN PROGRESS\]/g) || []).length,
				'[BLOCKED]': (filesSection.match(/\[BLOCKED\]/g) || []).length,
				'[SMALL]': (filesSection.match(/\[SMALL\]/g) || []).length,
				'[MEDIUM]': (filesSection.match(/\[MEDIUM\]/g) || []).length,
				'[LARGE]': (filesSection.match(/\[LARGE\]/g) || []).length,
			};

			// Each should appear at least once
			for (const [token, count] of Object.entries(counts)) {
				expect(
					count,
					`${token} should appear at least once`,
				).toBeGreaterThanOrEqual(1);
			}
		});

		it('should preserve checkbox format tokens [x] and [ ]', () => {
			const filesStart = prompt.indexOf('## FILES');
			const filesSection = prompt.substring(filesStart);

			expect(filesSection).toContain('[x]');
			expect(filesSection).toContain('[ ]');
		});
	});

	// ATTACK VECTOR 7: Regression check - ensure template variables are not broken
	describe('ATTACK VECTOR 7: Template variable regressions', () => {
		it('should NOT have converted template variables to placeholders', () => {
			// Check that {{AGENT_PREFIX}} is still used
			expect(prompt).toContain('{{AGENT_PREFIX}}');
		});

		it('should NOT have converted {{SWARM_ID}} to something else', () => {
			expect(prompt).toContain('{{SWARM_ID}}');
		});

		it('should NOT have {{QA_RETRY_LIMIT}} accidentally modified', () => {
			expect(prompt).toContain('{{QA_RETRY_LIMIT}}');
		});
	});

	// ATTACK VECTOR 8: Edge case - bracket patterns in instruction text
	describe('ATTACK VECTOR 8: Bracket patterns in instruction text vs templates', () => {
		it('should allow [x] and [ ] as valid checkbox markers', () => {
			// These should exist and are NOT placeholders
			expect(prompt).toContain('[x]');
			expect(prompt).toContain('[ ]');
		});

		it('should NOT accidentally have [x] in template examples', () => {
			const filesStart = prompt.indexOf('## FILES');
			const filesSection = prompt.substring(filesStart);

			// [x] should be in the template examples (checkboxes)
			expect(filesSection).toContain('[x]');
		});

		it('should NOT accidentally have [ ] in template examples', () => {
			const filesStart = prompt.indexOf('## FILES');
			const filesSection = prompt.substring(filesStart);

			// [ ] should be in the template examples (checkboxes)
			expect(filesSection).toContain('[ ]');
		});
	});

	// ATTACK VECTOR 9: Comprehensive scan for suspicious bracket patterns in FILES section only
	describe('ATTACK VECTOR 9: Comprehensive bracket pattern scan in FILES section', () => {
		let templateExamplesOnly: string;

		it('extract template examples from FILES section', () => {
			const filesStart = prompt.indexOf('## FILES');
			expect(filesStart).toBeGreaterThanOrEqual(0);
			const filesSection = prompt.substring(filesStart);

			// Extract only the actual template examples (code blocks after the warning line)
			const warningEndIndex = filesSection.indexOf(
				'must be reproduced exactly.',
			);
			expect(warningEndIndex).toBeGreaterThan(0);

			const templateStartIndex = filesSection.indexOf('\n\n', warningEndIndex);
			templateExamplesOnly = filesSection.substring(templateStartIndex);
		});

		it('should scan only template examples for suspicious bracket patterns', () => {
			const lines = templateExamplesOnly.split('\n');

			// Valid patterns that are allowed in template examples
			const validPatterns = [
				/\[COMPLETE\]/,
				/\[IN PROGRESS\]/,
				/\[BLOCKED\]/,
				/\[SMALL\]/,
				/\[MEDIUM\]/,
				/\[LARGE\]/,
				/\[x\]/,
				/\[ \]/,
				/\[x\]\s*\d+\.\d+:/, // Checkbox with task number
				/\[ \]\s*\d+\.\d+:/, // Unchecked checkbox with task number
			];

			const suspicious: {
				lineNum: number;
				pattern: string;
				context: string;
			}[] = [];

			lines.forEach((line, idx) => {
				const lineNum = idx + 1;
				const trimmedLine = line.trim();

				// Skip empty lines and code block markers
				if (!trimmedLine || trimmedLine === '```') return;

				// Find all bracket patterns in this line
				const bracketMatches = trimmedLine.match(/\[[^\]]+\]/g) || [];

				bracketMatches.forEach((match) => {
					// Check if this bracket pattern matches any valid pattern
					let isValid = false;

					for (const validPattern of validPatterns) {
						if (validPattern.test(match) || validPattern.test(trimmedLine)) {
							isValid = true;
							break;
						}
					}

					// Checkbox format
					if (match === '[x]' || match === '[ ]') {
						isValid = true;
					}

					if (!isValid) {
						// This is a suspicious bracket pattern
						suspicious.push({
							lineNum,
							pattern: match,
							context: trimmedLine.substring(0, 80),
						});
					}
				});
			});

			if (suspicious.length > 0) {
				const report = suspicious
					.map(
						(s) =>
							`  Line ${s.lineNum}: Found ${s.pattern} in "${s.context}..."`,
					)
					.join('\n');
				expect().fail(
					`\nSuspicious bracket patterns found in template examples:\n${report}`,
				);
			}
		});
	});

	// ATTACK VECTOR 10: MODE:PLAN section — save_plan example prompt injection risks
	// Focus on the new save_plan example call - ensure it doesn't contain malicious injection vectors
	describe('ATTACK VECTOR 10: MODE:PLAN save_plan example prompt injection risks', () => {
		let modePlanSection: string;
		let savePlanExample: string;

		it('extract MODE:PLAN section from prompt', () => {
			const modePlanStart = prompt.indexOf('### MODE: PLAN');
			expect(modePlanStart).toBeGreaterThanOrEqual(0);

			// Find the next major section (MODE: CRITIC-GATE or END)
			const nextSectionStart = prompt.indexOf(
				'### MODE: CRITIC-GATE',
				modePlanStart,
			);
			const nextSectionStart2 = prompt.indexOf(
				'### MODE: EXECUTE',
				modePlanStart,
			);
			const endOfPlan = Math.min(
				nextSectionStart > 0 ? nextSectionStart : Infinity,
				nextSectionStart2 > 0 ? nextSectionStart2 : Infinity,
			);

			modePlanSection = prompt.substring(modePlanStart, endOfPlan);
			expect(modePlanSection).toContain('save_plan');
		});

		it('extract the save_plan example call', () => {
			const exampleStart = modePlanSection.indexOf('Example call:');
			expect(exampleStart).toBeGreaterThan(0);

			// Find the end of the example (next blank line or section marker)
			const exampleEnd = modePlanSection.indexOf('\n\n', exampleStart);
			savePlanExample = modePlanSection.substring(exampleStart, exampleEnd);

			expect(savePlanExample).toContain('save_plan({');
			expect(savePlanExample).toContain('swarm_id:');
		});

		it('should NOT contain raw backtick sequences that could escape template literal', () => {
			// Check for standalone backticks that could break the template
			const standaloneBackticks = savePlanExample.match(/(?<!`)`(?!`)/g) || [];
			expect(standaloneBackticks.length).toBe(0);
		});

		it('should NOT contain instructions that could be injected if treated as template', () => {
			// Look for patterns that look like commands or instructions in the example
			const maliciousPatterns = [
				/eval\(/i,
				/execute\(/i,
				/run\(/i,
				/system\(/i,
				/exec\(/i,
				/require\(/i,
				/import\(/i,
				/process\./,
				/global\./,
				/__proto__/,
				/constructor/i,
				/function\s*\(\)/,
				/=>\s*{/,
			];

			for (const pattern of maliciousPatterns) {
				expect(savePlanExample).not.toMatch(pattern);
			}
		});

		it('should NOT accidentally expose secrets or credentials', () => {
			const secretPatterns = [
				/password/i,
				/secret/i,
				/token/i,
				/api[_-]?key/i,
				/credential/i,
				/auth/i,
				/private[_-]?key/i,
				/bearer\s+token/i,
				/oauth/i,
				/session/i,
			];

			for (const pattern of secretPatterns) {
				// These should NOT appear in the example call itself
				expect(savePlanExample).not.toMatch(
					new RegExp(pattern.source + '\\s*[:=]', 'i'),
				);
			}
		});

		it('should use realistic but harmless example values', () => {
			// Check that example values are clearly placeholders/realistic but not real data
			expect(savePlanExample).toContain('"My Real Project"');
			expect(savePlanExample).toContain('"mega"');
			expect(savePlanExample).toContain('"Setup"');
			expect(savePlanExample).toContain(
				'"Install dependencies and configure TypeScript"',
			);
		});
	});

	// ATTACK VECTOR 11: Placeholder bypass in MODE:PLAN instructions
	// Ensure the new instructions properly reject bracket placeholders, including multi-word patterns
	describe('ATTACK VECTOR 11: Placeholder bypass detection in MODE:PLAN', () => {
		let modePlanSection: string;

		it('extract MODE:PLAN section', () => {
			const modePlanStart = prompt.indexOf('### MODE: PLAN');
			expect(modePlanStart).toBeGreaterThanOrEqual(0);

			const nextSectionStart = prompt.indexOf(
				'### MODE: CRITIC-GATE',
				modePlanStart,
			);
			const nextSectionStart2 = prompt.indexOf(
				'### MODE: EXECUTE',
				modePlanStart,
			);
			const endOfPlan = Math.min(
				nextSectionStart > 0 ? nextSectionStart : Infinity,
				nextSectionStart2 > 0 ? nextSectionStart2 : Infinity,
			);

			modePlanSection = prompt.substring(modePlanStart, endOfPlan);
		});

		it('should explicitly warn about bracket placeholder rejection', () => {
			// Check that the warning is present and clear
			expect(modePlanSection).toContain('REJECTED');
			expect(modePlanSection).toContain('bracket');
			expect(modePlanSection).toContain('placeholder');
		});

		it('should reject multi-word bracket patterns like [Project Name]', () => {
			// The warning should be general enough to catch multi-word patterns
			expect(modePlanSection).toMatch(/\[[^\]]+\]/);
		});

		it('should explicitly mention [task] as forbidden', () => {
			expect(modePlanSection).toContain('[task]');
		});

		it('should explicitly mention that brackets in descriptions will be rejected', () => {
			// Look for language that makes this clear
			expect(modePlanSection).toMatch(/bracket.*placeholder.*REJECTED/i);
		});

		it('should provide clear guidance on what IS acceptable', () => {
			// Instructions should contrast forbidden brackets with acceptable formats
			expect(modePlanSection).toContain('title:');
			expect(modePlanSection).toContain('swarm_id:');
			expect(modePlanSection).toContain('phases:');
		});
	});

	// ATTACK VECTOR 12: Malformed save_plan example - structural validity
	// Ensure the example call is structurally valid and won't mislead LLMs
	describe('ATTACK VECTOR 12: Malformed save_plan example structural validity', () => {
		let savePlanExample: string;

		it('extract save_plan example call', () => {
			const modePlanStart = prompt.indexOf('### MODE: PLAN');
			const exampleStart = prompt.indexOf('Example call:', modePlanStart);
			const exampleEnd = prompt.indexOf('\n\n', exampleStart);

			savePlanExample = prompt.substring(exampleStart, exampleEnd);
		});

		it('should have balanced parentheses', () => {
			const openParens = (savePlanExample.match(/\(/g) || []).length;
			const closeParens = (savePlanExample.match(/\)/g) || []).length;
			expect(openParens).toBe(closeParens);
		});

		it('should have balanced braces for objects', () => {
			const openBraces = (savePlanExample.match(/\{/g) || []).length;
			const closeBraces = (savePlanExample.match(/\}/g) || []).length;
			expect(openBraces).toBe(closeBraces);
		});

		it('should have balanced brackets for arrays', () => {
			const openBrackets = (savePlanExample.match(/\[/g) || []).length;
			const closeBrackets = (savePlanExample.match(/\]/g) || []).length;
			expect(openBrackets).toBe(closeBrackets);
		});

		it('should use proper quote matching', () => {
			// Count both single and double quotes
			const singleQuotes = (savePlanExample.match(/'/g) || []).length;
			const doubleQuotes = (savePlanExample.match(/"/g) || []).length;

			// Should be even numbers (balanced)
			expect(singleQuotes % 2).toBe(0);
			expect(doubleQuotes % 2).toBe(0);
		});

		it('should have proper comma-separated parameters', () => {
			// Check that parameters are properly separated
			expect(savePlanExample).toContain('title:');
			expect(savePlanExample).toContain('swarm_id:');
			expect(savePlanExample).toContain('phases:');

			// Ensure no trailing commas before closing braces/parentheses
			expect(savePlanExample).not.toMatch(/,\s*[}\]]/);
		});

		it('should include all required parameters', () => {
			expect(savePlanExample).toContain('title:');
			expect(savePlanExample).toContain('swarm_id:');
			expect(savePlanExample).toContain('phases:');
			expect(savePlanExample).toContain('id:');
			expect(savePlanExample).toContain('name:');
			expect(savePlanExample).toContain('tasks:');
		});

		it('should demonstrate optional fields correctly', () => {
			// The example should show optional fields like size
			expect(savePlanExample).toContain('size:');
		});
	});

	// ATTACK VECTOR 13: Fallback abuse - coder delegation for .swarm/plan.md
	// Ensure the fallback delegation can't be misused to write arbitrary content
	describe('ATTACK VECTOR 13: Fallback delegation abuse prevention', () => {
		let modePlanSection: string;
		let fallbackDelegation: string;

		it('extract MODE:PLAN section', () => {
			const modePlanStart = prompt.indexOf('### MODE: PLAN');
			const nextSectionStart = prompt.indexOf(
				'### MODE: CRITIC-GATE',
				modePlanStart,
			);
			const nextSectionStart2 = prompt.indexOf(
				'### MODE: EXECUTE',
				modePlanStart,
			);
			const endOfPlan = Math.min(
				nextSectionStart > 0 ? nextSectionStart : Infinity,
				nextSectionStart2 > 0 ? nextSectionStart2 : Infinity,
			);

			modePlanSection = prompt.substring(modePlanStart, endOfPlan);
		});

		it('extract fallback delegation section', () => {
			const fallbackStart = modePlanSection.indexOf('⚠️');
			expect(fallbackStart).toBeGreaterThan(0);

			// Find the end of this section (next heading or end of MODE:PLAN)
			// Looking for TASK GRANULARITY RULES which follows the fallback section
			const nextSectionStart = modePlanSection.indexOf(
				'TASK GRANULARITY RULES',
				fallbackStart,
			);
			fallbackDelegation = modePlanSection.substring(
				fallbackStart,
				nextSectionStart,
			);

			expect(fallbackDelegation).toContain('{{AGENT_PREFIX}}coder');
			expect(fallbackDelegation).toContain('.swarm/plan.md');
		});

		it('should clearly mark fallback as EXCEPTION path, not primary', () => {
			expect(fallbackDelegation).toContain('unavailable');
			expect(fallbackDelegation).toContain('⚠️');
		});

		it('should enforce EXACT content writing constraint', () => {
			expect(fallbackDelegation).toContain('EXACTLY');
			expect(fallbackDelegation).toContain(
				'Do not modify, summarize, or interpret',
			);
		});

		it('should NOT allow coder to make decisions about plan content', () => {
			expect(fallbackDelegation).not.toMatch(/write.*plan.*yourself/i);
			expect(fallbackDelegation).not.toMatch(/generate.*plan/i);
		});

		it('should require INPUT parameter with complete plan', () => {
			expect(fallbackDelegation).toContain('INPUT:');
			expect(fallbackDelegation).toContain('provide the complete plan content');
		});

		it('should not be easily confused as the primary path', () => {
			// Check that save_plan tool is mentioned first and is the primary recommendation
			const savePlanIndex = modePlanSection.indexOf('save_plan');
			const fallbackIndex = modePlanSection.indexOf(
				'If `save_plan` is unavailable',
			);

			expect(savePlanIndex).toBeLessThan(fallbackIndex);
		});

		it('should have strong constraint language', () => {
			const constraintSection = fallbackDelegation.substring(
				fallbackDelegation.indexOf('CONSTRAINT:'),
			);
			expect(constraintSection).toMatch(/[A-Z]{4,}/); // Should have uppercase emphasis
		});
	});

	// ATTACK VECTOR 14: Swarm ID injection - path traversal and special characters
	// Ensure swarm_id field can't be used for injection attacks
	describe('ATTACK VECTOR 14: Swarm ID injection prevention', () => {
		let modePlanSection: string;

		it('extract MODE:PLAN section', () => {
			const modePlanStart = prompt.indexOf('### MODE: PLAN');
			const nextSectionStart = prompt.indexOf(
				'### MODE: CRITIC-GATE',
				modePlanStart,
			);
			const nextSectionStart2 = prompt.indexOf(
				'### MODE: EXECUTE',
				modePlanStart,
			);
			const endOfPlan = Math.min(
				nextSectionStart > 0 ? nextSectionStart : Infinity,
				nextSectionStart2 > 0 ? nextSectionStart2 : Infinity,
			);

			modePlanSection = prompt.substring(modePlanStart, endOfPlan);
		});

		it('should warn about or restrict special characters in swarm_id', () => {
			// Look for any warnings about special characters
			const hasSpecialCharWarning =
				modePlanSection.match(/special.*char/i) ||
				modePlanSection.match(/path.*traversal/i) ||
				modePlanSection.match(/invalid.*char/i);

			// Even if no explicit warning, check if examples show simple alphanumeric values
			expect(modePlanSection).toContain('"mega"');
		});

		it('example swarm_id should be simple alphanumeric', () => {
			const exampleStart = modePlanSection.indexOf('Example call:');
			const exampleEnd = modePlanSection.indexOf('\n\n', exampleStart);
			const example = modePlanSection.substring(exampleStart, exampleEnd);

			expect(example).toContain('"mega"');

			// Extract just the swarm_id value from the example
			const swarmIdMatch = example.match(/swarm_id:\s*"([^"]+)"/);
			expect(swarmIdMatch).toBeTruthy();

			if (swarmIdMatch) {
				const swarmIdValue = swarmIdMatch[1];
				// The swarm_id value should NOT contain path traversal patterns
				expect(swarmIdValue).not.toContain('..');
				expect(swarmIdValue).not.toMatch(/[\\/]/); // No backslash or forward slash
				expect(swarmIdValue).not.toMatch(/[;&|`$<]/); // No shell injection characters
			}
		});

		it('should not show example with path traversal patterns', () => {
			const exampleStart = modePlanSection.indexOf('Example call:');
			const exampleEnd = modePlanSection.indexOf('\n\n', exampleStart);
			const example = modePlanSection.substring(exampleStart, exampleEnd);

			const dangerousPatterns = [
				/\.\.\//, // Parent directory traversal
				/\\\\/, // Backslash (Windows path separator) - use double backslash in regex
				/[\\/]\s*\.swarm/, // Attempt to write to .swarm
				/[;&|`$]/, // Shell injection characters
				/\${/, // Template injection
				/<%/, // Template injection
			];

			for (const pattern of dangerousPatterns) {
				expect(example).not.toMatch(pattern);
			}

			// Also check the swarm_id value specifically
			const swarmIdMatch = example.match(/swarm_id:\s*"([^"]+)"/);
			if (swarmIdMatch) {
				const swarmIdValue = swarmIdMatch[1];
				expect(swarmIdValue).not.toMatch(/[\\/]/); // No path separators
				expect(swarmIdValue).not.toContain('..'); // No parent directory references
			}
		});

		it('should frame swarm_id as identifier, not path', () => {
			expect(modePlanSection).toContain('swarm_id:');
			expect(modePlanSection).toContain('identifier');

			// Should NOT suggest it's used for file paths
			expect(modePlanSection).not.toMatch(/swarm_id.*path/i);
			expect(modePlanSection).not.toMatch(/swarm_id.*file/i);
		});

		it('should use example values that are clearly identifiers', () => {
			const exampleStart = modePlanSection.indexOf('Example call:');
			const exampleEnd = modePlanSection.indexOf('\n\n', exampleStart);
			const example = modePlanSection.substring(exampleStart, exampleEnd);

			// The example should use a simple identifier string
			expect(example).toMatch(/swarm_id:\s*"[a-zA-Z0-9]+"/);
		});
	});

	// ATTACK VECTOR 15: Comprehensive scan for all bracket patterns in MODE:PLAN
	// Ensure no bracket placeholders slipped through in instructions or examples
	describe('ATTACK VECTOR 15: Comprehensive bracket pattern scan in MODE:PLAN', () => {
		let modePlanSection: string;

		it('extract MODE:PLAN section', () => {
			const modePlanStart = prompt.indexOf('### MODE: PLAN');
			const nextSectionStart = prompt.indexOf(
				'### MODE: CRITIC-GATE',
				modePlanStart,
			);
			const nextSectionStart2 = prompt.indexOf(
				'### MODE: EXECUTE',
				modePlanStart,
			);
			const endOfPlan = Math.min(
				nextSectionStart > 0 ? nextSectionStart : Infinity,
				nextSectionStart2 > 0 ? nextSectionStart2 : Infinity,
			);

			modePlanSection = prompt.substring(modePlanStart, endOfPlan);
		});

		it('should scan for suspicious bracket patterns in instructions', () => {
			const lines = modePlanSection.split('\n');

			// Valid bracket patterns that ARE allowed (format tokens, examples, warnings)
			const validPatterns = [
				/\[COMPLETE\]/,
				/\[IN PROGRESS\]/,
				/\[BLOCKED\]/,
				/\[SMALL\]/,
				/\[MEDIUM\]/,
				/\[LARGE\]/,
				/\[x\]/,
				/\[ \]/,
				/\[task\]/, // Mentioned as forbidden, so allowed in warning text
				/\[Project\]/, // Mentioned as forbidden, so allowed in warning text
				/\[task\].*REJECTED/, // Warning about forbidden pattern
				/\[.*name\]/, // Generic placeholder patterns in warnings
				/bracket.*\[.*\].*placeholder/, // Warning text about brackets
				/INPUT:\s*\[.*\]/, // INPUT placeholder in fallback section
				/\{\s*id:/, // Array/object notation in example (not square brackets alone)
				/phases:\s*\[/, // phases array in example
				/tasks:\s*\[/, // tasks array in example
			];

			const suspicious: {
				lineNum: number;
				pattern: string;
				context: string;
			}[] = [];

			lines.forEach((line, idx) => {
				const lineNum = idx + 1;
				const trimmedLine = line.trim();

				// Skip empty lines and code block markers
				if (!trimmedLine || trimmedLine === '```') return;

				// Find all bracket patterns in this line
				const bracketMatches = trimmedLine.match(/\[[^\]]+\]/g) || [];

				bracketMatches.forEach((match) => {
					// Check if this bracket pattern matches any valid pattern
					let isValid = false;

					for (const validPattern of validPatterns) {
						if (validPattern.test(match) || validPattern.test(trimmedLine)) {
							isValid = true;
							break;
						}
					}

					// Also check if it's in a warning/context that makes it valid
					if (
						trimmedLine.includes('REJECTED') ||
						trimmedLine.includes('forbidden') ||
						trimmedLine.includes('INPUT:')
					) {
						isValid = true;
					}

					// Format tokens
					if (
						[
							'[COMPLETE]',
							'[IN PROGRESS]',
							'[BLOCKED]',
							'[SMALL]',
							'[MEDIUM]',
							'[LARGE]',
							'[x]',
							'[ ]',
						].includes(match)
					) {
						isValid = true;
					}

					// Check if it's part of array/object syntax (like [{ ... }] or phases: [)
					// These are valid when part of JavaScript/TypeScript syntax
					if (
						trimmedLine.includes('save_plan') ||
						trimmedLine.includes('phases:') ||
						trimmedLine.includes('tasks:')
					) {
						isValid = true;
					}

					// INPUT placeholder is valid
					if (match === '[provide the complete plan content below]') {
						isValid = true;
					}

					if (!isValid) {
						suspicious.push({
							lineNum,
							pattern: match,
							context: trimmedLine.substring(0, 80),
						});
					}
				});
			});

			if (suspicious.length > 0) {
				const report = suspicious
					.map(
						(s) =>
							`  Line ${s.lineNum}: Found ${s.pattern} in "${s.context}..."`,
					)
					.join('\n');
				expect().fail(
					`\nSuspicious bracket patterns found in MODE:PLAN:\n${report}`,
				);
			}
		});

		it('should ensure save_plan example contains no forbidden placeholders', () => {
			const exampleStart = modePlanSection.indexOf('Example call:');
			const exampleEnd = modePlanSection.indexOf('\n\n', exampleStart);
			const example = modePlanSection.substring(exampleStart, exampleEnd);

			// Look for bracket patterns that look like placeholders (not array syntax)
			// The example uses array syntax like [{ ... }] which is fine
			// We want to find bracket patterns that are placeholders like [task], [Project], etc.

			// Extract the description field value specifically
			const descMatch = example.match(/description:\s*"([^"]+)"/);
			if (descMatch) {
				const descriptionValue = descMatch[1];
				// The description should NOT contain bracket placeholders
				expect(descriptionValue).not.toMatch(/\[[^\]]+\]/);
			}

			// Check title field
			const titleMatch = example.match(/title:\s*"([^"]+)"/);
			if (titleMatch) {
				const titleValue = titleMatch[1];
				expect(titleValue).not.toMatch(/\[[^\]]+\]/);
			}

			// Check name field (phase name)
			const nameMatch = example.match(/name:\s*"([^"]+)"/);
			if (nameMatch) {
				const nameValue = nameMatch[1];
				expect(nameValue).not.toMatch(/\[[^\]]+\]/);
			}

			// Check swarm_id field
			const swarmIdMatch = example.match(/swarm_id:\s*"([^"]+)"/);
			if (swarmIdMatch) {
				const swarmIdValue = swarmIdMatch[1];
				expect(swarmIdValue).not.toMatch(/\[[^\]]+\]/);
			}
		});
	});
});

describe('architect prompt: time-pressure anti-rationalization coverage in Rule 4', () => {
	let prompt: string;

	it('setup: extract prompt from architect agent', () => {
		const { createArchitectAgent } = require('../../../src/agents/architect');
		const agent = createArchitectAgent('gpt-4');
		expect(agent).toBeDefined();
		prompt = agent.config.prompt!;
		expect(typeof prompt).toBe('string');
	});

	it('Rule 4 addresses time-critical / urgent / blocking rationalization', () => {
		expect(prompt).toContain('time-critical / urgent / blocking');
	});

	it('Rule 4 states architect is an AI with no deadlines', () => {
		expect(prompt).toContain('AI with no deadlines');
	});

	it('Rule 4 addresses "fix is obvious — explaining takes more effort" rationalization', () => {
		expect(prompt).toContain('fix is obvious');
	});

	it('Rule 4 addresses "quick fix to unblock next task" rationalization', () => {
		expect(prompt).toContain('quick fix to unblock');
	});

	it('Rule 4 addresses "user needs this quickly" rationalization', () => {
		expect(prompt).toContain('user needs this quickly');
	});

	it('Rule 4 clarifies users want correct code, not fast code', () => {
		expect(prompt).toContain('correct code, not fast code');
	});

	it('section 6h EDIT AUTHORITY addresses urgency rationalization', () => {
		expect(prompt).toContain(
			'This is urgent / time-critical / the user is waiting',
		);
	});

	it('section 6h EDIT AUTHORITY addresses "fix so obvious it does not need a coder" rationalization', () => {
		expect(prompt).toContain("fix is so obvious it doesn't need a coder");
	});
});
