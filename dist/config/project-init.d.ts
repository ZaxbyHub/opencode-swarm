/**
 * Creates .opencode/opencode-swarm.json in the given directory if it does not
 * already exist. Uses an atomic exclusive write (flag 'wx') so concurrent
 * plugin loads never double-write or corrupt the file.
 *
 * Non-fatal: any fs error (permissions, disk full, etc.) is swallowed so the
 * plugin continues with its default or global config.
 */
export declare function writeProjectConfigIfNew(directory: string, quiet?: boolean): void;
/**
 * Writes .swarm/config.example.json on first plugin init for a given project.
 * Creates .swarm/ if it does not yet exist. Non-fatal: all errors are silently
 * ignored.
 */
export declare function writeSwarmConfigExampleIfNew(projectDirectory: string): void;
