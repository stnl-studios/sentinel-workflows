Use `stnl-slice-executor`.
OPERATION=APPLY_FINDINGS
SPEC_PATH={{SPEC_PATH}}
SLICE={{SLICE}}

Contexto adicional (opcional):

When `STNL_MANAGED_CONTEXT` is present, follow the skill's managed producer commands: prepare with `$STNL_MANAGED_FINALIZER`, edit the allocated payload file, invoke `node "$STNL_MANAGED_RUNNER_BRIDGE" --payload-file "$STNL_MANAGED_RUNNER_PAYLOAD"`, and finalize with `$STNL_MANAGED_FINALIZER`. Native/manual launches retain their published recipes.
