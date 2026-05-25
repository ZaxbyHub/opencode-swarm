/**
 * Verification tests for .opencode/skills/deep-dive/SKILL.md protocol content.
 * Task: deep-dive protocol detail-level tests
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SKILL_PATH = join(process.cwd(), '.opencode/skills/deep-dive/SKILL.md');
const skillContent = readFileSync(SKILL_PATH, 'utf-8');

describe('.opencode/skills/deep-dive/SKILL.md protocol content', () => {
	describe('1. YAML frontmatter is valid', () => {
		it('contains name: deep-dive in frontmatter', () => {
			expect(skillContent).toContain('name: deep-dive');
		});

		it('contains description: in frontmatter', () => {
			expect(skillContent).toContain('description:');
		});
	});

	describe('2. All 7 protocol steps present', () => {
		it('contains Step 0 — Parse Header', () => {
			expect(skillContent).toContain('## Step 0 — Parse Header');
		});

		it('contains Step 1 — Repo Readiness', () => {
			expect(skillContent).toContain('## Step 1 — Repo Readiness');
		});

		it('contains Step 2 — Scope Resolution', () => {
			expect(skillContent).toContain('## Step 2 — Scope Resolution');
		});

		it('contains Step 3 — Explorer Missions', () => {
			expect(skillContent).toContain('## Step 3 — Explorer Missions');
		});

		it('contains Step 4 — Normalize Candidates', () => {
			expect(skillContent).toContain('## Step 4 — Normalize Candidates');
		});

		it('contains Step 5 — Always 2 Parallel Reviewers', () => {
			expect(skillContent).toContain('## Step 5 — Always 2 Parallel Reviewers');
		});

		it('contains Step 5b — Reviewer Merge/Dedup', () => {
			expect(skillContent).toContain('## Step 5b — Reviewer Merge/Dedup');
		});

		it('contains Step 6 — Critic Challenge', () => {
			expect(skillContent).toContain('## Step 6 — Critic Challenge');
		});

		it('contains Step 7 — Final Report', () => {
			expect(skillContent).toContain('## Step 7 — Final Report');
		});
	});

	describe('3. All 8 lane templates named', () => {
		const lanes = [
			'SCOPE_MAP',
			'WIRING_DATAFLOW',
			'RUNTIME_BEHAVIOR',
			'UX_FLOW',
			'SECURITY_TRUST',
			'TEST_COVERAGE',
			'PERFORMANCE_RELIABILITY',
			'DOCS_CONFIG_DEPLOYMENT',
		];

		for (const lane of lanes) {
			it(`contains lane template: ${lane}`, () => {
				expect(skillContent).toContain(lane);
			});
		}
	});

	describe('4. All 5 profiles named', () => {
		const profiles = ['standard', 'security', 'ux', 'architecture', 'full'];

		for (const profile of profiles) {
			it(`contains profile: ${profile}`, () => {
				expect(skillContent).toContain(profile);
			});
		}
	});

	describe('5. 2 parallel reviewers constraint', () => {
		it('contains "2 parallel" and "reviewer" together', () => {
			expect(skillContent).toContain('2 parallel');
			expect(skillContent).toContain('reviewer');
		});

		it('contains exact text "2 parallel `{{AGENT_PREFIX}}reviewer` calls"', () => {
			expect(skillContent).toContain(
				'2 parallel `{{AGENT_PREFIX}}reviewer` calls',
			);
		});
	});

	describe('6. 8-file cap for explorer missions', () => {
		it('contains "8 files maximum per mission"', () => {
			expect(skillContent).toContain('8 files maximum per mission');
		});
	});

	describe('7. Critic challenges only HIGH/CRITICAL', () => {
		it('contains "Do NOT challenge MEDIUM/LOW/INFO findings"', () => {
			expect(skillContent).toContain(
				'Do NOT challenge MEDIUM/LOW/INFO findings',
			);
		});
	});

	describe('8. {{AGENT_PREFIX}} references preserved', () => {
		it('contains {{AGENT_PREFIX}}reviewer', () => {
			expect(skillContent).toContain('{{AGENT_PREFIX}}reviewer');
		});

		it('contains {{AGENT_PREFIX}}critic', () => {
			expect(skillContent).toContain('{{AGENT_PREFIX}}critic');
		});
	});

	describe('9. ~3500 line guardrail', () => {
		it('contains "~3500 total lines across all files in a mission"', () => {
			expect(skillContent).toContain(
				'~3500 total lines across all files in a mission',
			);
		});
	});
});
