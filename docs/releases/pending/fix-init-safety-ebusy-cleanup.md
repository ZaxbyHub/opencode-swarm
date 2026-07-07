## Fixed

- Fixed intermittent Windows CI failure in `init-safety.test.ts` where `afterAll` cleanup threw `EBUSY` when temp directory file handles were still held by recently-terminated child processes. Both `rmSync` calls now tolerate `EBUSY` and `ENOTEMPTY` errors.
