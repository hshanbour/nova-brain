export function initialiseSpeakerEnrollment({ document, navigator, MediaRecorder, fetchImpl = fetch, now = Date.now } = {}) {
  const dialog = document.querySelector("#speakerEnrollmentDialog");
  const form = document.querySelector("#speakerEnrollmentForm");
  const button = document.querySelector("#speakerSampleButton");
  const submit = document.querySelector("#speakerEnrollSubmit");
  const status = document.querySelector("#speakerEnrollmentStatus");
  const existingProfiles = document.querySelector("#speakerExistingProfiles");
  const confirmations = [...document.querySelectorAll("[data-speaker-sample-confirmation]")];
  let samples = [];
  let recorder;
  let stream;
  let startedAt;
  let chunks = [];
  let pendingSample;
  let attempt = 0;
  let enrollmentController;

  const stopTracks = () => {
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
  };
  const updateConfirmations = () => confirmations.forEach((item, index) => {
    const confirmed = index < samples.length;
    item.textContent = `Sample ${index + 1}: ${confirmed ? "Confirmed" : "Not recorded"}`;
    item.dataset.confirmed = String(confirmed);
  });
  const reset = () => {
    attempt += 1;
    enrollmentController?.abort();
    enrollmentController = undefined;
    if (recorder?.state === "recording") recorder.stop();
    stopTracks();
    chunks = [];
    samples = [];
    pendingSample = undefined;
    recorder = undefined;
    button.disabled = false;
    button.textContent = "Start sample 1";
    submit.disabled = true;
    updateConfirmations();
    status.textContent = "Nothing is recorded until you explicitly start and stop each sample.";
  };
  const cancel = () => {
    reset();
    form.reset();
    dialog.hidden = true;
  };
  const refreshProfiles = async () => {
    existingProfiles.replaceChildren();
    try {
      const body = await fetchImpl("/api/speakers").then((value) => value.json());
      for (const profile of body?.speakers || []) {
        const row = document.createElement("div");
        const label = document.createElement("span");
        const remove = document.createElement("button");
        label.textContent = `Existing encrypted voiceprint: ${profile.displayName}`;
        remove.type = "button";
        remove.className = "secondary-button";
        remove.textContent = `Delete ${profile.displayName} voiceprint`;
        remove.addEventListener("click", async () => {
          if (!document.defaultView?.confirm?.(`Permanently delete the ${profile.displayName} speaker profile and encrypted voiceprint?`)) return;
          remove.disabled = true;
          const response = await fetchImpl(`/api/speakers/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
          if (!response.ok) { remove.disabled = false; status.textContent = "The existing voiceprint could not be deleted."; return; }
          await refreshProfiles();
          status.textContent = "Existing speaker profile and encrypted voiceprint permanently deleted.";
        });
        row.append(label, remove);
        existingProfiles.append(row);
      }
    } catch {
      existingProfiles.textContent = "Existing speaker profiles could not be loaded.";
    }
  };

  document.querySelector("#speakerEnrollmentButton").addEventListener("click", async () => {
    reset();
    dialog.hidden = false;
    await refreshProfiles();
    try {
      const ready = await fetchImpl("/api/voice/readiness").then((value) => value.json());
      if (!ready?.speakerRecognition?.available) {
        button.disabled = true;
        status.textContent = "Speaker recognition worker is not configured in this Preview yet.";
      }
    } catch {
      button.disabled = true;
      status.textContent = "Speaker recognition readiness could not be verified.";
    }
  });
  document.querySelectorAll("[data-close-speaker-enrollment]").forEach((item) => item.addEventListener("click", cancel));

  button.addEventListener("click", async () => {
    if (recorder?.state === "recording") {
      recorder.stop();
      return;
    }
    if (pendingSample) {
      const sampleNumber = samples.length + 1;
      samples.push(pendingSample);
      pendingSample = undefined;
      updateConfirmations();
      button.textContent = samples.length === 3 ? "All three samples confirmed" : `Start sample ${samples.length + 1}`;
      button.disabled = samples.length === 3;
      submit.disabled = samples.length !== 3;
      status.textContent = `Sample ${sampleNumber} confirmed by you. ${samples.length === 3 ? "All three samples are ready for enrollment." : `Click Start sample ${samples.length + 1} only when you are ready.`}`;
      return;
    }
    if (samples.length >= 3) return;
    const sampleNumber = samples.length + 1;
    const currentAttempt = attempt;
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    recorder = new MediaRecorder(stream, {
      mimeType: MediaRecorder.isTypeSupported?.("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm",
      audioBitsPerSecond: 64000
    });
    startedAt = now();
    recorder.addEventListener("dataavailable", (event) => { if (event.data.size) chunks.push(event.data); });
    recorder.addEventListener("stop", async () => {
      const durationSeconds = (now() - startedAt) / 1000;
      stopTracks();
      if (currentAttempt !== attempt) { chunks = []; return; }
      if (durationSeconds < 2) {
        chunks = [];
        button.textContent = `Start sample ${sampleNumber}`;
        status.textContent = `Sample ${sampleNumber} was discarded because it was too short. Click Start sample ${sampleNumber} to try again.`;
        return;
      }
      const blob = new Blob(chunks, { type: recorder.mimeType });
      chunks = [];
      pendingSample = { audioBase64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())), mimeType: blob.type, durationSeconds };
      recorder = undefined;
      button.textContent = `Confirm sample ${sampleNumber}`;
      button.disabled = false;
      submit.disabled = true;
      status.textContent = `Sample ${sampleNumber} stopped. It is not accepted yet. Click Confirm sample ${sampleNumber} to accept it, or Cancel to discard the attempt.`;
    });
    recorder.start(100);
    button.textContent = `Stop sample ${sampleNumber}`;
    status.textContent = `Recording sample ${sampleNumber}… click Stop sample ${sampleNumber} when you finish speaking.`;
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (samples.length !== 3 || !form.elements.consent.checked) return;
    enrollmentController = new AbortController();
    submit.disabled = true;
    button.disabled = true;
    status.textContent = "Deriving and encrypting voiceprint… Cancel discards this attempt.";
    try {
      const response = await fetchImpl("/api/speakers/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: form.elements.displayName.value, relation: form.elements.relation.value, scope: "household", consent: true, consentActor: form.elements.displayName.value, samples }),
        signal: enrollmentController.signal
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || "Enrollment failed.");
      samples = [];
      chunks = [];
      updateConfirmations();
      status.textContent = `${body.speaker.displayName} enrolled. Raw samples discarded.`;
      setTimeout(() => { dialog.hidden = true; form.reset(); reset(); }, 1200);
    } catch (error) {
      if (error?.name === "AbortError") return;
      status.textContent = error.message || "Enrollment failed safely.";
      submit.disabled = samples.length !== 3;
      button.disabled = samples.length === 3;
    } finally {
      enrollmentController = undefined;
    }
  });
  return { reset, cancel };
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}
