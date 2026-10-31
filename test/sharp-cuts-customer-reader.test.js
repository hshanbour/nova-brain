import assert from "node:assert/strict";
import test from "node:test";
import {readConfig} from "../src/config/env.js";
import {AGGREGATE_QUERY,createSharpCutsCustomerReader,SharpCutsCustomerDatabaseError} from "../src/automation/sharp-cuts-customer-reader.js";

const URL_VALUE="postgresql://nova_sharp_cuts_preview_select:private@ep-autumn-tree-zaetzhlw-pooler.c-2.eu-west-2.aws.neon.tech/neondb?sslmode=require";

test("Sharp Cuts customer database requires the exact restricted role, database and TLS",()=>{
  const disabled=readConfig({});assert.equal(disabled.sharpCutsCustomerDatabase.configured,false);
  assert.throws(()=>readConfig({NOVA_SHARP_CUTS_CUSTOMER_DATABASE_URL:"postgresql://neondb_owner:private@ep-autumn-tree-zaetzhlw-pooler.c-2.eu-west-2.aws.neon.tech/neondb?sslmode=require"}),/SELECT-only role/);
  assert.throws(()=>readConfig({NOVA_SHARP_CUTS_CUSTOMER_DATABASE_URL:"postgresql://nova_sharp_cuts_preview_select:private@ep-example.neon.tech/neondb?sslmode=require"}),/staging host/);
  assert.throws(()=>readConfig({NOVA_SHARP_CUTS_CUSTOMER_DATABASE_URL:"postgresql://nova_sharp_cuts_preview_select:private@ep-autumn-tree-zaetzhlw-pooler.c-2.eu-west-2.aws.neon.tech/neondb"}),/TLS mode/);
  const configured=readConfig({NOVA_SHARP_CUTS_CUSTOMER_DATABASE_URL:URL_VALUE.replace("private","private%40phrase")}).sharpCutsCustomerDatabase;
  assert.equal(configured.configured,true);assert.equal(configured.branchId,"br-steep-truth-za3vyugo");assert.equal(configured.view,"public.sc_customer_deduplicated_preview");
});

test("malformed database URLs fail without disclosing credential material",()=>{
  const marker="credential-marker-never-log";
  assert.throws(()=>readConfig({NOVA_SHARP_CUTS_CUSTOMER_DATABASE_URL:`postgresql://nova_sharp_cuts_preview_select:${marker}%@ep-autumn-tree-zaetzhlw-pooler.c-2.eu-west-2.aws.neon.tech/neondb?sslmode=require`}),error=>{
    assert.doesNotMatch(error.message,/credential-marker|postgresql:\/\//);return true;
  });
});

test("database client failures are converted to secret-free fail-closed errors",async()=>{
  const marker="credential-marker-never-log";
  const config=readConfig({NOVA_SHARP_CUTS_CUSTOMER_DATABASE_URL:URL_VALUE}).sharpCutsCustomerDatabase;
  const reader=createSharpCutsCustomerReader({config,sqlClient:{async query(){throw new Error(`failed ${marker} postgresql://restricted:secret@example.invalid/db`);}}});
  await assert.rejects(reader.snapshot(),error=>{
    assert.ok(error instanceof SharpCutsCustomerDatabaseError);assert.equal(error.code,"sharp_cuts_customer_database_unavailable");assert.equal(error.statusCode,503);assert.doesNotMatch(error.message,/credential-marker|postgresql:\/\/|secret/);return true;
  });
});

test("reader returns aggregate-only channel evidence and fails closed on missing marketing evidence",async()=>{
  const calls=[],sqlClient={async query(statement,params){calls.push({statement,params});return[{role_name:"nova_sharp_cuts_preview_select",database_name:"neondb",transaction_read_only:"on",source_profiles:1991,provisional_unique_profiles:1982,email_candidates:1562,mobile_candidates:1640,both_candidates:1560,missing_contact:340,ambiguous_identity_profiles:799}];}};
  const config=readConfig({NOVA_SHARP_CUTS_CUSTOMER_DATABASE_URL:URL_VALUE}).sharpCutsCustomerDatabase,reader=createSharpCutsCustomerReader({config,sqlClient}),snapshot=await reader.snapshot();
  assert.equal(snapshot.sourceProfiles,1991);assert.equal(snapshot.uniqueProfiles,1982);assert.equal(snapshot.emailOnly,2);assert.equal(snapshot.mobileOnly,80);assert.equal(snapshot.channels.email.verifiedEligible,0);assert.equal(snapshot.channels.sms.verifiedEligible,0);assert.equal(snapshot.channels.whatsapp.verifiedEligible,0);assert.equal(snapshot.identifiersExposed,false);assert.equal(snapshot.readOnlyEnforced,true);
  assert.equal(calls.length,1);assert.equal(calls[0].statement,AGGREGATE_QUERY);assert.deepEqual(calls[0].params,[]);assert.doesNotMatch(JSON.stringify(snapshot),/@|\+44|ciphertext|profile_envelope|fingerprint/);
});

test("reader rejects a privileged or writable database session",async()=>{
  const config=readConfig({NOVA_SHARP_CUTS_CUSTOMER_DATABASE_URL:URL_VALUE}).sharpCutsCustomerDatabase;
  const reader=createSharpCutsCustomerReader({config,sqlClient:{async query(){return[{role_name:"neondb_owner",database_name:"neondb",transaction_read_only:"off"}];}}});
  await assert.rejects(reader.snapshot(),/identity or read-only enforcement/);
});
