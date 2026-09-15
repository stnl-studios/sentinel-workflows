# Aggregator development instructions

Validation environments are defined by the launch profiles in `.vscode/launch.json` and the tasks they reference in `.vscode/tasks.json`.

The API verification uses the `API checks in Compose` profile. The web verification may use either project profile whose `sentinelComponent` is `web-client`; do not infer host when that choice is unresolved.

The shared Compose configuration lives outside both child repositories at `shared/compose.yml`.

