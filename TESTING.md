# Plane Spotter - Manual Test Checklist

Run these against the deployed worker after changes.
Replace `$BASE` and `$KEY` with your values.

```sh
BASE="https://plane-spotter.mastermakrela.workers.dev"
KEY="$(cat .dev.vars | grep API_KEY | cut -d= -f2-)"
```

## Auth

```sh
# No API key -> 401
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/flights/nearby" \
  -H "Content-Type: application/json" -d '{"lat":52.23,"lon":21.01}'

# Wrong API key -> 401
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/flights/nearby" \
  -H "Content-Type: application/json" -H "api-key: wrong" -d '{"lat":52.23,"lon":21.01}'
```

## JSON response

```sh
# Warsaw, 50km - should return flights; source is whichever position API answered
# ("adsbfi", "adsblol", or "airplaneslive" - from CF egress it's usually airplaneslive)
curl -s -X POST "$BASE/api/flights/nearby" \
  -H "Content-Type: application/json" -H "api-key: $KEY" \
  -d '{"lat":52.23,"lon":21.01,"radius":50}' | jq '{flights: (.flights | length), source}'
```

Check that returned flights have:
- `icao24` populated (`callsign` may be empty for some aircraft)
- `origin.id`/`destination.id` populated (ICAO airport codes) for most airline flights; empty (not dropped) when no plausible route is known
- `aircraft.type` or `aircraft.model` present (from adsb.fi)
- `distance` makes sense for the radius
- no ground traffic (parked aircraft, airport TWR beacons are filtered out)

## Pretty-print

```sh
# Same request with pretty-print -> plain text with aircraft, routes, airport list
curl -s -X POST "$BASE/api/flights/nearby" \
  -H "Content-Type: application/json" -H "api-key: $KEY" \
  -d '{"lat":52.23,"lon":21.01,"radius":50,"pretty-print":true}'
```

Check: flights without a known route show `✈︎ route unknown (CALLSIGN)`; output ends with `---\nAirports:` section listing referenced airports (omitted if no routes were resolved).

## Default radius

```sh
# Omit radius -> defaults to 10km, should still return 200
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/flights/nearby" \
  -H "Content-Type: application/json" -H "api-key: $KEY" \
  -d '{"lat":52.23,"lon":21.01}'
```

## Validation

```sh
# Invalid latitude -> 400
curl -s -X POST "$BASE/api/flights/nearby" \
  -H "Content-Type: application/json" -H "api-key: $KEY" \
  -d '{"lat":999,"lon":21.01}'

# Radius too large -> 400 (or 500 depending on where validation happens)
curl -s -X POST "$BASE/api/flights/nearby" \
  -H "Content-Type: application/json" -H "api-key: $KEY" \
  -d '{"lat":52.23,"lon":21.01,"radius":9999}'
```

## Busy airspace (stress test)

```sh
# London Heathrow area, 100km - many flights; should still be fast (<2s)
# since route enrichment is a single batched routeset call for the top 20
curl -s -w "\nTime: %{time_total}s" -X POST "$BASE/api/flights/nearby" \
  -H "Content-Type: application/json" -H "api-key: $KEY" \
  -d '{"lat":51.47,"lon":-0.46,"radius":100}' | jq '{flights: (.flights | length), source}'
```

## Cache behavior

```sh
# Run the same request twice quickly - second should be faster
# (position responses cached for 15s at CF edge; routeset is an uncached POST)
time curl -s -o /dev/null -X POST "$BASE/api/flights/nearby" \
  -H "Content-Type: application/json" -H "api-key: $KEY" \
  -d '{"lat":52.23,"lon":21.01,"radius":50}'

time curl -s -o /dev/null -X POST "$BASE/api/flights/nearby" \
  -H "Content-Type: application/json" -H "api-key: $KEY" \
  -d '{"lat":52.23,"lon":21.01,"radius":50}'
```

## OpenAPI docs

```sh
# Root should serve the OpenAPI/Swagger docs page
curl -s -o /dev/null -w "%{http_code}" "$BASE/" -H "api-key: $KEY"
```

## Known limitations

- **Rate limits**: the community position APIs allow ~1 req/s and throttle/block shared cloud IPs — from CF egress, adsb.fi 403s and adsb.lol 429s (July 2026), so airplanes.live usually answers. CF edge caching (`cacheTtl: 15s`) mitigates repeat requests. Avoid rapid-fire tests with varying params — airplanes.live 429s too and then ALL sources fail (500).
- **Failover**: sources are tried in order (adsb.fi → adsb.lol → airplanes.live); `source` shows which answered. Only if all fail does the request error — check `wrangler tail` for per-source status codes.
- **Route coverage**: routes come from the community-maintained VRS standing-data via adsb.im's routeset API. Regional airlines with dynamically-assigned callsigns, charters, GA, and military flights may have no route — they are returned with empty `origin`/`destination` instead of being dropped. Routes implausible for the aircraft's current position are discarded (stale callsign mappings).
