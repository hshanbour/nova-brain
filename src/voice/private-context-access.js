// Account authentication is enforced by the HTTP boundary. A current signed
// speaker match AND an active owner profile are additionally required here.
export async function requirePrivateVoiceSpeaker({assertion,speakerAssertions,speakerIdentity}) {
  const speaker=speakerAssertions?.verify?.(assertion);
  const profile=speaker?.speaker_profile_id ? await speakerIdentity?.get?.(speaker.speaker_profile_id) : null;
  if(speaker?.match_status!=='confirmed'||speaker?.speaker_label!=='owner'||profile?.status!=='active'||profile?.relation!=='owner')throw Object.assign(new Error('Private voice context is paused until the owner voice is verified. Guest conversation does not grant private access.'),{code:'voice_owner_verification_required',statusCode:403});
  return speaker;
}

// Informational evidence only. Every private API still verifies the assertion;
// neither model text nor this summary can authorise a tool or a future turn.
export function verifiedOwnerVoiceEvidence(){return {
  status:'verified_owner',source:'server_verified_enrolled_voice',scope:'current_turn',
  statement:'Nova server verified that the current turn matches an active enrolled owner voice profile in the signed-in workspace. If asked whether you recognise the speaker, acknowledge this actual match. Do not say that no voice verification was performed. This does not prove identity infallibly or grant approval for consequential actions. Reverification is required for subsequent turns; never infer identity from a spoken name.'
};}
