# Windows Composer wrappers launched through the contained cmd.exe launcher; `build_check` reports launch failures distinctly

`test_runner` launched a Composer `vendor/bin` tool by handing `vendor/bin/phpunit.bat`
(or `pest.bat`) straight to the process spawner on Windows. A batch file is not a
directly-spawnable target: Node's `child_process.spawn` rejects it with `EINVAL`,
so on a Windows host where the plugin runs under the Node sidecar, running the
`phpunit` or `pest` test framework could not start the process at all. Bun
happens to tolerate a raw `.bat` (it routes batch files through cmd.exe itself),
which is why the defect stayed invisible on the primary dev/test runtime — but
that tolerance is a runtime accident, not a contract, and behaviour must not
depend on which runtime is hosting the plugin.

All three Composer routes — the default dispatch builder, the test-runner's
legacy switch, and the PHP backend's framework selection — now share one
`buildPhpVendorCommand` helper. On Windows the `.bat` shim is launched through
the contained `cmd.exe` launcher (`resolveContainedWindowsBatchCommand`), the
same path the Maven and Gradle wrappers already use; when that launcher declines
(missing shim, a wrapper symlink resolving outside the project directory, a
test-file path carrying a `cmd.exe` metacharacter, an argument ending in a
backslash that the launcher's quoting would mangle, an unresolvable `ComSpec`)
the command falls back to running the PHP interpreter against the
extensionless Composer proxy instead of re-emitting the batch file.
Non-Windows behaviour is unchanged.

Separately, `build_check` now reports the `spawnError` value from its process
launch as a `spawn_error` field on the run record. Previously a command that
could not be launched at all was recorded with the same `exit_code` as a build
that ran and failed, so the two cases were indistinguishable in the tool output
and in persisted build evidence. `exit_code` and the pass/fail verdict are
unchanged; the new field only adds the reason, and is absent when the process
did start.
