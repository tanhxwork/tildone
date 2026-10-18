/**
 * Client mode: the board lives on another Tildone (the hub) because the
 * `board_hub_url` setting is set. Plain module state, so code outside React and
 * the db layer can ask without importing the settings store. appSettings.ts
 * sets it when the settings load; changing the URL reloads the window, so the
 * answer never changes within one page.
 */
let hubUrl = "";

export const setBoardHubUrl = (url: string) => {
  hubUrl = url.trim();
};

export const isClientMode = () => hubUrl !== "";

/** The hub this window uses, as set (trimmed); "" in local mode. Files kept for one hub name it. */
export const getBoardHubUrl = () => hubUrl;
