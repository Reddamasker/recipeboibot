import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';

const shell=process.platform==='win32'?path.join(process.env.ProgramFiles||'C:/Program Files','Git/bin/bash.exe'):'/bin/sh';
for(const file of ['apply-release.sh','apply-test-release.sh','apply-max-release.sh']) {
  test(`${file} captures the running image even when the latest tag points to another build`,()=>{
    const lines=readFileSync('deploy/'+file,'utf8').split(/\r?\n/);
    const capture=lines.find(line=>line.trim().startsWith('running_image='));
    const tag=lines.find(line=>line.includes('docker tag "$running_image" "$previous"'));
    assert.ok(capture,'Capture the immutable ID from the container before building');
    assert.ok(tag,'The rollback tag must identify the running image');
    const result=spawnSync(shell,['-c',`set -eu
docker() {
  case "$1" in
    inspect) printf '%s\\n' 'sha256:actually-running';;
    tag) printf '%s|%s\\n' "$2" "$3";;
    *) return 1;;
  esac
}
sudo() { if [ "$1" = '-n' ]; then shift; fi; "$@"; }
container=fixture-container
image=repository-with-stale-latest
previous=rollback-target
${capture}
${tag}
`],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    assert.equal(result.stdout.trim(),'sha256:actually-running|rollback-target');
    assert.ok(lines.indexOf(capture)<lines.findIndex(line=>line.includes('compose')&&line.includes(' build ')),'Capture before build can replace latest');
  });
}
