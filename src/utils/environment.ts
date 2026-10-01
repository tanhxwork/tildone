import { ENVIRONMENTS, type Environment, type Project } from "../types";

/**
 * The environment a new project gets: the first one no project uses yet, else
 * cycling by project count. Mirrored in src-tauri/src/agent.rs (create_project)
 * so a project made over MCP picks the same one.
 */
export function nextEnvironment(projects: Pick<Project, "environment">[]): Environment {
  const used = new Set(projects.map((p) => p.environment));
  return ENVIRONMENTS.find((e) => !used.has(e)) ?? ENVIRONMENTS[projects.length % ENVIRONMENTS.length];
}
