# Native Windows and Linux desktop

## Architecture and requirements

The pinned Deno **2.9.6** `deno desktop --backend webview` packager embeds MCM's
TypeScript backend and built React frontend with the Deno runtime and native
Laufey WebView library. The native UI event loop and backend run asynchronously;
no blocking FFI `webview.run()` or external browser is used. Deno desktop is
experimental; update the pin deliberately and re-run native validation.

- **Windows x86-64:** a supported Windows desktop with the Microsoft
  [WebView2 Evergreen Runtime](https://developer.microsoft.com/microsoft-edge/webview2/).
  WebView2 is usually already installed on Windows 11. Install it if the native
  loader reports it missing.
- **Linux x86-64:** a graphical X11 or Wayland session, GTK 3, WebKitGTK **4.1**
  and its runtime dependencies. On Debian 12 / Ubuntu 24.04:
  `sudo apt-get install libwebkit2gtk-4.1-0`. On Fedora:
  `sudo dnf install webkit2gtk4.1`. The actual Linux launcher links
  `libwebkit2gtk-4.1.so.0`, `libjavascriptcoregtk-4.1.so.0`, GTK 3 and libsoup 3;
  the older WebKitGTK 4.0 package alone is insufficient.
- A separately installed compatible llama-server executable and models. MCM
  never downloads or launches inference automatically.

Source references:
[Deno desktop](https://docs.deno.com/runtime/desktop/),
[window lifecycle](https://docs.deno.com/runtime/desktop/windows/),
[serving](https://docs.deno.com/runtime/desktop/serving/),
[distribution](https://docs.deno.com/runtime/desktop/distribution/),
[pinned runtime architecture](https://github.com/denoland/deno/blob/v2.9.6/doc/desktop-architecture.md).

## Development and packaging

Install source dependencies with Node 22.12+ and `npm ci`. Deno is an exact
npm devDependency; no global Deno installation is required.

| Command | Result |
| --- | --- |
| `npm run desktop` | Build the UI and native bundle, then run the native launcher |
| `npm run desktop:dev` | Build UI, then Deno native HMR development |
| `npm run desktop:check` | Deno's separate desktop API type-check |
| `npm run desktop:test` | Real Deno backend/managed-process integration smoke, no display needed |
| `npm run desktop:build:linux` | `dist/desktop/linux/MCM/` |
| `npm run desktop:build:windows` | `dist/desktop/windows/MCM/` |

Both builds can run on either host; downloads are checksum-verified by Deno.
The desktop tasks use the pinned npm-installed executable directly to avoid
Deno task's npm-bin resolution treating that native executable as JavaScript.
The ordinary TS7 checker remains `npm run typecheck`; desktop-only APIs are
outside the main application's tsconfig. `--desktop` selects Deno's native API
declarations; `sloppy-imports` supports the existing extensionless server imports.

Run `MCM.exe` on Windows or `./MCM` on Linux **from the resulting app directory**,
or invoke that launcher by its absolute path from anywhere. Distribute the
**entire directory**, including `MCM.dll` / `MCM.so`, not just the small launcher.
Keep it writable only by trusted users. Neither Node nor Deno CLI is needed at
runtime. The Windows build is unsigned; production publishers should sign its
executable and DLL before distribution. No automatic update endpoint is enabled.

The build script excludes development-only npm packages and executable shims;
it does not replace or rewrite npm's dependency tree. The explicit
`desktop/main.ts` entrypoint prevents Vite auto-detection from packaging a
static-only app without the APIs. UI assets are embedded with `--include` and
resolved relative to `import.meta.url`, never the launch working directory.

HMR watches backend code and built assets, not unbuilt React source: rebuild
the client with `npm run build` to refresh UI changes. Avoid editing/restarting
HMR while inference is running: experimental runtime hot-restart is not the
same as an orderly window close. Stop inference first. For ordinary use,
`npm run desktop` does not enable HMR.

## Data, ports and startup errors

Desktop defaults are stable across upgrades, extraction directories and launch
working directories:

- Windows: `%LOCALAPPDATA%\MCM`, falling back to `%APPDATA%\MCM`.
- Linux: `$XDG_DATA_HOME/mcm`, falling back to `~/.local/share/mcm`.
- `MCM_DATA_DIR` overrides either; desktop requires an **absolute** path.
  Browser mode retains its existing `.mcm` / `MCM_DATA_DIR` behavior.

To move existing browser data, stop MCM and its managed server first, then copy
the contents of `.mcm` into the desktop data directory, or point desktop's
`MCM_DATA_DIR` at the absolute path to that directory. Do not run browser and
desktop backends against the same data simultaneously.

The conventional API/proxy remains `http://127.0.0.1:7838` (`MCM_PORT` overrides
it; allowed range 1024–65535). Deno also allocates a private loopback UI port;
both listeners serve the **same** app instance. The WebView loads UI and APIs
from the same origin, preserving existing management Host/Origin protections.
Proxy-only CORS behavior is unchanged. Loopback is not authentication: other
local programs/users can access these ports.

Listeners are reserved before loading mutable state. An occupied port fails
startup rather than opening another instance's UI or silently reusing its
backend. A `.desktop-lock` directory additionally prevents simultaneous desktop
instances using the same data with different ports. Normal shutdown removes it.
After an OS kill/crash, **verify MCM and its managed llama-server are stopped**
before removing that empty directory manually; MCM never guesses that a lock
is stale. Missing native libraries, invalid settings, missing UI assets, failed
binds and data-permission failures surface as startup errors rather than a
browser fallback. Launch from a terminal to see loader errors.

Window close, SIGINT, and SIGTERM (Unix) stop accepting HTTP requests, drain
pending settings writes, cancel active proxy streams, stop the managed process,
flush usage accounting and close SSE connections before releasing the data lock
and native window. Windows supports window close and SIGINT; forcible Task
Manager termination and power loss cannot run asynchronous cleanup.

## Trusted code and WebView differences

The app is packaged with Deno's full permissions (`-A`). This is intentional:
MCM must read arbitrary model/executable paths, write private configuration,
spawn your configured executable, make upstream/Hugging Face requests, and run
explicitly acknowledged trusted interceptor modules. **This is not a sandbox
for untrusted models' scripts or interceptor code.** Only configure modules and
executables you trust. Interceptor hooks retain their existing management UI,
locked built-ins, ordering, and startup environment-module support.
Packaged Deno loads trusted external local JavaScript and TypeScript modules;
use explicit file extensions for their local imports and keep any dependencies
available alongside the module. MCM strips its desktop listener/smoke environment
variables when spawning inference executables, so child servers keep their own
configured ports.

The UI remains the same, including saved themes and speculative/draft settings.
Native titlebar styling is controlled by the OS.

### Native always-on-top Inference window

In the desktop app, the Inference card's PiP icon opens a dedicated Deno
`BrowserWindow` with `alwaysOnTop: true`. It does not call WebView2's
`documentPictureInPicture.requestWindow()`, avoiding the embedded WebView's
`Internal error: no window` failure.

Only the Inference card is shown: PP/TG, live input/output totals and token value.
The window connects to the same backend's event stream; it does not create a
second inference process or count tokens again. Main-window theme previews and
saved changes synchronize to the Inference window.

There is only one native Inference window per desktop instance. Close it normally
or use the main card's restore icon to return the card. Closing it does not stop
MCM; closing the main app closes the Inference window and shuts down the backend.
The compact window is frameless and resizable. Its Inference header has a grip
icon for dragging (or use the arrow keys while that icon is focused) and an X
button to close only the popup. There is no native titlebar.
User-adjusted size and position are saved locally in `inference-window.json`
inside the desktop data directory. Bounds are saved after moving/resizing and
flushed when closing, then restored on reopen and across MCM restarts. Reopening
an already-open popup focuses it without resetting its dimensions. Geometry is
not part of shared model configurations. If a changed monitor arrangement leaves
the popup off-screen, close MCM and remove this file to restore the initial placement.

Browser mode continues to use Document PiP where supported and the in-page
floating fallback otherwise. Those browser behaviors are independent of desktop's
native always-on-top window.

Clipboard/share-sheet permissions and file-download dialogs differ between
WebView2 and WebKitGTK. Share URLs contain portable configuration in the
fragment, not secrets; use browser mode if a platform blocks clipboard access
or a download. Local-file selection also follows the system WebView's picker.

## Validation and CI

`desktop:test` starts the real backend under Deno, compiles a small deterministic
standalone llama-server fixture (not a real inference engine), and checks
same-origin UI/API access, settings validation, persistence, dynamic local
TypeScript interceptor loading, live SSE/proxy traffic, usage flush,
port/data-directory conflicts, executable version/preview, process start/stop,
and cleanup. It creates and removes its own files under `test-results/`.

For the **actual packaged native window**, set `MCM_DESKTOP_SMOKE=1` plus a
fresh absolute `MCM_DATA_DIR` and free `MCM_PORT`, then run the launcher in a
graphical session. It verifies rendered React content and a same-origin API
call from the WebView, exercises native Inference open/theme/reuse/close behavior,
then checks the asynchronous main-window close handler and exits.
It never launches inference. On headless Linux, Xvfb with the WebKitGTK runtime
can provide the display. Install and run a window manager such as Openbox inside
Xvfb, plus `xprop` (`x11-utils` on Debian/Ubuntu), to verify the always-on-top state.
A failed native smoke exits unsuccessfully; it does
not fall back to the headless backend smoke.

The manual **MCM desktop bundles** GitHub Actions workflow builds Windows/Linux
artifacts with native runners, runs Deno integration validation on both, and
runs the Linux packaged-window smoke under Xvfb. Cross-building Windows on Linux
does not demonstrate Windows native execution; run the Windows artifact on
Windows before publishing.
