/**
 * M10 regression tests: the dark-matter / co-change writer — the one knowledge
 * ingestion path that historically never ran through validateLesson — is now
 * gated by the same content-safety check every other ingestion path uses.
 *
 * Dark-matter lesson text is derived from git-tracked file paths, which are
 * attacker-influenceable. A maliciously named path could embed a prompt-injection
 * payload that would otherwise be appended to knowledge.jsonl and later injected
 * verbatim into the architect's system prompt.
 *
 * The system-enhancer append chokepoint gates each generated entry on
 *   validateActionability(e).actionable && validateLesson(e.lesson, …).valid
 * These tests exercise that exact predicate against the real generator output.
 */

import { describe, expect, it } from 'bun:test';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types.js';
import {
	validateActionability,
	validateLesson,
} from '../../../src/hooks/knowledge-validator.js';
import type { CoChangeEntry } from '../../../src/tools/co-change-analyzer.js';
import { darkMatterToKnowledgeEntries } from '../../../src/tools/co-change-analyzer.js';

function makePair(fileA: string, fileB: string): CoChangeEntry {
	return {
		fileA,
		fileB,
		coChangeCount: 8,
		npmi: 0.5,
		lift: 2,
		hasStaticEdge: false,
		totalCommits: 40,
		commitsA: 12,
		commitsB: 10,
	};
}

/** Mirrors the dark-matter append chokepoint gate in system-enhancer.ts. */
function passesGate(e: SwarmKnowledgeEntry): boolean {
	return (
		validateActionability(e).actionable &&
		validateLesson(e.lesson, [], {
			category: e.category,
			scope: e.scope,
			confidence: e.confidence,
		}).valid
	);
}

describe('dark-matter writer — M10 validateLesson content-safety gate', () => {
	it('drops a dark-matter entry whose file paths embed a prompt-injection payload', () => {
		const entries = darkMatterToKnowledgeEntries(
			[makePair('src/a<script>x.ts', 'src/b.ts')],
			'proj',
		);
		expect(entries).toHaveLength(1);
		const e = entries[0];
		// The payload really is carried into the lesson text...
		expect(e.lesson).toContain('<script');
		// ...it is still structurally actionable (predicate + scope present)...
		expect(validateActionability(e).actionable).toBe(true);
		// ...but validateLesson's Layer-2 scan rejects it, so the gate drops it.
		expect(
			validateLesson(e.lesson, [], {
				category: e.category,
				scope: e.scope,
				confidence: e.confidence,
			}).valid,
		).toBe(false);
		expect(passesGate(e)).toBe(false);
	});

	it('keeps a benign dark-matter entry (positive control)', () => {
		const entries = darkMatterToKnowledgeEntries(
			[makePair('src/foo.ts', 'src/bar.ts')],
			'proj',
		);
		expect(entries).toHaveLength(1);
		const e = entries[0];
		expect(e.lesson).not.toContain('<script');
		expect(passesGate(e)).toBe(true);
	});
});
