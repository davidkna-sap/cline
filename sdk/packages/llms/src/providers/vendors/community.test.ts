import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchClientCredentialsTokenMock = vi.fn();
let lastXsuaaServiceArgs: unknown[] = [];

vi.mock("@sap/xssec", () => {
	class MockXsuaaService {
		constructor(...args: unknown[]) {
			lastXsuaaServiceArgs = args;
		}
		fetchClientCredentialsToken = fetchClientCredentialsTokenMock;
	}
	return { XsuaaService: MockXsuaaService };
});

const { createSapAiCoreProviderModule } = await import("./community");

function mockToken(accessToken = "test-access-token") {
	fetchClientCredentialsTokenMock.mockResolvedValue({
		access_token: accessToken,
		expires_in: 3600,
		token_type: "bearer",
	});
}

describe("createSapAiCoreProviderModule", () => {
	beforeEach(() => {
		fetchClientCredentialsTokenMock.mockReset();
		lastXsuaaServiceArgs = [];
	});

	it("fetches OAuth token via xssec XsuaaService and builds destination with authTokens", async () => {
		mockToken("my-bearer-token");
		const mockFetch = vi.fn();

		const provider = await createSapAiCoreProviderModule({
			providerId: "sapaicore",
			baseUrl: "https://api.ai.example.aws.ml.hana.ondemand.com",
			fetch: mockFetch as unknown as typeof fetch,
			options: {
				clientId: "sap-client",
				clientSecret: "sap-secret",
				tokenUrl: "https://auth.example/oauth/token",
				deploymentId: "deployment-id",
			},
		});

		// XsuaaService should have been constructed with the right credentials
		// and CA material forwarded through xssec's Node http/https request path.
		expect(lastXsuaaServiceArgs[0]).toMatchObject({
			clientid: "sap-client",
			clientsecret: "sap-secret",
			url: "https://auth.example",
		});
		expect(lastXsuaaServiceArgs[1]).toMatchObject({
			requests: {
				ca: expect.any(Array),
			},
		});
		expect(fetchClientCredentialsTokenMock).toHaveBeenCalled();

		const model = provider.model("anthropic--claude-4.6-sonnet") as {
			config?: {
				destination?: Record<string, unknown>;
				deploymentConfig?: Record<string, unknown>;
				providerApi?: string;
			};
		};

		// Destination should carry the token fetched via xssec in authTokens
		expect(model.config?.destination).toMatchObject({
			url: "https://api.ai.example.aws.ml.hana.ondemand.com",
			authentication: "OAuth2ClientCredentials",
			authTokens: [
				expect.objectContaining({
					type: "Bearer",
					value: "my-bearer-token",
					http_header: {
						key: "Authorization",
						value: "Bearer my-bearer-token",
					},
				}),
			],
		});
		expect(model.config?.deploymentConfig).toMatchObject({
			deploymentId: "deployment-id",
		});
		expect(model.config?.providerApi).toBe("orchestration");
	});

	it("normalizes token URLs ending in /oauth/token", async () => {
		mockToken();

		await createSapAiCoreProviderModule({
			providerId: "sapaicore",
			baseUrl: "https://api.ai.example.aws.ml.hana.ondemand.com/",
			options: {
				clientId: "sap-client",
				clientSecret: "sap-secret",
				tokenUrl: "https://auth.example/oauth/token",
			},
		});

		// Token base URL should not include a trailing /oauth/token
		expect(lastXsuaaServiceArgs[0]).toMatchObject({
			url: "https://auth.example",
		});
	});

	it("uses no destination when no explicit SAP credentials are configured", async () => {
		const provider = await createSapAiCoreProviderModule({
			providerId: "sapaicore",
			options: {},
		});

		const model = provider.model("anthropic--claude-4.6-sonnet") as {
			config?: { destination?: Record<string, unknown> };
		};

		expect(fetchClientCredentialsTokenMock).not.toHaveBeenCalled();
		expect(model.config?.destination).toBeUndefined();
	});

	it("uses resource group deployment resolution for orchestration mode", async () => {
		mockToken();

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
		expect(model.config?.requestConfig?.headers?.["ai-client-type"]).toBe("Cline");
		expect(model.config?.requestConfig?.maxBodyLength).toBe(Number.POSITIVE_INFINITY);
		expect(model.config?.requestConfig?.maxContentLength).toBe(Number.POSITIVE_INFINITY);
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
});
