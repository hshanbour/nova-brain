import { randomUUID } from "node:crypto";
import { callStartArguments } from "../phone/call-envelope.js";

export const PSTN_ENROLLMENT_PURPOSE="pstn_speaker_recognition_owner_voice_enrollment";
export const PSTN_ENROLLMENT_CHANNEL="pstn_8khz_v1";
export const PSTN_ENROLLMENT_CONSENT_VERSION="pstn-owner-enrollment-v1";
const OWNER_NAME="Mohammad";
const EXPECTED_DESTINATION="+447960672981";
const PHRASES=Object.freeze({
  arabic:Object.freeze([
    "أنا محمد، وأستخدم نوفا لمساعدتي في تنظيم عملي ومشاريعي بأمان.",
    "اليوم أراجع خططي بهدوء، وأتأكد أن كل خطوة واضحة قبل التنفيذ.",
    "صوتي هذا للتعرّف الآمن على المالك أثناء مكالمات نوفا الهاتفية.",
  ]),
  english:Object.freeze([
    "I am Mohammad, and I use Nova to organise my work and projects safely.",
    "Today I am reviewing my plans carefully before Nova takes any action.",
    "This voice sample helps Nova recognise its owner during phone calls.",
  ]),
  mixed:Object.freeze([
    "أنا محمد، وبستخدم Nova عشان أنظم business وprojects بطريقة آمنة.",
    "اليوم براجع الـ plan مع Nova قبل أي action أو external commitment.",
    "هذا voice sample مخصص فقط للتعرّف على owner في مكالمات Nova.",
  ]),
});

export class PstnEnrollmentError extends Error{constructor(message,{code="pstn_enrollment_error",statusCode=400}={}){super(message);this.name="PstnEnrollmentError";this.code=code;this.statusCode=statusCode;}}
const safeQuality=(result)=>Object.freeze({voicedDurationSeconds:Number(result.speechSeconds||result.durationSeconds||0),silenceRatio:Number.isFinite(result.silenceRatio)?result.silenceRatio:null,clippingRatio:Number.isFinite(result.clippingRatio)?result.clippingRatio:null,peakToNoiseDb:Number.isFinite(result.peakToNoiseDb)?result.peakToNoiseDb:null,preprocessingVersion:result.preprocessingVersion||null,extractorVersion:result.extractorVersion||null,accepted:result.sufficient===true,reason:result.sufficient===true?null:String(result.reason||"quality_rejected").slice(0,80)});
const publicSession=session=>session&&({...session,phrasePlan:session.phrasePlan.map(({id,language,text})=>({id,language,text}))});
const normalized=values=>{const magnitude=Math.sqrt(values.reduce((sum,value)=>sum+value*value,0));return values.map(value=>value/magnitude);};
const centroid=values=>normalized(Array.from({length:values[0].length},(_,index)=>values.reduce((sum,value)=>sum+value[index],0)/values.length));

export function createPstnSpeakerEnrollment({storage,ownerId,phoneService,speakerExtractor,speakerIdentity,ownerNumber,clock=()=>new Date(),idFactory=randomUUID}={}){
  if(!storage||!ownerId||!phoneService||!speakerExtractor||!speakerIdentity)throw new Error("PSTN enrollment dependencies are required.");
  const ensureConsent=async()=>{const consent=await storage.getActiveSpeakerEnrollmentConsent(ownerId,{purpose:PSTN_ENROLLMENT_PURPOSE,channel:PSTN_ENROLLMENT_CHANNEL});if(!consent)throw new PstnEnrollmentError("Active explicit owner biometric consent is required.",{code:"pstn_enrollment_consent_required",statusCode:403});return consent;};
  const pick=(language,sessionNumber)=>{const values=PHRASES[language],entropy=idFactory().replace(/[^a-f0-9]/gi,"").slice(-8),index=Number.parseInt(entropy||"0",16)%values.length;return{id:`${language}-${sessionNumber}-${index+1}`,language,text:values[index]};};
  const phrasePlan=sessionNumber=>[pick("arabic",sessionNumber),pick("english",sessionNumber),pick("mixed",sessionNumber)];
  const load=async id=>{const session=await storage.getSpeakerEnrollmentSession(id,ownerId);if(!session)throw new PstnEnrollmentError("Speaker enrollment session was not found.",{code:"pstn_enrollment_session_not_found",statusCode:404});return session;};
  return Object.freeze({
    async recordConsent({actor,explicitConsent,provenance="explicit_owner_consent_in_codex_task",consentVersion=PSTN_ENROLLMENT_CONSENT_VERSION}={}){
      if(explicitConsent!==true||actor!==OWNER_NAME||consentVersion!==PSTN_ENROLLMENT_CONSENT_VERSION)throw new PstnEnrollmentError("Exact explicit Mohammad consent is required.",{code:"pstn_enrollment_consent_invalid",statusCode:403});
      const consent=await storage.saveSpeakerEnrollmentConsent({id:`speaker-consent-${idFactory()}`,ownerId,purpose:PSTN_ENROLLMENT_PURPOSE,consentVersion,consentActor:OWNER_NAME,channel:PSTN_ENROLLMENT_CHANNEL,provenance,consentedAt:clock().toISOString()});
      await storage.appendActivity({ownerId,action:"pstn_speaker_enrollment_consent_recorded",tool:null,status:"completed",summary:"Recorded explicit owner consent for PSTN speaker enrollment.",metadata:{consentId:consent.id,consentVersion,channel:PSTN_ENROLLMENT_CHANNEL}});return consent;
    },
    async revokeConsent(id){const consent=await storage.revokeSpeakerEnrollmentConsent(id,ownerId,clock().toISOString());if(consent)await storage.appendActivity({ownerId,action:"pstn_speaker_enrollment_consent_revoked",status:"completed",summary:"Revoked PSTN speaker enrollment consent and pending sessions.",metadata:{consentId:id}});return consent;},
    async prepareSession({sessionNumber=1,conversationId}={}){
      if(![1,2].includes(sessionNumber))throw new PstnEnrollmentError("Enrollment session number is invalid.",{code:"pstn_enrollment_session_not_authorized",statusCode:403});
      if(ownerNumber!==EXPECTED_DESTINATION)throw new PstnEnrollmentError("The server-resolved owner destination is not authorized for enrollment.",{code:"pstn_enrollment_destination_invalid",statusCode:403});
      const consent=await ensureConsent(),sessions=await storage.listSpeakerEnrollmentSessions(ownerId,{limit:20}),existing=sessions.find(item=>item.sessionNumber===sessionNumber&&!['failed','revoked'].includes(item.status));if(existing)return{session:publicSession(existing),call:existing.callIntentId?callStartArguments(await storage.getPhoneCallIntent(existing.callIntentId,ownerId)):null,approval:existing.approvalId?await storage.getApproval(existing.approvalId,ownerId):null,idempotent:true};
      if(sessionNumber===2&&!sessions.some(item=>item.sessionNumber===1&&item.status==="completed"))throw new PstnEnrollmentError("Session 1 must complete before Session 2 can be prepared.",{code:"pstn_enrollment_session_order_invalid",statusCode:409});
      const conditionLabel=sessionNumber===1?"quiet_normal_handset":"alternate_realistic_condition",id=`speaker-enrollment-${idFactory()}`,conversation=await storage.ensureConversation({id:conversationId||`speaker-enrollment-conversation-${idFactory()}`,ownerId,title:`Mohammad PSTN voice enrollment — Session ${sessionNumber}`}),expiresAt=new Date(clock().getTime()+24*60*60*1000).toISOString(),plan=phrasePlan(sessionNumber);
      let session=await storage.createSpeakerEnrollmentSession({id,ownerId,consentId:consent.id,conversationId:conversation.id,sessionNumber,conditionLabel,phrasePlan:plan,status:"prepared",expiresAt});
      const run=await storage.createRun({id:`speaker-enrollment-run-${idFactory()}`,ownerId,conversationId:conversation.id,goal:`Prepare Mohammad PSTN owner voice enrollment Session ${sessionNumber}`,status:"waiting_for_approval"});
      const call=await phoneService.prepare({destination:ownerNumber,expectedParty:OWNER_NAME,callerDisclosure:"Nova voice enrollment assistant for Mohammad.",objective:`Collect exactly three consented PSTN speaker-enrollment samples for Session ${sessionNumber}; do not conduct a general conversation.`,approvedContext:`Enrollment session ${id}; ${conditionLabel}; Arabic, English, and mixed Arabic-English.`,permittedQuestions:plan.map(item=>`Prompt ${item.language}: ${item.text}`),permittedDisclosures:["Explain that the call is for consented owner voice enrollment.","Report whether each sample was accepted or needs retry."],prohibitedDisclosures:["Any unrelated private owner or business context."],prohibitedActions:["No tools, external actions, commitments, or general Nova work."],languageStrategy:"Arabic first; guide the fixed Arabic, English, then mixed Arabic-English enrollment prompts.",maximumDurationMinutes:10,maximumAttempts:1,voicemailPolicy:"do_not_leave",recordingPolicy:"disabled",mediaProfile:"speaker_enrollment_v1",enrollmentSessionId:id,expiresAt},{conversationId:conversation.id,runId:run.id});
      const approval=await storage.createApproval({id:`speaker-enrollment-approval-${idFactory()}`,ownerId,runId:run.id,tool:"phone_call_start",reason:`Place exactly one owner-approved PSTN biometric enrollment call for Mohammad — Session ${sessionNumber}.`,riskLevel:"SENSITIVE",arguments:call});
      await phoneService.approvalRequired(call,approval,{conversationId:conversation.id,runId:run.id});
      const assistantMessageId=`speaker-enrollment-message-${idFactory()}`;await storage.appendMessage({id:assistantMessageId,conversationId:conversation.id,ownerId,role:"assistant",content:`Mohammad PSTN voice enrollment Session ${sessionNumber} is prepared. Review the formal Approval card; no call will occur unless you click Approve.`});
      await storage.updateRun(run.id,ownerId,{result:{assistantMessageId,sessionId:id,callIntentId:call.callIntentId,approvalId:approval.id}});
      session=await storage.updateSpeakerEnrollmentSession(id,ownerId,{status:"waiting_for_approval",callIntentId:call.callIntentId,approvalId:approval.id});
      await storage.appendActivity({ownerId,runId:run.id,action:"pstn_speaker_enrollment_session_prepared",tool:"phone_call_start",status:"waiting_for_approval",summary:"Prepared owner PSTN speaker enrollment Session 1 without dialing.",metadata:{sessionId:id,callIntentId:call.callIntentId,approvalId:approval.id,expectedSamples:3,recording:false}});
      return{session:publicSession(session),call,approval,idempotent:false};
    },
    async status(){const consent=await storage.getActiveSpeakerEnrollmentConsent(ownerId,{purpose:PSTN_ENROLLMENT_PURPOSE,channel:PSTN_ENROLLMENT_CHANNEL}),sessions=await storage.listSpeakerEnrollmentSessions(ownerId,{limit:10});return{consent:consent?{id:consent.id,version:consent.consentVersion,status:consent.status,actor:consent.consentActor,consentedAt:consent.consentedAt,channel:consent.channel}:null,sessions:sessions.map(publicSession)};},
    async submitSample({sessionId,submissionKey,ordinal,promptId,audioBase64,mimeType,durationSeconds},{signal}={}){
      const consent=await ensureConsent(),session=await load(sessionId);if(session.consentId!==consent.id||session.status!=="collecting")throw new PstnEnrollmentError("Enrollment session is not collecting samples.",{code:"pstn_enrollment_session_inactive",statusCode:409});
      if(!Number.isInteger(ordinal)||ordinal<1||ordinal>3||session.phrasePlan[ordinal-1]?.id!==promptId||!/^[A-Za-z0-9:_-]{8,160}$/.test(submissionKey||""))throw new PstnEnrollmentError("Enrollment sample binding is invalid.",{code:"pstn_enrollment_sample_invalid"});
      const prior=(await storage.listSpeakerEnrollmentSamples(ownerId,sessionId)).find(item=>item.submissionKey===submissionKey);if(prior)return{sample:prior,acceptedCount:session.acceptedCount,idempotent:true};
      let result;try{result=await speakerExtractor.extract({audioBase64,mimeType,durationSeconds},{signal,requestId:`enrollment-${sessionId}-${ordinal}`,enrollmentAttemptId:sessionId});}catch(error){result={sufficient:false,reason:error?.code||"extractor_rejected",extractorVersion:null};}
      const quality=safeQuality(result),poor=result.sufficient!==true||(Number.isFinite(result.clippingRatio)&&result.clippingRatio>0.02)||(Number.isFinite(result.peakToNoiseDb)&&result.peakToNoiseDb<8),status=poor?"retry":"accepted";
      const recorded=await storage.recordSpeakerEnrollmentSample({id:`speaker-sample-${idFactory()}`,ownerId,sessionId,ordinal,submissionKey,promptId,language:session.phrasePlan[ordinal-1].language,conditionLabel:session.conditionLabel,status,quality,encryptedRepresentation:status==="accepted"?speakerIdentity.protectRepresentation(result.representation):null,representationVersion:status==="accepted"?result.extractorVersion:null});
      let updated=await load(sessionId);if(recorded.inserted&&status==="accepted"&&updated.acceptedCount===3){updated=await storage.updateSpeakerEnrollmentSession(sessionId,ownerId,{status:"completed",completedAt:clock().toISOString()});const sessions=await storage.listSpeakerEnrollmentSessions(ownerId,{limit:20}),completed=sessions.filter(item=>item.status==="completed"&&item.consentId===consent.id);if(completed.some(item=>item.sessionNumber===1)&&completed.some(item=>item.sessionNumber===2)){const ordered=completed.sort((a,b)=>a.sessionNumber-b.sessionNumber),sampleSets=await Promise.all(ordered.map(item=>storage.listSpeakerEnrollmentSamples(ownerId,item.id,{includeRepresentation:true}))),accepted=sampleSets.flat().filter(item=>item.status==="accepted"&&item.encryptedRepresentation),vectors=accepted.map(item=>speakerIdentity.revealRepresentation(item.encryptedRepresentation));if(vectors.length===6&&vectors.every(Boolean)){const template=[vectors[0],vectors[1],vectors[3],vectors[4]],heldout=[vectors[2],vectors[5]],center=centroid(template),scores=heldout.map(value=>speakerIdentity.similarity(center,value)),minimum=Math.min(...scores);if(minimum>=0.9){const profile=await speakerIdentity.enroll({displayName:OWNER_NAME,relation:"owner",scope:"private_owner",consent:true,consentActor:consent.consentActor,sampleRepresentations:template,representationVersion:accepted[0].representationVersion,enrollmentAttemptId:`pstn:${consent.id}`});await storage.saveSpeakerChannelCalibration({ownerId,speakerProfileId:profile.id,channel:PSTN_ENROLLMENT_CHANNEL,status:"ready",representationVersion:accepted[0].representationVersion,ownerMatchThreshold:Math.max(0.9,minimum-0.02),ambiguityMargin:0.08,sampleCount:6,sessionCount:2,conditions:ordered.map(item=>item.conditionLabel),consentAt:consent.consentedAt});await storage.purgeSpeakerEnrollmentSampleRepresentations(ownerId,ordered.map(item=>item.id));}}}await storage.appendActivity({ownerId,action:"pstn_speaker_enrollment_session_completed",status:"completed",summary:"Completed one three-sample PSTN enrollment session; calibration is ready only after two sessions and held-out validation.",metadata:{sessionId,sampleCount:3,totalRequired:6}});}return{sample:recorded.sample,acceptedCount:updated.acceptedCount,sessionStatus:updated.status,idempotent:!recorded.inserted,retry:status!=="accepted",rawAudioPersisted:false};
    },
  });
}
