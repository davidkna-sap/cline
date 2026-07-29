// Minimal ambient type declarations for @sap/xssec.
//
// Background: the workspace root package.json currently overrides
// `@sap/xssec` to a local sibling checkout (`file:../node-xs2sec`) for
// testing an unreleased xssec change. That sibling checkout has not run
// `npm run generateTypes`, so `./types/index.d.ts` (referenced by its
// package.json `typings` field) does not exist, and TypeScript fails to
// resolve the module (TS2307).
//
// Remove this file once the override is dropped in favor of a published
// `@sap/xssec` version (which ships built type declarations), or once the
// sibling checkout's types are generated/committed.
declare module "@sap/xssec" {
	export interface XsuaaServiceCredentials {
		clientid: string;
		clientsecret?: string;
		url?: string;
		certurl?: string;
		uaadomain?: string;
	}

	export interface ServiceConfig {
		fetchFunction?: (
			url: string | URL,
			init: Record<string, unknown>,
		) => Promise<Response>;
		requests?: {
			agent?: unknown;
			ca?: string | string[];
			timeout?: number;
		};
	}

	export interface TokenFetchResponse {
		access_token: string;
		expires_in: number;
		token_type: string;
	}

	export interface TokenFetchOptions {
		correlationId?: string;
		timeout?: number;
		token_format?: "jwt" | "opaque";
	}

	export class XsuaaService {
		constructor(
			credentials: XsuaaServiceCredentials,
			serviceConfig?: ServiceConfig,
		);
		fetchClientCredentialsToken(
			options?: TokenFetchOptions,
		): Promise<TokenFetchResponse>;
	}
}
