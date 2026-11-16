import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

export function validateOnce({directory,key,run,currentKey=()=>key,now=Date.now()}) {
  fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,createHash('sha256').update(key).digest('hex')+'.json');
  let receipt;
  try { receipt=JSON.parse(fs.readFileSync(file,'utf8')); } catch {}
  if(receipt?.version===1 && receipt.key===key && Number.isFinite(receipt.at) && now>=receipt.at && now-receipt.at<24*3600000){
    console.log('Reusing successful full local checks for the identical committed tree and environment.');return false;
  }
  run();
  if(currentKey()!==key)throw Error('Project changed during validation; release stopped');
  const temporary=file+'.'+process.pid+'.tmp';
  fs.writeFileSync(temporary,JSON.stringify({version:1,key,at:now}));fs.renameSync(temporary,file);
  return true;
}
export function runReleaseTests(root) {
  const command=(cmd,args)=>{const r=spawnSync(cmd,args,{cwd:root,encoding:'utf8'});if(r.error)throw r.error;if(r.status!==0)throw Error(cmd+' failed');return r.stdout.trim();};
  const fingerprint=()=>{
    if(command('git',['status','--porcelain']))throw Error('Commit project changes before validation');
    const python=spawnSync('python',['--version'],{encoding:'utf8'});
    return JSON.stringify({tree:command('git',['rev-parse','HEAD^{tree}']),node:process.version,platform:process.platform,arch:process.arch,python:python.status===0?python.stdout.trim():'unavailable',environment:createHash('sha256').update(JSON.stringify(Object.entries(process.env).sort())).digest('hex'),args:['--test','--test-concurrency=1']});
  };
  const key=fingerprint(),directory=path.resolve(root,command('git',['rev-parse','--git-common-dir']),'release-validation');
  return validateOnce({directory,key,currentKey:fingerprint,run:()=>{
    const r=spawnSync(process.execPath,['--test','--test-concurrency=1'],{cwd:root,stdio:'inherit'});
    if(r.error)throw r.error;if(r.status!==0)throw Error('Full local checks failed; release stopped');
  }});
}
