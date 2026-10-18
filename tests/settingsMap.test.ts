import { describe, expect, it } from "bun:test";
import { aiPatchToApp, legacyToApp, settingsPatchToApp } from "../src/settingsMap";

describe("legacyToApp", () => {
  it("maps both old localStorage blobs to snake_case keys, only the keys present", () => {
    const settings = JSON.stringify({
      theme: "dark",
      weekStart: "sunday",
      defaultProjectId: 7,
      agentNotify: false,
      tagsCollapsed: true, // layout state: not a setting
    });
    const ai = JSON.stringify({ mode: "builtin", engineModel: "better", secretaryEnabled: false });
    expect(legacyToApp(settings, ai)).toEqual({
      theme: "dark",
      week_start: "sunday",
      default_project_id: 7,
      agent_notify: false,
      ai_mode: "builtin",
      ai_engine_model: "better",
      ai_secretary: false,
    });
  });

  it("drops invalid values and survives missing or corrupt blobs", () => {
    expect(legacyToApp(null, null)).toEqual({});
    expect(legacyToApp("{nope", "[]")).toEqual({});
    expect(legacyToApp(JSON.stringify({ theme: "neon", agentServer: "yes" }), null)).toEqual({});
  });
});

describe("patch mapping", () => {
  it("renames window fields to settings.json keys and skips undefined", () => {
    expect(settingsPatchToApp({ weekStart: "monday", defaultProjectId: null })).toEqual({
      week_start: "monday",
      default_project_id: null,
    });
    expect(aiPatchToApp({ baseUrl: "http://x", autoStart: true, model: undefined })).toEqual({
      ai_base_url: "http://x",
      ai_auto_start: true,
    });
  });
});
