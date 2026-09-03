import { createSpeakerEngineResult } from "./speaker-engine.js";

// Disabled readiness adapter. A real Eagle runtime and Eagle-native profiles must
// be supplied explicitly before this can ever participate as a shadow engine.
export function createEagleShadowEngine({ accessKey = null, runtime = null, profileStore = null } = {}) {
  const configured = Boolean(accessKey && runtime && profileStore);
  return Object.freeze({
    id: "picovoice_eagle",
    version: runtime?.version || "unconfigured",
    authoritative: false,
    configured,
    async readiness() { return { available: configured, status: configured ? "ConfiguredShadow" : "Disabled", engineId: "picovoice_eagle" }; },
    async recognize() {
      if (!configured) return createSpeakerEngineResult({ engineId: "picovoice_eagle", engineVersion: "unconfigured", qualityState: "unavailable", status: "failure", error: { code: "not_configured", stage: "configuration" } });
      throw Object.assign(new Error("Eagle shadow runtime is not implemented."), { code: "adapter_skeleton" });
    }
  });
}
