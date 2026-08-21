import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { DefaultDnsResolver, createSafeLookupFunction } from "./dns.js";
import {
  DEFAULT_ALLOWED_PORTS,
  DEFAULT_FETCH_MAX_BYTES,
  DEFAULT_FETCH_TIMEOUT_MS,
  MAX_FETCH_MAX_BYTES,
  MAX_FETCH_TIMEOUT_MS,
  MAX_HEADER_SIZE,
  MAX_REDIRECTS,
  validateAndParseUrl,
} from "./policy.js";
import {
  type FetchUrlOptions,
  type FetchUrlResult,
  NetworkSecurityError,
  type SafeDnsResolver,
} from "./types.js";

const DEFAULT_USER_AGENT = "high-performance-mcp-server/0.2.0";
const DEFAULT_ACCEPT_HEADER =
  "text/html, text/plain, application/json, application/xml, text/xml, application/xhtml+xml, application/javascript, text/javascript, application/yaml, text/yaml, text/markdown, text/csv;q=0.9, */*;q=0.1";

const ALLOWED_CONTENT_TYPES = [
  /^text\//i,
  /^application\/json/i,
  /^application\/[a-z0-9._+-]+\+json/i,
  /^application\/xml/i,
  /^application\/[a-z0-9._+-]+\+xml/i,
  /^application\/javascript/i,
  /^application\/x-javascript/i,
  /^application\/xhtml\+xml/i,
  /^application\/yaml/i,
  /^application\/x-yaml/i,
  /^application\/problem\+json/i,
  /^application\/problem\+xml/i,
];

interface ContentTypeInspection {
  readonly mediaType: string;
  readonly charset?: string;
}

function parseContentTypeHeader(headerValue?: string): ContentTypeInspection | null {
  if (!headerValue || headerValue.trim().length === 0) {
    return null;
  }
  const parts = headerValue.split(";").map((p) => p.trim());
  const mediaType = parts[0] ? parts[0].toLowerCase() : "";
  let charset: string | undefined;

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]!;
    const eqIdx = part.indexOf("=");
    if (eqIdx !== -1) {
      const key = part.slice(0, eqIdx).trim().toLowerCase();
      const val = part.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (key === "charset") {
        charset = val.toLowerCase();
      }
    }
  }

  return { mediaType, charset };
}

function isMediaTypeAllowed(mediaType: string): boolean {
  return ALLOWED_CONTENT_TYPES.some((pattern) => pattern.test(mediaType));
}

/**
 * Performs an SSRF-hardened, read-only HTTP/HTTPS GET request.
 *
 * Security Principles:
 * 1. Node.js http.request / https.request custom socket lookup pins connection to verified safe IPs.
 * 2. Dedicated agents per connection (no global agent, no keepAlive connection reuse).
 * 3. Manual redirect handling with full re-validation of each hop (max 5 redirects).
 * 4. HTTPS to HTTP redirect downgrade prevention.
 * 5. Bounded streaming (hard byte bounds, stream destroyed immediately on limit).
 * 6. Strict UTF-8 text decoding (fatal: true) and binary NUL byte rejection.
 * 7. Zero IP disclosure in error messages.
 */
export async function fetchUrlService(options: FetchUrlOptions): Promise<FetchUrlResult> {
  const allowedPorts = options.customAllowedPorts ?? DEFAULT_ALLOWED_PORTS;
  const resolver: SafeDnsResolver = options.customResolver ?? new DefaultDnsResolver();

  // Validate timeout
  const minTimeout = options.allowLoopbackForTesting ? 10 : 1000;
  let timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  if (typeof timeoutMs !== "number" || isNaN(timeoutMs) || timeoutMs < minTimeout) {
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS;
  } else if (timeoutMs > MAX_FETCH_TIMEOUT_MS) {
    timeoutMs = MAX_FETCH_TIMEOUT_MS;
  }

  // Validate maxBytes
  let maxBytes = options.maxBytes ?? DEFAULT_FETCH_MAX_BYTES;
  if (typeof maxBytes !== "number" || isNaN(maxBytes) || maxBytes < 1) {
    maxBytes = DEFAULT_FETCH_MAX_BYTES;
  } else if (maxBytes > MAX_FETCH_MAX_BYTES) {
    maxBytes = MAX_FETCH_MAX_BYTES;
  }

  // Overall deadline timer setup
  const overallTimeoutController = new AbortController();
  const timeoutId = setTimeout(() => {
    overallTimeoutController.abort();
  }, timeoutMs);

  // Combine caller signal with overall timeout
  const combinedController = new AbortController();
  const onCallerAbort = () => combinedController.abort();
  const onTimeoutAbort = () => combinedController.abort();

  if (options.signal) {
    if (options.signal.aborted) {
      clearTimeout(timeoutId);
      throw new NetworkSecurityError("timeout", "Request cancelled before execution.");
    }
    options.signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  overallTimeoutController.signal.addEventListener("abort", onTimeoutAbort, { once: true });

  const requestedUrl = options.url;
  const allowLoopbackForTesting = options.allowLoopbackForTesting ?? false;
  let currentUrl = validateAndParseUrl(requestedUrl, allowedPorts, allowLoopbackForTesting);
  let redirectCount = 0;

  try {
    while (true) {
      if (combinedController.signal.aborted) {
        if (options.signal?.aborted) {
          throw new NetworkSecurityError("network_error", "Request was aborted by client.");
        }
        throw new NetworkSecurityError("timeout", `Request timed out after ${timeoutMs}ms.`);
      }

      const responseOrRedirect = await executeSingleRequest({
        targetUrl: currentUrl,
        maxBytes,
        allowedPorts,
        resolver,
        signal: combinedController.signal,
        allowLoopbackForTesting,
      });

      if (responseOrRedirect.isRedirect) {
        redirectCount++;
        if (redirectCount > MAX_REDIRECTS) {
          throw new NetworkSecurityError(
            "redirect_limit",
            `Maximum redirect limit of ${MAX_REDIRECTS} exceeded.`
          );
        }

        const locationHeader = responseOrRedirect.location;
        if (!locationHeader || locationHeader.trim().length === 0) {
          throw new NetworkSecurityError("invalid_redirect", "Redirect response missing Location header.");
        }

        let nextUrl: URL;
        try {
          nextUrl = new URL(locationHeader, currentUrl.href);
        } catch (err: any) {
          throw new NetworkSecurityError("invalid_redirect", "Malformed redirect Location URL.", err.message);
        }

        // HTTPS -> HTTP redirect downgrade check
        if (currentUrl.protocol === "https:" && nextUrl.protocol === "http:") {
          throw new NetworkSecurityError(
            "redirect_downgrade_not_allowed",
            "HTTPS to HTTP redirect downgrade is not allowed by security policy."
          );
        }

        // Re-validate the redirect destination URL against full policy
        currentUrl = validateAndParseUrl(nextUrl.href, allowedPorts, allowLoopbackForTesting);
        continue;
      }

      // Success / terminal response reached
      return {
        requestedUrl,
        finalUrl: currentUrl.href,
        status: responseOrRedirect.status,
        statusText: responseOrRedirect.statusText,
        contentType: responseOrRedirect.contentType,
        contentLength: responseOrRedirect.contentLength,
        body: responseOrRedirect.body,
        bytesRead: responseOrRedirect.bytesRead,
        truncated: responseOrRedirect.truncated,
        redirectCount,
      };
    }
  } finally {
    clearTimeout(timeoutId);
    if (options.signal) {
      options.signal.removeEventListener("abort", onCallerAbort);
    }
    overallTimeoutController.signal.removeEventListener("abort", onTimeoutAbort);
  }
}

interface SingleRequestOptions {
  readonly targetUrl: URL;
  readonly maxBytes: number;
  readonly allowedPorts: readonly number[];
  readonly resolver: SafeDnsResolver;
  readonly signal: AbortSignal;
  readonly allowLoopbackForTesting?: boolean;
}

type SingleRequestResult =
  | { readonly isRedirect: true; readonly location: string; readonly status: number }
  | {
      readonly isRedirect: false;
      readonly status: number;
      readonly statusText: string;
      readonly contentType?: string;
      readonly contentLength?: number;
      readonly body?: string;
      readonly bytesRead: number;
      readonly truncated: boolean;
    };

async function executeSingleRequest(opts: SingleRequestOptions): Promise<SingleRequestResult> {
  const { targetUrl, maxBytes, resolver, signal, allowLoopbackForTesting = false } = opts;

  return new Promise<SingleRequestResult>((resolve, reject) => {
    if (signal.aborted) {
      return reject(new NetworkSecurityError("network_error", "Request was aborted prior to socket creation."));
    }

    const isHttps = targetUrl.protocol === "https:";
    const defaultPort = isHttps ? 443 : 80;
    const port = targetUrl.port ? parseInt(targetUrl.port, 10) : defaultPort;

    // Create safe custom lookup function tied to our resolver and active abort signal
    const customLookup = createSafeLookupFunction(resolver, signal, allowLoopbackForTesting);

    // Create a dedicated, short-lived Agent to prevent global agent state or proxy inheritance
    const agent = isHttps
      ? new https.Agent({
          keepAlive: false,
          maxSockets: 1,
          rejectUnauthorized: true,
          lookup: customLookup as any,
        })
      : new http.Agent({
          keepAlive: false,
          maxSockets: 1,
          lookup: customLookup as any,
        });

    const requestHeaders: Record<string, string> = {
      "User-Agent": DEFAULT_USER_AGENT,
      Accept: DEFAULT_ACCEPT_HEADER,
      "Accept-Encoding": "identity",
      Connection: "close",
      Host: targetUrl.host,
    };

    const requestOptions: http.RequestOptions = {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      method: "GET",
      headers: requestHeaders,
      agent,
      lookup: customLookup as any,
      maxHeaderSize: MAX_HEADER_SIZE,
      signal,
    };

    let clientRequest: http.ClientRequest;
    let completed = false;
    let isTruncated = false;

    const cleanup = () => {
      if (!completed) {
        completed = true;
        try {
          agent.destroy();
        } catch {
          // ignore
        }
      }
    };

    const abortHandler = () => {
      cleanup();
      if (clientRequest) {
        try {
          clientRequest.destroy();
        } catch {
          // ignore
        }
      }
      reject(new NetworkSecurityError("timeout", "Network request was cancelled or timed out."));
    };

    signal.addEventListener("abort", abortHandler, { once: true });

    try {
      const httpModule = isHttps ? https : http;
      clientRequest = httpModule.request(requestOptions, (res: http.IncomingMessage) => {
        const status = res.statusCode || 200;
        const statusText = res.statusMessage || "";

        // Check for redirects: 301, 302, 303, 307, 308
        if ([301, 302, 303, 307, 308].includes(status)) {
          const rawLocation = res.headers.location;
          const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
          // Consume and discard body
          res.resume();
          signal.removeEventListener("abort", abortHandler);
          cleanup();
          return resolve({
            isRedirect: true,
            location: location || "",
            status,
          });
        }

        // Protocol upgrade rejection for 101
        if (status === 101) {
          res.destroy();
          signal.removeEventListener("abort", abortHandler);
          cleanup();
          return reject(
            new NetworkSecurityError(
              "protocol_upgrade_not_allowed",
              "Protocol upgrade is not supported by fetch_url."
            )
          );
        }

        // Content-Encoding verification: reject any non-identity compression
        const contentEncoding = res.headers["content-encoding"];
        if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
          res.destroy();
          signal.removeEventListener("abort", abortHandler);
          cleanup();
          return reject(
            new NetworkSecurityError(
              "unsupported_content_encoding",
              `Content-Encoding "${contentEncoding}" is not supported. Only uncompressed responses are allowed.`
            )
          );
        }

        // Content-Type & Charset inspection
        const rawContentType = res.headers["content-type"];
        const contentTypeHeader = Array.isArray(rawContentType) ? rawContentType[0] : rawContentType;
        const inspectedContentType = parseContentTypeHeader(contentTypeHeader);

        // Check empty body responses (e.g. 204 No Content)
        if (status === 204 || status === 304) {
          res.resume();
          signal.removeEventListener("abort", abortHandler);
          cleanup();
          return resolve({
            isRedirect: false,
            status,
            statusText,
            contentType: contentTypeHeader,
            contentLength: 0,
            body: "",
            bytesRead: 0,
            truncated: false,
          });
        }

        // If content-type is provided, validate media type & charset
        if (inspectedContentType) {
          if (!isMediaTypeAllowed(inspectedContentType.mediaType)) {
            res.destroy();
            signal.removeEventListener("abort", abortHandler);
            cleanup();
            return reject(
              new NetworkSecurityError(
                "unsupported_content_type",
                `Content-Type "${inspectedContentType.mediaType}" is not supported for text decoding.`
              )
            );
          }

          if (
            inspectedContentType.charset &&
            inspectedContentType.charset !== "utf-8" &&
            inspectedContentType.charset !== "utf8"
          ) {
            res.destroy();
            signal.removeEventListener("abort", abortHandler);
            cleanup();
            return reject(
              new NetworkSecurityError(
                "unsupported_charset",
                `Unsupported charset "${inspectedContentType.charset}". Only UTF-8 is supported.`
              )
            );
          }
        }

        // Parse optional Content-Length safely
        let declaredContentLength: number | undefined;
        const rawCL = res.headers["content-length"];
        if (rawCL) {
          const parsedCL = parseInt(Array.isArray(rawCL) ? rawCL[0]! : rawCL, 10);
          if (!isNaN(parsedCL) && parsedCL >= 0 && Number.isSafeInteger(parsedCL)) {
            declaredContentLength = parsedCL;
          }
        }

        // Stream body with strict byte accumulation bounds
        const chunks: Buffer[] = [];
        let bytesRead = 0;
        let truncated = false;

        const finishResponse = () => {
          if (completed) return;
          completed = true;
          if (truncated) isTruncated = true;
          signal.removeEventListener("abort", abortHandler);
          cleanup();

          const totalBuffer = Buffer.concat(chunks, bytesRead);

          // Strict UTF-8 decoding
          let decodedText = "";
          try {
            const decoder = new TextDecoder("utf-8", { fatal: true });
            decodedText = decoder.decode(totalBuffer);
          } catch (err: any) {
            return reject(
              new NetworkSecurityError(
                "invalid_text_encoding",
                "Response body contains malformed UTF-8 byte sequences.",
                err.message
              )
            );
          }

          // Binary NUL byte guard
          if (decodedText.includes("\0")) {
            return reject(
              new NetworkSecurityError(
                "unsupported_content_type",
                "Response body contains binary NUL bytes."
              )
            );
          }

          resolve({
            isRedirect: false,
            status,
            statusText,
            contentType: contentTypeHeader,
            contentLength: declaredContentLength ?? bytesRead,
            body: decodedText,
            bytesRead,
            truncated,
          });
        };

        res.on("data", (chunk: Buffer) => {
          if (bytesRead >= maxBytes || completed) {
            return;
          }

          const remaining = maxBytes - bytesRead;
          if (chunk.length > remaining) {
            chunks.push(chunk.subarray(0, remaining));
            bytesRead += remaining;
            truncated = true;
            isTruncated = true;
            res.destroy(); // Stop receiving data immediately
            finishResponse();
          } else {
            chunks.push(chunk);
            bytesRead += chunk.length;
          }
        });

        res.on("end", () => {
          finishResponse();
        });

        res.on("close", () => {
          if (!completed && truncated) {
            finishResponse();
          }
        });

        res.on("error", (err: any) => {
          if (truncated || completed) {
            return;
          }
          signal.removeEventListener("abort", abortHandler);
          cleanup();
          reject(new NetworkSecurityError("network_error", "Error reading response stream.", err.message));
        });
      });

      // Handle protocol upgrade (e.g. 101 WebSocket / HTTP upgrade)
      clientRequest.on("upgrade", (res, socket) => {
        socket.destroy();
        signal.removeEventListener("abort", abortHandler);
        cleanup();
        reject(
          new NetworkSecurityError(
            "protocol_upgrade_not_allowed",
            "Protocol upgrade is not supported by fetch_url."
          )
        );
      });

      clientRequest.on("error", (err: any) => {
        if (completed || isTruncated) {
          return;
        }

        signal.removeEventListener("abort", abortHandler);
        cleanup();

        if (err instanceof NetworkSecurityError) {
          return reject(err);
        }

        if (err.code === "EBLOCKEDDESTINATION" || err.message?.includes("Destination is not allowed")) {
          return reject(
            new NetworkSecurityError(
              "blocked_destination",
              "Destination is not allowed by network security policy."
            )
          );
        }

        if (err.code === "ENOTFOUND" || err.syscall === "getaddrinfo") {
          return reject(
            new NetworkSecurityError(
              "dns_resolution_failed",
              "DNS resolution failed for the requested hostname."
            )
          );
        }

        if (err.name === "AbortError" || signal.aborted) {
          return reject(
            new NetworkSecurityError("timeout", "Network request was cancelled or timed out.")
          );
        }

        reject(new NetworkSecurityError("network_error", "Network connection failed.", err.message));
      });

      clientRequest.end();
    } catch (err: any) {
      signal.removeEventListener("abort", abortHandler);
      cleanup();
      if (err instanceof NetworkSecurityError) {
        return reject(err);
      }
      reject(new NetworkSecurityError("network_error", "Failed to initiate request.", err.message));
    }
  });
}
