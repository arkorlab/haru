import { createServer } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createChatFetch } from "./chat-fetch.js";

import type { IncomingMessage, Server, ServerResponse } from "node:http";

/**
 * These tests exercise REAL sockets on 127.0.0.1 instead of a fake
 * fetch: the module under test exists purely to change undici's
 * transport-level timers, which no injected fetch can observe. The
 * undici defaults being replaced are 300s, which a unit test cannot
 * wait out; so each knob is proven live by injecting a sub-second
 * value and watching it fire (plumbing), and the shipped default is
 * proven by the paired test where the SAME slow server succeeds.
 */

const servers: Server[] = [];

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP listen address");
  }
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  const closing = servers.map(
    (server) =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  );
  servers.length = 0;
  await Promise.all(closing);
});

/** Delay before the slow test servers answer. undici schedules its
 * transport timers on a coarse wheel (roughly 1s ticks), so an
 * injected 50ms timeout actually fires around 1-2s; the servers must
 * answer well after that for the timeout tests to be deterministic,
 * and the success-path twins pay the same delay. Measured locally: a
 * 50ms headersTimeout fired at ~1.01s. */
const SLOW_MS = 3000;

/** Undici error codes travel either on the error itself (dispatcher
 * errors) or on the cause of a wrapping TypeError ("fetch failed" /
 * "terminated"); accept both shapes so the assertion doesn't encode
 * one undici version's wrapping. */
function undiciCode(error: unknown): unknown {
  let current: unknown = error;
  while (typeof current === "object" && current !== null) {
    if ("code" in current) {
      return current.code;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

/** A server whose response HEADERS arrive only after SLOW_MS: the
 * shape of a long non-streaming completion. */
function slowHeadersServer(): Promise<string> {
  return listen((_request, response) => {
    const timer = setTimeout(() => {
      response.writeHead(200, {
        "content-type": "application/json",
        connection: "close",
      });
      response.end("{}");
    }, SLOW_MS);
    // The client may abort first (that is the point of the timeout
    // test); never write into a torn-down response.
    response.on("close", () => {
      clearTimeout(timer);
    });
  });
}

/** A server that answers headers immediately, streams one chunk, goes
 * QUIET for SLOW_MS, then finishes: the shape of an SSE completion
 * with a mid-generation pause. */
function quietStreamServer(): Promise<string> {
  return listen((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      connection: "close",
    });
    response.write("data: first\n\n");
    const timer = setTimeout(() => {
      response.end("data: [DONE]\n\n");
    }, SLOW_MS);
    response.on("close", () => {
      clearTimeout(timer);
    });
  });
}

describe("createChatFetch", () => {
  it("propagates a configured headers timeout to the wire", async () => {
    const url = await slowHeadersServer();
    const chatFetch = createChatFetch({ headersTimeoutMs: 50 });
    const error = await rejectionOf(chatFetch(url));
    expect(undiciCode(error)).toBe("UND_ERR_HEADERS_TIMEOUT");
  });

  it("by default does not cut a slow-header response", async () => {
    const url = await slowHeadersServer();
    const chatFetch = createChatFetch();
    const response = await chatFetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("{}");
  });

  it("propagates a configured body idle timeout to the wire", async () => {
    const url = await quietStreamServer();
    const chatFetch = createChatFetch({ bodyTimeoutMs: 50 });
    // Headers arrive instantly; the idle timer must fire mid-BODY.
    const response = await chatFetch(url);
    expect(response.status).toBe(200);
    const error = await rejectionOf(response.text());
    expect(undiciCode(error)).toBe("UND_ERR_BODY_TIMEOUT");
  });

  it("by default streams across a mid-body quiet period uncut", async () => {
    const url = await quietStreamServer();
    const chatFetch = createChatFetch();
    const response = await chatFetch(url);
    const body = await response.text();
    expect(body).toContain("data: first");
    expect(body).toContain("data: [DONE]");
  });
});
