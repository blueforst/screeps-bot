'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const ROOT=path.resolve(__dirname),DELIVERY=path.join(ROOT,'maintenance'),P=require(path.join(DELIVERY,'PACKAGE.json'));
const A=require(path.join(DELIVERY,'tools/adapt-executor.cjs'));
const S=require(path.join(DELIVERY,'tools/source.cjs'));
const C=require(path.join(DELIVERY,'tools/common.cjs'));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const blob=b=>crypto.createHash('sha1').update(Buffer.from(`blob ${b.length}\0`)).update(b).digest('hex');
function git(repo,args){try{return cp.execFileSync('git',['-c','core.autocrlf=false','-c','core.eol=lf','-C',repo,...args],{encoding:null,maxBuffer:64*1048576,timeout:120000,stdio:['ignore','pipe','pipe']});}catch{throw new Error('SOURCE_GIT_READ_FAILED');}}
const text=(repo,args)=>git(repo,args).toString('utf8').trim();
function parse(args){const o={};for(let i=0;i<args.length;i+=2){if(!['--repo','--source-ref','--out','--typescript'].includes(args[i])||!args[i+1]||o[args[i].slice(2)]!==undefined)throw new Error('INVALID_ARGUMENTS');o[args[i].slice(2)]=args[i+1];}if(!o.repo||!o['source-ref']||!o.out)throw new Error('REQUIRED_ARGUMENT_MISSING');return o;}
function build(o){
 C.verify();
 const repo=path.resolve(o.repo),out=path.resolve(o.out),sourceHead=text(repo,['rev-parse','--verify',o['source-ref']+'^{commit}']);
 if(fs.existsSync(out))throw new Error('OUTPUT_ALREADY_EXISTS');
 const parents=text(repo,['show','-s','--format=%P',sourceHead]).split(' ').filter(Boolean);
 if(parents.length!==1||parents[0]!==P.compatBase||text(repo,['show','-s','--format=%s',sourceHead])!==P.sourceMessage||
   text(repo,['rev-parse',P.compatBase+'^{tree}'])!==P.compatBaseTree)throw new Error('SOURCE_IDENTITY_MISMATCH');
 const paths=git(repo,['diff','--name-only','-z',P.compatBase,sourceHead]).toString('utf8').split('\0').filter(Boolean).sort();
 if(JSON.stringify(paths)!==JSON.stringify([...P.sourcePaths].sort()))throw new Error('SOURCE_PATH_SET_MISMATCH');
 const files={};for(const name of paths){const bytes=git(repo,['show',sourceHead+':'+name]);files[name]={after:{bytes:bytes.length,sha256:sha(bytes),gitBlob:blob(bytes)}};}
 const runtimeBytes=git(repo,['show',sourceHead+':'+P.runtimePath]);
 const runtimeText=runtimeBytes.toString('utf8');
 const emitter=/\bFULL_COST_EXPERIMENT\s*=\s*["']([^"']+)["']/.exec(runtimeText)?.[1];
 if(!emitter||emitter!==P.runtimeEmitterId)throw new Error('RUNTIME_EMITTER_IDENTITY_MISMATCH');
 const tree=text(repo,['rev-parse',sourceHead+'^{tree}']);
 const runtimeArtifacts=S.compileRuntimeArtifacts(repo,sourceHead,o.typescript?path.resolve(o.typescript):path.join(repo,'node_modules/typescript'));
 const artifactSummary=S.runtimeArtifactsManifest(runtimeArtifacts);
 const source={head:sourceHead,tree,base:P.compatBase,paths:paths.length,sourceModified:false,implementationHead:sourceHead,
  runtimeEmitterId:emitter,runtimeArtifacts:{compilerVersion:runtimeArtifacts.compilerVersion,modules:Object.keys(runtimeArtifacts.files).length}};
 const manifest={kind:'full-cost-FC1-source/v1',expectedSourceTree:tree,runtimeEmitterId:emitter,runtimeArtifacts:artifactSummary,files};
 const receipt={kind:'fc1-offline-assembly/v1',authorizationStatus:'WAITING_FOR_EXPLICIT_AUTHORIZATION',
  source,onlineAttempted:false,networkWrites:0,atMs:Date.now()};
 const inherited=path.resolve(ROOT,'../compat-fc1-executor-admission-repair-i/task-package/final-executor/baseline-executor');
 const result=A.resolve(inherited,out,source,manifest,receipt,runtimeArtifacts);
 const policy=JSON.parse(fs.readFileSync(path.join(out,'policy.json'),'utf8'));
 if(policy.kind!==P.kind||policy.runtimeEmitterId!==emitter||policy.newRoundAuthorization?.status!=='WAITING_FOR_EXPLICIT_AUTHORIZATION'||policy.newRoundAuthorization.authorizationId!==null||
   policy.newRoundAuthorization.runId!==null||policy.authorizationId!==P.authorizationId||policy.parentRunId!==P.runId)throw new Error('AUTHORIZATION_GATE_INVALID');
 return{status:'FC1_OFFLINE_EXECUTOR_ASSEMBLED_AUTHORIZATION_REQUIRED',executor:out,fingerprint:result.fingerprint,
  source,measurementPolicy:P.measurement,onlineAttempted:false,networkWrites:0};
}
if(require.main===module){try{process.stdout.write(JSON.stringify(build(parse(process.argv.slice(2))))+'\n');}catch(e){process.stderr.write((e.code||e.message||'ASSEMBLY_FAILED')+'\n');process.exitCode=1;}}
module.exports={build,parse};
