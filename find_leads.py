import os
import sys
import requests

PLACES_API_KEY = os.environ.get("PLACES_API_KEY")

def search_businesses(industry, location, max_results=20):
    url = "https://places.googleapis.com/v1/places:searchText"
    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": PLACES_API_KEY,
        "X-Goog-FieldMask": (
            "places.displayName,places.formattedAddress,"
            "places.internationalPhoneNumber,places.websiteUri,"
            "places.rating,places.id"
        ),
    }
    body = {
        "textQuery": f"{industry} in {location}",
        "maxResultCount": min(max_results, 20),
    }
    resp = requests.post(url, headers=headers, json=body)
    resp.raise_for_status()
    return resp.json().get("places", [])

if __name__ == "__main__":
    if not PLACES_API_KEY:
        raise SystemExit("Set PLACES_API_KEY first.")

    if len(sys.argv) >= 3:
        industry = sys.argv[1]
        location = sys.argv[2]
    else:
        industry = input("Industry (e.g. 'roofing contractors'): ")
        location = input("Location (e.g. 'Nashville, TN'): ")

    results = search_businesses(industry, location)

    print(f"\nFound {len(results)} businesses:\n")
    for p in results:
        name = p.get("displayName", {}).get("text", "")
        addr = p.get("formattedAddress", "")
        phone = p.get("internationalPhoneNumber", "")
        website = p.get("websiteUri", "")
        rating = p.get("rating", "")
        print(f"- {name} | {addr} | {phone} | {website} | rating: {rating}")
