# Wake-word setup

Jarvis uses openWakeWord locally through ONNX Runtime. There is no account, cloud service,
company email, access key, Python runtime, or separate wake-word installation.

Run `npm run fetch-models` from source, or click **download voice models** in Settings. This
downloads the pinned mel-spectrogram, speech-embedding, and `hey_jarvis` classifier models into
the Jarvis model directory. The wake phrase is **"Hey Jarvis"**.

Sensitivity is adjustable in Settings → Voice. The default `0.6` maps to openWakeWord's `0.5`
score threshold. Raise sensitivity if Jarvis misses the phrase; lower it if ordinary speech
causes false triggers.

For a live microphone check:

```powershell
npx tsx scripts/smoke/smoke-wakeword.ts
```

The pretrained model is licensed CC BY-NC-SA 4.0, which is appropriate for this noncommercial
private beta. A commercial release must use a separately trained or commercially licensed model.
