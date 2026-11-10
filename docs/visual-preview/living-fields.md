# Living field comparison — 2026-11-10

Preview entry: `?avatar=current-glass&scene=tides#chat`.

Visual-only changes: Tidal Currents (three depth layers of rolling particle sheets), Aurora Weave (tall folding curtains), and an entrance sampled from the existing display GLB triangles. Model files and embedded textures remain unchanged. Existing scene options remain available.

The avatar adapter reads the existing `createGlassSignal` contract. The voice controller alone owns sessions, microphone, playback and interruption. Scene selection changes a renderer input and does not recreate either controller. A session false→true edge requests one entrance; Replay Entrance only increments the visual entrance counter.

No-microphone demos are separate from live Voice Mode. Listening is a labelled synthetic level. Speaking plays the existing `artifacts/gpt-live-voice-samples/nova-gpt-live-marin-pcmu8k.wav` sample through Web Audio and measures the audible output. The copy skips its first four silent seconds at playback. Live session activation cancels a pending sample and disables demo controls. End/interruption clears travelling pulses. These tests do not verify real microphone barge-in or any conversational behaviour.

GPU field: 19,200 fixed points with shader motion. Entrance: 8,500 area-weighted samples of actual transformed GLB geometry. Existing 30 FPS cap and adaptive pixel ratio remain. Phone framing backs the camera away slightly to retain shoulders during rotation.

Local Edge inspection: desktop 1440×900 and phone-sized 390×844; foreground observations approximately 18–24 FPS. This is viewport emulation on the laptop, not a physical-phone benchmark. Recorded sample produced nonzero measured audio (peak visual envelope ~0.94) and travelling waves. Need owner evaluation on actual phone and a later live microphone test. No voice provider, memory, permissions, business integration or Production changes.
