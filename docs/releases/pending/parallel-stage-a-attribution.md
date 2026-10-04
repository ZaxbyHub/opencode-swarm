# Fix: Stage A gate runs are credited to the task they checked when coders run in parallel

## What

A gate tool run (`pre_check_batch` and the other Stage A tools) was credited to
the architect session's single `currentTaskId`. With parallel coders, that is
the coder that returned last, not the task whose files the gate checked. The
run was credited to the wrong task, and the task actually checked never reached
Stage B.

While two or more tasks of the session are awaiting Stage A
(`coder_delegated`), a gate run is now credited by its `files`. It goes to the
one in-flight task whose planned `files_touched` contain every checked file.
If the files are missing, belong to several tasks or match no task, nothing is
credited and the architect is told to re-run the gate with one task's files.
With zero or one task in flight, attribution is unchanged (`currentTaskId`,
then the durable post-reset fallback).

## Why

Found in a live run with four parallel coders: every Stage A run was credited
to the last-returned task, and the wave stalled.
