import { fetchFlight, fetchFromRadar } from "flightradar24-client";
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
	try {
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
	} catch (err) {
		console.error("Error fetching from OpenSky:", err);
		return [];
	}
}

/**
 * Fetch flights from FlightRadar24 API
 */
async function fetchFlightRadar24(lat: number, lon: number, radiusKm: number): Promise<Flight[]> {
	try {
		// Calculate bounding box
		const approxLatDegrees = radiusKm / 111;
		const approxLonDegrees = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));

		const north = lat + approxLatDegrees;
		const south = lat - approxLatDegrees;
		const east = lon + approxLonDegrees;
		const west = lon - approxLonDegrees;

		const radarFlights = await fetchFromRadar(north, west, south, east);

		// Process each flight
		const detailedFlightsPromises = radarFlights.map(async (flight): Promise<Flight | null> => {
			const icao24 = flight.modeSCode?.toLowerCase() || "";
			if (!icao24) return null; // Skip if no ICAO24

			const distance = calculateDistance(lat, lon, flight.latitude, flight.longitude);

			const basicFlight: Flight = {
				icao24,
				callsign: flight.callsign || flight.flight || "",
				latitude: flight.latitude,
				longitude: flight.longitude,
				altitude: flight.altitude * 0.3048, // Convert feet to meters
				speed: flight.speed, // Speed in knots
				heading: flight.bearing,
				distance,
				aircraft: {
					type: flight.model || undefined, // Use model as type initially
					model: flight.model || undefined,
					registration: flight.registration || undefined,
				},
				origin: {
					id: flight.origin || "",
					name: "", // Will be filled by detailed info if available
					country: "", // Will be filled by detailed info if available
				},
				destination: {
					id: flight.destination || "",
					name: "", // Will be filled by detailed info if available
					country: "", // Will be filled by detailed info if available
				},
			};

			// Fetch detailed information if available
			try {
				if (flight.id) {
					const detailedInfo = await fetchFlight(flight.id);

					if (detailedInfo) {
						basicFlight.airline = detailedInfo.airline || undefined;
						basicFlight.aircraft.model = detailedInfo.model || basicFlight.aircraft.model;
						basicFlight.aircraft.type = detailedInfo.model || basicFlight.aircraft.type; // Update type as well

						// Origin information
						if (detailedInfo.origin) {
							basicFlight.origin.id = detailedInfo.origin.id || basicFlight.origin.id;
							basicFlight.origin.name = detailedInfo.origin.name || "";
							basicFlight.origin.country = detailedInfo.origin.country || "";
						}

						// Destination information
						if (detailedInfo.destination) {
							basicFlight.destination.id = detailedInfo.destination.id || basicFlight.destination.id;
							basicFlight.destination.name = detailedInfo.destination.name || "";
							basicFlight.destination.country = detailedInfo.destination.country || "";
						}
					}
				}
			} catch (detailErr) {
				// console.log(`🦔 ~ radarFlights.map ~ detailErr:`, detailErr); // Keep commented out unless debugging
				console.warn(`Could not fetch detailed information for flight ${flight.id || flight.callsign}`);
			}

			// Only return if we have at least origin or destination airport ID
			if (basicFlight.origin.id || basicFlight.destination.id) {
				return basicFlight;
			}
			return null; // Discard if no airport info found
		});

		const detailedFlights = await Promise.all(detailedFlightsPromises);

		// Filter out null values
		return detailedFlights.filter((f): f is Flight => f !== null);
	} catch (err) {
		console.error("Error fetching from FlightRadar24:", err);
		return [];
	}
}

/**
 * Main function to fetch flights from both OpenSky and FlightRadar24 APIs and sort by distance
 */
export async function getNearbyFlights(lat: number, lon: number, radiusKm: number): Promise<ApiResponse> {
	// Validate parameters
	if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
		console.log(lat, lon);
		throw new Error("Invalid latitude/longitude values");
	}

	if (radiusKm <= 0 || radiusKm > 500) {
		throw new Error("Invalid radius. Must be between 0 and 500 km");
	}

	// Always fetch from both APIs
	const promises: Promise<Flight[]>[] = [];
	const sourcesUsed = ["opensky", "flightradar24"];

	// Order matters: OpenSky first, FlightRadar24 second (for merging preference)
	promises.push(fetchOpenSky(lat, lon, radiusKm));
	promises.push(fetchFlightRadar24(lat, lon, radiusKm));

	// Fetch from all APIs in parallel
	const results = await Promise.all(promises);

	// Merge flights, using icao24 as unique identifier
	const flightMap = new Map<string, Flight>();

	results.flat().forEach((flight) => {
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
				latitude: flight.latitude, // Always update position/status fields from the latest source (which might be FR24 if it came second)
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
	let flights = Array.from(flightMap.values()).sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
	// console.log(`🦔 ~ getNearbyFlights ~ flights:`, flights);

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
