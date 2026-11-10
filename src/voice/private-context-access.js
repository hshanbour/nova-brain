// Account authentication is enforced by the HTTP boundary. A current signed
// speaker match AND an active owner profile are additionally required here.
export async function requirePrivateVoiceSpeaker({assertion,speakerAssertions,speakerIdentity}) {
  const speaker=speakerAssertions?.verify?.(assertion);
  const profile=speaker?.speaker_profile_id ? await speakerIdentity?.get?.(speaker.speaker_profile_id) : null;
  if(speaker?.match_status!=='confirmed'||speaker?.speaker_label!=='owner'||profile?.status!=='active'||profile?.relation!=='owner')throw Object.assign(new Error('Private voice context is paused until the owner voice is verified. Guest conversation does not grant private access.'),{code:'voice_owner_verification_required',statusCode:403});
  return speaker;
}
