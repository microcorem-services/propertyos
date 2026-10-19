import 'server-only';

import * as oidc from 'openid-client';
import type { CustomFetch } from 'openid-client';

const OIDC_TIMEOUT_MS = 5_000;
const CALLBACK_PATH = '/api/auth/callback';

export type CognitoConfiguration = {
  issuer: URL;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  callbackUrl: URL;
  appOrigin: URL;
};

export class CognitoConfigurationError extends Error {
  constructor() {
    super('Cognito OIDC configuration is invalid or incomplete.');
    this.name = 'CognitoConfigurationError';
  }
}

export function loadAppOrigin(
  environment: Record<string, string | undefined> = process.env,
): URL {
  const appOriginValue = environment.APP_ORIGIN?.trim();
  if (!appOriginValue) throw new CognitoConfigurationError();
  try {
    const appOrigin = new URL(appOriginValue);
    const isProduction = environment.NODE_ENV === 'production';
    const isLoopback =
      appOrigin.hostname === 'localhost' ||
      appOrigin.hostname === '127.0.0.1' ||
      appOrigin.hostname === '[::1]';
    if (
      appOrigin.pathname !== '/' ||
      appOrigin.search ||
      appOrigin.hash ||
      appOrigin.username ||
      appOrigin.password ||
      (appOrigin.protocol !== 'https:' && (isProduction || !isLoopback))
    ) {
      throw new CognitoConfigurationError();
    }
    return appOrigin;
  } catch {
    throw new CognitoConfigurationError();
  }
}

export function loadCognitoConfiguration(
  environment: Record<string, string | undefined> = process.env,
): CognitoConfiguration {
  const issuerValue = environment.COGNITO_ISSUER?.trim();
  const clientId = environment.COGNITO_CLIENT_ID?.trim();
  const clientSecret = environment.COGNITO_CLIENT_SECRET?.trim();
  const scopesValue = environment.COGNITO_SCOPES?.trim() || 'openid';
  const callbackValue = environment.COGNITO_CALLBACK_URL?.trim();
  const scopes = scopesValue.split(/\s+/);
  if (
    !issuerValue ||
    !clientId ||
    !clientSecret ||
    !callbackValue ||
    !scopes.includes('openid') ||
    new Set(scopes).size !== scopes.length ||
    scopes.some((scope) => !/^[A-Za-z0-9:_./-]+$/.test(scope))
  ) {
    throw new CognitoConfigurationError();
  }

  try {
    const issuer = new URL(issuerValue);
    const callbackUrl = new URL(callbackValue);
    const appOrigin = loadAppOrigin(environment);
    const isProduction = environment.NODE_ENV === 'production';
    const isCallbackLoopback =
      callbackUrl.hostname === 'localhost' ||
      callbackUrl.hostname === '127.0.0.1' ||
      callbackUrl.hostname === '[::1]';
    if (
      issuer.protocol !== 'https:' ||
      issuer.username ||
      issuer.password ||
      issuer.search ||
      issuer.hash ||
      callbackUrl.pathname !== CALLBACK_PATH ||
      callbackUrl.search ||
      callbackUrl.hash ||
      callbackUrl.username ||
      callbackUrl.password ||
      callbackUrl.origin !== appOrigin.origin ||
      (callbackUrl.protocol !== 'https:' && (isProduction || !isCallbackLoopback))
    ) {
      throw new CognitoConfigurationError();
    }
    return { issuer, clientId, clientSecret, scopes, callbackUrl, appOrigin };
  } catch {
    throw new CognitoConfigurationError();
  }
}

let configurationPromise: Promise<oidc.Configuration> | undefined;

const timeoutFetch: CustomFetch = (url, options) =>
  fetch(url, {
    ...options,
    body: options.body as BodyInit,
    signal: AbortSignal.timeout(OIDC_TIMEOUT_MS),
  });

export function getCognitoOidcClient(
  configuration = loadCognitoConfiguration(),
): Promise<oidc.Configuration> {
  if (!configurationPromise) {
    configurationPromise = oidc.discovery(
      configuration.issuer,
      configuration.clientId,
      undefined,
      oidc.ClientSecretBasic(configuration.clientSecret),
      { [oidc.customFetch]: timeoutFetch },
    ).catch((error: unknown) => {
      configurationPromise = undefined;
      throw error;
    });
  }
  return configurationPromise;
}

export function resetCognitoOidcClientForTests(): void {
  configurationPromise = undefined;
}
