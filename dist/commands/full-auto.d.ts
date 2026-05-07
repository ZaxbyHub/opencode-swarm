/**
 * Handles the /swarm full-auto command.
 * Toggles Full-Auto Mode on or off for the active session.
 *
 * In Full-Auto v2 this also creates a durable run-state record under
 * .swarm/full-auto-state.json so the permission/oversight infrastructure can
 * fail-closed across hooks and across process restarts.
 *
 * H2 fix: durable write happens BEFORE flipping the legacy
 * `session.fullAutoMode` flag. If the durable write fails, the command
 * surfaces the error in its return string and does NOT enable the legacy
 * reactive intercept — preventing a silent fail-open where reactive checks
 * would believe Full-Auto is on while the v2 permission hook sees no
 * durable run.
 *
 * @param directory - Project directory (used to persist Full-Auto run state)
 * @param args - Optional argument: "on" | "off" | undefined (toggle behavior)
 * @param sessionID - Session ID for accessing active session state
 * @returns Feedback message about Full-Auto Mode state
 */
export declare function handleFullAutoCommand(directory: string, args: string[], sessionID: string): Promise<string>;
