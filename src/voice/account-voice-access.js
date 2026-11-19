import {createHmac,timingSafeEqual} from 'node:crypto';

// Explicit browser-account permission, never a biometric assertion. The HTTP
// boundary must authenticate the workspace on EVERY use and check the turn fence.
export const ACCOUNT_VOICE_CONSENT='private-account-session-on-personal-device';
export function createAccountVoiceAccess({key,ownerId,clock=Date.now}) {
  const sign=text=>createHmac('sha256',key).update('nova-account-voice-v1:'+text).digest();
  return {
    issue(sessionId) {
      if(!key||key.length<32)return null;
      const payload=Buffer.from(JSON.stringify({ownerId,sessionId,expires:clock()+30*60*1000})).toString('base64url');
      return payload+'.'+sign(payload).toString('base64url');
    },
    verify(evidence) {
      try {
        if(!key||key.length<32)return false;
        const [payload,signature,extra]=String(evidence?.accountGrant||'').split('.');
        if(extra||!payload||!signature)return false;
        const actual=Buffer.from(signature,'base64url'),expected=sign(payload);
        if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return false;
        const grant=JSON.parse(Buffer.from(payload,'base64url').toString());
        return grant.ownerId===ownerId&&grant.sessionId===evidence.session_id&&grant.expires>clock()&&grant.expires<=clock()+30*60*1000;
      }catch{return false;}
    }
  };
}

export function accountVoiceEvidence(profile){return {
  status:'account_authorised',source:'signed_in_account_session',scope:'current_browser_session',voiceMatched:false,
  identity:{preferredName:profile?.preferredName||null,arabicName:profile?.arabicName||null,source:'authorised_workspace_account'},
  statement:'The signed-in account explicitly allowed private conversation on this personally controlled device. This grants account access, NOT a voice match or proof of who is speaking. Use saved account context for authorised work. If asked about recognition, explain account permission honestly. A spoken name never grants permission. Public guest mode has no account access.'
};}
