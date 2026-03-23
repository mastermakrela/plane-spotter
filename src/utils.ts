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
	speed: number; // knots or m/s depending on source
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
 * Check if a point is within a given radius
 */
function isWithinRadius(lat1: number, lon1: number, lat2: number, lon2: number, radiusKm: number): boolean {
	const distance = calculateDistance(lat1, lon1, lat2, lon2);
	return distance <= radiusKm;
}

/**
 * Fetch flights from OpenSky Network API
 */
async function fetchOpenSky(lat: number, lon: number, radiusKm: number): Promise<Flight[]> {
	// Calculate bounding box
	const approxLatDegrees = radiusKm / 111;
	const approxLonDegrees = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));

	const lamin = lat - approxLatDegrees;
	const lamax = lat + approxLatDegrees;
	const lomin = lon - approxLonDegrees;
	const lomax = lon + approxLonDegrees;

	const response = await fetch(
		`https://opensky-network.org/api/states/all?lamin=${lamin}&lamax=${lamax}&lomin=${lomin}&lomax=${lomax}`,
		{
			headers:
				process.env.OPENSKY_USERNAME && process.env.OPENSKY_PASSWORD
					? {
							Authorization: `Basic ${Buffer.from(`${process.env.OPENSKY_USERNAME}:${process.env.OPENSKY_PASSWORD}`).toString(
								"base64"
							)}`,
					  }
					: {},
		}
	);

	if (!response.ok) throw new Error(`OpenSky API error: ${response.status}`);

	// Parse raw state array
	const data = await response.json();
	const rawStates = (data.states ?? []) as unknown[][];
	const now = Math.floor(Date.now() / 1000);
	const begin = now - 24 * 3600;

	const flights = await Promise.all(
		rawStates
			.filter((state: unknown[]): boolean => {
				const lat2 = Number(state[6]);
				const lon2 = Number(state[5]);
				return isWithinRadius(lat, lon, lat2, lon2, radiusKm);
			})
			.map(async (state: unknown[]): Promise<Flight | null> => {
				const callsign = String(state[1] || "").trim();
				const icao24 = String(state[0] || "");
				if (!icao24) return null; // Skip if no ICAO24

				const latitude = Number(state[6]);
				const longitude = Number(state[5]);
				const baroAlt = state[7] != null ? Number(state[7]) : undefined;
				const geoAlt = state[13] != null ? Number(state[13]) : undefined;
				const altitude = baroAlt ?? geoAlt ?? 0; // Altitude is in meters from OpenSky
				const speed = Number(state[9] ?? 0); // Speed is in m/s from OpenSky
				const heading = Number(state[10] ?? 0);
				const origin_country_from_state = String(state[2] ?? "");
				const distance = calculateDistance(lat, lon, latitude, longitude);

				const flight: Flight = {
					icao24,
					callsign,
					latitude,
					longitude,
					altitude,
					speed,
					heading,
					distance,
					aircraft: {}, // Initialize nested objects
					origin: { country: origin_country_from_state, id: "", name: "" },
					destination: { id: "", name: "", country: "" },
				};

				// Enrich with departure/arrival from flight route API
				try {
					const routeRes = await fetch(
						`https://opensky-network.org/api/flights/aircraft?icao24=${icao24}&begin=${begin}&end=${now}`
					);
					if (routeRes.ok) {
						const routes = (await routeRes.json()) as Array<{
							estDepartureAirport: string | null;
							estArrivalAirport: string | null;
						}>;
						if (routes.length > 0) {
							flight.origin.id = routes[0].estDepartureAirport ?? "";
							flight.destination.id = routes[0].estArrivalAirport ?? "";
						}
					}
				} catch (e) {
					console.warn(`Route fetch failed for ${icao24}`, e);
				}

				// Only return if we have at least origin or destination airport ID
				if (flight.origin.id || flight.destination.id) {
					return flight;
				}
				return null; // Discard if no airport info found
			})
	);

	// Filter out null values (flights skipped due to missing ICAO24 or airport info)
	return flights.filter((f): f is Flight => f !== null);
}

/**
 * Fetch route info (origin/destination) from adsbdb.com by callsign
 */
async function fetchRouteFromAdsbdb(callsign: string): Promise<{ airline?: string; origin?: { id: string; name: string; country: string }; destination?: { id: string; name: string; country: string } } | null> {
	try {
		const res = await fetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`);
		if (!res.ok) {
			if (res.status !== 404) {
				console.warn(`adsbdb returned ${res.status} for callsign ${callsign}`);
			}
			return null;
		}

		const data = await res.json() as {
			response?: {
				flightroute?: {
					airline?: { name?: string };
					origin?: { icao_code?: string; name?: string; country?: string; iata_code?: string };
					destination?: { icao_code?: string; name?: string; country?: string; iata_code?: string };
				};
			};
		};

		const route = data.response?.flightroute;
		if (!route) return null;

		return {
			airline: route.airline?.name || undefined,
			origin: route.origin ? {
				id: route.origin.icao_code || route.origin.iata_code || "",
				name: route.origin.name || "",
				country: route.origin.country || "",
			} : undefined,
			destination: route.destination ? {
				id: route.destination.icao_code || route.destination.iata_code || "",
				name: route.destination.name || "",
				country: route.destination.country || "",
			} : undefined,
		};
	} catch (error) {
		console.warn(`adsbdb lookup failed for callsign ${callsign}:`, error);
		return null;
	}
}

/**
 * Fetch flights from adsb.fi API
 */
async function fetchAdsbFi(lat: number, lon: number, radiusKm: number): Promise<Flight[]> {
	// Convert km to nautical miles, cap at 250 NM
	const distNm = Math.min(radiusKm / 1.852, 250);

	const response = await fetch(
		`https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/${distNm}`
	);

	if (!response.ok) throw new Error(`adsb.fi API error: ${response.status}`);

	const data = await response.json() as {
		ac?: Array<{
			hex?: string;
			flight?: string;
			r?: string;
			t?: string;
			desc?: string;
			lat?: number;
			lon?: number;
			alt_baro?: number | string;
			gs?: number;
			track?: number;
		}>;
	};

	const aircraft = data.ac ?? [];

	// Step 1: Map all aircraft into Flight objects without adsbdb calls
	const allFlights: Flight[] = aircraft
		.filter((ac) => ac.hex && ac.lat != null && ac.lon != null)
		.map((ac): Flight | null => {
			const icao24 = ac.hex!.toLowerCase();
			const callsign = (ac.flight || "").trim();
			const latitude = ac.lat!;
			const longitude = ac.lon!;
			const altBaro = typeof ac.alt_baro === "number" ? ac.alt_baro : 0;
			const altitude = altBaro * 0.3048; // feet to meters
			const speed = ac.gs ?? 0; // knots
			const heading = ac.track ?? 0;
			const distance = calculateDistance(lat, lon, latitude, longitude);

			// Filter by actual radius (adsb.fi uses NM circle, we want km)
			if (distance > radiusKm) return null;

			return {
				icao24,
				callsign,
				latitude,
				longitude,
				altitude,
				speed,
				heading,
				distance,
				aircraft: {
					type: ac.t || undefined,
					model: ac.desc || ac.t || undefined,
					registration: ac.r || undefined,
				},
				origin: { id: "", name: "", country: "" },
				destination: { id: "", name: "", country: "" },
			};
		})
		.filter((f): f is Flight => f !== null);

	// Step 2: Sort by distance, take top 20 with a callsign
	const closest = allFlights
		.sort((a, b) => a.distance - b.distance)
		.filter((f) => f.callsign)
		.slice(0, 20);

	// Step 3: Enrich only these 20 with adsbdb route lookups
	await Promise.all(
		closest.map(async (flight) => {
			const route = await fetchRouteFromAdsbdb(flight.callsign);
			if (route) {
				flight.airline = route.airline;
				if (route.origin) flight.origin = route.origin;
				if (route.destination) flight.destination = route.destination;
			}
		})
	);

	// Step 4: Keep only flights that have origin or destination after enrichment
	return closest.filter((f) => f.origin.id || f.destination.id);
}

/**
 * Main function to fetch flights from both OpenSky and adsb.fi APIs and sort by distance
 */
export async function getNearbyFlights(lat: number, lon: number, radiusKm: number): Promise<ApiResponse> {
	// Validate parameters
	if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
		throw new Error("Invalid latitude/longitude values");
	}

	if (radiusKm <= 0 || radiusKm > 500) {
		throw new Error("Invalid radius. Must be between 0 and 500 km");
	}

	// Fetch from both APIs in parallel; failures are handled per-source
	const sourceNames = ["opensky", "adsbfi"] as const;
	const settled = await Promise.allSettled([
		fetchOpenSky(lat, lon, radiusKm),
		fetchAdsbFi(lat, lon, radiusKm),
	]);

	// Build sourcesUsed and collect flights only from fulfilled promises
	const sourcesUsed: string[] = [];
	const allFlights: Flight[] = [];

	settled.forEach((result, i) => {
		if (result.status === "fulfilled") {
			sourcesUsed.push(sourceNames[i]);
			allFlights.push(...result.value);
		} else {
			console.error(`Error fetching from ${sourceNames[i]}:`, result.reason);
		}
	});

	// Merge flights, using icao24 as unique identifier
	const flightMap = new Map<string, Flight>();

	allFlights.forEach((flight) => {
		// Ensure icao24 exists and is not empty before proceeding
		if (!flight.icao24) {
			return; // Skip flights without a valid ICAO24 identifier
		}

		// If we already have this flight, merge missing data (preferring existing data unless new data is present)
		if (flightMap.has(flight.icao24)) {
			const existingFlight = flightMap.get(flight.icao24)!;

			// Merge logic: Keep existing unless new is defined and existing is not, or specifically merge nested objects
			flightMap.set(flight.icao24, {
				...existingFlight, // Start with existing data
				callsign: existingFlight.callsign || flight.callsign,
				latitude: flight.latitude, // Always update position/status fields from the latest source (which might be adsb.fi if it came second)
				longitude: flight.longitude,
				altitude: flight.altitude,
				speed: flight.speed,
				heading: flight.heading,
				distance: flight.distance, // Update distance based on the latest position data
				airline: existingFlight.airline || flight.airline,
				aircraft: {
					type: existingFlight.aircraft.type || flight.aircraft.type,
					model: existingFlight.aircraft.model || flight.aircraft.model,
					registration: existingFlight.aircraft.registration || flight.aircraft.registration,
				},
				origin: {
					id: existingFlight.origin.id || flight.origin.id,
					name: existingFlight.origin.name || flight.origin.name,
					country: existingFlight.origin.country || flight.origin.country,
				},
				destination: {
					id: existingFlight.destination.id || flight.destination.id,
					name: existingFlight.destination.name || flight.destination.name,
					country: existingFlight.destination.country || flight.destination.country,
				},
			});
		} else {
			// Add new flight if it has an origin or destination ID
			if (flight.origin.id || flight.destination.id) {
				flightMap.set(flight.icao24, flight);
			}
		}
	});

	// Convert to array and sort by distance
	const flights = Array.from(flightMap.values()).sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));

	return {
		flights,
		source: sourcesUsed.join("+"),
		timestamp: Date.now(),
	};
}

/**
 * Pretty prints an array of flight objects with updated formatting, expanded aircraft models, and an airport list.
 *
 * @param flights An array of Flight objects.
 * @param icaoToModelMap A map to expand ICAO aircraft type codes to full model names.
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

		// Line 2: Origin -> Destination
		lines.push(`✈︎ ${flight.origin.id} → ${flight.destination.id}`);

		// Collect airport information
		airportMap.set(flight.origin.id, flight.origin.name);
		airportMap.set(flight.destination.id, flight.destination.name);

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
			const airlineName = airline_names[flight.airline] || flight.airline; // Use full name if available, otherwise fallback to code
			lines.push(airlineName);
		}

		return lines.join("\n");
	});

	const flightOutput = formattedFlights.join("\n\n");

	// Collect and format airport list
	const sortedAirportIds = Array.from(airportMap.keys()).sort();
	const airportList = sortedAirportIds.filter((id) => !!id).map((id) => `${id}: ${airportMap.get(id)}`);

	return flightOutput + "\n\n---\nAirports:\n" + airportList.join("\n");
}
