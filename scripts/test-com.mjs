import {spawnSync} from 'node:child_process';import {existsSync} from 'node:fs';
if(process.platform!=='win32')throw Error('Windows COM harness requires Windows');
const dotnet=process.env.DSH_DOTNET??(existsSync('.tmp/sdk/dotnet.exe')?'.tmp/sdk/dotnet.exe':'dotnet');
const r=spawnSync(dotnet,['run','--project','test/fixtures/bridge-regression/Harness.csproj','-c','Release'],{stdio:'inherit',env:{...process.env,DOTNET_NOLOGO:'1',DOTNET_CLI_TELEMETRY_OPTOUT:'1'}});if(r.error)throw r.error;process.exitCode=r.status??1;
