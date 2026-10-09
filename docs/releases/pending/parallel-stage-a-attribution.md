# Fix: `pre_check_batch` runs are credited to the task they checked when several coders are in flight

## What

A `pre_check_batch` run was credited to the architect session's single
`currentTaskId`. With several tasks awaiting Stage A (parallel coders, or
Turbo's coder re-dispatch before Stage A), that is the coder that returned
last, not the task whose files the gate checked. The verdict was credited to
the wrong task, and the task actually checked never reached Stage B.

While two or more tasks of the session are awaiting Stage A
(`coder_delegated`) — or exactly one that is not the session's current task
(the last-returned coder already passed Stage A, so the session still points
at it while the remaining parallel task awaits) — a `pre_check_batch` run is
now credited by its `files`.
It goes to the one in-flight task whose planned `files_touched` contain every
checked file.
If the files are missing, belong to several tasks or match no task, nothing is
credited and the architect is told to re-run the gate with one task's files.
With no task in flight, or exactly one that is the session's current task (or
when no current task is set), and for the other gate tools (`diff`, `lint`,
`imports`, …, which carry no Stage A verdict), attribution is unchanged
(`currentTaskId`, then the durable post-reset fallback).

When only that one task awaits Stage A, a run that names no files, or only
files of the session's current task, is treated as the serial case and still
credits the current task, as before.

The architect prompt and the execute protocol (step 5i) now say to pass
`pre_check_batch` `files` = exactly the checked task's `files_touched`, never
the union of the parallel tasks' files.

## Why

Found in a live run with four parallel coders: every Stage A run was credited
to the last-returned task, and the wave stalled. After the first fix, the
last remaining task was still mis-credited: once the last-returned task had
passed Stage A only one task was in flight, so attribution fell back to the
session's current task — the one that had already passed — and a failing run
sent it back to rework.
