import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./settings";

// Dev builds paint themselves red (the [data-dev-build] tokens in App.css) so
// a dev window is never mistaken for the installed app. The name half of the
// same signal lives in scripts/tauri.sh, which runs dev as "Tildone Dev".
if (import.meta.env.DEV) {
  document.documentElement.dataset.devBuild = "true";
}

// E2e builds (bun run e2e:build) carry the wdio bridge so tests can reach
// Tauri APIs; the flag is compile-time, so release bundles tree-shake this out.
if (import.meta.env.VITE_E2E) {
  import("@wdio/tauri-plugin");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
