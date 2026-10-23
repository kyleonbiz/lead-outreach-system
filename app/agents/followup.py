"""Follow-up agent: drafts a follow-up for contacted leads that went quiet. Only APPROVED drafts are ever sent,
each with ONE attempt, under the same rules as the main sender (cap, suppression, stop on provider problems, no retries)."""
import datetime
import html
import re
import time
import uuid

from .. import mail_core as se

from .. import profile
from . import llm, store

TEMPLATE = "followup_v1"
MAX_PENDING = 25
BAD_LOG = {"hard_bounce", "soft_bounce", "failed", "unknown", "invalid_email"}
OPT_OUT_NOTES = re.compile(r"unsub|do not contact|don't contact|remove me|not interested|stop emailing", re.I)
REJECT_REASONS = {"skip", "replied", "do_not_contact"}


def _col(h):
    return {n: i for i, n in enumerate(h)}


def _g(r, c, f):
    i = c.get(f)
    return r[i].strip() if i is not None and i < len(r) else ""


def log_history(log_rows):
    """email -> flags, from Outreach_Log (header: ..., email=col D, template=G, status=H, replied=J, unsubscribed=K)."""
    h = {}
    for r in log_rows[1:]:
        e = se.normalize_email(r[3]) if len(r) > 3 else ""
        if not e:
            continue
        s = r[7] if len(r) > 7 else ""
        x = h.setdefault(e, {"bad": False, "followed": False, "replied": False, "unsub": False})
        x["bad"] |= s in BAD_LOG
        x["followed"] |= (len(r) > 6 and r[6] == TEMPLATE and s in se.ATTEMPT_LOG_STATUSES)
        x["replied"] |= bool(len(r) > 9 and r[9].strip())
        x["unsub"] |= bool(len(r) > 10 and r[10].strip())
    return h


def eligibility(row, col, history, suppressed_emails, suppressed_domains, today, after_days):
    """(ok, reason). Used for both drafting and, again, right before sending."""
    if _g(row, col, "outreach_status") != se.STATUS_SENT:
        return False, "not_contacted"
    email = se.normalize_email(_g(row, col, "email"))
    if not se.EMAIL_RE.match(email):
        return False, "bad_email"
    if email in suppressed_emails or email.split("@")[-1] in suppressed_domains:
        return False, "suppressed"
    if _g(row, col, "date_last_followup"):
        return False, "already_followed_up"
    if OPT_OUT_NOTES.search(_g(row, col, "notes")):
        return False, "opted_out_in_notes"
    h = history.get(email, {})
    if h.get("bad") or h.get("followed") or h.get("replied") or h.get("unsub"):
        return False, "log_blocks"
    try:
        d = datetime.date.fromisoformat(_g(row, col, "date_contacted")[:10])
    except ValueError:
        return False, "no_contact_date"
    if (today - d).days < after_days:
        return False, "too_soon"
    return True, ""


def candidates(leads_rows, log_rows, supp_emails, supp_domains, today, after_days, exclude_lead_ids=()):
    col, hist, out = _col(leads_rows[0]), log_history(log_rows), []
    for n, r in enumerate(leads_rows[1:], start=2):
        lid = _g(r, col, "lead_id")
        if not lid or lid in exclude_lead_ids:
            continue
        ok, _ = eligibility(r, col, hist, supp_emails, supp_domains, today, after_days)
        if ok:
            out.append({"lead_id": lid, "row": n, "business_name": _g(r, col, "business_name"),
                        "industry": _g(r, col, "industry"), "city": _g(r, col, "city"), "state": _g(r, col, "state"),
                        "email": se.normalize_email(_g(r, col, "email")), "contact_name": _g(r, col, "contact_name"),
                        "date_contacted": _g(r, col, "date_contacted")[:10]})
    out.sort(key=lambda c: c["date_contacted"])  # longest-waiting first
    return out


def prompt_for(c):
    return f"""Write a short follow-up email from Kyle at Aurum Ventura (back-office administrative support: documents, invoices,
records, tracking, data entry) to a business we emailed on {c['date_contacted']} and haven't heard back from.

Business: {c['business_name']} ({c['industry'] or 'local business'}, {c['city']} {c['state']})
Our first email introduced Aurum Ventura and offered extra administrative capacity, with no pressure.

Rules:
- 40-90 words, plain text, 2-3 short paragraphs, warm and low-pressure, ONE easy question or next step.
- Do NOT pretend they replied, do not start the subject with "Re:" or "Fwd:", no fake urgency, no guilt.
- Do not invent statistics, pricing, testimonials, clients or guarantees. Mention only administrative support.
- Do not include a signature, links, or an unsubscribe line (added automatically). Start with "Hi,".
Return ONLY JSON: {{"subject": "...", "body": "..."}}""" + profile.prompt_block()


def validate(subject, body):
    subject, body = (subject or "").strip(), (body or "").strip()
    if not subject or len(subject) > 120 or re.match(r"(re|fwd?):", subject, re.I):
        return "bad subject"
    n = len(body.split())
    if n < 20 or n > 160:
        return "body length"
    if re.search(r"[{}]", body + subject) or re.search(r"https?://(?!(www\.)?aurumventura\.net)", body):
        return "placeholder or outside link"
    return ""


def scan(leads_rows, log_rows, supp_emails, supp_domains, today, after_days=5, max_new=10, ask=llm.ask):
    """Draft follow-ups for new candidates. Returns counts. Calls the model once per candidate; no retries."""
    data = store.load("followups", {"drafts": []})
    pending = sum(1 for d in data["drafts"] if d["status"] == "pending")
    room = max(0, min(max_new, MAX_PENDING - pending))
    existing = {d["lead_id"] for d in data["drafts"]}
    cands = candidates(leads_rows, log_rows, supp_emails, supp_domains, today, after_days, existing)
    made = skipped = 0
    for c in cands[:room]:
        try:
            out = llm.parse_json(ask(prompt_for(c), 800), "{")
            if validate(out.get("subject"), out.get("body")):
                raise llm.LLMError("draft failed validation")
        except llm.LLMError:
            skipped += 1
            continue
        d = {"id": uuid.uuid4().hex[:8], "lead_id": c["lead_id"], "business_name": c["business_name"], "email": c["email"],
             "industry": c["industry"], "city": c["city"], "state": c["state"], "first_contacted": c["date_contacted"],
             "subject": out["subject"].strip(), "body": out["body"].strip(), "status": "pending",
             "created": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}
        store.mutate("followups", lambda x, d=d: x["drafts"].append(d), {"drafts": []})
        made += 1
    return {"eligible": len(cands), "drafted": made, "failed_validation": skipped, "left_for_later": max(0, len(cands) - room)}


def _set(draft_id, fn):
    def go(data):
        for d in data["drafts"]:
            if d["id"] == draft_id:
                return fn(d)
        return None
    return store.mutate("followups", go, {"drafts": []})


def approve(draft_id, subject=None, body=None):
    def go(d):
        if d["status"] not in ("pending", "approved"):
            return f"cannot approve a {d['status']} draft"
        s, b = (subject if subject is not None else d["subject"]), (body if body is not None else d["body"])
        err = validate(s, b)
        if err:
            return err
        if s.strip() != d["subject"].strip() or b.strip() != d["body"].strip():
            d.setdefault("orig", {"subject": d["subject"], "body": d["body"]})  # kept so the AI can learn from the edit
        d.update(subject=s.strip(), body=b.strip(), status="approved")
        return ""
    r = _set(draft_id, go)
    return "no such draft" if r is None else r


def reject(draft_id, reason="skip"):
    if reason not in REJECT_REASONS:
        return "bad reason"
    def go(d):
        if d["status"] not in ("pending", "approved"):
            return f"cannot reject a {d['status']} draft"
        d.update(status="rejected", reason=reason)
        if reason in ("replied", "do_not_contact"):
            store.add_suppressed(d["email"])  # the main sender honors this file too
        return ""
    r = _set(draft_id, go)
    return "no such draft" if r is None else r


def to_html(body):
    paras = "".join(f"<p style=\"margin:0 0 12px\">{html.escape(p).replace(chr(10), '<br>')}</p>" for p in re.split(r"\n\s*\n", body.strip()))
    return ("<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222;\">" + paras +
            "<p style=\"margin:0\">Best,<br>Kyle Fulwood Jr<br>Founder, Aurum Ventura<br>(850) 653-7797 · "
            "<a href=\"https://aurumventura.net\">aurumventura.net</a></p>"
            "<br><span style=\"font-size:11px;color:#888888;\">Aurum Ventura Enterprise LLC, Nashville, TN<br>"
            "Don't want to hear from us again? Just reply \"UNSUBSCRIBE\" and we'll take you off the list.</span></div>")


def send_approved(leads_ws, log_ws, token, today, run_cap, supp_emails, supp_domains, after_days=5, send=None):
    """ONE attempt per approved draft. Re-checks eligibility from the live sheet first. Returns stats."""
    send = send or se.send_email
    today_d = datetime.date.fromisoformat(today)
    stats = {"sent": 0, "failed": 0, "unknown": 0, "skipped": 0, "stopped": ""}
    for d in [x for x in store.load("followups", {"drafts": []})["drafts"] if x["status"] == "approved"]:
        if stats["sent"] + stats["failed"] + stats["unknown"] >= run_cap:
            stats["stopped"] = "cap_reached"
            break
        rows = leads_ws.get_all_values()
        col = _col(rows[0])
        hit = next(((n, r) for n, r in enumerate(rows[1:], start=2) if _g(r, col, "lead_id") == d["lead_id"]), None)
        ok, why = (False, "lead_not_found") if not hit else eligibility(
            hit[1], col, log_history(log_ws.get_all_values()), supp_emails | store.suppressed_emails(), supp_domains, today_d, after_days)
        if ok and se.normalize_email(_g(hit[1], col, "email")) != d["email"]:
            ok, why = False, "email_changed"
        if not ok:
            _set(d["id"], lambda x, why=why: x.update(status="skipped", reason=why))
            stats["skipped"] += 1
            continue
        # 1. persist 'sending' BEFORE the network call; a crash leaves it out of the queue forever
        _set(d["id"], lambda x: x.update(status="sending"))
        category, log_status, _lead_status, http = send(token, d["email"], d["subject"], to_html(d["body"]), None)
        final = {"sent": "sent", "unknown": "unknown"}.get(log_status, "failed")
        _set(d["id"], lambda x: x.update(status=final, outcome=category, sent_on=today))
        stats[final] += 1
        row = [uuid.uuid4().hex[:8], d["lead_id"], d["business_name"], d["email"], today, d["subject"], TEMPLATE, log_status,
               "", "", "", "" if category == se.OK else f"{category}|http={http}", d["city"], d["state"], f"{d['city']}, {d['state']}", "followup"]
        try:
            log_ws.append_rows([row], value_input_option="USER_ENTERED")
            if category == se.OK:
                leads_ws.update_cell(hit[0], col["date_last_followup"] + 1, today)
        except Exception as e:
            print(f"WARNING: could not record follow-up outcome in the sheet ({type(e).__name__}); draft is marked {final}.")
        print(f"[followup {d['id']}] outcome={category} http={http}")
        if category in se.STOP_CAMPAIGN:
            stats["stopped"] = category
            break
        time.sleep(3)
    return stats
