import os from 'os';
import path from 'path';

// os.homedir() is the robust cross-platform home lookup and never throws.
// Fall back to env vars, then the current directory, so module load can never
// crash with `path.join(undefined, ...)` when HOME/USERPROFILE are both unset
// (e.g. minimal containers / CI runners).
const home = os.homedir() || process.env.HOME || process.env.USERPROFILE || '.';

export const DEFAULT_SWARM_CONFIG = path.join(home, '.config', 'opencode', 'opencode-swarm.json');
export const DEFAULT_OPENCODE_CONFIG = path.join(home, '.config', 'opencode', 'opencode.json');
