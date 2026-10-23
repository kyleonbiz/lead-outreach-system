"""Marketing agent: weekly Facebook posts (reusing create_fb_posts rules) plus SEO page ideas. Never posts anything."""
import datetime

import create_fb_posts as fb

from . import llm, store


def seo_prompt(site_text):
    return f"""You suggest new web pages for aurumventura.net, a back-office / administrative support company.

SOURCE OF TRUTH - the website (use ONLY facts found here):
{site_text}

Suggest 5 new pages (service/industry landing pages or helpful guides) that would attract small business owners.
Rules: stay on back-office/administrative support; do not invent statistics, pricing, testimonials, clients or guarantees;
do not claim search volumes or rankings; no legal/financial advice. Keep to services the site already offers.
Return ONLY a JSON array: [{{"title": "...", "audience": "...", "search_intent": "what the visitor is trying to do",
"suggested_keyword": "a plausible phrase to target (no volume claims)", "outline": ["H2 heading", "..."]}}]"""


def run(ask=llm.ask, site_text=None, today=None):
    today = today or datetime.datetime.now(fb.CENTRAL).date()
    site_text = site_text if site_text is not None else fb.get_site_text()
    topics, dates = fb.week_topics(today), fb.week_dates(today)
    posts = fb.parse_posts(ask(fb.build_prompt(site_text, topics, dates), 4000))
    clean = [{"day": str(p.get("day", "")), "service": str(p.get("service", "")), "industry": str(p.get("industry", "")),
              "post": str(p.get("post", "")).strip(), "image_idea": str(p.get("image_idea", "")).strip()}
             for p in posts if isinstance(p, dict) and p.get("post")]
    seo = llm.parse_json(ask(seo_prompt(site_text), 3000), "[")
    seo = [{k: (v if isinstance(v, list) else str(v)) for k, v in s.items()} for s in seo if isinstance(s, dict) and s.get("title")][:5]
    report = {"generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
              "week_of": dates[0].isoformat(), "posts": clean, "seo": seo}
    store.save("marketing", report)
    return report
