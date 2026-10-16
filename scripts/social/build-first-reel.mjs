import { createRequire } from "node:module";
import { mkdir, rm, writeFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const require = createRequire(import.meta.url);
const sharpPath = process.env.NOVA_SHARP_PATH;
const ffmpeg = process.env.NOVA_FFMPEG_PATH;
if (!sharpPath || !ffmpeg) throw new Error("NOVA_SHARP_PATH and NOVA_FFMPEG_PATH are required.");
const sharp = require(sharpPath);

const root = path.resolve(import.meta.dirname, "../..");
const outputDir = path.join(root, "assets", "social", "reels");
const workDir = path.join(root, ".social-render-work");
const narration = process.env.NOVA_NARRATION_PATH || path.join(workDir, "narration.wav");
const visual = path.join(workDir, "visual.mp4");
const soundtrack = path.join(workDir, "soundtrack.m4a");
const output = path.join(outputDir, "three-jobs-ai-should-assist-v1.mp4");
const poster = path.join(outputDir, "three-jobs-ai-should-assist-v1-poster.jpg");

await rm(workDir, { recursive: true, force: true });
await mkdir(workDir, { recursive: true });
await mkdir(outputDir, { recursive: true });

const escapeXml = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const wrap = (value, limit) => {
  const lines = []; let current = "";
  for (const word of String(value).split(/\s+/)) {
    if (!current || `${current} ${word}`.length <= limit) current = current ? `${current} ${word}` : word;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines;
};
const scene = ({ eyebrow, title, body, number, accent = "#8cf5d2", motif = "spark" }) => `
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#07131f"/><stop offset=".54" stop-color="#10273d"/><stop offset="1" stop-color="#081019"/></linearGradient>
    <radialGradient id="glow"><stop offset="0" stop-color="${accent}" stop-opacity=".34"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient>
    <filter id="shadow"><feDropShadow dx="0" dy="22" stdDeviation="30" flood-color="#000" flood-opacity=".45"/></filter>
  </defs>
  <rect width="1080" height="1920" fill="url(#bg)"/><circle cx="880" cy="270" r="430" fill="url(#glow)"/><circle cx="180" cy="1580" r="330" fill="url(#glow)" opacity=".45"/>
  <g opacity=".14" stroke="#d8f7ef" stroke-width="2">${Array.from({ length: 12 }, (_, i) => `<path d="M${60 + i * 92} 0V1920"/>`).join("")}${Array.from({ length: 20 }, (_, i) => `<path d="M0 ${80 + i * 92}H1080"/>`).join("")}</g>
  <g transform="translate(78 86)"><rect width="74" height="74" rx="24" fill="${accent}"/><path d="M21 48 37 21l16 27M27 39h20" fill="none" stroke="#07131f" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><text x="94" y="31" fill="#f5fbff" font-family="Segoe UI,Arial,sans-serif" font-size="28" font-weight="700">NOVA DIGITAL SERVICES UK</text><text x="94" y="63" fill="#a9bfcc" font-family="Segoe UI,Arial,sans-serif" font-size="20" letter-spacing="4">PRACTICAL AI · HUMAN CONTROL</text></g>
  <g transform="translate(78 330)" filter="url(#shadow)"><rect width="924" height="1120" rx="58" fill="#0e2133" stroke="#fff" stroke-opacity=".14" stroke-width="3"/><rect x="44" y="44" width="${number ? 112 : 260}" height="72" rx="36" fill="${accent}"/><text x="${number ? 100 : 174}" y="92" text-anchor="middle" fill="#06111b" font-family="Segoe UI,Arial,sans-serif" font-size="28" font-weight="800">${escapeXml(number || eyebrow)}</text>${number ? `<text x="184" y="92" fill="#bed1dc" font-family="Segoe UI,Arial,sans-serif" font-size="25" font-weight="700" letter-spacing="3">${escapeXml(eyebrow)}</text>` : ""}
    <text x="48" y="270" fill="#f7fbff" font-family="Segoe UI,Arial,sans-serif" font-size="78" font-weight="800" letter-spacing="-2">${wrap(title, 22).map((line, index) => `<tspan x="48" dy="${index ? 86 : 0}">${escapeXml(line)}</tspan>`).join("")}</text>
    <text x="50" y="750" fill="#bdd0da" font-family="Segoe UI,Arial,sans-serif" font-size="38" font-weight="500">${wrap(body, 42).map((line, index) => `<tspan x="50" dy="${index ? 52 : 0}">${escapeXml(line)}</tspan>`).join("")}</text>
    <g transform="translate(52 1000)">${motif === "checklist" ? `<rect width="820" height="78" rx="28" fill="#fff" fill-opacity=".07"/><circle cx="42" cy="39" r="18" fill="${accent}"/><path d="m33 39 7 7 13-16" fill="none" stroke="#07131f" stroke-width="6"/><rect y="102" width="690" height="18" rx="9" fill="#fff" fill-opacity=".18"/><rect y="142" width="530" height="18" rx="9" fill="#fff" fill-opacity=".12"/>` : motif === "draft" ? `<rect width="820" height="172" rx="28" fill="#fff" fill-opacity=".06"/><rect x="38" y="38" width="500" height="18" rx="9" fill="${accent}"/><rect x="38" y="78" width="690" height="16" rx="8" fill="#fff" fill-opacity=".22"/><rect x="38" y="116" width="580" height="16" rx="8" fill="#fff" fill-opacity=".14"/>` : motif === "organise" ? [0,1,2].map(i => `<rect x="${i*274}" width="246" height="170" rx="30" fill="#fff" fill-opacity="${.05+i*.03}"/><circle cx="${42+i*274}" cy="46" r="16" fill="${accent}"/><rect x="${72+i*274}" y="36" width="130" height="18" rx="9" fill="#fff" fill-opacity=".3"/><rect x="${32+i*274}" y="92" width="174" height="14" rx="7" fill="#fff" fill-opacity=".14"/>`).join("") : motif === "shield" ? `<path d="M410-65 555-8v105c0 92-63 163-145 202-82-39-145-110-145-202V-8z" fill="${accent}" fill-opacity=".16" stroke="${accent}" stroke-width="8"/><path d="m355 38 44 44 80-96" fill="none" stroke="${accent}" stroke-width="20" stroke-linecap="round"/>` : `<path d="M0 90h210l60-60 80 120 78-78 86 86 70-70h236" fill="none" stroke="${accent}" stroke-width="12" stroke-linecap="round"/><circle cx="270" cy="30" r="19" fill="${accent}"/><circle cx="428" cy="72" r="19" fill="${accent}"/>`}</g>
  </g>
  <g transform="translate(78 1530)"><rect width="924" height="210" rx="46" fill="#07131f" stroke="${accent}" stroke-opacity=".5" stroke-width="3"/><text x="46" y="72" fill="${accent}" font-family="Segoe UI,Arial,sans-serif" font-size="25" font-weight="800" letter-spacing="3">THE CHECKLIST</text><text x="46" y="130" fill="#f7fbff" font-family="Segoe UI,Arial,sans-serif" font-size="37" font-weight="700">Summarise · Draft · Organise</text><text x="46" y="173" fill="#a9bfcc" font-family="Segoe UI,Arial,sans-serif" font-size="24">Keep people responsible for the decision.</text></g>
  <text x="540" y="1840" text-anchor="middle" fill="#8fa8b7" font-family="Segoe UI,Arial,sans-serif" font-size="22" letter-spacing="4">@NOVADIGITALSERVICESUK</text>
</svg>`;

const scenes = [
  { eyebrow: "PRACTICAL AI", title: "AI should remove friction — not responsibility.", body: "Three useful jobs for AI in a small business.", accent: "#8cf5d2", motif: "spark" },
  { eyebrow: "ASSIST, DON'T DECIDE", number: "01", title: "Summarise repetitive information.", body: "Turn long notes into a reviewable starting point — then check what matters.", accent: "#79d8ff", motif: "checklist" },
  { eyebrow: "ASSIST, DON'T DECIDE", number: "02", title: "Draft the first version.", body: "Use AI to escape the blank page. A person still owns the final words.", accent: "#b5a0ff", motif: "draft" },
  { eyebrow: "ASSIST, DON'T DECIDE", number: "03", title: "Organise the next steps.", body: "Convert scattered information into a clear, editable action list.", accent: "#ffc878", motif: "organise" },
  { eyebrow: "THE GUARDRAIL", title: "People own prices, promises and final decisions.", body: "Automation should make responsibility clearer — never hide it.", accent: "#ff9da8", motif: "shield" },
  { eyebrow: "SAVE THIS", title: "Use AI for the first 80%. Keep judgement for the final 20%.", body: "Follow for practical AI systems without the hype.", accent: "#8cf5d2", motif: "spark" }
];

for (const [index, item] of scenes.entries()) await sharp(Buffer.from(scene(item))).png({ compressionLevel: 9 }).toFile(path.join(workDir, `scene-${index + 1}.png`));
const run = args => new Promise((resolve, reject) => { const child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] }); let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; }); child.on("error", reject); child.on("close", code => code === 0 ? resolve(stderr) : reject(new Error(stderr.slice(-6000)))); });

const visualArgs = ["-y"];
for (let index = 0; index < scenes.length; index += 1) visualArgs.push("-loop", "1", "-t", "5", "-i", path.join(workDir, `scene-${index + 1}.png`));
const motion = scenes.map((_, index) => `[${index}:v]scale=1120:1992,crop=1080:1920:x='(iw-ow)/2+6*sin(t*.55+${index})':y='(ih-oh)/2+8*cos(t*.42+${index})',setsar=1,fps=30,format=yuv420p[v${index}]`).join(";");
const transitions = "[v0][v1]xfade=transition=fade:duration=0.5:offset=4.5[x1];[x1][v2]xfade=transition=slideleft:duration=0.5:offset=9[x2];[x2][v3]xfade=transition=slideup:duration=0.5:offset=13.5[x3];[x3][v4]xfade=transition=fadeblack:duration=0.5:offset=18[x4];[x4][v5]xfade=transition=fade:duration=0.5:offset=22.5[vout]";
visualArgs.push("-filter_complex", `${motion};${transitions}`, "-map", "[vout]", "-t", "27.5", "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", visual);
await run(visualArgs);

const hasNarration = await stat(narration).then(() => true, () => false);
const audioArgs = ["-y", "-f", "lavfi", "-i", "sine=frequency=174:duration=27.5:sample_rate=48000", "-f", "lavfi", "-i", "sine=frequency=261.63:duration=27.5:sample_rate=48000"];
if (hasNarration) audioArgs.push("-i", narration);
const audioFilter = hasNarration ? "[0:a]volume=.018,afade=t=in:st=0:d=1.2,afade=t=out:st=25:d=2.5[b0];[1:a]volume=.010,afade=t=in:st=0:d=1.2,afade=t=out:st=25:d=2.5[b1];[2:a]adelay=650|650,volume=1.25,highpass=f=90,lowpass=f=12000[voice];[b0][b1][voice]amix=inputs=3:duration=longest:dropout_transition=2,loudnorm=I=-16:TP=-1.5:LRA=8[aout]" : "[0:a]volume=.025,afade=t=in:st=0:d=1.2,afade=t=out:st=25:d=2.5[b0];[1:a]volume=.014,afade=t=in:st=0:d=1.2,afade=t=out:st=25:d=2.5[b1];[b0][b1]amix=inputs=2:duration=longest,loudnorm=I=-20:TP=-2:LRA=6[aout]";
audioArgs.push("-filter_complex", audioFilter, "-map", "[aout]", "-t", "27.5", "-ar", "48000", "-c:a", "aac", "-b:a", "160k", soundtrack);
await run(audioArgs);
await run(["-y", "-i", visual, "-i", soundtrack, "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-shortest", output]);
await run(["-y", "-ss", "1.2", "-i", output, "-frames:v", "1", "-q:v", "2", poster]);
await writeFile(path.join(outputDir, "three-jobs-ai-should-assist-v1-rights.json"), `${JSON.stringify({ asset: path.basename(output), version: 1, project: "nova-digital-services-uk", contentId: "social_nova_launch_ai_assist_not_decide", rightsStatus: "owned", sourceAttribution: "Original Nova Digital Services UK motion design, script, vector artwork, subtitles, and generated sound design.", externalMedia: [], narration: hasNarration ? "Microsoft Hazel system voice rendered locally from Nova-owned script; no provider API usage." : "none", dimensions: "1080x1920", durationSeconds: 27.5, createdAt: new Date().toISOString() }, null, 2)}\n`);
console.log(JSON.stringify({ output, poster, narration: hasNarration, scenes: scenes.length }));
