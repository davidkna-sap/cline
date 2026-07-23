import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSapAiCoreProviderModule } from "./community";

function makeTokenResponse(accessToken: string, expiresIn = 3600) {
	return new Response(
		JSON.stringify({ access_token: accessToken, expires_in: expiresIn }),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

function makeConfig(overrides: Record<string, unknown> = {}) {
	return {
		providerId: "sapaicore",
		baseUrl: "https://api.ai.example.aws.ml.hana.ondemand.com",
		options: {
			clientId: "sap-client",
			clientSecret: "sap-secret",
			tokenUrl: "https://auth.example/oauth/token",
			deploymentId: "deployment-id",
		},
		...overrides,
	};
}

interface TestRequest {
	headers?: Record<string, unknown>;
	[key: string]: unknown;
}

type TestMiddleware = (options: {
	fn: (request: TestRequest) => Promise<TestRequest>;
}) => (request: TestRequest) => Promise<TestRequest>;

interface TestSapModel {
	config?: {
		destination?: Record<string, unknown>;
		requestConfig?: {
			middleware?: TestMiddleware[];
		};
	};
}

async function runAuthMiddleware(model: TestSapModel): Promise<TestRequest> {
	const middleware = model.config?.requestConfig?.middleware?.[0];
	if (!middleware) {
		throw new Error("SAP auth middleware is missing");
	}
	return middleware({ fn: async (request) => request })({
		method: "POST",
		headers: {},
	});
}

describe("createSapAiCoreProviderModule", () => {
	let fetchMock: typeof fetch & ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn() as unknown as typeof fetch & ReturnType<typeof vi.fn>;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("fetches a token and injects it through request middleware", async () => {
		fetchMock.mockResolvedValueOnce(makeTokenResponse("tok-initial"));

		const provider = await createSapAiCoreProviderModule({
			...makeConfig(),
			fetch: fetchMock,
		});

		expect(fetchMock).not.toHaveBeenCalled();
		const model = provider.model(
			"anthropic--claude-4.6-sonnet",
		) as TestSapModel;
		expect(model.config?.destination).toMatchObject({
			url: "https://api.ai.example.aws.ml.hana.ondemand.com",
			authentication: "NoAuthentication",
		});

		const request = await runAuthMiddleware(model);
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://auth.example/oauth/token");
		const body = new URLSearchParams(init.body as string);
		expect(body.get("grant_type")).toBe("client_credentials");
		expect(body.get("client_id")).toBe("sap-client");
		expect(body.get("client_secret")).toBe("sap-secret");
		expect(request.headers?.Authorization).toBe("Bearer tok-initial");
	});

	it("reuses a valid token for model requests", async () => {
		fetchMock.mockResolvedValue(makeTokenResponse("tok-cached", 3600));

		const provider = await createSapAiCoreProviderModule({
			...makeConfig(),
			fetch: fetchMock,
		});

		const model = provider.model("model-a") as TestSapModel;

		await Promise.all([runAuthMiddleware(model), runAuthMiddleware(model)]);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("refreshes a token before it expires", async () => {
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		fetchMock
			.mockResolvedValueOnce(makeTokenResponse("tok-first", 120))
			.mockResolvedValueOnce(makeTokenResponse("tok-refreshed", 3600));

		const provider = await createSapAiCoreProviderModule({
			...makeConfig(),
			fetch: fetchMock,
		});
		const model = provider.model(
			"anthropic--claude-4.6-sonnet",
		) as TestSapModel;

		await runAuthMiddleware(model);
		now += 60_000;
		const requests = await Promise.all([
			runAuthMiddleware(model),
			runAuthMiddleware(model),
		]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(requests[0].headers?.Authorization).toBe("Bearer tok-refreshed");
		expect(requests[1].headers?.Authorization).toBe("Bearer tok-refreshed");
	});

	it("does not cache a token past a short declared lifetime", async () => {
		fetchMock
			.mockResolvedValueOnce(makeTokenResponse("tok-short", 10))
			.mockResolvedValueOnce(makeTokenResponse("tok-next", 3600));
		const provider = await createSapAiCoreProviderModule({
			...makeConfig(),
			fetch: fetchMock,
		});
		const model = provider.model("model-a") as TestSapModel;

		await runAuthMiddleware(model);
		await runAuthMiddleware(model);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("uses resource group for orchestration mode", async () => {
		fetchMock.mockResolvedValueOnce(makeTokenResponse("tok-orch"));

		const provider = await createSapAiCoreProviderModule({
			providerId: "sapaicore",
			baseUrl: "https://api.ai.example.aws.ml.hana.ondemand.com",
			options: {
				clientId: "sap-client",
				clientSecret: "sap-secret",
				tokenUrl: "https://auth.example",
				resourceGroup: "default",
				useOrchestrationMode: true,
			},
			fetch: fetchMock,
		});

		const model = provider.model("anthropic--claude-4.6-sonnet") as {
			config?: {
				deploymentConfig?: Record<string, unknown>;
				providerApi?: string;
			};
		};

		expect(model.config?.deploymentConfig).toMatchObject({
			resourceGroup: "default",
		});
		expect(model.config?.deploymentConfig).not.toHaveProperty("deploymentId");
		expect(model.config?.providerApi).toBe("orchestration");
	});

	it("sets requestConfig with fetch adapter and Cline client-type header", async () => {
		const provider = await createSapAiCoreProviderModule({
			providerId: "sapaicore",
			baseUrl: "https://api.ai.example.aws.ml.hana.ondemand.com",
			options: {
				clientId: "sap-client",
				clientSecret: "sap-secret",
				tokenUrl: "https://auth.example",
			},
		});

		const model = provider.model("anthropic--claude-4.6-sonnet") as {
			config?: {
				requestConfig?: {
					adapter?: string;
					headers?: Record<string, string>;
					fetch?: unknown;
					maxBodyLength?: number;
					maxContentLength?: number;
				};
			};
		};

		expect(model.config?.requestConfig?.adapter).toBe("fetch");
		expect(model.config?.requestConfig?.headers?.["ai-client-type"]).toBe(
			"Cline",
		);
		expect(model.config?.requestConfig?.maxBodyLength).toBe(
			Number.POSITIVE_INFINITY,
		);
		expect(model.config?.requestConfig?.maxContentLength).toBe(
			Number.POSITIVE_INFINITY,
		);
		expect(model.config?.requestConfig?.fetch).toBeUndefined();
	});

	it("forwards custom fetch function via requestConfig.fetch", async () => {
		const customFetch = globalThis.fetch as unknown as typeof fetch;

		const provider = await createSapAiCoreProviderModule({
			providerId: "sapaicore",
			baseUrl: "https://api.ai.example.aws.ml.hana.ondemand.com",
			fetch: customFetch,
			options: {
				clientId: "sap-client",
				clientSecret: "sap-secret",
				tokenUrl: "https://auth.example",
			},
		});

		const model = provider.model("anthropic--claude-4.6-sonnet") as {
			config?: {
				requestConfig?: { fetch?: unknown };
			};
		};

		expect(model.config?.requestConfig?.fetch).toBe(customFetch);
	});

	it("leaves default environment-based configuration untouched", async () => {
		const provider = await createSapAiCoreProviderModule({
			providerId: "sapaicore",
			options: {},
		});

		const model = provider.model("anthropic--claude-4.6-sonnet") as {
			config?: { destination?: Record<string, unknown> };
		};
		expect(model.config?.destination).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("fails fast for partial explicit SAP configuration", async () => {
		await expect(
			createSapAiCoreProviderModule({
				providerId: "sapaicore",
				options: {
					clientId: "sap-client",
					clientSecret: "sap-secret",
					tokenUrl: "https://auth.example",
				},
			}),
		).rejects.toThrow(/baseUrl/);
	});

	it("throws when token fetch returns non-2xx", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response("Unauthorized", { status: 401 }),
		);

		const provider = await createSapAiCoreProviderModule({
			...makeConfig(),
			fetch: fetchMock,
		});
		await expect(
			runAuthMiddleware(provider.model("model-a") as TestSapModel),
		).rejects.toThrow(/401/);
	});

	it("times out token requests", async () => {
		const hangingFetch = vi.fn(
			(_input: RequestInfo | URL, init?: RequestInit) => {
				const signal = init?.signal;
				if (!signal) {
					return Promise.reject(new Error("Missing timeout signal"));
				}
				return new Promise<Response>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				});
			},
		) as typeof fetch;

		const provider = await createSapAiCoreProviderModule({
			...makeConfig(),
			fetch: hangingFetch,
			timeoutMs: 1,
		});
		await expect(
			runAuthMiddleware(provider.model("model-a") as TestSapModel),
		).rejects.toMatchObject({ name: "TimeoutError" });
	});

	it("throws when the token response is invalid", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ expires_in: 3600 }), { status: 200 }),
		);

		const provider = await createSapAiCoreProviderModule({
			...makeConfig(),
			fetch: fetchMock,
		});
		await expect(
			runAuthMiddleware(provider.model("model-a") as TestSapModel),
		).rejects.toThrow("SAP AI Core token response is invalid.");
	});
});
