IF DB_NAME() NOT LIKE N'stnl_synthetic[_]%'
    THROW 51002, 'synthetic database prefix required', 1;
PRINT N'STNL_PRE_DEPLOY_BASELINE';
