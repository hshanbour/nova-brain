import test from "node:test";
import assert from "node:assert/strict";
import { createMatrixAvatar } from "../assets/matrix-avatar.js";

test("matrix avatar renders procedural depth, changes variants and fully stops", () => {
  const callbacks = [];
  const context = fakeContext();
  const canvas = { width: 0, height: 0, getContext: () => context, getBoundingClientRect: () => ({ width: 320, height: 420 }) };
  const avatar = createMatrixAvatar({ canvas, raf(callback) { callbacks.push(callback); return callbacks.length; }, caf() {}, now: () => 1000, dpr: () => 1 });
  avatar.start();
  assert.equal(callbacks.length, 1);
  callbacks.shift()(1040);
  assert.ok(context.draws > 100, "a genuine point field should render");
  assert.equal(avatar.metrics().pointCount, 760);
  assert.equal(avatar.setVariant("wireframe").getVariant(), "wireframe");
  assert.equal(avatar.setState("executing").getState(), "executing");
  avatar.stop();
  assert.equal(avatar.metrics().running, false);
  avatar.dispose();
});

function fakeContext() {
  const context = { draws: 0, clearRect() {}, setTransform() {}, save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, arc() { this.draws += 1; }, ellipse() { this.draws += 1; }, fill() {}, stroke() { this.draws += 1; }, fillRect() { this.draws += 1; }, createLinearGradient() { return { addColorStop() {} }; } };
  for (const property of ["globalCompositeOperation", "fillStyle", "strokeStyle", "lineWidth"]) Object.defineProperty(context, property, { set() {}, configurable: true });
  return context;
}
