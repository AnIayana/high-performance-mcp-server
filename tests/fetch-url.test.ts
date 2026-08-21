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

test("fetchUrlService — Rejects unsupported Content-Encoding (gzip/br)", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/plain",
      "Content-Encoding": "gzip",
    });
    res.end(Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
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
    // Deliberately stall response
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

test("fetchUrlService — Environment proxy variables do not hijack connection", async () => {
  // Set proxy env variables
  const origHttpProxy = process.env.HTTP_PROXY;
  const origHttpsProxy = process.env.HTTPS_PROXY;
  const origNodeEnvProxy = process.env.NODE_USE_ENV_PROXY;

  process.env.HTTP_PROXY = "http://127.0.0.1:9999";
  process.env.HTTPS_PROXY = "http://127.0.0.1:9999";
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
    process.env.NODE_USE_ENV_PROXY = origNodeEnvProxy;
  }
});

test("fetchUrlService — Rejects 101 Protocol Upgrade attempts", async () => {
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
