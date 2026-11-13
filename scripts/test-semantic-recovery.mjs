import test from 'node:test';
import assert from 'node:assert/strict';
import { createContractView } from './fixtures/semantic-recovery.mjs';

// Executable requirement → scenario → assertion matrix. Contracts below are
// intentionally explicit and synthetic; their failure classes come from the
// 39146 diagnosis. This does not qualify the OS, Sentinel agents or native QA.
const matrix = [
  {
    requirement: 'SEM-001: absence of a numeric value is not zero',
    scenario: 'A has no amount; B has a genuine zero', mutation: 'null-to-zero',
    verify(view) { assert.equal(view.get('A').amount, null); assert.equal(view.get('B').amount, 0); },
  },
  {
    requirement: 'SEM-002: absent dates remain absent',
    scenario: 'A has no date; B has a supplied date', mutation: 'null-to-min-date',
    verify(view) { assert.equal(view.get('A').date, null); assert.equal(view.get('B').date, '2026-01-02'); },
  },
  {
    requirement: 'SEM-003: PCR status is the selected source',
    scenario: 'history and PCR deliberately disagree', mutation: 'history-instead-of-pcr',
    verify(view) {
      assert.equal(view.get('A').status, 'active');
      const result = view.search({ status: 'active' });
      assert.deepEqual(result.rows.map(item => item.id), ['A', 'C']); assert.equal(result.total, 2);
    },
  },
  {
    requirement: 'SEM-004: nonexistent records are not fabricated',
    scenario: 'unknown identifier', mutation: 'fabricate-missing-record',
    verify(view) { assert.equal(view.get('missing'), null); },
  },
  {
    requirement: 'SEM-005: failed reload clears the visible result and total',
    scenario: 'successful query followed by error and recovery', mutation: 'stale-total-after-error',
    verify(view) {
      assert.equal(view.search().total, 3);
      assert.deepEqual(view.search({ fail: true }), { rows: [], total: 0, error: 'Unavailable' });
      const recovered = view.search({ status: 'closed' });
      assert.equal(recovered.error, null); assert.equal(recovered.total, 1);
      assert.deepEqual(recovered.rows.map(item => item.id), ['B']);
    },
  },
  {
    requirement: 'SEM-006: partial position preserves available and absent parts',
    scenario: 'A has billed but no paid amount; B has no position', mutation: 'partial-position-missing',
    verify(view) { assert.deepEqual(view.get('A').position, { billed: 12, paid: null }); assert.equal(view.get('A').positionTooltip, null); assert.equal(view.get('B').position, null); assert.equal(view.get('B').positionTooltip, 'Position unavailable'); },
  },
  {
    requirement: 'SEM-007: export includes all matches and preserves absence versus zero',
    scenario: 'three matches across two pages, then a filtered export', mutation: 'export-current-page-only',
    verify(view) {
      assert.equal(view.export({ pageSize: 2 }), 'id,status,amount,date\nA,active,,\nB,closed,0,2026-01-02\nC,active,25,2026-01-03');
      assert.equal(view.export({ status: 'closed' }), 'id,status,amount,date\nB,closed,0,2026-01-02');
    },
  },
  {
    requirement: 'SEM-008: page offsets and total describe the same filtered collection',
    scenario: 'first, last, empty page and filtered page', mutation: 'wrong-page-offset',
    verify(view) {
      assert.deepEqual(view.search({ page: 1 }).rows.map(item => item.id), ['A', 'B']);
      const last = view.search({ page: 2 }); assert.deepEqual(last.rows.map(item => item.id), ['C']); assert.equal(last.total, 3);
      const empty = view.search({ page: 3 }); assert.deepEqual(empty.rows, []); assert.equal(empty.total, 3);
      const filtered = view.search({ status: 'active', page: 2, pageSize: 1 });
      assert.deepEqual(filtered.rows.map(item => item.id), ['C']); assert.equal(filtered.total, 2);
    },
  },
  {
    requirement: 'SEM-009: absent source does not justify a negative sublease label',
    scenario: 'missing source versus a supplied label', mutation: 'fabricate-sublease-label',
    verify(view) { assert.equal(view.get('A').subleaseLabel, null); assert.equal(view.get('B').subleaseLabel, 'Source supplied label'); },
  },
  {
    requirement: 'SEM-010: SAP link requires a supplied number',
    scenario: 'record without number versus known number', mutation: 'sap-link-without-number',
    verify(view) { assert.equal(view.get('A').sapLink, null); assert.equal(view.get('B').sapLink, '/sap/SAP-42'); },
  },
];

for (const item of matrix) {
  test(`${item.requirement} / ${item.scenario}: correct behavior passes`, () => item.verify(createContractView()));
  test(`${item.requirement}: assertion detects ${item.mutation}`, () => {
    assert.throws(() => item.verify(createContractView(item.mutation)), error => error.code === 'ERR_ASSERTION');
  });
}
