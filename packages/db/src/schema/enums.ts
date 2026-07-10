import {
  domainStateSchema,
  operationKindSchema,
  operationStateSchema,
  slotKindSchema,
  slotStateSchema,
} from "@haru/protocol";
import { pgEnum } from "drizzle-orm/pg-core";

// Postgres enums mirror the protocol zod enums so the two can never
// drift silently: the values are read straight from the zod options.

/** pgEnum requires a non-empty tuple; zod options are a plain array. */
function tuple<T extends string>(values: readonly T[]): [T, ...T[]] {
  const [first, ...rest] = values;
  if (first === undefined) {
    throw new Error("enum values must be non-empty");
  }
  return [first, ...rest];
}

export const domainStateEnum = pgEnum(
  "domain_state",
  tuple(domainStateSchema.options),
);

export const slotKindEnum = pgEnum("slot_kind", tuple(slotKindSchema.options));

export const slotStateEnum = pgEnum(
  "slot_state",
  tuple(slotStateSchema.options),
);

export const operationKindEnum = pgEnum(
  "operation_kind",
  tuple(operationKindSchema.options),
);

export const operationStateEnum = pgEnum(
  "operation_state",
  tuple(operationStateSchema.options),
);
