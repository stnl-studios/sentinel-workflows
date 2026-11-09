from db_local import fresh_database
with fresh_database() as connection:
    names = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {'imported', 'import_history', 'summary'} <= names
    assert connection.execute('PRAGMA foreign_keys').fetchone() == (1,)
    assert connection.execute('SELECT total FROM summary').fetchone() == (0,)
    assert connection.execute('SELECT count(*) FROM imported').fetchone() == (0,)
print('schema, pre/post deployment and clean database: PASS')
