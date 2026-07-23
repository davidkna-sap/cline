export interface SapAiCoreTokenCredentials {
	clientId: string;
	clientSecret: string;
	tokenUrl: string;
}

export interface SapAiCoreToken {
	value: string;
	refreshAt: number;
}

export interface SapAiCoreTokenRequestOptions {
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
}

const SAP_TOKEN_REFRESH_BUFFER_MS = 60_000;
const SAP_TOKEN_TIMEOUT_MS = 30_000;

function normalizeTokenUrl(tokenUrl: string): string {
	return `${tokenUrl.replace(/\/+$/, "").replace(/\/oauth\/token$/i, "")}/oauth/token`;
}

export async function fetchSapAiCoreToken(
	credentials: SapAiCoreTokenCredentials,
	options: SapAiCoreTokenRequestOptions = {},
): Promise<SapAiCoreToken> {
	const fetchFn = options.fetch ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? SAP_TOKEN_TIMEOUT_MS;
	const response = await fetchFn(normalizeTokenUrl(credentials.tokenUrl), {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "client_credentials",
			client_id: credentials.clientId,
			client_secret: credentials.clientSecret,
		}).toString(),
		signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(
			`SAP AI Core token fetch failed with HTTP ${response.status}${text ? `: ${text}` : ""}`,
		);
	}

	const data = (await response.json()) as {
		access_token?: unknown;
		expires_in?: unknown;
	};
	if (
		typeof data.access_token !== "string" ||
		data.access_token.length === 0 ||
		typeof data.expires_in !== "number" ||
		!Number.isFinite(data.expires_in) ||
		data.expires_in < 0
	) {
		throw new Error("SAP AI Core token response is invalid.");
	}
	return {
		value: data.access_token,
		refreshAt:
			Date.now() +
			Math.max(data.expires_in * 1000 - SAP_TOKEN_REFRESH_BUFFER_MS, 0),
	};
}

export function createSapAiCoreTokenGetter(
	credentials: SapAiCoreTokenCredentials,
	options: SapAiCoreTokenRequestOptions = {},
): () => Promise<string> {
	let cached: SapAiCoreToken | undefined;
	let pending: Promise<SapAiCoreToken> | undefined;

	return async () => {
		if (!cached || Date.now() >= cached.refreshAt) {
			pending ??= fetchSapAiCoreToken(credentials, options).finally(() => {
				pending = undefined;
			});
			cached = await pending;
		}
		return cached.value;
	};
}
