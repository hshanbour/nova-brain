import {readFile} from "node:fs/promises";
import {readConfig} from "../../src/config/env.js";
import {createSharpCutsCustomerReader} from "../../src/automation/sharp-cuts-customer-reader.js";
import {createSenderMarketingClient} from "../../src/email/sender-marketing.js";
import {describeCampaignSource,readCampaignAddresses} from "../../src/email/sharp-cuts-audience.js";

// Operator workflow. By default it only reads the exact original export,
// current staging aggregate and provider status. No raw identifiers in output.
// --apply-transfer <reviewed hash> is only for a separately authorised group
// import. Nothing here can submit a campaign or send an email.
async function run() {
  const args=process.argv.slice(2);
  const options=new Map();
  for(let i=0;i<args.length;i+=2){
    if(!["--source","--evidence","--apply-transfer"].includes(args[i])||!args[i+1]||
      options.has(args[i]))throw Error("Invalid arguments.");
    options.set(args[i],args[i+1]);
  }
  if(!options.get("--source"))throw Error("Use --source with the previously verified Sharp Cuts client CSV.");
  const {addresses,sharedAddresses}=readCampaignAddresses(await readFile(options.get("--source")));
  const cfg=readConfig(process.env),reader=createSharpCutsCustomerReader({config:cfg.sharpCutsCustomerDatabase});
  if(!reader||!cfg.sharpCutsEmail.configured)return {status:"existing_preview_bindings_required",distinctSourceAddresses:addresses.length,contactsTransferred:0};
  const snap=await reader.snapshot(),source=describeCampaignSource(snap.emailSource,snap.channels.email.verifiedEligible);
  if(source.membershipStatus!=="matched")throw Error("Staging membership changed. Reconcile the cohort first.");
  let evidence=[];
  if(options.has("--evidence")){
    const input=JSON.parse(await readFile(options.get("--evidence"),"utf8"));
    if(input.sourceSnapshotHash!==source.originalExport.sourceHash||!Array.isArray(input.records))
      throw Error("Evidence file does not identify the verified source.");
    evidence=input.records;
  }
  const client=createSenderMarketingClient({config:cfg.sharpCutsEmail});
  return client.reconcileAudience({addresses,sharedAddresses,evidence,membershipHash:source.membershipHash,approvalHash:options.get("--apply-transfer")});
}

try {
  const result=await run();
  console.log(JSON.stringify(result));
  if(result.status==="provider_outcome_requires_reconciliation"||result.status==="existing_preview_bindings_required")process.exitCode=2;
} catch(e) {
  // Raw exception messages may contain an email, import path or file contents.
  console.error(JSON.stringify({status:"blocked",reason:["SenderMarketingError","SharpCutsCustomerDatabaseError"].includes(e.name)?e.code:"invalid_or_unavailable_source_evidence_or_approval"}));
  process.exitCode=1;
}
