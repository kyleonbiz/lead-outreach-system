"""Market research agent: which industries/cities give usable emails and few bounces, and where to prospect next.
Uses only your own sheet data (aggregated counts, no emails or names go to the model). It only suggests."""
import datetime
from collections import defaultdict

from . import llm, store

MIN_SAMPLE = 15


def _col(h):
    return {n: i for i, n in enumerate(h)}


def _g(r, c, f):
    i = c.get(f)
    return r[i].strip() if i is not None and i < len(r) else ""


def analyze(leads_rows, log_rows):
    lc = _col(leads_rows[0]) if leads_rows else {}
    by_lead = {}
    ind, loc = defaultdict(lambda: defaultdict(int)), defaultdict(lambda: defaultdict(int))
    for r in leads_rows[1:]:
        if not any(r):
            continue
        lid = _g(r, lc, "lead_id")
        industry = _g(r, lc, "industry") or "(blank)"
        city, state = _g(r, lc, "city"), _g(r, lc, "state").upper()
        place = f"{city}, {state}" if city and state else (state or "(blank)")
        by_lead[lid] = (industry, place)
        has_email = _g(r, lc, "enrichment_status") == "enriched" or bool(_g(r, lc, "email"))
        contacted = _g(r, lc, "outreach_status") == "contacted"
        for bucket, key in ((ind, industry), (loc, place)):
            bucket[key]["leads"] += 1
            bucket[key]["with_email"] += has_email
            bucket[key]["contacted"] += contacted
    # bounces/replies come from the log, joined to the lead's industry/place by lead_id
    for r in log_rows[1:]:
        lid = r[1] if len(r) > 1 else ""
        status = r[7] if len(r) > 7 else ""
        if lid not in by_lead:
            continue
        for bucket, key in ((ind, by_lead[lid][0]), (loc, by_lead[lid][1])):
            if status == "sent":
                bucket[key]["sent"] += 1
            elif status in ("hard_bounce", "failed"):
                bucket[key]["bounced"] += 1
            if len(r) > 9 and r[9].strip():
                bucket[key]["replied"] += 1

    def rows(bucket):
        out = []
        for k, v in bucket.items():
            n = v["leads"]
            out.append({"name": k, "leads": n, "with_email": v["with_email"],
                        "email_rate": round(v["with_email"] / n * 100) if n else 0,
                        "contacted": v["contacted"], "sent": v["sent"], "bounced": v["bounced"],
                        "bounce_rate": round(v["bounced"] / (v["sent"] + v["bounced"]) * 100, 1) if v["sent"] + v["bounced"] else 0.0,
                        "replied": v["replied"], "enough_data": n >= MIN_SAMPLE})
        return sorted(out, key=lambda x: (-x["enough_data"], -x["email_rate"], -x["leads"]))
    total_replies = sum(v["replied"] for v in ind.values())
    return {"industries": rows(ind), "places": rows(loc)[:25], "replies_tracked": total_replies > 0}


def recommend(stats, queue_rows=None, ask=llm.ask):
    queue = [f"{r[0]} | {r[1]}" for r in (queue_rows or [])[1:] if len(r) > 1 and r[0]]
    prompt = f"""You advise a small back-office/admin support company (Aurum Ventura) that finds local business leads
and emails them. Using ONLY the statistics below from their own lead pipeline, recommend where to prospect next.

INDUSTRY STATS: {stats['industries'][:30]}
PLACE STATS: {stats['places']}
ALREADY IN CAMPAIGN QUEUE (industry | location): {queue[:40]}
REPLY TRACKING: {'available' if stats['replies_tracked'] else 'NOT recorded, so recommend from email-found rate and bounce rate only; say so'}

Rules: never invent market sizes, prices, or facts not in the stats. Rows with enough_data=false are too small to trust; say so.
Prefer high email_rate, low bounce_rate, and combinations not already in the queue.
Return ONLY JSON: {{"summary": "2-3 sentences", "recommendations": [{{"industry": "...", "location": "City, ST", "reason": "cites the numbers", "confidence": "low|medium|high"}}], "caveats": ["..."]}} with at most 8 recommendations."""
    out = llm.parse_json(ask(prompt), "{")
    recs = [r for r in out.get("recommendations", []) if isinstance(r, dict) and r.get("industry")][:8]
    return {"summary": str(out.get("summary", ""))[:800], "recommendations": recs,
            "caveats": [str(c)[:300] for c in out.get("caveats", [])][:6]}


def run(leads_rows, log_rows, queue_rows, ask=llm.ask):
    stats = analyze(leads_rows, log_rows)
    report = {"generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"), "stats": stats,
              "advice": recommend(stats, queue_rows, ask)}
    store.save("research", report)
    return report
