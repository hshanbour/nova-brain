import {createHash} from "node:crypto";
import {SHARP_CUTS_STAGING_SNAPSHOT} from "../automation/sharp-cuts-campaign.js";
import {parseCsvRecords} from "../automation/sharp-cuts-customer-audit.js";

// The SELECT-only staging query and a read of its original import produced
// these different counts on 14 Nov 2026. Profiles may share an address.
export const SHARP_CUTS_EMAIL_SOURCE = Object.freeze({
  profileCount: 1562,
  membershipHash: "1f90c3865ddcc2c6732e6d4ca019b4b1a1841fdb63d960805654adb09a30c7e8",
  sourceSnapshotHash: SHARP_CUTS_STAGING_SNAPSHOT.sourceSnapshotSha256,
  exportRows: 1988,
  emailRows: 1571,
  distinctAddresses: 1558,
});

const hash = value => createHash("sha256").update(value).digest("hex");
const address = value => String(value || "").trim().toLowerCase();

export function describeCampaignSource(source, eligible, provider = {}) {
  const expected = SHARP_CUTS_EMAIL_SOURCE;
  const matched = source?.profileCount === expected.profileCount &&
    source.distinctProfileIds === expected.profileCount && source.membershipHash === expected.membershipHash;
  const group = provider.groups?.find(item => item.boundToNova);
  return {
    expectedProfiles: expected.profileCount, observedProfiles: source?.profileCount ?? null,
    membershipStatus: !source?.membershipHash ? "unavailable" : matched ? "matched" : "changed",
    membershipHash: source?.membershipHash ?? null, ambiguousProfiles: source?.ambiguousProfiles ?? null,
    originalExport: {sourceHash:expected.sourceSnapshotHash, rows:expected.exportRows, emailRows:expected.emailRows, distinctAddresses:expected.distinctAddresses},
    verifiedEligible: eligible ?? null,
    senderGroup: group ? {id:group.id, total:group.total, active:group.active, unsubscribed:group.unsubscribed, bounced:group.bounced} : null,
    transferStatus: !matched ? "source_membership_unverified" : !eligible ? "channel_evidence_required" :
      !group ? "dedicated_group_required" : "recipient_reconciliation_required",
    sourceRowsChanged:0, contactsTransferred:0,
  };
}

// All addresses stay in the local process. The approved staging view contains
// presence flags only, so use the exact existing export, verified by digest.
export function readCampaignAddresses(bytes) {
  if(hash(bytes)!==SHARP_CUTS_EMAIL_SOURCE.sourceSnapshotHash)throw Error("The source file differs from the verified Sharp Cuts import.");
  const rows=parseCsvRecords(bytes.toString("utf8"));
  const counts=new Map();
  for(const row of rows){const key=address(row.Email);if(key)counts.set(key,(counts.get(key)||0)+1);}
  if(rows.length!==SHARP_CUTS_EMAIL_SOURCE.exportRows || counts.size!==SHARP_CUTS_EMAIL_SOURCE.distinctAddresses)throw Error("Source membership could not be reconciled.");
  return {addresses:[...counts.keys()].sort(),sharedAddresses:[...counts].filter(([,count])=>count>1).map(([key])=>key)};
}

// Supplemental evidence must come from the business's authoritative records.
// The existing export has no consent or opt-out columns. A passed-in group
// count, address presence, or transactional email status cannot replace them.
export function planAudienceTransfer({addresses, sharedAddresses=[], evidence=[], providerSubscribers=[], groupId, membershipHash, now=Date.now()}) {
  if(membershipHash!==SHARP_CUTS_EMAIL_SOURCE.membershipHash)throw Error("The live source cohort has changed or is unavailable.");
  const byAddress = new Map(), subscribers = new Map();
  function index(records, map, label) {
    for(const row of records) {
      const key=address(row.email);
      if(!key||map.has(key))throw Error(label+" contains an unresolved or duplicated address.");
      map.set(key,row);
    }
  }
  index(evidence,byAddress,"Source evidence");
  index(providerSubscribers,subscribers,"Sender inventory");
  const add=[],create=[],existing=[], counts={unknownEvidence:0,sourceSuppressed:0,futureBooking:0,providerSuppressed:0};
  const sourceAddresses=new Set(addresses),shared=new Set(sharedAddresses);
  for(const key of byAddress.keys())if(!sourceAddresses.has(key))throw Error("Evidence does not belong to the checked source file.");
  for(const email of sourceAddresses){
    const proof=byAddress.get(email);
    if(proof?.suppressed===true){counts.sourceSuppressed++;continue;}
    if(proof?.futureBooking===true){counts.futureBooking++;continue;}
    const checkedAt=Date.parse(proof?.checkedAt);
    if(!proof || !["consent","soft_opt_in_verified"].includes(proof.basis) || proof.suppressed!==false ||
       proof.futureBooking!==false || proof.reachabilityVerified!==true || (shared.has(email)&&proof.sharedAddressCleared!==true) || !String(proof.source||"").trim() ||
       !Number.isFinite(checkedAt) || checkedAt>now) {counts.unknownEvidence++;continue;}
    const recipient=subscribers.get(email);
    if(recipient && (recipient.status?.email!=="active" || recipient.unsubscribed_at || recipient.bounced_at)) {counts.providerSuppressed++;continue;}
    if(!recipient)create.push(email);
    else if(recipient.subscriber_tags?.some(group=>group.id===groupId))existing.push(email);
    else add.push(email);
  }
  const eligible=new Set([...existing,...create,...add]);
  const unexpectedGroupMembers=[...subscribers].filter(([email,row])=>row.subscriber_tags?.some(group=>group.id===groupId)&&!eligible.has(email)).length;
  // Idempotent on resumption: a successful transfer changes a contact from
  // create/add to existing, but leaves this exact destination and audience intact.
  const approvalHash=hash(JSON.stringify({groupId,membershipHash,eligible:[...eligible].sort()}));
  const summary={profileCount:SHARP_CUTS_EMAIL_SOURCE.profileCount, distinctSourceAddresses:sourceAddresses.size,
    ...counts,eligible:eligible.size,create:create.length,add:add.length,alreadyInGroup:existing.length,
    unexpectedGroupMembers,groupBound:Boolean(groupId),approvalHash,contactsTransferred:0};
  return {summary,create,add};
}
