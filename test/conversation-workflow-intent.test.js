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
