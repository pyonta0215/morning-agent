// ============================================================
// GENERATED FILE — DO NOT EDIT
//
// imai-auth shared browser auth client
// version: 1.1.0
// source:  https://github.com/pyonta0215/imai-auth  packages/browser/
//
// 直したいときは imai-auth 側を直し、release から vendor 更新 PR を
// 受け取ること。ここを手で書き換えると次の同期で失われる。
// ============================================================

// packages/browser/src/imai-auth-browser.ts
var AuthFatalError = class extends Error {
  kind = "fatal";
  constructor(message, options) {
    super(message, options);
    this.name = "AuthFatalError";
  }
};
var AuthTransientError = class extends Error {
  kind = "transient";
  constructor(message, options) {
    super(message, options);
    this.name = "AuthTransientError";
  }
};
function isTransient(error) {
  return error instanceof AuthTransientError;
}
var AuthSignedOutError = class extends Error {
  kind = "signed-out";
  constructor() {
    super("signed out from this product");
    this.name = "AuthSignedOutError";
  }
};
function isSignedOut(error) {
  return error instanceof AuthSignedOutError;
}
function base64Url(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomString(byteLength, cryptoApi) {
  const bytes = new Uint8Array(byteLength);
  cryptoApi.getRandomValues(bytes);
  return base64Url(bytes);
}
async function pkceChallenge(verifier, cryptoApi) {
  const digest = await cryptoApi.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(digest);
}
function createMemoryStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    async read(key) {
      return values.get(key) ?? null;
    },
    async write(key, value) {
      values.set(key, value);
    },
    async remove(key) {
      values.delete(key);
    }
  };
}
var STORE_NAME = "tokens";
function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function openDatabase(factory, name) {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("indexedDB open blocked"));
  });
}
function createIndexedDbStore(namespace, factory) {
  const dbName = `imai-auth:${namespace}`;
  let fallback = null;
  let opening = null;
  async function connect() {
    if (!opening) {
      opening = openDatabase(factory, dbName).catch((cause) => {
        opening = null;
        throw cause;
      });
    }
    return opening;
  }
  async function withStore(mode, run) {
    const connection = await connect();
    const transaction = connection.transaction(STORE_NAME, mode);
    return promisify(run(transaction.objectStore(STORE_NAME)));
  }
  function degrade() {
    if (!fallback) fallback = createMemoryStore();
    return fallback;
  }
  return {
    async read(key) {
      if (fallback) return fallback.read(key);
      try {
        const value = await withStore("readonly", (store) => store.get(key));
        return typeof value === "string" ? value : null;
      } catch {
        return degrade().read(key);
      }
    },
    async write(key, value) {
      if (fallback) return fallback.write(key, value);
      try {
        await withStore("readwrite", (store) => store.put(value, key));
      } catch {
        await degrade().write(key, value);
      }
    },
    async remove(key) {
      if (fallback) return fallback.remove(key);
      try {
        await withStore("readwrite", (store) => store.delete(key));
      } catch {
        await degrade().remove(key);
      }
    }
  };
}
var DEFAULT_AUTH_DOMAIN = "https://auth.imai.me";
var DEFAULT_SCOPES = "openid email aws.cognito.signin.user.admin";
var EXPIRY_MARGIN_MS = 6e4;
var RT_KEY = "refresh_token";
var SIGNED_OUT_KEY = "signed_out";
var PKCE_KEY = "imai-auth:pkce";
var OAUTH_PARAMS = ["code", "state", "error", "error_description", "error_uri"];
var FATAL_OAUTH_ERRORS = /* @__PURE__ */ new Set(["invalid_grant", "invalid_client", "unauthorized_client"]);
function defaultLockRunner() {
  const locks = globalThis.navigator?.locks;
  if (!locks) {
    return (_name, run) => run();
  }
  return (name, run) => locks.request(name, run);
}
function defaultOnResume(handler) {
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") handler();
    });
  }
  if (typeof window !== "undefined") {
    window.addEventListener("online", handler);
  }
}
function defaultStore(namespace) {
  const factory = globalThis.indexedDB;
  return factory ? createIndexedDbStore(namespace, factory) : createMemoryStore();
}
function takeOAuthCallback(href, history) {
  const url = new URL(href);
  const result = {
    code: url.searchParams.get("code"),
    state: url.searchParams.get("state"),
    error: url.searchParams.get("error"),
    present: OAUTH_PARAMS.some((name) => url.searchParams.has(name))
  };
  if (result.present) {
    for (const name of OAUTH_PARAMS) url.searchParams.delete(name);
    const query = url.searchParams.toString();
    try {
      history.replaceState(null, "", `${url.pathname}${query ? `?${query}` : ""}${url.hash}`);
    } catch {
    }
  }
  return result;
}
function createAuthClient(config, overrides = {}) {
  const authDomain = (config.authDomain ?? DEFAULT_AUTH_DOMAIN).replace(/\/$/, "");
  const scopes = config.scopes ?? DEFAULT_SCOPES;
  const store = overrides.store ?? defaultStore(config.storageNamespace);
  const pending = overrides.sessionStorage ?? globalThis.sessionStorage;
  const cryptoApi = overrides.crypto ?? globalThis.crypto;
  const fetchApi = overrides.fetch ?? globalThis.fetch.bind(globalThis);
  const location = overrides.location ?? globalThis.location;
  const history = overrides.history ?? globalThis.history;
  const now = overrides.now ?? Date.now;
  const withLock = overrides.withLock ?? defaultLockRunner();
  const onResume = overrides.onResume ?? defaultOnResume;
  const lockName = `imai-auth:refresh:${config.storageNamespace}`;
  let session = null;
  let inFlight = null;
  let resumeAttached = false;
  function isUsable(candidate) {
    return candidate !== null && candidate.expiresAt - EXPIRY_MARGIN_MS > now();
  }
  async function readErrorCode(response) {
    try {
      const body = await response.json();
      return typeof body.error === "string" ? body.error : "";
    } catch {
      return "";
    }
  }
  async function tokenRequest(body) {
    let response;
    try {
      response = await fetchApi(`${authDomain}/oauth2/token`, {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body).toString()
      });
    } catch (cause) {
      throw new AuthTransientError("token endpoint unreachable", { cause });
    }
    if (response.ok) return await response.json();
    if (response.status === 400 || response.status === 401) {
      const code = await readErrorCode(response);
      if (FATAL_OAUTH_ERRORS.has(code)) {
        throw new AuthFatalError(`token endpoint rejected the grant: ${code}`);
      }
    }
    throw new AuthTransientError(`token endpoint returned ${response.status}`);
  }
  async function acceptTokens(json) {
    if (typeof json.access_token !== "string" || !Number.isFinite(json.expires_in)) {
      throw new AuthTransientError("token response is incomplete");
    }
    if (json.refresh_token) await store.write(RT_KEY, json.refresh_token);
    session = {
      accessToken: json.access_token,
      idToken: json.id_token ?? null,
      expiresAt: now() + json.expires_in * 1e3
    };
    return session;
  }
  function refreshTokens() {
    if (inFlight) return inFlight;
    const run = withLock(lockName, async () => {
      if (isUsable(session)) return session;
      const stored = await store.read(RT_KEY);
      if (!stored) throw new AuthFatalError("no refresh token");
      try {
        return await acceptTokens(
          await tokenRequest({
            grant_type: "refresh_token",
            client_id: config.clientId,
            refresh_token: stored
          })
        );
      } catch (cause) {
        if (!isTransient(cause)) await store.remove(RT_KEY);
        throw cause;
      }
    }).finally(() => {
      if (inFlight === run) inFlight = null;
    });
    inFlight = run;
    return run;
  }
  function attachResume() {
    if (resumeAttached) return;
    resumeAttached = true;
    onResume(() => {
      if (isUsable(session)) return;
      void refreshTokens().catch(() => void 0);
    });
  }
  async function startLogin() {
    const verifier = randomString(64, cryptoApi);
    const state = randomString(24, cryptoApi);
    pending.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));
    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: "code",
      scope: scopes,
      redirect_uri: config.redirectUri,
      state,
      code_challenge: await pkceChallenge(verifier, cryptoApi),
      code_challenge_method: "S256"
    });
    location.replace(`${authDomain}/oauth2/authorize?${params.toString()}`);
    return new Promise(() => {
    });
  }
  async function handleCallback() {
    const callback = takeOAuthCallback(location.href, history);
    if (!callback.present) return;
    const storedRaw = pending.getItem(PKCE_KEY);
    pending.removeItem(PKCE_KEY);
    if (callback.error || !callback.code || !storedRaw) return;
    let stored;
    try {
      stored = JSON.parse(storedRaw);
    } catch {
      return;
    }
    if (typeof stored.verifier !== "string" || stored.state !== callback.state) return;
    try {
      await acceptTokens(
        await tokenRequest({
          grant_type: "authorization_code",
          client_id: config.clientId,
          code: callback.code,
          redirect_uri: config.redirectUri,
          code_verifier: stored.verifier
        })
      );
      await store.remove(SIGNED_OUT_KEY);
    } catch {
    }
  }
  async function revokeRefreshToken() {
    const stored = await store.read(RT_KEY);
    await store.remove(RT_KEY);
    session = null;
    pending.removeItem(PKCE_KEY);
    if (!stored) return;
    try {
      await fetchApi(`${authDomain}/oauth2/revoke`, {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: stored, client_id: config.clientId }).toString()
      });
    } catch {
    }
  }
  async function isSignedOutFlagSet() {
    return await store.read(SIGNED_OUT_KEY) === "true";
  }
  async function restore() {
    await handleCallback();
    if (isUsable(session)) {
      attachResume();
      return true;
    }
    if (await isSignedOutFlagSet()) return false;
    try {
      await refreshTokens();
      attachResume();
      return true;
    } catch (cause) {
      if (isTransient(cause)) throw cause;
      return false;
    }
  }
  return {
    restore,
    async ensureAuthenticated() {
      if (await restore()) return;
      if (await isSignedOutFlagSet()) {
        throw new AuthSignedOutError();
      }
      await startLogin();
    },
    async getAccessToken() {
      if (isUsable(session)) return session.accessToken;
      return (await refreshTokens()).accessToken;
    },
    getIdToken() {
      return session?.idToken ?? null;
    },
    async login() {
      await store.remove(SIGNED_OUT_KEY);
      return startLogin();
    },
    async logout() {
      await revokeRefreshToken();
      await store.write(SIGNED_OUT_KEY, "true");
    },
    async signOutEverywhere() {
      await revokeRefreshToken();
      await store.write(SIGNED_OUT_KEY, "true");
      const params = new URLSearchParams({
        client_id: config.clientId,
        logout_uri: config.redirectUri
      });
      location.assign(`${authDomain}/logout?${params.toString()}`);
      return new Promise(() => {
      });
    },
    getPasskeyAddUrl() {
      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri
      });
      return `${authDomain}/passkeys/add?${params.toString()}`;
    }
  };
}
export {
  AuthFatalError,
  AuthSignedOutError,
  AuthTransientError,
  base64Url,
  createAuthClient,
  createIndexedDbStore,
  createMemoryStore,
  isSignedOut,
  isTransient,
  pkceChallenge,
  randomString,
  takeOAuthCallback
};
