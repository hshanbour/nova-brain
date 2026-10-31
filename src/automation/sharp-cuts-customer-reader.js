import {neon} from "@neondatabase/serverless";

const AGGREGATE_QUERY=`SELECT current_user AS role_name,current_database() AS database_name,current_setting('transaction_read_only') AS transaction_read_only,
  coalesce(sum(source_profile_count),0)::int AS source_profiles,count(*)::int AS provisional_unique_profiles,
  count(*) FILTER (WHERE has_email)::int AS email_candidates,count(*) FILTER (WHERE has_mobile)::int AS mobile_candidates,
  count(*) FILTER (WHERE has_email AND has_mobile)::int AS both_candidates,
  count(*) FILTER (WHERE NOT has_email AND NOT has_mobile)::int AS missing_contact,
  count(*) FILTER (WHERE has_ambiguous_candidates)::int AS ambiguous_identity_profiles
FROM public.sc_customer_deduplicated_preview`;

function count(value,name){const parsed=Number(value);if(!Number.isSafeInteger(parsed)||parsed<0)throw new Error(`Sharp Cuts aggregate ${name} is invalid.`);return parsed;}
function channel(contactCandidates,evidence){return Object.freeze({contactCandidates,verifiedEligible:0,marketingBasisVerified:0,suppressionCleared:0,futureBookingCleared:0,reachabilityVerified:0,status:"blocked_evidence_incomplete",evidence:Object.freeze(evidence)});}

export class SharpCutsCustomerDatabaseError extends Error{
  constructor(){super("Sharp Cuts customer aggregates are temporarily unavailable.");this.name="SharpCutsCustomerDatabaseError";this.code="sharp_cuts_customer_database_unavailable";this.statusCode=503;}
}

export function createSharpCutsCustomerReader({config,sqlClient}={}){
  if(!config?.configured&&!sqlClient)return null;
  let sql=sqlClient||null;
  const query=async(statement,params=[])=>{
    try{sql||=neon(config.connectionString);return await sql.query(statement,params);}
    catch{throw new SharpCutsCustomerDatabaseError();}
  };
  return Object.freeze({
    async snapshot(){
      const rows=await query(AGGREGATE_QUERY,[]),row=rows?.[0];if(!row)throw new Error("Sharp Cuts aggregate query returned no result.");
      if(row.role_name!==config.role||row.database_name!==config.database||row.transaction_read_only!=="on")throw new Error("Sharp Cuts database identity or read-only enforcement did not match the approved policy.");
      const sourceProfiles=count(row.source_profiles,"source profiles"),uniqueProfiles=count(row.provisional_unique_profiles,"unique profiles"),emailCandidates=count(row.email_candidates,"email candidates"),mobileCandidates=count(row.mobile_candidates,"mobile candidates"),bothCandidates=count(row.both_candidates,"both candidates"),missingContact=count(row.missing_contact,"missing contact"),ambiguousIdentityProfiles=count(row.ambiguous_identity_profiles,"ambiguous identities");
      if(uniqueProfiles>sourceProfiles||bothCandidates>emailCandidates||bothCandidates>mobileCandidates||emailCandidates+mobileCandidates-bothCandidates+missingContact!==uniqueProfiles)throw new Error("Sharp Cuts aggregate invariants failed.");
      const evidence=["marketing consent or UK soft-opt-in evidence is not present in the approved view","suppression and opt-out evidence is not present in the approved view","future Fresha booking evidence is not present in the approved view","channel delivery evidence is not present in the approved view"];
      return Object.freeze({source:"neon_select_only_aggregate",projectId:config.projectId,branchId:config.branchId,branchName:config.branchName,database:config.database,role:config.role,view:config.view,readOnlyEnforced:true,identifiersExposed:false,sourceProfiles,uniqueProfiles,emailCandidates,mobileCandidates,bothCandidates,emailOnly:emailCandidates-bothCandidates,mobileOnly:mobileCandidates-bothCandidates,missingContact,ambiguousIdentityProfiles,channels:Object.freeze({email:channel(emailCandidates,evidence),sms:channel(mobileCandidates,evidence),whatsapp:channel(mobileCandidates,evidence)})});
    }
  });
}

export {AGGREGATE_QUERY};
