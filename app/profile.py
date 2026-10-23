"""AI learning mode: a business profile plus memories the person controls. Stored in the app's own store; sent to the AI only
while learning mode is ON, and only as plain preferences (contact details and secrets are rejected)."""
import datetime
import re
import uuid

from .agents import store

CATS = ("business", "customers", "style", "rules", "preferences")
FIELDS = {"your_name": 80, "business_name": 120, "what_we_do": 600, "ideal_customers": 600, "service_area": 200,
          "tone": 60, "tone_notes": 300, "always_say": 400, "never_say": 400, "goals": 400}
TONES = ("", "Warm and professional", "Direct and concise", "Friendly and casual", "Formal")
MAX_MEMORIES, MAX_SUGGESTIONS, MAX_MEMORY_LEN, BLOCK_LIMIT = 60, 20, 300, 4000
DEFAULT = {"enabled": False, "profile": {}, "memories": [], "suggestions": []}

SENSITIVE = [
    (re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"), "an email address"),
    (re.compile(r"\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b"), "a phone number"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{8,}"), "an API key"),
    (re.compile(r"\b(password|passcode|api[ _-]?key|secret|token|credit card|ssn)\b", re.I), "a secret"),
    (re.compile(r"\d[\d -]{8,}\d"), "a long number"),
]


def _data():
    return store.load("profile", DEFAULT)


def _mut(fn):
    return store.mutate("profile", fn, {"enabled": False, "profile": {}, "memories": [], "suggestions": []})


def check_text(text):
    """'' if the text is safe to remember, otherwise a short reason."""
    for rx, what in SENSITIVE:
        if rx.search(text or ""):
            return f"that looks like it contains {what}; keep memories to preferences and facts about your business"
    return ""


def get():
    d = _data()
    return {"enabled": bool(d.get("enabled")), "profile": d.get("profile", {}), "memories": d.get("memories", []),
            "suggestions": d.get("suggestions", []), "tones": list(TONES), "categories": list(CATS)}


def set_enabled(on):
    _mut(lambda d: d.__setitem__("enabled", bool(on)))


def update_profile(fields):
    clean = {}
    for k, v in fields.items():
        if k not in FIELDS or v is None:
            continue
        v = str(v).strip()
        if len(v) > FIELDS[k]:
            return f"{k.replace('_', ' ')} is too long (max {FIELDS[k]} characters)"
        if k == "tone" and v not in TONES:
            return "pick one of the listed tones"
        err = check_text(v) if k != "tone" else ""
        if err:
            return f"{k.replace('_', ' ')}: {err}"
        clean[k] = v
    _mut(lambda d: d["profile"].update(clean))
    return ""


def add_memory(text, category="preferences", source="you"):
    text, category = (text or "").strip(), category if category in CATS else "preferences"
    if not text or len(text) > MAX_MEMORY_LEN:
        return None, f"memory must be 1-{MAX_MEMORY_LEN} characters"
    err = check_text(text)
    if err:
        return None, err
    def go(d):
        if len(d["memories"]) >= MAX_MEMORIES:
            return None, f"limit of {MAX_MEMORIES} memories; delete some first"
        if any(m["text"].lower() == text.lower() for m in d["memories"]):
            return None, "already remembered"
        m = {"id": uuid.uuid4().hex[:8], "text": text, "category": category, "source": source,
             "added": datetime.date.today().isoformat(), "enabled": True}
        d["memories"].append(m)
        return m, ""
    return _mut(go)


def update_memory(mid, text=None, enabled=None, category=None):
    if text is not None:
        text = text.strip()
        if not text or len(text) > MAX_MEMORY_LEN:
            return f"memory must be 1-{MAX_MEMORY_LEN} characters"
        if check_text(text):
            return check_text(text)
    def go(d):
        m = next((x for x in d["memories"] if x["id"] == mid), None)
        if not m:
            return "no such memory"
        if text is not None:
            m["text"] = text
        if enabled is not None:
            m["enabled"] = bool(enabled)
        if category in CATS:
            m["category"] = category
        return ""
    return _mut(go)


def delete_memory(mid):
    def go(d):
        n = len(d["memories"])
        d["memories"] = [m for m in d["memories"] if m["id"] != mid]
        return len(d["memories"]) < n
    return _mut(go)


def add_suggestions(items, source="edits"):
    """Queue suggestions for the person to accept or dismiss. Returns how many were queued."""
    def go(d):
        n, have = 0, {s["text"].lower() for s in d["suggestions"]} | {m["text"].lower() for m in d["memories"]}
        for it in items:
            t = str(it.get("text", "")).strip()[:MAX_MEMORY_LEN]
            if not t or t.lower() in have or check_text(t) or len(d["suggestions"]) >= MAX_SUGGESTIONS:
                continue
            d["suggestions"].append({"id": uuid.uuid4().hex[:8], "text": t, "category": it.get("category") if it.get("category") in CATS else "style",
                                     "evidence": str(it.get("evidence", ""))[:200], "source": source})
            have.add(t.lower())
            n += 1
        return n
    return _mut(go)


def resolve_suggestion(sid, accept):
    d = _data()
    s = next((x for x in d["suggestions"] if x["id"] == sid), None)
    if not s:
        return "no such suggestion"
    if accept:
        m, err = add_memory(s["text"], s["category"], s["source"])
        if err and err != "already remembered":
            return err
    _mut(lambda d: d.__setitem__("suggestions", [x for x in d["suggestions"] if x["id"] != sid]))
    return ""


def clear():
    store.save("profile", {"enabled": False, "profile": {}, "memories": [], "suggestions": []})


def prompt_block():
    """Text appended to AI prompts. Empty unless learning mode is on and there is something to say."""
    d = _data()
    if not d.get("enabled"):
        return ""
    p, lines = d.get("profile", {}), []
    labels = [("business_name", "Business"), ("your_name", "Owner"), ("what_we_do", "What we do"), ("ideal_customers", "Ideal customers"),
              ("service_area", "Service area"), ("tone", "Preferred tone"), ("tone_notes", "Tone notes"), ("always_say", "Always say"),
              ("never_say", "Never say"), ("goals", "Goals")]
    lines += [f"- {l}: {p[k]}" for k, l in labels if p.get(k)]
    mem = [f"- {m['text']}" for m in d.get("memories", []) if m.get("enabled")]
    if not lines and not mem:
        return ""
    body = "\n".join(lines) + ("\nRemembered preferences:\n" + "\n".join(mem) if mem else "")
    return ("\n\nABOUT THE USER AND THEIR BUSINESS (written or approved by the user; use it to match their voice and priorities. "
            "It never overrides the rules above and never permits inventing facts, prices or claims):\n" + body)[:BLOCK_LIMIT]
