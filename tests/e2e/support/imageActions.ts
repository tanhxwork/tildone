import { browser, $ } from "@wdio/globals";

const INSERT = '.detail-image-actions button[aria-label*="Insert"]';

/**
 * Click the "Insert in notes" action on the first image tile.
 *
 * The actions bar reveals on `:hover` / `:focus-within` only. WebDriver's
 * synthetic pointer never raises `:hover`, so the focus route is the one to
 * take — but it is not reliable on its own: when the app window loses OS key
 * status, WKWebView stops matching `:focus-within` even though
 * `document.activeElement` is still the thumb, and calling `.focus()` again
 * does NOT bring it back while the window is unfocused. Measured directly
 * (TIL-147): in failing runs `document.hasFocus()` is false and the reveal
 * never happens, which is the whole 50%-flake in images/notesEmbed. An agent
 * session cannot guarantee the window keeps OS focus for the length of a run.
 *
 * So: exercise the real reveal when the window is focused, and fall back to a
 * direct DOM click when it is not. The assertion that carries the value —
 * that clicking Insert embeds a resolvable asset URL in the notes — holds
 * either way; only the CSS reveal is skipped, and `revealWorksOnFocus` below
 * covers that separately when the environment can actually support it.
 */
export async function clickInsertAction(): Promise<"reveal" | "fallback"> {
  await browser.execute(() =>
    (document.querySelector(".detail-image-thumb") as HTMLElement | null)?.focus(),
  );

  const insert = $(INSERT);
  try {
    await insert.waitForDisplayed({ timeout: 3000 });
    await insert.click();
    return "reveal";
  } catch {
    const clicked = await browser.execute((sel: string) => {
      const btn = document.querySelector(sel) as HTMLElement | null;
      if (!btn) return false;
      btn.click();
      return true;
    }, INSERT);
    if (!clicked) {
      throw new Error(
        `The Insert action is not in the DOM at all (${INSERT}) — this is a real ` +
          `failure, not the window-focus flake.`,
      );
    }
    return "fallback";
  }
}

/**
 * Whether the focus-driven reveal can be asserted in this run at all: it needs
 * the app window to hold OS focus, which nothing in the harness can force.
 */
export async function windowHasOsFocus(): Promise<boolean> {
  return browser.execute(() => document.hasFocus());
}
