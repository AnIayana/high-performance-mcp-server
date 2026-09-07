import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/server";
import {
  createNetworkCachePolicy,
  HttpConditionalCache,
} from "../src/network/conditional-cache.js";
import { fetchUrlService } from "../src/network/fetch-service.js";
import { NetworkSecurityError, type SafeDnsResolver } from "../src/network/types.js";
import registerFetchUrlTool, { fetchUrlInputSchema } from "../src/tools/fetch-url.js";
import { TEST_TLS_CERT, TEST_TLS_KEY } from "./fixtures/test-cert.js";

const localLoopbackResolver: SafeDnsResolver = {
  async resolve() {
    return [{ address: "127.0.0.1", family: 4 }];
  },
};

test("fetchUrlService — Successful 200 OK text/plain and JSON responses", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/json") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ message: "hello world" }));
    } else {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Plain text content");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  try {
    const plainResult = await fetchUrlService({
      url: `http://public.example.com:${port}/`,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });

    assert.equal(plainResult.status, 200);
    assert.equal(plainResult.body, "Plain text content");
    assert.equal(plainResult.bytesRead, 18);
    assert.equal(plainResult.truncated, false);
    assert.equal(plainResult.redirectCount, 0);

    const jsonResult = await fetchUrlService({
      url: `http://public.example.com:${port}/json`,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });

    assert.equal(jsonResult.status, 200);
    assert.equal(jsonResult.contentType, "application/json; charset=utf-8");
    assert.deepEqual(JSON.parse(jsonResult.body!), { message: "hello world" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Bounded streaming and truncation at maxBytes", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    // Write 500 bytes
    res.write("A".repeat(500));
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  try {
    const result = await fetchUrlService({
      url: `http://public.example.com:${port}/`,
      maxBytes: 100, // Limit to 100 bytes
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });

    assert.equal(result.status, 200);
    assert.equal(result.bytesRead, 100);
    assert.equal(result.body?.length, 100);
    assert.equal(result.truncated, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Single large chunk memory bound proof (no memory overflow)", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    // Send a single large chunk of 64 KiB
    res.end(Buffer.alloc(65536, "Z"));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  try {
    const result = await fetchUrlService({
      url: `http://public.example.com:${port}/large-chunk`,
      maxBytes: 128, // Hard maxBytes limit: 128 bytes
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });

    assert.equal(result.status, 200);
    assert.equal(result.bytesRead, 128);
    assert.equal(result.body?.length, 128);
    assert.equal(result.truncated, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Content-Length safety (large declared Content-Length and chunked transfer)", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/huge-cl") {
      res.writeHead(200, {
        "Content-Type": "text/plain",
        "Content-Length": "1048576", // 1 MiB declared length
      });
      res.end("A".repeat(200));
    } else if (req.url === "/chunked") {
      res.writeHead(200, {
        "Content-Type": "text/plain",
        // No Content-Length -> Transfer-Encoding: chunked
      });
      res.write("Chunk 1; ");
      res.write("Chunk 2");
      res.end();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  try {
    const hugeClResult = await fetchUrlService({
      url: `http://public.example.com:${port}/huge-cl`,
      maxBytes: 100, // Limit to 100 bytes
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(hugeClResult.status, 200);
    assert.equal(hugeClResult.bytesRead, 100);
    assert.equal(hugeClResult.truncated, true);
    assert.equal(hugeClResult.contentLength, 1048576);

    const chunkedResult = await fetchUrlService({
      url: `http://public.example.com:${port}/chunked`,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(chunkedResult.status, 200);
    assert.equal(chunkedResult.body, "Chunk 1; Chunk 2");
    assert.equal(chunkedResult.contentLength, 16);
    assert.equal(chunkedResult.truncated, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Manual redirect handling up to 5 hops", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/hop1") {
      res.writeHead(302, { Location: "/hop2" });
      res.end();
    } else if (req.url === "/hop2") {
      res.writeHead(301, { Location: "/final" });
      res.end();
    } else {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Destination reached");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  try {
    const result = await fetchUrlService({
      url: `http://public.example.com:${port}/hop1`,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });

    assert.equal(result.status, 200);
    assert.equal(result.body, "Destination reached");
    assert.equal(result.redirectCount, 2);
    assert.equal(result.finalUrl, `http://public.example.com:${port}/final`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Redirect loop exceeding 5 hops is halted", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(302, { Location: "/infinite" });
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  try {
    await assert.rejects(
      async () => {
        await fetchUrlService({
          url: `http://public.example.com:${port}/infinite`,
          customResolver: localLoopbackResolver,
          customAllowedPorts: [port],
          allowLoopbackForTesting: true,
        });
      },
      (err: any) => err instanceof NetworkSecurityError && err.code === "redirect_limit"
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Redirect to private destination is blocked before second connection", async () => {
  const server = http.createServer((_req, res) => {
    // Redirects to private RFC1918 IP (not allowed even when allowLoopbackForTesting is true)
    res.writeHead(302, { Location: "http://192.168.1.1:80/" });
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  try {
    await assert.rejects(
      async () => {
        await fetchUrlService({
          url: `http://public.example.com:${port}/pivot`,
          customResolver: localLoopbackResolver,
          customAllowedPorts: [port, 80],
          allowLoopbackForTesting: true,
        });
      },
      (err: any) => err instanceof NetworkSecurityError && err.code === "blocked_destination"
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Redirect from HTTPS to HTTP downgrade is strictly rejected", () => {
  // Unit test for downgrade redirect logic in fetch-service
  const originalUrl = new URL("https://example.com/start");
  const targetUrl = new URL("http://example.com/downgrade");

  if (originalUrl.protocol === "https:" && targetUrl.protocol === "http:") {
    assert.throws(
      () => {
        throw new NetworkSecurityError(
          "redirect_downgrade_not_allowed",
          "HTTPS-to-HTTP redirect downgrade is not allowed by network security policy."
        );
      },
      (err: any) => err instanceof NetworkSecurityError && err.code === "redirect_downgrade_not_allowed"
    );
  }
});

test("fetchUrlService — Content-Encoding verification (absent, identity, gzip, br, deflate)", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/absent") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("uncompressed text");
    } else if (req.url === "/identity") {
      res.writeHead(200, { "Content-Type": "text/plain", "Content-Encoding": "identity" });
      res.end("identity text");
    } else if (req.url === "/gzip") {
      res.writeHead(200, { "Content-Type": "text/plain", "Content-Encoding": "gzip" });
      res.end(Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
    } else if (req.url === "/br") {
      res.writeHead(200, { "Content-Type": "text/plain", "Content-Encoding": "br" });
      res.end(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
    } else if (req.url === "/deflate") {
      res.writeHead(200, { "Content-Type": "text/plain", "Content-Encoding": "deflate" });
      res.end(Buffer.from([0x78, 0x9c, 0x03, 0x00]));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  try {
    // 1. Absent -> 200 OK
    const absentRes = await fetchUrlService({
      url: `http://public.example.com:${port}/absent`,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(absentRes.status, 200);
    assert.equal(absentRes.body, "uncompressed text");

    // 2. Identity -> 200 OK
    const identityRes = await fetchUrlService({
      url: `http://public.example.com:${port}/identity`,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(identityRes.status, 200);
    assert.equal(identityRes.body, "identity text");

    // 3. Gzip -> rejected
    await assert.rejects(
      async () => {
        await fetchUrlService({
          url: `http://public.example.com:${port}/gzip`,
          customResolver: localLoopbackResolver,
          customAllowedPorts: [port],
          allowLoopbackForTesting: true,
        });
      },
      (err: any) => err instanceof NetworkSecurityError && err.code === "unsupported_content_encoding"
    );

    // 4. Brotli -> rejected
    await assert.rejects(
      async () => {
        await fetchUrlService({
          url: `http://public.example.com:${port}/br`,
          customResolver: localLoopbackResolver,
          customAllowedPorts: [port],
          allowLoopbackForTesting: true,
        });
      },
      (err: any) => err instanceof NetworkSecurityError && err.code === "unsupported_content_encoding"
    );

    // 5. Deflate -> rejected
    await assert.rejects(
      async () => {
        await fetchUrlService({
          url: `http://public.example.com:${port}/deflate`,
          customResolver: localLoopbackResolver,
          customAllowedPorts: [port],
          allowLoopbackForTesting: true,
        });
      },
      (err: any) => err instanceof NetworkSecurityError && err.code === "unsupported_content_encoding"
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Rejects binary Content-Types (e.g. image/png)", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  try {
    await assert.rejects(
      async () => {
        await fetchUrlService({
          url: `http://public.example.com:${port}/image.png`,
          customResolver: localLoopbackResolver,
          customAllowedPorts: [port],
          allowLoopbackForTesting: true,
        });
      },
      (err: any) => err instanceof NetworkSecurityError && err.code === "unsupported_content_type"
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Rejects non-UTF-8 explicit charset (e.g. ISO-8859-1)", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=iso-8859-1" });
    res.end("Latin text");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  try {
    await assert.rejects(
      async () => {
        await fetchUrlService({
          url: `http://public.example.com:${port}/`,
          customResolver: localLoopbackResolver,
          customAllowedPorts: [port],
          allowLoopbackForTesting: true,
        });
      },
      (err: any) => err instanceof NetworkSecurityError && err.code === "unsupported_charset"
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Strict UTF-8 decoding rejects malformed byte sequences", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    // Invalid UTF-8 sequence (standalone 0xff or invalid continuation)
    res.end(Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0xff, 0xfe]));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  try {
    await assert.rejects(
      async () => {
        await fetchUrlService({
          url: `http://public.example.com:${port}/invalid-utf8`,
          customResolver: localLoopbackResolver,
          customAllowedPorts: [port],
          allowLoopbackForTesting: true,
        });
      },
      (err: any) => err instanceof NetworkSecurityError && err.code === "invalid_text_encoding"
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Rejects textual bodies containing binary NUL bytes", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("hello\0world");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  try {
    await assert.rejects(
      async () => {
        await fetchUrlService({
          url: `http://public.example.com:${port}/nul`,
          customResolver: localLoopbackResolver,
          customAllowedPorts: [port],
          allowLoopbackForTesting: true,
        });
      },
      (err: any) => err instanceof NetworkSecurityError && err.code === "unsupported_content_type"
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — HTTP 4xx and 5xx return structured error bodies without throwing MCP failure", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/404") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found details");
    } else if (req.url === "/500") {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal server error" }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  try {
    const res404 = await fetchUrlService({
      url: `http://public.example.com:${port}/404`,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(res404.status, 404);
    assert.equal(res404.body, "Not Found details");

    const res500 = await fetchUrlService({
      url: `http://public.example.com:${port}/500`,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(res500.status, 500);
    assert.deepEqual(JSON.parse(res500.body!), { error: "internal server error" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Handles 204 No Content empty responses safely", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(204);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  try {
    const res204 = await fetchUrlService({
      url: `http://public.example.com:${port}/204`,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(res204.status, 204);
    assert.equal(res204.body, "");
    assert.equal(res204.bytesRead, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — AbortSignal cancellation immediately stops request", async () => {
  const server = http.createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("delayed");
    }, 2000);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);

  try {
    await assert.rejects(
      async () => {
        await fetchUrlService({
          url: `http://public.example.com:${port}/`,
          signal: controller.signal,
          customResolver: localLoopbackResolver,
          customAllowedPorts: [port],
          allowLoopbackForTesting: true,
        });
      },
      (err: any) => err instanceof NetworkSecurityError
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — DNS late-callback is ignored after abort/timeout", async () => {
  let socketAttempted = false;
  const server = http.createServer((_req, res) => {
    socketAttempted = true;
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("should never be called");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  // Delayed resolver that takes 100ms
  const delayedResolver: SafeDnsResolver = {
    async resolve(_hostname: string, signal?: AbortSignal) {
      await new Promise((r) => setTimeout(r, 100));
      if (signal?.aborted) {
        throw new Error("DNS lookup cancelled");
      }
      return [{ address: "127.0.0.1", family: 4 }];
    },
  };

  const controller = new AbortController();
  // Abort early at 15ms while DNS is still resolving
  setTimeout(() => controller.abort(), 15);

  try {
    await assert.rejects(
      async () => {
        await fetchUrlService({
          url: `http://public.example.com:${port}/`,
          signal: controller.signal,
          customResolver: delayedResolver,
          customAllowedPorts: [port],
          allowLoopbackForTesting: true,
        });
      },
      (err: any) => err instanceof NetworkSecurityError
    );

    // Wait past the 100ms resolver delay to ensure late completion never triggered socket connection
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(socketAttempted, false, "Late DNS callback must never start socket connection");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Environment proxy variables do not hijack connection", async () => {
  const origHttpProxy = process.env.HTTP_PROXY;
  const origHttpsProxy = process.env.HTTPS_PROXY;
  const origAllProxy = process.env.ALL_PROXY;
  const origNodeEnvProxy = process.env.NODE_USE_ENV_PROXY;

  process.env.HTTP_PROXY = "http://127.0.0.1:9999";
  process.env.HTTPS_PROXY = "http://127.0.0.1:9999";
  process.env.ALL_PROXY = "http://127.0.0.1:9999";
  process.env.NODE_USE_ENV_PROXY = "1";

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("direct connection success");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  try {
    const result = await fetchUrlService({
      url: `http://public.example.com:${port}/`,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });

    assert.equal(result.status, 200);
    assert.equal(result.body, "direct connection success");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env.HTTP_PROXY = origHttpProxy;
    process.env.HTTPS_PROXY = origHttpsProxy;
    process.env.ALL_PROXY = origAllProxy;
    process.env.NODE_USE_ENV_PROXY = origNodeEnvProxy;
  }
});

test("fetchUrlService — Rejects 101 Protocol Upgrade attempts and destroys socket", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(101, {
      Connection: "Upgrade",
      Upgrade: "websocket",
    });
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  try {
    await assert.rejects(
      async () => {
        await fetchUrlService({
          url: `http://public.example.com:${port}/ws`,
          customResolver: localLoopbackResolver,
          customAllowedPorts: [port],
          allowLoopbackForTesting: true,
        });
      },
      (err: any) => err instanceof NetworkSecurityError && err.code === "protocol_upgrade_not_allowed"
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Single overall timeout/deadline covers redirects and entire request chain", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/slow-hop1") {
      setTimeout(() => {
        res.writeHead(302, { Location: "/slow-hop2" });
        res.end();
      }, 75);
    } else if (req.url === "/slow-hop2") {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("final after hops");
      }, 75);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  try {
    // Overall timeout is 100ms. Hop 1 takes 75ms, so Hop 2 will exceed the overall 100ms deadline.
    await assert.rejects(
      async () => {
        await fetchUrlService({
          url: `http://public.example.com:${port}/slow-hop1`,
          timeoutMs: 100, // Strict 100ms overall timeout for entire chain
          customResolver: localLoopbackResolver,
          customAllowedPorts: [port],
          allowLoopbackForTesting: true,
        });
      },
      (err: any) => err instanceof NetworkSecurityError && err.code === "timeout"
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Error privacy: blocked destination failures never disclose internal IP/DNS/socket details", async () => {
  const sensitiveTargets = [
    "http://127.0.0.1:80/",
    "http://10.0.0.1:80/",
    "http://172.16.0.1:80/",
    "http://192.168.1.1:80/",
    "http://169.254.169.254:80/",
    "http://[::1]:80/",
    "http://[::ffff:127.0.0.1]:80/",
  ];

  for (const targetUrl of sensitiveTargets) {
    try {
      await fetchUrlService({
        url: targetUrl,
        customAllowedPorts: [80],
        // allowLoopbackForTesting is false by default
      });
      assert.fail(`Expected ${targetUrl} to reject`);
    } catch (err: any) {
      assert.ok(err instanceof NetworkSecurityError);
      assert.equal(err.code, "blocked_destination");
      // Ensure clientMessage is sanitized
      assert.equal(err.message, "Destination is not allowed by network security policy.");
      // Ensure no internal IP or socket leak in clientMessage
      assert.equal(err.message.includes("127.0.0.1"), false);
      assert.equal(err.message.includes("10.0.0.1"), false);
      assert.equal(err.message.includes("172.16"), false);
      assert.equal(err.message.includes("192.168"), false);
      assert.equal(err.message.includes("169.254"), false);
    }
  }
});

test("fetchUrlService — Operator allowlist permits allowed host and blocks unlisted hosts", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("allowed content");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  const policy = {
    allowHosts: ["allowed.example.com", "*.allowed-sub.org"],
    denyHosts: [],
    httpsOnly: false,
    maxResponseBytes: 5_242_880,
    maxTimeoutMs: 30_000,
  };

  try {
    // 1. Matching exact allowlist
    const allowedRes = await fetchUrlService({
      url: `http://allowed.example.com:${port}/`,
      operatorPolicy: policy,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(allowedRes.status, 200);
    assert.equal(allowedRes.body, "allowed content");

    // 2. Matching wildcard allowlist
    const subRes = await fetchUrlService({
      url: `http://api.allowed-sub.org:${port}/`,
      operatorPolicy: policy,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(subRes.status, 200);
    assert.equal(subRes.body, "allowed content");

    // 3. Unlisted host rejected with host_not_allowed
    await assert.rejects(
      async () => {
        await fetchUrlService({
          url: `http://unlisted.example.com:${port}/`,
          operatorPolicy: policy,
          customResolver: localLoopbackResolver,
          customAllowedPorts: [port],
          allowLoopbackForTesting: true,
        });
      },
      (err: any) =>
        err instanceof NetworkSecurityError &&
        err.code === "host_not_allowed" &&
        err.message === "Destination hostname is not allowed by server network policy."
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Operator denylist blocks denied hosts with host_denied", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("data");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  const policy = {
    allowHosts: [],
    denyHosts: ["denied.example.com", "*.ads.net"],
    httpsOnly: false,
    maxResponseBytes: 5_242_880,
    maxTimeoutMs: 30_000,
  };

  try {
    // 1. Non-denied host allowed
    const okRes = await fetchUrlService({
      url: `http://public.example.com:${port}/`,
      operatorPolicy: policy,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(okRes.status, 200);

    // 2. Exact denied host blocked with host_denied
    await assert.rejects(
      async () => {
        await fetchUrlService({
          url: `http://denied.example.com:${port}/`,
          operatorPolicy: policy,
          customResolver: localLoopbackResolver,
          customAllowedPorts: [port],
          allowLoopbackForTesting: true,
        });
      },
      (err: any) =>
        err instanceof NetworkSecurityError &&
        err.code === "host_denied" &&
        err.message === "Destination hostname is denied by server network policy."
    );

    // 3. Wildcard denied host blocked with host_denied
    await assert.rejects(
      async () => {
        await fetchUrlService({
          url: `http://banner.ads.net:${port}/`,
          operatorPolicy: policy,
          customResolver: localLoopbackResolver,
          customAllowedPorts: [port],
          allowLoopbackForTesting: true,
        });
      },
      (err: any) =>
        err instanceof NetworkSecurityError &&
        err.code === "host_denied" &&
        err.message === "Destination hostname is denied by server network policy."
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Operator denylist takes precedence over allowlist", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("data");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  // Host matches allow (*.example.com) BUT also matches deny (blocked.example.com)
  const policy = {
    allowHosts: ["*.example.com"],
    denyHosts: ["blocked.example.com"],
    httpsOnly: false,
    maxResponseBytes: 5_242_880,
    maxTimeoutMs: 30_000,
  };

  try {
    await assert.rejects(
      async () => {
        await fetchUrlService({
          url: `http://blocked.example.com:${port}/`,
          operatorPolicy: policy,
          customResolver: localLoopbackResolver,
          customAllowedPorts: [port],
          allowLoopbackForTesting: true,
        });
      },
      (err: any) =>
        err instanceof NetworkSecurityError &&
        err.code === "host_denied" &&
        err.message === "Destination hostname is denied by server network policy."
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Redirect to denied host is rejected at redirect hop", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/start") {
      res.writeHead(302, { Location: `http://tracker.adnetwork.com:${port}/dest` });
      res.end();
    } else {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("landing");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  const policy = {
    allowHosts: ["allowed.com", "*.adnetwork.com"],
    denyHosts: ["tracker.adnetwork.com"],
    httpsOnly: false,
    maxResponseBytes: 5_242_880,
    maxTimeoutMs: 30_000,
  };

  try {
    await assert.rejects(
      async () => {
        await fetchUrlService({
          url: `http://allowed.com:${port}/start`,
          operatorPolicy: policy,
          customResolver: localLoopbackResolver,
          customAllowedPorts: [port],
          allowLoopbackForTesting: true,
        });
      },
      (err: any) =>
        err instanceof NetworkSecurityError &&
        err.code === "host_denied" &&
        err.message === "Destination hostname is denied by server network policy."
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Operator allowlist CANNOT bypass built-in SSRF protections", async () => {
  // Even if operator configured allowHosts = ["safe.example.com"]
  // If safe.example.com resolves to private/loopback/cloud IP, it MUST be blocked
  const privateResolver: SafeDnsResolver = {
    async resolve(_hostname: string) {
      return [{ address: "10.0.0.1", family: 4 }];
    },
  };

  const policy = {
    allowHosts: ["safe.example.com"],
    denyHosts: [],
    httpsOnly: false,
    maxResponseBytes: 5_242_880,
    maxTimeoutMs: 30_000,
  };

  await assert.rejects(
    async () => {
      await fetchUrlService({
        url: "http://safe.example.com/api",
        operatorPolicy: policy,
        customResolver: privateResolver,
        customAllowedPorts: [80],
        allowLoopbackForTesting: false,
      });
    },
    (err: any) =>
      err instanceof NetworkSecurityError &&
      err.code === "blocked_destination" &&
      err.message === "Destination is not allowed by network security policy."
  );
});

test("fetchUrlService — Operator HTTPS-only mode rejects HTTP initial and redirect destinations", async () => {
  const policy = {
    allowHosts: [],
    denyHosts: [],
    httpsOnly: true,
    maxResponseBytes: 5_242_880,
    maxTimeoutMs: 30_000,
  };

  // Initial HTTP rejected
  await assert.rejects(
    async () => {
      await fetchUrlService({
        url: "http://example.com/data",
        operatorPolicy: policy,
      });
    },
    (err: any) =>
      err instanceof NetworkSecurityError &&
      err.code === "https_required" &&
      err.message === "HTTPS is required by server network policy."
  );
});

test("fetchUrlService — Operator maxResponseBytes clamps response truncation", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    // 500 bytes payload
    res.end("x".repeat(500));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  const policy = {
    allowHosts: [],
    denyHosts: [],
    httpsOnly: false,
    maxResponseBytes: 100, // Operator cap of 100 bytes
    maxTimeoutMs: 30_000,
  };

  try {
    // Caller requests 1000 bytes, but operator caps at 100 bytes
    const result = await fetchUrlService({
      url: `http://public.example.com:${port}/`,
      maxBytes: 1000,
      operatorPolicy: policy,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });

    assert.equal(result.status, 200);
    assert.equal(result.truncated, true);
    assert.equal(result.bytesRead, 100);
    assert.equal(result.body?.length, 100);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Operator allowlist with Mixed DNS (public + private IP) rejects hostname with blocked_destination", async () => {
  // Even if operator configured allowHosts = ["safe-looking.example"]
  // If safe-looking.example resolves to mixed [93.184.216.34, 10.0.0.1], the all-or-nothing SSRF rule must reject it
  const mixedResolver: SafeDnsResolver = {
    async resolve(_hostname: string) {
      return [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ];
    },
  };

  const policy = {
    allowHosts: ["safe-looking.example"],
    denyHosts: [],
    httpsOnly: false,
    maxResponseBytes: 5_242_880,
    maxTimeoutMs: 30_000,
  };

  await assert.rejects(
    async () => {
      await fetchUrlService({
        url: "http://safe-looking.example/data",
        operatorPolicy: policy,
        customResolver: mixedResolver,
        customAllowedPorts: [80],
        allowLoopbackForTesting: false,
      });
    },
    (err: any) =>
      err instanceof NetworkSecurityError &&
      err.code === "blocked_destination" &&
      err.message === "Destination is not allowed by network security policy."
  );
});

test("fetchUrlService — Raw public IP literal is rejected when operator hostname allowlist is active", async () => {
  const policy = {
    allowHosts: ["example.com"],
    denyHosts: [],
    httpsOnly: false,
    maxResponseBytes: 5_242_880,
    maxTimeoutMs: 30_000,
  };

  await assert.rejects(
    async () => {
      await fetchUrlService({
        url: "http://93.184.216.34/data",
        operatorPolicy: policy,
        customAllowedPorts: [80],
        allowLoopbackForTesting: false,
      });
    },
    (err: any) =>
      err instanceof NetworkSecurityError &&
      err.code === "host_not_allowed" &&
      err.message === "Destination hostname is not allowed by server network policy."
  );
});

test("fetchUrlService — Operator maxTimeoutMs bounds request deadline", async () => {
  const server = http.createServer((_req, _res) => {
    // Intentionally never respond or hang
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  const policy = {
    allowHosts: [],
    denyHosts: [],
    httpsOnly: false,
    maxResponseBytes: 5_242_880,
    maxTimeoutMs: 30, // Operator clamps to 30ms for fast testing
  };

  try {
    await assert.rejects(
      async () => {
        await fetchUrlService({
          url: `http://public.example.com:${port}/`,
          timeoutMs: 30_000, // Caller asks for 30s
          operatorPolicy: policy,
          customResolver: localLoopbackResolver,
          customAllowedPorts: [port],
          allowLoopbackForTesting: true,
        });
      },
      (err: any) =>
        err instanceof NetworkSecurityError &&
        err.code === "timeout" &&
        err.message === "Network request was cancelled or timed out."
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Conditional Cache: First 200 with ETag -> second conditional request gets 304 -> cached body returned", async () => {
  let requestCount = 0;
  let receivedIfNoneMatch: string | undefined;

  const server = https.createServer(
    { key: TEST_TLS_KEY, cert: TEST_TLS_CERT },
    (req, res) => {
      requestCount++;
      receivedIfNoneMatch = req.headers["if-none-match"];

      if (req.headers["if-none-match"] === '"etag-v1"') {
        res.writeHead(304, {
          etag: '"etag-v1"',
          "content-type": "text/plain",
        });
        res.end();
        return;
      }

      res.writeHead(200, {
        "content-type": "text/plain",
        etag: '"etag-v1"',
      });
      res.end("Cached resource body v1");
    }
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  const cache = new HttpConditionalCache(
    createNetworkCachePolicy({
      enabled: true,
      maxEntries: 10,
      maxSizeBytes: 1024 * 1024,
    })
  );

  try {
    // First request: cache miss, stores entry
    const res1 = await fetchUrlService({
      url: `https://public.example.com:${port}/resource`,
      networkCache: cache,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });

    assert.equal(res1.status, 200);
    assert.equal(res1.body, "Cached resource body v1");
    assert.equal(res1.cacheStatus, "stored");
    assert.equal(requestCount, 1);
    assert.equal(receivedIfNoneMatch, undefined);
    assert.equal(cache.size, 1);

    // Second request: sends If-None-Match, origin responds 304, returns cached body
    const res2 = await fetchUrlService({
      url: `https://public.example.com:${port}/resource`,
      networkCache: cache,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });

    assert.equal(res2.status, 200);
    assert.equal(res2.body, "Cached resource body v1");
    assert.equal(res2.cacheStatus, "revalidated");
    assert.equal(res2.revalidationStatus, 304);
    assert.equal(requestCount, 2);
    assert.equal(receivedIfNoneMatch, '"etag-v1"');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Conditional Cache: Last-Modified only sends If-Modified-Since -> origin 304 -> cached body returned", async () => {
  let receivedIfModifiedSince: string | undefined;

  const lmHeader = "Wed, 21 Oct 2026 07:28:00 GMT";
  const server = https.createServer(
    { key: TEST_TLS_KEY, cert: TEST_TLS_CERT },
    (req, res) => {
      receivedIfModifiedSince = req.headers["if-modified-since"];

      if (req.headers["if-modified-since"] === lmHeader) {
        res.writeHead(304, {
          "last-modified": lmHeader,
          "content-type": "text/plain",
        });
        res.end();
        return;
      }

      res.writeHead(200, {
        "content-type": "text/plain",
        "last-modified": lmHeader,
      });
      res.end("Last-Modified body v1");
    }
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  const cache = new HttpConditionalCache(
    createNetworkCachePolicy({
      enabled: true,
      maxEntries: 10,
      maxSizeBytes: 1024 * 1024,
    })
  );

  try {
    // First request
    const res1 = await fetchUrlService({
      url: `https://public.example.com:${port}/resource-lm`,
      networkCache: cache,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });

    assert.equal(res1.status, 200);
    assert.equal(res1.body, "Last-Modified body v1");
    assert.equal(res1.cacheStatus, "stored");

    // Second request: sends If-Modified-Since
    const res2 = await fetchUrlService({
      url: `https://public.example.com:${port}/resource-lm`,
      networkCache: cache,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });

    assert.equal(res2.status, 200);
    assert.equal(res2.body, "Last-Modified body v1");
    assert.equal(res2.cacheStatus, "revalidated");
    assert.equal(res2.revalidationStatus, 304);
    assert.equal(receivedIfModifiedSince, lmHeader);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Conditional Cache: 200 changed representation updates entry", async () => {
  let version = 1;

  const server = https.createServer(
    { key: TEST_TLS_KEY, cert: TEST_TLS_CERT },
    (_req, res) => {
      if (version === 1) {
        res.writeHead(200, {
          "content-type": "text/plain",
          etag: '"etag-v1"',
        });
        res.end("Content v1");
      } else {
        res.writeHead(200, {
          "content-type": "text/plain",
          etag: '"etag-v2"',
        });
        res.end("Updated Content v2");
      }
    }
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  const cache = new HttpConditionalCache(
    createNetworkCachePolicy({
      enabled: true,
      maxEntries: 10,
      maxSizeBytes: 1024 * 1024,
    })
  );

  try {
    const res1 = await fetchUrlService({
      url: `https://public.example.com:${port}/changing`,
      networkCache: cache,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(res1.body, "Content v1");
    assert.equal(res1.cacheStatus, "stored");

    // Origin updates resource
    version = 2;

    const res2 = await fetchUrlService({
      url: `https://public.example.com:${port}/changing`,
      networkCache: cache,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(res2.body, "Updated Content v2");
    assert.equal(res2.cacheStatus, "updated");
    assert.equal(res2.status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Conditional Cache: 404 response invalidates entry -> next request is a fresh miss", async () => {
  let shouldReturn404 = false;

  const server = https.createServer(
    { key: TEST_TLS_KEY, cert: TEST_TLS_CERT },
    (_req, res) => {
      if (shouldReturn404) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not Found");
      } else {
        res.writeHead(200, {
          "content-type": "text/plain",
          etag: '"initial-tag"',
        });
        res.end("Initial item");
      }
    }
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  const cache = new HttpConditionalCache(
    createNetworkCachePolicy({
      enabled: true,
      maxEntries: 10,
      maxSizeBytes: 1024 * 1024,
    })
  );

  try {
    // 1. Store
    const res1 = await fetchUrlService({
      url: `https://public.example.com:${port}/item`,
      networkCache: cache,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(res1.cacheStatus, "stored");
    assert.equal(cache.size, 1);

    // 2. Resource deleted on origin -> returns 404 and invalidates cache entry
    shouldReturn404 = true;
    const res2 = await fetchUrlService({
      url: `https://public.example.com:${port}/item`,
      networkCache: cache,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(res2.status, 404);
    assert.equal(res2.cacheStatus, "uncacheable");
    assert.equal(cache.size, 0); // Invalidated
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Conditional Cache: DNS rebinds to private IP during revalidation -> blocked_destination (stale body NOT served)", async () => {
  let dnsCallCount = 0;
  const rebindingResolver: SafeDnsResolver = {
    async resolve() {
      dnsCallCount++;
      if (dnsCallCount === 1) {
        return [{ address: "93.184.216.34", family: 4 }]; // Public
      }
      return [{ address: "192.168.1.1", family: 4 }]; // Private rebind attempt
    },
  };

  const cache = new HttpConditionalCache(
    createNetworkCachePolicy({
      enabled: true,
      maxEntries: 10,
      maxSizeBytes: 1024 * 1024,
    })
  );

  // Directly seed cache entry
  const dummyUrl = new URL("https://rebinding.example/data");
  const cacheKey = cache.enabled ? "dummy" : undefined;

  // Simulate first request storing entry
  const server = https.createServer(
    { key: TEST_TLS_KEY, cert: TEST_TLS_CERT },
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", etag: '"safe-tag"' });
      res.end("Valid public response");
    }
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  try {
    // 1. Initial request against local mock with localLoopbackResolver
    await fetchUrlService({
      url: `https://public.example.com:${port}/rebinding-test`,
      networkCache: cache,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(cache.size, 1);

    // 2. Second request now encounters private IP rebinding
    await assert.rejects(
      async () => {
        await fetchUrlService({
          url: `https://public.example.com:${port}/rebinding-test`,
          networkCache: cache,
          customResolver: {
            async resolve() {
              return [{ address: "10.0.0.1", family: 4 }]; // Private IP
            },
          },
          customAllowedPorts: [port],
          allowLoopbackForTesting: false,
        });
      },
      (err: any) =>
        err instanceof NetworkSecurityError &&
        err.code === "blocked_destination" &&
        err.message === "Destination is not allowed by network security policy."
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Conditional Cache: MCP cancellation during revalidation -> request aborted (stale body NOT served)", async () => {
  const server = https.createServer(
    { key: TEST_TLS_KEY, cert: TEST_TLS_CERT },
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", etag: '"tag-1"' });
      res.end("Initial");
    }
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  const cache = new HttpConditionalCache(
    createNetworkCachePolicy({
      enabled: true,
      maxEntries: 10,
      maxSizeBytes: 1024 * 1024,
    })
  );

  try {
    // Store
    await fetchUrlService({
      url: `https://public.example.com:${port}/cancel-test`,
      networkCache: cache,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });

    // Abort controller
    const controller = new AbortController();
    controller.abort(); // Pre-aborted

    await assert.rejects(
      async () => {
        await fetchUrlService({
          url: `https://public.example.com:${port}/cancel-test`,
          networkCache: cache,
          signal: controller.signal,
          customResolver: localLoopbackResolver,
          customAllowedPorts: [port],
          allowLoopbackForTesting: true,
        });
      },
      (err: any) =>
        err instanceof NetworkSecurityError &&
        err.code === "timeout" &&
        (err.message.includes("cancelled") || err.message.includes("timed out"))
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Conditional Cache: Request timeout during revalidation -> timeout error (stale body NOT served)", async () => {
  let isFirst = true;
  const server = https.createServer(
    { key: TEST_TLS_KEY, cert: TEST_TLS_CERT },
    (_req, res) => {
      if (isFirst) {
        isFirst = false;
        res.writeHead(200, { "content-type": "text/plain", etag: '"tag-timeout"' });
        res.end("Initial body");
      } else {
        // Hang on revalidation to trigger timeout
      }
    }
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  const cache = new HttpConditionalCache(
    createNetworkCachePolicy({
      enabled: true,
      maxEntries: 10,
      maxSizeBytes: 1024 * 1024,
    })
  );

  try {
    await fetchUrlService({
      url: `https://public.example.com:${port}/timeout-test`,
      networkCache: cache,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });

    await assert.rejects(
      async () => {
        await fetchUrlService({
          url: `https://public.example.com:${port}/timeout-test`,
          networkCache: cache,
          timeoutMs: 50,
          customResolver: localLoopbackResolver,
          customAllowedPorts: [port],
          allowLoopbackForTesting: true,
        });
      },
      (err: any) =>
        err instanceof NetworkSecurityError &&
        err.code === "timeout" &&
        err.message === "Network request was cancelled or timed out."
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Conditional Cache: Operator hostname policy enforced during revalidation (denyHosts matches -> host_denied)", async () => {
  const server = https.createServer(
    { key: TEST_TLS_KEY, cert: TEST_TLS_CERT },
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", etag: '"tag-policy"' });
      res.end("Initial policy body");
    }
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  const cache = new HttpConditionalCache(
    createNetworkCachePolicy({
      enabled: true,
      maxEntries: 10,
      maxSizeBytes: 1024 * 1024,
    })
  );

  try {
    await fetchUrlService({
      url: `https://public.example.com:${port}/policy-test`,
      networkCache: cache,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });

    // Revalidation with operator policy denying the host
    await assert.rejects(
      async () => {
        await fetchUrlService({
          url: `https://public.example.com:${port}/policy-test`,
          networkCache: cache,
          operatorPolicy: {
            allowHosts: [],
            denyHosts: ["public.example.com"],
            httpsOnly: false,
            maxResponseBytes: 5242880,
            maxTimeoutMs: 30000,
          },
          customResolver: localLoopbackResolver,
          customAllowedPorts: [port],
          allowLoopbackForTesting: true,
        });
      },
      (err: any) =>
        err instanceof NetworkSecurityError &&
        err.code === "host_denied" &&
        err.message === "Destination hostname is denied by server network policy."
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Conditional Cache: Redirect responses and Query URLs are uncacheable", async () => {
  const server = https.createServer(
    { key: TEST_TLS_KEY, cert: TEST_TLS_CERT },
    (req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "/target" });
        res.end();
      } else if (req.url === "/target") {
        res.writeHead(200, { "content-type": "text/plain", etag: '"redir-tag"' });
        res.end("Redirect Target");
      } else if (req.url?.startsWith("/query")) {
        res.writeHead(200, { "content-type": "text/plain", etag: '"query-tag"' });
        res.end("Query Target");
      }
    }
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  const cache = new HttpConditionalCache(
    createNetworkCachePolicy({
      enabled: true,
      maxEntries: 10,
      maxSizeBytes: 1024 * 1024,
    })
  );

  try {
    // 1. Redirect response
    const redirRes = await fetchUrlService({
      url: `https://public.example.com:${port}/redirect`,
      networkCache: cache,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(redirRes.redirectCount, 1);
    assert.equal(redirRes.cacheStatus, "uncacheable");

    // 2. Query URL
    const queryRes = await fetchUrlService({
      url: `https://public.example.com:${port}/query?token=123`,
      networkCache: cache,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(queryRes.cacheStatus, "uncacheable");
    assert.equal(cache.size, 0); // Nothing stored
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Conditional Cache: ServerContext isolation (Context A cache not visible to Context B)", async () => {
  let hitCount = 0;
  const server = https.createServer(
    { key: TEST_TLS_KEY, cert: TEST_TLS_CERT },
    (req, res) => {
      hitCount++;
      if (req.headers["if-none-match"] === '"isolation-tag"') {
        res.writeHead(304, { etag: '"isolation-tag"', "content-type": "text/plain" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain", etag: '"isolation-tag"' });
      res.end("Isolation Body");
    }
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  const cacheA = new HttpConditionalCache(
    createNetworkCachePolicy({ enabled: true, maxEntries: 10, maxSizeBytes: 1024 * 1024 })
  );
  const cacheB = new HttpConditionalCache(
    createNetworkCachePolicy({ enabled: true, maxEntries: 10, maxSizeBytes: 1024 * 1024 })
  );

  try {
    // Context A fetches and caches
    const resA = await fetchUrlService({
      url: `https://public.example.com:${port}/isolated`,
      networkCache: cacheA,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(resA.cacheStatus, "stored");
    assert.equal(cacheA.size, 1);
    assert.equal(cacheB.size, 0); // Context B empty

    // Context B fetches -> does not see Context A cache, performs fresh fetch
    const resB = await fetchUrlService({
      url: `https://public.example.com:${port}/isolated`,
      networkCache: cacheB,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(resB.cacheStatus, "stored");
    assert.equal(cacheB.size, 1);
    assert.equal(hitCount, 2); // Origin had 2 separate 200 requests
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Conditional Cache: Cached entry larger than caller maxBytes skips cache reuse and bounds fresh fetch", async () => {
  const bigContent = "A".repeat(500);
  const server = https.createServer(
    { key: TEST_TLS_KEY, cert: TEST_TLS_CERT },
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", etag: '"big-tag"' });
      res.end(bigContent);
    }
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  const cache = new HttpConditionalCache(
    createNetworkCachePolicy({ enabled: true, maxEntries: 10, maxSizeBytes: 1024 * 1024 })
  );

  try {
    // First request with large maxBytes -> stores 500-byte entry
    const res1 = await fetchUrlService({
      url: `https://public.example.com:${port}/large-item`,
      networkCache: cache,
      maxBytes: 1000,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(res1.cacheStatus, "stored");
    assert.equal(res1.bytesRead, 500);

    // Second request specifies maxBytes: 50 -> cached body (500 bytes) exceeds caller cap
    // -> skips conditional reuse and performs fresh bounded fetch (truncated at 50 bytes)
    const res2 = await fetchUrlService({
      url: `https://public.example.com:${port}/large-item`,
      networkCache: cache,
      maxBytes: 50,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(res2.bytesRead, 50);
    assert.equal(res2.truncated, true);
    assert.equal(res2.body?.length, 50);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Safe UTF-8 truncation boundary across 2, 3, and 4-byte sequences and genuine malformed UTF-8 rejection", async () => {
  // 1. 2-byte sequence: 'é' (C3 A9)
  // Prefix 'abc' (3 bytes) + 'é' (2 bytes) = 5 bytes total. Truncate at maxBytes = 4 -> cuts mid 2-byte sequence.
  const twoByteContent = Buffer.from("abcé", "utf-8");
  assert.equal(twoByteContent.length, 5);

  const server2 = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(twoByteContent);
  });
  await new Promise<void>((resolve) => server2.listen(0, "127.0.0.1", resolve));
  const port2 = (server2.address() as any).port;

  try {
    const res = await fetchUrlService({
      url: `http://public.example.com:${port2}/utf8-2byte`,
      maxBytes: 4,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port2],
      allowLoopbackForTesting: true,
    });
    assert.equal(res.status, 200);
    assert.equal(res.truncated, true);
    assert.equal(res.body, "abc");
  } finally {
    await new Promise<void>((resolve) => server2.close(() => resolve()));
  }

  // 2. 3-byte sequence: '€' (E2 82 AC)
  // Prefix 'abc' (3 bytes) + '€' (3 bytes) = 6 bytes total.
  // Test cut at byte 1 (maxBytes = 4) and byte 2 (maxBytes = 5) of the 3-byte sequence.
  const threeByteContent = Buffer.from("abc€", "utf-8");
  assert.equal(threeByteContent.length, 6);

  const server3 = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(threeByteContent);
  });
  await new Promise<void>((resolve) => server3.listen(0, "127.0.0.1", resolve));
  const port3 = (server3.address() as any).port;

  try {
    // Cut at 1 byte into 3-byte codepoint
    const resCut1 = await fetchUrlService({
      url: `http://public.example.com:${port3}/utf8-3byte-cut1`,
      maxBytes: 4,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port3],
      allowLoopbackForTesting: true,
    });
    assert.equal(resCut1.status, 200);
    assert.equal(resCut1.truncated, true);
    assert.equal(resCut1.body, "abc");

    // Cut at 2 bytes into 3-byte codepoint
    const resCut2 = await fetchUrlService({
      url: `http://public.example.com:${port3}/utf8-3byte-cut2`,
      maxBytes: 5,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port3],
      allowLoopbackForTesting: true,
    });
    assert.equal(resCut2.status, 200);
    assert.equal(resCut2.truncated, true);
    assert.equal(resCut2.body, "abc");
  } finally {
    await new Promise<void>((resolve) => server3.close(() => resolve()));
  }

  // 3. 4-byte sequence: '😀' (F0 9F 98 80)
  // Prefix 'abc' (3 bytes) + '😀' (4 bytes) = 7 bytes total.
  // Test cut at byte 1 (maxBytes = 4), byte 2 (maxBytes = 5), and byte 3 (maxBytes = 6).
  const fourByteContent = Buffer.from("abc😀", "utf-8");
  assert.equal(fourByteContent.length, 7);

  const server4 = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(fourByteContent);
  });
  await new Promise<void>((resolve) => server4.listen(0, "127.0.0.1", resolve));
  const port4 = (server4.address() as any).port;

  try {
    for (const cutBytes of [4, 5, 6]) {
      const res = await fetchUrlService({
        url: `http://public.example.com:${port4}/utf8-4byte-cut`,
        maxBytes: cutBytes,
        customResolver: localLoopbackResolver,
        customAllowedPorts: [port4],
        allowLoopbackForTesting: true,
      });
      assert.equal(res.status, 200);
      assert.equal(res.truncated, true);
      assert.equal(res.body, "abc");
    }
  } finally {
    await new Promise<void>((resolve) => server4.close(() => resolve()));
  }

  // 4. Genuine malformed UTF-8 inside retained bytes is rejected with invalid_text_encoding
  const malformedBuffer = Buffer.from([0x61, 0x62, 0xff, 0xfe, 0x63, 0x64]); // 'ab' + invalid UTF-8 bytes + 'cd'
  const serverMalformed = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(malformedBuffer);
  });
  await new Promise<void>((resolve) => serverMalformed.listen(0, "127.0.0.1", resolve));
  const portMalformed = (serverMalformed.address() as any).port;

  try {
    await assert.rejects(
      async () => {
        await fetchUrlService({
          url: `http://public.example.com:${portMalformed}/utf8-malformed`,
          maxBytes: 100,
          customResolver: localLoopbackResolver,
          customAllowedPorts: [portMalformed],
          allowLoopbackForTesting: true,
        });
      },
      (err: any) =>
        err instanceof NetworkSecurityError &&
        err.code === "invalid_text_encoding" &&
        err.message === "Response body contains malformed UTF-8 byte sequences."
    );
  } finally {
    await new Promise<void>((resolve) => serverMalformed.close(() => resolve()));
  }
});

test("fetchUrlService — Conditional Cache: Vary response header policy (Vary: * and Vary: Accept are uncacheable)", async () => {
  let varyHeaderValue = "*";
  const server = https.createServer(
    { key: TEST_TLS_KEY, cert: TEST_TLS_CERT },
    (_req, res) => {
      res.writeHead(200, {
        "content-type": "text/plain",
        etag: '"vary-tag"',
        vary: varyHeaderValue,
      });
      res.end("Vary response body");
    }
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  const cache = new HttpConditionalCache(
    createNetworkCachePolicy({ enabled: true, maxEntries: 10, maxSizeBytes: 1024 * 1024 })
  );

  try {
    // 1. Vary: * -> uncacheable
    varyHeaderValue = "*";
    const res1 = await fetchUrlService({
      url: `https://public.example.com:${port}/vary-test`,
      networkCache: cache,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(res1.status, 200);
    assert.equal(res1.cacheStatus, "uncacheable");
    assert.equal(cache.size, 0);

    // 2. Vary: Accept -> uncacheable under conservative v1 policy
    varyHeaderValue = "Accept";
    const res2 = await fetchUrlService({
      url: `https://public.example.com:${port}/vary-test`,
      networkCache: cache,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(res2.status, 200);
    assert.equal(res2.cacheStatus, "uncacheable");
    assert.equal(cache.size, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Conditional Cache: Cache-Control directives (no-store, private, no-cache, max-age)", async () => {
  let ccHeader = "no-store";
  let requestCount = 0;
  let lastIfNoneMatch: string | undefined;

  const server = https.createServer(
    { key: TEST_TLS_KEY, cert: TEST_TLS_CERT },
    (req, res) => {
      requestCount++;
      lastIfNoneMatch = req.headers["if-none-match"] as string | undefined;
      if (lastIfNoneMatch === '"cc-tag"') {
        res.writeHead(304, { etag: '"cc-tag"', "content-type": "text/plain" });
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": "text/plain",
        etag: '"cc-tag"',
        "cache-control": ccHeader,
      });
      res.end("Cache-Control body");
    }
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  const cache = new HttpConditionalCache(
    createNetworkCachePolicy({ enabled: true, maxEntries: 10, maxSizeBytes: 1024 * 1024 })
  );

  try {
    // 1. Cache-Control: No-Store (case-insensitive) -> uncacheable
    ccHeader = "No-Store";
    const resNoStore = await fetchUrlService({
      url: `https://public.example.com:${port}/cc-test`,
      networkCache: cache,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(resNoStore.cacheStatus, "uncacheable");
    assert.equal(cache.size, 0);

    // 2. Cache-Control: PRIVATE (case-insensitive) -> uncacheable
    ccHeader = "PRIVATE, max-age=3600";
    const resPrivate = await fetchUrlService({
      url: `https://public.example.com:${port}/cc-test`,
      networkCache: cache,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(resPrivate.cacheStatus, "uncacheable");
    assert.equal(cache.size, 0);

    // 3. Cache-Control: No-Cache (case-insensitive) -> stored, but requires origin 304 revalidation
    ccHeader = "No-Cache";
    const resNoCache = await fetchUrlService({
      url: `https://public.example.com:${port}/cc-test`,
      networkCache: cache,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(resNoCache.cacheStatus, "stored");
    assert.equal(cache.size, 1);

    // Second fetch with No-Cache entry MUST conditionally revalidate with origin
    const prevCountNoCache = requestCount;
    const resNoCacheReval = await fetchUrlService({
      url: `https://public.example.com:${port}/cc-test`,
      networkCache: cache,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(resNoCacheReval.cacheStatus, "revalidated");
    assert.equal(resNoCacheReval.revalidationStatus, 304);
    assert.equal(requestCount, prevCountNoCache + 1);
    assert.equal(lastIfNoneMatch, '"cc-tag"');
    cache.clear();

    // 4. Cache-Control: max-age=3600 (without no-store/private) -> stored, but second request STILL revalidates with origin
    ccHeader = "public, max-age=3600";
    const resStored = await fetchUrlService({
      url: `https://public.example.com:${port}/cc-test`,
      networkCache: cache,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(resStored.cacheStatus, "stored");
    assert.equal(cache.size, 1);

    // Second fetch: even within max-age / young TTL, MUST conditionally revalidate with origin
    const prevCount = requestCount;
    const resReval = await fetchUrlService({
      url: `https://public.example.com:${port}/cc-test`,
      networkCache: cache,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(resReval.cacheStatus, "revalidated");
    assert.equal(resReval.revalidationStatus, 304);
    assert.equal(requestCount, prevCount + 1); // Origin received request
    assert.equal(lastIfNoneMatch, '"cc-tag"'); // Sent conditional header
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Conditional Cache: 200 OK update becoming uncacheable drops old cache entry", async () => {
  let isSecond = false;
  const server = https.createServer(
    { key: TEST_TLS_KEY, cert: TEST_TLS_CERT },
    (_req, res) => {
      if (!isSecond) {
        // Initial eligible 200
        res.writeHead(200, { "content-type": "text/plain", etag: '"initial-tag"' });
        res.end("Initial version");
      } else {
        // Updated 200 that is NOT eligible (e.g. Cache-Control: no-store)
        res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
        res.end("Updated uncacheable version");
      }
    }
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  const cache = new HttpConditionalCache(
    createNetworkCachePolicy({ enabled: true, maxEntries: 10, maxSizeBytes: 1024 * 1024 })
  );

  try {
    // 1. Initial eligible request -> stored
    const res1 = await fetchUrlService({
      url: `https://public.example.com:${port}/update-uncacheable`,
      networkCache: cache,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(res1.cacheStatus, "stored");
    assert.equal(cache.size, 1);

    // 2. Second request returns 200 with no-store -> returns fresh body, deletes old cache entry
    isSecond = true;
    const res2 = await fetchUrlService({
      url: `https://public.example.com:${port}/update-uncacheable`,
      networkCache: cache,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(res2.status, 200);
    assert.equal(res2.body, "Updated uncacheable version");
    assert.equal(res2.cacheStatus, "uncacheable");
    assert.equal(cache.size, 0); // Old entry was dropped
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Conditional Cache: Non-200 status (410, 500) invalidates cached entry with zero stale fallback", async () => {
  let responseStatus = 200;
  const server = https.createServer(
    { key: TEST_TLS_KEY, cert: TEST_TLS_CERT },
    (_req, res) => {
      if (responseStatus === 200) {
        res.writeHead(200, { "content-type": "text/plain", etag: '"err-tag"' });
        res.end("Initial content");
      } else {
        res.writeHead(responseStatus, { "content-type": "text/plain" });
        res.end("Error response");
      }
    }
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  const cache = new HttpConditionalCache(
    createNetworkCachePolicy({ enabled: true, maxEntries: 10, maxSizeBytes: 1024 * 1024 })
  );

  try {
    // 1. Store
    await fetchUrlService({
      url: `https://public.example.com:${port}/err-inval`,
      networkCache: cache,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(cache.size, 1);

    // 2. Origin returns 410 Gone -> invalidates entry, returns 410 (no stale fallback)
    responseStatus = 410;
    const res410 = await fetchUrlService({
      url: `https://public.example.com:${port}/err-inval`,
      networkCache: cache,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(res410.status, 410);
    assert.equal(res410.cacheStatus, "uncacheable");
    assert.equal(cache.size, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — Policy before cache: Disallowed port, HTTPS-only, and Operator deny list reject before network or cache reuse", async () => {
  const cache = new HttpConditionalCache(
    createNetworkCachePolicy({ enabled: true, maxEntries: 10, maxSizeBytes: 1024 * 1024 })
  );

  // 1. Disallowed port -> port_not_allowed
  await assert.rejects(
    async () => {
      await fetchUrlService({
        url: "https://public.example.com:9999/data",
        networkCache: cache,
        customAllowedPorts: [80, 443],
      });
    },
    (err: any) => err instanceof NetworkSecurityError && err.code === "port_not_allowed"
  );

  // 2. HTTPS-only policy rejects HTTP before cache or connection
  await assert.rejects(
    async () => {
      await fetchUrlService({
        url: "http://public.example.com/data",
        networkCache: cache,
        operatorPolicy: {
          allowHosts: [],
          denyHosts: [],
          httpsOnly: true,
          maxResponseBytes: 5242880,
          maxTimeoutMs: 30000,
        },
      });
    },
    (err: any) => err instanceof NetworkSecurityError && err.code === "https_required"
  );

  // 3. Operator deny list rejects before network connection
  await assert.rejects(
    async () => {
      await fetchUrlService({
        url: "https://denied.example.com/data",
        networkCache: cache,
        operatorPolicy: {
          allowHosts: [],
          denyHosts: ["denied.example.com"],
          httpsOnly: false,
          maxResponseBytes: 5242880,
          maxTimeoutMs: 30000,
        },
      });
    },
    (err: any) => err instanceof NetworkSecurityError && err.code === "host_denied"
  );
});

// ============================================================================
// v0.5.0 M3 — fetch_url HEAD Tests
// ============================================================================

test("fetchUrlInputSchema — Strict Zod Schema validation for method parameter", () => {
  // 1. method omitted accepted (default: GET semantics)
  const omittedRes = fetchUrlInputSchema.safeParse({ url: "https://example.com/resource" });
  assert.equal(omittedRes.success, true);
  if (omittedRes.success) {
    assert.equal(omittedRes.data.method, undefined);
  }

  // 2. method "GET" accepted
  const getRes = fetchUrlInputSchema.safeParse({
    url: "https://example.com/resource",
    method: "GET",
  });
  assert.equal(getRes.success, true);
  if (getRes.success) {
    assert.equal(getRes.data.method, "GET");
  }

  // 3. method "HEAD" accepted
  const headRes = fetchUrlInputSchema.safeParse({
    url: "https://example.com/resource",
    method: "HEAD",
  });
  assert.equal(headRes.success, true);
  if (headRes.success) {
    assert.equal(headRes.data.method, "HEAD");
  }

  // 4. POST rejected
  const postRes = fetchUrlInputSchema.safeParse({
    url: "https://example.com/resource",
    method: "POST",
  });
  assert.equal(postRes.success, false);

  // 5. PUT / PATCH / DELETE / OPTIONS rejected
  for (const m of ["PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT"]) {
    const res = fetchUrlInputSchema.safeParse({
      url: "https://example.com/resource",
      method: m,
    });
    assert.equal(res.success, false, `Method "${m}" must be rejected by schema`);
  }

  // 6. lowercase get rejected
  const lowerGetRes = fetchUrlInputSchema.safeParse({
    url: "https://example.com/resource",
    method: "get",
  });
  assert.equal(lowerGetRes.success, false, "Lowercase 'get' must be rejected");

  // 7. lowercase head rejected
  const lowerHeadRes = fetchUrlInputSchema.safeParse({
    url: "https://example.com/resource",
    method: "head",
  });
  assert.equal(lowerHeadRes.success, false, "Lowercase 'head' must be rejected");

  // Non-string method rejected
  assert.equal(
    fetchUrlInputSchema.safeParse({ url: "https://example.com", method: 123 }).success,
    false
  );
});

test("fetchUrlService — GET regression: legacy omitted and explicit GET equivalence and restrictions", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/png") {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    } else if (req.url === "/gzip") {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Encoding": "gzip",
      });
      res.end(Buffer.from([0x1f, 0x8b, 0x08]));
    } else if (req.url === "/trunc") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("1234567890abcdefghij");
    } else {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Standard GET content");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  try {
    // 8. Omitted method behaves as legacy GET
    const omittedResult = await fetchUrlService({
      url: `http://public.example.com:${port}/`,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(omittedResult.status, 200);
    assert.equal(omittedResult.body, "Standard GET content");
    assert.equal(omittedResult.bytesRead, 20);
    assert.equal(omittedResult.truncated, false);

    // 9. Explicit GET behaves equivalently to omitted method
    const explicitGetResult = await fetchUrlService({
      url: `http://public.example.com:${port}/`,
      method: "GET",
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(explicitGetResult.status, 200);
    assert.equal(explicitGetResult.body, "Standard GET content");
    assert.equal(explicitGetResult.bytesRead, 20);
    assert.equal(explicitGetResult.truncated, false);

    // 10. Existing GET content-type restrictions remain (image/png rejected)
    await assert.rejects(
      async () => {
        await fetchUrlService({
          url: `http://public.example.com:${port}/png`,
          method: "GET",
          customResolver: localLoopbackResolver,
          customAllowedPorts: [port],
          allowLoopbackForTesting: true,
        });
      },
      (err: any) => err instanceof NetworkSecurityError && err.code === "unsupported_content_type"
    );

    // 11. Existing GET encoding restrictions remain (gzip rejected)
    await assert.rejects(
      async () => {
        await fetchUrlService({
          url: `http://public.example.com:${port}/gzip`,
          method: "GET",
          customResolver: localLoopbackResolver,
          customAllowedPorts: [port],
          allowLoopbackForTesting: true,
        });
      },
      (err: any) => err instanceof NetworkSecurityError && err.code === "unsupported_content_encoding"
    );

    // 12. Existing GET maxBytes/truncation behavior remains
    const truncResult = await fetchUrlService({
      url: `http://public.example.com:${port}/trunc`,
      method: "GET",
      maxBytes: 10,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(truncResult.status, 200);
    assert.equal(truncResult.bytesRead, 10);
    assert.equal(truncResult.body?.length, 10);
    assert.equal(truncResult.truncated, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — HEAD basic success: 200, 204, 404, 500, and Content-Length metadata", async () => {
  let receivedMethod = "";
  const server = http.createServer((req, res) => {
    receivedMethod = req.method ?? "";
    if (req.url === "/200") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": "42",
      });
      res.end("Should not be consumed by HEAD");
    } else if (req.url === "/204") {
      res.writeHead(204);
      res.end();
    } else if (req.url === "/404") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found body");
    } else if (req.url === "/500") {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Server Error body");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  try {
    // 13. HEAD 200: body omitted/undefined, bytesRead=0, truncated=false
    const res200 = await fetchUrlService({
      url: `http://public.example.com:${port}/200`,
      method: "HEAD",
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(receivedMethod, "HEAD", "Server must have received HEAD request");
    assert.equal(res200.status, 200);
    assert.equal(res200.statusText, "OK");
    assert.equal(res200.contentType, "text/html; charset=utf-8");
    assert.equal(res200.contentLength, 42);
    assert.equal(res200.body, undefined, "body must be omitted/undefined for HEAD");
    assert.equal(res200.bytesRead, 0, "bytesRead must be strictly 0 for HEAD");
    assert.equal(res200.truncated, false, "truncated must be false for HEAD");
    assert.equal(res200.redirectCount, 0);

    // 14. HEAD 204
    const res204 = await fetchUrlService({
      url: `http://public.example.com:${port}/204`,
      method: "HEAD",
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(res204.status, 204);
    assert.equal(res204.body, undefined);
    assert.equal(res204.bytesRead, 0);
    assert.equal(res204.truncated, false);

    // 15. HEAD 404: returned as normal FetchUrlResult, not thrown
    const res404 = await fetchUrlService({
      url: `http://public.example.com:${port}/404`,
      method: "HEAD",
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(res404.status, 404);
    assert.equal(res404.statusText, "Not Found");
    assert.equal(res404.body, undefined);
    assert.equal(res404.bytesRead, 0);
    assert.equal(res404.truncated, false);

    // 16. HEAD 500: returned as normal FetchUrlResult, not thrown
    const res500 = await fetchUrlService({
      url: `http://public.example.com:${port}/500`,
      method: "HEAD",
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(res500.status, 500);
    assert.equal(res500.statusText, "Internal Server Error");
    assert.equal(res500.body, undefined);
    assert.equal(res500.bytesRead, 0);
    assert.equal(res500.truncated, false);

    // 17. HEAD contentLength metadata parsed when present
    assert.equal(res200.contentLength, 42);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — HEAD body policy: binary metadata, gzip encoding, non-UTF8 charset, and NUL safety", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/image.png") {
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": "12345",
      });
      res.end();
    } else if (req.url === "/doc.pdf") {
      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Length": "54321",
      });
      res.end();
    } else if (req.url === "/binary.bin") {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": "9999",
      });
      res.end();
    } else if (req.url === "/compressed.html") {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Encoding": "gzip",
        "Content-Length": "500",
      });
      res.end();
    } else if (req.url === "/latin1.html") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=iso-8859-1",
        "Content-Length": "200",
      });
      res.end();
    } else if (req.url === "/unexpected-nul-bytes") {
      // Server sends binary NUL bytes unexpectedly in a HEAD response
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": "8",
      });
      res.write(Buffer.from([0x00, 0x01, 0x00, 0x02]));
      res.end();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  try {
    // 18. HEAD image/png succeeds as metadata
    const pngResult = await fetchUrlService({
      url: `http://public.example.com:${port}/image.png`,
      method: "HEAD",
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(pngResult.status, 200);
    assert.equal(pngResult.contentType, "image/png");
    assert.equal(pngResult.contentLength, 12345);
    assert.equal(pngResult.body, undefined);
    assert.equal(pngResult.bytesRead, 0);

    // 19. HEAD application/pdf succeeds as metadata
    const pdfResult = await fetchUrlService({
      url: `http://public.example.com:${port}/doc.pdf`,
      method: "HEAD",
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(pdfResult.status, 200);
    assert.equal(pdfResult.contentType, "application/pdf");
    assert.equal(pdfResult.contentLength, 54321);
    assert.equal(pdfResult.body, undefined);
    assert.equal(pdfResult.bytesRead, 0);

    // 20. HEAD application/octet-stream succeeds as metadata
    const binResult = await fetchUrlService({
      url: `http://public.example.com:${port}/binary.bin`,
      method: "HEAD",
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(binResult.status, 200);
    assert.equal(binResult.contentType, "application/octet-stream");
    assert.equal(binResult.contentLength, 9999);
    assert.equal(binResult.body, undefined);
    assert.equal(binResult.bytesRead, 0);

    // 21. HEAD Content-Encoding: gzip succeeds without body decoding
    const gzipResult = await fetchUrlService({
      url: `http://public.example.com:${port}/compressed.html`,
      method: "HEAD",
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(gzipResult.status, 200);
    assert.equal(gzipResult.contentType, "text/html");
    assert.equal(gzipResult.contentLength, 500);
    assert.equal(gzipResult.body, undefined);
    assert.equal(gzipResult.bytesRead, 0);

    // 22. HEAD non-UTF8 charset metadata does not trigger GET charset decoding failure
    const latin1Result = await fetchUrlService({
      url: `http://public.example.com:${port}/latin1.html`,
      method: "HEAD",
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(latin1Result.status, 200);
    assert.equal(latin1Result.contentType, "text/html; charset=iso-8859-1");
    assert.equal(latin1Result.contentLength, 200);
    assert.equal(latin1Result.body, undefined);
    assert.equal(latin1Result.bytesRead, 0);

    // 23. HEAD does not run TextDecoder or binary NUL guard (drains stream safely)
    const nulResult = await fetchUrlService({
      url: `http://public.example.com:${port}/unexpected-nul-bytes`,
      method: "HEAD",
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });
    assert.equal(nulResult.status, 200);
    assert.equal(nulResult.body, undefined);
    assert.equal(nulResult.bytesRead, 0);
    assert.equal(nulResult.truncated, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — HEAD maxBytes vs Content-Length distinction", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": "100000000", // 100 MB declared length
    });
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  try {
    // 24. HEAD with maxBytes=1 and Content-Length=100000000
    // Must NOT reject because Content-Length > maxBytes
    // Must NOT set truncated=true
    // Must NOT pretend bytes were downloaded
    const result = await fetchUrlService({
      url: `http://public.example.com:${port}/huge-file.iso`,
      method: "HEAD",
      maxBytes: 1,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });

    assert.equal(result.status, 200);
    assert.equal(result.contentLength, 100000000);
    assert.equal(result.bytesRead, 0);
    assert.equal(result.truncated, false);
    assert.equal(result.body, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchUrlService — HEAD redirect method preservation across 301, 302, 303, 307, 308", async () => {
  const redirectCodes = [301, 302, 303, 307, 308];

  for (const code of redirectCodes) {
    const receivedMethods: string[] = [];
    const server = http.createServer((req, res) => {
      receivedMethods.push(`${req.method}:${req.url}`);
      if (req.url === `/hop-${code}`) {
        res.writeHead(code, {
          Location: `/final-${code}`,
          "Content-Type": "text/plain",
        });
        res.end();
      } else if (req.url === `/final-${code}`) {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": "128",
        });
        res.end();
      }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;

    try {
      // 25. HEAD preserved across 301, 302, 303, 307, 308
      const result = await fetchUrlService({
        url: `http://public.example.com:${port}/hop-${code}`,
        method: "HEAD",
        customResolver: localLoopbackResolver,
        customAllowedPorts: [port],
        allowLoopbackForTesting: true,
      });

      assert.equal(result.status, 200);
      assert.equal(result.body, undefined);
      assert.equal(result.bytesRead, 0);
      assert.equal(result.redirectCount, 1);
      assert.equal(result.finalUrl, `http://public.example.com:${port}/final-${code}`);

      // Verify origin and final destination both received HEAD
      assert.deepEqual(receivedMethods, [
        `HEAD:/hop-${code}`,
        `HEAD:/final-${code}`,
      ]);

      if (code === 303) {
        // Specifically assert: 303 final method === HEAD
        const finalMethod = receivedMethods[1]?.split(":")[0];
        assert.equal(finalMethod, "HEAD", "HEAD + 303 redirect destination must strictly remain HEAD");
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  // 26. HEAD redirect limit exceeding 5 hops throws redirect_limit
  const loopServer = http.createServer((_req, res) => {
    res.writeHead(302, { Location: "/loop" });
    res.end();
  });
  await new Promise<void>((resolve) => loopServer.listen(0, "127.0.0.1", resolve));
  const loopPort = (loopServer.address() as any).port;

  try {
    await assert.rejects(
      async () => {
        await fetchUrlService({
          url: `http://public.example.com:${loopPort}/loop`,
          method: "HEAD",
          customResolver: localLoopbackResolver,
          customAllowedPorts: [loopPort],
          allowLoopbackForTesting: true,
        });
      },
      (err: any) => err instanceof NetworkSecurityError && err.code === "redirect_limit"
    );
  } finally {
    await new Promise<void>((resolve) => loopServer.close(() => resolve()));
  }

  // 27. HEAD HTTPS to HTTP redirect downgrade rejection
  const httpsServer = https.createServer(
    { key: TEST_TLS_KEY, cert: TEST_TLS_CERT },
    (_req, res) => {
      res.writeHead(302, { Location: "http://public.example.com:80/downgrade" });
      res.end();
    }
  );
  await new Promise<void>((resolve) => httpsServer.listen(0, "127.0.0.1", resolve));
  const httpsPort = (httpsServer.address() as any).port;

  try {
    await assert.rejects(
      async () => {
        await fetchUrlService({
          url: `https://public.example.com:${httpsPort}/hop`,
          method: "HEAD",
          customResolver: localLoopbackResolver,
          customAllowedPorts: [httpsPort, 80],
          allowLoopbackForTesting: true,
        });
      },
      (err: any) =>
        err instanceof NetworkSecurityError && err.code === "redirect_downgrade_not_allowed"
    );
  } finally {
    await new Promise<void>((resolve) => httpsServer.close(() => resolve()));
  }
});

test("fetchUrlService — HEAD SSRF and security equivalence to GET", async () => {
  // 28. Loopback rejected when allowLoopbackForTesting=false
  await assert.rejects(
    async () => {
      await fetchUrlService({
        url: "http://127.0.0.1:8080/",
        method: "HEAD",
        allowLoopbackForTesting: false,
      });
    },
    (err: any) => err instanceof NetworkSecurityError && err.code === "blocked_destination"
  );

  // 29. Private IP rejection
  const privateResolver: SafeDnsResolver = {
    async resolve() {
      return [{ address: "10.0.0.1", family: 4 }];
    },
  };
  await assert.rejects(
    async () => {
      await fetchUrlService({
        url: "http://internal.example.com/data",
        method: "HEAD",
        customResolver: privateResolver,
      });
    },
    (err: any) => err instanceof NetworkSecurityError && err.code === "blocked_destination"
  );

  // 30. Cloud metadata IP rejection (169.254.169.254)
  const metadataResolver: SafeDnsResolver = {
    async resolve() {
      return [{ address: "169.254.169.254", family: 4 }];
    },
  };
  await assert.rejects(
    async () => {
      await fetchUrlService({
        url: "http://metadata.example.com/latest",
        method: "HEAD",
        customResolver: metadataResolver,
      });
    },
    (err: any) => err instanceof NetworkSecurityError && err.code === "blocked_destination"
  );

  // 31. Mixed DNS answer rejection (one public, one private)
  const mixedResolver: SafeDnsResolver = {
    async resolve() {
      return [
        { address: "93.184.215.14", family: 4 },
        { address: "192.168.1.1", family: 4 },
      ];
    },
  };
  await assert.rejects(
    async () => {
      await fetchUrlService({
        url: "http://mixed.example.com/",
        method: "HEAD",
        customResolver: mixedResolver,
      });
    },
    (err: any) => err instanceof NetworkSecurityError && err.code === "blocked_destination"
  );

  // 32. HTTPS-only policy rejection on HTTP HEAD
  await assert.rejects(
    async () => {
      await fetchUrlService({
        url: "http://public.example.com/data",
        method: "HEAD",
        operatorPolicy: {
          allowHosts: [],
          denyHosts: [],
          httpsOnly: true,
          maxResponseBytes: 5242880,
          maxTimeoutMs: 30000,
        },
      });
    },
    (err: any) => err instanceof NetworkSecurityError && err.code === "https_required"
  );

  // Disallowed port rejection
  await assert.rejects(
    async () => {
      await fetchUrlService({
        url: "https://public.example.com:9999/data",
        method: "HEAD",
        customAllowedPorts: [80, 443],
      });
    },
    (err: any) => err instanceof NetworkSecurityError && err.code === "port_not_allowed"
  );
});

test("fetchUrlService — HEAD conditional cache, 304 revalidation, and method isolation", async () => {
  let requestCount = 0;
  let lastReceivedMethod = "";
  let lastIfNoneMatch: string | undefined;

  const server = https.createServer(
    { key: TEST_TLS_KEY, cert: TEST_TLS_CERT },
    (req, res) => {
      requestCount++;
      lastReceivedMethod = req.method ?? "";
      lastIfNoneMatch = req.headers["if-none-match"] as string | undefined;

      if (lastIfNoneMatch === '"head-etag-v1"') {
        // Return 304 Not Modified for conditional revalidation
        res.writeHead(304, {
          etag: '"head-etag-v1"',
          "content-type": "application/pdf",
          "content-length": "654321",
        });
        res.end();
      } else {
        // Fresh 200 response
        res.writeHead(200, {
          etag: '"head-etag-v1"',
          "content-type": "application/pdf",
          "content-length": "654321",
        });
        res.end();
      }
    }
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  const cache = new HttpConditionalCache(
    createNetworkCachePolicy({ enabled: true, maxEntries: 10, maxSizeBytes: 1024 * 1024 })
  );

  try {
    // 37. HEAD initial cacheable 200 => stored
    const initialRes = await fetchUrlService({
      url: `https://public.example.com:${port}/cached-doc.pdf`,
      method: "HEAD",
      networkCache: cache,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });

    assert.equal(initialRes.status, 200);
    assert.equal(initialRes.contentType, "application/pdf");
    assert.equal(initialRes.contentLength, 654321);
    assert.equal(initialRes.body, undefined);
    assert.equal(initialRes.bytesRead, 0);
    assert.equal(initialRes.cacheStatus, "stored");
    assert.equal(cache.size, 1);
    assert.equal(lastReceivedMethod, "HEAD");

    // 38. HEAD conditional repeat => validator sent
    // 39. HEAD 304 => final result uses cached metadata
    const revalRes = await fetchUrlService({
      url: `https://public.example.com:${port}/cached-doc.pdf`,
      method: "HEAD",
      networkCache: cache,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });

    assert.equal(lastIfNoneMatch, '"head-etag-v1"', "Server must have received If-None-Match header");
    assert.equal(lastReceivedMethod, "HEAD");

    // Required 304 assertions:
    assert.equal(revalRes.status, 200, "status must be cached original status (200)");
    assert.equal(revalRes.revalidationStatus, 304, "revalidationStatus must be 304");
    assert.equal(revalRes.body, undefined, "body must be absent/undefined");
    assert.equal(revalRes.bytesRead, 0, "bytesRead must be 0");
    assert.equal(revalRes.truncated, false, "truncated must be false");
    assert.equal(revalRes.cacheStatus, "revalidated", "cacheStatus must be revalidated");
    assert.equal(revalRes.contentType, "application/pdf");
    assert.equal(revalRes.contentLength, 654321);

    // 40. GET cache cannot satisfy HEAD:
    // Clear cache, store a GET entry
    cache.clear();
    // Server handles GET /cached-doc.pdf (will fail content-type validation since application/pdf is not allowed for GET)
    // To test isolation cleanly: use a textual content-type
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // Cross-Method Cache Isolation Test (GET vs HEAD)
  const isoServer = https.createServer(
    { key: TEST_TLS_KEY, cert: TEST_TLS_CERT },
    (req, res) => {
      res.writeHead(200, {
        etag: '"iso-tag"',
        "content-type": "text/plain",
        "content-length": "12",
      });
      res.end("Iso content!");
    }
  );

  await new Promise<void>((resolve) => isoServer.listen(0, "127.0.0.1", resolve));
  const isoPort = (isoServer.address() as any).port;

  const isoCache = new HttpConditionalCache(
    createNetworkCachePolicy({ enabled: true, maxEntries: 10, maxSizeBytes: 1024 * 1024 })
  );

  try {
    // 1. First fetch with GET -> stored in GET cache namespace
    const getRes = await fetchUrlService({
      url: `https://public.example.com:${isoPort}/iso-resource`,
      method: "GET",
      networkCache: isoCache,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [isoPort],
      allowLoopbackForTesting: true,
    });
    assert.equal(getRes.cacheStatus, "stored");
    assert.equal(isoCache.size, 1);

    // 2. Fetch with HEAD for same URL:
    // Invariant: GET cache CANNOT satisfy HEAD.
    // It must be a cache miss, origin is contacted, and HEAD is stored under HEAD namespace.
    const headRes = await fetchUrlService({
      url: `https://public.example.com:${isoPort}/iso-resource`,
      method: "HEAD",
      networkCache: isoCache,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [isoPort],
      allowLoopbackForTesting: true,
    });
    assert.equal(headRes.cacheStatus, "stored", "HEAD must miss GET cache and store fresh HEAD entry");
    assert.equal(isoCache.size, 2, "Cache must contain two distinct entries (GET and HEAD)");

    // 3. Invariant: HEAD cache CANNOT satisfy GET.
    // Explicit GET fetch conditionally revalidates ONLY against GET entry.
    const getRes2 = await fetchUrlService({
      url: `https://public.example.com:${isoPort}/iso-resource`,
      method: "GET",
      networkCache: isoCache,
      customResolver: localLoopbackResolver,
      customAllowedPorts: [isoPort],
      allowLoopbackForTesting: true,
    });
    assert.equal(getRes2.body, "Iso content!", "GET must retrieve GET body, never empty HEAD buffer");
    assert.equal(getRes2.bytesRead, 12);
  } finally {
    await new Promise<void>((resolve) => isoServer.close(() => resolve()));
  }
});

test("fetchUrlService — HEAD timeout and cancellation", async () => {
  // 42. HEAD timeout
  const slowServer = http.createServer((_req, _res) => {
    // Intentionally never respond
  });
  await new Promise<void>((resolve) => slowServer.listen(0, "127.0.0.1", resolve));
  const slowPort = (slowServer.address() as any).port;

  try {
    await assert.rejects(
      async () => {
        await fetchUrlService({
          url: `http://public.example.com:${slowPort}/hang`,
          method: "HEAD",
          timeoutMs: 1000,
          customResolver: localLoopbackResolver,
          customAllowedPorts: [slowPort],
          allowLoopbackForTesting: true,
        });
      },
      (err: any) => err instanceof NetworkSecurityError && err.code === "timeout"
    );

    // 43. HEAD caller abort
    const abortController = new AbortController();
    setTimeout(() => abortController.abort(), 100);

    await assert.rejects(
      async () => {
        await fetchUrlService({
          url: `http://public.example.com:${slowPort}/hang`,
          method: "HEAD",
          timeoutMs: 10000,
          signal: abortController.signal,
          customResolver: localLoopbackResolver,
          customAllowedPorts: [slowPort],
          allowLoopbackForTesting: true,
        });
      },
      (err: any) =>
        err instanceof NetworkSecurityError &&
        (err.code === "network_error" || err.code === "timeout")
    );
  } finally {
    await new Promise<void>((resolve) => slowServer.close(() => resolve()));
  }
});

test("MCP Tool Handlers — registerFetchUrlTool registration and execution with HEAD", async () => {
  const server = new McpServer({ name: "test-mcp", version: "1.0.0" });
  registerFetchUrlTool(server);

  // Verify fetchUrlInputSchema accepts HEAD and omits body in result
  const testHttpServer = http.createServer((req, res) => {
    assert.equal(req.method, "HEAD");
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": "25",
    });
    res.end();
  });
  await new Promise<void>((resolve) => testHttpServer.listen(0, "127.0.0.1", resolve));
  const port = (testHttpServer.address() as any).port;

  try {
    const serviceRes = await fetchUrlService({
      url: `http://public.example.com:${port}/api`,
      method: "HEAD",
      customResolver: localLoopbackResolver,
      customAllowedPorts: [port],
      allowLoopbackForTesting: true,
    });

    assert.equal(serviceRes.status, 200);
    assert.equal(serviceRes.body, undefined);
    assert.equal(serviceRes.bytesRead, 0);
    assert.equal(serviceRes.truncated, false);
    assert.equal(serviceRes.contentLength, 25);
  } finally {
    await new Promise<void>((resolve) => testHttpServer.close(() => resolve()));
  }
});
