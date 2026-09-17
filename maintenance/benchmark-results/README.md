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

## Production Pilot #4

Candidate `03724a7f646d6d20f57b7cb85ea6358bdf29c999` used
`production-v2`. The canary stopped before B/C authorization, so only the
truthful partial Case A raw exists:

- `03724a7f646d6d20f57b7cb85ea6358bdf29c999/case-a-production-v2.json`
  - status: `BLOCKED`
  - final execution state: `AUXILIARY_BLOCKED`
  - SHA-256: `fa6b421fe4861a497f15f5432acfdb7f3b5d22e5e3c48780398181f6a794a202`

No official production-v2 baseline is established.
