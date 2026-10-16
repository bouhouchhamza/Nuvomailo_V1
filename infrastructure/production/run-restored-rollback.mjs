import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const snapshot = process.argv[2];
if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(snapshot ?? ""))
  throw new Error("RESTORED_SNAPSHOT_UUID_REQUIRED");
const root = fileURLToPath(new URL("../../", import.meta.url));
const project = `nuvomailo-coordinated-${snapshot.slice(0,8)}`;
const compose = ["compose","-p",project,"-f","infrastructure/mail-lab/coordinated-backup.compose.yaml"];
const database = `rollback_${randomUUID().replaceAll("-", "")}`;
const secrets = join(root,"infrastructure/production/secrets/63131daf-896d-41d4-a7a8-bf70f4c5d9dd");
const app = `nuvomailo-${database}`;
let stage = "restore-database-start";
function docker(args, input, limit = 8*1024*1024) {
  return new Promise((resolve,reject) => {
    const child=spawn("docker",args,{cwd:root,stdio:["pipe","pipe","pipe"]});
    const chunks=[];let size=0;
    child.stdout.on("data",data=>{size+=data.length;chunks.push(data);if(size>limit)child.kill();});
    child.stderr.on("data",()=>{});
    child.on("error",reject);
    child.on("close",code=>code===0&&size<=limit?resolve(Buffer.concat(chunks)):reject(new Error("ROLLBACK_COMMAND_FAILED")));
    child.stdin.on("error",()=>{});child.stdin.end(input);
  });
}
const sql = async (query, db=database) => (await docker([...compose,"exec","-T","db","psql","-v","ON_ERROR_STOP=1","-U","lab","-d",db,"-Atc",query])).toString().trim();
try {
  await docker([...compose,"up","-d","--wait","db"]);
  stage="isolated-database-copy";
  await sql(`CREATE DATABASE ${database}`,"nuvomailo_lab");
  const dump=await docker([...compose,"exec","-T","db","pg_dump","-U","lab","-d","nuvomailo_lab","-Fc"]);
  await docker([...compose,"exec","-T","db","pg_restore","-U","lab","-d",database,"--no-owner","--exit-on-error"],dump);
  const fingerprint=()=>sql(`SELECT md5(COALESCE(string_agg(row_to_json(s)::text,'|' ORDER BY s.id),'')) FROM webmail_send_attempts s`);
  const before=await fingerprint();
  const schema=await sql("SELECT count(*)||':'||max(name) FROM pgmigrations");
  if(!schema.startsWith("31:1791977444761"))throw new Error("EXPECTED_4761_SNAPSHOT");
  const reports=[];
  for(const image of ["nuvomailo-control-plane:retained-pre4761","nuvomailo-control-plane:local-review"]) {
    stage=image.endsWith("retained-pre4761")?"old-application-on-new-schema":"forward-application";
    await docker(["run","-d","--rm","--name",app,"--network",`${project}_restore`,"--network-alias","api",
      "--read-only","--cap-drop","ALL","--security-opt","no-new-privileges:true","--memory","384m","--pids-limit","128","--tmpfs","/tmp",
      ...["db-api-password","jwt-signing-key","identity-key"].flatMap(name=>[
        "--mount",`type=bind,source=${join(secrets,name)},target=/run/secrets/${name},readonly`]),
      "-e","NODE_ENV=production","-e","PORT=4000","-e","PGHOST=db","-e","PGPORT=5432","-e","PGUSER=lab","-e",`PGDATABASE=${database}`,
      "-e","PGPASSWORD_FILE=/run/secrets/db-api-password","-e","JWT_SECRET_FILE=/run/secrets/jwt-signing-key",
      "-e","IDENTITY_ENCRYPTION_KEY_FILE=/run/secrets/identity-key","-e","FRONTEND_ORIGIN=https://nuvomailo.rehearsal.invalid",image]);
    let ready=false;
    for(let attempt=0;attempt<40;attempt++) {
      try {await docker(["exec",app,"node","-e","fetch('http://127.0.0.1:4000/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]);ready=true;break;}catch{}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    if(!ready)throw new Error("ROLLBACK_APP_NOT_READY");
    const output=await docker(["run","--rm","--network",`${project}_restore`,"--read-only","--cap-drop","ALL",
      "--memory","256m","--mount",`type=bind,source=${join(root,"backend/dist")},target=/app/dist,readonly`,
      "nuvomailo-control-plane:local-review","node","dist/scripts/closed-stack-conformance.js"]);
    const report=output.toString().split("\n").map(line=>{try{return JSON.parse(line);}catch{return null;}}).find(value=>value?.passed);
    if(!report)throw new Error("MISSING_ACCEPTANCE_REPORT");
    await docker(["stop",app]);
    if(await fingerprint()!==before)throw new Error("RESOLUTION_DATA_CHANGED");
    if(await sql("SELECT count(*)||':'||max(name) FROM pgmigrations")!==schema)throw new Error("SCHEMA_CHANGED");
    reports.push({image,checks:report.checks.length,p95ReadMs:report.p95ReadMs});
  }
  console.log(JSON.stringify({passed:true,restoredSnapshot:snapshot,isolatedDatabase:database,reports,
    resolvedSendDataPreserved:true,schemaDowngraded:false,publicPorts:false,
    limitation:"Synthetic restored DB owner role; production runtime-role rollback requires separate acceptance"}));
} catch {
  console.error(JSON.stringify({passed:false,stage,isolatedDatabase:database,code:"RESTORED_ROLLBACK_FAILED"}));
  process.exitCode=1;
} finally {
  try{await docker(["stop",app]);}catch{}
  try{await docker([...compose,"stop","db"]);}catch{process.exitCode=1;}
}
