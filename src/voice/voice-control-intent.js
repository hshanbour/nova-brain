export const VOICE_CONTROL_INTENT = Object.freeze({ PAUSE:"pause", RESUME:"resume", NEW_CONVERSATION:"new_conversation", UNRELATED:"unrelated", UNCERTAIN:"uncertain" });

const PAUSE_PHRASES=["استني","استنى","وقف","وقفي","وقفه","لحظه","دقيقه","شوي","استني شوي","وقف شوي","وقفي شوي","اسكتي شوي","خلاص","wait","stop","pause","hold on","one second","just a second","espera","un momento","arrete","attends"];
const RESUME_PHRASES=["كملي","كمل","كملي حكي","كمل حكي","تابعي","تابع","يلا كملي","ارجعي كملي","رجعي كملي","كملي هس يلا","كملي من وين وقفتي","كملي من عند ما تركتي","شو كنتي تحكي","ارجعي لنفس النقطه","resume from where you stopped","continue where you left off","continue","resume","carry on","go on","keep going","continua","sigue","continuez"];

export function classifyVoiceControlIntent({transcript,state}={}){
  const value=normaliseVoiceControlText(transcript);const allowed=state==="speaking"?[[VOICE_CONTROL_INTENT.PAUSE,PAUSE_PHRASES]]:["paused_waiting_for_user","resumable"].includes(state)?[[VOICE_CONTROL_INTENT.RESUME,RESUME_PHRASES]]:[];
  if(!value)return result(VOICE_CONTROL_INTENT.UNCERTAIN,0,"empty");
  for(const [intent,phrases] of allowed){if(phrases.includes(value))return result(intent,1,"exact");if(boundedFuzzy(value,phrases))return result(intent,.88,"bounded_fuzzy");if(intent===VOICE_CONTROL_INTENT.PAUSE&&isPauseOnlyPhrase(value))return result(intent,.92,"bounded_semantic");if(intent===VOICE_CONTROL_INTENT.RESUME&&isResumeOnlyPhrase(value))return result(intent,.92,"bounded_semantic");}
  if((state!=="speaking"&&isControlLookalikeConversation(value))||isConversationalTurn(value)||isGreeting(value))return result(VOICE_CONTROL_INTENT.NEW_CONVERSATION,.9,"conversational_turn");
  if(value.split(" ").length<=3)return result(VOICE_CONTROL_INTENT.UNCERTAIN,.45,"short_ambiguous");
  return result(VOICE_CONTROL_INTENT.UNRELATED,.8,"not_control_or_conversation");
}

export function normaliseVoiceControlText(value){return String(value||"").normalize("NFKD").replace(/\p{M}/gu,"").replace(/[أإآٱ]/gu,"ا").replace(/ة/gu,"ه").replace(/ى/gu,"ي").replace(/ـ/gu,"").toLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").replace(/\s+/gu," ").trim();}
function boundedFuzzy(value,phrases){if(value.includes(" "))return false;return phrases.some((phrase)=>!phrase.includes(" ")&&Math.abs(phrase.length-value.length)<=1&&editDistanceAtMostOne(value,phrase));}
function editDistanceAtMostOne(a,b){if(a===b)return true;if(Math.abs(a.length-b.length)>1)return false;let i=0,j=0,edits=0;while(i<a.length&&j<b.length){if(a[i]===b[j]){i++;j++;continue;}if(++edits>1)return false;if(a.length>b.length)i++;else if(b.length>a.length)j++;else{i++;j++;}}return edits+(i<a.length||j<b.length?1:0)<=1;}
function isPauseOnlyPhrase(value){const tokens=value.split(" ");return tokens.length<=4&&tokens.every((token)=>["استني","استنى","وقف","وقفي","وقفه","لحظه","دقيقه","شوي","خلاص","نوفا"].includes(token));}
function isResumeOnlyPhrase(value){const tokens=value.split(" ");if(/^(?:نوفا )?(?:بتقدري|تقدري|ممكن|لو سمحتي )?(?:تكملي|تكمليلي|تواصلي|تستمري)(?: من وين وقفتي)?$/u.test(value))return true;return tokens.length<=7&&tokens.every((token)=>["كملي","كمل","تكملي","تكمليلي","حكي","تابعي","تابع","واصلي","استمري","يلا","ارجعي","رجعي","نوفا","تقدري","بتقدري","ممكن","لو","سمحتي","من","وين","وقفتي"].includes(token));}
function isControlLookalikeConversation(value){return /^(?:كملي|كمل|تابعي|واصل|واصلي|استمر|استمري|continue|resume|keep going)\s+(?!(?:حكي|من وين وقفتي|from where you stopped)$).+/iu.test(value);}
function isGreeting(value){return /^(?:مرحبا|اهلا|هلا|السلام عليكم|hello|hi|hey)(?:$|\s)/iu.test(value);}
function isConversationalTurn(value){return /^(?:مين|من|شو|ماذا|وين|اين|متى|ليش|كيف|هل)(?:$|\s)/u.test(value)||/^(?:what|who|where|when|why|how|can|could|would|do|does|did|is|are)(?:$|\s)/iu.test(value)||/[?؟]$/u.test(value);}
function result(intent,confidence,method){return Object.freeze({intent,confidence,method});}
