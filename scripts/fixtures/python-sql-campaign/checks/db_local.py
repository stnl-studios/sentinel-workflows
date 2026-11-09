"""Synthetic SQLite fixture helper. Never opens an existing database."""
import sys
# These synthetic checks use assertions as functional oracles. Never report PASS
# when a direct caller explicitly disabled those assertions.
if sys.flags.optimize:
    raise RuntimeError("synthetic SQL checks require enabled assertions")
import csv
import sqlite3
from pathlib import Path
import xml.etree.ElementTree as ET
ROOT = Path(__file__).resolve().parents[1]

def fresh_database():
    connection = sqlite3.connect(':memory:')
    project = ET.parse(ROOT / 'database' / 'synthetic.sqlproj')
    for kind in ('PreDeploy', 'Build', 'PostDeploy'):
        for item in project.findall('.//' + kind):
            connection.executescript((ROOT / 'database' / item.attrib['Include']).read_text())
    return connection

def seed_rows():
    with (ROOT / 'fixtures' / 'synthetic.csv').open(newline='') as source:
        return [(int(row['id']), row['payload']) for row in csv.DictReader(source)]

def import_rows(connection):
    connection.executemany('INSERT INTO imported(id,payload) VALUES(?,?)', seed_rows())
    connection.commit()

def rebuild(connection):
    if connection.execute('SELECT count(*) FROM imported').fetchone()[0]:
        raise ValueError('refuse rebuild: imported is not empty')
    connection.execute('DELETE FROM import_history')
    connection.execute('UPDATE summary SET total=0')
    connection.commit()
