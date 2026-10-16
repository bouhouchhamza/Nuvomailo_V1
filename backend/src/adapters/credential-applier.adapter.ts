import { rpc } from "../mail-lab/rpc.js";
import type {
  CredentialApplier,
  CredentialTarget,
} from "../services/mailbox-credential.service.js";
import { env } from "../config/env.js";
export class LocalCredentialApplier implements CredentialApplier {
  constructor() {
    if (env.NODE_ENV === "production")
      throw new Error("Synthetic credential applier is local only");
  }
  async apply(target: CredentialTarget) {
    const result = await rpc("/v1/credential", target);
    if (result.status !== 200 || result.body.status !== "applied")
      throw new Error("CREDENTIAL_APPLY_UNCONFIRMED");
  }
}
