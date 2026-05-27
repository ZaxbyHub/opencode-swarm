import { describe, expect, it } from 'bun:test';
import { createSMEAgent } from '../../../src/agents/sme';

describe('SME_PROMPT — Research Caching', () => {
	const agent = createSMEAgent('test-model');
	const prompt = agent.config.prompt!;

	it('1. SME_PROMPT contains RESEARCH CACHING section header', () => {
		expect(prompt).toContain('RESEARCH CACHING');
	});

	it('2. SME_PROMPT references `.swarm/context.md` for cache lookup', () => {
		expect(prompt).toContain('.swarm/context.md');
	});

	it('3. SME_PROMPT references `## Research Sources` section', () => {
		expect(prompt).toContain('## Research Sources');
	});

	it('4. SME_PROMPT instructs reuse of cached summary on cache hit', () => {
		const hasCacheReuse = prompt.includes('reuse') || prompt.includes('cached');
		expect(hasCacheReuse).toBe(true);
	});

	it('5. SME_PROMPT outputs CACHE-UPDATE line on cache miss', () => {
		expect(prompt).toContain('CACHE-UPDATE:');
		expect(prompt).toContain('append this line at the end of your response');
	});

	it('6. SME_PROMPT handles missing context.md → proceed with fresh research', () => {
		expect(prompt).toContain('If `.swarm/context.md` does not exist');
		expect(prompt).toContain('proceed with fresh research');
	});

	it('7. SME_PROMPT handles missing ## Research Sources → proceed with fresh research', () => {
		expect(prompt).toContain('the `## Research Sources` section is absent');
		expect(prompt).toContain('proceed with fresh research');
	});

	it('8. Cache bypass: contains keywords "re-fetch", "ignore cache", "latest"', () => {
		expect(prompt).toContain('"re-fetch"');
		expect(prompt).toContain('"ignore cache"');
		expect(prompt).toContain('"latest"');
	});

	it('9. Cache bypass still produces CACHE-UPDATE line', () => {
		const cacheBypassIndex = prompt.indexOf('Cache bypass');
		const cacheBypassSection = prompt.substring(
			cacheBypassIndex,
			cacheBypassIndex + 300,
		);
		expect(cacheBypassSection).toContain('still include the CACHE-UPDATE line');
	});

	it('10. SME is explicitly read-only for caching', () => {
		expect(prompt).toContain('Do NOT write to any file');
		expect(prompt).toContain('SME is read-only');
	});

	it('11. Architect saves the CACHE-UPDATE line', () => {
		expect(prompt).toContain('Architect');
		expect(prompt).toContain('save this line');
	});

	it('12. CACHE-UPDATE format includes date placeholder [YYYY-MM-DD]', () => {
		expect(prompt).toContain('[YYYY-MM-DD]');
	});

	it('13. SME cites evidence-cache refs for external evidence', () => {
		expect(prompt).toContain('EVIDENCE_REFS');
		expect(prompt).toContain('evidence-cache:<id>');
		expect(prompt).toContain(
			'Raw docs/search snippets are evidence, not memory',
		);
	});
});

describe('SME_PROMPT — Research Caching adversarial', () => {
	const agent = createSMEAgent('test-model');
	const prompt = agent.config.prompt!;

	it('1. SME does NOT instruct writing directly to context.md', () => {
		// Find the RESEARCH CACHING section
		const researchCachingStart = prompt.indexOf('RESEARCH CACHING');
		const researchCachingEnd =
			prompt.indexOf('OUTPUT FORMAT:', researchCachingStart) !== -1
				? prompt.indexOf('OUTPUT FORMAT:', researchCachingStart)
				: prompt.length;
		const researchCachingSection = prompt.substring(
			researchCachingStart,
			researchCachingEnd,
		);

		// Look for "write to" or "append to" instructions that are NOT followed by "Architect"
		const lines = researchCachingSection.split('\n');
		let hasUnauthorizedWrite = false;

		for (const line of lines) {
			// Skip lines that say "Architect" (those are delegating the write)
			if (line.includes('Architect')) {
				continue;
			}

			// Check if line instructs SME to write/append directly
			if (line.includes('write to') || line.includes('append to')) {
				hasUnauthorizedWrite = true;
				break;
			}
		}

		expect(hasUnauthorizedWrite).toBe(false);
	});

	it('2. No raw `${...}` template injection in the caching section', () => {
		// Find the RESEARCH CACHING section
		const researchCachingStart = prompt.indexOf('RESEARCH CACHING');
		const researchCachingEnd =
			prompt.indexOf('OUTPUT FORMAT:', researchCachingStart) !== -1
				? prompt.indexOf('OUTPUT FORMAT:', researchCachingStart)
				: prompt.length;
		const researchCachingSection = prompt.substring(
			researchCachingStart,
			researchCachingEnd,
		);

		// Check for unescaped template expressions like ${...}
		const hasTemplateInjection = researchCachingSection.match(/\$\{[^}]+\}/);
		expect(hasTemplateInjection).toBeNull();
	});

	it('3. Cache bypass does NOT skip the CACHE-UPDATE line', () => {
		// Find the Cache bypass line
		const cacheBypassIndex = prompt.indexOf('Cache bypass');
		const cacheBypassSection = prompt.substring(
			cacheBypassIndex,
			cacheBypassIndex + 300,
		);

		// The bypass should skip cache CHECK, but still include CACHE-UPDATE
		expect(cacheBypassSection).toContain('skip the cache check');
		expect(cacheBypassSection).toContain('still include the CACHE-UPDATE line');
	});
});
