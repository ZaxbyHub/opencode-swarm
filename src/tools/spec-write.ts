/**
 * spec_write — Safe writer for `.swarm/spec.md`.
 *
 * Allows the spec_writer agent (or architect) to update the project spec
 * without granting general filesystem write access. Validates target path is
 * `.swarm/spec.md`, performs an atomic rename, and rejects content that would
 * break the basic shape (must be markdown, must contain a top-level heading).
 */

import { mkdir, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { loadPluginConfigWithMeta } from '../config';
import { SpecWriterConfigSchema } from '../config/schema';
import { createSwarmTool } from './create-tool.js';

const MAX_SPEC_BYTES = 256 * 1024; // 256 KiB

export const spec_write: ReturnType<typeof createSwarmTool> = createSwarmTool({
	description:
		'Write the canonical project spec to .swarm/spec.md. Atomic write, size-bounded (256 KiB), heading-required. Honors spec_writer.allow_spec_write.',
	args: {
		content: z.string().min(20).max(MAX_SPEC_BYTES),
		mode: z.enum(['replace', 'append']).optional().default('replace'),
	},
	execute: async (args: unknown, directory): Promise<string> => {
		const a = (args ?? {}) as {
			content?: string;
			mode?: 'replace' | 'append';
		};
		const content = a.content;
		const mode = a.mode ?? 'replace';
		if (typeof content !== 'string' || content.length < 20) {
			return JSON.stringify({
				written: false,
				reason: 'content must be a string >=20 chars',
			});
		}
		if (content.length > MAX_SPEC_BYTES) {
			return JSON.stringify({
				written: false,
				reason: `content exceeds ${MAX_SPEC_BYTES} bytes`,
			});
		}
		const { config } = loadPluginConfigWithMeta(directory);
		const parsed = SpecWriterConfigSchema.parse(config.spec_writer ?? {});
		if (!parsed.allow_spec_write) {
			return JSON.stringify(
				{
					written: false,
					reason: 'spec_writer.allow_spec_write is false',
				},
				null,
				2,
			);
		}
		// Defense: forbid embedded null and require a top-level heading.
		if (content.indexOf('\u0000') !== -1) {
			return JSON.stringify(
				{ written: false, reason: 'content contains null byte' },
				null,
				2,
			);
		}
		if (!/^#\s+/m.test(content)) {
			return JSON.stringify(
				{
					written: false,
					reason: 'spec must contain at least one top-level "# Heading"',
				},
				null,
				2,
			);
		}

		const target = path.join(directory, '.swarm', 'spec.md');
		await mkdir(path.dirname(target), { recursive: true });
		const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
		let finalContent = content;
		if (mode === 'append') {
			try {
				const fs = await import('node:fs/promises');
				const prior = await fs.readFile(target, 'utf-8');
				finalContent = `${prior.replace(/\s+$/, '')}\n\n${content}\n`;
				if (finalContent.length > MAX_SPEC_BYTES) {
					return JSON.stringify(
						{
							written: false,
							reason:
								'append would exceed max spec size (256 KiB); rewrite explicitly',
						},
						null,
						2,
					);
				}
			} catch {
				// no prior file; treat as replace
			}
		}
		await writeFile(tmp, finalContent, 'utf-8');
		await rename(tmp, target);
		return JSON.stringify(
			{ written: true, path: target, bytes: finalContent.length },
			null,
			2,
		);
	},
});

export const _internals: { spec_write: typeof spec_write } = { spec_write };
