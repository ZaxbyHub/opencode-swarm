import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	extract_code_blocks,
	extractFilename,
} from '../../../src/tools/file-extractor';

describe('file-extractor', () => {
	describe('extractFilename', () => {
		it('extracts filename from # filename: comment', () => {
			const code = `# filename: test.py\nprint("hello")`;
			const result = extractFilename(code, 'python', 0);
			expect(result).toBe('test.py');
		});

		it('extracts filename from // filename: comment', () => {
			const code = `// filename: app.js\nconsole.log("hello");`;
			const result = extractFilename(code, 'javascript', 0);
			expect(result).toBe('app.js');
		});

		it('extracts bare filename from # pattern', () => {
			const code = `# myfile.ps1\nGet-Process`;
			const result = extractFilename(code, 'powershell', 0);
			expect(result).toBe('myfile.ps1');
		});

		it('extracts filename from def function definition', () => {
			const code = `def my_function():\n    pass`;
			const result = extractFilename(code, 'python', 0);
			expect(result).toBe('my_function.py');
		});

		it('extracts filename from class definition', () => {
			const code = `class MyClass:\n    def __init__(self):\n        pass`;
			const result = extractFilename(code, 'python', 0);
			expect(result).toBe('MyClass.py');
		});

		it('extracts filename from function keyword', () => {
			const code = `function Get-Process {\n    Get-Process`;
			const result = extractFilename(code, 'powershell', 0);
			expect(result).toBe('Get-Process.ps1');
		});

		it('skips private functions starting with _', () => {
			const code = `def _private_function():\n    pass`;
			const result = extractFilename(code, 'python', 0);
			// Deterministic fallback keeps preflight authorization and execution aligned.
			expect(result).toBe('output_1.py');
		});

		it('falls back to a deterministic name when no patterns match', () => {
			const code = `some random code\nwith no patterns`;
			const result = extractFilename(code, 'python', 0);
			expect(result).toBe('output_1.py');
		});

		it('uses correct extensions from EXT_MAP for known languages', () => {
			const code = `print("hello")`;
			const testCases = [
				{ language: 'python', expected: '.py' },
				{ language: 'javascript', expected: '.js' },
				{ language: 'typescript', expected: '.ts' },
				{ language: 'powershell', expected: '.ps1' },
				{ language: 'bash', expected: '.sh' },
				{ language: 'json', expected: '.json' },
				{ language: 'yaml', expected: '.yaml' },
				{ language: 'xml', expected: '.xml' },
				{ language: 'html', expected: '.html' },
				{ language: 'css', expected: '.css' },
				{ language: 'sql', expected: '.sql' },
			];

			testCases.forEach(({ language, expected }) => {
				const result = extractFilename(code, language, 0);
				expect(result).toEndWith(expected);
			});
		});

		it('uses .txt for unknown languages', () => {
			const code = `some code`;
			const result = extractFilename(code, 'unknown_language', 0);
			expect(result).toEndWith('.txt');
		});
	});

	describe('extract_code_blocks.execute', () => {
		// Secure model (issue #1778 C1): the 2nd arg is the workspace root and
		// output_dir must resolve inside it. Tests use a real workspace dir.
		const makeWorkspace = () =>
			fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'extractor-ws-')));

		it('extracts single code block into the workspace root', async () => {
			const ws = makeWorkspace();
			const content = '```python\nprint("hello")\n```';

			const result = await extract_code_blocks.execute({ content }, {
				directory: ws,
			} as any);

			expect(result).toContain('Extracted 1 file(s):');

			const files = fs.readdirSync(ws);
			expect(files).toHaveLength(1);
			expect(fs.readFileSync(path.join(ws, files[0]), 'utf-8')).toBe(
				'print("hello")',
			);

			fs.rmSync(ws, { recursive: true, force: true });
		});

		it('extracts multiple code blocks', async () => {
			const ws = makeWorkspace();
			const content = `
\`\`\`python
def hello():
    print("hello")
\`\`\`

\`\`\`javascript
console.log("world");
\`\`\`
`;

			const result = await extract_code_blocks.execute({ content }, {
				directory: ws,
			} as any);

			expect(result).toContain('Extracted 2 file(s):');

			const files = fs.readdirSync(ws);
			expect(files).toHaveLength(2);
			expect(files.find((f) => f.endsWith('.py'))).toBeDefined();
			expect(files.find((f) => f.endsWith('.js'))).toBeDefined();

			fs.rmSync(ws, { recursive: true, force: true });
		});

		it('returns "No code blocks found" for content without fences', async () => {
			const ws = makeWorkspace();
			const content = 'This is just plain text without any code blocks.';

			const result = await extract_code_blocks.execute({ content }, {
				directory: ws,
			} as any);

			expect(result).toBe('No code blocks found in content.');
			expect(fs.readdirSync(ws)).toHaveLength(0);

			fs.rmSync(ws, { recursive: true, force: true });
		});

		it('applies prefix to filenames', async () => {
			const ws = makeWorkspace();
			const content = '```python\nprint("hello")\n```';

			const result = await extract_code_blocks.execute(
				{ content, prefix: 'test_prefix' },
				{ directory: ws } as any,
			);

			expect(result).toContain('test_prefix_');
			expect(fs.readdirSync(ws)[0]).toStartWith('test_prefix_');

			fs.rmSync(ws, { recursive: true, force: true });
		});

		it('handles filename collisions by incrementing counter', async () => {
			const ws = makeWorkspace();
			const content = `
\`\`\`python
print("first")
\`\`\`

\`\`\`python
print("second")
\`\`\`
`;
			const existingFile = path.join(ws, 'output_1.py');
			fs.writeFileSync(existingFile, 'existing content');

			await extract_code_blocks.execute({ content }, { directory: ws } as any);

			const files = fs.readdirSync(ws);
			expect(files).toHaveLength(3); // existing + 2 new files
			const newFiles = files.filter((f) => f !== path.basename(existingFile));
			expect(newFiles.sort()).toEqual(['output_1_1.py', 'output_2.py']);

			fs.rmSync(ws, { recursive: true, force: true });
		});

		it('creates a relative output subdirectory inside the workspace', async () => {
			const ws = makeWorkspace();
			const content = '```python\nprint("hello")\n```';

			const result = await extract_code_blocks.execute(
				{ content, output_dir: 'gen/sub' },
				{ directory: ws } as any,
			);

			const sub = path.join(ws, 'gen', 'sub');
			expect(fs.existsSync(sub)).toBe(true);
			expect(result).toContain('Extracted 1 file(s):');
			expect(fs.readdirSync(sub)).toHaveLength(1);

			fs.rmSync(ws, { recursive: true, force: true });
		});

		// --- Security: containment (issue #1778 C1) ---

		it('rejects an absolute output_dir outside the workspace', async () => {
			const ws = makeWorkspace();
			const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'extractor-out-'));
			const content = '```python\nprint("pwn")\n```';

			const result = await extract_code_blocks.execute(
				{ content, output_dir: outside },
				{ directory: ws } as any,
			);

			expect(result).toContain('output_dir rejected');
			expect(fs.readdirSync(outside)).toHaveLength(0);

			fs.rmSync(ws, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		});

		it('rejects a traversal output_dir that escapes the workspace', async () => {
			const ws = makeWorkspace();
			const content = '```python\nprint("pwn")\n```';

			const result = await extract_code_blocks.execute(
				{ content, output_dir: '../escaped' },
				{ directory: ws } as any,
			);

			expect(result).toContain('output_dir rejected');
			expect(fs.existsSync(path.join(path.dirname(ws), 'escaped'))).toBe(false);

			fs.rmSync(ws, { recursive: true, force: true });
		});

		it('rejects a malicious `# filename:` traversal comment', async () => {
			const ws = makeWorkspace();
			// First line is a filename comment that tries to escape via ../.
			const content = '```python\n# filename: ../../evil.sh\nprint("pwn")\n```';

			const result = await extract_code_blocks.execute({ content }, {
				directory: ws,
			} as any);

			expect(result).toContain('Rejected unsafe filename');
			expect(fs.existsSync(path.join(path.dirname(ws), 'evil.sh'))).toBe(false);
			expect(
				fs.existsSync(path.join(path.dirname(path.dirname(ws)), 'evil.sh')),
			).toBe(false);
			// Nothing written into the workspace either.
			expect(fs.readdirSync(ws)).toHaveLength(0);

			fs.rmSync(ws, { recursive: true, force: true });
		});

		it('rejects a filename comment with a nested path segment', async () => {
			const ws = makeWorkspace();
			const content =
				'```python\n# filename: subdir/nested.py\nprint("x")\n```';

			const result = await extract_code_blocks.execute({ content }, {
				directory: ws,
			} as any);

			expect(result).toContain('Rejected unsafe filename');
			expect(fs.existsSync(path.join(ws, 'subdir'))).toBe(false);

			fs.rmSync(ws, { recursive: true, force: true });
		});

		it('rejects a write through a pre-planted broken symlink (final component)', async () => {
			const ws = makeWorkspace();
			const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'extractor-sym-'));
			// A broken symlink inside the workspace pointing outside to a
			// not-yet-existing file. existsSync(link) follows it → false, so the
			// collision loop would skip it and writeFileSync would follow it out
			// of the workspace. The lstat guard must reject it (#1778 C1 F2).
			const outsideTarget = path.join(outside, 'escaped.py');
			// Deterministic generated filename via a bare `# filename:` comment,
			// so the pre-planted symlink name matches the write target exactly.
			const linkName = 'planted.py';
			try {
				fs.symlinkSync(outsideTarget, path.join(ws, linkName));
			} catch (error) {
				// Windows requires Developer Mode or SeCreateSymbolicLinkPrivilege for
				// file symlinks. Leave this security case active everywhere it is supported.
				if ((error as NodeJS.ErrnoException).code === 'EPERM') {
					fs.rmSync(ws, { recursive: true, force: true });
					fs.rmSync(outside, { recursive: true, force: true });
					return;
				}
				throw error;
			}
			const content = '```python\n# filename: planted.py\nprint("pwn")\n```';

			const result = await extract_code_blocks.execute({ content }, {
				directory: ws,
			} as any);

			expect(result).toContain('Rejected write through symlink');
			expect(fs.existsSync(outsideTarget)).toBe(false);

			fs.rmSync(ws, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		});
	});
});
