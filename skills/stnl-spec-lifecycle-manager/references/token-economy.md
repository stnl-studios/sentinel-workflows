# File Purpose Header

```yaml
purpose: Keep SPEC work compact without sacrificing deterministic validation or durable content.
status: not_applicable
read_when: A lifecycle operation risks broad reads, duplicated metadata, repeated prose, or lossy compaction.
do_not_read_when: A tiny isolated correction already has all required context.
contains: Selective-reading, non-duplication, metadata economy, and safe closure rules.
owner: stnl-spec-lifecycle-manager
update_policy: Change when documentary economy or preservation policy changes.
```

# Token Economy

Use the feature header and compact indexes for discovery, then read only the necessary canonical item and structural links. Do not load every shared category for a localized question.

Keep IDs only in headings. Omit absent optional metadata instead of writing `null`. Do not persist derived counters, materialization flags, null paths, operational mode history, repeated blockers, command output, chats, session summaries, internal reasoning, permanent handoffs, or duplicate traceability.

Narrative content stays real Markdown rather than YAML-wrapped prose. CLOSE may inspect every materialized record needed for consistency, but compaction never erases durable structure or collapses a decision, constraint, risk, criterion, or relevant resolved question into a lossy single string.
