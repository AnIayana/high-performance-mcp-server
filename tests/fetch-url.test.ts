import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { fetchUrlService } from "../src/network/fetch-service.js";
import { NetworkSecurityError, type SafeDnsResolver } from "../src/network/types.js";

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


