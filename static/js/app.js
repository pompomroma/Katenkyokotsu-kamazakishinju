/* ============================================================
   VISION  -  AR-glasses HUD client
   ============================================================ */
(() => {
"use strict";

/* ------------------------------------------------------------
   1.  Configuration
   ------------------------------------------------------------ */

/* Search engines that allow being iframed.  Engines that block
   embedding (Google, YouTube) silently fall back to DuckDuckGo
   so the holo-pane never shows a blank refusal page.            */
const BROWSERS = {
  duckduckgo: { url: "https://duckduckgo.com/?kae=d&q=",                 embeds: true  },
  bing:       { url: "https://www.bing.com/search?q=",                   embeds: true  },
  wikipedia:  { url: "https://en.wikipedia.org/wiki/Special:Search?search=", embeds: true },
  startpage:  { url: "https://www.startpage.com/do/search?q=",           embeds: true  },
  google:     { url: "https://www.google.com/search?igu=1&q=",           embeds: false },
  youtube:    { url: "https://www.youtube.com/results?search_query=",    embeds: false },
  github:     { url: "https://github.com/search?q=",                     embeds: false },
  reddit:     { url: "https://www.reddit.com/search/?q=",                embeds: false },
  "stack overflow": { url: "https://stackoverflow.com/search?q=",        embeds: false },
  stackoverflow:    { url: "https://stackoverflow.com/search?q=",        embeds: false },
};
const BROWSER_ALIAS = {
  "duck duck go": "duckduckgo",
  "ddg": "duckduckgo",
  "stack overflow": "stackoverflow",
  "yt": "youtube",
};
const FALLBACK = BROWSERS.duckduckgo;

/* COCO-SSD synonyms - so "phone", "mobile" all map to "cell phone" */
const SYN = {
  phone: "cell phone", mobile: "cell phone", cellphone: "cell phone", iphone: "cell phone",
  laptop: "laptop", computer: "laptop", notebook: "laptop", macbook: "laptop",
  cup: "cup", mug: "cup", bottle: "bottle", drink: "bottle", water: "bottle",
  person: "person", human: "person", man: "person", woman: "person",
  guy: "person", lady: "person", people: "person", face: "person", me: "person",
  dog: "dog", puppy: "dog", cat: "cat", kitten: "cat", bird: "bird",
  car: "car", vehicle: "car", truck: "truck", bus: "bus", motorbike: "motorcycle",
  motorcycle: "motorcycle", bike: "bicycle", bicycle: "bicycle",
  chair: "chair", seat: "chair", couch: "couch", sofa: "couch", bed: "bed",
  tv: "tv", television: "tv", screen: "tv", monitor: "tv",
  book: "book", remote: "remote", keyboard: "keyboard", mouse: "mouse",
  apple: "apple", banana: "banana", orange: "orange", food: "sandwich",
  sandwich: "sandwich", pizza: "pizza", cake: "cake", donut: "donut",
  bag: "handbag", backpack: "backpack", purse: "handbag", suitcase: "suitcase",
  ball: "sports ball", umbrella: "umbrella", tie: "tie",
  toothbrush: "toothbrush", scissors: "scissors", clock: "clock",
  vase: "vase", plant: "potted plant", flower: "potted plant",
};

/* ------------------------------------------------------------
   2.  State + DOM shortcuts
   ------------------------------------------------------------ */
const state = {
  booted:    false,
  listening: false,
  speaking:  false,
  muted:     false,
  history:   [],
  aiming:    null,
  tfModel:   null,
  loop:      null,
  busy:      false,
  lastUserUtterance: 0,
  /* article-capture state */
  article:        null,   // { title, byline, date, blocks[], pages, continues }
  articlePdfBlob: null,
  articlePdfStale: true,
  articleFile:    null,   // last filename used
};

const $ = (id) => document.getElementById(id);
const video    = $("cam");
const canvas   = $("snap");
const ctx      = canvas.getContext("2d");
const reticle  = $("reticle");
const retLbl   = $("ret-label");
const retRng   = $("ret-range");

/* ------------------------------------------------------------
   3.  Small helpers
   ------------------------------------------------------------ */
function setStatus(id, on, label) {
  const el = $(id);
  if (!el) return;
  el.classList.remove("live", "off");
  el.classList.add(on ? "live" : "off");
  if (label) el.textContent = label;
}
function showResponse(t) { $("response-text").textContent = t; }
function showTranscript(t, hearing) {
  $("trans-text").textContent = t || "Awaiting voice input...";
  $("transcript").classList.toggle("hearing", !!hearing);
}

/* ------------------------------------------------------------
   4.  Camera
   ------------------------------------------------------------ */
async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("cam-status", false, "CAM✕");
    showResponse("This browser cannot access the camera. Use Chrome or Safari over HTTPS.");
    return false;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width:  { ideal: 1280 },
        height: { ideal: 720  },
      },
      audio: false,
    });
    video.srcObject = stream;
    await new Promise(r => { video.onloadedmetadata = r; });
    await video.play().catch(() => {});
    setStatus("cam-status", true, "CAM");
    return true;
  } catch (err) {
    console.warn("camera error", err);
    setStatus("cam-status", false, "CAM✕");
    showResponse("Camera blocked. Tap the lock icon in the address bar and allow camera + microphone.");
    return false;
  }
}

function snapshot(maxW = 768, quality = 0.72) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const scale = Math.min(1, maxW / vw);
  canvas.width  = Math.round(vw * scale);
  canvas.height = Math.round(vh * scale);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

/* ------------------------------------------------------------
   5.  Speech synthesis (interruptible)
   ------------------------------------------------------------ */
let cachedVoice = null;
function pickVoice() {
  if (cachedVoice) return cachedVoice;
  const v = speechSynthesis.getVoices();
  if (!v.length) return null;
  cachedVoice =
    v.find(x => /(google uk english male|daniel|alex|en-gb.*male)/i.test(x.name + x.lang)) ||
    v.find(x => /en-gb/i.test(x.lang)) ||
    v.find(x => /en-us/i.test(x.lang)) ||
    v.find(x => /^en/i.test(x.lang)) ||
    v[0];
  return cachedVoice;
}
if ("speechSynthesis" in window) {
  speechSynthesis.onvoiceschanged = () => { cachedVoice = null; pickVoice(); };
  pickVoice();
}

function speak(text, onEnd) {
  if (!text || state.muted || !("speechSynthesis" in window)) {
    if (onEnd) onEnd(); return;
  }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate   = 1.04;
  u.pitch  = 0.95;
  u.volume = 1.0;
  const v = pickVoice();
  if (v) u.voice = v;
  u.onstart = () => { state.speaking = true; };
  u.onend   = () => { state.speaking = false; if (onEnd) onEnd(); };
  u.onerror = () => { state.speaking = false; if (onEnd) onEnd(); };
  /* Chrome bug: long utterances cut off after ~15 s.  Re-prime. */
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
function stopSpeaking() {
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  state.speaking = false;
}

/* ------------------------------------------------------------
   6.  Speech recognition (continuous, with TTS interruption)
   ------------------------------------------------------------ */
let rec = null;
function initRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    showResponse("Voice recognition isn't supported in this browser. Use Chrome on Android or Safari on iOS 16+.");
    return null;
  }
  const r = new SR();
  r.continuous     = true;
  r.interimResults = true;
  r.lang           = "en-US";
  r.maxAlternatives = 1;

  let finalBuf = "";
  let processTimer = null;

  r.onresult = (ev) => {
    let interim = "", finalText = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const res = ev.results[i];
      if (res.isFinal) finalText += res[0].transcript;
      else interim += res[0].transcript;
    }

    /* ----- VOICE INTERRUPTION -----
       If the AI is currently speaking and the user begins to talk,
       cut TTS immediately so they can issue a new request.        */
    const heard = (interim.trim().length > 2) || (finalText.trim().length > 0);
    if (heard && state.speaking) stopSpeaking();
    showTranscript((finalBuf + " " + finalText + " " + interim).trim(), heard);

    if (finalText) {
      finalBuf += " " + finalText;
      clearTimeout(processTimer);
      processTimer = setTimeout(() => {
        const utt = finalBuf.trim();
        finalBuf = "";
        if (utt) handleUtterance(utt);
      }, 650);
    }
  };

  r.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      setStatus("mic-status", false, "MIC✕");
      showResponse("Microphone blocked. Allow microphone access in the browser site settings.");
      state.listening = false;
    }
    /* "no-speech" / "audio-capture" / "aborted" - silently restart */
  };

  r.onend = () => {
    if (state.listening) {
      setTimeout(() => { try { r.start(); } catch (_) {} }, 200);
    }
  };

  return r;
}
function startListening() {
  if (!rec) rec = initRecognition();
  if (!rec) return;
  state.listening = true;
  try { rec.start(); setStatus("mic-status", true, "MIC"); } catch (_) {}
}
function stopListening() {
  state.listening = false;
  if (rec) { try { rec.stop(); } catch (_) {} }
  setStatus("mic-status", false, "MIC✕");
}

/* ------------------------------------------------------------
   7.  Command parser  -  voice utterances --> actions
   ------------------------------------------------------------ */
function handleUtterance(text) {
  state.lastUserUtterance = Date.now();
  const utt = text.toLowerCase().trim();
  if (!utt) return;

  /* ---- CLOSE WEB ---- */
  if (/\b(close|hide|dismiss|shut|kill|slide\s+down)\s+(the\s+)?(web|browser|tab|page|window|search|pane)\b/.test(utt) ||
      /^(close|hide)\s+(it|that)$/.test(utt)) {
    closeBrowser();
    reply("Closing.", true);
    return;
  }

  /* ---- OPEN <browser> [query] ---- */
  const openRe = /\bopen\s+(duck\s*duck\s*go|stack\s*overflow|google|bing|wikipedia|youtube|github|reddit|startpage|ddg)\b[\s,]*(?:(?:and\s+)?(?:search(?:\s+(?:for|up))?|look\s+up|find|tell\s+me\s+about)\s+)?(.*)$/i;
  const m = utt.match(openRe);
  if (m) {
    let name = m[1].replace(/\s+/g, " ").trim();
    name = BROWSER_ALIAS[name] || name.replace(/\s+/g, "");
    if (name === "duckduckgo" || name === "ddg") name = "duckduckgo";
    const query = (m[2] || "").replace(/^(please|now|for me|about)\s+/, "").trim();
    openBrowser(name, query);
    reply(query
      ? `Opening ${m[1]} for ${query}.`
      : `Opening ${m[1]}.`, true);
    return;
  }

  /* ---- ARTICLE CAPTURE (must come before generic SCAN) ---- */
  if (/\b(scan|capture|read|copy|grab|photocopy)\s+(?:the\s+|this\s+|that\s+|an?\s+)?(?:article|page|document|paper|text|column|story)\b/.test(utt) ||
      /\b(start|begin)\s+(?:an?\s+)?article(?:\s+capture)?\b/.test(utt) ||
      /\b(ocr|transcribe)\b/.test(utt)) {
    startArticleScan();
    return;
  }
  if (state.article && /\b(next\s+page|another\s+page|add\s+page|capture\s+(?:the\s+)?next|next\s+section|continue\s+article|more\s+text)\b/.test(utt)) {
    captureArticlePage();
    return;
  }
  if (state.article && /\b(save|finish|compile|build|generate|make|create|end|stop|done\s+with)\s+(?:the\s+|my\s+)?(?:article|pdf|capture)\b/.test(utt)) {
    finishArticle();
    return;
  }
  if (/\b(download|export|give\s+me|send\s+me|save\s+to\s+(?:my\s+)?(?:phone|device))\s+(?:the\s+|my\s+)?(?:article|pdf|file|capture)\b/.test(utt) ||
      /\b(download|export)\s+(?:it|that)\b/.test(utt)) {
    downloadArticle();
    return;
  }
  if (state.article && /\b(discard|cancel|throw\s+away|delete|trash)\s+(?:the\s+|my\s+)?article\b/.test(utt)) {
    discardArticle();
    reply("Article discarded.", true);
    return;
  }

  /* ---- SCAN <object> ---- */
  const scanRe = /\b(scan|analy[sz]e|identify|tell\s+me\s+about|what'?s|what\s+is)\b\s*(?:the\s+|that\s+|this\s+|a\s+|an\s+)?(.*)$/i;
  const sm = utt.match(scanRe);
  if (sm && /^(scan|analy[sz]e|identify)/.test(utt)) {
    const target = (sm[2] || "").trim() || "the object in the centre of view";
    doScan(target);
    return;
  }
  if (/^(scan|analy[sz]e)\b/.test(utt)) {
    doScan("the object in the centre of view");
    return;
  }

  /* ---- AIM / FIND / LOCATE / POINT AT ---- */
  const aimRe = /\b(aim|point|target|find|locate|spot|track|where(?:'s|\s+is))\b\s*(?:at\s+|on\s+|the\s+|a\s+|an\s+)*(.*)$/i;
  const am = utt.match(aimRe);
  if (am) {
    const what = (am[2] || "")
      .replace(/\b(please|now|for me|over there|around here)\b/g, "")
      .trim();
    if (what.length > 1) {
      startAiming(what);
      return;
    }
  }

  /* ---- STOP AIMING ---- */
  if (/\b(stop\s+(aiming|targeting|tracking)|clear\s+target|release\s+target|disengage|stand\s+down)\b/.test(utt)) {
    stopAiming();
    reply("Target released.", true);
    return;
  }

  /* ---- MUTE / UNMUTE ---- */
  if (/\b(mute|be\s+quiet|silence)\b/.test(utt)) { setMuted(true);  reply("Muted.", false); return; }
  if (/\b(unmute|speak\s+again)\b/.test(utt))    { setMuted(false); reply("Voice restored.", true); return; }

  /* ---- everything else: general chat ---- */
  chatWithAI(text);
}

/* ------------------------------------------------------------
   8.  Browser overlay
   ------------------------------------------------------------ */
function openBrowser(name, query) {
  const entry = BROWSERS[name] || BROWSERS[BROWSER_ALIAS[name]] || null;
  const useFallback = !entry || !entry.embeds;
  const target = useFallback ? FALLBACK : entry;
  const url = target.url + encodeURIComponent(query || "");

  $("browser-title").textContent =
    name.toUpperCase() + (query ? "  ▸  " + query : "");
  $("browser-foot").textContent = useFallback
    ? `${name} blocks embedding - mirrored via DuckDuckGo`
    : `${name} · translucent web pane`;
  $("browser-frame").src = url;

  const pane = $("browser-pane");
  pane.classList.remove("closing", "hidden");
}
function closeBrowser() {
  const pane = $("browser-pane");
  if (pane.classList.contains("hidden")) return;
  pane.classList.add("closing");
  setTimeout(() => {
    pane.classList.add("hidden");
    pane.classList.remove("closing");
    $("browser-frame").src = "about:blank";
  }, 420);
}
$("browser-close").addEventListener("click", closeBrowser);

/* ------------------------------------------------------------
   9.  SCAN command  -  snapshot --> /api/vision (mode=scan)
   ------------------------------------------------------------ */
async function doScan(target) {
  if (state.busy) return;
  const img = snapshot();
  if (!img) { reply("Camera not ready.", true); return; }

  state.busy = true;
  setStatus("ai-status", true, "AI*");
  reply(`Scanning ${target}...`, true);
  $("scan-flash").classList.remove("active");
  void $("scan-flash").offsetWidth;     // restart animation
  $("scan-flash").classList.add("active");

  try {
    const r = await fetch("/api/vision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: img, prompt: target, mode: "scan" }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    showScanResult(j.reply);

    /* read out the NAME and price for the user */
    const lines = j.reply.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const get = (k) => (lines.find(l => l.toUpperCase().startsWith(k)) || "").replace(/^[^:]+:\s*/, "");
    const name  = get("NAME") || "object";
    const brand = get("BRAND");
    const price = get("ESTIMATED PRICE") || get("PRICE");
    let say = `Scan complete. ${name}`;
    if (brand && !/unknown/i.test(brand)) say += ` by ${brand}`;
    if (price && !/unknown/i.test(price)) say += `, estimated ${price}`;
    speak(say + ".");
  } catch (e) {
    reply("Scan failed: " + e.message, true);
  } finally {
    state.busy = false;
    setStatus("ai-status", true, "AI");
  }
}
function showScanResult(text) {
  const body = $("scan-text");
  body.innerHTML = "";
  text.split(/\r?\n/).forEach(line => {
    if (!line.trim()) return;
    const m = line.match(/^\s*([A-Z][A-Z \-]+):\s*(.*)$/);
    const row = document.createElement("div");
    if (m) row.innerHTML = `<span class="field">${m[1]}:</span> ${escapeHtml(m[2])}`;
    else   row.textContent = line;
    body.appendChild(row);
  });
  $("scan-panel").classList.remove("hidden");
}
$("scan-close").addEventListener("click", () => $("scan-panel").classList.add("hidden"));
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}

/* ------------------------------------------------------------
  10.  AIM command  -  COCO-SSD live tracking + vision-API fallback
   ------------------------------------------------------------ */
async function loadDetector() {
  if (state.tfModel) return state.tfModel;
  if (typeof cocoSsd === "undefined") return null;
  try {
    state.tfModel = await cocoSsd.load({ base: "lite_mobilenet_v2" });
    return state.tfModel;
  } catch (e) {
    console.warn("coco-ssd load failed", e);
    return null;
  }
}
function bestMatch(detections, query) {
  const q = (query || "").toLowerCase();
  if (!detections.length) return null;
  /* highest-score direct match */
  let m = detections
    .filter(d => q.includes(d.class) || d.class.split(" ").some(t => q.includes(t)))
    .sort((a,b) => b.score - a.score)[0];
  if (m) return m;
  /* synonym match */
  for (const k of Object.keys(SYN)) {
    if (q.includes(k)) {
      const cls = SYN[k];
      m = detections.filter(d => d.class === cls).sort((a,b)=>b.score-a.score)[0];
      if (m) return m;
    }
  }
  return null;
}
function moveReticleToBBox(bbox, sourceW, sourceH) {
  const [x, y, w, h] = bbox;
  /* the camera <video> uses object-fit: cover, so we need to map
     the (source) pixel coords to (window) coords identically.    */
  const cw = window.innerWidth, ch = window.innerHeight;
  const s  = Math.max(cw / sourceW, ch / sourceH);
  const dx = (cw - sourceW * s) / 2;
  const dy = (ch - sourceH * s) / 2;
  const cx = dx + (x + w / 2) * s;
  const cy = dy + (y + h / 2) * s;
  reticle.style.left = ((cx / cw) * 100).toFixed(1) + "%";
  reticle.style.top  = ((cy / ch) * 100).toFixed(1) + "%";
  reticle.classList.add("locked");
  retLbl.classList.add("show");
  /* fake "range" reading based on bbox size */
  const span = Math.max(w / sourceW, h / sourceH);
  const meters = Math.max(0.4, (1.0 / Math.max(span, 0.02)).toFixed(1));
  retRng.textContent = "RNG " + meters + "m";
}
function resetReticle() {
  reticle.classList.remove("locked");
  reticle.style.top = "50%";
  reticle.style.left = "50%";
  retLbl.classList.remove("show");
  retLbl.textContent = "";
  retRng.textContent = "RNG ——";
}

async function startAiming(label) {
  state.aiming = label;
  reply("Acquiring target: " + label + "...", true);
  retLbl.classList.add("show");
  retLbl.textContent = "◌ SEARCHING: " + label.toUpperCase();

  const model = await loadDetector();

  /* ---- fast path: on-device tracker (no API cost) ---- */
  if (model) {
    if (state.loop) clearInterval(state.loop);
    let lockedOnce = false, missCount = 0;
    state.loop = setInterval(async () => {
      if (!state.aiming || video.readyState < 2) return;
      try {
        const det = await model.detect(video, 10);
        const m = bestMatch(det, state.aiming);
        if (m) {
          moveReticleToBBox(m.bbox, video.videoWidth, video.videoHeight);
          retLbl.textContent = "◉ LOCKED: " + m.class.toUpperCase() +
                               "  " + Math.round(m.score * 100) + "%";
          if (!lockedOnce) {
            lockedOnce = true;
            speak("Target acquired. " + m.class + ".");
          }
          missCount = 0;
        } else {
          missCount++;
          if (missCount > 4) {
            reticle.classList.remove("locked");
            retLbl.textContent = "◌ SEARCHING: " + state.aiming.toUpperCase();
          }
        }
      } catch (_) {}
    }, 320);
    return;
  }

  /* ---- fallback: ask the vision model for normalised coords ---- */
  const img = snapshot();
  if (!img) { stopAiming(); reply("Camera not ready.", true); return; }
  try {
    const r = await fetch("/api/vision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: img, prompt: label, mode: "locate" }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    const obj = JSON.parse(j.reply.match(/\{[\s\S]*\}/)[0]);
    if (obj.found) {
      reticle.style.left = (obj.x * 100).toFixed(1) + "%";
      reticle.style.top  = (obj.y * 100).toFixed(1) + "%";
      reticle.classList.add("locked");
      retLbl.textContent = "◉ LOCKED: " + (obj.label || label).toUpperCase();
      speak("Target acquired. " + (obj.label || label) + ".");
    } else {
      reply(label + " is not in view.", true);
      stopAiming();
    }
  } catch (e) {
    reply("Unable to lock target. " + e.message, true);
    stopAiming();
  }
}
function stopAiming() {
  state.aiming = null;
  if (state.loop) { clearInterval(state.loop); state.loop = null; }
  resetReticle();
}

/* ------------------------------------------------------------
  11.  ARTICLE CAPTURE  -  OCR -> structured blocks -> PDF
   ------------------------------------------------------------ */
function showArticlePanel()   { $("article-panel").classList.remove("hidden"); }
function hideArticlePanel()   { $("article-panel").classList.add("hidden"); }

function discardArticle() {
  state.article = null;
  state.articlePdfBlob = null;
  state.articlePdfStale = true;
  hideArticlePanel();
}

function updateArticlePanel() {
  const a = state.article;
  if (!a) return;
  $("article-title").textContent = a.title || "(untitled)";
  $("article-meta").textContent =
    `${a.pages} page${a.pages !== 1 ? "s" : ""} · ` +
    `${a.blocks.length} block${a.blocks.length !== 1 ? "s" : ""}` +
    (a.continues ? " · MORE BELOW" : "");
  const preview = $("article-preview");
  preview.innerHTML = "";
  const last = a.blocks.slice(-6);
  for (const b of last) {
    const line = document.createElement("div");
    line.className = "art-line";
    const snip = (b.text || "").slice(0, 110);
    line.innerHTML =
      `<span class="art-type">${escapeHtml(b.type.toUpperCase())}</span>` +
      escapeHtml(snip) + (b.text.length > 110 ? "…" : "");
    preview.appendChild(line);
  }
  /* highlight DOWNLOAD when a fresh PDF is ready */
  $("btn-art-dl").classList.toggle("ready",
    !!state.articlePdfBlob && !state.articlePdfStale);
}

async function startArticleScan() {
  if (state.busy) return;
  state.article = {
    title: null, byline: null, date: null,
    blocks: [], pages: 0, continues: false,
  };
  state.articlePdfBlob = null;
  state.articlePdfStale = true;
  showArticlePanel();
  updateArticlePanel();
  reply("Article capture armed. Hold the page steady - capturing now.", true);
  await captureArticlePage();
}

async function captureArticlePage() {
  if (!state.article) { reply("No article in progress. Say 'scan article' first.", true); return; }
  if (state.busy) return;
  /* a higher-res snapshot keeps OCR accurate */
  const img = snapshot(1024, 0.82);
  if (!img) { reply("Camera not ready.", true); return; }

  state.busy = true;
  setStatus("ai-status", true, "AI*");
  $("scan-flash").classList.remove("active");
  void $("scan-flash").offsetWidth;
  $("scan-flash").classList.add("active");

  try {
    const r = await fetch("/api/article", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: img }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    const a = j.article;
    state.article.pages++;
    if (a.title  && !state.article.title)  state.article.title  = a.title;
    if (a.byline && !state.article.byline) state.article.byline = a.byline;
    if (a.date   && !state.article.date)   state.article.date   = a.date;
    state.article.blocks.push(...(a.blocks || []));
    state.article.continues = !!a.continues;
    state.articlePdfStale = true;
    updateArticlePanel();

    const blockCount = state.article.blocks.length;
    const tail = a.continues
      ? "Text continues. Aim at the next section and say 'next page', or 'save article' to finish."
      : "End of page. Say 'next page' for more, or 'save article' to build the PDF.";
    reply(`Page ${state.article.pages} captured. ${blockCount} block${blockCount===1?"":"s"} total. ${tail}`, true);
  } catch (e) {
    reply("Article capture failed: " + e.message, true);
  } finally {
    state.busy = false;
    setStatus("ai-status", true, "AI");
  }
}

function finishArticle() {
  if (!state.article || !state.article.blocks.length) {
    reply("Nothing captured yet. Say 'scan article' first.", true);
    return;
  }
  buildArticlePdf();
  const a = state.article;
  reply(
    `PDF ready: "${a.title || "untitled"}" - ${a.blocks.length} blocks across ` +
    `${a.pages} page${a.pages!==1?"s":""}. ` +
    `Tap DOWNLOAD or say "download article".`,
    true
  );
}

function buildArticlePdf() {
  const jspdfNS = window.jspdf || window.jsPDF || null;
  const jsPDF = jspdfNS && (jspdfNS.jsPDF || jspdfNS);
  if (!jsPDF) { reply("PDF engine missing. Reload the page.", true); return; }

  const a = state.article;
  const doc  = new jsPDF({ unit: "pt", format: "letter" });
  const left = 56, right = 56, top = 56, bottom = 56;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const maxW  = pageW - left - right;
  let y = top;

  function newPage() { doc.addPage(); y = top; }
  function setFont(size, weight, style) {
    doc.setFontSize(size);
    doc.setFont("helvetica", weight === "bold" ? "bold"
                          : style === "italic" ? "italic" : "normal");
  }
  function write(text, size, weight, style, indent) {
    indent = indent || 0;
    setFont(size, weight, style);
    const lh = size * 1.32;
    const lines = doc.splitTextToSize(text, maxW - indent);
    for (const ln of lines) {
      if (y + lh > pageH - bottom) newPage();
      doc.text(ln, left + indent, y + lh * 0.78);
      y += lh;
    }
    y += lh * 0.32;     // small paragraph gap
  }

  /* masthead */
  if (a.title)  write(a.title, 20, "bold");
  if (a.byline) write(a.byline, 11, null, "italic");
  if (a.date)   write(a.date,   10, null, "italic");
  if (a.title || a.byline || a.date) {
    y += 4;
    if (y + 12 > pageH - bottom) newPage();
    doc.setDrawColor(120);
    doc.line(left, y, pageW - right, y);
    y += 14;
  }

  /* body blocks */
  for (const b of a.blocks) {
    const t = b.text || "";
    switch ((b.type || "paragraph")) {
      case "heading":    write(t, 16, "bold"); break;
      case "subheading": write(t, 13, "bold"); break;
      case "quote":      write("“" + t + "”", 12, null, "italic", 22); break;
      case "caption":    write(t, 10, null, "italic"); break;
      case "list_item":  write("•  " + t, 12, null, null, 18); break;
      case "footer":     write(t,  9, null, "italic"); break;
      default:           write(t, 12); break;
    }
  }

  /* attribution footer on every page */
  const total = doc.internal.getNumberOfPages();
  const stamp = new Date().toLocaleString();
  for (let p = 1; p <= total; p++) {
    doc.setPage(p);
    doc.setFontSize(8);
    doc.setFont("helvetica", "italic");
    doc.setTextColor(110);
    doc.text(`Scanned with VISION on ${stamp}  ·  Page ${p} of ${total}  ·  Personal / educational use.`,
             left, pageH - 22);
    doc.setTextColor(0);
  }

  state.articlePdfBlob = doc.output("blob");
  state.articlePdfStale = false;
  state.articleFile = articleFilename();
  updateArticlePanel();
}

function articleFilename() {
  const t = (state.article?.title || "article")
    .replace(/[^\w\d \-]+/g, "")
    .trim()
    .slice(0, 60)
    .replace(/\s+/g, "_");
  const d = new Date().toISOString().slice(0, 10);
  return `${t || "article"}-${d}.pdf`;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
}

function downloadArticle() {
  if (!state.article || !state.article.blocks.length) {
    reply("No article to download. Say 'scan article' to start.", true);
    return;
  }
  /* auto-build if the user skipped "save article" or edited since */
  if (!state.articlePdfBlob || state.articlePdfStale) buildArticlePdf();
  if (!state.articlePdfBlob) return;
  triggerDownload(state.articlePdfBlob, state.articleFile || articleFilename());
  reply(`Downloading ${state.articleFile}.`, true);
}

$("article-close").addEventListener("click", discardArticle);
$("btn-art-next").addEventListener("click", () => captureArticlePage());
$("btn-art-save").addEventListener("click", () => finishArticle());
$("btn-art-dl").addEventListener("click",   () => downloadArticle());

/* ------------------------------------------------------------
  12.  General chat
   ------------------------------------------------------------ */
async function chatWithAI(message) {
  if (state.busy) return;
  state.busy = true;
  setStatus("ai-status", true, "AI*");
  showResponse("···");
  try {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        history: state.history.slice(-10),
      }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    state.history.push({ role: "user",      content: message });
    state.history.push({ role: "assistant", content: j.reply });
    reply(j.reply, true);
  } catch (e) {
    reply("Connection issue. " + e.message, true);
  } finally {
    state.busy = false;
    setStatus("ai-status", true, "AI");
  }
}
function reply(text, tts) {
  showResponse(text);
  if (tts !== false) speak(text);
}

/* ------------------------------------------------------------
  13.  Misc - clock, net, mute, buttons, boot
   ------------------------------------------------------------ */
function tickClock() {
  const d = new Date(), p = n => String(n).padStart(2, "0");
  $("clock").textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
setInterval(tickClock, 1000); tickClock();

function netCheck() { setStatus("net-status", navigator.onLine, "NET"); }
window.addEventListener("online",  netCheck);
window.addEventListener("offline", netCheck);
netCheck();

function setMuted(m) {
  state.muted = !!m;
  $("btn-mute").innerHTML = m ? "🔇 UNMUTE" : "🎤 MUTE";
  if (m) stopSpeaking();
}

$("btn-mute").addEventListener("click", () => setMuted(!state.muted));
$("btn-scan").addEventListener("click", () => doScan("the object in the centre of view"));
$("btn-listen").addEventListener("click", () => {
  if (state.listening) stopListening(); else startListening();
});

/* Tapping the reticle clears any active target */
reticle.addEventListener("click", () => { if (state.aiming) stopAiming(); });

/* Pre-fetch the COCO model lazily once the page is idle */
window.addEventListener("load", () => {
  if ("requestIdleCallback" in window) requestIdleCallback(() => loadDetector());
  else setTimeout(loadDetector, 2500);
});

/* health check on the API keys */
fetch("/api/health").then(r => r.json()).then(j => {
  const missing = [];
  if (!j.text_key_set)   missing.push("TEXT_API_KEY");
  if (!j.visual_key_set) missing.push("VISUAL_API_KEY");
  if (missing.length) {
    showResponse("Backend started, but " + missing.join(" + ") +
                 " not configured. Add in Replit Secrets and restart.");
    setStatus("ai-status", false, "AI✕");
  } else {
    setStatus("ai-status", true, "AI");
  }
}).catch(() => {});

/* ------------------------------------------------------------
  14.  Activation (mic + cam need a user gesture)
   ------------------------------------------------------------ */
async function activate() {
  if (state.booted) return;
  state.booted = true;
  $("boot").classList.add("hidden");
  /* prime TTS on Safari (must be inside the gesture) */
  try { speechSynthesis.resume(); speak(" "); } catch (_) {}
  const camOk = await startCamera();
  startListening();
  if (camOk) reply("Vision online. How can I help, sir?", true);
}
$("boot-btn").addEventListener("click", activate);

/* iOS Safari: hold focus and prevent rubber-band scrolling */
document.addEventListener("touchmove", (e) => { e.preventDefault(); }, { passive: false });

})();
