from db_local import fresh_database, import_rows, seed_rows
with fresh_database() as connection:
    assert connection.execute('SELECT count(*) FROM imported').fetchone() == (0,)
    import_rows(connection)
    assert connection.execute('SELECT id,payload FROM imported ORDER BY id').fetchall() == seed_rows()
    assert connection.execute('SELECT imported_id,payload FROM import_history ORDER BY sequence').fetchall() == seed_rows()
    assert connection.execute('SELECT total FROM summary').fetchone() == (len(seed_rows()),)
print('real SQL insertion, import history and summary: PASS')
