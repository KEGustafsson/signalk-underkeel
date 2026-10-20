import { randomUUID } from "crypto";
import type { AckStore } from "./ack-store";
import { parseAckRequest } from "./api/ack-request";
import type { ApiReply } from "./api/routes";
import type { Ack } from "./engine/acks";
import { convexHull } from "./engine/footprint";
import type { LookaheadResult } from "./engine/lookahead";
import type { WaterLevel } from "./model/uncertainty";

/** `GET/POST/DELETE /acks`: acknowledged passages for the current vessel and water level. */

/** Default half-width of the heading sector (plan §4.12). */
export const DEFAULT_SECTOR_DEG = 20;

export interface AckServiceDeps {
  store: AckStore;
  /** The look-ahead now; its footprints are the default polygon. */
  current(): LookaheadResult | undefined;
  /** True heading now, radians. */
  heading(): number | undefined;
  waterLevel(): WaterLevel;
  draft(): number | undefined;
  now(): number;
  /** Logs a failure the reply does not carry: the file path stays off the wire. */
  error(message: string): void;
}

const NOT_SAVED: ApiReply = { status: 500, body: { errors: ["could not save acknowledgements"] } };

/** Runs a store write; a save that throws is logged and answered 500. */
function saving(deps: AckServiceDeps, write: () => ApiReply): ApiReply {
  try {
    return write();
  } catch (err) {
    deps.error(`acknowledgements not saved: ${(err as Error).message}`);
    return NOT_SAVED;
  }
}

export function listAcks(deps: AckServiceDeps): ApiReply {
  return { status: 200, body: deps.store.list(deps.now()) };
}

export function addAck(body: unknown, deps: AckServiceDeps): ApiReply {
  const parsed = parseAckRequest(body);
  if (!parsed.ok) {
    return { status: 400, body: { errors: parsed.errors } };
  }
  const req = parsed.value;
  const heading = deps.heading();
  const draft = deps.draft();
  if (heading === undefined || draft === undefined) {
    return { status: 409, body: { errors: ["heading and draft are needed to acknowledge"] } };
  }
  const level = deps.waterLevel();
  if (level.degraded !== undefined) {
    // An acknowledgement records the level it holds at; a fallback level is not one.
    return { status: 409, body: { errors: [`water level degraded: ${level.degraded}`] } };
  }
  const footprints = deps.current()?.footprints ?? [];
  const polygon = req.polygon ?? convexHull(footprints.flatMap((f) => f.ring));
  if (polygon.length < 3) {
    return { status: 409, body: { errors: ["no look-ahead area to acknowledge"] } };
  }
  const now = deps.now();
  const ack: Ack = {
    id: randomUUID(),
    created: new Date(now).toISOString(),
    expires: req.ttl === undefined ? undefined : new Date(now + req.ttl * 1000).toISOString(),
    polygon,
    heading,
    sector: ((req.sector ?? DEFAULT_SECTOR_DEG) * Math.PI) / 180,
    notificationId: req.notificationId,
    waterLevel: level.h,
    draft
  };
  return saving(deps, () => {
    deps.store.add(ack);
    return { status: 201, body: ack };
  });
}

export function deleteAck(id: string, deps: AckServiceDeps): ApiReply {
  return saving(deps, () =>
    deps.store.remove(id)
      ? { status: 204, body: undefined }
      : { status: 404, body: { errors: [`no acknowledgement ${id}`] } }
  );
}
