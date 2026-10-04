# Fix: `pre_check_batch` runs are credited to the task they checked when several coders are in flight

## What

A `pre_check_batch` run was credited to the architect session's single
`currentTaskId`. With several tasks awaiting Stage A (parallel coders, or
Turbo's coder re-dispatch before Stage A), that is the coder that returned
last, not the task whose files the gate checked. The verdict was credited to
the wrong task, and the task actually checked never reached Stage B.

While two or more tasks of the session are awaiting Stage A
(`coder_delegated`), a `pre_check_batch` run is now credited by its `files`.
It goes to the one in-flight task whose planned `files_touched` contain every
checked file.
If the files are missing, belong to several tasks or match no task, nothing is
credited and the architect is told to re-run the gate with one task's files.
With zero or one task in flight, and for the other gate tools (`diff`, `lint`,
`imports`, …, which carry no Stage A verdict), attribution is unchanged
(`currentTaskId`, then the durable post-reset fallback).

## Why

Found in a live run with four parallel coders: every Stage A run was credited
to the last-returned task, and the wave stalled.
