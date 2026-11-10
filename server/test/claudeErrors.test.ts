import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callClaude, CLAUDE_CALL_CAPS, ClaudeInputTooLargeError, describeClaudeError } from "../src/ai/claude.js";

// What gets logged when a Claude call fails, and how photos count toward the input cap.
// No database (budget bypassed) and no real API call.

const BYPASS = { bypass: "live_check" } as const;
const OPTIONS = { timeout: 1000, maxRetries: 0 };
const SECRET_PROMPT = "the full prompt text";

function badRequest() {
  const body = { type: "error", error: { type: "invalid_request_error", message: "messages.0.content.1.image.source.url: invalid URL" } };
  return new Anthropic.BadRequestError(400, body, undefined, new Headers({ "request-id": "req_123" }));
}

afterEach(() => vi.restoreAllMocks());

describe("describeClaudeError", () => {
  it("gives an API error's status, request id, and the type and message from its body", () => {
    expect(describeClaudeError(badRequest())).toBe(
      "BadRequestError (status 400, request req_123): invalid_request_error: messages.0.content.1.image.source.url: invalid URL",
    );
  });

  it("copes with an API error without a body, and with errors that aren't from the API", () => {
    expect(describeClaudeError(new Anthropic.APIConnectionTimeoutError())).toBe("APIConnectionTimeoutError (status none): Request timed out.");
    expect(describeClaudeError(new Anthropic.InternalServerError(500, undefined, undefined, new Headers()))).toBe("InternalServerError (status 500)");
    expect(describeClaudeError(new Error("connection reset"))).toBe("Error: connection reset");
    expect(describeClaudeError("nope")).toBe("unknown error");
  });
});

describe("callClaude", () => {
  it("logs why a call failed, without the prompt, and passes the error on", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = badRequest();
    const createMessage = vi.fn().mockRejectedValue(err);

    await expect(callClaude("dispute_agent", BYPASS, { model: "m", messages: [{ role: "user", content: SECRET_PROMPT }] }, OPTIONS, createMessage)).rejects.toBe(err);

    const logged = error.mock.calls.flat().join(" ");
    expect(logged).toContain("[claude] dispute_agent call failed");
    expect(logged).toContain("invalid_request_error: messages.0.content.1.image.source.url: invalid URL");
    expect(logged).not.toContain(SECRET_PROMPT);
  });

  it("doesn't count base64 photo data toward the text input cap, but still counts text", async () => {
    const createMessage = vi.fn().mockResolvedValue({ content: [] });
    const photo = { type: "image" as const, source: { type: "base64" as const, media_type: "image/webp" as const, data: "A".repeat(CLAUDE_CALL_CAPS.dispute_agent.maxInputChars * 2) } };

    await callClaude("dispute_agent", BYPASS, { model: "m", messages: [{ role: "user", content: [photo, { type: "text", text: "hi" }] }] }, OPTIONS, createMessage);
    expect(createMessage.mock.calls[0][0].messages[0].content[0].source.data).toBe(photo.source.data); // sent unchanged

    const longText = "x".repeat(CLAUDE_CALL_CAPS.dispute_agent.maxInputChars + 1);
    await expect(callClaude("dispute_agent", BYPASS, { model: "m", messages: [{ role: "user", content: [photo, { type: "text", text: longText }] }] }, OPTIONS, createMessage)).rejects.toBeInstanceOf(
      ClaudeInputTooLargeError,
    );
  });
});
