## Fixed

- Hardened `resolveWorkingDirectory` so tool validation returns structured errors instead of throwing when `fallbackDirectory` is missing or `working_directory` is not a string, and aligned the Windows tool-test guidance with the current `.swarm` containment behavior.
