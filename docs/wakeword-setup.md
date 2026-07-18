# Training a custom wake word

Jarvis ships with the built-in Porcupine keyword **"Jarvis"**. If you rename the assistant in
Settings, the built-in keyword does **not** follow the new name — Porcupine only recognises the
exact keyword model it was given. To make the wake word match a custom name, train a free custom
keyword (`.ppn`) on the Picovoice Console and point Jarvis at it.

## Steps

1. Go to the Picovoice Console: <https://console.picovoice.ai/> and sign in (the same free
   account that gives you the access key).
2. Open **Porcupine** → **Create Wake Word**.
3. Type the phrase you want (e.g. your assistant's new name), choose **Windows (x86_64)** as the
   platform, and **Train**. Training takes a minute or two.
4. Download the resulting `.ppn` file.
5. In Jarvis: **Settings → Voice → Custom wake word**, click **Choose .ppn** and select the file
   you downloaded.

That's it — say the new wake word and the overlay should light up.

## Notes

- The **access key** and the **keyword file** both come from the same free Picovoice account.
- Custom `.ppn` files are tied to a platform; use the **Windows (x86_64)** build.
- Picovoice's free tier is subject to their terms; see
  <https://picovoice.ai/docs/terms-of-use/>.
- If you keep the default name "Jarvis", no custom keyword is needed — the built-in keyword works
  out of the box once the access key is set.
