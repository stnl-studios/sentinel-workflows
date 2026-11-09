from db_local import fresh_database, import_rows, rebuild
with fresh_database() as connection:
    import_rows(connection)
    before = list(connection.iterdump())
    try:
        rebuild(connection)
    except ValueError as error:
        assert str(error) == 'refuse rebuild: imported is not empty'
    else:
        raise AssertionError('nonempty database rebuild was accepted')
    assert list(connection.iterdump()) == before, 'refused rebuild changed data'
with fresh_database() as connection:
    rebuild(connection)
    assert connection.execute('SELECT count(*) FROM imported').fetchone() == (0,)
print('nonempty rebuild refused with exact data preservation; empty rebuild: PASS')
