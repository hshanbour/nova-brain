export const LEGACY_META_OAUTH_CALLBACK_PATH = "/api/integrations/instagram/oauth/callback";
export const ROOT_META_OAUTH_CALLBACK_MARKER = "meta_oauth_callback";

export function isSupportedMetaOAuthRedirect(value) {
  let url;
  try { url = value instanceof URL ? value : new URL(value); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return false;
  if (url.pathname === LEGACY_META_OAUTH_CALLBACK_PATH) return url.search === "";
  if (url.pathname !== "/" || url.searchParams.get(ROOT_META_OAUTH_CALLBACK_MARKER) !== "1") return false;
  return [...url.searchParams.keys()].length === 1;
}

export function isMetaOAuthCallbackUrl(url) {
  return url.pathname === LEGACY_META_OAUTH_CALLBACK_PATH ||
    (url.pathname === "/" && url.searchParams.get(ROOT_META_OAUTH_CALLBACK_MARKER) === "1");
}

export function metaOAuthCookiePath(redirectUri) {
  return new URL(redirectUri).pathname === "/" ? "/" : LEGACY_META_OAUTH_CALLBACK_PATH;
}
