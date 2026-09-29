import test from "node:test";
import assert from "node:assert/strict";
import {appendSafeLinkedText} from "../assets/web-citations.js";

function fixture(){
  const children=[];
  const document={createTextNode:text=>({type:"text",text}),createElement:tag=>({type:tag})};
  return{container:{ownerDocument:document,append(...items){children.push(...items);}},children};
}

test("Console renders bounded HTTPS citations as clickable safe links while leaving other text literal",()=>{
  const {container,children}=fixture();appendSafeLinkedText(container,"Evidence [Official source](https://example.com/a) remains cited.");
  const anchor=children.find(item=>item.type==="a");assert.equal(anchor.href,"https://example.com/a");assert.equal(anchor.textContent,"Official source");assert.equal(anchor.target,"_blank");assert.equal(anchor.rel,"noopener noreferrer");
});

test("Console does not turn non-HTTPS or malformed source syntax into active content",()=>{
  const {container,children}=fixture();appendSafeLinkedText(container,"[unsafe](http://127.0.0.1) <script>alert(1)</script>");
  assert.equal(children.some(item=>item.type==="a"),false);assert.match(children.map(item=>item.text||"").join(""),/<script>/);
});
