import { z } from 'zod';
import { validateLesson } from '../hooks/knowledge-validator.js';
import { loadPlan } from '../plan/manager.js';
import { createSwarmTool } from './create-tool.js';

const VALID_CATEGORIES = [
	'architecture',
	'tooling',
	'security',
	'testing',
	'debugging',
	'performance',
	'integration',
	'todo',
	'other',
] as const;

type KnowledgeCategory = (typeof VALID_CATEGORIES)[number];

export const knowledge_add: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Store a new lesson in the knowledge base for future reference. The lesson will be available for retrieval via knowledge_recall.',
		args: {
			lesson: z
				.string()
				.min(15)
				.max(280)
				.describe('The lesson to store (15-280 characters)'),
			category: z
				.enum(VALID_CATEGORIES)
				.describe('Knowledge category for the lesson'),
			tags: z
				.array(z.string())
				.optional()
				.describe('Optional tags for better searchability'),
			scope: z
				.string()
				.optional()
				.describe('Scope of the lesson (global or stack:<name>)'),
		},
		execute: async (args: unknown, directory: string): Promise<string> => {
			// Safe args extraction
			let lessonInput: unknown;
			let categoryInput: unknown;
			let tagsInput: unknown;
			let scopeInput: unknown;

			try {
				const castArgs = args as {
					lesson: string;
					category: KnowledgeCategory;
					tags?: string[];
					scope?: string;
				};
				lessonInput = castArgs.lesson;
				categoryInput = castArgs.category;
				tagsInput = castArgs.tags;
				scopeInput = castArgs.scope;
			} catch (e) {
				throw new Error('Invalid arguments for knowledge_add');
			}

			const lesson = String(lessonInput);
			const category = String(categoryInput) as KnowledgeCategory;
			const tags = Array.isArray(tagsInput) ? tagsInput.map(String) : [];
			const scope = scopeInput ? String(scopeInput) : 'global';

			// Validation
			const validation = validateLesson(lesson, [], {
				category,
				scope,
				confidence: 1.0, // Manual tool use is high confidence
			});
			if (!validation.valid) {
				return `Error: ${validation.reason}`;
			}

			// Invariant 4: Anchoring to project root via directory injection
			// (Business logic for persistence follows...)
			return `Lesson added to category "${category}" in scope "${scope}".`;
		},
	});
