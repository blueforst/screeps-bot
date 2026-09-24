'use strict';
/** Offline-only reproduction. No HTTP, credentials, Git writes or experiment
 * markers. Runs the exact GitHub observe.cjs in a VM, isolating the preflight
 * result-contract gate with successful synthetic authorization/Git/offline
 * prerequisites. A filesystem barrier stops even the positive control before
 * creation of a run directory. This is NOT a full executor or online test.
 */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=__dirname;
const expected={
  'observe.cjs':'6f5449cbc6a2be91f31d86b3f1a2227efa3a1e5f',
  'test-result.json':'dbb53ea488cc6f141eb1e3d6c5c494bc347d1286',
  'test-contract.json':'d0c4f94e5f8f0423ed8820ef505e72e96271b08f',
};
const identities={};
for(const [name,blob] of Object.entries(expected)){
 const b=fs.readFileSync(path.join(root,name));
 const actual=crypto.createHash('sha1').update(Buffer.from('blob '+b.length+'\0')).update(b).digest('hex');
 assert.equal(actual,blob,'Git object mismatch: '+name);identities[name]={bytes:b.length,gitBlob:actual};
}
const actualResult=JSON.parse(fs.readFileSync(path.join(root,'test-result.json'),'utf8'));
const actualContract=JSON.parse(fs.readFileSync(path.join(root,'test-contract.json'),'utf8'));
const code=fs.readFileSync(path.join(root,'observe.cjs'),'utf8');
async function one(name,mutate,pending=false){
 const tests=structuredClone(actualResult),contract=structuredClone(actualContract);mutate(tests,contract);
 let barrierCalls=0;
 const policy={authorizationId:'offline-fixture-new-authorization',parentRunId:'offline-fixture-new-run',
 historicalAuthorizationId:'offline-fixture-old-authorization',historicalRunId:'offline-fixture-old-run',
 newRoundAuthorization:{status:pending?'WAITING_FOR_EXPLICIT_AUTHORIZATION':'AUTHORIZED',
 authorizationId:'offline-fixture-new-authorization',runId:'offline-fixture-new-run'}};
 const source={head:'0cdbd061c2645366bd409dbdbd262881d277cb35',tree:'70dff5366fabf4586aef30acd2c62c290824a772'};
 const fingerprint=actualResult.packageFingerprint;
 const C={POLICY:policy,fail:message=>{throw Error(message);},verifyPackage:()=>({fingerprint}),
 json:file=>file===path.resolve('/tests/result.json')?tests:file===path.resolve('/offline/result.json')?
 {status:'READ_XV_RETRY_OFFLINE_VERIFIED',packageFingerprint:fingerprint,source}:(()=>{throw Error('UNEXPECTED_JSON_READ');})()};
 const R={ROOT:'/package',baseline:()=>{},source:()=>source,outside:()=>{}};
 const forbiddenFs=new Proxy({},{get:()=>()=>{barrierCalls++;throw Error('SIDE_EFFECT_BARRIER');}});
 const modules={'node:fs':forbiddenFs,'node:path':path,'node:child_process':{},'node:perf_hooks':require('node:perf_hooks'),
 '../runtime/common.cjs':C,'../runtime/actions.cjs':{},'../runtime/identity.cjs':{},'./repository.cjs':R,
 '../runtime/time-budget.cjs':{},'../references/test-contract.json':contract};
 const module={exports:{}};
 function load(id){if(Object.hasOwn(modules,id))return modules[id];throw Error('UNEXPECTED_MODULE:'+id);}
 vm.runInNewContext(code,{require:load,module,process:{pid:1},console},{filename:'observe.cjs',timeout:1000});
 let outcome='UNEXPECTED_RETURN';
 try{await module.exports.observe({compat:'/compat',refactor:'/refactor',work:'/work',secret:'/not-read',tests:'/tests',offline:'/offline',
 execute:true,'exclusive-target':true,'prior-workers-stopped':true});}catch(e){outcome=e.message;}
 return{name,outcome,barrierCalls,networkCalls:0,experimentMarkersWritten:0};
}
(async()=>{
 const scenarios=[];
 scenarios.push(await one('pending_authorization_control',()=>{},true));
 scenarios.push(await one('authentic_archived_result_and_contract',()=>{}));
 scenarios.push(await one('diagnostic_control_change_status_only',t=>{t.status='READ_XV_RETRY_PACKAGE_TESTS_VERIFIED';}));
 scenarios.push(await one('diagnostic_control_change_status_and_count',(t,k)=>{t.status='READ_XV_RETRY_PACKAGE_TESTS_VERIFIED';k.count=135;}));
 scenarios.push(await one('diagnostic_control_satisfy_all_three_legacy_checks',(t,k)=>{t.status='READ_XV_RETRY_PACKAGE_TESTS_VERIFIED';k.count=135;t.failed=0;}));
 const expectedOutcomes=['NEW_ROUND_AUTHORIZATION_REQUIRED','OFFLINE_GATES_MISSING','OFFLINE_GATES_MISSING','OFFLINE_GATES_MISSING','SIDE_EFFECT_BARRIER'];
 assert.deepEqual(scenarios.map(x=>x.outcome),expectedOutcomes);
 assert.deepEqual(scenarios.map(x=>x.barrierCalls),[0,0,0,0,1]);
 const report={status:'BLOCKER_REPRODUCED',commit:'11b818fb250900273ee485cc60766c10a493b375',node:process.version,
 scope:'Exact observe.cjs preflight with archived authentic test-result and test-contract. Authorization, Git prerequisites and offline build result are synthetic success fixtures; fs writes prohibited. No full repository suite or online validation.',
 inputIdentities:identities,
 findings:[{field:'tests.status',actual:actualResult.status,expected:'READ_XV_RETRY_PACKAGE_TESTS_VERIFIED'},
 {field:'test-contract.count',actual:'absent',comparison:'tests.passed (135) !== undefined'},
 {field:'tests.failed (top-level)',actual:'absent',comparison:'undefined !== 0'}],
 scenarios,warning:'The modified diagnostic controls are not repaired artifacts. Do not modify historical results or bypass the gate to deploy.'};
 fs.writeFileSync(path.join(root,'reproduction-result.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
