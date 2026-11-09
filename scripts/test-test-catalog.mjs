import assert from 'node:assert/strict';
import test from 'node:test';
import {validateCatalog} from './lib/test-catalog.mjs';
const fixture=()=>({format:'sentinel-test-catalog-v1',files:['scripts/test-example.mjs','scripts/test-shell-delegation.mjs'],excluded:[{file:'scripts/fixtures/example.test.mjs',reason:'fixture'}],delegations:[{file:'scripts/test-example.sh',target:'scripts/test-example.mjs',coveredBy:'scripts/test-shell-delegation.mjs',reason:'delegation contract'}]});
const discovered=['scripts/fixtures/example.test.mjs','scripts/test-example.mjs','scripts/test-example.sh','scripts/test-shell-delegation.mjs'];
test('catalog covers every discovered test exactly once, including tested delegation',()=>assert.equal(validateCatalog(fixture(),discovered).delegations.length,1));
for(const [name,change] of [
  ['unknown format',c=>c.format='other'],['malformed files',c=>c.files=null],['malformed delegations',c=>c.delegations={}],
  ['duplicate runnable',c=>c.files.push(c.files[0])],['unsorted runnable',c=>c.files.reverse()],
  ['unexplained exclusion',c=>c.excluded[0].reason=' '],['duplicate exclusion',c=>c.excluded.push(c.excluded[0])],
  ['stale exclusion',c=>c.excluded[0].file='scripts/missing.test.mjs'],['missing file',c=>c.files.shift()],
  ['stale file',c=>c.files.unshift('scripts/test-absent.mjs')],['overlap',c=>c.files.push(c.delegations[0].file)],
  ['unexplained delegation',c=>c.delegations[0].reason=''],['duplicate delegation',c=>c.delegations.push(c.delegations[0])],
  ['stale delegation',c=>c.delegations[0].file='scripts/test-absent.sh'],['uncovered delegation',c=>c.delegations[0].coveredBy='scripts/missing.mjs'],
  ['wrong target',c=>c.delegations[0].target='scripts/test-shell-delegation.mjs'],['self coverage',c=>c.delegations[0].coveredBy=c.delegations[0].target],
])test(`catalog fails closed: ${name}`,()=>{const c=fixture();change(c);assert.throws(()=>validateCatalog(c,discovered));});
test('newly discovered test fails closed',()=>assert.throws(()=>validateCatalog(fixture(),[...discovered,'scripts/test-new.mjs']),/Uncatalogued/));
