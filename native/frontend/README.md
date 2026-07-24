# Native frontend provider

`data-provider.js` is the renderer-side boundary for the future Tauri or
Electron shell. It deliberately has no Node, filesystem, SQLite, or archive
access.

The desktop shell must inject a bridge with this shape:

```js
{
  request(method, params) {
    // Return a Promise for one sidecar response.
  },
  on(eventName, handler) {
    // Subscribe to sidecar events and return an unsubscribe function.
  }
}
```

For Electron, expose only this narrow bridge from a sandboxed preload script.
Do not expose `ipcRenderer`, `child_process`, paths, or arbitrary sidecar
methods to the renderer.

For Tauri, implement the same bridge over Tauri commands/channels. The provider
API and Rust JSON contract should remain unchanged.

The provider enforces the 1,000-row limit again in the renderer and never
accumulates pages. The view layer decides which previous window to discard.
`searchMessages` also enforces a 1,024-byte query limit. Attachment and
duplicate-member pages may contain a nullable `context` object populated by the
native core; `null` means unlinked, not safe to delete.

Every chat record carries `source: "line" | "square"`. The renderer must pass
that source to both `listMessages` and `searchMessages`; otherwise a community
chat primary key could be sent to the wrong SQLite database. Message records
also carry native-derived `isSelf`. The renderer must not reinterpret
`sendStatus` when that boolean is present.

Run its dependency-free tests with:

```bash
node --test native/frontend/data-provider.test.js
```
