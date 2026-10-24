export { type ComputerEnvHost } from "./client.ts";

export {
  type ComputerBackend,
  ComputerExecutionEnv,
  type ComputerExecutionEnvOptions,
  type ComputerWorkspaceStub,
} from "./env.ts";

export {
  type ContainerAccess,
  type ContainerScriptRun,
  MAX_CONTAINER_FILE_BYTES,
} from "./container-files.ts";

export { HARNESS_ROOT, isContainerOnly, withHarnessKept } from "./container-paths.ts";

export { posixCode } from "./failure.ts";

export { ComputerFiles, type ComputerFilesOptions } from "./files.ts";

export { ensureDirectory, READERS_DIR, type ReadEnv, TEMP_DIR, WorkspaceEnvHost } from "./host.ts";

export type {
  DirectoryEntry,
  EnvRequest,
  EnvResponse,
  HostOperation,
  WireInstructionFile,
  WirePrompt,
  WireSkill,
} from "./wire.ts";
