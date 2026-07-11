# Plane Spotter

Plane Spotter is a Cloudflare Worker API that provides real-time information about airplanes flying near a specified location. It is designed for integration with Apple Watch shortcuts, enabling quick access to flight details overhead.

## What it does

- Fetches live flight data from adsb.fi (with airplanes.live as failover), with route enrichment via the adsb.im routeset API.
- Enriches flight information (including aircraft model, airline, origin, and destination) with position-plausibility-checked routes.
- Exposes a secure HTTP API endpoint to query for flights near a given latitude/longitude and within a specified radius.
- Supports both JSON and human-readable plain text output for easy consumption by devices and shortcuts.

## How it works

1. **API Endpoint**:  
   The worker exposes a POST endpoint at `/api/flights/nearby` that requires an API key for authentication.

2. **Request**:  
   Clients send a JSON body with latitude, longitude, and optional radius (in kilometers). An optional `pretty-print` flag returns a formatted text response.

3. **Data Fetching**:  
   The worker queries adsb.fi (falling back to airplanes.live) for airborne aircraft within the requested area, calculates distances, and enriches the closest 20 with route data via a single batched call to the adsb.im routeset API. Routes that are implausible for the aircraft's current position are discarded; flights without a known route are still returned.

4. **Response**:  
   The API returns a list of nearby flights, sorted by distance, including details such as aircraft type, registration, airline, origin, destination, altitude, speed, and heading. The response can be in JSON or pretty-printed text format.

5. **Security**:  
   All requests require a valid API key, which is checked against the value set in the worker's environment variables.

## Example Usage

See the Apple Watch shortcut or use any HTTP client to POST to `/api/flights/nearby` with the required headers and body.

```
POST /api/flights/nearby
Headers:
  api-key: <your-api-key>
Body:
  {
    "lat": 52.2297,
    "lon": 21.0122,
    "radius": 10,
    "pretty-print": true
  }
```

## Data Sources

- **Positions** — three community sources tried in order, all serving the same readsb format, no auth required (~1 req/s each): [adsb.fi](https://opendata.adsb.fi/), [adsb.lol](https://api.adsb.lol/docs), [airplanes.live](https://airplanes.live/api-guide/). The `source` field in the response shows which one answered. Note: these community APIs throttle or block shared cloud egress IPs — as of July 2026, adsb.fi returns 403 and adsb.lol 429 from Cloudflare Workers, so airplanes.live typically carries production traffic; the chain exists so this can shift without breaking.
- **[adsb.im routeset](https://adsb.im/api/0/routeset)** — Route enrichment (origin/destination/airline) by callsign, batched in a single POST. Backed by the community-maintained [VRS standing-data](https://github.com/vradarserver/standing-data) (updated daily) and validated against the aircraft's actual position (`plausible` flag) — the same API tar1090 uses. Airline names come from a static ICAO-code map generated from the same dataset (`src/names.ts`).

Removed sources: OpenSky (bbox-only, credit-capped, returns no registration/type/route) and adsbdb.com (largely static legacy route data that produced stale/wrong routes).

For more details, see the [src/index.ts](src/index.ts) and [src/utils.ts](src/utils.ts) files.
