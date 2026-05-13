# VISION

An **E.D.I.T.H.-style augmented-reality assistant** that runs on your phone
through the browser.  Point your phone at the world (rear camera), hear it
respond through your earbuds, and you have a wearable AR HUD in your hand
or in a $5 Cardboard headset.

```
┌─ V·I·S·I·O·N ─────────────────────────── 00:00:00 ─┐
│  MIC  CAM  NET  AI                                 │
│                                                    │
│           ┌───┐                                    │
│        ── │ + │ ──     ◉ LOCKED: PERSON   91%      │
│           └───┘                                    │
│                       VISION OUTPUT  ─────────     │
│                       Standing by, sir.            │
│                                                    │
│           ▼  "scan the bottle on the desk"         │
│           ▶ SCAN  🎤 MUTE  ⊕ LISTEN                │
└────────────────────────────────────────────────────┘
```

---

## What it can do

| Voice command                                  | What happens                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| anything conversational                        | Routed to NVIDIA NIM chat - replies are spoken out loud                                       |
| `open google and search up <something>`        | Pops up a small translucent web pane with the search; if the engine blocks iframing it mirrors via DuckDuckGo |
| `open duckduckgo / bing / wikipedia / youtube` | Same as above for the named engine                                                            |
| `close web`                                    | Slides the web pane down off-screen                                                           |
| `scan <the thing you describe>`                | Snapshots the camera, sends it to the vision model, shows BRAND / PRICE / FEATURES, and reads the headline aloud |
| `aim at <object>` / `find <object>`            | Moves the scope reticle onto the target and tracks it live (real-time on-device tracker for common objects, vision-model fallback for anything else) |
| `stop aiming`                                  | Clears the target lock                                                                        |
| **anything spoken while the AI is talking**    | Interrupts the AI mid-sentence and starts processing your new request                         |

---

## Recommended NVIDIA API keys (2026)

Get your key for free from **<https://build.nvidia.com/>** - click any model,
then **Get API Key**.  A personal NVIDIA developer account gives you the
free-tier key (`nvapi-...`) at no cost.

The two models VISION talks to (and *why* these specifically):

| Slot   | Model ID                            | Why this one                                                    |
| ------ | ----------------------------------- | --------------------------------------------------------------- |
| Chat   | `meta/llama-3.3-70b-instruct`       | Free on the NIM catalog, OpenAI-compatible, Meta's long-life Llama-3.x family - no sunset planned |
| Vision | `meta/llama-3.2-11b-vision-instruct`| Free on the NIM catalog, image+text in one call, lightweight enough to be very fast |

Both are in the **free** tier of the public NVIDIA NIM catalogue, so as long
as your account is a regular developer account they cost **0 credits per
call**.  Because they are part of the Llama-3.x family - the most widely
adopted line on the catalogue - they are the least likely to be deprecated;
even if a point version (e.g. `3.2-11b`) rotates, the same name pattern
remains addressable.

If for any reason a model is removed in the future, you can swap models
without touching the code by setting the two environment variables
`VISION_TEXT_MODEL` and `VISION_VISION_MODEL` in Replit Secrets.

---

## Running it on Replit

1. Create an empty Replit  →  **Import from GitHub** (or paste the files
   manually).  The included `.replit` and `replit.nix` make Replit detect it
   automatically; just press **Run** once and the deps install.
2. Open **Tools  →  Secrets** and add:
   * `TEXT_API_KEY`   = `nvapi-...` (key from build.nvidia.com - used for the chat model)
   * `VISUAL_API_KEY` = `nvapi-...` (key from build.nvidia.com - used for the vision model)

   Both can be the **same** `nvapi-...` key from a single NVIDIA developer
   account, or two separate keys if you want to split chat vs vision usage
   across different accounts.
3. Press **Run**.  A web URL is shown.
4. On your **phone**, open that URL in **Chrome (Android)** or **Safari
   (iOS 16+)**.  Tap *Activate*, allow camera and microphone, put your phone
   in a cheap Cardboard / VR-style headset, plug in earbuds.

That is it - say "Vision, what do you see?" or "scan the can in front of
me" and you have an AR assistant.

> The browser must serve over HTTPS for the camera and microphone to work.
> Replit's `*.replit.dev` URL already is HTTPS, so this is automatic.

---

## File layout

```
main.py                     Flask backend; thin proxy to NVIDIA NIM
templates/index.html        The HUD page
static/css/style.css        Holographic styling
static/js/app.js            Voice, camera, commands, tracking, web pane
requirements.txt            flask + requests
.replit / replit.nix        Replit run config
.env.example                What env vars to set
```

---

## Privacy

Camera frames are sent to NVIDIA only when you say **scan** or **aim at**,
and only one frame at a time.  Voice is processed by the browser's built-in
Web Speech API - it never reaches our backend.  The only thing the server
forwards is the text transcript / one snapshot per request.
