import test from "node:test";
import assert from "node:assert/strict";
import {parseTestFailure} from "../src/tools/test-failure-evidence.js";

test("structured test evidence captures bounded actionable failure data",()=>{
  const evidence=parseTestFailure({root:"C:/repo",runner:"node_test",command:"npm test",exitCode:1,durationMs:42,stdout:"✖ composer records dictation\nAssertionError: expected true\n    at C:/repo/test/composer-dictation.test.js:23:4\nℹ tests 2\nℹ pass 1\nℹ fail 1"});
  assert.equal(evidence.version,1);assert.deepEqual(evidence.failedFiles,["test/composer-dictation.test.js"]);assert.deepEqual(evidence.failedTitles,["composer records dictation"]);assert.equal(evidence.errorClass,"AssertionError");assert.equal(evidence.counts.failed,1);assert.equal(evidence.durationMs,42);assert.match(evidence.fingerprint,/^[a-f0-9]{64}$/);
});

test("structured test evidence is redacted bounded and deterministic",()=>{
  const input={root:"C:/repo",runner:"node_test",command:"npm test",stderr:`token=do-not-leak\n${"x".repeat(13000)}`},first=parseTestFailure(input),second=parseTestFailure(input);
  assert.equal(first.fingerprint,second.fingerprint);assert.equal(first.stderrTruncated,true);assert.ok(first.stderrExcerpt.length<=12000);assert.doesNotMatch(JSON.stringify(first),/do-not-leak/);
});

test("malformed runner output produces a safe fallback classification",()=>{const evidence=parseTestFailure({root:"C:/repo",stderr:"unstructured failure"});assert.deepEqual(evidence.failedFiles,[]);assert.equal(evidence.errorMessage,"Allowlisted tests failed.");assert.match(evidence.fingerprint,/^[a-f0-9]{64}$/);});
