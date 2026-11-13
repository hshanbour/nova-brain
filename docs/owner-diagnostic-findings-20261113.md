# Retained owner diagnostic — 13 November 2026

This is diagnostic evidence, not live conversational acceptance or channel calibration.

## Actual recording

The consented recording captured 24.001 seconds and decoded to 24.000 seconds,
with 13.47 seconds of RMS-detected speech and no clipping. The selected Intel
microphone array supplied 48 kHz mono with browser echo cancellation, noise
suppression and automatic gain enabled. The extractor was the existing Modal
ECAPA service, reporting `decode-mono-16k-rms-vad-v3-compat`.

Original and identical replay scores were exactly equal: VAD .365363 and full
waveform .379622. Browser-decoded 16 kHz mono PCM scored .371419/.381811.
Both 12-second halves passed the existing .35 threshold (.368535/.370332).
No diagnostic request issued an authorization assertion or changed enrollment.

## Controlled window comparison

All excerpts came from the same retained recording and used the same readable
September 19 enrollment, service and unchanged threshold:

| Start / length (seconds) | Detected speech | Best similarity | Result |
| --- | --- | --- | --- |
| 0 / 3.5 | 0 | — | insufficient speech |
| 4 / 3.5 | 2.53 | .235 | non-match |
| 8 / 3.5 | 2.40 | .317 | non-match |
| 12 / 3.5 | 2.56 | .286 | non-match |
| 16 / 3.5 | 2.20 | .364 | match |
| 20 / 3.5 | 1.51 | .401 | match |
| 0 / 8 | 3.21 | .342 | non-match |
| 12 / 8 | 5.69 | .357 | match |

This reproduces false rejection on shorter owner excerpts. It does not prove
duration is the sole cause: phonetic content and acoustic conditions vary.
The older failed 9.24-second recording contained 6.52 seconds of detected speech
but scored .293; its reported noise floor was materially higher. Its raw audio
was not retained, so an exact acoustic comparison is unavailable.

Capture truncation, codec failure and nondeterministic extraction were not
observed in the retained sample. Historical model artifact identity cannot be
proved solely from the service's version string.

## Profile discrepancy

The September 19 profile is readable and matched this recording as well as
historical successful sessions. The September 1 profile fails authenticated
decryption under the current binding and therefore does not participate.
Historical key-binding dates suggest different key provenance; missing original
key material prevents distinguishing that from damaged ciphertext. Neither
profile nor any key was modified. This unreadable record does not explain why
the same usable profile both accepts and rejects excerpts of the same recording.

## Bounded repair and limits

Initial private admission and clean recovery now collect a continuous 12-second
minimum window across VAD pauses, instead of 3.5 seconds. UI guidance reflects
that duration. Guest mode does not acquire this private verification requirement.
Later turns still require fresh matching and server authorization. A failed
recheck destroys the old private provider session before a single gated recovery;
no previous assertion or private context is reused. End Voice cancels collection.

This is a justified entry/recovery mitigation, not a completed solution for
short-turn continuous verification. False rejection during normal owner speech,
mixed-speaker robustness and final audible reply still need live acceptance.
Do not lower thresholds, accumulate trusted audio across unknown speakers or
silently replace the profile to make those checks pass.

97 focused automated tests passed after the repair, covering diagnostic expiry,
authorization, capture, short-window recovery, guest denial and stale replies.
These overlap earlier suites and are not microphone tests. No new memory or
interruption acceptance was established.

## Retention completion

After comparisons, Delete recording was invoked in the authenticated diagnostic
tab before its 21:10:06 UTC deadline. The UI verified that the temporary key and
ciphertext were discarded and replay was disabled. Only non-audio measurements
and a deletion screenshot were saved in local deliverables. No raw recording was
saved to disk, Git, database, analytics or a public URL. Service decoder temporary
files are deleted by the existing request cleanup. This is application-level
deletion, not a forensic claim about browser/OS memory or swap.
