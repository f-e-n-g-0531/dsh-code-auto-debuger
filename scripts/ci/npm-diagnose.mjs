import {spawnSync} from 'node:child_process';
const name='@feng0531/dsh-code-auto-debuger';
const run=(args)=>spawnSync('npm',args,{encoding:'utf8',timeout:60000});
const version=run(['--version']);console.log('npm CLI '+version.stdout.trim());
if(!process.env.NODE_AUTH_TOKEN)throw Error('NPM_AUTOMATION_TOKEN unavailable');
const result=run(['stage','list',name,'--json','--registry=https://registry.npmjs.org']);
// Never print arbitrary CLI output, auth configuration or token fields.
if(result.status!==0){console.log(JSON.stringify({stagedQuery:'failed',exitCode:result.status,authFailure:/E401|E403|ENEEDAUTH/.test(result.stderr),unsupported:/Unknown command|not a valid npm command/.test(result.stderr)}));process.exitCode=1;}
else {let data;try{data=JSON.parse(result.stdout);}catch{throw Error('Staged query returned non-JSON; raw output withheld');}
function safe(value){if(Array.isArray(value))return value.map(safe);if(value&&typeof value==='object'){return Object.fromEntries(Object.entries(value).filter(([k])=>/^(id|stageId|stage_id|name|version|status|state|shasum|integrity|created|updated|createdAt|updatedAt|packages|staged|stages|items|results|total|distTags|dist-tags|tag|message)$/i.test(k)).map(([k,v])=>[k,safe(v)]));}return value;}
console.log(JSON.stringify({stagedQuery:'success',data:safe(data)}));}
const r=await fetch('https://registry.npmjs.org/'+encodeURIComponent(name)+'?diagnose='+Date.now(),{headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('Public registry '+r.status);const publicData=await r.json();console.log(JSON.stringify({publicVersions:Object.keys(publicData.versions??{}),distTags:publicData['dist-tags'],time:publicData.time}));
