import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createReviewManifest, parseReviewArgs, reviewUrl, stageReview } from '../scripts/deploy-test-review.js';

function fixture(t) {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'test-review-fixture-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const source=path.join(base,'review');fs.mkdirSync(source);
  fs.writeFileSync(path.join(source,'index.html'),'<html>review</html>');
  fs.mkdirSync(path.join(source,'assets'));
  fs.writeFileSync(path.join(source,'assets/font.woff2'),Buffer.from([0,128,255]));
  return {base,source};
}

test('review destination cannot escape the isolated test namespace',()=>{
  assert.deepEqual(parseReviewArgs(['--check']),{mode:'--check',slug:'recime-20261109'});
  assert.equal(reviewUrl('recime-20261109'), 'https://recipeboibot-test.89-223-123-75.sslip.io/review/recime-20261109/index.html?view=collection');
  for(const args of [['--apply','--target','production'],['--apply','--slug','../public'],['--apply','--slug','recime-20261109;restart'],['--apply','--slug'],['--apply','--slug','recime-20261109','extra'],['--restart']]) assert.throws(()=>parseReviewArgs(args));
});

test('only manifest files enter the bundle; binary bytes and nested paths are preserved',t=>{
  const {base,source}=fixture(t);
  fs.writeFileSync(path.join(base,'.env.local'),'not-for-publication');
  fs.writeFileSync(path.join(source,'assets/inter-OFL.txt'),'OFL 1.1');
  const manifest=createReviewManifest(source,'recime-20261109');
  const stage=path.join(base,'stage');stageReview(source,manifest,stage);
  assert.equal(manifest.files.length,3);
  assert.deepEqual(fs.readFileSync(path.join(stage,'files/assets/font.woff2')),Buffer.from([0,128,255]));
  assert.equal(fs.existsSync(path.join(stage,'.env.local')),false);
  assert.equal(fs.readFileSync(path.join(stage,'files/assets/inter-OFL.txt'),'utf8'),'OFL 1.1');
  assert.equal(manifest.totalBytes,fs.statSync(path.join(source,'index.html')).size+3+7);
});

test('secret-like files and traversal-like names cannot be packaged',t=>{
  const {source}=fixture(t);
  for(const filename of ['.env.local','backup.sqlite','bad;name.js']) {
    const file=path.join(source,filename);fs.writeFileSync(file,'private');
    assert.throws(()=>createReviewManifest(source,'recime-20261109'));
    fs.unlinkSync(file);
  }
});

test('concurrent review edits abort staging instead of changing the reviewed release',t=>{
  const {base,source}=fixture(t);
  const manifest=createReviewManifest(source,'recime-20261109');
  fs.writeFileSync(path.join(source,'index.html'),'<html>different</html>');
  assert.throws(()=>stageReview(source,manifest,path.join(base,'stage')),/changed/);
  assert.equal(fs.existsSync(path.join(base,'stage')),false);
});

test('review deploy is inert under Node test discovery and import',()=>{
  const result=spawnSync(process.execPath,['scripts/deploy-test-review.js'],{encoding:'utf8',env:{...process.env,NODE_TEST_CONTEXT:'child-v8'}});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');assert.equal(result.stderr,'');
});

test('remote validator and saved rollback reject unsafe bundles and concurrent menu changes',t=>{
  // The production image need not contain Python; the release host does. Run the actual
  // embedded validator locally when available, without invoking main, SSH or Docker.
  const python=[process.env.REVIEW_TEST_PYTHON,'python3','python'].filter(Boolean).find(command=>spawnSync(command,['--version'],{encoding:'utf8'}).status===0);
  if(!python){t.skip('Python validator is checked on the release workstation');return;}
  const shell=fs.readFileSync('deploy/apply-test-review.sh','utf8').replace(/\r\n?/g,'\n');
  const source=shell.split("python3 - <<'PY'\n")[1].split('\nPY')[0];
  const check=String.raw`
import contextlib,hashlib,io,json,pathlib,subprocess,sys,tarfile,tempfile,types
scope={'__name__':'validator_test'}
exec(compile(sys.stdin.read(),'apply-test-review.sh','exec'),scope)
slug='recime-20261109'; data=b'<html>review</html>'
manifest={'schema':1,'slug':slug,'url':scope['ORIGIN']+'/review/'+slug+'/index.html?view=collection','totalBytes':len(data),'files':[{'path':'index.html','bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}]}
with tempfile.TemporaryDirectory() as directory:
 archive=pathlib.Path(directory)/'review.tgz'
 def build(extra=None,link=False,bad=False):
  with tarfile.open(archive,'w:gz') as tar:
   for name,content in [('manifest.json',json.dumps(manifest).encode()),('files/index.html',b'wrong' if bad else data)]+([] if extra is None else [(extra,b'private')]):
    item=tarfile.TarInfo(name);item.size=len(content)
    if link and name=='files/index.html':item.type=tarfile.SYMTYPE;item.linkname='/etc/passwd';item.size=0;tar.addfile(item)
    else:tar.addfile(item,io.BytesIO(content))
  return hashlib.sha256(archive.read_bytes()).hexdigest()
 good=build(); value,content=scope['validate_bundle'](archive,slug,good)
 assert content=={'index.html':data}
 for kwargs in [{'extra':'files/private.json'},{'extra':'../outside.js'},{'link':True},{'bad':True}]:
  sha=build(**kwargs)
  try:scope['validate_bundle'](archive,slug,sha)
  except RuntimeError:pass
  else:raise AssertionError('Unsafe bundle was accepted')
 build()
 try:scope['validate_bundle'](archive,slug,'0'*64)
 except RuntimeError:pass
 else:raise AssertionError('Wrong bundle hash accepted')
 scope['unchanged']({'pid':123},{'pid':123})
 try:scope['unchanged']({'pid':123},{'pid':124})
 except RuntimeError:pass
 else:raise AssertionError('Restart was accepted')
with tempfile.TemporaryDirectory() as directory:
 folder=pathlib.Path(directory)
 old={'type':'web_app','text':'Menu','web_app':{'url':'https://test.invalid/old'}}
 new={'type':'web_app','text':'Menu','web_app':{'url':'https://test.invalid/review'}}
 scope['save_rollback'](folder,old,new)
 current=[new];writes=[]
 previous_run=subprocess.run
 def fake_run(args,**kwargs):
  assert args[:4]==['docker','exec','-i','recipeboibot-test']
  body=json.loads(kwargs['input'])
  if body['action']=='set':
   assert body['expected']==current[0]
   writes.append(body['menu']);current[0]=body['menu']
  return types.SimpleNamespace(returncode=0,stdout=json.dumps(current[0]).encode(),stderr=b'')
 subprocess.run=fake_run
 def rollback():
  with contextlib.redirect_stdout(io.StringIO()):
   exec(compile((folder/'rollback-menu.py').read_text(),'rollback-menu.py','exec'),{'__file__':str(folder/'rollback-menu.py')})
 try:
  rollback();assert current[0]==old and writes==[old]
  try:rollback()
  except SystemExit as error:assert error.code==0
  assert writes==[old]
  current[0]={'type':'commands'}
  try:rollback()
  except SystemExit as error:assert 'changed after review' in str(error)
  else:raise AssertionError('Concurrent menu change was overwritten')
  assert writes==[old]
 finally:subprocess.run=previous_run
print('remote-validator-ok')
`;
  const result=spawnSync(python,['-c',check],{input:source,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/remote-validator-ok/);
});
