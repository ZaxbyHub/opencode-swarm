# Advisory CI runtime hardening

- Bounds advisory CI deadlines and shadow/journal resources, keeps diagnostics
  free of evaluated-directory paths, and documents unavoidable process-death
  cleanup residue.
- `run_started` journal entries omit the evaluated directory, and Windows
  signal-driven cancellation remains best-effort; the timeout remains the
  portable cancellation bound. Legacy flat-retrospective evidence reads stay
  migration-free and do not rewrite the evaluated repository.
- The documented `600000` ms timeout example is no longer compatible with the
  supported `1`–`300000` ms range; callers using the former value must lower it.
