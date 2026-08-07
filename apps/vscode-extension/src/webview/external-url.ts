const MAX_EXTERNAL_URL_LENGTH = 4096;

export function normalizeExternalHttpUrl(value: string | undefined) {
  if (!value || value.length > MAX_EXTERNAL_URL_LENGTH) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}
