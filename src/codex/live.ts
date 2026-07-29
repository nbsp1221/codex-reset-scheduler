import { AppServerClient } from "./app-server-client.js";
import {
  executableVersion,
  resolveExecutable,
} from "../platform/executables.js";

export type LiveCodex = Readonly<{
  executable: string;
  version: string;
  client: AppServerClient;
}>;

export async function connectLiveCodex(): Promise<LiveCodex> {
  const executable = await resolveExecutable("codex");
  const version = await executableVersion(executable);
  const client = await AppServerClient.connect({
    executable,
    arguments: ["app-server", "--stdio"],
    environment: process.env,
  });
  return { executable, version, client };
}
