# Plane Spotter

Plane Spotter is a Cloudflare Worker API that provides real-time information about airplanes flying near a specified location. It is designed for integration with Apple Watch shortcuts, enabling quick access to flight details overhead.

## What it does

- Fetches live flight data from both OpenSky Network and FlightRadar24.
- Merges, deduplicates, and enriches flight information (including aircraft model, airline, origin, and destination).
- Exposes a secure HTTP API endpoint to query for flights near a given latitude/longitude and within a specified radius.
- Supports both JSON and human-readable plain text output for easy consumption by devices and shortcuts.

## How it works

1. **API Endpoint**:  
   The worker exposes a POST endpoint at `/api/flights/nearby` that requires an API key for authentication.

2. **Request**:  
   Clients send a JSON body with latitude, longitude, and optional radius (in kilometers). An optional `pretty-print` flag returns a formatted text response.

3. **Data Fetching**:  
   The worker queries both OpenSky and FlightRadar24 APIs for flights within the requested area. It calculates distances, fetches additional details, and merges results by unique aircraft identifiers.

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

For more details, see the [src/index.ts](src/index.ts) and [src/utils.ts](src/utils.ts) files.
