declare module "flightradar24-client" {
	export interface FlightRadar24Flight {
		id: string;
		registration: string;
		flight: string;
		callsign: string;
		origin?: string;
		destination?: string;

		latitude: number;
		longitude: number;
		altitude: number; // in feet
		bearing: number; // in degrees
		speed: number; // in knots
		rateOfClimb: number; // in ft/min
		isOnGround: boolean;

		squawkCode?: string;
		model?: string;
		modeSCode?: string;
		radar?: string;
		isGlider?: boolean;

		timestamp: number;
	}

	export interface FlightRadar24DetailedFlight {
		id: string;
		callsign: string;
		liveData: boolean;
		model: string;
		registration: string;
		airline: string;
		origin: {
			id: string;
			name: string;
			coordinates: {
				latitude: number;
				longitude: number;
				altitude: number;
			};
			timezone: string;
			country: string;
		};
		destination: {
			id: string;
			name: string;
			coordinates: {
				latitude: number;
				longitude: number;
				altitude: number;
			};
			timezone: string;
			country: string;
		};
		departure: string;
		scheduledDeparture: string;
		departureTerminal: string | null;
		departureGate: string | null;
		arrival: string;
		scheduledArrival: string;
		arrivalTerminal: string | null;
		arrivalGate: string | null;
		delay: number;
	}

	export function fetchFromRadar(north: number, west: number, south: number, east: number): Promise<FlightRadar24Flight[]>;

	export function fetchFlight(id: string): Promise<FlightRadar24DetailedFlight>;
}
