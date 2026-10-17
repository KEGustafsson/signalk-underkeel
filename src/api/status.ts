import type { IRouter } from "express";
import type { EngineStatus } from "../foundation/state";

export const API_BASE = "/v1";

export function registerStatusRoute(
  router: Pick<IRouter, "get">,
  getStatus: () => EngineStatus
): void {
  router.get(`${API_BASE}/status`, (_req, res) => {
    res.json({ engine: getStatus() });
  });
}
