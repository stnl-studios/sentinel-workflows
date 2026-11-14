// Synthetic teaching fixture, not OS 39146 code or a reproduction of its full
// domain. Deliberately tiny, in-memory and independent of databases or clients.
export const contracts = Object.freeze([
  { id: 'A', historicalStatus: 'closed', pcrStatus: 'active', amount: null, date: null, position: { billed: 12, paid: null }, subleaseLabel: null, sapNumber: null },
  { id: 'B', historicalStatus: 'active', pcrStatus: 'closed', amount: 0, date: '2026-01-02', position: null, subleaseLabel: 'Source supplied label', sapNumber: 'SAP-42' },
  { id: 'C', historicalStatus: 'closed', pcrStatus: 'active', amount: 25, date: '2026-01-03', position: { billed: 25, paid: 25 }, subleaseLabel: null, sapNumber: null },
]);

// Each switch introduces one intentionally wrong behavior. Assertions live in
// the test, separate from this implementation and its mutants.
export function createContractView(mutation = null) {
  const row = item => ({
    id: item.id,
    status: mutation === 'history-instead-of-pcr' ? item.historicalStatus : item.pcrStatus,
    amount: mutation === 'null-to-zero' ? item.amount ?? 0 : item.amount,
    date: mutation === 'null-to-min-date' ? item.date ?? '0001-01-01' : item.date,
    position: item.position === null ? null : {
      billed: item.position.billed,
      paid: item.position.paid,
    },
    positionTooltip: item.position === null || mutation === 'partial-position-missing' && item.position.paid === null ? 'Position unavailable' : null,
    subleaseLabel: mutation === 'fabricate-sublease-label' ? item.subleaseLabel ?? 'Not subleased' : item.subleaseLabel,
    sapLink: item.sapNumber === null && mutation !== 'sap-link-without-number' ? null : `/sap/${item.sapNumber ?? ''}`,
  });
  let state = { rows: [], total: 0, error: null };
  return {
    get(id) {
      const item = contracts.find(candidate => candidate.id === id);
      if (!item) return mutation === 'fabricate-missing-record' ? row(contracts[0]) : null;
      return row(item);
    },
    search({ status = null, page = 1, pageSize = 2, fail = false } = {}) {
      if (fail) {
        state = { rows: [], total: mutation === 'stale-total-after-error' ? state.total : 0, error: 'Unavailable' };
        return structuredClone(state);
      }
      const matching = contracts.map(row).filter(item => status === null || item.status === status);
      const offset = mutation === 'wrong-page-offset' ? page * pageSize : (page - 1) * pageSize;
      state = { rows: matching.slice(offset, offset + pageSize), total: matching.length, error: null };
      return structuredClone(state);
    },
    export({ status = null, pageSize = 2 } = {}) {
      const matching = contracts.map(row).filter(item => status === null || item.status === status);
      const exported = mutation === 'export-current-page-only' ? matching.slice(0, pageSize) : matching;
      // Explicit synthetic export contract: all matching rows, nulls as blank
      // fields, literal zero retained. No assertion about the real OS format.
      return ['id,status,amount,date', ...exported.map(item =>
        [item.id, item.status, item.amount ?? '', item.date ?? ''].join(','))].join('\n');
    },
  };
}
