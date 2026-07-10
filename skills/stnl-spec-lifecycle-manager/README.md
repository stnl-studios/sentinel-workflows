# stnl-spec-lifecycle-manager

This package maintains independent feature SPECs. It covers documentary requirements and their lifecycle, not implementation planning or delivery operations.

The four modes are `INIT`, `RESUME`, `PLANNING`, and `CLOSE`. Canonical items are directly rendered Markdown whose heading is the sole ID authority; YAML is limited to file-purpose and compact feature-level discovery/state blocks.

Supporting resources are progressively loaded from `references/`, `templates/`, `examples/`, and `evals/`. Validate changes with `python3 scripts/test-spec-lifecycle.py` from the repository root.
