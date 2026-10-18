# e2e specs

WebdriverIO drives the real Tauri app through `@wdio/tauri-service` (see `wdio.conf.ts`).

```bash
bun run e2e:build                               # build this worktree's app binary
bun run e2e                                     # whole suite, about 3 minutes
bun run e2e --spec tests/e2e/goals.spec.ts      # one spec
```

Run `e2e:build` again after any change under `src/` or `src-tauri/`: the suite drives the built binary, not the source.

## Shared helpers

Helpers that more than one spec needs live in `tests/e2e/support/`. Import them as `./support/<name>.js`.

| File | Use it for |
|---|---|
| `dataDir.ts` | The e2e database and attachments paths. |
| `reset.ts` | Reset app state, remount, backdate activity. |
| `imageActions.ts` | Reveal and click an image tile's actions. |
| `select.ts` | Pick an option in a `<select>`. |

## Gotchas

### `selectByVisibleText` does nothing

WebdriverIO's `selectByVisibleText()` resolves without error but leaves the `<select>` unchanged. The spec then passes while nothing was selected. TIL-204 found this in `goals.spec.ts`: both tasks kept `goal_id` NULL in the database.

It happens on both platforms: on macOS (WKWebView) in TIL-204, and on Linux (WebKitGTK) in TIL-207, where both selects still read "No goal" after the call.

Use `selectOption(selector, visibleText)` from `support/select.ts` instead. It sets the value and dispatches a bubbling `change` event, which React's `onChange` listens for. Then assert the effect the app shows, not the select's value.

### WebDriver hover never raises `:hover`

Reach controls that reveal on hover through focus instead. `support/imageActions.ts` shows the pattern and its fallback.
