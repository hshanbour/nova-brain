import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemContext } from '../src/memory/context-retriever.js';
import { savedReplyLanguage } from '../src/identity/communication-policy.js';
import { requestsEarlierConversation, conversationRecallTerms } from '../src/memory/conversation-recall.js';

test('owner saved reply language is an explicit instruction, not only embedded context', () => {
  const prompt = buildSystemContext({owner:{defaultReplyLanguage:'ar'},memories:[],projects:[]});
  assert.match(prompt, /ACTIVE OWNER REPLY LANGUAGE: Natural Jordanian\/Levantine Arabic/);
  assert.match(prompt, /English question is not an explicit language-switch request/);
  assert.equal(savedReplyLanguage({replyLanguage:'ar',language:'English'}),'ar');
  assert.doesNotMatch(buildSystemContext({owner:{},memories:[]}), /ACTIVE OWNER REPLY LANGUAGE:/);
});

test('explicitly quoted archive topic excludes timeline instructions from matching', () => {
  assert.deepEqual(conversationRecallTerms('منارة تدقيق نوفمبر اختبار تصحيح حذف', 'ارجعي للمحادثات السابقة عن «منارة تدقيق نوفمبر» واذكري تسلسل الاختبار والتصحيح والحذف.'),['منارة','تدقيق','نوفمبر']);
  assert.deepEqual(conversationRecallTerms('Synthetic Lantern correction', 'Recall our earlier conversation about "Synthetic Lantern" and describe the correction.'),['synthetic','lantern']);
  assert.deepEqual(conversationRecallTerms('Sharp Cuts', 'Recall our earlier Sharp Cuts conversation.'),['sharp','cuts']);
});

test('a prohibition on archive search is not permission to search', () => {
  for (const message of [
    'Use saved memory only; do not search earlier conversations.',
    "Don't retrieve previous chats about the lighthouse.",
    'لا تبحثي في أي محادثة سابقة، ولا تخمني.',
    'شو الرمز؟ لا تبحثي في المحادثات السابقة.',
  ]) assert.equal(requestsEarlierConversation(message),false,message);
  for (const message of [
    'Recall our earlier conversation about Synthetic Lantern.',
    'ارجعي للمحادثات السابقة عن «منارة تدقيق نوفمبر» ولا تعيدي حفظها.',
  ]) assert.equal(requestsEarlierConversation(message),true,message);
});
