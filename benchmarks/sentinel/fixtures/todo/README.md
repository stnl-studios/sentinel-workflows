# Sentinel Todo Seed

Small dependency-free Todo CLI used by Sentinel Benchmark v1.

```text
node src/cli.mjs --store ./todos.json add "Write tests"
node src/cli.mjs --store ./todos.json list
node src/cli.mjs --store ./todos.json complete 1
node --test
```

The persisted format is a UTF-8 JSON object with one `todos` array. IDs are
positive incremental integers, titles are non-empty strings, and every new Todo
starts with `completed: false`.
