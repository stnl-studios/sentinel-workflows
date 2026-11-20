import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

export const BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const CASES = Object.freeze([
  { id: 'rename', difficulty: 'small', title: 'Renomear uma tarefa', requirements: [
    'No TodoService existente, adicionar async rename(id,title). Usar validateId e validateTitle existentes; retornar e persistir a tarefa com título normalizado, preservando ID, completed, ordem e todas as outras tarefas. Exatamente uma escrita no sucesso.',
    'ID inválido/inexistente e título inválido rejeitam sem escrita. Propagar falha do store, nunca declarar sucesso sem persistência.',
    'CLI: rename ID TITULO... junta palavras por espaço. Sucesso: uma linha JSON da tarefa, stderr vazio, exit0. Falha de dados/store: stdout vazio, stderr não vazio, exit1. Argumentos insuficientes: exit2. Um novo processo list deve observar o título persistido.',
    'Preservar add/list/complete, validação e persistência existentes. Caso independente; não implementar consulta/importação.'
  ] },
  { id: 'query', difficulty: 'medium', title: 'Listagem filtrada de tarefas', requirements: [
    'Evoluir async TodoService.list(options={}). options objeto simples com somente status e query opcionais. status: all (default), pending ou completed. query: string (default vazia), trim e comparação case-insensitive por substring no título. Filtros combinados por AND. Resultado sempre em ordem crescente de ID, incluindo list() sem opções.',
    'Não mutar opções, registros nem store, e não escrever. Objeto/opções/tipos/status inválidos rejeitam; null, array e campos desconhecidos inválidos. Query vazia ou whitespace equivale a sem busca.',
    'CLI: list [--status all|pending|completed] [--query TEXTO]. Flags em qualquer ordem, cada flag no máximo uma vez, valor separado obrigatório. Flags desconhecidas/duplicadas/sem valor ou argumentos posicionais: exit2. Status inválido: exit1. Sucesso: JSON lines, uma tarefa por linha, zero linhas sem resultados, stderr vazio e exit0. Erros: stdout vazio e stderr não vazio.',
    'Preservar add/complete, validação e persistência existentes. Caso independente; não exigir rename/importação.'
  ] },
  { id: 'import', difficulty: 'cross-layer', trajectory: { minSlices: 2, description: 'Duas entregas naturais: serviço/persistência → CLI; preservar contratos anteriores; permitir alteração de arquivo compartilhado quando necessário, sem forçar.' }, title: 'Importação JSON all-or-nothing', requirements: [
    'Adicionar async TodoService.importTodos(document). Documento objeto contendo somente todos: array. Cada item objeto contendo somente title obrigatório e completed opcional boolean (default false). Título usa validateTitle existente. Rejeitar null/arrays/shape errado, campos extras e IDs fornecidos. Títulos duplicados são permitidos.',
    'Validar lote inteiro antes de qualquer escrita. Append preserva tarefas existentes e atribui IDs sequenciais a partir de max ID existente +1 na ordem de entrada. Retornar array de novas tarefas. Lote vazio retorna [] sem escrita. Lote não vazio faz exatamente uma store.write; erros de leitura/escrita propagam sem falso sucesso. Não mutar entrada nem registros existentes.',
    'CLI: import ARQUIVO_JSON, exatamente um caminho. Ler e parsear JSON, importar, imprimir uma linha JSON contendo array importado, exit0 e stderr vazio. Arquivo ausente, JSON inválido, schema inválido: exit1, stdout vazio, stderr não vazio, bytes do store intactos. Uso inválido exit2. Falha no final do lote não pode importar prefixo. Novo processo list observa lote inteiro.',
    'Atomicidade exigida é validação antes da escrita e uma escrita pela infraestrutura atômica existente. Não requer transação concorrente/crash recovery adicional. Preservar add/list/complete. Caso independente; não exigir rename/consulta.'
  ] }
].map(item => Object.freeze({ ...item, trajectory: Object.freeze(item.trajectory ?? { minSlices: 1 }), requirements: Object.freeze(item.requirements) })));

function inside(root, name) { const rel = path.relative(root, name); return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel); }
async function safePath(name) {
  const abs = path.resolve(name);
  if (!inside(BASE, abs)) throw new Error('path must be inside benchmark base');
  let current = BASE;
  for (const component of path.relative(BASE, abs).split(path.sep)) {
    current = path.join(current, component);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('symlinks are not permitted'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return abs;
}
async function files(root, prefix = '') {
  const result = {};
  for (const entry of (await fs.readdir(root, { withFileTypes: true })).sort((a,b)=>a.name.localeCompare(b.name))) {
    const rel = path.join(prefix, entry.name), absolute = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error('product symlink rejected');
    if (entry.isDirectory()) Object.assign(result, await files(absolute, rel));
    else if (entry.isFile()) { const stat = await fs.stat(absolute); if (stat.size > 2*1024*1024) throw new Error('product file too large'); result[rel] = hash(await fs.readFile(absolute)); }
    else throw new Error('non-regular product file rejected');
    if (Object.keys(result).length > 200) throw new Error('too many product files');
  }
  return result;
}
async function productHashesAt(workspace) {
  await safePath(path.join(workspace, 'src')); await safePath(path.join(workspace, 'package.json'));
  const entries = await files(path.join(workspace, 'src'));
  return { ...Object.fromEntries(Object.entries(entries).map(([key,value])=>[`src/${key}`,value])), 'package.json': hash(await fs.readFile(path.join(workspace,'package.json'))) };
}
function subprocess(args, options) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { ...options, detached: true, stdio: ['ignore','pipe','pipe'] });
    let output = '', error = '', stopped = false;
    const stop = () => { stopped = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(stop, Math.min(20000,options.timeoutMs??20000));
    for (const [stream, setter] of [[child.stdout, v=>{output+=v;}],[child.stderr,v=>{error+=v;}]]) stream.on('data', chunk=>{setter(chunk.toString()); if (output.length+error.length > 2*1024*1024) stop();});
    child.on('error', e=>{error+=e.message;});
    child.on('close',(code,signal)=>{clearTimeout(timer); resolve({code,signal,stopped,stdout:output,stderr:error});});
  });
}
export async function verifyCase({ caseId, workspace, evidenceDir, engineRoot = path.join(BASE,'bench'), deadline = Infinity }) {
  if(deadline<=Date.now())throw Error('CASE_DEADLINE');
  if (!CASES.some(c=>c.id===caseId)) throw new Error('unknown case');
  engineRoot = await safePath(engineRoot);
  await safePath(path.join(engineRoot,'cases/baseline-hashes.json')); await safePath(path.join(engineRoot,'cases/oracle.test.mjs'));
  workspace = await safePath(workspace); evidenceDir = await safePath(evidenceDir);
  if (workspace === evidenceDir || inside(workspace,evidenceDir) || inside(evidenceDir,workspace)) throw new Error('evidence and workspace must be disjoint');
  if (!(inside(path.join(BASE,'temp'),evidenceDir) || inside(path.join(BASE,'evidence'),evidenceDir))) throw new Error('evidence must be under base/temp or base/evidence');
  await fs.mkdir(path.dirname(evidenceDir),{recursive:true});
  await fs.mkdir(evidenceDir); // Exclusive reservation: existing evidence is never overwritten.
  const checks = [], productHashes = {}, baselineTestHashes = {};
  const snapshot = path.join(evidenceDir,'product'), scratch=path.join(evidenceDir,'scratch');
  const check = async (name,fn) => { try {await fn();checks.push({name,status:'PASS'});}catch(e){checks.push({name,status:'FAIL',error:String(e.message).slice(0,3000)});} };
  await check('capture immutable product and frozen regression',async()=>{
    Object.assign(productHashes,await productHashesAt(workspace));
    const expected = JSON.parse(await fs.readFile(path.join(engineRoot,'cases/baseline-hashes.json'),'utf8'));
    Object.assign(baselineTestHashes,await files(path.join(BASE,'fixtures/todo/test')));
    if (JSON.stringify(expected)!==JSON.stringify(baselineTestHashes)) throw new Error('frozen regression fingerprint changed');
    await fs.mkdir(snapshot); await fs.mkdir(scratch);
    for(const file of Object.keys(productHashes)){await fs.mkdir(path.dirname(path.join(snapshot,file)),{recursive:true});await fs.copyFile(path.join(workspace,file),path.join(snapshot,file));}
    await fs.cp(path.join(BASE,'fixtures/todo/test'),path.join(snapshot,'test'),{recursive:true});
    if (JSON.stringify(productHashes)!==JSON.stringify(await productHashesAt(snapshot))) throw new Error('source changed during capture');
  });
  if (checks[0].status==='PASS') {
    const env={PATH:process.env.PATH, HOME:scratch, TMPDIR:scratch,TMP:scratch,TEMP:scratch, BENCH_PRODUCT:snapshot,BENCH_CASE:caseId,BENCH_SCRATCH:scratch};
    for(const [name,args] of [['frozen baseline regression',['--test',...Object.keys(baselineTestHashes).map(file=>path.join(snapshot,'test',file))]],['independent acceptance',['--test',path.join(engineRoot,'cases/oracle.test.mjs')]]]) {
      await check(name,async()=>{if(deadline<=Date.now())throw Error('CASE_DEADLINE');const result=await subprocess(args,{cwd:snapshot,env,timeoutMs:deadline-Date.now()});await fs.writeFile(path.join(evidenceDir,`${name.replaceAll(' ','-')}.json`),JSON.stringify(result,null,2),{flag:'wx'});if(result.code!==0||result.stopped)throw new Error(`subprocess failed (${result.code}/${result.signal}): ${result.stdout.slice(-2200)} ${result.stderr.slice(-500)}`); const expectedTests=name==='frozen baseline regression'?8:{rename:4,query:3,import:5}[caseId]; for(const [metric,count] of [['tests',expectedTests],['pass',expectedTests],['fail',0],['cancelled',0],['skipped',0]])if(!result.stdout.split('\n').includes(`# ${metric} ${count}`))throw new Error(`incomplete oracle execution: ${metric} expected ${count}`);});
    }
    await check('frozen regression unchanged',async()=>{if(JSON.stringify(baselineTestHashes)!==JSON.stringify(await files(path.join(snapshot,'test'))))throw new Error('regression modified during verification');});
    await check('source product unchanged',async()=>{if(JSON.stringify(productHashes)!==JSON.stringify(await productHashesAt(workspace)))throw new Error('workspace product changed during verification');});
    await check('captured product unchanged',async()=>{if(JSON.stringify(productHashes)!==JSON.stringify(await productHashesAt(snapshot)))throw new Error('product self-modified during verification');});
  }
  const result={caseId,engineRoot,status:checks.every(c=>c.status==='PASS')?'PASS':'FAIL',checks,productHashes,baselineTestHashes,sourceWorkspace:workspace,snapshot, evidenceDir, note:'External deterministic acceptance, not formal Sentinel CLOSE, not an adversarial security sandbox.'};
  await fs.writeFile(path.join(evidenceDir,'report.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  return result;
}
