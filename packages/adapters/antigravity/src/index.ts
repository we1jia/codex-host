import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export { AntigravityAdapter } from "./antigravity-adapter.js";
export type {
  AntigravityAdapterDependencies,
  AntigravityAdapterOptions,
} from "./antigravity-adapter.js";
export {
  AntigravityExecutableError,
  antigravityInvocation,
  resolveAntigravityExecutable,
} from "./command.js";
export { AntigravityProcessTransport } from "./process-transport.js";
export type {
  AntigravityProcessTransportOptions,
  AntigravityTransportEvent,
} from "./process-transport.js";
export { parseAntigravityLine } from "./stream-events.js";
export type { AntigravityStreamEvent } from "./stream-events.js";

export const packageMetadata = {
  name: "@codexhost/adapter-antigravity",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
} as const;
