import { browser } from "@wdio/globals";

/**
 * Pick the option whose text is `visibleText` in the <select> matching
 * `selector`, the way a user's choice reaches React.
 *
 * Use this instead of WebdriverIO's `selectByVisibleText`: against this app's
 * WebDriver it resolves without error but never changes the control, so a spec
 * built on it passes while nothing was selected (TIL-204, TIL-207). This sets
 * the value and dispatches a bubbling "change" event, which is what React's
 * select onChange listens for. Throws when the select or the option is not on
 * screen, so a missing control fails the spec instead of passing it.
 */
export async function selectOption(selector: string, visibleText: string): Promise<void> {
  await browser.execute(
    (sel: string, text: string) => {
      const select = document.querySelector(sel) as HTMLSelectElement | null;
      if (!select) throw new Error(`no select matches ${sel}`);
      const option = Array.from(select.options).find((o) => o.text === text);
      if (!option) throw new Error(`no option "${text}" in ${sel}`);
      select.value = option.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    },
    selector,
    visibleText,
  );
}
