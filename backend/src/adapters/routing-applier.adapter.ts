import { rpc } from "../mail-lab/rpc.js";
import { env } from "../config/env.js";
import type {
  RoutingApplier,
  RoutingTarget,
} from "../services/mail-routing.service.js";
export class LocalRoutingApplier implements RoutingApplier {
  constructor() {
    if (env.NODE_ENV === "production")
      throw new Error("Synthetic routing is local only");
  }
  async apply(target: RoutingTarget) {
    const result = await rpc("/v1/routing", target);
    if (result.status !== 200 || result.body.status !== "applied")
      throw new Error("ROUTING_UNCONFIRMED");
  }
}
