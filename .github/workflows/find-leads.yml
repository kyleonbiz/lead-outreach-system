import os
import sys
import json
import re
import time
import requests
from urllib.parse import urlparse
import gspread
import google.auth

PLACES_API_KEY = os.environ.get("PLACES_API_KEY")
SHEET_ID = os.environ.get("SHEET_ID")

# How many NEW (not already in the sheet) leads to collect per run
TARGET_NEW_LEADS = int(os.environ.get("MAX_RESULTS_PER_RUN", "100"))
# Safety cap on searches per run so a bad run can't burn through the API budget
MAX_SEARCHES_PER_RUN = int(os.environ.get("MAX_SEARCHES_PER_RUN", "60"))
# Google Places returns max 20 per page, max 3 pages (60 results) per search
MAX_PAGES_PER_SEARCH = 3

PROGRESS_TAB = "Search_Progress"

# Chain / franchise filters
CHAIN_REVIEW_LIMIT = int(os.environ.get("CHAIN_REVIEW_LIMIT", "1500"))  # more reviews than this = likely chain
CHAIN_NAME_LIMIT = int(os.environ.get("CHAIN_NAME_LIMIT", "3"))  # same name this many times = chain

# "Websites" that aren't the business's own site, so they can't be used to spot duplicates
SHARED_HOSTS = {
    "facebook.com", "m.facebook.com", "instagram.com", "linkedin.com", "twitter.com", "x.com",
    "google.com", "sites.google.com", "business.site", "yelp.com", "linktr.ee", "square.site",
    "wixsite.com", "godaddysites.com", "weebly.com", "wordpress.com", "squarespace.com",
    "nextdoor.com", "angi.com", "homeadvisor.com", "thumbtack.com", "bbb.org", "g.page",
}

INDUSTRIES = [
    "plumbers", "electricians", "HVAC contractors", "roofing contractors",
    "general contractors", "landscaping companies", "cleaning services",
    "pest control companies", "painting contractors", "flooring contractors",
    "auto repair shops", "dentists", "chiropractors", "physical therapy clinics",
    "veterinary clinics", "med spas", "insurance agencies", "real estate agencies",
    "property management companies", "law firms", "accounting firms",
    "marketing agencies", "construction companies", "moving companies",
    "trucking companies", "towing companies", "pool services",
    "garage door repair", "fencing contractors", "concrete contractors",
    "remodeling contractors", "solar installers", "home inspectors",
    "mortgage brokers", "financial advisors", "staffing agencies",
    "event planners", "catering companies", "photography studios",
    "fitness studios", "daycare centers", "home health care agencies",
    "IT services companies", "printing services", "sign companies",
    "locksmiths", "appliance repair", "tree services",
]

CITIES = [
    "New York, NY", "Los Angeles, CA", "Chicago, IL", "Houston, TX", "Phoenix, AZ",
    "Philadelphia, PA", "San Antonio, TX", "San Diego, CA", "Dallas, TX", "Jacksonville, FL",
    "Fort Worth, TX", "San Jose, CA", "Austin, TX", "Charlotte, NC", "Columbus, OH",
    "Indianapolis, IN", "San Francisco, CA", "Seattle, WA", "Denver, CO", "Oklahoma City, OK",
    "Nashville, TN", "Washington, DC", "El Paso, TX", "Las Vegas, NV", "Boston, MA",
    "Detroit, MI", "Portland, OR", "Louisville, KY", "Memphis, TN", "Baltimore, MD",
    "Milwaukee, WI", "Albuquerque, NM", "Tucson, AZ", "Fresno, CA", "Sacramento, CA",
    "Mesa, AZ", "Atlanta, GA", "Kansas City, MO", "Colorado Springs, CO", "Omaha, NE",
    "Raleigh, NC", "Miami, FL", "Virginia Beach, VA", "Long Beach, CA", "Oakland, CA",
    "Minneapolis, MN", "Bakersfield, CA", "Tulsa, OK", "Tampa, FL", "Arlington, TX",
    "Wichita, KS", "Aurora, CO", "New Orleans, LA", "Cleveland, OH", "Honolulu, HI",
    "Anaheim, CA", "Henderson, NV", "Orlando, FL", "Lexington, KY", "Stockton, CA",
    "Riverside, CA", "Irvine, CA", "Corpus Christi, TX", "Newark, NJ", "Santa Ana, CA",
    "Cincinnati, OH", "Pittsburgh, PA", "Saint Paul, MN", "Greensboro, NC", "Jersey City, NJ",
    "Durham, NC", "Lincoln, NE", "North Las Vegas, NV", "Plano, TX", "Anchorage, AK",
    "Gilbert, AZ", "Madison, WI", "Reno, NV", "Chandler, AZ", "St. Louis, MO",
    "Chula Vista, CA", "Buffalo, NY", "Fort Wayne, IN", "Lubbock, TX", "St. Petersburg, FL",
    "Toledo, OH", "Laredo, TX", "Port St. Lucie, FL", "Glendale, AZ", "Irving, TX",
    "Winston-Salem, NC", "Chesapeake, VA", "Garland, TX", "Scottsdale, AZ", "Boise, ID",
    "Hialeah, FL", "Frisco, TX", "Richmond, VA", "Cape Coral, FL", "Norfolk, VA",
    "Spokane, WA", "Huntsville, AL", "Santa Clarita, CA", "Tacoma, WA", "Fremont, CA",
    "McKinney, TX", "San Bernardino, CA", "Baton Rouge, LA", "Modesto, CA", "Fontana, CA",
    "Salt Lake City, UT", "Moreno Valley, CA", "Des Moines, IA", "Worcester, MA", "Yonkers, NY",
    "Fayetteville, NC", "Sioux Falls, SD", "Grand Prairie, TX", "Rochester, NY", "Tallahassee, FL",
    "Little Rock, AR", "Amarillo, TX", "Overland Park, KS", "Augusta, GA", "Mobile, AL",
    "Oxnard, CA", "Grand Rapids, MI", "Peoria, AZ", "Vancouver, WA", "Knoxville, TN",
    "Birmingham, AL", "Montgomery, AL", "Providence, RI", "Huntington Beach, CA", "Brownsville, TX",
    "Chattanooga, TN", "Fort Lauderdale, FL", "Tempe, AZ", "Akron, OH", "Clarksville, TN",
    "Ontario, CA", "Newport News, VA", "Elk Grove, CA", "Cary, NC", "Eugene, OR",
    "Aurora, IL", "Salem, OR", "Santa Rosa, CA", "Rancho Cucamonga, CA", "Pembroke Pines, FL",
    "Fort Collins, CO", "Springfield, MO", "Oceanside, CA", "Garden Grove, CA", "Lancaster, CA",
    "Murfreesboro, TN", "Palmdale, CA", "Corona, CA", "Killeen, TX", "Salinas, CA",
    "Roseville, CA", "Denton, TX", "Surprise, AZ", "Macon, GA", "Paterson, NJ",
    "Lakewood, CO", "Hayward, CA", "Charleston, SC", "Alexandria, VA", "Hollywood, FL",
    "Springfield, MA", "Kansas City, KS", "Sunnyvale, CA", "Bellevue, WA", "Joliet, IL",
    "Naperville, IL", "Escondido, CA", "Bridgeport, CT", "Savannah, GA", "Olathe, KS",
    "Mesquite, TX", "Syracuse, NY", "Pasadena, TX", "McAllen, TX", "Rockford, IL",
    "Gainesville, FL", "Pomona, CA", "Visalia, CA", "Thornton, CO", "Waco, TX",
    "Jackson, MS", "Columbia, SC", "Fullerton, CA", "Torrance, CA", "Victorville, CA",
    "Midland, TX", "Orange, CA", "Miramar, FL", "Hampton, VA", "Warren, MI",
    "Stamford, CT", "Cedar Rapids, IA", "Elizabeth, NJ", "Palm Bay, FL", "Dayton, OH",
    "New Haven, CT", "Coral Springs, FL", "Meridian, ID", "West Valley City, UT", "Pasadena, CA",
    "Lewisville, TX", "Kent, WA", "Sterling Heights, MI", "Fargo, ND", "Carrollton, TX",
    "Santa Clara, CA", "Round Rock, TX", "Norman, OK", "Columbia, MO", "Abilene, TX",
    "Athens, GA", "Pearland, TX", "Clovis, CA", "Topeka, KS", "College Station, TX",
    "Simi Valley, CA", "Allentown, PA", "West Palm Beach, FL", "Thousand Oaks, CA", "Vallejo, CA",
    "Wilmington, NC", "Evansville, IN", "Independence, MO", "Ann Arbor, MI", "Provo, UT",
    "Lansing, MI", "Beaumont, TX", "Odessa, TX", "Springfield, IL", "Hartford, CT",
    "Fairfield, CA", "Lafayette, LA", "Peoria, IL", "Berkeley, CA", "Richardson, TX",
    "Arvada, CO", "Billings, MT", "Murrieta, CA", "Rochester, MN", "Cambridge, MA",
    "Westminster, CO", "Manchester, NH", "Lowell, MA", "High Point, NC", "Clearwater, FL",
    "Pueblo, CO", "Temecula, CA", "Green Bay, WI", "Broken Arrow, OK", "Miami Gardens, FL",
    "League City, TX", "Antioch, CA", "Tyler, TX", "Las Cruces, NM", "Everett, WA",
    "Boulder, CO", "Wichita Falls, TX", "Sugar Land, TX", "Greeley, CO", "Lakeland, FL",
    "Gresham, OR", "Davenport, IA", "South Bend, IN", "Jurupa Valley, CA", "Rialto, CA",
    "Edison, NJ", "Burbank, CA", "Charleston, WV", "Waterbury, CT", "Kenosha, WI",
    "Concord, NC", "Greenville, SC", "Asheville, NC", "Franklin, TN", "Johnson City, TN",
    "Jackson, TN", "Bowling Green, KY", "Huntington, WV", "Portland, ME", "Burlington, VT",
    "Wilmington, DE", "Cheyenne, WY", "Casper, WY", "Missoula, MT", "Bismarck, ND",
    "Rapid City, SD", "Idaho Falls, ID", "St. George, UT", "Ogden, UT", "Santa Fe, NM",
    "Flagstaff, AZ", "Yuma, AZ", "Fayetteville, AR", "Fort Smith, AR", "Shreveport, LA",
    "Gulfport, MS", "Hattiesburg, MS", "Tuscaloosa, AL", "Dothan, AL", "Pensacola, FL",
    "Sarasota, FL", "Fort Myers, FL", "Daytona Beach, FL", "Ocala, FL", "Columbus, GA",
    "Myrtle Beach, SC", "Spartanburg, SC", "Roanoke, VA", "Lynchburg, VA", "Erie, PA",
    "Scranton, PA", "Lancaster, PA", "Reading, PA", "Albany, NY", "Trenton, NJ",
]


def get_client():
    credentials, _ = google.auth.default(
        scopes=["https://www.googleapis.com/auth/spreadsheets"]
    )
    return gspread.authorize(credentials)


def with_retry(fn, *args, attempts=5, **kwargs):
    """Retry transient Google Sheets errors with exponential backoff."""
    for i in range(attempts):
        try:
            return fn(*args, **kwargs)
        except gspread.exceptions.WorksheetNotFound:
            raise
        except Exception as e:
            if i == attempts - 1:
                raise
            wait = 2 ** i
            print(f"Sheets error ({e}); retrying in {wait}s...")
            time.sleep(wait)


def normalize_name(name):
    """'Mr. Rooter Plumbing - Austin, LLC' -> 'mr rooter plumbing'"""
    n = (name or "").lower()
    n = re.split(r"\s[-|–]\s", n)[0]
    n = re.sub(r"[^a-z0-9 ]", " ", n)
    n = re.sub(r"\b(llc|inc|co|corp|company|ltd|pllc|pc|pa)\b", " ", n)
    return " ".join(n.split())


def site_key(url):
    """Business's own website domain, or '' if it's a shared host like facebook.com."""
    if not url:
        return ""
    host = urlparse(url if "//" in url else "http://" + url).netloc.lower().split(":")[0]
    if host.startswith("www."):
        host = host[4:]
    if host in SHARED_HOSTS or any(host.endswith("." + h) for h in SHARED_HOSTS):
        return ""
    return host


def load_existing(sheet):
    """Place IDs, website domains and name counts already in the Leads tab."""
    ws = with_retry(sheet.worksheet, "Leads")
    rows = with_retry(ws.get_all_values)
    place_ids, domains, name_counts = set(), set(), {}
    if not rows:
        return place_ids, domains, name_counts
    header = [h.strip().lower() for h in rows[0]]

    def col(*names, default=None):
        for n in names:
            if n in header:
                return header.index(n)
        return default

    pid_col = col("place_id")
    web_col = col("website", default=7)
    name_col = col("business_name", "business name", "name", default=1)
    for row in rows[1:]:
        if pid_col is not None and len(row) > pid_col and row[pid_col]:
            place_ids.add(row[pid_col])
        if len(row) > web_col:
            d = site_key(row[web_col])
            if d:
                domains.add(d)
        if len(row) > name_col:
            n = normalize_name(row[name_col])
            if n:
                name_counts[n] = name_counts.get(n, 0) + 1
    return place_ids, domains, name_counts


class Filter:
    """Decides whether a Places result is a new, independent business worth keeping."""

    def __init__(self, place_ids, domains, name_counts):
        self.place_ids = place_ids
        self.domains = domains
        self.name_counts = name_counts
        self.skipped = {"already_have": 0, "same_website": 0, "chain": 0, "closed": 0}

    def keep(self, p):
        pid = p.get("id")
        if not pid or pid in self.place_ids:
            self.skipped["already_have"] += 1
            return False
        self.place_ids.add(pid)

        if p.get("businessStatus") and p["businessStatus"] != "OPERATIONAL":
            self.skipped["closed"] += 1
            return False

        name = normalize_name(p.get("displayName", {}).get("text", ""))
        if name:
            self.name_counts[name] = self.name_counts.get(name, 0) + 1
        if (p.get("userRatingCount") or 0) > CHAIN_REVIEW_LIMIT or \
                (name and self.name_counts[name] > CHAIN_NAME_LIMIT):
            self.skipped["chain"] += 1
            return False

        domain = site_key(p.get("websiteUri", ""))
        if domain:
            if domain in self.domains:
                self.skipped["same_website"] += 1
                return False
            self.domains.add(domain)
        return True


def get_progress_ws(sheet):
    try:
        return with_retry(sheet.worksheet, PROGRESS_TAB)
    except gspread.exceptions.WorksheetNotFound:
        ws = sheet.add_worksheet(title=PROGRESS_TAB, rows=10, cols=3)
        ws.update(range_name="A1:B1", values=[["next_index", "0"]])
        return ws


def read_next_index(ws):
    val = with_retry(ws.acell, "B1").value
    try:
        return int(val)
    except (TypeError, ValueError):
        return 0


def save_next_index(ws, idx):
    with_retry(ws.update, range_name="A1:B1", values=[["next_index", str(idx)]])


def combo_for_index(idx):
    """Walk every industry in a city, then move to the next city. Wraps forever."""
    total = len(INDUSTRIES) * len(CITIES)
    idx = idx % total
    industry = INDUSTRIES[idx % len(INDUSTRIES)]
    city = CITIES[idx // len(INDUSTRIES)]
    return industry, city


def search_businesses(industry, location):
    """Run one Places text search and page through up to 60 results."""
    url = "https://places.googleapis.com/v1/places:searchText"
    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": PLACES_API_KEY,
        "X-Goog-FieldMask": (
            "places.displayName,places.formattedAddress,"
            "places.internationalPhoneNumber,places.websiteUri,"
            "places.rating,places.id,places.userRatingCount,"
            "places.businessStatus,nextPageToken"
        ),
    }
    body = {"textQuery": f"{industry} in {location}", "pageSize": 20}
    results = []
    for _ in range(MAX_PAGES_PER_SEARCH):
        resp = requests.post(url, headers=headers, json=body, timeout=30)
        if resp.status_code in (401, 403):
            # Bad key / API disabled / billing issue: stop the whole run
            raise SystemExit(f"Places API auth error {resp.status_code}: {resp.text}")
        if resp.status_code != 200:
            print(f"  Places error {resp.status_code} for '{body['textQuery']}': {resp.text[:200]}")
            break
        data = resp.json()
        results.extend(data.get("places", []))
        token = data.get("nextPageToken")
        if not token:
            break
        body["pageToken"] = token
        time.sleep(2)  # page tokens need a moment before they're valid
    return results


def to_lead(p, industry):
    return {
        "business_name": p.get("displayName", {}).get("text", ""),
        "address": p.get("formattedAddress", ""),
        "phone": p.get("internationalPhoneNumber", ""),
        "website": p.get("websiteUri", ""),
        "rating": p.get("rating", ""),
        "place_id": p.get("id", ""),
        "industry": industry,
    }


if __name__ == "__main__":
    if not PLACES_API_KEY:
        raise SystemExit("Set PLACES_API_KEY first.")
    if not SHEET_ID:
        raise SystemExit("Set SHEET_ID first.")

    sheet = get_client().open_by_key(SHEET_ID)
    place_ids, domains, name_counts = load_existing(sheet)
    filt = Filter(place_ids, domains, name_counts)
    print(f"{len(place_ids)} leads already in the sheet (will be skipped).")

    leads = []
    manual = len(sys.argv) >= 3 and sys.argv[1].strip() and sys.argv[2].strip()

    if manual:
        # One-off search from a manual workflow run
        industry, location = sys.argv[1], sys.argv[2]
        for p in search_businesses(industry, location):
            if filt.keep(p):
                leads.append(to_lead(p, industry))
        print(f"{industry} in {location}: {len(leads)} new")
    else:
        progress_ws = get_progress_ws(sheet)
        idx = read_next_index(progress_ws)
        searches = 0
        try:
            while len(leads) < TARGET_NEW_LEADS and searches < MAX_SEARCHES_PER_RUN:
                industry, location = combo_for_index(idx)
                new_here = 0
                for p in search_businesses(industry, location):
                    if filt.keep(p):
                        leads.append(to_lead(p, industry))
                        new_here += 1
                print(f"[{searches + 1}] {industry} in {location}: {new_here} new (total {len(leads)})")
                idx += 1
                searches += 1
        finally:
            save_next_index(progress_ws, idx)
            print(f"Progress saved. Next run starts at search #{idx} of {len(INDUSTRIES) * len(CITIES)}.")

    print(f"Skipped: {filt.skipped}")

    with open("leads_raw.json", "w") as f:
        json.dump(leads, f, indent=2)
    print(f"\nSaved {len(leads)} new leads to leads_raw.json")
