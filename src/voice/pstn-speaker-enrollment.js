import { randomUUID } from "node:crypto";
import { callStartArguments } from "../phone/call-envelope.js";

export const PSTN_ENROLLMENT_PURPOSE="pstn_speaker_recognition_owner_voice_enrollment";
export const PSTN_ENROLLMENT_CHANNEL="pstn_8khz_v1";
export const PSTN_ENROLLMENT_CONSENT_VERSION="pstn-owner-enrollment-v1";
const OWNER_NAME="Mohammad";
const EXPECTED_DESTINATION="+447960672981";
const CALIBRATION_THRESHOLD=0.9;
const CALIBRATION_AMBIGUITY_MARGIN=0.08;
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
const rounded=value=>Number.isFinite(value)?Math.round(value*10000)/10000:null;
const scoreSummary=values=>Object.freeze({minimum:rounded(Math.min(...values)),maximum:rounded(Math.max(...values)),mean:rounded(values.reduce((sum,value)=>sum+value,0)/values.length)});
const pairScores=(values,similarity)=>{const scores=[];for(let left=0;left<values.length;left+=1)for(let right=left+1;right<values.length;right+=1)scores.push(similarity(values[left],values[right]));return scores;};

export function createPstnSpeakerEnrollment({storage,ownerId,phoneService,speakerExtractor,speakerIdentity,ownerNumber,clock=()=>new Date(),idFactory=randomUUID}={}){
  if(!storage||!ownerId||!phoneService||!speakerExtractor||!speakerIdentity)throw new Error("PSTN enrollment dependencies are required.");
  const ensureConsent=async()=>{const consent=await storage.getActiveSpeakerEnrollmentConsent(ownerId,{purpose:PSTN_ENROLLMENT_PURPOSE,channel:PSTN_ENROLLMENT_CHANNEL});if(!consent)throw new PstnEnrollmentError("Active explicit owner biometric consent is required.",{code:"pstn_enrollment_consent_required",statusCode:403});return consent;};
  const pick=(language,sessionNumber,excluded=new Set())=>{const all=PHRASES[language],values=all.filter(value=>!excluded.has(value));if(!values.length)throw new PstnEnrollmentError("No unused enrollment phrase is available.",{code:"pstn_enrollment_phrase_pool_exhausted",statusCode:409});const entropy=idFactory().replace(/[^a-f0-9]/gi,"").slice(-8),index=Number.parseInt(entropy||"0",16)%values.length,text=values[index];return{id:`${language}-${sessionNumber}-${all.indexOf(text)+1}`,language,text};};
  const phrasePlan=(sessionNumber,excluded)=>[pick("arabic",sessionNumber,excluded),pick("english",sessionNumber,excluded),pick("mixed",sessionNumber,excluded)];
  const load=async id=>{const session=await storage.getSpeakerEnrollmentSession(id,ownerId);if(!session)throw new PstnEnrollmentError("Speaker enrollment session was not found.",{code:"pstn_enrollment_session_not_found",statusCode:404});return session;};
  const service={
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
      const firstSession=sessionNumber===2?sessions.find(item=>item.sessionNumber===1&&item.status==="completed"):null;if(sessionNumber===2&&!firstSession)throw new PstnEnrollmentError("Session 1 must complete before Session 2 can be prepared.",{code:"pstn_enrollment_session_order_invalid",statusCode:409});
      const conditionLabel=sessionNumber===1?"quiet_normal_handset":"speakerphone",excluded=new Set(firstSession?.phrasePlan?.map(item=>item.text)||[]),id=`speaker-enrollment-${idFactory()}`,conversation=await storage.ensureConversation({id:conversationId||`speaker-enrollment-conversation-${idFactory()}`,ownerId,title:`Mohammad PSTN voice enrollment — Session ${sessionNumber}`}),expiresAt=new Date(clock().getTime()+24*60*60*1000).toISOString(),plan=phrasePlan(sessionNumber,excluded);
      let session=await storage.createSpeakerEnrollmentSession({id,ownerId,consentId:consent.id,conversationId:conversation.id,sessionNumber,conditionLabel,phrasePlan:plan,status:"prepared",expiresAt});
      const run=await storage.createRun({id:`speaker-enrollment-run-${idFactory()}`,ownerId,conversationId:conversation.id,goal:`Prepare Mohammad PSTN owner voice enrollment Session ${sessionNumber}`,status:"waiting_for_approval"});
      const speakerphoneInstruction="For Session 2, ask Mohammad to use speakerphone at a normal realistic distance, speak naturally, and not deliberately change his voice; Bluetooth and artificial loud noise are not required.";
      const call=await phoneService.prepare({destination:ownerNumber,expectedParty:OWNER_NAME,callerDisclosure:"Nova voice enrollment assistant for Mohammad.",objective:`Collect exactly three consented PSTN speaker-enrollment samples for Session ${sessionNumber}; do not conduct a general conversation.`,approvedContext:`Enrollment session ${id}; acoustic condition: ${conditionLabel}; Arabic, English, and mixed Arabic-English.${sessionNumber===2?` ${speakerphoneInstruction}`:""}`,permittedQuestions:plan.map(item=>`Prompt ${item.language}: ${item.text}`),permittedDisclosures:["Explain that the call is for consented owner voice enrollment.",...(sessionNumber===2?[speakerphoneInstruction]:[]),"Report whether each sample was accepted or needs retry."],prohibitedDisclosures:["Any unrelated private owner or business context."],prohibitedActions:["No tools, external actions, commitments, or general Nova work."],languageStrategy:"Arabic first; guide the fixed Arabic, English, then mixed Arabic-English enrollment prompts.",maximumDurationMinutes:10,maximumAttempts:1,voicemailPolicy:"do_not_leave",recordingPolicy:"disabled",mediaProfile:"speaker_enrollment_v1",enrollmentSessionId:id,expiresAt},{conversationId:conversation.id,runId:run.id});
      const approval=await storage.createApproval({id:`speaker-enrollment-approval-${idFactory()}`,ownerId,runId:run.id,tool:"phone_call_start",reason:`Place exactly one owner-approved PSTN biometric enrollment call for Mohammad — Session ${sessionNumber}.`,riskLevel:"SENSITIVE",arguments:call});
      await phoneService.approvalRequired(call,approval,{conversationId:conversation.id,runId:run.id});
      const assistantMessageId=`speaker-enrollment-message-${idFactory()}`;await storage.appendMessage({id:assistantMessageId,conversationId:conversation.id,ownerId,role:"assistant",content:`Mohammad PSTN voice enrollment Session ${sessionNumber} is prepared. Review the formal Approval card; no call will occur unless you click Approve.`});
      await storage.updateRun(run.id,ownerId,{result:{assistantMessageId,sessionId:id,callIntentId:call.callIntentId,approvalId:approval.id}});
      session=await storage.updateSpeakerEnrollmentSession(id,ownerId,{status:"waiting_for_approval",callIntentId:call.callIntentId,approvalId:approval.id});
      await storage.appendActivity({ownerId,runId:run.id,action:"pstn_speaker_enrollment_session_prepared",tool:"phone_call_start",status:"waiting_for_approval",summary:`Prepared owner PSTN speaker enrollment Session ${sessionNumber} without dialing.`,metadata:{sessionId:id,callIntentId:call.callIntentId,approvalId:approval.id,expectedSamples:3,conditionLabel,recording:false}});
      return{session:publicSession(session),call,approval,idempotent:false};
    },
    async replacePendingSession({sessionId,callIntentId,approvalId}={}){
      const session=await load(sessionId),call=await storage.getPhoneCallIntent(callIntentId,ownerId),approval=await storage.getApproval(approvalId,ownerId);
      if(session.sessionNumber!==2||session.callIntentId!==callIntentId||session.approvalId!==approvalId||call?.approvalId!==approvalId||call?.envelope?.enrollmentSessionId!==sessionId||approval?.arguments?.callIntentId!==callIntentId)throw new PstnEnrollmentError("The pending Session 2 replacement binding is invalid.",{code:"pstn_enrollment_replacement_binding_invalid",statusCode:409});
      if(call.attemptCount!==0||call.providerCallSid||call.providerStreamSid)throw new PstnEnrollmentError("A started enrollment call cannot be replaced.",{code:"pstn_enrollment_replacement_call_started",statusCode:409});
      if(session.status==="waiting_for_approval"&&call.status==="waiting_for_approval"&&approval.status==="pending"){
        const rejected=await storage.decideApproval(approval.id,ownerId,"rejected");if(!rejected)throw new PstnEnrollmentError("The pending Session 2 Approval changed before replacement.",{code:"pstn_enrollment_replacement_conflict",statusCode:409});
        await phoneService.approvalDecision(rejected,"rejected");
        if(approval.runId)await storage.updateRun(approval.runId,ownerId,{status:"cancelled",error:"Superseded before dialing because an enrollment phrase repeated and the speakerphone condition was not explicit.",completedAt:clock().toISOString(),result:{approvalId:approval.id,approvalDecision:"rejected",replacementReasonCodes:["repeated_enrollment_phrase","speakerphone_condition_not_explicit"]}});
        await storage.appendActivity({ownerId,runId:approval.runId||null,action:"pstn_speaker_enrollment_session_superseded",tool:"phone_call_start",status:"cancelled",summary:"Superseded a pre-dial Session 2 enrollment preparation without counting an attempt.",metadata:{sessionId,callIntentId,approvalId,attemptCount:0,replacementReasonCodes:["repeated_enrollment_phrase","speakerphone_condition_not_explicit"]}});
      }else if(!(session.status==="failed"&&call.status==="failed"&&approval.status==="rejected"))throw new PstnEnrollmentError("Only one unchanged pre-dial Session 2 preparation can be replaced.",{code:"pstn_enrollment_replacement_not_pending",statusCode:409});
      return service.prepareSession({sessionNumber:2});
    },
    async status(){const consent=await storage.getActiveSpeakerEnrollmentConsent(ownerId,{purpose:PSTN_ENROLLMENT_PURPOSE,channel:PSTN_ENROLLMENT_CHANNEL}),sessions=await storage.listSpeakerEnrollmentSessions(ownerId,{limit:10});return{consent:consent?{id:consent.id,version:consent.consentVersion,status:consent.status,actor:consent.consentActor,consentedAt:consent.consentedAt,channel:consent.channel}:null,sessions:sessions.map(publicSession)};},
    async evaluateCalibrationReadiness({persist=true}={}){
      const consent=await ensureConsent();
      const sessions=(await storage.listSpeakerEnrollmentSessions(ownerId,{limit:20})).filter(item=>item.consentId===consent.id&&item.status==="completed"&&[1,2].includes(item.sessionNumber)).sort((left,right)=>left.sessionNumber-right.sessionNumber);
      const result={channel:PSTN_ENROLLMENT_CHANNEL,status:"not_ready",reason:"insufficient_sessions",sampleCount:0,sessionCount:sessions.length,conditions:sessions.map(item=>item.conditionLabel),representationVersion:null,thresholdCandidate:CALIBRATION_THRESHOLD,ambiguityMargin:CALIBRATION_AMBIGUITY_MARGIN,heldout:null,conditionsSummary:null,crossConditionScore:null,languageScores:null,outlier:null,calibrationCreated:false,ownerModeEnabled:false};
      try{
      if(sessions.length===2&&sessions[0].sessionNumber===1&&sessions[1].sessionNumber===2){
        const sampleSets=await Promise.all(sessions.map(item=>storage.listSpeakerEnrollmentSamples(ownerId,item.id,{includeRepresentation:true})));
        const samples=sampleSets.flatMap((items,index)=>items.filter(item=>item.status==="accepted").sort((left,right)=>left.ordinal-right.ordinal).map(item=>({...item,sessionNumber:sessions[index].sessionNumber})));
        result.sampleCount=samples.length;
        if(samples.length<6||sampleSets.some(items=>items.filter(item=>item.status==="accepted").length!==3))result.reason="insufficient_samples";
        else if(samples.some(item=>item.quality?.accepted!==true))result.reason="quality_failed";
        else {
          const versions=new Set(samples.map(item=>item.representationVersion).filter(Boolean));result.representationVersion=versions.size===1?[...versions][0]:null;
          if(versions.size!==1)result.reason="model_version_mismatch";
          else {
            let vectors;try{vectors=samples.map(item=>speakerIdentity.revealRepresentation(item.encryptedRepresentation));}catch{vectors=[];}
            const dimension=vectors[0]?.length;
            if(!dimension||vectors.some(value=>!Array.isArray(value)||value.length!==dimension||value.some(component=>!Number.isFinite(component))))result.reason="representation_invalid";
            else {
              const byKey=new Map(samples.map((item,index)=>[`${item.sessionNumber}:${item.ordinal}`,{item,vector:vectors[index]}]));
              const templateKeys=["1:1","1:2","2:1","2:2"],heldoutKeys=["1:3","2:3"],template=templateKeys.map(key=>byKey.get(key)?.vector),heldout=heldoutKeys.map(key=>byKey.get(key));
              if(template.some(value=>!value)||heldout.some(value=>!value))result.reason="representation_invalid";
              else {
                const center=centroid(template),heldoutScores=heldout.map(({vector})=>speakerIdentity.similarity(center,vector)),minimum=Math.min(...heldoutScores);
                const sessionVectors=sessionNumber=>samples.map((item,index)=>item.sessionNumber===sessionNumber?vectors[index]:null).filter(Boolean);
                const handset=sessionVectors(1),speakerphone=sessionVectors(2),languageScores={};
                for(const language of["arabic","english","mixed"]){const entries=samples.map((item,index)=>item.language===language?vectors[index]:null).filter(Boolean);languageScores[language]=entries.length===2?rounded(speakerIdentity.similarity(entries[0],entries[1])):null;}
                const outlierScores=samples.map((item,index)=>({sessionNumber:item.sessionNumber,ordinal:item.ordinal,language:item.language,condition:item.conditionLabel,score:rounded(speakerIdentity.similarity(centroid(vectors.filter((_,other)=>other!==index)),vectors[index]))})).sort((left,right)=>left.score-right.score);
                result.heldout={scores:heldout.map(({item},index)=>({sessionNumber:item.sessionNumber,ordinal:item.ordinal,language:item.language,condition:item.conditionLabel,score:rounded(heldoutScores[index])})),...scoreSummary(heldoutScores)};
                result.conditionsSummary={quietNormalHandset:scoreSummary(pairScores(handset,speakerIdentity.similarity)),speakerphone:scoreSummary(pairScores(speakerphone,speakerIdentity.similarity))};
                result.crossConditionScore=rounded(speakerIdentity.similarity(centroid(handset),centroid(speakerphone)));
                result.languageScores=languageScores;result.outlier=outlierScores[0];result.thresholdCandidate=rounded(Math.max(CALIBRATION_THRESHOLD,minimum-0.02));
                result.status=minimum>=CALIBRATION_THRESHOLD?"ready":"not_ready";result.reason=result.status==="ready"?"ready":"heldout_score_below_threshold";
              }
            }
          }
        }
      }
      }catch{result.status="not_ready";result.reason="calibration_error";result.heldout=null;result.conditionsSummary=null;result.crossConditionScore=null;result.languageScores=null;result.outlier=null;}
      const safe=Object.freeze({...result});
      if(persist)await storage.appendActivity({ownerId,action:"pstn_speaker_calibration_readiness_evaluated",status:"completed",summary:"Evaluated PSTN speaker calibration readiness without creating a profile or calibration.",metadata:safe});
      return safe;
    },
    async submitSample({sessionId,submissionKey,ordinal,promptId,audioBase64,mimeType,durationSeconds},{signal}={}){
      const consent=await ensureConsent(),session=await load(sessionId);if(session.consentId!==consent.id||session.status!=="collecting")throw new PstnEnrollmentError("Enrollment session is not collecting samples.",{code:"pstn_enrollment_session_inactive",statusCode:409});
      if(!Number.isInteger(ordinal)||ordinal<1||ordinal>3||session.phrasePlan[ordinal-1]?.id!==promptId||!/^[A-Za-z0-9:_-]{8,160}$/.test(submissionKey||""))throw new PstnEnrollmentError("Enrollment sample binding is invalid.",{code:"pstn_enrollment_sample_invalid"});
      const prior=(await storage.listSpeakerEnrollmentSamples(ownerId,sessionId)).find(item=>item.submissionKey===submissionKey);if(prior)return{sample:prior,acceptedCount:session.acceptedCount,idempotent:true};
      let result;try{result=await speakerExtractor.extract({audioBase64,mimeType,durationSeconds},{signal,requestId:`enrollment-${sessionId}-${ordinal}`,enrollmentAttemptId:sessionId});}catch(error){result={sufficient:false,reason:error?.code||"extractor_rejected",extractorVersion:null};}
      const quality=safeQuality(result),poor=result.sufficient!==true||(Number.isFinite(result.clippingRatio)&&result.clippingRatio>0.02)||(Number.isFinite(result.peakToNoiseDb)&&result.peakToNoiseDb<8),status=poor?"retry":"accepted";
      const recorded=await storage.recordSpeakerEnrollmentSample({id:`speaker-sample-${idFactory()}`,ownerId,sessionId,ordinal,submissionKey,promptId,language:session.phrasePlan[ordinal-1].language,conditionLabel:session.conditionLabel,status,quality,encryptedRepresentation:status==="accepted"?speakerIdentity.protectRepresentation(result.representation):null,representationVersion:status==="accepted"?result.extractorVersion:null});
      let updated=await load(sessionId);if(recorded.inserted&&status==="accepted"&&updated.acceptedCount===3){updated=await storage.updateSpeakerEnrollmentSession(sessionId,ownerId,{status:"completed",completedAt:clock().toISOString()});await storage.appendActivity({ownerId,action:"pstn_speaker_enrollment_session_completed",status:"completed",summary:"Completed one three-sample PSTN enrollment session; calibration remains a separate explicit owner-authorized operation.",metadata:{sessionId,sampleCount:3,totalRequired:6,calibrationCreated:false,ownerModeEnabled:false}});}return{sample:recorded.sample,acceptedCount:updated.acceptedCount,sessionStatus:updated.status,idempotent:!recorded.inserted,retry:status!=="accepted",rawAudioPersisted:false};
    },
  };return Object.freeze(service);
}
