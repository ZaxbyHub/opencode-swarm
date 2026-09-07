# Expose audited PR publication cancellation (#2584)

The registered `abort_pr_workflow` tool now exposes its existing
`cancel-publication` path, while continuing to reject the human-only `force`
kind. Successful cancellation responses truthfully report the terminal
`cancelled_without_publication` status and empty checkout-receipt fields when
there is nothing to restore.
