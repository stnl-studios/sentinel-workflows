// Mechanical check-design regressions, not a native judgment or a general
// documentation parser. These finite fixture variants never authorize product
// behavior: a formal reviewer still checks missing/contradictory explanations.
import test from 'node:test';
import assert from 'node:assert/strict';

const input=[{sku:'A',quantity:2},{sku:'B',quantity:1},{sku:'A',quantity:3}];
const output=[{sku:'A',quantity:5},{sku:'B',quantity:1}];
const categories=['non-array','non-object','missing or extra','non-string','empty',
  'leading or trailing whitespace','fractional','zero','negative','unsafe','incompatible types',
  'NaN','Infinity','overflow','Number.MAX_SAFE_INTEGER','case-sensitive','first occurrence','does not mutate'];
const documentation=`# Usage
import { aggregateShipmentItems } from './src/aggregate-shipment-items.mjs';
node --test test/aggregate-shipment-items.test.mjs
\`\`\`json
${JSON.stringify(input)}
\`\`\`
\`\`\`json
${JSON.stringify(output)}
\`\`\`
${categories.join('; ')}
`;

function assertFixtureDocumentation(doc) {
  // Match the actual import binding/path, rather than a quote or wrapping style.
  assert.match(doc,/import\s*\{\s*aggregateShipmentItems\s*\}\s*from\s*(['"])\.\/src\/aggregate-shipment-items\.mjs\1/u);
  assert.ok(doc.includes('node --test test/aggregate-shipment-items.test.mjs'));
  // This fixture uses JSON examples; private HTML comments are not selectors.
  const examples=[...doc.matchAll(/```json\s*([\s\S]*?)```/gu)].map(item=>JSON.parse(item[1]));
  assert.deepEqual(examples,[input,output]);
  const prose=doc.replace(/```[\s\S]*?```/gu,'').replace(/\s+/gu,' ');
  for(const category of categories)assert.ok(prose.includes(category),category);
}
function assertFixtureResult(actual) {
  assert.deepEqual(actual,output,'group order and values are normative');
  for(const item of actual)assert.deepEqual(Reflect.ownKeys(item).sort(),['quantity','sku']);
}

test('B-T13 documentary reflow, CRLF, import quotes and absent private markers preserve the fixture checks',()=>{
  for(const doc of [documentation,
    documentation.replace('incompatible types','incompatible\n  types'),
    documentation.replaceAll('\n','\r\n'),
    documentation.replace("import { aggregateShipmentItems } from './src/aggregate-shipment-items.mjs';",
      'import {\n aggregateShipmentItems\n} from "./src/aggregate-shipment-items.mjs";')])assertFixtureDocumentation(doc);
  assert.equal(documentation.includes('<!-- input -->'),false);
  assert.equal(documentation.replace('incompatible types','incompatible\n types').includes('incompatible types'),false,
    'the original raw includes discriminant would reject equivalent content');
});
test('B-T13 removing any required fixture category or damaging the import/example remains a failure',()=>{
  for(const category of categories)assert.throws(()=>assertFixtureDocumentation(documentation.replace(category,'')),{name:'AssertionError'},category);
  assert.throws(()=>assertFixtureDocumentation(documentation.replace('quantity":5','quantity":6')));
  assert.throws(()=>assertFixtureDocumentation(documentation.replace('./src/aggregate-shipment-items.mjs','./src/foreign.mjs')));
  assert.throws(()=>assertFixtureDocumentation(documentation.replace('aggregateShipmentItems','anotherExport')));
});
test('B-T18 object enumeration is incidental; group order, values, and exact own keys remain mandatory',()=>{
  assertFixtureResult(output);
  const equivalent=output.map(({sku,quantity})=>({quantity,sku}));assertFixtureResult(equivalent);
  assert.notDeepEqual(Reflect.ownKeys(equivalent[0]),['sku','quantity'],'the original order assertion rejected this equivalent result');
  for(const wrong of [[...output].reverse(),[{sku:'A',quantity:6},output[1]],
    [{...output[0],extra:true},output[1]],[{...output[0],[Symbol('extra')]:true},output[1]]])assert.throws(()=>assertFixtureResult(wrong));
});
