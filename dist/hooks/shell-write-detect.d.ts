/**
 * Shell Write Detector — POSIX AST + Windows regex-based write-operation detection
 *
 * Parses POSIX shell commands using bash-parser and statically detects
 * file-system write operations using regex heuristics for Windows shells.
 * Used by guardrails and scope-validation hooks to catch opaque shell
 * commands that would bypass direct tool coverage.
 *
 * @module shell-write-detect
 */
/**
 * All write-operation categories detected by this module.
 */
export type WriteCategory = 'redirect' | 'here_doc' | 'builtin_write' | 'inplace_edit' | 'interpreter_eval' | 'network_download' | 'archive_extract' | 'git_destructive';
/**
 * A single write target detected in a shell command.
 */
export interface WriteTarget {
    /** The category of write operation. */
    category: WriteCategory;
    /** The tool or operator that triggered this write, e.g. "cp", ">", "sed -i". */
    operator: string;
    /** The file path written to, or null when the path cannot be determined statically. */
    path: string | null;
}
/**
 * Result of analyzing a single shell command.
 */
export interface WriteAnalysis {
    /** All write targets detected in the command (empty if none). */
    writes: WriteTarget[];
    /** Whether the command contains any detected writes. */
    hasWrites: boolean;
    /** Whether the command could not be parsed (fail-closed). */
    parseError?: boolean;
}
/**
 * A write target with its resolved absolute path.
 */
export interface ResolvedWriteTarget {
    /** The original write target. */
    original: WriteTarget;
    /**
     * The resolved absolute path, or null if the path could not be determined
     * (null original path) or was marked unresolvable (dynamic path).
     */
    resolvedPath: string | null;
    /**
     * Whether the path was successfully resolved to an absolute path.
     * false when: path is null, path contains env vars ($VAR), or path
     * contains command substitution ($(cmd) or `cmd`).
     */
    resolved: boolean;
}
/**
 * Detect interactive/session tools that should be denied regardless of scope.
 *
 * These tools create persistent sessions or run commands repeatedly in a way
 * that is inherently open-ended and cannot be bounded safely.
 *
 * @param command - A shell command string
 * @param shell - The shell type: 'posix', 'powershell', or 'cmd'
 * @returns true if the command uses an interactive/session tool
 */
export declare function detectInteractiveSession(command: string, shell: 'posix' | 'powershell' | 'cmd'): boolean;
/**
 * Parse a POSIX shell command and detect all file-system write operations.
 *
 * Detects:
 * - Redirection operators: >, >>, >|, <<, <<- (here-docs)
 * - Write-effect builtins: cp, mv, install, ln, truncate, dd (of=)
 * - In-place editors: sed -i, perl -i, awk -i
 * - Interpreter eval: python -c/-m, node -e, bun -e, ruby -e, perl -e, php -r
 * - Network downloaders: curl -o, wget -O, scp
 * - Archive extraction: tar -x, unzip, gunzip
 * - Git destructive: git checkout --, git restore, git reset --hard, git clean -fd
 *
 * @param command - A POSIX shell command string
 * @returns WriteAnalysis with array of detected write targets; hasWrites is false when array is empty
 */
export declare function detectPosixWrites(command: string): WriteAnalysis;
/**
 * Parse a Windows shell command (PowerShell or cmd.exe) and detect all
 * file-system write operations using regex heuristics.
 *
 * Detects:
 * - Redirection operators: >, >>
 * - PowerShell cmdlets: Out-File, Set-Content, Add-Content, Clear-Content,
 *   Copy-Item, Move-Item, Remove-Item, Invoke-WebRequest (-OutFile), Start-Process
 * - PowerShell aliases: echo, write (when used with redirection)
 * - cmd.exe builtins: copy, move, ren, del, rd, md
 * - cmd.exe redirections: >, >>
 * - cmd.exe echo/set with redirection
 *
 * @param command - A Windows shell command string
 * @param shell - Either 'powershell' or 'cmd'
 * @returns WriteAnalysis with array of detected write targets; hasWrites is false when array is empty
 */
export declare function detectWindowsWrites(command: string, shell: 'powershell' | 'cmd'): WriteAnalysis;
/**
 * Resolve write targets from a POSIX shell command against a given cwd,
 * tracking directory changes through subshell `cd` commands.
 *
 * This function is pure: it does not modify any external state.
 *
 * @param command - A POSIX shell command string (e.g., "(cd /tmp && echo x > file)")
 * @param cwd - The starting current working directory (e.g., "/home/user")
 * @returns Array of ResolvedWriteTarget with resolved absolute paths
 */
export declare function resolveWriteTargets(command: string, writes: WriteTarget[], cwd: string): ResolvedWriteTarget[];
