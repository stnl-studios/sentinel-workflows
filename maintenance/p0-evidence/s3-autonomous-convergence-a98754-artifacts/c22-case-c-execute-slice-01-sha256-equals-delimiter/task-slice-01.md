# Preserved C22 task artifact

The managed replay preserved the task artifact before cleanup. Its active `Delegation Blocker` records that the runner returned file-backed `Tested state` with `sha256=<digest>` rather than the canonical `sha256:<64 lowercase hexadecimal>` token, and requires resuming `EXECUTE_SLICE slice-01` only after a valid runner response.
