import { z } from "zod";

/**
 * Minimal OpenAI-compatible chat completion request shape. haru's chat
 * proxy only needs `model` to pick a serving URL; every other field
 * (messages, sampling params, tools, vendor extensions) passes through
 * to the upstream vLLM server untouched, which is why this is a loose
 * object instead of a full schema.
 */
export const chatCompletionRequestSchema = z.looseObject({
  model: z.string().min(1),
});
export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
