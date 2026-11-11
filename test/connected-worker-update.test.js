import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {buildSharpCutsOperationalReadiness,buildSharpCutsChannelReadiness} from '../src/automation/sharp-cuts-automation.js';
import {ANSWER_PRESENTATION_GUIDANCE} from '../src/agent/answer-presentation.js';

test('existing WhatsApp configuration is not presented as unstarted onboarding or proven delivery',()=>{
 const whatsappStatus={configured:true,receiveEnabled:true,executionHeld:true,sendEnabled:false};
 const r=buildSharpCutsOperationalReadiness({whatsappStatus}).whatsapp;
 assert.equal(r.configured,true);assert.equal(r.executionHeld,true);assert.equal(r.providerDeliveryVerified,false);assert.equal(r.cloudApiConnected,null);
 const c=buildSharpCutsChannelReadiness({whatsappStatus}).find(x=>x.id==='whatsapp');
 assert.equal(c.status,'configured_execution_held');assert.ok(c.blocked.includes('execution_held'));assert.ok(!c.blocked.includes('provider_onboarding'));
});

test('public webhook host is routed through the API guard before static files',async()=>{
 const routes=JSON.parse(await readFile(new URL('../vercel.json',import.meta.url),'utf8')).routes;
 assert.deepEqual(routes[0],{src:'/(.*)',has:[{type:'host',value:'scnovawa.vercel.app'}],dest:'/api/index'});
 assert.ok(routes.findIndex(r=>r.handle==='filesystem')>0);
 assert.match(ANSWER_PRESENTATION_GUIDANCE,/saved language preference/);
 assert.doesNotMatch(ANSWER_PRESENTATION_GUIDANCE,/Match the language of the owner's current request/);
});

test('worker guard accepts its exact old dependency bindings but rejects task tampering', {skip:process.platform!=='win32'},async t=>{
 const root=await mkdtemp(join(tmpdir(),'nova-worker-binding-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=await readFile(new URL('../scripts/windows-local-worker-service.ps1',import.meta.url),'utf8');
 const body=source.slice(source.indexOf('  function Get-WorkerSnapshot {'),source.indexOf('  $priorTask=Get-ScheduledTask'));
 const script=join(root,'binding.ps1');
 await writeFile(script,`$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$name='fixture';$node='C:\\node.exe';$git='C:\\new\\git.exe';$codex='C:\\new\\codex.exe';$helper='C:\\helper.exe';$versions='C:\\versions';$runtimeVersion='${'b'.repeat(40)}';$PreviewUrl='https://fixture.vercel.app';$root='C:\\fixture';$arguments='new'
$script:s=[pscustomobject]@{pid=17;taskId='';state='idle';lastHeartbeat='now';lastSuccessfulPoll='now';runtimeVersion='${'a'.repeat(40)}';previewUrl=$PreviewUrl;gitExecutable='C:\\old\\git.exe';codexExecutable='C:\\removed\\codex.exe';repositoryProof=[pscustomobject]@{root=$root;branch='preview';repository='hshanbour/nova-brain';head='${'c'.repeat(40)}'}}
$oldScript=Join-Path (Join-Path $versions $s.runtimeVersion) 'scripts\\persistent-local-worker.js'
$oldArgs='"'+$oldScript+'" --preview-url "'+$PreviewUrl+'" --repository-root "'+$root+'" --repository-branch "preview" --runtime-version "'+$s.runtimeVersion+'" --git-executable "'+$s.gitExecutable+'" --codex-executable "'+$s.codexExecutable+'" --credential-helper "'+$helper+'"'
$script:task=[pscustomobject]@{State='Running';Actions=@([pscustomobject]@{Execute=$node;Arguments=$oldArgs;WorkingDirectory=$root})}
function Get-ScheduledTask {param($TaskName,$ErrorAction) return $script:task}
function Get-Process {param($Id,$ErrorAction) return [pscustomobject]@{Path=$node}}
function Read-WorkerStatus {return $script:s}
function Read-LockPid {return 17}
function Test-RecentTimestamp {param($value) return $true}
function Test-Path {param($LiteralPath,$PathType) return $true}
${body}
$valid=Get-WorkerSnapshot
$script:task.Actions[0].Arguments+=' --unexpected'
$tampered=Get-WorkerSnapshot
@{valid=$valid.CurrentBindingMismatch;tampered=$tampered.CurrentBindingMismatch;healthy=$valid.Healthy}|ConvertTo-Json -Compress
`);
 const {stdout}=await promisify(execFile)(join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true});
 assert.deepEqual(JSON.parse(stdout.trim()),{valid:false,tampered:true,healthy:true});
 assert.ok(source.indexOf('prior runtime rollback binding')<source.indexOf('$stopCurrent={'));
});
