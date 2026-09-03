export const OWNER_ID = "owner_mohammad_shanbour";

export const INITIAL_OWNER_PROFILE = Object.freeze({
  id: OWNER_ID,
  fullName: "Mohammad Shanbour",
  preferredName: "Mohammad",
  arabicName: "محمد شنبور",
  facts: Object.freeze({
    gender: "male",
    bornIn: "Jordan",
    familyBackground: "Palestinian",
    currentLocation: "Luton, United Kingdom",
    maritalStatus: "married",
    childrenCount: 2,
    languages: ["Arabic", "English"],
    profession: "Experienced barber with many years of experience",
    education: "Studying Business Management in the United Kingdom"
  }),
  preferences: Object.freeze({
    communication: "Direct, natural, practical, and concise without unnecessary repetition",
    arabic: "Natural Jordanian/Levantine Arabic unless context suggests otherwise",
    english: "Natural British English",
    execution: "Prefer safe practical execution and clear next actions over excessive theory"
  }),
  goals: Object.freeze([]),
  context: Object.freeze({
    sharpCuts: "Sharp Cuts is a separate barber business/project in Luton, United Kingdom; it is not Nova Brain."
  }),
  provenance: "owner-provided-initial-context",
  privacy: "private"
});

export const INITIAL_PROJECTS = Object.freeze([
  { id: "nova-brain", name: "Nova Brain", description: "Personal AI and orchestration system." },
  { id: "sharp-cuts", name: "Sharp Cuts", description: "Separate barber business in Luton, United Kingdom." },
  { id: "uk-missed-call-recovery", name: "UK missed-call recovery", description: "Initial business testbed for recovering customers after missed inbound calls." }
]);

export const INITIAL_MEMORIES = Object.freeze([
  {
    id: "memory_owner_communication",
    category: "preference",
    scope: "global",
    content: "Mohammad prefers direct, natural communication, minimal repetition, practical execution, and clear next actions. Use natural Jordanian/Levantine Arabic with him unless context suggests otherwise, and natural British English in English.",
    provenance: "owner-provided-initial-context",
    privacy: "private",
    sensitivity: "personal",
    status: "active"
  },
  {
    id: "memory_sharp_cuts_context",
    category: "project_context",
    scope: "project",
    projectId: "sharp-cuts",
    content: "Mohammad is an experienced barber involved in Sharp Cuts in Luton. Sharp Cuts is a separate business/project and must never be confused with Nova Brain.",
    provenance: "owner-provided-initial-context",
    privacy: "private",
    sensitivity: "business",
    status: "active"
  },
  {
    id: "memory_nova_vision",
    category: "project_context",
    scope: "system",
    content: "Nova Brain is intended to become a broad personal autonomous execution system and central orchestrator, not merely a chatbot. It should coordinate specialised tools and agents to safely research, validate, build, deploy, market, operate, measure, improve, scale, or stop real projects.",
    provenance: "owner-provided-initial-context",
    privacy: "private",
    sensitivity: "normal",
    status: "active"
  },
  {
    id: "memory_nova_portfolio_strategy",
    category: "reusable_instruction",
    scope: "system",
    content: "Nova's portfolio cycle is: research, validate, run the smallest real test, attempt real customer acquisition, learn, then scale, iterate, or kill. Avoid creating useless projects merely to generate activity; each project should add reusable capability, workflow, or knowledge.",
    provenance: "owner-provided-initial-context",
    privacy: "private",
    sensitivity: "normal",
    status: "active"
  },
  {
    id: "memory_nova_voice_recent_milestone",
    category: "project_context",
    scope: "project",
    projectId: "nova-brain",
    content: "Recent Nova Voice work: ECAPA remains the authoritative speaker engine at threshold 0.35 with signed owner assertions and fail-closed unknown handling. Arabic, English, and mixed owner recognition and real unknown-speaker rejection passed. ElevenLabs Nova Female V1 long-form streaming and consistent seeded chunking are active. The speaker-engine abstraction is installed with Eagle disabled. The current feature Preview adds same-session interruption checkpoint preservation, acknowledgement-safe playback, Arabic and English resume commands, privacy-safe latency telemetry, and faster human barge-in detection; final real acceptance is still pending.",
    provenance: "system-generated-project-release",
    privacy: "private",
    sensitivity: "normal",
    status: "active"
  },
  {
    id: "memory_missed_call_testbed",
    category: "project_context",
    scope: "project",
    projectId: "uk-missed-call-recovery",
    content: "The UK missed-call recovery concept is an initial business testbed: help small businesses recover customers after missed inbound calls through future follow-up, conversation, qualification, persistence, and sale recovery. It is separate from Nova Brain and is not implemented yet.",
    provenance: "owner-provided-initial-context",
    privacy: "private",
    sensitivity: "business",
    status: "active"
  }
]);
