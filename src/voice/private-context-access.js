// Account authentication is enforced by the HTTP boundary. A current signed
// speaker match AND an active owner profile are additionally required here.
export async function requirePrivateVoiceSpeaker({assertion,speakerAssertions,speakerIdentity,turnId}) {
  const speaker=speakerAssertions?.verify?.(assertion);
  const profile=speaker?.speaker_profile_id ? await speakerIdentity?.get?.(speaker.speaker_profile_id) : null;
  if((speaker?.turn_id||turnId)&&speaker?.turn_id!==turnId)throw Object.assign(new Error('Speaker evidence belongs to a different voice turn.'),{code:'voice_owner_verification_required',statusCode:403});
  if(speaker?.match_status!=='confirmed'||speaker?.speaker_label!=='owner'||profile?.status!=='active'||profile?.relation!=='owner')throw Object.assign(new Error('Private voice context is paused until the owner voice is verified. Guest conversation does not grant private access.'),{code:'voice_owner_verification_required',statusCode:403});
  return speaker;
}

// Informational evidence only. Every private API still verifies the assertion;
// neither model text nor this summary can authorise a tool or a future turn.
export function verifiedOwnerVoiceEvidence(profile){return {
  status:'verified_owner',source:'server_verified_enrolled_voice',scope:'current_turn',
  ...(profile ? {identity:{preferredName:profile.preferredName||null,arabicName:profile.arabicName||null,source:'authorised_workspace_owner_record'}} : {}),
  statement:'The server matched this turn to the active enrolled owner profile in the signed-in workspace. The attached identity, when present, comes from that authorised workspace owner record. Use its saved name naturally when asked who the speaker is; do not substitute the label owner for an available name. Do not invent missing personal details or repeat technical verification disclaimers in ordinary conversation. If asked how you know, explain the enrolled voice match and saved account record honestly. This is not infallible identity proof or approval for consequential actions. Every later turn and private tool still requires server verification; never infer identity from a spoken name.'
};}
