// Pure validation shared by the runner and its adversarial regression tests.
export function validateCatalog(catalog, actual) {
  if(catalog.format!=='sentinel-test-catalog-v1'||!Array.isArray(catalog.files)||!Array.isArray(catalog.excluded)
    ||(catalog.delegations!==undefined&&!Array.isArray(catalog.delegations)))
    throw new Error('invalid scripts/test-catalog.json format');
  const listed=catalog.files;
  const excluded=catalog.excluded;
  const delegations=catalog.delegations??[];
  const sortedUnique=values=>values.every((value,index)=>typeof value==='string'&&value.length>0&&(index===0||values[index-1]<value));
  if(!sortedUnique(listed))throw new Error('test catalog must contain unique, sorted paths');
  for(const [name,items] of [['exclusions',excluded],['delegations',delegations]]) {
    if(items.some(item=>!item||typeof item.file!=='string'||typeof item.reason!=='string'||!item.reason.trim())
      ||!sortedUnique(items.map(item=>item.file)))throw new Error(`test catalog ${name} must be unique, sorted, and explained`);
  }
  for(const item of delegations) {
    if(!item.file.endsWith('.sh')||!listed.includes(item.target)||!listed.includes(item.coveredBy)
      ||item.target===item.coveredBy||item.coveredBy!=='scripts/test-shell-delegation.mjs'
      ||item.target!==item.file.replace(/\.sh$/u,'.mjs'))
      throw new Error('test catalog delegation requires a distinct runnable target and delegation contract');
  }
  const all=[...listed,...excluded.map(item=>item.file),...delegations.map(item=>item.file)];
  if(new Set(all).size!==all.length)throw new Error('test catalog classifications must be separate');
  const missing=actual.filter(file=>!all.includes(file));
  const stale=all.filter(file=>!actual.includes(file));
  if(missing.length||stale.length)throw new Error([
    missing.length?'Uncatalogued test files (review and add deliberately):\n'+missing.map(file=>'  '+file).join('\n'):'',
    stale.length?'Catalog entries no longer discovered (remove or update deliberately):\n'+stale.map(file=>'  '+file).join('\n'):'',
  ].filter(Boolean).join('\n'));
  return {listed,excluded,delegations};
}
