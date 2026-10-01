import test from "node:test";
import assert from "node:assert/strict";
import {isConversationWorkflowTurn,isSelfDevelopmentWorkflowCandidate} from "../src/autonomy/conversation-workflow-intent.js";

test("stored candidates cannot activate workflow routing for an ordinary current turn",()=>{
  assert.equal(isConversationWorkflowTurn("What should we do next for Sharp Cuts?"),false);
  assert.equal(isConversationWorkflowTurn("شو اللي صاير معك"),false);
  assert.equal(isConversationWorkflowTurn("Please remember that I prefer concise answers."),false);
  assert.equal(isSelfDevelopmentWorkflowCandidate({id:`web_${"a".repeat(32)}`}),false);
  assert.equal(isSelfDevelopmentWorkflowCandidate({id:`coding_${"b".repeat(32)}`}),true);
});

test("generic email test and approval wording stays outside workflow routing",()=>{
  const request=`Prepare a test email to hamodehshanbour@yahoo.com with the subject “Nova Email V1 Test” and the body “This is the first real email sent through Nova Email V1.”

Do not send it yet. Show me the exact email and wait for my explicit approval before sending.`;
  assert.equal(isConversationWorkflowTurn(request),false);
  assert.equal(isConversationWorkflowTurn("test"),false);
  assert.equal(isConversationWorkflowTurn("approval"),false);
  assert.equal(isConversationWorkflowTurn("approve"),false);
  assert.equal(isConversationWorkflowTurn("test approval approve"),false);
  assert.equal(isConversationWorkflowTurn("Prepare a test email and wait for approval."),false);
  assert.equal(isConversationWorkflowTurn("Show this approval before sending."),false);
});

test("only a current workflow reference or implementation signal opens trusted workflow resolution",()=>{
  assert.equal(isConversationWorkflowTurn("Continue it."),true);
  assert.equal(isConversationWorkflowTurn("Why is the shipping task blocked?"),true);
  assert.equal(isConversationWorkflowTurn("What's the status?"),true);
  assert.equal(isConversationWorkflowTurn("Deploy to Preview."),true);
  assert.equal(isConversationWorkflowTurn("I approve it."),true);
  assert.equal(isConversationWorkflowTurn("كمل المهمة"),true);
  assert.equal(isConversationWorkflowTurn(`Show status for coding_${"c".repeat(32)}`),true);
  assert.equal(isConversationWorkflowTurn("Implement a new Console control.",{implementationSignal:true}),true);
});
