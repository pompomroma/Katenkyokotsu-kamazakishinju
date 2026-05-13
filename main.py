"""
VISION  -  E.D.I.T.H.-inspired AR assistant backend.

A thin Flask proxy that bridges the in-browser HUD to NVIDIA's NIM API
(OpenAI-compatible) at https://integrate.api.nvidia.com/v1.

Set TEXT_API_KEY and VISUAL_API_KEY in the Replit "Secrets" panel before
running.  Both keys are NVIDIA `nvapi-...` keys from build.nvidia.com -
they may point at the same key or two separate ones.
"""

import os
import json
import logging
import time
import requests
from flask import Flask, render_template, request, jsonify

app = Flask(__name__, static_folder="static", template_folder="templates")
logging.basicConfig(level=logging.INFO)
log = logging.getLogger("vision")

TEXT_API_KEY = os.environ.get("TEXT_API_KEY", "").strip()
VISUAL_API_KEY = os.environ.get("VISUAL_API_KEY", "").strip()
NVIDIA_API_BASE = os.environ.get("NVIDIA_API_BASE",
                                 "https://integrate.api.nvidia.com/v1").rstrip("/")

# Free-tier, OpenAI-compatible NVIDIA NIM models (build.nvidia.com catalog).
# These were chosen because Meta's Llama 3.x line is the most stable family
# on the catalog; even when individual point versions rotate, the 3.x series
# remains addressable.  No replacement is expected to be needed.
TEXT_MODEL = os.environ.get("VISION_TEXT_MODEL",  "meta/llama-3.3-70b-instruct")
VISION_MODEL = os.environ.get("VISION_VISION_MODEL", "meta/llama-3.2-11b-vision-instruct")

SYSTEM_PROMPT = (
    "You are VISION, an AI assistant integrated into augmented-reality glasses, "
    "inspired by E.D.I.T.H.  You are intelligent, calm, witty, and helpful. "
    "Keep replies short and conversational - 1 to 3 sentences is ideal because "
    "your output is spoken aloud through the glasses.  Occasionally address the "
    "user as 'sir', 'commander', or by their name if known.  You can see what "
    "the user sees through the camera and respond to voice commands.  Avoid "
    "markdown, headings, lists, or emoji in your replies because the user "
    "hears them rather than reads them."
)


def _nvidia_post(payload, api_key, key_name, timeout=60):
    if not api_key:
        return None, (f"{key_name} is not set on the server. "
                      "Add it under Replit > Tools > Secrets.")
    try:
        r = requests.post(
            f"{NVIDIA_API_BASE}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=timeout,
        )
    except requests.RequestException as exc:
        return None, f"network error contacting NVIDIA NIM: {exc}"

    if r.status_code >= 400:
        try:
            detail = r.json()
        except Exception:
            detail = r.text[:400]
        return None, f"NIM responded {r.status_code}: {detail}"
    try:
        data = r.json()
        return data["choices"][0]["message"]["content"].strip(), None
    except (KeyError, IndexError, ValueError) as exc:
        return None, f"unexpected NIM response shape: {exc}"


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/health")
def health():
    return jsonify({
        "ok": True,
        "text_key_set": bool(TEXT_API_KEY),
        "visual_key_set": bool(VISUAL_API_KEY),
        "text_model": TEXT_MODEL,
        "vision_model": VISION_MODEL,
    })


@app.route("/api/chat", methods=["POST"])
def chat():
    data = request.get_json(silent=True) or {}
    msg = (data.get("message") or "").strip()
    history = data.get("history") or []
    if not msg:
        return jsonify({"error": "empty message"}), 400

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    for turn in history[-10:]:
        if isinstance(turn, dict) and turn.get("role") in ("user", "assistant"):
            messages.append({"role": turn["role"],
                             "content": str(turn.get("content", ""))[:1500]})
    messages.append({"role": "user", "content": msg})

    reply, err = _nvidia_post({
        "model": TEXT_MODEL,
        "messages": messages,
        "temperature": 0.6,
        "top_p": 0.9,
        "max_tokens": 320,
        "stream": False,
    }, TEXT_API_KEY, "TEXT_API_KEY", timeout=45)
    if err:
        log.warning("chat error: %s", err)
        return jsonify({"error": err}), 502
    return jsonify({"reply": reply})


@app.route("/api/vision", methods=["POST"])
def vision():
    """Mode: 'describe' | 'scan' | 'locate'."""
    data = request.get_json(silent=True) or {}
    image_b64 = (data.get("image") or "").strip()
    prompt = (data.get("prompt") or "").strip()
    mode = (data.get("mode") or "describe").lower()
    if not image_b64:
        return jsonify({"error": "no image provided"}), 400

    if image_b64.startswith("data:"):
        image_b64 = image_b64.split(",", 1)[1]

    if mode == "scan":
        instruction = (
            "You are scanning an object through AR glasses.  The user asked "
            f"about: '{prompt or 'the object in front of me'}'.  Identify the "
            "product/object in the image that most closely matches that "
            "request.  Reply ONLY in this exact line format, no extra prose:\n"
            "NAME: <short name>\n"
            "BRAND: <brand or 'unknown'>\n"
            "CATEGORY: <category>\n"
            "ESTIMATED PRICE: <approx market price in USD, or 'unknown'>\n"
            "KEY FEATURES: <three short comma-separated features>\n"
            "NOTES: <one short sentence>\n"
            "If a field is uncertain say 'unknown'."
        )
    elif mode == "locate":
        instruction = (
            f"Locate '{prompt}' in the image.  Reply with ONLY a single JSON "
            "object on one line: "
            '{"found": true|false, "x": 0..1, "y": 0..1, '
            '"label": "short name", "note": "one short sentence"}. '
            "x and y are normalized image coordinates of the target's center "
            "(0=left/top, 1=right/bottom).  If the target is not in view, "
            'set "found" to false and other fields to null.'
        )
    else:
        instruction = prompt or "Describe what you see in one sentence."

    payload = {
        "model": VISION_MODEL,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": instruction},
                {"type": "image_url",
                 "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
            ],
        }],
        "temperature": 0.2,
        "top_p": 0.9,
        "max_tokens": 400,
        "stream": False,
    }
    reply, err = _nvidia_post(payload, VISUAL_API_KEY, "VISUAL_API_KEY", timeout=75)
    if err:
        log.warning("vision error: %s", err)
        return jsonify({"error": err}), 502
    return jsonify({"reply": reply, "mode": mode})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    log.info("VISION starting on 0.0.0.0:%d  (text key: %s, visual key: %s)",
             port, bool(TEXT_API_KEY), bool(VISUAL_API_KEY))
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
