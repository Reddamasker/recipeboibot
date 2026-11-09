#!/bin/bash
# The existing Node process and cached / document are deliberately untouched.
set -euo pipefail
mode=${1:?Missing mode}
slug=${2:?Missing slug}
bundle=${3:--}
[[ "$mode" = --check || "$mode" = --apply ]] || exit 2
[[ "$slug" =~ ^recime-[0-9]{8}(-[a-z0-9]{1,24})?$ ]] || exit 2
[[ "$mode" = --check || "$bundle" =~ ^[0-9a-f]{64}$ ]] || exit 2
exec 9>/tmp/recipeboibot-test-deploy.lock
flock -n 9 || { echo 'Another test deployment is running' >&2; exit 1; }
exec 8>/tmp/recipeboibot-docker-deploy.lock
flock -n 8 || { echo 'Another Docker deployment is running' >&2; exit 1; }
export REVIEW_MODE="$mode" REVIEW_SLUG="$slug" REVIEW_BUNDLE="$bundle"
umask 077
python3 - <<'PY'
import datetime, hashlib, json, os, pathlib, re, shutil, subprocess, sys, tarfile, urllib.request

ROOT = pathlib.Path('/opt/recipeboibot-test')
NAMES = ('recipeboibot-test', 'recipeboibot', 'recipeboibot-max')
ORIGIN = 'https://recipeboibot-test.89-223-123-75.sslip.io'
LIMIT = 64 * 1024 * 1024
TYPES = {'.html','.css','.js','.json','.txt','.svg','.png','.jpg','.jpeg','.webp','.avif','.gif','.woff','.woff2','.ttf','.otf'}

def run(args, data=None):
    try:
        value = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=60)
    except subprocess.TimeoutExpired:
        raise RuntimeError('Command timed out: ' + pathlib.Path(args[0]).name) from None
    if value.returncode:
        # Do not forward provider output, environment, token-bearing URLs or subprocess arguments.
        raise RuntimeError('Command failed: ' + pathlib.Path(args[0]).name)
    return value.stdout

MENU_JS = r"""
import fs from 'node:fs';
import {config} from './src/config.js';
let actual=null,writeAccepted=false;
const observations=[];
const safeMenu=value=>value&&typeof value==='object'?{
  type:value.type,
  ...(typeof value.text==='string'?{text:value.text}:{}),
  ...(typeof value.web_app?.url==='string'?{web_app:{url:value.web_app.url}}:{})
}:null;
const finish=(ok,error=null)=>console.log(JSON.stringify({ok,error,menu:safeMenu(actual),writeAccepted,observations}));
try {
  if (!config.testContour || config.botPlatform !== 'telegram' || config.testBotUsername !== 'recipeboi_test_bot') throw Error('Wrong contour');
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const canonical=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
  const origin = (process.env.TELEGRAM_API_ORIGIN || 'https://api.telegram.org').replace(/\/+$/, '');
  async function call(method, body={}, timeoutMs=10000) {
    let response;
    try { response=await fetch(`${origin}/bot${config.telegramToken}/${method}`, {method:'POST',headers:{'content-type':'application/json','cache-control':'no-cache, no-store'},body:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)}); }
    catch { throw Error('Telegram transport unavailable'); }
    const payload=await response.json();
    if (!payload.ok) throw Error('Telegram request rejected');
    return payload.result;
  }
  const me=await call('getMe');
  if (me.username !== 'recipeboi_test_bot') throw Error('Unexpected bot');
  if (input.action === 'set') {
    actual=await call('getChatMenuButton');
    observations.push({phase:'guard',menu:safeMenu(actual)});
    if (canonical(actual)!==canonical(input.expected)) { finish(false,'menu_changed_concurrently'); }
    else {
      writeAccepted=(await call('setChatMenuButton',{menu_button:input.menu}))===true;
      if (!writeAccepted) finish(false,'write_not_accepted');
      else {
        // Read-after-write can briefly return the preceding default menu. Never repeat the write.
        const deadline=Date.now()+20000;
        let verified=false;
        for(let attempt=1;attempt<=10;attempt++) {
          if(attempt>1) {
            if(Date.now()+2000>=deadline)break;
            await new Promise(resolve=>setTimeout(resolve,2000));
          }
          const remaining=deadline-Date.now();
          if(remaining<=0)break;
          try {
            actual=await call('getChatMenuButton',{},Math.min(5000,remaining));
            observations.push({phase:'verify',attempt,menu:safeMenu(actual)});
            if(canonical(actual)===canonical(input.menu)){verified=true;break;}
          } catch { observations.push({phase:'verify',attempt,error:'read_unavailable'}); }
        }
        finish(verified,verified?null:'verification_unconfirmed');
      }
    }
  } else if (input.action === 'get') {
    actual=await call('getChatMenuButton');observations.push({phase:'read',menu:safeMenu(actual)});finish(true);
  } else finish(false,'unknown_action');
} catch { finish(false,'test_menu_operation_failed'); }
"""

MENU_HISTORY=[]
class MenuOperationError(RuntimeError):
    def __init__(self, details):
        super().__init__('Test menu operation unconfirmed: '+str(details.get('error')))
        self.details=details

def menu(action='get', value=None, expected=None):
    details=json.loads(run(['docker','exec','-i','recipeboibot-test','node','--input-type=module','-e',MENU_JS], json.dumps({'action':action,'menu':value,'expected':expected}).encode()))
    MENU_HISTORY.append({'action':action,**details})
    if not details.get('ok'):raise MenuOperationError(details)
    return details['menu']

TREE_JS = r"""
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
const exclude=process.argv[1], items=[];
function walk(relative) {
  if(relative===exclude)return;
  for(const entry of fs.readdirSync('/app/'+relative,{withFileTypes:true}).sort((a,b)=>Buffer.compare(Buffer.from(a.name),Buffer.from(b.name)))) {
    const name=relative+'/'+entry.name;
    if(name===exclude)continue;
    if(entry.isSymbolicLink())throw Error('Unexpected source symlink');
    if(entry.isDirectory())walk(name);
    else if(entry.isFile())items.push([name,crypto.createHash('sha256').update(fs.readFileSync('/app/'+name)).digest('hex')]);
  }
}
walk('src');walk('public');
console.log(JSON.stringify({sha256:crypto.createHash('sha256').update(JSON.stringify(items)).digest('hex'),files:items.length}));
"""
DB_JS = r"""
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('/app/data/recipes.sqlite',{readOnly:true});
const integrity=db.prepare('PRAGMA integrity_check').all();
const foreignKeys=db.prepare('PRAGMA foreign_key_check').all().length;
db.close();
const ok=integrity.length===1&&Object.values(integrity[0])[0]==='ok'&&foreignKeys===0;
console.log(JSON.stringify({ok,foreignKeyViolations:foreignKeys}));if(!ok)process.exitCode=1;
"""

def sha(data): return hashlib.sha256(data).hexdigest()
def write_json(file, data): file.write_text(json.dumps(data, indent=2)+'\n', encoding='utf8')
def host_tree(root, excluded):
    items=[]
    for base in ('src','public'):
        for file in sorted((root/base).rglob('*')):
            relative=file.relative_to(root).as_posix()
            if relative==excluded or relative.startswith(excluded+'/'): continue
            if file.is_symlink(): raise RuntimeError('Unexpected source symlink')
            if file.is_file(): items.append([relative,sha(file.read_bytes())])
    return {'sha256':sha(json.dumps(items,separators=(',',':')).encode()),'files':len(items)}

def snapshot(slug):
    result={}
    fmt='{"id":{{json .Id}},"pid":{{.State.Pid}},"startedAt":{{json .State.StartedAt}},"restartCount":{{.RestartCount}},"image":{{json .Image}},"running":{{.State.Running}}}'
    for name in NAMES:
        root=pathlib.Path('/opt')/name
        exclude='public/review/'+slug if name=='recipeboibot-test' else '__none__'
        runtime=json.loads(run(['docker','inspect','--format',fmt,name]))
        if not runtime['running']: raise RuntimeError('A protected container is not running')
        files={}
        for filename in ('.env.local','compose.yaml','compose.test.yaml','compose.max.yaml'):
            file=root/filename
            if file.exists(): files[filename]=sha(file.read_bytes())
        if '.env.local' not in files or not any(k.startswith('compose') for k in files): raise RuntimeError('Missing protected configuration')
        health=json.loads(run(['docker','exec',name,'node','-e',"fetch('http://127.0.0.1:3087/healthz',{signal:AbortSignal.timeout(15000)}).then(r=>r.json()).then(x=>{if(!x.ok)process.exit(1);console.log(JSON.stringify({ok:x.ok}))}).catch(()=>process.exit(1))"]))
        result[name]={'runtime':runtime,'containerSources':json.loads(run(['docker','exec',name,'node','-e',TREE_JS,exclude])),'hostSources':host_tree(root,exclude),'configuration':files,'health':health,'integrity':json.loads(run(['docker','exec',name,'node','-e',DB_JS]))}
    ready=json.loads(run(['docker','exec','recipeboibot-test','node','-e',"fetch('http://127.0.0.1:3087/readyz',{signal:AbortSignal.timeout(15000)}).then(r=>r.json()).then(x=>{if(!x.ok)process.exit(1);console.log(JSON.stringify({ok:x.ok}))}).catch(()=>process.exit(1))"]))
    result['testReady']=ready
    return result

def unchanged(before, after):
    if before != after: raise RuntimeError('Protected runtime, files, configuration or health changed')

def validate_bundle(archive, slug, expected_hash):
    if archive.stat().st_size>LIMIT+1048576: raise RuntimeError('Compressed bundle exceeds size limit')
    if sha(archive.read_bytes()) != expected_hash: raise RuntimeError('Bundle SHA-256 mismatch')
    with tarfile.open(archive,'r:gz') as tar:
        members=tar.getmembers()
        if len(members)>513 or len({m.name for m in members})!=len(members): raise RuntimeError('Invalid archive entries')
        if any(not m.isfile() or m.size<0 or m.size>LIMIT for m in members): raise RuntimeError('Only bounded regular files are allowed')
        if sum(m.size for m in members)>LIMIT+256000: raise RuntimeError('Archive exceeds expanded size limit')
        metadata=next((m for m in members if m.name=='manifest.json'),None)
        if metadata is None or metadata.size>256000: raise RuntimeError('Missing or oversized manifest')
        manifest=json.load(tar.extractfile(metadata))
        url=ORIGIN+'/review/'+slug+'/index.html?view=collection'
        if manifest.get('schema')!=1 or manifest.get('slug')!=slug or manifest.get('url')!=url: raise RuntimeError('Manifest target mismatch')
        files=manifest.get('files')
        if not isinstance(files,list) or not 1<=len(files)<=512: raise RuntimeError('Invalid manifest files')
        expected={'manifest.json'}
        content={}
        total=0
        for item in files:
            name=item.get('path','')
            parts=name.split('/')
            if not parts or any(not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*',p) for p in parts) or pathlib.PurePosixPath(name).suffix.lower() not in TYPES: raise RuntimeError('Unsafe manifest path')
            member_name='files/'+name
            if member_name in expected: raise RuntimeError('Duplicate manifest path')
            expected.add(member_name)
            member=next((m for m in members if m.name==member_name),None)
            if member is None or member.size!=item.get('bytes'): raise RuntimeError('Missing or wrong-size file')
            total+=member.size
            if total>LIMIT: raise RuntimeError('Bundle exceeds size limit')
            data=tar.extractfile(member).read()
            if sha(data)!=item.get('sha256'): raise RuntimeError('File SHA-256 mismatch')
            content[name]=data
        if {m.name for m in members}!=expected or 'index.html' not in content or total!=manifest.get('totalBytes'): raise RuntimeError('Manifest/archive disagreement')
        return manifest,content

def ensure_new(slug):
    parent=ROOT/'public'/'review'
    if ROOT.resolve()!=ROOT or (ROOT/'public').resolve()!=ROOT/'public' or (parent.exists() and parent.resolve()!=parent): raise RuntimeError('Unsafe host review parent')
    if (parent/slug).exists() or (parent/slug).is_symlink(): raise RuntimeError('Review slug already exists on host; choose a new suffix')
    source=r"const fs=require('node:fs');for(const p of ['/app/public','/app/public/review']){if(fs.existsSync(p)&&fs.realpathSync(p)!==p)process.exit(2)}if(fs.existsSync('/app/public/review/'+process.argv[1]))process.exit(3);console.log('ok')"
    run(['docker','exec','recipeboibot-test','node','-e',source,slug])

def save_rollback(folder, old, new):
    write_json(folder/'menu-before.json',old)
    write_json(folder/'menu-review.json',new)
    # Both JSON objects are public UI settings. Credentials are read only inside the test container.
    rollback='''import json,pathlib,subprocess,sys
folder=pathlib.Path(__file__).parent
helper=(folder/'menu-helper.mjs').read_text()
def call(body):
 r=subprocess.run(['docker','exec','-i','recipeboibot-test','node','--input-type=module','-e',helper],input=json.dumps(body).encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
 if r.returncode: raise SystemExit('Test menu rollback failed; no credentials logged')
 result=json.loads(r.stdout)
 if not result.get('ok'):print(json.dumps(result));raise SystemExit('Test menu rollback unconfirmed')
 return result['menu']
old=json.loads((folder/'menu-before.json').read_text()); expected=json.loads((folder/'menu-review.json').read_text())
current=call({'action':'get'})
if current not in (old,expected): raise SystemExit('Menu changed after review; rollback refused')
# Even an old-looking read can be stale. Confirm an explicit write and its subsequent reads.
if call({'action':'set','menu':old,'expected':current})!=old: raise SystemExit('Rollback verification failed')
print('Previous test menu restored')
'''
    (folder/'menu-helper.mjs').write_text(MENU_JS)
    (folder/'rollback-menu.py').write_text(rollback)
    shell='#!/bin/bash\nset -euo pipefail\nexec 9>/tmp/recipeboibot-test-deploy.lock\nflock -n 9\nexec 8>/tmp/recipeboibot-docker-deploy.lock\nflock -n 8\npython3 '+str(folder/'rollback-menu.py')+'\n'
    (folder/'rollback-menu.sh').write_text(shell)

def main():
    mode=os.environ['REVIEW_MODE'];slug=os.environ['REVIEW_SLUG'];bundle=os.environ['REVIEW_BUNDLE']
    ensure_new(slug)
    before=snapshot(slug)
    old=menu()
    url=ORIGIN+'/review/'+slug+'/index.html?view=collection'
    wanted={'type':'web_app','text':'Меню','web_app':{'url':url}}
    report={'ok':True,'mode':mode,'slug':slug,'url':url,'before':before,'menuBefore':old,'rootEntryUnchanged':True}
    if mode=='--check':
        print(json.dumps(report));return
    archive=pathlib.Path('/root/recipeboibot-test-review-'+bundle+'.tgz')
    manifest,content=validate_bundle(archive,slug,bundle)
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    folder=ROOT/'backups'/'ui-review'/(stamp+'-'+bundle[:12])
    folder.mkdir(parents=True,exist_ok=False)
    report.update({'ok':False,'status':'prepared','bundleSha256':bundle,'manifest':manifest,'reportPath':str(folder/'report.json'),'rollbackMenuCommand':'bash '+str(folder/'rollback-menu.sh'),'menuAfter':None})
    write_json(folder/'before.json',before);write_json(folder/'manifest.json',manifest)
    shutil.copyfile(archive,folder/'review.tgz')
    save_rollback(folder,old,wanted)
    write_json(folder/'report.json',report)
    attempted_menu=False
    try:
        # Unique new tree: existing source files are never overwritten. Entry is installed last.
        host=ROOT/'public'/'review'/slug
        host.mkdir(parents=True,exist_ok=False)
        container='/app/public/review/'+slug
        run(['docker','exec','recipeboibot-test','mkdir','-p',container])
        for name,data in content.items():
            if name=='index.html':continue
            file=host/name;file.parent.mkdir(parents=True,exist_ok=True);file.write_bytes(data);file.chmod(0o644)
            run(['docker','exec','recipeboibot-test','mkdir','-p',str(pathlib.PurePosixPath(container,name).parent)])
            run(['docker','cp',str(file),'recipeboibot-test:'+container+'/'+name])
        index=folder/'index.html';index.write_bytes(content['index.html']);index.chmod(0o644)
        run(['docker','cp',str(index),'recipeboibot-test:'+container+'/.index.pending'])
        run(['docker','exec','recipeboibot-test','mv',container+'/.index.pending',container+'/index.html'])
        pending=host/'.index.pending';pending.write_bytes(content['index.html']);pending.chmod(0o644);pending.replace(host/'index.html')
        # Public tree must be readable by a future image's non-root user.
        for directory in [host,host.parent,*[p for p in host.rglob('*') if p.is_dir()]]:directory.chmod(0o755)
        for item in manifest['files']:
            name=item['path']
            if sha((host/name).read_bytes())!=item['sha256']:raise RuntimeError('Host artifact mismatch')
            if sha(run(['docker','exec','recipeboibot-test','cat',container+'/'+name]))!=item['sha256']:raise RuntimeError('Container artifact mismatch')
            request=urllib.request.Request(ORIGIN+'/review/'+slug+'/'+name,headers={'Cache-Control':'no-cache','Accept-Encoding':'identity'})
            with urllib.request.urlopen(request,timeout=20) as response:
                if response.status!=200 or sha(response.read(LIMIT+1))!=item['sha256']:raise RuntimeError('HTTPS artifact mismatch')
        unchanged(before,snapshot(slug))
        report['status']='changing_menu'
        write_json(folder/'report.json',report)
        attempted_menu=True
        actual=menu('set',wanted,old)
        if actual!=wanted:raise RuntimeError('Menu verification mismatch')
        report['menuAfter']=actual
        after=snapshot(slug);unchanged(before,after)
        report['after']=after
        report['menuOperations']=MENU_HISTORY
        report['ok']=True;report['status']='verified'
        report['note']='Static review only. Cached / and existing message buttons remain unchanged. A future polling startup can reset the menu.'
        write_json(folder/'report.json',report)
        print(json.dumps(report))
    except Exception as error:
        report['ok']=False;report['status']='failed';report['error']=str(error)
        if isinstance(error,MenuOperationError):report['menuObserved']=error.details.get('menu')
        if attempted_menu:
            try:
                current=menu()
                if current in (wanted,old):report['rollbackMenu']=menu('set',old,current)==old
                else:report['rollbackMenu']=False
            except Exception:report['rollbackMenu']=False
        report['menuOperations']=MENU_HISTORY
        report['partialArtifactRetained']=str(ROOT/'public'/'review'/slug)
        write_json(folder/'report.json',report)
        print(json.dumps(report));sys.exit(1)

if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'ok':False,'error':str(error)}));sys.exit(1)
PY
