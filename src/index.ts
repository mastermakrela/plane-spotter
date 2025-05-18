import { Bool, Num, OpenAPIRoute, fromHono } from "chanfana";
import { Hono } from "hono";
import { z } from "zod";
import { getNearbyFlights, prettyPrintFlights } from "./utils";

// Start a Hono app
const app = new Hono();

// Setup OpenAPI registry
const openapi = fromHono(app, {
	docs_url: "/",
});

// API key middleware
const apiKeyMiddleware = async (c, next) => {
	const apiKey = c.req.header("api-key");

	if (!apiKey || apiKey !== process.env.API_KEY) {
		return new Response(
			JSON.stringify({
				success: false,
				error: "Unauthorized: Invalid or missing API key",
			}),
			{
				status: 401,
				headers: {
					"content-type": "application/json",
				},
			}
		);
	}

	await next();
};

// Add API key middleware to all routes
app.use("*", apiKeyMiddleware);

// Define the flights endpoint class
class NearbyFlights extends OpenAPIRoute {
	schema = {
		tags: ["Flights"],
		summary: "Get nearby flights",
		security: [{ ApiKeyAuth: [] }],
		request: {
			headers: z.object({
				"API-Key": z.string().describe("API Key for authentication"), // required header
			}),
			body: {
				content: {
					"application/json": {
						schema: z.object({
							lat: Num({ description: "Latitude between -90 and 90" }),
							lon: Num({ description: "Longitude between -180 and 180" }),
							radius: Num({ description: "Search radius in kilometers" }).optional().default(10),
							"pretty-print": z
								.boolean()
								.optional()
								.default(false)
								.describe("Return a human-readable plain text response instead of JSON"),
						}),
					},
				},
			},
		},
		responses: {
			"200": {
				description: "Returns nearby flights within 10km radius, either as JSON or plain text",
				content: {
					"application/json": {
						schema: z.object({
							// series: z.object({ // Chanfana might auto-wrap this, adjust if needed
							success: Bool(),
							flights: z.array(z.any()),
							source: z.string(),
							timestamp: z.number(),
							// }),
						}),
					},
					"text/plain": {
						schema: z.string().describe("Pretty-printed list of flights"),
					},
				},
			},
			"400": {
				description: "Invalid request parameters",
				content: {
					"application/json": {
						schema: z.object({
							series: z.object({
								success: Bool(),
								error: z.string(),
							}),
						}),
					},
				},
			},
			"401": {
				description: "Unauthorized - Invalid API key",
				content: {
					"application/json": {
						schema: z.object({
							series: z.object({
								success: Bool(),
								error: z.string(),
							}),
						}),
					},
				},
			},
		},
	};

	async handle(c) {
		// Add 'any' type for c if not already strongly typed by Hono/Chanfana context
		let requestBody; // To store request body for logging in case of error
		let rawFlightResultJson: string | null = null; // To store raw result from getNearbyFlights

		try {
			// Get validated data
			const data = await this.getValidatedData<typeof this.schema>();
			requestBody = data.body; // Store for potential error logging

			console.log(`🦔 ~ NearbyFlights ~ handle ~ data.body:`, data.body);
			// Retrieve the validated coordinates and pretty-print flag
			const { lat, lon, radius } = data.body;
			const prettyPrint = data.body["pretty-print"]; // Access using bracket notation due to hyphen

			// Use the provided or default radius
			const radiusKm = radius;

			// Get nearby flights using the utility function
			const result = await getNearbyFlights(lat, lon, radiusKm);
			rawFlightResultJson = JSON.stringify(result); // Store raw result

			let finalResponse;
			let responseBodyToLog: string;
			let responseTypeToLog: string;
			let responseIsSuccess = true;

			if (prettyPrint) {
				const prettyText = prettyPrintFlights(result.flights);
				responseBodyToLog = prettyText;
				responseTypeToLog = "text/plain";
				finalResponse = c.text(prettyText, 200, { "Content-Type": "text/plain" });
			} else {
				const jsonResponseObject = {
					success: true,
					...result,
				};
				responseBodyToLog = JSON.stringify(jsonResponseObject);
				responseTypeToLog = "application/json";
				responseIsSuccess = jsonResponseObject.success;
				finalResponse = c.json(jsonResponseObject);
			}

			// D1 Logging for successful response
			if (c.env.DB) {
				try {
					const stmt = c.env.DB.prepare(
						`INSERT INTO request_logs (timestamp, latitude, longitude, radius, request_pretty_print, response_type, response_body, response_success, raw_flight_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
					);
					await stmt
						.bind(
							new Date().toISOString(),
							lat,
							lon,
							radiusKm,
							prettyPrint ? 1 : 0,
							responseTypeToLog,
							responseBodyToLog,
							responseIsSuccess ? 1 : 0,
							rawFlightResultJson
						)
						.run();
				} catch (dbError: any) {
					console.error(
						"D1 logging failed for successful response:",
						dbError.message,
						dbError.cause ? dbError.cause.message : ""
					);
				}
			} else {
				console.warn("D1 binding 'DB' not found in environment. Skipping logging for successful response.");
			}

			return finalResponse;
		} catch (error: any) {
			const errorResponse = {
				success: false,
				error: error.message || "An error occurred while fetching flights",
			};

			// D1 Logging for error response
			if (c.env.DB) {
				try {
					const errorLat = requestBody?.lat ?? null;
					const errorLon = requestBody?.lon ?? null;
					const errorRadius = requestBody?.radius ?? null;
					const errorPrettyPrint = requestBody?.["pretty-print"] ?? false;

					const stmt = c.env.DB.prepare(
						`INSERT INTO request_logs (timestamp, latitude, longitude, radius, request_pretty_print, response_type, response_body, response_success, raw_flight_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
					);
					await stmt
						.bind(
							new Date().toISOString(),
							errorLat,
							errorLon,
							errorRadius,
							errorPrettyPrint ? 1 : 0,
							"application/json", // Error response is JSON
							JSON.stringify(errorResponse),
							0, // success is false
							rawFlightResultJson // Log raw flight data even in case of error, if available
						)
						.run();
				} catch (dbError: any) {
					console.error("D1 logging failed for error response:", dbError.message, dbError.cause ? dbError.cause.message : "");
				}
			} else {
				console.warn("D1 binding 'DB' not found in environment. Skipping logging for error response.");
			}

			return c.json(errorResponse, 400);
		}
	}
}

// Define OpenAPI components for security
// openapi.addComponents({
// 	securitySchemes: {
// 		ApiKeyAuth: {
// 			type: "apiKey",
// 			in: "header",
// 			name: "api-key",
// 		},
// 	},
// });

// Register the flights endpoint
openapi.post("/api/flights/nearby", NearbyFlights);

// Export the Hono app
export default app;
