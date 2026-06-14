/**
 * Tests for shell-write-detect module
 * @jest-environment node
 */

// FR-011: This file contains 253 tests against a security-sensitive shell command
// parser. The high test count is justified by the need to cover many shell syntax
// variants, quoting modes, escape sequences, and cross-platform command patterns.
// See .swarm/spec.md FR-011.

import { describe, expect, test } from 'bun:test';
import {
	detectInteractiveSession,
	detectPosixWrites,
	detectWindowsWrites,
	resolveWriteTargets,
} from './shell-write-detect';

function expectWrites(
	command: string,
	expected: Array<{ category: string; operator: string; path: string | null }>,
) {
	const result = detectPosixWrites(command);
	expect(result.writes).toEqual(expected);
	expect(result.hasWrites).toBe(expected.length > 0);
}

// ---------------------------------------------------------------------------
// Category 1: File redirection operators (>  >>  >|  <>)
// ---------------------------------------------------------------------------

describe('redirect operators', () => {
	test('detects > (redirect output)', () => {
		expectWrites('echo hello > file.txt', [
			{ category: 'redirect', operator: '>', path: 'file.txt' },
		]);
	});

	test('detects >> (append output)', () => {
		expectWrites('echo world >> log.txt', [
			{ category: 'redirect', operator: '>>', path: 'log.txt' },
		]);
	});

	test('detects >| (clobber redirect)', () => {
		expectWrites('echo data >| output.bin', [
			{ category: 'redirect', operator: '>|', path: 'output.bin' },
		]);
	});

	test('detects <> (read/write redirect)', () => {
		expectWrites('exec 5<> /dev/tty', [
			{ category: 'redirect', operator: '<>', path: '/dev/tty' },
		]);
	});

	test('detects redirect on piped command', () => {
		expectWrites('cat input.txt | grep foo > results.txt', [
			{ category: 'redirect', operator: '>', path: 'results.txt' },
		]);
	});

	test('detects redirect on subshell', () => {
		expectWrites('(echo inside) > sub_output.txt', [
			{ category: 'redirect', operator: '>', path: 'sub_output.txt' },
		]);
	});

	test('detects multiple redirects', () => {
		expectWrites('echo foo > a.txt 2> b.txt', [
			{ category: 'redirect', operator: '>', path: 'a.txt' },
			{ category: 'redirect', operator: '>', path: 'b.txt' },
		]);
	});

	test('fd-specific redirect: 2>&1 (not a write target, just fd copy)', () => {
		const result = detectPosixWrites('cmd 2>&1');
		// LESSAND/GREATAND are not in our write-effect set
		expect(result.hasWrites).toBe(false);
	});

	test('returns null path when redirect target is not a static word', () => {
		// Dynamic target can't be determined statically
		const result = detectPosixWrites('echo foo > $VAR');
		expect(result.writes.length).toBe(1);
		expect(result.writes[0].path).toBe('$VAR'); // bash-parser returns it as a Word with that text
	});

	test('empty command has no writes', () => {
		expect(detectPosixWrites('').hasWrites).toBe(false);
	});

	test('null path when redirect word is a here-doc marker-like string', () => {
		// bash-parser would give us the word as-is; we filter known here-doc markers
		// This is a path=null case for future fail-closed handling
		const result = detectPosixWrites('cat << END\ncontent\nEND > out.txt');
		// The > out.txt is the write; the here-doc itself doesn't have a real path
		expect(result.hasWrites).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Category 2: Here-document and here-string redirections
// ---------------------------------------------------------------------------

describe('here-document / here-string', () => {
	test('detects << (here-doc)', () => {
		expectWrites('cat << EOF\ndata\nEOF', [
			{ category: 'here_doc', operator: '<<', path: null }, // here-doc marker, not a file
		]);
	});

	test('detects <<- (here-doc with leading tab strip)', () => {
		expectWrites('cat <<-END\ndata\nEND', [
			{ category: 'here_doc', operator: '<<-', path: null },
		]);
	});

	test('detects <<< (here-string)', () => {
		// Note: bash-parser in POSIX mode does not support <<< (bash-specific here-string).
		// This test documents that the module gracefully returns empty when the parser fails.
		const result = detectPosixWrites('grep foo <<< "hello world"');
		// bash-parser throws "Unexpected 'LESS'" for <<< in POSIX mode → fail-gracefully returns []
		expect(result.hasWrites).toBe(false);
	});

	test('here-doc with redirect on same command', () => {
		expectWrites('cat << EOF > out.txt\ndata\nEOF', [
			{ category: 'here_doc', operator: '<<', path: null },
			{ category: 'redirect', operator: '>', path: 'out.txt' },
		]);
	});
});

// ---------------------------------------------------------------------------
// Category 3: Write-effect builtins (cp, mv, install, ln, truncate, dd)
// ---------------------------------------------------------------------------

describe('builtin write-effect commands', () => {
	test('cp with destination', () => {
		expectWrites('cp src.txt dst.txt', [
			{ category: 'builtin_write', operator: 'cp', path: 'dst.txt' },
		]);
	});

	test('cp -r with directory destination', () => {
		expectWrites('cp -r folder/ backup/', [
			{ category: 'builtin_write', operator: 'cp', path: 'backup/' },
		]);
	});

	test('mv with destination', () => {
		expectWrites('mv old.txt new.txt', [
			{ category: 'builtin_write', operator: 'mv', path: 'new.txt' },
		]);
	});

	test('install with destination', () => {
		expectWrites('install -m 644 src.tmp /dest/file', [
			{ category: 'builtin_write', operator: 'install', path: '/dest/file' },
		]);
	});

	test('ln with target link name', () => {
		expectWrites('ln -s target.txt link.txt', [
			{ category: 'builtin_write', operator: 'ln', path: 'link.txt' },
		]);
	});

	test('truncate with file path', () => {
		expectWrites('truncate -s 0 bigfile.log', [
			{ category: 'builtin_write', operator: 'truncate', path: 'bigfile.log' },
		]);
	});

	test('truncate with size option only', () => {
		const result = detectPosixWrites('truncate -s 0');
		// No non-flag argument — can't determine path
		expect(result.hasWrites).toBe(false);
	});

	test('dd with of= output file', () => {
		expectWrites('dd if=/dev/zero of=output.bin bs=1M count=1', [
			{ category: 'builtin_write', operator: 'dd of=', path: 'output.bin' },
		]);
	});

	test('dd with of= no-space variant', () => {
		expectWrites('dd if=/dev/zero of=out.bin', [
			{ category: 'builtin_write', operator: 'dd of=', path: 'out.bin' },
		]);
	});

	test('dd without of= (no write target)', () => {
		const result = detectPosixWrites('dd if=/dev/zero of=/dev/null');
		expect(result.hasWrites).toBe(false);
	});

	test('cp preserves last non-flag argument', () => {
		expectWrites('cp -v -r src/ /dest/', [
			{ category: 'builtin_write', operator: 'cp', path: '/dest/' },
		]);
	});
});

// ---------------------------------------------------------------------------
// Category 4: In-place editing (sed -i, perl -i, awk -i)
// ---------------------------------------------------------------------------

describe('in-place editing', () => {
	test('sed -i edits file in place', () => {
		expectWrites('sed -i "s/foo/bar/g" file.txt', [
			{ category: 'inplace_edit', operator: 'sed -i', path: 'file.txt' },
		]);
	});

	test('sed -i[SUFFIX] variant (sed -ibak)', () => {
		expectWrites('sed -ibak "s/foo/bar/" script.sh', [
			{ category: 'inplace_edit', operator: 'sed -i', path: 'script.sh' },
		]);
	});

	test('perl -i edits file in place', () => {
		expectWrites('perl -i -pe "s/foo/bar/" data.csv', [
			{ category: 'inplace_edit', operator: 'perl -i', path: 'data.csv' },
		]);
	});

	test('awk -i inplace edits file in place', () => {
		expectWrites('awk -i inplace "{print $1}" records.txt', [
			{ category: 'inplace_edit', operator: 'awk -i', path: 'records.txt' },
		]);
	});

	test('sed without -i is not flagged', () => {
		const result = detectPosixWrites('sed "s/foo/bar/" file.txt');
		expect(result.hasWrites).toBe(false);
	});

	test('perl without -i is not flagged', () => {
		const result = detectPosixWrites('perl -pe "print" file.txt');
		expect(result.hasWrites).toBe(false);
	});

	test('multiple files with sed -i', () => {
		expectWrites('sed -i "s/a/b/" f1.txt f2.txt', [
			{ category: 'inplace_edit', operator: 'sed -i', path: 'f1.txt' },
		]);
	});
});

// ---------------------------------------------------------------------------
// Category 5: Interpreter eval (python -c, node -e, bun -e, ruby -e, perl -e, php -r)
// ---------------------------------------------------------------------------

describe('interpreter eval', () => {
	test('python -c executes inline code', () => {
		expectWrites('python -c "print(1+1)"', [
			{ category: 'interpreter_eval', operator: 'python [eval]', path: null },
		]);
	});

	test('python3 -c executes inline code', () => {
		expectWrites('python3 -c "import os; os.write(1,b"hi")"', [
			{ category: 'interpreter_eval', operator: 'python3 [eval]', path: null },
		]);
	});

	test('node -e executes inline code', () => {
		expectWrites('node -e "console.log(1)"', [
			{ category: 'interpreter_eval', operator: 'node [eval]', path: null },
		]);
	});

	test('bun -e executes inline code', () => {
		expectWrites('bun -e "console.log(1)"', [
			{ category: 'interpreter_eval', operator: 'bun [eval]', path: null },
		]);
	});

	test('ruby -e executes inline code', () => {
		expectWrites('ruby -e "puts 1"', [
			{ category: 'interpreter_eval', operator: 'ruby [eval]', path: null },
		]);
	});

	test('perl -e executes inline code', () => {
		expectWrites('perl -e "print 1"', [
			{ category: 'interpreter_eval', operator: 'perl [eval]', path: null },
		]);
	});

	test('php -r executes inline code', () => {
		expectWrites('php -r "echo 1;"', [
			{ category: 'interpreter_eval', operator: 'php [eval]', path: null },
		]);
	});

	test('python -m executes module (potential write)', () => {
		expectWrites('python -m compileall .', [
			{ category: 'interpreter_eval', operator: 'python [eval]', path: null },
		]);
	});

	test('node -p evaluates and prints (write effect)', () => {
		expectWrites('node -p "1+1"', [
			{ category: 'interpreter_eval', operator: 'node [eval]', path: null },
		]);
	});

	test('plain python without -c is not flagged', () => {
		const result = detectPosixWrites('python script.py');
		expect(result.hasWrites).toBe(false);
	});

	test('plain node without -e is not flagged', () => {
		const result = detectPosixWrites('node script.js');
		expect(result.hasWrites).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Category 6: Network downloaders (curl -o, wget -O, scp)
// ---------------------------------------------------------------------------

describe('network downloaders', () => {
	test('curl -o with space', () => {
		expectWrites('curl -o output.html https://example.com', [
			{
				category: 'network_download',
				operator: 'curl -o',
				path: 'output.html',
			},
		]);
	});

	test('curl -o without space (-oFILE)', () => {
		expectWrites('curl -oFILE https://example.com', [
			{ category: 'network_download', operator: 'curl -o', path: 'FILE' },
		]);
	});

	test('curl -O (remote name)', () => {
		// -O doesn't specify local path, downloads to current dir with remote name
		// We don't flag -O alone since it uses remote filename
		const result = detectPosixWrites('curl -O https://example.com/file.zip');
		expect(result.hasWrites).toBe(false);
	});

	test('wget -O with space', () => {
		expectWrites('wget -O page.html https://example.com', [
			{ category: 'network_download', operator: 'wget -O', path: 'page.html' },
		]);
	});

	test('wget -O without space', () => {
		expectWrites('wget -OPAGE.html https://example.com', [
			{ category: 'network_download', operator: 'wget -O', path: 'PAGE.html' },
		]);
	});

	test('scp with local path', () => {
		expectWrites('scp user@remote:/path/file.txt ./local/', [
			{ category: 'network_download', operator: 'scp', path: './local/' },
		]);
	});

	test('scp with absolute local path', () => {
		expectWrites('scp user@remote:/path/file.txt /tmp/file.txt', [
			{ category: 'network_download', operator: 'scp', path: '/tmp/file.txt' },
		]);
	});
});

// ---------------------------------------------------------------------------
// Category 7: Archive extraction (tar -x, unzip, gunzip)
// ---------------------------------------------------------------------------

describe('archive extraction', () => {
	test('tar -x extracts archive', () => {
		expectWrites('tar -xf archive.tar', [
			{ category: 'archive_extract', operator: 'tar -x', path: 'archive.tar' },
		]);
	});

	test('tar -xv extracts with verbose', () => {
		expectWrites('tar -xvzf backup.tar.gz', [
			{
				category: 'archive_extract',
				operator: 'tar -x',
				path: 'backup.tar.gz',
			},
		]);
	});

	test('tar --extract long form', () => {
		expectWrites('tar --extract --file=archive.tar', [
			{ category: 'archive_extract', operator: 'tar -x', path: 'archive.tar' },
		]);
	});

	test('tar -c (create) is not flagged as extraction', () => {
		const result = detectPosixWrites('tar -cf archive.tar dir/');
		expect(result.hasWrites).toBe(false);
	});

	test('unzip extracts archive', () => {
		expectWrites('unzip archive.zip', [
			{ category: 'archive_extract', operator: 'unzip', path: 'archive.zip' },
		]);
	});

	test('unzip with -d (extract to dir)', () => {
		expectWrites('unzip -d outdir archive.zip', [
			{ category: 'archive_extract', operator: 'unzip', path: 'archive.zip' },
		]);
	});

	test('gunzip decompresses', () => {
		expectWrites('gunzip file.gz', [
			{
				category: 'archive_extract',
				operator: 'gunzip [decompress]',
				path: 'file.gz',
			},
		]);
	});

	test('gzip -d (decompress)', () => {
		expectWrites('gzip -d data.tar.gz', [
			{
				category: 'archive_extract',
				operator: 'gzip [decompress]',
				path: 'data.tar.gz',
			},
		]);
	});

	test('bzip2 -d (decompress)', () => {
		expectWrites('bzip2 -d archive.bz2', [
			{
				category: 'archive_extract',
				operator: 'bzip2 [decompress]',
				path: 'archive.bz2',
			},
		]);
	});
});

// ---------------------------------------------------------------------------
// Category 8: Git destructive operations
// ---------------------------------------------------------------------------

describe('git destructive operations', () => {
	test('git checkout -- path', () => {
		expectWrites('git checkout -- src/index.ts', [
			{
				category: 'git_destructive',
				operator: 'git checkout --',
				path: 'src/index.ts',
			},
		]);
	});

	test('git checkout -- . (discard all)', () => {
		expectWrites('git checkout -- .', [
			{ category: 'git_destructive', operator: 'git checkout -- .', path: '.' },
		]);
	});

	test('git restore --hard', () => {
		expectWrites('git restore --hard', [
			{ category: 'git_destructive', operator: 'git restore', path: null },
		]);
	});

	test('git restore --hard with path', () => {
		expectWrites('git restore --hard -- source/file.ts', [
			{
				category: 'git_destructive',
				operator: 'git restore',
				path: 'source/file.ts',
			},
		]);
	});

	test('git restore -H (variant)', () => {
		expectWrites('git restore -H', [
			{ category: 'git_destructive', operator: 'git restore', path: null },
		]);
	});

	test('git reset --hard', () => {
		expectWrites('git reset --hard HEAD~1', [
			{ category: 'git_destructive', operator: 'git reset --hard', path: null },
		]);
	});

	test('git reset -H (variant)', () => {
		expectWrites('git reset -H', [
			{ category: 'git_destructive', operator: 'git reset --hard', path: null },
		]);
	});

	test('git clean -fd', () => {
		expectWrites('git clean -fd', [
			{ category: 'git_destructive', operator: 'git clean -fd', path: null },
		]);
	});

	test('git clean -fdn (dry run) is not flagged', () => {
		const result = detectPosixWrites('git clean -fdn');
		expect(result.hasWrites).toBe(false);
	});

	test('git checkout without -- is not flagged', () => {
		const result = detectPosixWrites('git checkout main');
		expect(result.hasWrites).toBe(false);
	});

	test('git reset without --hard is not flagged', () => {
		const result = detectPosixWrites('git reset HEAD~1');
		expect(result.hasWrites).toBe(false);
	});

	test('git clean without -fd is not flagged', () => {
		const result = detectPosixWrites('git clean -f');
		expect(result.hasWrites).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Edge cases: subshells, pipelines, command substitution
// ---------------------------------------------------------------------------

describe('edge cases — compound structures', () => {
	test('pipeline: both sides scanned for writes', () => {
		expectWrites('cat a.txt | tee b.txt > c.txt', [
			// tee b.txt writes to b.txt; > c.txt is the redirect on the whole pipeline
			{ category: 'redirect', operator: '>', path: 'c.txt' },
			// tee writes b.txt — this is a builtin with a path arg
			// (tee isn't in our builtin list, so it won't be detected)
		]);
	});

	test('subshell: write inside subshell', () => {
		expectWrites('(cp a b; echo done) > out.txt', [
			{ category: 'redirect', operator: '>', path: 'out.txt' },
			{ category: 'builtin_write', operator: 'cp', path: 'b' },
		]);
	});

	test('logical expression: both sides scanned', () => {
		expectWrites('test -f file && cp src dst', [
			{ category: 'builtin_write', operator: 'cp', path: 'dst' },
		]);
	});

	test('logical OR: second command scanned', () => {
		expectWrites('test -f file || echo not found', [
			// echo not found is not a write; || is not write
		]);
		expect(detectPosixWrites('test -f file || echo not found').hasWrites).toBe(
			false,
		);
	});

	test('brace group with redirect', () => {
		expectWrites('{ echo hello; } > out.txt', [
			{ category: 'redirect', operator: '>', path: 'out.txt' },
		]);
	});
});

// ---------------------------------------------------------------------------
// Edge cases: graceful failure
// ---------------------------------------------------------------------------

describe('graceful failure', () => {
	test('null command returns empty writes', () => {
		// @ts-expect-error — intentional invalid input
		expect(detectPosixWrites(null).hasWrites).toBe(false);
		// @ts-expect-error — intentional invalid input
		expect(detectPosixWrites(undefined).hasWrites).toBe(false);
	});

	test('non-string input returns empty writes', () => {
		// @ts-expect-error — intentional invalid input
		expect(detectPosixWrites(123 as unknown as string).hasWrites).toBe(false);
	});

	test('unparseable command returns empty writes (fail gracefully)', () => {
		// bash-parser throws on some invalid syntax; we catch it
		const result = detectPosixWrites('echo ${invalid}');
		// This is actually valid bash, but some edge cases may throw
		// The important thing is we return a WriteAnalysis, not throw
		expect(Array.isArray(result.writes)).toBe(true);
	});

	test('returns WriteAnalysis shape even on error', () => {
		// @ts-expect-error
		const result = detectPosixWrites(null);
		expect(typeof result.hasWrites).toBe('boolean');
		expect(Array.isArray(result.writes)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe('deduplication', () => {
	test('same target not reported twice from multiple categories', () => {
		// A command like: cp src dst > dst
		// Both builtin and redirect target dst
		const result = detectPosixWrites('cp src dst > dst');
		// Should deduplicate: only one entry for 'dst'
		const paths = result.writes.filter((w) => w.path === 'dst');
		expect(paths.length).toBe(1);
	});

	test('multiple same redirects deduplicated', () => {
		const result = detectPosixWrites('echo a > f; echo b > f');
		const fWrites = result.writes.filter((w) => w.path === 'f');
		expect(fWrites.length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Windows: PowerShell redirection operators
// ---------------------------------------------------------------------------

describe('Windows PowerShell — redirect operators', () => {
	function ps(command: string) {
		return detectWindowsWrites(command, 'powershell');
	}

	test('detects > (redirect output)', () => {
		expect(ps('echo hello > file.txt').writes).toEqual([
			{ category: 'redirect', operator: '>', path: 'file.txt' },
		]);
	});

	test('detects >> (append output)', () => {
		expect(ps('echo world >> log.txt').writes).toEqual([
			{ category: 'redirect', operator: '>>', path: 'log.txt' },
		]);
	});

	test('detects redirect on cmdlet output', () => {
		const result = ps('Get-Process > processes.txt');
		expect(result.writes).toEqual([
			{ category: 'redirect', operator: '>', path: 'processes.txt' },
		]);
	});

	test('detects redirect on piped command', () => {
		const result = ps(
			'Get-Content input.txt | Select-String foo > results.txt',
		);
		expect(result.writes).toEqual([
			{ category: 'redirect', operator: '>', path: 'results.txt' },
		]);
	});

	test('fd redirect 2>&1 is not flagged as write', () => {
		const result = ps('cmd 2>&1');
		expect(result.hasWrites).toBe(false);
	});

	test('empty command has no writes', () => {
		expect(ps('').hasWrites).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Windows: PowerShell file-writing cmdlets
// ---------------------------------------------------------------------------

describe('Windows PowerShell — file-writing cmdlets', () => {
	function ps(command: string) {
		return detectWindowsWrites(command, 'powershell');
	}

	test('Set-Content with -Path flag writes to file', () => {
		expect(ps('Set-Content -Path file.txt -Value "hello"').writes).toEqual([
			{ category: 'redirect', operator: 'Set-Content', path: 'file.txt' },
		]);
	});

	test('Out-File with positional path', () => {
		expect(ps('Out-File output.txt').writes).toEqual([
			{ category: 'redirect', operator: 'Out-File', path: 'output.txt' },
		]);
	});

	test('Set-Content writes to file', () => {
		expect(ps('Set-Content path.txt "content"').writes).toEqual([
			{ category: 'redirect', operator: 'Set-Content', path: 'path.txt' },
		]);
	});

	test('Add-Content appends to file', () => {
		expect(ps('Add-Content log.txt "new line"').writes).toEqual([
			{ category: 'redirect', operator: 'Add-Content', path: 'log.txt' },
		]);
	});

	test('Clear-Content clears file', () => {
		expect(ps('Clear-Content data.txt').writes).toEqual([
			{ category: 'redirect', operator: 'Clear-Content', path: 'data.txt' },
		]);
	});

	test('Copy-Item copies file', () => {
		expect(ps('Copy-Item source.txt dest.txt').writes).toEqual([
			{ category: 'builtin_write', operator: 'Copy-Item', path: 'dest.txt' },
		]);
	});

	test('Copy-Item with -Path flag', () => {
		expect(ps('Copy-Item -Path src.txt -Destination dst.txt').writes).toEqual([
			{ category: 'builtin_write', operator: 'Copy-Item', path: 'dst.txt' },
		]);
	});

	test('Move-Item moves file', () => {
		expect(ps('Move-Item old.txt new.txt').writes).toEqual([
			{ category: 'builtin_write', operator: 'Move-Item', path: 'new.txt' },
		]);
	});

	test('Remove-Item deletes file', () => {
		expect(ps('Remove-Item file.txt').writes).toEqual([
			{ category: 'builtin_write', operator: 'Remove-Item', path: 'file.txt' },
		]);
	});

	test('Remove-Item with -Recurse', () => {
		expect(ps('Remove-Item -Path dir -Recurse').writes).toEqual([
			{ category: 'builtin_write', operator: 'Remove-Item', path: 'dir' },
		]);
	});

	test('quoted path in Copy-Item', () => {
		expect(ps('Copy-Item "source.txt" "dest.txt"').writes).toEqual([
			{ category: 'builtin_write', operator: 'Copy-Item', path: 'dest.txt' },
		]);
	});

	// Regression: Issue 1 — non-canonical flag order was capturing -Value as the path
	test('Set-Content with non-canonical flag order (-Value before -Path)', () => {
		expect(ps('Set-Content -Value hello -Path file.txt').writes).toEqual([
			{ category: 'redirect', operator: 'Set-Content', path: 'file.txt' },
		]);
	});

	test('Out-File with non-canonical flag order (-Value before -Path)', () => {
		expect(ps('Out-File -Value "data" -Path output.txt').writes).toEqual([
			{ category: 'redirect', operator: 'Out-File', path: 'output.txt' },
		]);
	});

	test('Set-Content with -FilePath flag', () => {
		expect(
			ps('Set-Content -FilePath config.ini -Value "settings"').writes,
		).toEqual([
			{ category: 'redirect', operator: 'Set-Content', path: 'config.ini' },
		]);
	});

	test('Set-Content with -LiteralPath flag', () => {
		expect(
			ps('Add-Content -LiteralPath "C:\\path\\file.txt" -Value "data"').writes,
		).toEqual([
			{
				category: 'redirect',
				operator: 'Add-Content',
				path: 'C:\\path\\file.txt',
			},
		]);
	});

	test('Set-Content with quoted path containing spaces', () => {
		expect(
			ps('Set-Content -Path "C:\\path with spaces\\file.txt" -Value data')
				.writes,
		).toEqual([
			{
				category: 'redirect',
				operator: 'Set-Content',
				path: 'C:\\path with spaces\\file.txt',
			},
		]);
	});
});

// ---------------------------------------------------------------------------
// Windows: PowerShell Invoke-WebRequest and Start-Process
// ---------------------------------------------------------------------------

describe('Windows PowerShell — network and process', () => {
	function ps(command: string) {
		return detectWindowsWrites(command, 'powershell');
	}

	test('Invoke-WebRequest -OutFile flags as network download', () => {
		expect(
			ps(
				'Invoke-WebRequest -Url https://example.com/file.zip -OutFile output.zip',
			).writes,
		).toEqual([
			{
				category: 'network_download',
				operator: 'Invoke-WebRequest -OutFile',
				path: 'output.zip',
			},
		]);
	});

	test('curl -o in PowerShell context detected via IWR regex', () => {
		expect(ps('curl -o page.html https://example.com').writes).toEqual([
			{
				category: 'network_download',
				operator: 'Invoke-WebRequest -OutFile',
				path: 'page.html',
			},
		]);
	});
	// Start-Process is no longer detected in detectPowerShellWrites — it is
	// handled by detectInteractiveSession instead (avoids double-detection).
});

// ---------------------------------------------------------------------------
// Windows: cmd.exe redirect operators
// ---------------------------------------------------------------------------

describe('Windows cmd.exe — redirect operators', () => {
	function cmd(command: string) {
		return detectWindowsWrites(command, 'cmd');
	}

	test('detects > (redirect output)', () => {
		expect(cmd('echo hello > file.txt').writes).toEqual([
			{ category: 'redirect', operator: '>', path: 'file.txt' },
		]);
	});

	test('detects >> (append output)', () => {
		expect(cmd('echo world >> log.txt').writes).toEqual([
			{ category: 'redirect', operator: '>>', path: 'log.txt' },
		]);
	});

	test('fd redirect 2>&1 is not flagged', () => {
		expect(cmd('cmd 2>&1').hasWrites).toBe(false);
	});

	test('redirect on builtin', () => {
		expect(cmd('dir > listing.txt').writes).toEqual([
			{ category: 'redirect', operator: '>', path: 'listing.txt' },
		]);
	});

	test('empty command has no writes', () => {
		expect(cmd('').hasWrites).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Windows: cmd.exe builtins
// ---------------------------------------------------------------------------

describe('Windows cmd.exe — builtin commands', () => {
	function cmd(command: string) {
		return detectWindowsWrites(command, 'cmd');
	}

	test('copy builtin with destination', () => {
		expect(cmd('copy src.txt dst.txt').writes).toEqual([
			{ category: 'builtin_write', operator: 'copy', path: 'dst.txt' },
		]);
	});

	test('copy with quoted paths', () => {
		expect(cmd('copy "source.txt" "dest.txt"').writes).toEqual([
			{ category: 'builtin_write', operator: 'copy', path: 'dest.txt' },
		]);
	});

	test('move builtin with destination', () => {
		expect(cmd('move old.txt new.txt').writes).toEqual([
			{ category: 'builtin_write', operator: 'move', path: 'new.txt' },
		]);
	});

	test('ren builtin renames file', () => {
		expect(cmd('ren oldname.txt newname.txt').writes).toEqual([
			{ category: 'builtin_write', operator: 'ren', path: 'newname.txt' },
		]);
	});

	test('del builtin deletes file', () => {
		expect(cmd('del file.txt').writes).toEqual([
			{ category: 'builtin_write', operator: 'del', path: 'file.txt' },
		]);
	});

	test('del with /f /q flags still detects path', () => {
		const result = cmd('del /f /q file.txt');
		expect(result.writes).toEqual([
			{ category: 'builtin_write', operator: 'del', path: 'file.txt' },
		]);
	});

	test('rd builtin removes directory', () => {
		expect(cmd('rd /s /q dirname').writes).toEqual([
			{ category: 'builtin_write', operator: 'rd', path: 'dirname' },
		]);
	});

	test('md builtin creates directory', () => {
		expect(cmd('md newdir').writes).toEqual([
			{ category: 'builtin_write', operator: 'md', path: 'newdir' },
		]);
	});

	test('type builtin is read-only (not flagged)', () => {
		const result = cmd('type file.txt');
		expect(result.hasWrites).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Windows: cmd.exe echo/set with redirection
// ---------------------------------------------------------------------------

describe('Windows cmd.exe — echo and set with redirection', () => {
	function cmd(command: string) {
		return detectWindowsWrites(command, 'cmd');
	}

	test('echo with redirect', () => {
		expect(cmd('echo hello > file.txt').writes).toEqual([
			{ category: 'redirect', operator: '>', path: 'file.txt' },
		]);
	});

	test('echo >> append redirect', () => {
		expect(cmd('echo line >> log.txt').writes).toEqual([
			{ category: 'redirect', operator: '>>', path: 'log.txt' },
		]);
	});

	test('echo. with redirect', () => {
		expect(cmd('echo. > blank.txt').writes).toEqual([
			{ category: 'redirect', operator: '>', path: 'blank.txt' },
		]);
	});

	test('set with redirect', () => {
		expect(cmd('set VAR=value > env.txt').writes).toEqual([
			{ category: 'redirect', operator: '>', path: 'env.txt' },
		]);
	});
});

// ---------------------------------------------------------------------------
// Windows: compound commands and pipelines
// ---------------------------------------------------------------------------

describe('Windows — compound commands and pipelines', () => {
	test('pipeline: both sides scanned for writes (PowerShell)', () => {
		const result = detectWindowsWrites(
			'Get-Content a.txt | Select-String foo > results.txt',
			'powershell',
		);
		expect(result.writes).toEqual([
			{ category: 'redirect', operator: '>', path: 'results.txt' },
		]);
	});

	test('pipeline: both sides scanned for writes (cmd)', () => {
		const result = detectWindowsWrites(
			'type a.txt | find "foo" > results.txt',
			'cmd',
		);
		expect(result.writes).toEqual([
			{ category: 'redirect', operator: '>', path: 'results.txt' },
		]);
	});

	test('logical AND: both sides scanned (PowerShell)', () => {
		const result = detectWindowsWrites(
			'Test-Path file.txt && Copy-Item src dst',
			'powershell',
		);
		expect(result.writes).toEqual([
			{ category: 'builtin_write', operator: 'Copy-Item', path: 'dst' },
		]);
	});

	test('logical OR: second command scanned (cmd)', () => {
		const result = detectWindowsWrites('if exist file.txt copy src dst', 'cmd');
		// if exist is read-only; copy is write
		expect(result.writes).toEqual([
			{ category: 'builtin_write', operator: 'copy', path: 'dst' },
		]);
	});

	test('empty sub-command in pipeline is handled', () => {
		const result = detectWindowsWrites('cmd1 | | cmd2', 'cmd');
		expect(result.hasWrites).toBe(false);
	});

	// Regression: Issue 2 — single & separator was not splitting commands
	test('single & separator splits cmd.exe commands', () => {
		const result = detectWindowsWrites('copy a.txt b.txt & del c.txt', 'cmd');
		expect(result.writes).toContainEqual({
			category: 'builtin_write',
			operator: 'copy',
			path: 'b.txt',
		});
		expect(result.writes).toContainEqual({
			category: 'builtin_write',
			operator: 'del',
			path: 'c.txt',
		});
	});

	test('single & separator in PowerShell splits commands', () => {
		const result = detectWindowsWrites(
			'Write-Output "hello" & Remove-Item file.txt',
			'powershell',
		);
		expect(result.writes).toContainEqual({
			category: 'builtin_write',
			operator: 'Remove-Item',
			path: 'file.txt',
		});
	});

	test('single & not treated as && (different separator)', () => {
		// cmd.exe: single & means sequential; && means conditional
		// Both copy and del should be detected
		const result = detectWindowsWrites('copy a.txt b.txt & del c.txt', 'cmd');
		expect(result.writes.length).toBeGreaterThanOrEqual(2);
	});
});

// ---------------------------------------------------------------------------
// Windows: graceful failure
// ---------------------------------------------------------------------------

describe('Windows — graceful failure', () => {
	test('null command returns empty writes', () => {
		// @ts-expect-error — intentional invalid input
		expect(detectWindowsWrites(null, 'powershell').hasWrites).toBe(false);
		// @ts-expect-error — intentional invalid input
		expect(detectWindowsWrites(null, 'cmd').hasWrites).toBe(false);
	});

	// mut-004: guard-removal mutant would break null/undefined handling
	test('detectWindowsWrites handles null input gracefully', () => {
		// @ts-expect-error — intentional invalid input
		expect(detectWindowsWrites(null, 'powershell')).toEqual({
			writes: [],
			hasWrites: false,
		});
		// @ts-expect-error — intentional invalid input
		expect(detectWindowsWrites(null, 'cmd')).toEqual({
			writes: [],
			hasWrites: false,
		});
	});

	test('undefined command returns empty writes', () => {
		// @ts-expect-error — intentional invalid input
		expect(detectWindowsWrites(undefined, 'powershell').hasWrites).toBe(false);
		// @ts-expect-error — intentional invalid input
		expect(detectWindowsWrites(undefined, 'cmd').hasWrites).toBe(false);
	});

	test('non-string input returns empty writes', () => {
		// @ts-expect-error — intentional invalid input
		expect(
			detectWindowsWrites(123 as unknown as string, 'powershell').hasWrites,
		).toBe(false);
		// @ts-expect-error — intentional invalid input
		expect(detectWindowsWrites(123 as unknown as string, 'cmd').hasWrites).toBe(
			false,
		);
	});

	test('returns WriteAnalysis shape even on invalid input', () => {
		// @ts-expect-error
		const result = detectWindowsWrites(null, 'powershell');
		expect(typeof result.hasWrites).toBe('boolean');
		expect(Array.isArray(result.writes)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Windows: deduplication
// ---------------------------------------------------------------------------

describe('Windows — deduplication', () => {
	test('same target not reported twice (PowerShell)', () => {
		const result = detectWindowsWrites(
			'Set-Content file.txt "a"; Set-Content file.txt "b"',
			'powershell',
		);
		const fileWrites = result.writes.filter((w) => w.path === 'file.txt');
		expect(fileWrites.length).toBe(1);
	});

	test('same target not reported twice (cmd)', () => {
		const result = detectWindowsWrites(
			'copy a.txt b.txt & copy a.txt b.txt',
			'cmd',
		);
		const bWrites = result.writes.filter((w) => w.path === 'b.txt');
		expect(bWrites.length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// resolveWriteTargets — path resolution with subshell tracking
// ---------------------------------------------------------------------------

describe('resolveWriteTargets — basic resolution', () => {
	test('resolves relative path against cwd', () => {
		const writes = [{ category: 'redirect', operator: '>', path: 'file.txt' }];
		const result = resolveWriteTargets(
			'echo hello > file.txt',
			writes,
			'/home/user',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toBe('/home/user/file.txt');
		expect(result[0].resolved).toBe(true);
	});

	test('passes through absolute path unchanged', () => {
		const writes = [
			{ category: 'redirect', operator: '>', path: '/tmp/out.txt' },
		];
		const result = resolveWriteTargets(
			'echo hello > /tmp/out.txt',
			writes,
			'/home/user',
		);
		expect(result[0].resolvedPath).toBe('/tmp/out.txt');
		expect(result[0].resolved).toBe(true);
	});

	test('marks null path as unresolved', () => {
		const writes = [
			{ category: 'interpreter_eval', operator: 'node [eval]', path: null },
		];
		const result = resolveWriteTargets('node -e "code"', writes, '/home/user');
		expect(result[0].resolvedPath).toBe(null);
		expect(result[0].resolved).toBe(false);
	});

	test('marks $VAR path as unresolvable (dynamic)', () => {
		const writes = [{ category: 'redirect', operator: '>', path: '$FILE' }];
		const result = resolveWriteTargets(
			'echo hello > $FILE',
			writes,
			'/home/user',
		);
		expect(result[0].resolvedPath).toBe(null);
		expect(result[0].resolved).toBe(false);
	});

	test('marks ${VAR} path as unresolvable (dynamic)', () => {
		const writes = [
			{ category: 'redirect', operator: '>', path: '${OUTPUT_FILE}' },
		];
		const result = resolveWriteTargets(
			'echo hello > ${OUTPUT_FILE}',
			writes,
			'/home/user',
		);
		expect(result[0].resolvedPath).toBe(null);
		expect(result[0].resolved).toBe(false);
	});

	test('marks $(cmd) substitution as unresolvable (dynamic)', () => {
		const writes = [
			{ category: 'redirect', operator: '>', path: '$(cat filename)' },
		];
		const result = resolveWriteTargets(
			'echo hello > $(cat filename)',
			writes,
			'/home/user',
		);
		expect(result[0].resolvedPath).toBe(null);
		expect(result[0].resolved).toBe(false);
	});

	test('marks backtick substitution as unresolvable (dynamic)', () => {
		const writes = [
			{ category: 'redirect', operator: '>', path: '`pwd`/file.txt' },
		];
		const result = resolveWriteTargets(
			'echo hello > `pwd`/file.txt',
			writes,
			'/home/user',
		);
		expect(result[0].resolvedPath).toBe(null);
		expect(result[0].resolved).toBe(false);
	});

	test('preserves original write target in result', () => {
		const writes = [{ category: 'redirect', operator: '>', path: 'file.txt' }];
		const result = resolveWriteTargets(
			'echo hello > file.txt',
			writes,
			'/home/user',
		);
		expect(result[0].original).toEqual({
			category: 'redirect',
			operator: '>',
			path: 'file.txt',
		});
	});

	test('empty writes array returns empty result', () => {
		const result = resolveWriteTargets(
			'echo hello > file.txt',
			[],
			'/home/user',
		);
		expect(result).toEqual([]);
	});

	test('handles null input gracefully', () => {
		const writes = [{ category: 'redirect', operator: '>', path: 'file.txt' }];
		// @ts-expect-error — intentional invalid input
		const result = resolveWriteTargets(null, writes, '/home/user');
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toBe('/home/user/file.txt');
		expect(result[0].resolved).toBe(true);
	});
});

describe('resolveWriteTargets — subshell cd tracking', () => {
	test('subshell cd changes effective cwd for writes inside', () => {
		// (cd /tmp && echo x > file) — file resolves to /tmp/file
		const writes = [{ category: 'redirect', operator: '>', path: 'file' }];
		const result = resolveWriteTargets(
			'(cd /tmp && echo x > file)',
			writes,
			'/home/user',
		);
		expect(result[0].resolvedPath).toBe('/tmp/file');
		expect(result[0].resolved).toBe(true);
	});

	test('cd in parent shell propagates to subshell entry cwd', () => {
		// cd /tmp && (echo x > file) — cd is in parent, subshell inherits it
		const writes = [{ category: 'redirect', operator: '>', path: 'file' }];
		const result = resolveWriteTargets(
			'cd /tmp && (echo x > file)',
			writes,
			'/home/user',
		);
		// The subshell inherits parent's cwd at subshell entry time.
		// Since cd /tmp happens BEFORE the subshell, the subshell starts at /tmp.
		// So file resolves to /tmp/file.
		expect(result[0].resolvedPath).toBe('/tmp/file');
		expect(result[0].resolved).toBe(true);
	});

	test('nested subshells track cwd independently', () => {
		// ( (cd /home && echo x > file) ) — file resolves to /home/file
		const writes = [{ category: 'redirect', operator: '>', path: 'file' }];
		const result = resolveWriteTargets(
			'( (cd /home && echo x > file) )',
			writes,
			'/',
		);
		expect(result[0].resolvedPath).toBe('/home/file');
		expect(result[0].resolved).toBe(true);
	});

	test('multiple writes in subshell all use same effective cwd', () => {
		// (cd /tmp && echo a > a.txt && echo b > b.txt)
		const analysis = detectPosixWrites(
			'(cd /tmp && echo a > a.txt && echo b > b.txt)',
		);
		const result = resolveWriteTargets(
			'(cd /tmp && echo a > a.txt && echo b > b.txt)',
			analysis.writes,
			'/home/user',
		);
		const aWrite = result.find((r) => r.original.path === 'a.txt');
		const bWrite = result.find((r) => r.original.path === 'b.txt');
		expect(aWrite?.resolvedPath).toBe('/tmp/a.txt');
		expect(bWrite?.resolvedPath).toBe('/tmp/b.txt');
	});

	test('cd without subshell does not persist after command', () => {
		// cd /tmp && echo hello — no write target, so just verify context
		const analysis = detectPosixWrites('cd /tmp && echo hello');
		const result = resolveWriteTargets(
			'cd /tmp && echo hello',
			analysis.writes,
			'/home/user',
		);
		// echo hello has no redirect, so writes is empty
		expect(result).toEqual([]);
	});

	test('relative path after cd in subshell resolves correctly', () => {
		// (cd /var/log && tail -f syslog) — no write but tests context tracking
		const writes = [{ category: 'redirect', operator: '>>', path: 'app.log' }];
		const result = resolveWriteTargets(
			'(cd /var/log && echo more >> app.log)',
			writes,
			'/home/user',
		);
		expect(result[0].resolvedPath).toBe('/var/log/app.log');
		expect(result[0].resolved).toBe(true);
	});
});

describe('resolveWriteTargets — multiple writes with different contexts', () => {
	test('write inside subshell vs write outside subshell have different contexts', () => {
		// cd /tmp && (echo inside > file1) && echo outside > file2
		// file1 resolves to /tmp/file1 (subshell inherits cd /tmp)
		// file2 resolves to /tmp/file2 (cd /tmp already took effect in parent context)
		const analysis = detectPosixWrites(
			'cd /tmp && (echo inside > file1) && echo outside > file2',
		);
		const result = resolveWriteTargets(
			'cd /tmp && (echo inside > file1) && echo outside > file2',
			analysis.writes,
			'/home/user',
		);
		const file1Write = result.find((r) => r.original.path === 'file1');
		const file2Write = result.find((r) => r.original.path === 'file2');
		// file1 is inside subshell that started at /tmp (cd /tmp happened before subshell)
		expect(file1Write?.resolvedPath).toBe('/tmp/file1');
		// file2 is outside, at global level after cd /tmp already took effect
		expect(file2Write?.resolvedPath).toBe('/tmp/file2');
	});
});

describe('resolveWriteTargets — subshell cd does not leak to parent', () => {
	// Regression: F1 — POSIX subshell (...) does NOT propagate cd mutations to parent
	test('(cd /tmp && echo a > a.txt); echo b > b.txt → a.txt=/tmp/a.txt, b.txt=<cwd>/b.txt', () => {
		const analysis = detectPosixWrites(
			'(cd /tmp && echo a > a.txt); echo b > b.txt',
		);
		const result = resolveWriteTargets(
			'(cd /tmp && echo a > a.txt); echo b > b.txt',
			analysis.writes,
			'/home/user',
		);
		const aWrite = result.find((r) => r.original.path === 'a.txt');
		const bWrite = result.find((r) => r.original.path === 'b.txt');
		// a.txt is inside subshell: cd /tmp took effect inside the subshell
		expect(aWrite?.resolvedPath).toBe('/tmp/a.txt');
		// b.txt is outside subshell: parent cwd remains /home/user
		expect(bWrite?.resolvedPath).toBe('/home/user/b.txt');
	});

	test('cd inside (...) subshell does not affect subsequent commands outside', () => {
		// (cd /tmp && echo > inner.txt) && echo > outer.txt
		const analysis = detectPosixWrites(
			'(cd /tmp && echo > inner.txt) && echo > outer.txt',
		);
		const result = resolveWriteTargets(
			'(cd /tmp && echo > inner.txt) && echo > outer.txt',
			analysis.writes,
			'/project',
		);
		const innerWrite = result.find((r) => r.original.path === 'inner.txt');
		const outerWrite = result.find((r) => r.original.path === 'outer.txt');
		expect(innerWrite?.resolvedPath).toBe('/tmp/inner.txt');
		expect(outerWrite?.resolvedPath).toBe('/project/outer.txt');
	});
});

describe('resolveWriteTargets — relative cd path resolution', () => {
	// Regression: F2 — relative `cd subdir` must resolve against current cwd, not store raw string
	test('cd src && echo hello > output.txt resolves to <cwd>/src/output.txt', () => {
		const analysis = detectPosixWrites('cd src && echo hello > output.txt');
		const result = resolveWriteTargets(
			'cd src && echo hello > output.txt',
			analysis.writes,
			'/home/user',
		);
		const outWrite = result.find((r) => r.original.path === 'output.txt');
		expect(outWrite?.resolvedPath).toBe('/home/user/src/output.txt');
	});

	test('cd subdir in CompoundList resolves relative target', () => {
		// cd subdir && (cd nested && echo > file.txt) — first cd resolves, then nested cd resolves
		const analysis = detectPosixWrites(
			'cd subdir && (cd nested && echo > file.txt)',
		);
		const result = resolveWriteTargets(
			'cd subdir && (cd nested && echo > file.txt)',
			analysis.writes,
			'/workspace',
		);
		const fileWrite = result.find((r) => r.original.path === 'file.txt');
		// nested cd is relative to subdir, so /workspace/subdir/nested/file.txt
		expect(fileWrite?.resolvedPath).toBe('/workspace/subdir/nested/file.txt');
	});

	test('cd ../../parent resolves multi-level relative path', () => {
		const writes = [{ category: 'redirect', operator: '>', path: 'out.txt' }];
		const result = resolveWriteTargets(
			'cd ../../parent && echo > out.txt',
			writes,
			'/home/user/project/src',
		);
		expect(result[0].resolvedPath).toBe('/home/user/parent/out.txt');
	});
});

describe('resolveWriteTargets — edge cases', () => {
	test('handles path with .. components', () => {
		const writes = [
			{ category: 'redirect', operator: '>', path: '../file.txt' },
		];
		const result = resolveWriteTargets(
			'echo hello > ../file.txt',
			writes,
			'/home/user/project',
		);
		expect(result[0].resolvedPath).toBe('/home/user/file.txt');
		expect(result[0].resolved).toBe(true);
	});

	test('handles path with tilde (not expanded, treated as literal)', () => {
		// ~ is not a dynamic var, but it's a shell special that should be passed through
		const writes = [
			{ category: 'redirect', operator: '>', path: '~/file.txt' },
		];
		const result = resolveWriteTargets(
			'echo hello > ~/file.txt',
			writes,
			'/home/user',
		);
		// resolve treats ~/ as a literal relative path under cwd
		expect(result[0].resolvedPath).toBe('/home/user/~/file.txt');
		expect(result[0].resolved).toBe(true);
	});

	test('builtin write (cp) resolves relative destination', () => {
		const writes = [
			{ category: 'builtin_write', operator: 'cp', path: 'backup.txt' },
		];
		const result = resolveWriteTargets(
			'cp src.txt backup.txt',
			writes,
			'/home/user',
		);
		expect(result[0].resolvedPath).toBe('/home/user/backup.txt');
		expect(result[0].resolved).toBe(true);
	});

	test('sed -i inplace edit resolves relative path', () => {
		const writes = [
			{ category: 'inplace_edit', operator: 'sed -i', path: 'data.csv' },
		];
		const result = resolveWriteTargets(
			'sed -i "s/a/b/" data.csv',
			writes,
			'/workspace',
		);
		expect(result[0].resolvedPath).toBe('/workspace/data.csv');
		expect(result[0].resolved).toBe(true);
	});

	test('unparseable command falls back to global cwd', () => {
		const writes = [{ category: 'redirect', operator: '>', path: 'file.txt' }];
		const result = resolveWriteTargets(
			'invalid syntax {{{',
			writes,
			'/home/user',
		);
		// Falls back to global cwd when parse fails
		expect(result[0].resolvedPath).toBe('/home/user/file.txt');
		expect(result[0].resolved).toBe(true);
	});

	test('git destructive with path resolves relative path', () => {
		const writes = [
			{
				category: 'git_destructive',
				operator: 'git checkout --',
				path: 'src/index.ts',
			},
		];
		const result = resolveWriteTargets(
			'git checkout -- src/index.ts',
			writes,
			'/project',
		);
		expect(result[0].resolvedPath).toBe('/project/src/index.ts');
		expect(result[0].resolved).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Process substitution writes (bash)
// ---------------------------------------------------------------------------

describe('process substitution — POSIX bash', () => {
	test('tee >(cat > file.txt) detects write to file.txt', () => {
		// The >(...) process substitution runs `cat > file.txt` as a background write.
		// bash-parser cannot parse this, so we use regex fallback.
		const result = detectPosixWrites('tee >(cat > file.txt)');
		expect(result.hasWrites).toBe(true);
		expect(result.writes).toContainEqual({
			category: 'redirect',
			operator: '>',
			path: 'file.txt',
		});
	});

	test('echo hello | tee >(cat > file.txt) detects write', () => {
		// tee receives input, forwards to stdout AND to >(cat > file.txt)
		const result = detectPosixWrites('echo hello | tee >(cat > file.txt)');
		expect(result.hasWrites).toBe(true);
		expect(result.writes).toContainEqual({
			category: 'redirect',
			operator: '>',
			path: 'file.txt',
		});
	});

	test('diff <(old.txt) <(new.txt) does NOT detect writes (read-only)', () => {
		// <(...) is read-only process substitution (Less operator).
		// No writes should be detected.
		const result = detectPosixWrites('diff <(cat old.txt) <(cat new.txt)');
		// bash-parser cannot parse <(...) either; the <(...) patterns are read-only
		// so no writes are detected (the fallback produces no results for < patterns)
		expect(result.hasWrites).toBe(false);
	});

	test('process substitution with cp inside >(cp src dst)', () => {
		// cp inside process substitution should be detected as builtin write
		const result = detectPosixWrites('tee >(cp src.txt dst.txt)');
		expect(result.hasWrites).toBe(true);
		expect(result.writes).toContainEqual({
			category: 'builtin_write',
			operator: 'cp',
			path: 'dst.txt',
		});
	});

	test('multiple process substitutions with >(cmd) writes', () => {
		const result = detectPosixWrites('tee >(cat > a.txt) >(cat > b.txt)');
		expect(result.hasWrites).toBe(true);
		expect(result.writes).toContainEqual({
			category: 'redirect',
			operator: '>',
			path: 'a.txt',
		});
		expect(result.writes).toContainEqual({
			category: 'redirect',
			operator: '>',
			path: 'b.txt',
		});
	});
});

// ---------------------------------------------------------------------------
// PowerShell pipeline output — Get-Content | Out-File
// ---------------------------------------------------------------------------

describe('Windows PowerShell — pipeline output detection', () => {
	function ps(command: string) {
		return detectWindowsWrites(command, 'powershell');
	}

	test('Get-Content input.txt | Out-File output.txt detects write', () => {
		// Out-File after a pipe should detect output.txt as the write target
		const result = ps('Get-Content input.txt | Out-File output.txt');
		expect(result.hasWrites).toBe(true);
		expect(result.writes).toContainEqual({
			category: 'redirect',
			operator: 'Out-File',
			path: 'output.txt',
		});
	});

	test('Get-Content input.txt | Set-Content output.txt detects write', () => {
		const result = ps('Get-Content input.txt | Set-Content output.txt');
		expect(result.hasWrites).toBe(true);
		expect(result.writes).toContainEqual({
			category: 'redirect',
			operator: 'Set-Content',
			path: 'output.txt',
		});
	});

	test('Get-Content input.txt | Out-File -FilePath output.txt detects write with flag', () => {
		const result = ps('Get-Content input.txt | Out-File -FilePath output.txt');
		expect(result.hasWrites).toBe(true);
		expect(result.writes).toContainEqual({
			category: 'redirect',
			operator: 'Out-File',
			path: 'output.txt',
		});
	});

	test('pipeline with Add-Content after pipe detects append', () => {
		const result = ps('Get-Content input.txt | Add-Content log.txt');
		expect(result.hasWrites).toBe(true);
		expect(result.writes).toContainEqual({
			category: 'redirect',
			operator: 'Add-Content',
			path: 'log.txt',
		});
	});

	test('pipeline with Copy-Item after pipe detects copy', () => {
		const result = ps(
			'Get-Content input.txt | Copy-Item -Destination dest.txt',
		);
		expect(result.hasWrites).toBe(true);
		expect(result.writes).toContainEqual({
			category: 'builtin_write',
			operator: 'Copy-Item',
			path: 'dest.txt',
		});
	});
});

// ---------------------------------------------------------------------------
// Interactive / session tool denial
// ---------------------------------------------------------------------------

describe('detectInteractiveSession — POSIX', () => {
	test('watch ls is denied (runs command repeatedly)', () => {
		expect(detectInteractiveSession('watch ls', 'posix')).toBe(true);
	});

	test('watch -n 5 ./script.sh is denied', () => {
		expect(detectInteractiveSession('watch -n 5 ./script.sh', 'posix')).toBe(
			true,
		);
	});

	test('screen is denied (terminal multiplexer)', () => {
		expect(detectInteractiveSession('screen', 'posix')).toBe(true);
	});

	test('screen -S sessionname is denied', () => {
		expect(detectInteractiveSession('screen -S mysession', 'posix')).toBe(true);
	});

	test('tmux new-session is denied', () => {
		expect(detectInteractiveSession('tmux new-session', 'posix')).toBe(true);
	});

	test('tmux new-session -s myname is denied', () => {
		expect(
			detectInteractiveSession('tmux new-session -s myname', 'posix'),
		).toBe(true);
	});

	test('tmux without subcommand is denied (starts tmux server)', () => {
		expect(detectInteractiveSession('tmux', 'posix')).toBe(true);
	});

	test('tmux attach-session is allowed (reattaches, not creating new)', () => {
		// attach-session is a read-like operation, not creating a new session
		expect(detectInteractiveSession('tmux attach-session', 'posix')).toBe(
			false,
		);
	});

	test('ls is allowed (not interactive)', () => {
		expect(detectInteractiveSession('ls', 'posix')).toBe(false);
	});

	test('echo hello is allowed (not interactive)', () => {
		expect(detectInteractiveSession('echo hello', 'posix')).toBe(false);
	});

	test('git status is allowed (not interactive)', () => {
		expect(detectInteractiveSession('git status', 'posix')).toBe(false);
	});

	test('empty string is allowed', () => {
		expect(detectInteractiveSession('', 'posix')).toBe(false);
	});
});

describe('detectInteractiveSession — PowerShell', () => {
	test('Start-Process notepad is denied', () => {
		expect(
			detectInteractiveSession('Start-Process notepad', 'powershell'),
		).toBe(true);
	});

	test('Start-Process -FilePath code.exe is denied', () => {
		expect(
			detectInteractiveSession(
				'Start-Process -FilePath code.exe',
				'powershell',
			),
		).toBe(true);
	});

	test('Start-Process with -Wait is still denied (session tool)', () => {
		expect(
			detectInteractiveSession('Start-Process notepad -Wait', 'powershell'),
		).toBe(true);
	});

	test('echo hello is allowed (not interactive)', () => {
		expect(detectInteractiveSession('echo hello', 'powershell')).toBe(false);
	});

	test('Get-Process is allowed (not interactive)', () => {
		expect(detectInteractiveSession('Get-Process', 'powershell')).toBe(false);
	});
});

describe('detectInteractiveSession — cmd', () => {
	test('cmd.exe is not affected by POSIX tools', () => {
		// tmux is a POSIX tool, not cmd
		expect(detectInteractiveSession('tmux', 'cmd')).toBe(false);
	});

	test('cmd.exe Start-Process is not detected (powershell only)', () => {
		// Start-Process is a PowerShell cmdlet, not cmd.exe
		expect(detectInteractiveSession('Start-Process notepad', 'cmd')).toBe(
			false,
		);
	});

	test('echo hello is allowed', () => {
		expect(detectInteractiveSession('echo hello', 'cmd')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// FR-002 Scope Coverage: resolveWriteTargets in-scope vs out-of-scope
// ---------------------------------------------------------------------------
// Helper: determine if a resolved path is within the project scope (cwd).
// A path is in-scope when it equals cwd OR is a child of cwd.
// A path is out-of-scope when it is outside cwd (e.g., sibling or absolute outside).
// Handles both POSIX (forward slash) and Windows (backslash) path separators.
function isInScope(resolvedPath: string | null, cwd: string): boolean {
	if (resolvedPath === null) return false;
	// Normalize both paths to forward slashes for comparison
	// On POSIX: paths are already forward slash; on Windows: path.win32.resolve returns backslashes
	const normalizedResolved = resolvedPath.replace(/\\/g, '/');
	const normalizedCwd = cwd.replace(/\\/g, '/');
	// Ensure cwd has trailing slash for accurate prefix check
	const normalizedCwdWithSlash = normalizedCwd.endsWith('/')
		? normalizedCwd
		: normalizedCwd + '/';
	return (
		normalizedResolved === normalizedCwd ||
		normalizedResolved.startsWith(normalizedCwdWithSlash)
	);
}

// ---------------------------------------------------------------------------
// Category: Redirects — scope resolution
// ---------------------------------------------------------------------------

describe('FR-002 Redirects — resolveWriteTargets scope', () => {
	test('in-scope: redirect to relative path resolves inside cwd', () => {
		const writes = [
			{ category: 'redirect', operator: '>', path: 'src/index.ts' },
		];
		const result = resolveWriteTargets(
			'echo hello > src/index.ts',
			writes,
			'/project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toBe('/project/src/index.ts');
		expect(isInScope(result[0].resolvedPath, '/project')).toBe(true);
	});

	test('out-of-scope: redirect to /tmp/file resolves outside cwd', () => {
		const writes = [
			{ category: 'redirect', operator: '>', path: '/tmp/out.txt' },
		];
		const result = resolveWriteTargets(
			'echo hello > /tmp/out.txt',
			writes,
			'/project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toBe('/tmp/out.txt');
		expect(isInScope(result[0].resolvedPath, '/project')).toBe(false);
	});

	test('in-scope: append redirect to sibling file resolves inside cwd', () => {
		const writes = [
			{ category: 'redirect', operator: '>>', path: 'logs/app.log' },
		];
		const result = resolveWriteTargets(
			'echo world >> logs/app.log',
			writes,
			'/project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toBe('/project/logs/app.log');
		expect(isInScope(result[0].resolvedPath, '/project')).toBe(true);
	});

	test('out-of-scope: redirect to /var/log resolves outside cwd', () => {
		const writes = [
			{ category: 'redirect', operator: '>', path: '/var/log/syslog' },
		];
		const result = resolveWriteTargets(
			'echo test > /var/log/syslog',
			writes,
			'/project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toBe('/var/log/syslog');
		expect(isInScope(result[0].resolvedPath, '/project')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Category: Here-docs — scope resolution
// ---------------------------------------------------------------------------

describe('FR-002 Here-docs — resolveWriteTargets scope', () => {
	test('in-scope: here-doc marker with redirect resolves inside cwd', () => {
		// cat << EOF > src/doc.txt — the redirect file is in-scope
		const analysis = detectPosixWrites('cat << EOF > src/doc.txt\ndata\nEOF');
		const result = resolveWriteTargets(
			'cat << EOF > src/doc.txt\ndata\nEOF',
			analysis.writes,
			'/project',
		);
		const redirectWrite = result.find(
			(r) => r.original.category === 'redirect',
		);
		expect(redirectWrite).toBeDefined();
		expect(redirectWrite!.resolvedPath).toBe('/project/src/doc.txt');
		expect(isInScope(redirectWrite!.resolvedPath, '/project')).toBe(true);
	});

	test('out-of-scope: here-doc redirect to /tmp resolves outside cwd', () => {
		const analysis = detectPosixWrites('cat << EOF > /tmp/data.txt\ndata\nEOF');
		const result = resolveWriteTargets(
			'cat << EOF > /tmp/data.txt\ndata\nEOF',
			analysis.writes,
			'/project',
		);
		const redirectWrite = result.find(
			(r) => r.original.category === 'redirect',
		);
		expect(redirectWrite).toBeDefined();
		expect(redirectWrite!.resolvedPath).toBe('/tmp/data.txt');
		expect(isInScope(redirectWrite!.resolvedPath, '/project')).toBe(false);
	});

	test('in-scope: here-doc marker itself (path=null) is handled', () => {
		// Here-doc markers have path: null — they don't have a resolvable file path
		const analysis = detectPosixWrites('cat << EOF\ndata\nEOF');
		const result = resolveWriteTargets(
			'cat << EOF\ndata\nEOF',
			analysis.writes,
			'/project',
		);
		const hereDocWrite = result.find((r) => r.original.category === 'here_doc');
		expect(hereDocWrite).toBeDefined();
		expect(hereDocWrite!.original.path).toBe(null);
		expect(hereDocWrite!.resolved).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Category: Builtins — scope resolution
// ---------------------------------------------------------------------------

describe('FR-002 Builtins — resolveWriteTargets scope', () => {
	test('in-scope: cp dst inside cwd', () => {
		const writes = [
			{ category: 'builtin_write', operator: 'cp', path: 'backup/index.js' },
		];
		const result = resolveWriteTargets(
			'cp src/index.js backup/index.js',
			writes,
			'/project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toBe('/project/backup/index.js');
		expect(isInScope(result[0].resolvedPath, '/project')).toBe(true);
	});

	test('out-of-scope: cp dst to /home/user resolves outside cwd', () => {
		const writes = [
			{
				category: 'builtin_write',
				operator: 'cp',
				path: '/home/user/backup.txt',
			},
		];
		const result = resolveWriteTargets(
			'cp src.txt /home/user/backup.txt',
			writes,
			'/project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toBe('/home/user/backup.txt');
		expect(isInScope(result[0].resolvedPath, '/project')).toBe(false);
	});

	test('in-scope: mv moves file inside cwd', () => {
		const writes = [
			{ category: 'builtin_write', operator: 'mv', path: 'src/renamed.ts' },
		];
		const result = resolveWriteTargets(
			'mv oldname.ts src/renamed.ts',
			writes,
			'/project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toBe('/project/src/renamed.ts');
		expect(isInScope(result[0].resolvedPath, '/project')).toBe(true);
	});

	test('out-of-scope: mv moves file outside cwd', () => {
		const writes = [
			{ category: 'builtin_write', operator: 'mv', path: '/tmp/stale.log' },
		];
		const result = resolveWriteTargets(
			'mv data.log /tmp/stale.log',
			writes,
			'/project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toBe('/tmp/stale.log');
		expect(isInScope(result[0].resolvedPath, '/project')).toBe(false);
	});

	test('in-scope: install to destination inside cwd', () => {
		const writes = [
			{ category: 'builtin_write', operator: 'install', path: 'bin/tool' },
		];
		const result = resolveWriteTargets(
			'install -m 755 src/tool bin/tool',
			writes,
			'/project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toBe('/project/bin/tool');
		expect(isInScope(result[0].resolvedPath, '/project')).toBe(true);
	});

	test('in-scope: ln creates link inside cwd', () => {
		const writes = [
			{ category: 'builtin_write', operator: 'ln', path: 'lib/link.so' },
		];
		const result = resolveWriteTargets(
			'ln -s lib/lib.so lib/link.so',
			writes,
			'/project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toBe('/project/lib/link.so');
		expect(isInScope(result[0].resolvedPath, '/project')).toBe(true);
	});

	test('in-scope: truncate shrinks file inside cwd', () => {
		const writes = [
			{
				category: 'builtin_write',
				operator: 'truncate',
				path: 'cache/tmp.dat',
			},
		];
		const result = resolveWriteTargets(
			'truncate -s 0 cache/tmp.dat',
			writes,
			'/project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toBe('/project/cache/tmp.dat');
		expect(isInScope(result[0].resolvedPath, '/project')).toBe(true);
	});

	test('out-of-scope: truncate targets file outside cwd', () => {
		const writes = [
			{
				category: 'builtin_write',
				operator: 'truncate',
				path: '/var/tmp/big.log',
			},
		];
		const result = resolveWriteTargets(
			'truncate -s 0 /var/tmp/big.log',
			writes,
			'/project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toBe('/var/tmp/big.log');
		expect(isInScope(result[0].resolvedPath, '/project')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Category: In-place edits — scope resolution
// ---------------------------------------------------------------------------

describe('FR-002 In-place edits — resolveWriteTargets scope', () => {
	test('in-scope: sed -i edits file inside cwd', () => {
		const writes = [
			{ category: 'inplace_edit', operator: 'sed -i', path: 'src/config.yaml' },
		];
		const result = resolveWriteTargets(
			'sed -i "s/foo/bar/" src/config.yaml',
			writes,
			'/project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toBe('/project/src/config.yaml');
		expect(isInScope(result[0].resolvedPath, '/project')).toBe(true);
	});

	test('out-of-scope: sed -i edits file outside cwd', () => {
		const writes = [
			{ category: 'inplace_edit', operator: 'sed -i', path: '/etc/app.conf' },
		];
		const result = resolveWriteTargets(
			'sed -i "s/foo/bar/" /etc/app.conf',
			writes,
			'/project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toBe('/etc/app.conf');
		expect(isInScope(result[0].resolvedPath, '/project')).toBe(false);
	});

	test('in-scope: perl -i modifies file inside cwd', () => {
		const writes = [
			{
				category: 'inplace_edit',
				operator: 'perl -i',
				path: 'data/records.csv',
			},
		];
		const result = resolveWriteTargets(
			'perl -i -pe "s/a/b/" data/records.csv',
			writes,
			'/project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toBe('/project/data/records.csv');
		expect(isInScope(result[0].resolvedPath, '/project')).toBe(true);
	});

	test('out-of-scope: perl -i modifies file outside cwd', () => {
		const writes = [
			{
				category: 'inplace_edit',
				operator: 'perl -i',
				path: '/root/secrets.txt',
			},
		];
		const result = resolveWriteTargets(
			'perl -i -pe "s/a/b/" /root/secrets.txt',
			writes,
			'/project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toBe('/root/secrets.txt');
		expect(isInScope(result[0].resolvedPath, '/project')).toBe(false);
	});

	test('in-scope: awk -i inplace edits file inside cwd', () => {
		const writes = [
			{ category: 'inplace_edit', operator: 'awk -i', path: 'logs/access.log' },
		];
		const result = resolveWriteTargets(
			'awk -i inplace "{print $1}" logs/access.log',
			writes,
			'/project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toBe('/project/logs/access.log');
		expect(isInScope(result[0].resolvedPath, '/project')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Category: Interpreter eval — scope resolution
// ---------------------------------------------------------------------------

describe('FR-002 Interpreter eval — resolveWriteTargets scope', () => {
	test('interpreter eval has null path — caller must treat as in-scope write effect', () => {
		// Interpreter eval (python -c, node -e, etc.) has path: null because
		// inline code can write to arbitrary files. The caller must flag this
		// as a write effect regardless of cwd since we cannot statically determine
		// what file (if any) the code will write.
		const writes = [
			{
				category: 'interpreter_eval',
				operator: 'node [eval]',
				path: null,
			},
		];
		const result = resolveWriteTargets('node -e "code"', writes, '/project');
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toBe(null);
		expect(result[0].resolved).toBe(false);
		// path: null is not in-scope by path comparison; caller must handle specially
	});

	test('python -c detected and resolved with null path', () => {
		const analysis = detectPosixWrites('python -c "print(1+1)"');
		expect(analysis.writes.length).toBe(1);
		expect(analysis.writes[0].category).toBe('interpreter_eval');
		expect(analysis.writes[0].path).toBe(null);

		const result = resolveWriteTargets(
			'python -c "print(1+1)"',
			analysis.writes,
			'/project',
		);
		expect(result[0].resolvedPath).toBe(null);
		expect(result[0].resolved).toBe(false);
	});

	test('bun -e detected and resolved with null path', () => {
		const analysis = detectPosixWrites('bun -e "console.log(1)"');
		expect(analysis.writes[0].category).toBe('interpreter_eval');
		expect(analysis.writes[0].path).toBe(null);

		const result = resolveWriteTargets(
			'bun -e "console.log(1)"',
			analysis.writes,
			'/project',
		);
		expect(result[0].resolvedPath).toBe(null);
	});

	test('ruby -e detected with null path', () => {
		const analysis = detectPosixWrites('ruby -e "puts 1"');
		expect(analysis.writes[0].category).toBe('interpreter_eval');
		expect(analysis.writes[0].path).toBe(null);
	});

	test('php -r detected with null path', () => {
		const analysis = detectPosixWrites('php -r "echo 1;"');
		expect(analysis.writes[0].category).toBe('interpreter_eval');
		expect(analysis.writes[0].path).toBe(null);
	});
});

// ---------------------------------------------------------------------------
// Category: Network downloads — scope resolution
// ---------------------------------------------------------------------------

describe('FR-002 Network downloads — resolveWriteTargets scope', () => {
	test('in-scope: curl -o downloads to path inside cwd', () => {
		const writes = [
			{
				category: 'network_download',
				operator: 'curl -o',
				path: 'pkg/dep.tar.gz',
			},
		];
		const result = resolveWriteTargets(
			'curl -o pkg/dep.tar.gz https://example.com/dep.tar.gz',
			writes,
			'/project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toBe('/project/pkg/dep.tar.gz');
		expect(isInScope(result[0].resolvedPath, '/project')).toBe(true);
	});

	test('out-of-scope: curl -o downloads to /tmp resolves outside cwd', () => {
		const writes = [
			{
				category: 'network_download',
				operator: 'curl -o',
				path: '/tmp/dl.zip',
			},
		];
		const result = resolveWriteTargets(
			'curl -o /tmp/dl.zip https://example.com/file.zip',
			writes,
			'/project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toBe('/tmp/dl.zip');
		expect(isInScope(result[0].resolvedPath, '/project')).toBe(false);
	});

	test('in-scope: wget -O saves to path inside cwd', () => {
		const writes = [
			{
				category: 'network_download',
				operator: 'wget -O',
				path: 'dl/module.js',
			},
		];
		const result = resolveWriteTargets(
			'wget -O dl/module.js https://cdn.example.com/module.js',
			writes,
			'/project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toBe('/project/dl/module.js');
		expect(isInScope(result[0].resolvedPath, '/project')).toBe(true);
	});

	test('out-of-scope: wget -O saves to absolute path outside cwd', () => {
		const writes = [
			{
				category: 'network_download',
				operator: 'wget -O',
				path: '/usr/local/bin/tool',
			},
		];
		const result = resolveWriteTargets(
			'wget -O /usr/local/bin/tool https://example.com/tool',
			writes,
			'/project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toBe('/usr/local/bin/tool');
		expect(isInScope(result[0].resolvedPath, '/project')).toBe(false);
	});

	test('in-scope: scp downloads to relative local path inside cwd', () => {
		const writes = [
			{
				category: 'network_download',
				operator: 'scp',
				path: 'downloads/file.txt',
			},
		];
		const result = resolveWriteTargets(
			'scp user@remote:/path/file.txt downloads/file.txt',
			writes,
			'/project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toBe('/project/downloads/file.txt');
		expect(isInScope(result[0].resolvedPath, '/project')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Category: Git destructive — scope resolution
// ---------------------------------------------------------------------------

describe('FR-002 Git destructive — resolveWriteTargets scope', () => {
	test('in-scope: git checkout -- path inside cwd', () => {
		const writes = [
			{
				category: 'git_destructive',
				operator: 'git checkout --',
				path: 'src/index.ts',
			},
		];
		const result = resolveWriteTargets(
			'git checkout -- src/index.ts',
			writes,
			'/project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toBe('/project/src/index.ts');
		expect(isInScope(result[0].resolvedPath, '/project')).toBe(true);
	});

	test('out-of-scope: git checkout -- path outside cwd', () => {
		const writes = [
			{
				category: 'git_destructive',
				operator: 'git checkout --',
				path: '/tmp/changed.txt',
			},
		];
		const result = resolveWriteTargets(
			'git checkout -- /tmp/changed.txt',
			writes,
			'/project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toBe('/tmp/changed.txt');
		expect(isInScope(result[0].resolvedPath, '/project')).toBe(false);
	});

	test('git checkout -- . (discard all) resolves to cwd — in-scope', () => {
		const writes = [
			{ category: 'git_destructive', operator: 'git checkout -- .', path: '.' },
		];
		const result = resolveWriteTargets('git checkout -- .', writes, '/project');
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toBe('/project');
		// cwd itself is in-scope
		expect(isInScope(result[0].resolvedPath, '/project')).toBe(true);
	});

	test('git clean -fd (path=null) — caller must treat as out-of-scope repo-wide effect', () => {
		// git clean -fd has null path because it affects untracked files everywhere.
		// This is a repo-wide destructive action; caller must handle specially.
		const writes = [
			{ category: 'git_destructive', operator: 'git clean -fd', path: null },
		];
		const result = resolveWriteTargets('git clean -fd', writes, '/project');
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toBe(null);
		expect(result[0].resolved).toBe(false);
	});

	test('git reset --hard (path=null) — caller must treat as out-of-scope', () => {
		const writes = [
			{ category: 'git_destructive', operator: 'git reset --hard', path: null },
		];
		const result = resolveWriteTargets(
			'git reset --hard HEAD~1',
			writes,
			'/project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toBe(null);
	});

	test('in-scope: git restore --hard with path inside cwd', () => {
		const writes = [
			{
				category: 'git_destructive',
				operator: 'git restore',
				path: 'src/app.ts',
			},
		];
		const result = resolveWriteTargets(
			'git restore --hard -- src/app.ts',
			writes,
			'/project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toBe('/project/src/app.ts');
		expect(isInScope(result[0].resolvedPath, '/project')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Category: PowerShell — scope resolution for file-writing cmdlets
// ---------------------------------------------------------------------------

describe('FR-002 PowerShell cmdlets — resolveWriteTargets scope', () => {
	// PowerShell uses Windows paths; resolveWriteTargets uses win32 resolution
	// when cwd contains backslashes or drive letter.

	test('in-scope: Out-File writes to relative path resolves inside cwd', () => {
		const analysis = detectWindowsWrites('Out-File output.txt', 'powershell');
		const result = resolveWriteTargets(
			'Out-File output.txt',
			analysis.writes,
			'C:\\project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toMatch(/C:\\project[\\]?output\.txt$/);
		expect(isInScope(result[0].resolvedPath!, 'C:\\project')).toBe(true);
	});

	test('out-of-scope: Out-File writes to C:\\Windows resolves outside cwd', () => {
		const analysis = detectWindowsWrites(
			'Out-File C:\\Windows\\system32\\config.txt',
			'powershell',
		);
		const result = resolveWriteTargets(
			'Out-File C:\\Windows\\system32\\config.txt',
			analysis.writes,
			'C:\\project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toMatch(/C:\\Windows/);
		expect(isInScope(result[0].resolvedPath!, 'C:\\project')).toBe(false);
	});

	test('in-scope: Set-Content with -Path inside cwd', () => {
		const analysis = detectWindowsWrites(
			'Set-Content -Path data\\results.json -Value "test"',
			'powershell',
		);
		const result = resolveWriteTargets(
			'Set-Content -Path data\\results.json -Value "test"',
			analysis.writes,
			'C:\\project',
		);
		const write = result.find((r) => r.original.operator === 'Set-Content');
		expect(write).toBeDefined();
		expect(write!.resolvedPath).toMatch(/data\\results\.json$/);
		expect(isInScope(write!.resolvedPath!, 'C:\\project')).toBe(true);
	});

	test('out-of-scope: Set-Content to path on different drive', () => {
		const analysis = detectWindowsWrites(
			'Set-Content D:\\data\\secrets.txt -Value "secret"',
			'powershell',
		);
		const result = resolveWriteTargets(
			'Set-Content D:\\data\\secrets.txt -Value "secret"',
			analysis.writes,
			'C:\\project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toMatch(/D:/);
		expect(isInScope(result[0].resolvedPath!, 'C:\\project')).toBe(false);
	});

	test('in-scope: Copy-Item destination inside cwd', () => {
		const analysis = detectWindowsWrites(
			'Copy-Item src.txt dest.txt',
			'powershell',
		);
		const result = resolveWriteTargets(
			'Copy-Item src.txt dest.txt',
			analysis.writes,
			'C:\\project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toMatch(/dest\.txt$/);
		expect(isInScope(result[0].resolvedPath!, 'C:\\project')).toBe(true);
	});

	test('out-of-scope: Copy-Item destination to system32', () => {
		const analysis = detectWindowsWrites(
			'Copy-Item app.exe C:\\Windows\\System32\\app.exe',
			'powershell',
		);
		const result = resolveWriteTargets(
			'Copy-Item app.exe C:\\Windows\\System32\\app.exe',
			analysis.writes,
			'C:\\project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toMatch(/System32/);
		expect(isInScope(result[0].resolvedPath!, 'C:\\project')).toBe(false);
	});

	test('in-scope: Move-Item destination inside cwd', () => {
		const analysis = detectWindowsWrites(
			'Move-Item old.txt new\\renamed.txt',
			'powershell',
		);
		const result = resolveWriteTargets(
			'Move-Item old.txt new\\renamed.txt',
			analysis.writes,
			'C:\\project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toMatch(/renamed\.txt$/);
		expect(isInScope(result[0].resolvedPath!, 'C:\\project')).toBe(true);
	});

	test('in-scope: Remove-Item targets file inside cwd', () => {
		const analysis = detectWindowsWrites(
			'Remove-Item temp\\cache.bin',
			'powershell',
		);
		const result = resolveWriteTargets(
			'Remove-Item temp\\cache.bin',
			analysis.writes,
			'C:\\project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toMatch(/cache\.bin$/);
		expect(isInScope(result[0].resolvedPath!, 'C:\\project')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Category: cmd.exe builtins — scope resolution
// ---------------------------------------------------------------------------

describe('FR-002 cmd.exe builtins — resolveWriteTargets scope', () => {
	// cmd.exe uses Windows paths; resolveWriteTargets uses win32 resolution
	// when cwd contains backslashes or drive letter.

	test('in-scope: copy dst inside cwd', () => {
		const analysis = detectWindowsWrites('copy src.txt dst.txt', 'cmd');
		const result = resolveWriteTargets(
			'copy src.txt dst.txt',
			analysis.writes,
			'C:\\project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toMatch(/dst\.txt$/);
		expect(isInScope(result[0].resolvedPath!, 'C:\\project')).toBe(true);
	});

	test('out-of-scope: copy dst to C:\\ProgramData', () => {
		const analysis = detectWindowsWrites(
			'copy app.exe C:\\ProgramData\\app.exe',
			'cmd',
		);
		const result = resolveWriteTargets(
			'copy app.exe C:\\ProgramData\\app.exe',
			analysis.writes,
			'C:\\project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toMatch(/ProgramData/);
		expect(isInScope(result[0].resolvedPath!, 'C:\\project')).toBe(false);
	});

	test('in-scope: move dst inside cwd', () => {
		const analysis = detectWindowsWrites(
			'move old.txt newdir\\updated.txt',
			'cmd',
		);
		const result = resolveWriteTargets(
			'move old.txt newdir\\updated.txt',
			analysis.writes,
			'C:\\project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toMatch(/updated\.txt$/);
		expect(isInScope(result[0].resolvedPath!, 'C:\\project')).toBe(true);
	});

	test('out-of-scope: move dst to absolute path on different drive', () => {
		const analysis = detectWindowsWrites(
			'move data.csv D:\\archive\\data.csv',
			'cmd',
		);
		const result = resolveWriteTargets(
			'move data.csv D:\\archive\\data.csv',
			analysis.writes,
			'C:\\project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toMatch(/D:/);
		expect(isInScope(result[0].resolvedPath!, 'C:\\project')).toBe(false);
	});

	test('in-scope: ren to name inside cwd', () => {
		const analysis = detectWindowsWrites('ren oldname.txt newname.txt', 'cmd');
		const result = resolveWriteTargets(
			'ren oldname.txt newname.txt',
			analysis.writes,
			'C:\\project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toMatch(/newname\.txt$/);
		expect(isInScope(result[0].resolvedPath!, 'C:\\project')).toBe(true);
	});

	test('in-scope: del targets file inside cwd', () => {
		const analysis = detectWindowsWrites('del temp\\cache.bin', 'cmd');
		const result = resolveWriteTargets(
			'del temp\\cache.bin',
			analysis.writes,
			'C:\\project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toMatch(/cache\.bin$/);
		expect(isInScope(result[0].resolvedPath!, 'C:\\project')).toBe(true);
	});

	test('out-of-scope: del targets file in Windows\\System32', () => {
		const analysis = detectWindowsWrites(
			'del C:\\Windows\\System32\\usercache.txt',
			'cmd',
		);
		const result = resolveWriteTargets(
			'del C:\\Windows\\System32\\usercache.txt',
			analysis.writes,
			'C:\\project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toMatch(/System32/);
		expect(isInScope(result[0].resolvedPath!, 'C:\\project')).toBe(false);
	});

	test('in-scope: rd removes directory inside cwd', () => {
		const analysis = detectWindowsWrites('rd /s /q temp\\cache', 'cmd');
		const result = resolveWriteTargets(
			'rd /s /q temp\\cache',
			analysis.writes,
			'C:\\project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toMatch(/cache$/);
		expect(isInScope(result[0].resolvedPath!, 'C:\\project')).toBe(true);
	});

	test('in-scope: md creates directory inside cwd', () => {
		const analysis = detectWindowsWrites('md output\\artifacts', 'cmd');
		const result = resolveWriteTargets(
			'md output\\artifacts',
			analysis.writes,
			'C:\\project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toMatch(/artifacts$/);
		expect(isInScope(result[0].resolvedPath!, 'C:\\project')).toBe(true);
	});

	test('in-scope: cmd.exe echo redirect resolves inside cwd', () => {
		const analysis = detectWindowsWrites('echo hello > output.txt', 'cmd');
		const result = resolveWriteTargets(
			'echo hello > output.txt',
			analysis.writes,
			'C:\\project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toMatch(/output\.txt$/);
		expect(isInScope(result[0].resolvedPath!, 'C:\\project')).toBe(true);
	});

	test('out-of-scope: cmd.exe echo redirect to \\Windows\\Temp', () => {
		const analysis = detectWindowsWrites(
			'echo data > C:\\Windows\\Temp\\log.txt',
			'cmd',
		);
		const result = resolveWriteTargets(
			'echo data > C:\\Windows\\Temp\\log.txt',
			analysis.writes,
			'C:\\project',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath).toMatch(/Windows/);
		expect(isInScope(result[0].resolvedPath!, 'C:\\project')).toBe(false);
	});
});
