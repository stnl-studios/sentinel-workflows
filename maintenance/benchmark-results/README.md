# Sentinel Benchmark Results

Persisted benchmark results are engineering evidence. They are not requirements,
runtime, lifecycle, or execution authority and are never read automatically by
Sentinel skills.

Preserve raw result JSON so comparisons can be regenerated. Result files must
not contain chain-of-thought, complete logs, or user-local paths. Actual token
counts may be stored only when the provider or tool exposes real telemetry; they
must never be estimated.

Future results use this convention:

```text
maintenance/benchmark-results/<sentinel-sha>/
  case-a-production-v1.json
  case-b-production-v1.json
  case-c-production-v1.json
```

No synthetic or placeholder result belongs in this directory.
