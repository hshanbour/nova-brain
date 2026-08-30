export const STT_SAMPLES = Object.freeze([
  { id: "stt-a", label: "Jordanian Arabic", locale: "ar-JO", text: "مرحبا، بدي أحجز موعد حلاقة يوم الخميس بعد العصر." },
  { id: "stt-b", label: "Arabic and English", locale: "ar-JO", text: "خلي Nova تتأكد من API على GitHub، وتراجع booking لزبون Sharp Cuts customer." },
  { id: "stt-c", label: "Numbers and dates", locale: "ar-JO", text: "السعر خمسة وثلاثين باوند £35، والموعد يوم 15 سبتمبر 2026 الساعة 6:30، ورقمي 079 123 4567." },
  { id: "stt-d", label: "English", locale: "en-GB", text: "Please summarise the missed-call recovery plan and list the next three actions." },
  { id: "stt-e", label: "Proper names", locale: "ar-JO", text: "أنا Mohammad من Luton، وبشتغل على Sharp Cuts وNova Brain." }
]);

export const TTS_SAMPLES = Object.freeze([
  { id: "tts-ar", label: "Arabic", locale: "ar-JO", text: "أهلاً محمد. نوفا جاهزة تساعدك، وبنقدر نكمل بالعربي الأردني بشكل طبيعي." },
  { id: "tts-en", label: "English", locale: "en-GB", text: "Hello Mohammad. Nova is ready, and I can help you plan the next practical step." },
  { id: "tts-mixed", label: "Mixed", locale: "ar-JO", text: "تمام محمد، خلينا نراجع Nova Brain والـ missed-call recovery plan خطوة بخطوة." }
]);

export const PROVIDERS = Object.freeze({
  stt: Object.freeze([
    { id: "openai", name: "OpenAI GPT-Transcribe", model: "gpt-transcribe", credential: "openai", usdPerMinute: 0.0045 },
    { id: "deepgram", name: "Deepgram Nova-3", model: "nova-3", credential: "deepgram", usdPerMinute: 0.0077 },
    { id: "azure", name: "Azure Speech STT", model: "ar-JO", credential: "azure", usdPerMinute: 0.03, pricingNote: "conservative planning allowance; Azure price varies by region/tier" }
  ]),
  tts: Object.freeze([
    { id: "elevenlabs", name: "ElevenLabs v3 Conversational", model: "eleven_v3_conversational", credential: "elevenlabs", usdPerThousandCharacters: 0.05 },
    { id: "openai", name: "OpenAI TTS", model: "gpt-4o-mini-tts", voice: "marin", credential: "openai", usdPerThousandCharacters: 0.04, pricingNote: "conservative reservation derived from token/audio pricing" },
    { id: "azure", name: "Azure neural TTS", model: "neural", voices: { "ar-JO": "ar-JO-SanaNeural", "en-GB": "en-GB-SoniaNeural" }, credential: "azure", usdPerThousandCharacters: 0.015, pricingNote: "planning rate; Azure price varies by region/tier" }
  ])
});

export function providerConfigured(config, provider) {
  const credentials = config.credentials;
  if (provider.credential === "openai") return Boolean(credentials.openai);
  if (provider.credential === "deepgram") return Boolean(credentials.deepgram);
  if (provider.credential === "elevenlabs") return Boolean(credentials.elevenlabs && credentials.elevenlabsVoiceId);
  if (provider.credential === "azure") return Boolean(credentials.azureKey && credentials.azureRegion);
  return false;
}

export function estimateCost({ kind, provider, durationSeconds = 0, text = "" }) {
  if (kind === "stt") return round6((Math.max(0, durationSeconds) / 60) * provider.usdPerMinute);
  return round6((String(text).length / 1000) * provider.usdPerThousandCharacters);
}

export function estimateFullBenchmark() {
  const stt = PROVIDERS.stt.reduce((sum, provider) => sum + estimateCost({ kind: "stt", provider, durationSeconds: 150 }), 0);
  const text = TTS_SAMPLES.map((sample) => sample.text).join("");
  const tts = PROVIDERS.tts.reduce((sum, provider) => sum + estimateCost({ kind: "tts", provider, text }), 0);
  return round6(stt + tts);
}

function round6(value) { return Math.round(value * 1e6) / 1e6; }
