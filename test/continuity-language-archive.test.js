import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemContext } from '../src/memory/context-retriever.js';
import { savedReplyLanguage } from '../src/identity/communication-policy.js';
import { requestsEarlierConversation, conversationRecallTerms } from '../src/memory/conversation-recall.js';
import { allowsMemoryMutation, requiresMemoryOnly } from '../src/memory/mutation-intent.js';
import { createInMemoryStorage } from '../src/storage/in-memory-storage.js';
import { createToolRegistry } from '../src/tools/tool-registry.js';
import { registerSystemTools } from '../src/tools/developer-tools.js';
import { createAgent } from '../src/agent/agent.js';

test('owner saved reply language is an explicit instruction, not only embedded context', () => {
  const prompt = buildSystemContext({owner:{defaultReplyLanguage:'ar'},memories:[],projects:[]});
  assert.match(prompt, /ACTIVE OWNER REPLY LANGUAGE: Natural Jordanian\/Levantine Arabic/);
  assert.match(prompt, /English question is not an explicit language-switch request/);
  assert.equal(savedReplyLanguage({replyLanguage:'ar',language:'English'}),'ar');
  assert.doesNotMatch(buildSystemContext({owner:{},memories:[]}), /ACTIVE OWNER REPLY LANGUAGE:/);
});

test('a recall question cannot write memory even when the model attempts it', async () => {
  const storage=createInMemoryStorage();
  await storage.initialize({owner:{id:'test-owner',preferences:{arabic:'Levantine'}},projects:[]});
  const registry=createToolRegistry(); registerSystemTools(registry,{storage,ownerId:'test-owner'});
  let offered, result;
  const agent=createAgent({storage,ownerId:'test-owner',toolRegistry:registry,modelProvider:{name:'fixture',async generate(input){
    if(!input.toolResults?.length){offered=input.tools;return {type:'tool_calls',toolCalls:[{id:'bad-write',name:'memory_remember',arguments:{content:'An unsupported invented answer.',category:'preference',scope:'global'}}]};}
    result=input.toolResults; return {type:'final',message:'No supported memory.'};
  }}});
  await agent.run({conversationId:'read-only-test',message:'What is my saved November audit lighthouse code?'});
  assert.ok(offered.every(t=>t.name!=='memory_remember'&&t.name!=='memory_forget'));
  assert.equal(result[0].output.ok,false);
  assert.equal((await storage.listMemories('test-owner')).length,0);
  for(const text of ['Remember this test fact: violet.','صححي ذاكرة الاختبار: الرمز عنبر.','تذكري هذه المعلومة للاختبار فقط.']) assert.equal(allowsMemoryMutation('memory_remember',text),true);
  assert.equal(allowsMemoryMutation('memory_forget','احذفي ذاكرة الاختبار فقط.'),true);
  assert.equal(allowsMemoryMutation('memory_remember','لا تحفظي هذا النص.'),false);
  assert.equal(requiresMemoryOnly('Use active memory only; do not search previous conversations.'),true);
  assert.equal(requiresMemoryOnly('جاوبي من الذاكرة الدائمة فقط.'),true);
  assert.equal(requiresMemoryOnly('Remember this preference: use active memory only.'),false);
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
    'Start a new conversation, do not use any previous conversations.',
    'I mentioned a previous chat in my notes.',
    'لا تفتحي المحادثة السابقة.',
  ]) assert.equal(requestsEarlierConversation(message),false,message);
  for (const message of [
    'Recall our earlier conversation about Synthetic Lantern.',
    'Pick up where we left off in our last chat about PGK.',
    'كملي آخر محادثة عن المشروع.',
    'ارجعي للمحادثات السابقة عن «منارة تدقيق نوفمبر» ولا تعيدي حفظها.',
  ]) assert.equal(requestsEarlierConversation(message),true,message);
});
