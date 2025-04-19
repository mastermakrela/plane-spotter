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
		try {
			// Get validated data
			const data = await this.getValidatedData<typeof this.schema>();

			console.log(`🦔 ~ NearbyFlights ~ handle ~ data.body:`, data.body);
			// Retrieve the validated coordinates and pretty-print flag
			const { lat, lon, radius } = data.body;
			const prettyPrint = data.body["pretty-print"]; // Access using bracket notation due to hyphen

			// Use the provided or default radius
			const radiusKm = radius;

			// Get nearby flights using the utility function
			const result = await getNearbyFlights(lat, lon, radiusKm);

			if (prettyPrint) {
				const prettyText = prettyPrintFlights(result.flights);
				return new Response(prettyText, {
					headers: { "Content-Type": "text/plain" },
				});
			} else {
				// Return JSON response (Chanfana might handle wrapping this in { series: ... } automatically)
				return {
					success: true,
					...result,
				};
			}
		} catch (error) {
			return Response.json(
				{
					success: false,
					error: error.message || "An error occurred while fetching flights",
				},
				{
					status: 400,
				}
			);
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
