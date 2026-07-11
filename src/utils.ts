import { airline_names, icaoToModelMap } from "./names";

/**
 * Enhanced Flight object with distance from reference point
 */
interface Flight {
	distance: number; // distance in km from reference point

	// Basic flight information
	icao24: string;
	callsign: string;
	latitude: number;
	longitude: number;
	altitude: number; // meters
	speed: number; // knots
	heading: number; // degrees

	airline?: string;
	aircraft: {
		type?: string;
		model?: string;
		registration?: string;
	};

	origin: {
		id: string;
		name: string;
		country: string;
	};
	destination: {
		id: string;
		name: string;
		country: string;
	};
}

/**
 * API Response format
 */
interface ApiResponse {
	flights: Flight[];
	source: string;
	timestamp: number;
}

/**
 * Calculate distance between two geographical points
 */
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6371; // Earth's radius in km
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;

	const a =
		Math.sin(dLat / 2) * Math.sin(dLat / 2) +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	return R * c;
}

/**
 * Aircraft entry in the readsb JSON format shared by adsb.fi and airplanes.live
 */
interface ReadsbAircraft {
	hex?: string;
	flight?: string;
	r?: string;
	t?: string;
	desc?: string;
	lat?: number;
	lon?: number;
	alt_baro?: number | string; // "ground" when on the ground
	gs?: number;
	track?: number;
}

/**
 * Position sources, tried in order until one succeeds.
 * Both serve the same readsb format; radius is in nautical miles, capped at 250 NM.
 */
const POSITION_SOURCES = [
	{
		name: "adsbfi",
		url: (lat: number, lon: number, distNm: number) =>
			`https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/${distNm}`,
	},
	{
		name: "adsblol",
		url: (lat: number, lon: number, distNm: number) => `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${distNm}`,
	},
	{
		name: "airplaneslive",
		url: (lat: number, lon: number, distNm: number) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${distNm}`,
	},
] as const;

// Identify ourselves to the community-run APIs (Workers send no User-Agent by default,
// which some of them reject)
const USER_AGENT = "plane-spotter/1.0 (github.com/mastermakrela/plane-spotter)";

async function fetchPositions(lat: number, lon: number, radiusKm: number): Promise<{ aircraft: ReadsbAircraft[]; source: string }> {
	const distNm = Math.min(radiusKm / 1.852, 250);
	const errors: string[] = [];

	for (const source of POSITION_SOURCES) {
		try {
			const response = await fetch(source.url(lat, lon, distNm), {
				headers: { "user-agent": USER_AGENT },
				cf: { cacheTtl: 15 },
			} as RequestInit);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);

			const data = (await response.json()) as { ac?: ReadsbAircraft[] };
			return { aircraft: data.ac ?? [], source: source.name };
		} catch (error) {
			errors.push(`${source.name}: ${error}`);
			console.warn(`Position source ${source.name} failed, trying next:`, error);
		}
	}

	throw new Error(`All position sources failed: ${errors.join("; ")}`);
}

/**
 * Map readsb aircraft entries to Flight objects within the requested radius
 */
function toFlights(aircraft: ReadsbAircraft[], lat: number, lon: number, radiusKm: number): Flight[] {
	return aircraft
		// Airborne traffic only: "ground" covers parked aircraft and airport ground beacons (TWR)
		.filter((ac) => ac.hex && ac.lat != null && ac.lon != null && ac.alt_baro !== "ground")
		.flatMap((ac): Flight[] => {
			const latitude = ac.lat!;
			const longitude = ac.lon!;
			const distance = calculateDistance(lat, lon, latitude, longitude);

			// Sources use a NM circle; enforce the requested km radius
			if (distance > radiusKm) return [];

			const altBaro = typeof ac.alt_baro === "number" ? ac.alt_baro : 0;

			return [
				{
					icao24: ac.hex!.toLowerCase(),
					callsign: (ac.flight || "").trim(),
					latitude,
					longitude,
					altitude: altBaro * 0.3048, // feet to meters
					speed: ac.gs ?? 0, // knots
					heading: ac.track ?? 0,
					distance,
					aircraft: {
						type: ac.t || undefined,
						model: ac.desc || ac.t || undefined,
						registration: ac.r || undefined,
					},
					origin: { id: "", name: "", country: "" },
					destination: { id: "", name: "", country: "" },
				},
			];
		});
}

/**
 * Route entry returned by the adsb.im routeset API (VRS standing-data,
 * with a position-plausibility check). Same API tar1090 uses for its route column.
 */
interface RoutesetEntry {
	callsign?: string;
	airline_code?: string;
	airport_codes?: string;
	plausible?: boolean | number;
	_airports?: Array<{
		icao?: string;
		iata?: string;
		name?: string;
		countryiso2?: string;
	}>;
}

/**
 * Enrich flights in place with routes from adsb.im in a single batched call.
 * Flights without a match (or with an implausible route for their position)
 * keep empty origin/destination — they are still returned to the client.
 */
async function enrichWithRoutes(flights: Flight[]): Promise<void> {
	const withCallsign = flights.filter((f) => f.callsign);
	if (withCallsign.length === 0) return;

	let routes: RoutesetEntry[];
	try {
		const response = await fetch("https://adsb.im/api/0/routeset", {
			method: "POST",
			headers: { "content-type": "application/json", "user-agent": USER_AGENT },
			body: JSON.stringify({
				planes: withCallsign.map((f) => ({ callsign: f.callsign, lat: f.latitude, lng: f.longitude })),
			}),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		routes = (await response.json()) as RoutesetEntry[];
	} catch (error) {
		console.warn("routeset lookup failed, returning flights without routes:", error);
		return;
	}

	const byCallsign = new Map(routes.filter((r) => r.callsign).map((r) => [r.callsign!, r]));

	for (const flight of withCallsign) {
		const route = byCallsign.get(flight.callsign);
		if (!route || !route.plausible || route.airport_codes === "unknown") continue;

		const airports = route._airports ?? [];
		if (airports.length < 2) continue;

		// Multi-leg routes list intermediate stops; show the overall origin/destination
		const origin = airports[0];
		const destination = airports[airports.length - 1];

		flight.origin = {
			id: origin.icao || origin.iata || "",
			name: origin.name || "",
			country: origin.countryiso2 || "",
		};
		flight.destination = {
			id: destination.icao || destination.iata || "",
			name: destination.name || "",
			country: destination.countryiso2 || "",
		};
		if (route.airline_code) {
			flight.airline = airline_names[route.airline_code] || route.airline_code;
		}
	}
}

/**
 * Main function: fetch live positions (with failover), enrich the closest
 * flights with route data, and return them sorted by distance.
 */
export async function getNearbyFlights(lat: number, lon: number, radiusKm: number): Promise<ApiResponse> {
	// Validate parameters
	if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
		throw new Error("Invalid latitude/longitude values");
	}

	if (radiusKm <= 0 || radiusKm > 500) {
		throw new Error("Invalid radius. Must be between 0 and 500 km");
	}

	const { aircraft, source } = await fetchPositions(lat, lon, radiusKm);

	const flights = toFlights(aircraft, lat, lon, radiusKm)
		.sort((a, b) => a.distance - b.distance)
		.slice(0, 20);

	await enrichWithRoutes(flights);

	return {
		flights,
		source,
		timestamp: Date.now(),
	};
}

/**
 * Pretty prints an array of flight objects with updated formatting, expanded aircraft models, and an airport list.
 *
 * @param flights An array of Flight objects.
 * @returns A string containing the pretty-printed flight information followed by an airport list.
 */
export function prettyPrintFlights(flights: Flight[]): string {
	if (!flights || flights.length === 0) {
		return "No flights to display.";
	}

	const airportMap = new Map<string, string>();

	const formattedFlights: string[] = flights.map((flight) => {
		const lines: string[] = [];

		// Line 1: Expanded Aircraft Model (and registration)
		const aircraftParts: string[] = [];
		let expandedModel = flight.aircraft?.model;
		if (flight.aircraft?.model && icaoToModelMap[flight.aircraft.model]) {
			expandedModel = icaoToModelMap[flight.aircraft.model];
		}

		if (expandedModel) {
			aircraftParts.push(expandedModel);
		} else if (flight.aircraft?.type) {
			aircraftParts.push(flight.aircraft.type);
		} else {
			aircraftParts.push("Unknown Aircraft Type");
		}

		if (flight.aircraft?.registration) {
			aircraftParts[aircraftParts.length - 1] += ` (${flight.aircraft.registration})`;
		}

		lines.push(aircraftParts.join("/"));

		// Line 2: Origin -> Destination (if known)
		if (flight.origin.id || flight.destination.id) {
			lines.push(`✈︎ ${flight.origin.id || "?"} → ${flight.destination.id || "?"}`);

			// Collect airport information
			if (flight.origin.id) airportMap.set(flight.origin.id, flight.origin.name);
			if (flight.destination.id) airportMap.set(flight.destination.id, flight.destination.name);
		} else {
			lines.push(`✈︎ route unknown${flight.callsign ? ` (${flight.callsign})` : ""}`);
		}

		// Line 3-4: Distance, Altitude, Speed, Heading - Aligned
		const distStr = `${flight.distance.toFixed(2)} km`;
		const altStr = `⛰️ ${flight.altitude.toFixed(0)} m`;
		const speedStr = `💨 ${flight.speed.toFixed(0)} kt`;
		const headStr = `🧭 ${flight.heading.toFixed(0)}°`;

		// Pad the first column for alignment (adjust padding as needed)
		const padding = 12;
		lines.push(`${distStr.padEnd(padding)} | ${altStr}`);
		lines.push(`${speedStr.padEnd(padding)} | ${headStr}`);

		// Line 5: Airline (Full Name)
		if (flight.airline) {
			lines.push(flight.airline);
		}

		return lines.join("\n");
	});

	const flightOutput = formattedFlights.join("\n\n");

	// Collect and format airport list
	const sortedAirportIds = Array.from(airportMap.keys()).sort();
	const airportList = sortedAirportIds.filter((id) => !!id).map((id) => `${id}: ${airportMap.get(id)}`);

	if (airportList.length === 0) return flightOutput;

	return flightOutput + "\n\n---\nAirports:\n" + airportList.join("\n");
}
