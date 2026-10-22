import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {pathToFileURL} from 'node:url';
import {resolveExecutionFilesystemRoots,executionLockIdentity} from '../lib/execution-publication.mjs';
import { validateWorkspace } from "../lib/lifecycle.mjs";
import { validateReadinessAttestation } from "../lib/readiness.mjs";
import {
  TEST_ONLY_ACK,
  TEST_ONLY_ACK_ENV,
  TEST_ONLY_CRASH_ENV,
  publishCandidate,
  readinessAttestationPath,
  recoverIncompletePublication,
} from "../lib/publisher.mjs";
import {
  PUBLISHER_CLI,
  READY_FIXTURE,
  copyTree,
  removeTemporaryDirectory,
  snapshot,
  temporaryDirectory,
  transactionResidues,
  writeResumeManifest,
} from "./publisher-fixtures.mjs";

async function readyPromotionFixture(base) {
  const target = path.join(base, "draft workspace");
  const candidate = path.join(base, "ready candidate");
  await copyTree(READY_FIXTURE, target);
  const targetFeature = path.join(target, "feature_spec.md");
  await fs.writeFile(
    targetFeature,
    (await fs.readFile(targetFeature, "utf8")).replace("status: ready", "status: draft"),
    "utf8",
  );
  await copyTree(target, candidate);
  const candidateFeature = path.join(candidate, "feature_spec.md");
  await fs.writeFile(
    candidateFeature,
    (await fs.readFile(candidateFeature, "utf8")).replace("status: draft", "status: ready"),
    "utf8",
  );
  return {
    target,
    candidate,
    attestation: await readinessAttestationPath(target),
  };
}

async function withTemporaryDirectory(prefix, action) {
  const base = await temporaryDirectory(prefix);
  try {
    return await action(base);
  } finally {
    await removeTemporaryDirectory(base);
  }
}

function crashPublisher(target, candidate, attestation, checkpoint) {
  return spawnSync(
    process.execPath,
    [
      PUBLISHER_CLI,
      "RESUME",
      target,
      candidate,
      "--readiness-attestation",
      attestation,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        [TEST_ONLY_ACK_ENV]: TEST_ONLY_ACK,
        [TEST_ONLY_CRASH_ENV]: checkpoint,
      },
    },
  );
}

test("RESUME publishes exact draft to ready promotion and materializes a current attestation", async () => {
  await withTemporaryDirectory("stnl-ready-promotion-", async (base) => {
    const { target, candidate, attestation } = await readyPromotionFixture(base);
    await publishCandidate("RESUME", target, candidate, {
      readinessAttestation: attestation,
    });
    assert.equal(validateWorkspace(target).status, "ready");
    assert.doesNotThrow(() => validateReadinessAttestation(target, attestation));
    assert.deepEqual(await transactionResidues(target), []);
  });
});

test("publisher CLI performs ready promotion without a manifest or hand-written JSON", async () => {
  await withTemporaryDirectory("stnl-ready-promotion-cli-", async (base) => {
    const { target, candidate, attestation } = await readyPromotionFixture(base);
    const result = spawnSync(
      process.execPath,
      [
        PUBLISHER_CLI,
        "RESUME",
        target,
        candidate,
        "--readiness-attestation",
        "auto",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS: RESUME published validated candidate/u);
    assert.match(result.stdout, /PASS: readiness attestation available at /u);
    assert.equal(validateWorkspace(target).status, "ready");
    assert.doesNotThrow(() => validateReadinessAttestation(target, attestation));
  });
});

test("ready promotion rejects manifests and any content change beyond status", async () => {
  await withTemporaryDirectory("stnl-ready-promotion-bounds-", async (base) => {
    const { target, candidate, attestation } = await readyPromotionFixture(base);
    const manifest = path.join(base, "manual.json");
    await writeResumeManifest(manifest, target);
    await assert.rejects(
      publishCandidate("RESUME", target, candidate, {
        manifestPath: manifest,
        readinessAttestation: attestation,
      }),
      /uses no external manifest/u,
    );
    assert.equal(await fs.stat(manifest).then(() => true, () => false), true);

    const feature = path.join(candidate, "feature_spec.md");
    await fs.writeFile(
      feature,
      (await fs.readFile(feature, "utf8")).replace(
        "Provide deterministic",
        "Provide changed deterministic",
      ),
      "utf8",
    );
    const before = snapshot(target);
    await assert.rejects(
      publishCandidate("RESUME", target, candidate, {
        readinessAttestation: attestation,
      }),
      /feature section changes/u,
    );
    assert.equal(snapshot(target), before);
    assert.equal(await fs.stat(attestation).then(() => true, () => false), false);
  });
});

test("safe rollback retains a validated promotion attestation for a direct retry", async () => {
  await withTemporaryDirectory("stnl-ready-promotion-retry-", async (base) => {
    const { target, candidate, attestation } = await readyPromotionFixture(base);
    const before = snapshot(target);
    await assert.rejects(
      publishCandidate("RESUME", target, candidate, {
        readinessAttestation: attestation,
        afterBackupVerified: async () => {
          throw new Error("fixture failure after backup verification");
        },
      }),
      /readiness attestation intentionally retained for retry/u,
    );
    assert.equal(snapshot(target), before);
    assert.equal(await fs.stat(attestation).then(() => true, () => false), true);
    assert.deepEqual(await transactionResidues(target), []);

    await publishCandidate("RESUME", target, candidate, {
      readinessAttestation: attestation,
    });
    assert.equal(validateWorkspace(target).status, "ready");
    assert.doesNotThrow(() => validateReadinessAttestation(target, attestation));
  });
});

test("candidate-validated recovery commits only with the matching attestation", async (t) => {
  for (const removeAttestation of [false, true]) {
    await t.test(removeAttestation ? "missing attestation rolls back" : "matching attestation commits", async () => {
      await withTemporaryDirectory("stnl-ready-promotion-recovery-", async (base) => {
        const { target, candidate, attestation } = await readyPromotionFixture(base);
        const crashed = crashPublisher(
          target,
          candidate,
          attestation,
          "AFTER_TARGET_VALIDATION",
        );
        assert.notEqual(crashed.status, 0);
        assert.equal(await fs.stat(attestation).then(() => true, () => false), true);
        if (removeAttestation) await fs.unlink(attestation);
        await recoverIncompletePublication(target);
        assert.equal(validateWorkspace(target).status, removeAttestation ? "draft" : "ready");
        if (!removeAttestation) {
          assert.doesNotThrow(() => validateReadinessAttestation(target, attestation));
        }
        assert.deepEqual(await transactionResidues(target), []);
      });
    });
  }
});


test('READY auto selects only its material role and nonGit recovery retains the normal policy',async()=>{
  await withTemporaryDirectory('stnl-ready-auto-nongit-',async base=>{
    const {target,candidate}=await readyPromotionFixture(base);
    await fs.rm(path.join(base,'.git'),{recursive:true});
    const productRoot=await fs.realpath(base),temporaryRoot=path.join(productRoot,'explicit excluded operations');
    const filesystemContext={productRoot,temporaryRoot,excludedRoots:[temporaryRoot]};
    const attestation=await readinessAttestationPath(target,{filesystemContext});
    await publishCandidate('RESUME',target,candidate,{readinessAttestation:'auto',filesystemContext});
    assert.equal(path.dirname(attestation),path.join(temporaryRoot,(await resolveExecutionFilesystemRoots({specRoot:target,executionRoot:path.join(target,'execution')},filesystemContext)).specKey));
    assert.doesNotThrow(()=>validateReadinessAttestation(target,attestation));
    assert.equal(await recoverIncompletePublication(target,{filesystemContext}),false);
    assert.equal(await fs.stat(path.join(path.dirname(target),`.${path.basename(target)}.readiness-attestation.json`)).catch(()=>null),null);
  });
});

for(const point of ['AFTER_TARGET_VALIDATION','TARGET_TO_BACKUP_RENAMED'])test(`READY auto keeps exact attestation through process interruption at ${point}`,async()=>{
  await withTemporaryDirectory('stnl-ready-auto-crash-',async base=>{
    const {target,candidate,attestation}=await readyPromotionFixture(base);
    const crashed=crashPublisher(target,candidate,'auto',point);
    assert.equal(crashed.signal,'SIGKILL',crashed.stderr);
    const bytes=await fs.readFile(attestation);
    assert.equal(await recoverIncompletePublication(target),true);
    assert.equal(validateWorkspace(target).status,point==='TARGET_TO_BACKUP_RENAMED'?'draft':'ready');
    assert.deepEqual(await fs.readFile(attestation),bytes);
    assert.equal(await recoverIncompletePublication(target),false);
    if(point==='TARGET_TO_BACKUP_RENAMED') {
      await publishCandidate('RESUME',target,candidate,{readinessAttestation:'auto'});
      assert.equal(validateWorkspace(target).status,'ready');assert.deepEqual(await fs.readFile(attestation),bytes);
    }
  });
});

test('READY auto refuses foreign bytes without replacing the persistent attestation',async()=>{
  await withTemporaryDirectory('stnl-ready-auto-foreign-',async base=>{
    const {target,candidate,attestation}=await readyPromotionFixture(base);
    await fs.mkdir(path.dirname(attestation),{recursive:true});
    await fs.writeFile(attestation,'foreign persistent attestation\n');
    const before=snapshot(target),bytes=await fs.readFile(attestation);
    await assert.rejects(publishCandidate('RESUME',target,candidate,{readinessAttestation:'auto'}),/attestation|JSON/i);
    assert.deepEqual(await fs.readFile(attestation),bytes);assert.equal(snapshot(target),before);
  });
});

for(const mode of ['INIT','CLOSE'])test(`READY auto rejects ${mode} before operational allocation`,async()=>{
  await withTemporaryDirectory('stnl-ready-auto-mode-',async base=>{
    const {target,candidate}=await readyPromotionFixture(base);
    await assert.rejects(publishCandidate(mode,target,mode==='CLOSE'?null:candidate,{readinessAttestation:'auto'}),/only valid for RESUME/);
    assert.equal(await fs.stat(path.join(base,'tmp')).catch(()=>null),null);
  });
});

test('READY auto keeps its pre-journal authority after uncertain attestation parent sync and retries after owner exit',async()=>{
  await withTemporaryDirectory('stnl-ready-auto-sync-',async base=>{
    const {target,candidate,attestation}=await readyPromotionFixture(base);
    const publisher=pathToFileURL(path.join(path.dirname(PUBLISHER_CLI),'lib/publisher.mjs')).href;
    const code=`import fs from 'node:fs/promises';import {publishCandidate,journalPath,readinessAttestationPath} from ${JSON.stringify(publisher)};
const [target,candidate]=process.argv.slice(1),attestation=await readinessAttestationPath(target),journal=await journalPath(target);
const probe=await fs.open(process.cwd(),'r'),prototype=Object.getPrototypeOf(probe),sync=prototype.sync;await probe.close();let injected=0;
prototype.sync=async function(){const own=await this.stat(),parent=await fs.stat(new URL('.', 'file://'+attestation)).catch(()=>null);
if(!injected&&own.isDirectory()&&parent&&own.ino===parent.ino&&await fs.stat(attestation).catch(()=>null)&&!await fs.stat(journal).catch(()=>null)){injected++;throw Object.assign(Error('controlled attestation parent sync'),{code:'EIO'});}return sync.call(this);};
try{await publishCandidate('RESUME',target,candidate,{readinessAttestation:'auto'});process.exitCode=2;}catch(error){console.log(JSON.stringify({injected,retained:error.retainExecutionLock,message:error.message}));process.exitCode=1;}finally{prototype.sync=sync;}`;
    const before=snapshot(target),result=spawnSync(process.execPath,['--input-type=module','-e',code,target,candidate],{encoding:'utf8',timeout:20000});
    assert.equal(result.status,1,result.stderr);const observed=JSON.parse(result.stdout.trim());
    assert.equal(observed.injected,1);assert.equal(observed.retained,true);
    assert.match(observed.message,/intentionally retained/);assert.equal(snapshot(target),before);
    const bytes=await fs.readFile(attestation);
    const roots=await resolveExecutionFilesystemRoots({specRoot:target,executionRoot:path.join(target,'execution')});
    await fs.access((await executionLockIdentity({specRoot:roots.specRoot,executionRoot:roots.executionRoot})).lockPath);
    assert.equal(await recoverIncompletePublication(target),false);
    assert.deepEqual(await fs.readFile(attestation),bytes);
    await publishCandidate('RESUME',target,candidate,{readinessAttestation:'auto'});
    assert.equal(validateWorkspace(target).status,'ready');assert.deepEqual(await fs.readFile(attestation),bytes);
  });
});


test('READY auto rejects incompatible manifest and quiet source states before any operational allocation',async()=>{
  for(const kind of ['manifest','ready-ready','draft-draft'])await withTemporaryDirectory('stnl-ready-auto-preflight-',async base=>{
    const {target,candidate}=await readyPromotionFixture(base);
    const options={readinessAttestation:'auto'};
    if(kind==='manifest')options.manifestPath=path.join(base,'not a promotion manifest.json');
    if(kind==='ready-ready')await fs.writeFile(path.join(target,'feature_spec.md'),(await fs.readFile(path.join(target,'feature_spec.md'),'utf8')).replace('status: draft','status: ready'));
    if(kind==='draft-draft')await fs.writeFile(path.join(candidate,'feature_spec.md'),(await fs.readFile(path.join(candidate,'feature_spec.md'),'utf8')).replace('status: ready','status: draft'));
    const before=snapshot(target),proposed=snapshot(candidate);
    await assert.rejects(publishCandidate('RESUME',target,candidate,options),kind==='manifest'?/uses no external manifest/:/draft.*ready|ready promotion/i);
    assert.equal(snapshot(target),before);assert.equal(snapshot(candidate),proposed);
    assert.equal(await fs.stat(path.join(base,'tmp')).catch(()=>null),null);
  });
});

test('READY auto reentry completes its pending promotion before refusing a new already-ready request',async()=>{
  await withTemporaryDirectory('stnl-ready-auto-pending-',async base=>{
    const {target,candidate,attestation}=await readyPromotionFixture(base);
    const crashed=crashPublisher(target,candidate,'auto','AFTER_TARGET_VALIDATION');assert.equal(crashed.signal,'SIGKILL',crashed.stderr);
    const bytes=await fs.readFile(attestation);
    await assert.rejects(publishCandidate('RESUME',target,candidate,{readinessAttestation:'auto'}),/draft.*ready|ready promotion/i);
    assert.equal(validateWorkspace(target).status,'ready');assert.deepEqual(await fs.readFile(attestation),bytes);
    assert.equal(await recoverIncompletePublication(target),false);
    assert.deepEqual(await transactionResidues(target),[]);
  });
});
