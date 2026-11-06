import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("voice conversation entry is beside composer and immersive/integrated modes are real controls", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const consoleSource = await readFile(new URL("../assets/console.js", import.meta.url), "utf8");
  const topbar = html.slice(html.indexOf('<header class="topbar">'), html.indexOf("</header>", html.indexOf('<header class="topbar">')));
  const composer = html.slice(html.indexOf('<form class="composer"'), html.indexOf("</form>", html.indexOf('<form class="composer"')));
  assert.doesNotMatch(topbar, /id="voiceModeButton"/);
  assert.match(composer, /id="voiceButton"[\s\S]*id="voiceModeButton"/);
  assert.doesNotMatch(composer, /composerVoiceReviewButton|endVoiceButton/);
  assert.match(html, /id="voiceWorkspaceDock"/);
  assert.match(html, /id="voiceExperience"[\s\S]*id="voiceMuteButton"[\s\S]*id="voiceExperienceEnd"/);
  assert.match(html, /id="voiceAvatarCanvas"[\s\S]*id="avatarGalleryDialog"/);
  assert.match(html, /Nova Prism Shard Bloom[\s\S]*id="novaAetherCanvas"[\s\S]*data-aether-state="listening"[\s\S]*data-aether-view="profile"/);
  assert.match(consoleSource, /createNovaPrismAvatar/);
  assert.doesNotMatch(html, /data-avatar-option=/);
  assert.match(html, /value="separate"[\s\S]*value="integrated"/);
  assert.doesNotMatch(consoleSource, /onTranscript\(text\)\{input\.value=text/);
  assert.match(consoleSource, /persistRealtimeTurn/);
  assert.match(consoleSource, /voiceSessionDesired/);
  assert.match(consoleSource, /onInputLevel\(level\)/);
});
