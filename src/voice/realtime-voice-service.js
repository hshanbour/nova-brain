const OPENAI_REALTIME_CLIENT_SECRETS = "https://api.openai.com/v1/realtime/client_secrets";

export const REALTIME_VOICE_INSTRUCTIONS = `You are Nova, the owner's intelligent digital executive partner and the natural voice of the wider Nova AI Agent system. You are not a generic writing or translation assistant.
Speak naturally, warmly, and concisely in the user's English, natural Jordanian/Levantine Arabic, or mixed Arabic-English without asking them to choose a language. Keep one stable vocal character across languages; avoid stiff literal Arabic, excessive diacritics, theatrical stress, or unnecessary repetition.
You may directly handle greetings, conversational continuity, simple clarification, and questions about who Nova is or whether Nova is present. Never turn a question about your own identity into a statement about whether the speaker's identity was verified.
Call nova_turn exactly once for every request involving owner memory, project or business facts, current status, tools, research, recommendations based on private evidence, actions, approvals, commitments, or anything you cannot establish from these instructions and the current conversation. Nova Brain is authoritative for those matters. Never invent a capability, business fact, result, permission, or completed action.
When nova_turn is needed, you may give a very short natural acknowledgement while Nova Brain is working, but do not answer the substantive request until the tool result arrives. Then present that result faithfully in natural speech.
Yield immediately when the user interrupts. Do not claim the speaker is the owner unless Nova Brain explicitly reports a server-verified match. Do not volunteer an identity-verification disclaimer in ordinary conversation. Spoken approval never authorizes a consequential action.`;

export function createRealtimeVoiceService({ apiKey, fetchImpl = globalThis.fetch, model = "gpt-realtime-2.1", voice = "marin" } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("Realtime Voice requires fetch.");

  return Object.freeze({
    configured: Boolean(apiKey),
    model,
    voice,
    async createClientSecret({ safetyIdentifier, signal } = {}) {
      if (!apiKey) throw realtimeError("Realtime Voice is not configured.", "realtime_not_configured", 503);
      const response = await fetchImpl(OPENAI_REALTIME_CLIENT_SECRETS, {
        method: "POST",
        signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "OpenAI-Safety-Identifier": String(safetyIdentifier || "nova-owner").slice(0, 128),
        },
        body: JSON.stringify({
          expires_after: { anchor: "created_at", seconds: 60 },
          session: {
            type: "realtime",
            model,
            instructions: REALTIME_VOICE_INSTRUCTIONS,
            output_modalities: ["audio"],
            audio: {
              input: {
                transcription: { model: "gpt-transcribe" },
                turn_detection: {
                  type: "server_vad",
                  threshold: 0.5,
                  prefix_padding_ms: 300,
                  silence_duration_ms: 450,
                  create_response: true,
                  interrupt_response: true,
                },
              },
              output: { voice },
            },
            tools: [{
              type: "function",
              name: "nova_turn",
              description: "Ask the authoritative Nova Brain to handle the user's current turn, project context, tools, memory, permissions, and approvals.",
              parameters: {
                type: "object",
                properties: {
                  request: { type: "string", description: "The user's complete request, preserving their language and meaning." },
                },
                required: ["request"],
                additionalProperties: false,
              },
            }],
            tool_choice: "auto",
            max_output_tokens: 1200,
          },
        }),
      });
      const data = await safeJson(response);
      if (!response.ok || typeof data?.value !== "string" || !data.value.startsWith("ek_")) {
        throw realtimeError("OpenAI could not start a realtime voice session.", "realtime_session_failed", response.status || 502);
      }
      return Object.freeze({ clientSecret: data.value, expiresAt: data.expires_at || null, model, voice });
    },
  });
}

async function safeJson(response) {
  try { return await response.json(); }
  catch { return null; }
}

function realtimeError(message, code, statusCode) {
  return Object.assign(new Error(message), { code, statusCode });
}
