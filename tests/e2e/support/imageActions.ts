import { browser, $ } from "@wdio/globals";

const INSERT = '.detail-image-actions button[aria-label*="Insert"]';

/**
 * Reveal the image tile's actions bar and click "Insert in notes".
 *
 * The bar reveals on `:hover` / `:focus-within` only. WebDriver's synthetic
 * pointer never raises `:hover`, so take the focus route — the same reveal a
 * keyboard user gets.
 *
 * WKWebView stops matching `:focus-within` the moment the app window loses OS
 * key status, even though `document.activeElement` is still the thumb, and
 * re-focusing does not bring it back (measured, TIL-147). Most of that was the
 * launcher/worker port split in wdio.conf.ts leaving the service unable to
 * raise the window at all; with that fixed the reveal is reliable most of the
 * time, but nothing can stop another application from taking focus mid-run.
 *
 * So the fallback is gated on *proof* of that condition — `document.hasFocus()`
 * being false — and nothing else. If the window holds focus and the reveal
 * still doesn't happen, that is a real regression and this throws, which is
 * what an earlier catch-everything version wrongly swallowed.
 */
export async function clickInsertAction(): Promise<void> {
  await browser.execute(() =>
    (document.querySelector(".detail-image-thumb") as HTMLElement | null)?.focus(),
  );

  const insert = $(INSERT);
  try {
    await insert.waitForDisplayed({ timeout: 5000 });
  } catch (revealFailed) {
    if (await browser.execute(() => document.hasFocus())) {
      throw revealFailed; // focused window, no reveal — the CSS contract is broken
    }
    const clicked = await browser.execute((sel: string) => {
      const btn = document.querySelector(sel) as HTMLElement | null;
      if (!btn) return false;
      btn.click();
      return true;
    }, INSERT);
    if (!clicked) {
      throw new Error(`The Insert action is not in the DOM at all (${INSERT}).`);
    }
    return;
  }

  await insert.click();
}

/** Paste a small generated PNG into an element, the way ⌘V does. A real
 *  clipboard can't be primed from WebDriver, but the app only ever reads
 *  `clipboardData.items`, so a constructed DataTransfer exercises the same path. */
export async function pasteImageInto(selector: string) {
  await browser.executeAsync((sel: string, done: (v: unknown) => void) => {
    const canvas = document.createElement("canvas");
    canvas.width = 40;
    canvas.height = 30;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#5645d4";
      ctx.fillRect(0, 0, 40, 30);
    }
    canvas.toBlob((blob) => {
      if (!blob) return done("no blob");
      const file = new File([blob], "e2e-shot.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return done("no element");
      el.focus();
      el.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
      );
      done("ok");
    }, "image/png");
  }, selector);
}
