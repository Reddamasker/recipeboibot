// Infrastructure-only release used by the three standard deploy entry points.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const storageFiles=['deploy/storage.py','deploy/backup.sh','deploy/retention.sh','deploy/ops-monitor.sh',
  'deploy/apply-release.sh','deploy/apply-test-release.sh','deploy/apply-max-release.sh'];
export function deployStorage(contour,mode){
  if(!['production','test','max'].includes(contour)||!['--check','--apply'].includes(mode)||process.argv.length!==4)throw Error('Usage: deploy --check|--apply --storage-only');
  function run(cmd,args,options={}){const r=spawnSync(cmd,args,{cwd:root,encoding:'utf8',maxBuffer:3e6,...options});if(r.status!==0)throw Error(r.stderr||`${cmd} failed: ${r.status}`);return r.stdout;}
  const ssh=['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=6','-i',path.join(os.homedir(),'.ssh','recipeboibot_ed25519')];
  const target='root@89.223.123.75';
  const script=fs.readFileSync(path.join(root,'deploy/apply-storage.sh'),'utf8');
  process.stdout.write(run('ssh',[...ssh,target,`bash -s -- '${contour}' --check`],{input:script}));
  if(mode==='--check')return;
  if(run('git',['status','--porcelain']).trim())throw Error('Storage release requires a clean committed tree');
  const revision=run('git',['rev-parse','HEAD']).trim();
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'recipe-storage-'));
  const archive=path.join(temp,'storage.tgz');
  run('git',['archive','--format=tar.gz','-o',archive,revision,...storageFiles]);
  const hash=createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  const remote=`/root/recipeboibot-storage-${hash}.tgz`;
  run('scp',[...ssh,archive,`${target}:${remote}`]);
  // Streaming progress plus keep-alives survive restore validation of many old files.
  const r=spawnSync('ssh',[...ssh,target,`bash -s -- '${contour}' --apply '${revision}' '${hash}'`],{cwd:root,input:script,stdio:['pipe','inherit','inherit']});
  if(r.status!==0)throw Error(`Storage deployment failed (${r.status}); inspect retained diagnostics before retry`);
}
