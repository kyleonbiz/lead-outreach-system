"""Contacts: one directory over Leads, Referral partners and contacts you add yourself, with notes, activity
timeline and a do-not-contact flag. Notes and manual contacts live in the app's own store, never in your sheet."""
import datetime
import hashlib
import re
import uuid

from .agents import store

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MAX_MANUAL, MAX_NOTES = 2000, 100


def _ix(h):
    return {n: i for i, n in enumerate(h)}


def _g(r, ix, f):
    i = ix.get(f)
    return r[i].strip() if i is not None and i < len(r) else ""


def norm(e):
    return (e or "").strip().lower()


def _data():
    return store.load("contacts", {"manual": [], "notes": {}})


def log_index(log):
    """lead_id / email -> (last_date, sent_count). Test sends and invalid addresses are not activity."""
    ix, out = _ix(log.get("header", [])), {}
    for r in log.get("rows", []):
        s = _g(r, ix, "send_status") or (r[7] if len(r) > 7 else "")
        if s in ("sent_test", "invalid_email", ""):
            continue
        d = _g(r, ix, "date_sent") or (r[4] if len(r) > 4 else "")
        for k in {_g(r, ix, "lead_id") or (r[1] if len(r) > 1 else ""), norm(_g(r, ix, "email") or (r[3] if len(r) > 3 else ""))}:
            if k:
                last, n = out.get(k, ("", 0))
                out[k] = (max(last, d), n + (s == "sent"))
    return out


def directory(leads, referrals, log, manual, suppressed):
    """Compact list for the table (short keys keep a 7,000-row payload small)."""
    act, out = log_index(log), []
    li = _ix(leads.get("header", []))
    for r in leads.get("rows", []):
        lid, email = _g(r, li, "lead_id"), norm(_g(r, li, "email"))
        a = max([act.get(lid, ("", 0)), act.get(email, ("", 0))] if email else [act.get(lid, ("", 0))])
        out.append({"k": f"lead:{lid}", "t": "lead", "n": _g(r, li, "business_name"), "c": _g(r, li, "contact_name"), "e": email,
                    "p": _g(r, li, "phone"), "w": _g(r, li, "website"), "l": ", ".join(x for x in (_g(r, li, "city"), _g(r, li, "state")) if x),
                    "i": _g(r, li, "industry"), "s": _g(r, li, "outreach_status"), "a": a[0], "m": a[1], "d": bool(email and email in suppressed)})
    ri = _ix(referrals.get("header", []))
    for r in referrals.get("rows", []):
        name, site = _g(r, ri, "Business"), _g(r, ri, "Website")
        if not name:
            continue
        out.append({"k": "ref:" + hashlib.sha1(f"{name}|{site}".lower().encode()).hexdigest()[:10], "t": "referral", "n": name,
                    "c": _g(r, ri, "Contact"), "e": "", "p": "", "w": site, "l": "", "i": _g(r, ri, "Category"), "s": "", "a": "", "m": 0, "d": False})
    for m in manual:
        e = norm(m.get("email"))
        a = act.get(e, ("", 0)) if e else ("", 0)
        out.append({"k": "man:" + m["id"], "t": "manual", "n": m.get("company") or m["name"], "c": m["name"] if m.get("company") else "", "e": e,
                    "p": m.get("phone", ""), "w": m.get("website", ""), "l": "", "i": "", "s": "", "a": a[0], "m": a[1], "d": bool(e and e in suppressed)})
    return out


def find(key, leads, referrals, log, manual, suppressed):
    return next((c for c in directory(leads, referrals, log, manual, suppressed) if c["k"] == key), None)


def fields_for(key, leads, referrals, manual):
    """Every column stored for this contact, in sheet order."""
    kind, _, ident = key.partition(":")
    if kind == "lead":
        ix = _ix(leads.get("header", []))
        for r in leads.get("rows", []):
            if _g(r, ix, "lead_id") == ident:
                return {h: r[i] for h, i in ix.items() if i < len(r) and r[i].strip()}
    if kind == "ref":
        ix = _ix(referrals.get("header", []))
        for r in referrals.get("rows", []):
            if hashlib.sha1(f"{_g(r, ix, 'Business')}|{_g(r, ix, 'Website')}".lower().encode()).hexdigest()[:10] == ident:
                return {h: r[i] for h, i in ix.items() if i < len(r) and r[i].strip()}
    if kind == "man":
        m = next((x for x in manual if x["id"] == ident), None)
        if m:
            return {k: v for k, v in m.items() if k != "id" and v}
    return {}


def timeline(c, key, log, drafts, notes):
    items, ix = [], _ix(log.get("header", []))
    lid = key.split(":", 1)[1] if key.startswith("lead:") else ""
    for r in log.get("rows", []):
        e = norm(_g(r, ix, "email") or (r[3] if len(r) > 3 else ""))
        l = _g(r, ix, "lead_id") or (r[1] if len(r) > 1 else "")
        s = _g(r, ix, "send_status") or (r[7] if len(r) > 7 else "")
        if s in ("sent_test", "") or not ((lid and l == lid) or (c["e"] and e == c["e"])):
            continue
        items.append({"date": _g(r, ix, "date_sent") or (r[4] if len(r) > 4 else ""), "kind": "email", "status": s,
                      "text": _g(r, ix, "subject") or (r[5] if len(r) > 5 else ""), "detail": _g(r, ix, "template_used") or (r[6] if len(r) > 6 else "")})
    for d in drafts:
        if lid and d.get("lead_id") == lid:
            items.append({"date": d.get("created", "")[:10], "kind": "followup", "status": d["status"], "text": d["subject"], "detail": "Follow-up draft"})
    for n in notes:
        items.append({"date": n["date"], "kind": "note", "id": n["id"], "text": n["text"], "status": "", "detail": ""})
    return sorted(items, key=lambda x: (x["date"], x["kind"]), reverse=True)


def add_manual(name, company="", email="", phone="", website="", notes=""):
    name, email = (name or "").strip(), norm(email)
    if not name:
        return None, "name is required"
    if email and not EMAIL_RE.match(email):
        return None, "that email address does not look valid"
    def go(d):
        if len(d["manual"]) >= MAX_MANUAL:
            return None, f"limit of {MAX_MANUAL} contacts"
        if email and any(norm(m.get("email")) == email for m in d["manual"]):
            return None, "a contact with that email already exists"
        m = {"id": uuid.uuid4().hex[:8], "name": name[:120], "company": company.strip()[:120], "email": email, "phone": phone.strip()[:40],
             "website": website.strip()[:200], "notes": notes.strip()[:1000], "added": datetime.date.today().isoformat()}
        d["manual"].append(m)
        return m, ""
    return store.mutate("contacts", go, {"manual": [], "notes": {}})


def remove_manual(cid):
    def go(d):
        n = len(d["manual"])
        d["manual"] = [m for m in d["manual"] if m["id"] != cid]
        d["notes"].pop("man:" + cid, None)
        return len(d["manual"]) < n
    return store.mutate("contacts", go, {"manual": [], "notes": {}})


def add_note(key, text):
    text = (text or "").strip()
    if not text:
        return None, "note is empty"
    def go(d):
        lst = d["notes"].setdefault(key, [])
        if len(lst) >= MAX_NOTES:
            return None, f"limit of {MAX_NOTES} notes"
        n = {"id": uuid.uuid4().hex[:8], "date": datetime.date.today().isoformat(), "text": text[:1000]}
        lst.append(n)
        return n, ""
    return store.mutate("contacts", go, {"manual": [], "notes": {}})


def delete_note(key, nid):
    def go(d):
        lst = d["notes"].get(key, [])
        d["notes"][key] = [n for n in lst if n["id"] != nid]
        return len(d["notes"][key]) < len(lst)
    return store.mutate("contacts", go, {"manual": [], "notes": {}})
