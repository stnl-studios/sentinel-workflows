# S2 Terra Qualification

Status: `S2_MODEL_QUALIFICATION_FAIL`

Producer: `GPT-5.6-Terra`

Reviewer: `GPT-5.6-Sol / high`

Candidate: `82b56e0c4bd5acd444ecfcd47f6409720c8d5488`

## Case A

- Slices: 1
- Tasks: 3
- PLAN: 6428 bytes / 845 words
- TASKS: 4653 bytes / 619 words
- Repetition: LOW
- Blocker: `BF-A-PATHS`

## Case B

- Slices: 3
- Tasks: 7
- PLAN: 15021 bytes / 1847 words
- TASKS: 9413 bytes / 1123 words
- Repetition: MODERATE
- Blocker: `BF-B-PATHS`
- The compatibility oracle was an observed improvement.

## Case C

- Slices: 3
- Tasks: 5
- PLAN: 12877 bytes / 1606 words
- TASKS: 9826 bytes / 1232 words
- Repetition: LOW
- Paths were corrected after the second round.
- TASKS were larger, recorded as a warning.
- No final case blocker remained.

## Conclusion

- Terra preserved sizing, boundaries, and scope.
- Terra was not qualified.
- Path executability failed in 2 of 3 cases.
- G5 remains NOT_YET_PROVEN.
- Actual token telemetry was unavailable.
