# Changelog

[中文](CHANGELOG.md) ｜ English

This file records the release notes for each version of the Shanhai desktop app (new features / improvements / bug fixes).

Format convention: `version - date (YYYY-MM-DD)`; entries are written to be readable by end users, each one sentence explaining "what it is + what it did".

---

## 0.6.9 - 2026-09-11

**Download**

- Windows x64: `https://store.bjctykj.com/app-versions/Windows/1789119725_Shanhai-0.6.9-x64.exe`
- macOS arm64 (Apple Silicon): `https://store.bjctykj.com/app-versions/macOS/1789119766_Shanhai-0.6.9-arm64.dmg`

**Release time**: 2026-09-11 17:42 (converted from the timestamps embedded in the download URLs: Windows 17:42:05, macOS 17:42:46; server Last-Modified 17:43:41).

### Improvements

- **Long conversations remember more context**: the history replayed for a normal session went from 5 turns to 10 turns, and for the Session Supervisor from 10 turns to 20 turns; in long tasks the model more easily picks up on what was said earlier and is less likely to "forget". `deeda28`

### How to upgrade

Download the installer for the corresponding platform above and run it to install over the old version. Historical sessions, memory, and installed apps are all kept; there is no need to uninstall the old version.

### Insufficient evidence / to be confirmed

- **The Windows installer has not had its contents verified**: there is no Windows artifact on this machine, so it cannot be verified the way the macOS package was; for the online Windows package only the size and upload time were obtained (182,169,374 bytes, 17:42:05).
- **The macOS package has been verified as the same file**: the online macOS package and the local `apps/desktop/release/Shanhai-0.6.9-arm64.dmg` match exactly in size and MD5 (203,234,136 bytes, `cabaff3e778ef313be9b3422ed7b72e0`).
- **The releasable changes for this version are based on what has been committed**: the working tree has no uncommitted source changes (only 3 untracked files), so this version's entry only covers the one code change, "history replay turn count".

---

## 0.6.8 - 2026-09-10

### New features

- **The interface is folded into one window**: the supervisor no longer opens its own window; the supervisor panel is merged into the right-hand column of the chat window; clicking the tray/floating icon opens the main chat window. `6899ee6`
- **Skill marketplace**: a new skill marketplace panel lets you browse skills, refresh the skills on this machine, and install / uninstall third-party skills with one click. `6899ee6`
- **MCP service management UI**: you can now view, edit, start, and stop the MCP services on this machine in the UI, without hand-editing config files. `6899ee6`
- **Third-party skills go through a security audit before installation**: installing an external skill runs item-by-item security checks, and if it does not pass it is not installed on this machine. `6899ee6`
- **Account overlay**: account status and related entry points are gathered into a new account panel. `6899ee6`
- **Plugins can communicate in real time**: plugins gain a new "room" channel for sending and receiving messages within the same room; the channel is proxied by the main process, login credentials never leave the main process and plugins cannot impersonate others, and the permission must be explicitly declared in the plugin manifest. `0e4b011`
- **The memory panel is searchable and editable**: the memory panel supports searching by title and body; each memory's body can be edited directly, and saving / save failure is reported immediately instead of failing silently. `c6cbeb3`
- **Long-term memory is now stored as Markdown files**: memory is written to local Markdown documents (the previous JSON memory is migrated automatically), so you can open, read, and organize it yourself. `c6cbeb3`

### Improvements

- **Plugins no longer need a member ID to find someone**: when sending and receiving messages, plugins can specify the peer by username or nickname (internally completed in the order member ID > username > nickname), and plugins no longer need to ask you for a member ID. `19e97e8`
- **Rate limiting added to plugin subscriptions**: reduces the risk of plugins being used to probe whether a given user exists. `19e97e8`
- **The default landing panel is the supervisor**: the right-hand column shows the Session Supervisor by default, so there is less flicker at startup. `0e4b011`
- **Clearer input text in dark mode**: improves the contrast of input content in dark mode. `0e4b011`
- **History replay carries a long-term memory index**: both resuming from a breakpoint and handling a new task now inject a memory index tag block, so the model more easily recalls preferences and conventions recorded earlier. `c6cbeb3`

### Bug fixes

- **Quotes no longer go to the wrong window**: quotes from the supervisor and from normal sessions are all delivered to the chat window, which dispatches them in a unified way. `6899ee6`
- **Invalid session IDs are intercepted**: the interface for opening a window now has strict validation, so the UI can no longer pass in a session ID that does not exist. `6899ee6`

---

## 0.6.7 - 2026-09-10

### New features

- **App menu overlay**: the app menu is shown as an independent, always-on-top transparent overlay and is no longer covered by other windows. `e0185ba`

### Improvements

- **Stopping a session gives clear feedback**: clicking stop clearly tells you whether it stopped or not; if it did not stop, an error is shown and the "running" state is kept, instead of pretending it has stopped. `e0185ba`
- **Results are automatically resent after a remote reconnection**: instruction results that could not be sent while a remote entry point (such as the mobile client) was disconnected are resent in order once the connection is restored (up to 50 are buffered; anything older than 60 seconds is dropped). `e0185ba`
- **More accurate window layering**: the app menu overlay no longer takes part in window layer rotation, avoiding it and other windows covering each other. `e0185ba`

---

## 0.6.6 - 2026-09-08

**Version range note**: 0.6.6 / 0.6.7 / 0.6.8 previously had no entries in this file; from this section on they are backfilled, delimited by the version-number commits in the repository (0.6.6 corresponds to `67a603d`, 0.6.7 to `e0185ba`, 0.6.8 to `20456a7` and `6899ee6`); whether these three versions had publicly released installers has not been verified on this machine.

### New features

- **The supervisor no longer gets stuck handing out work**: tasks dispatched by the supervisor are now executed asynchronously, returning immediately with progress reported through the event stream, so remote entry points such as the mobile client no longer time out from waiting. `67a603d`
- **Handle the supervisor's approvals and questions right in the direct-message panel**: approval cards sent by the supervisor can be approved / rejected on the spot, and it automatically switches to the corresponding friend conversation. `67a603d`
- **Direct messages support Markdown formatting**: code blocks, links, and tables render properly in direct messages too, giving chat and direct messages a consistent look. `67a603d`
- **The default temperature for custom models is now 0**: when connecting a custom OpenAI-compatible endpoint the default temperature is 0 (more stable output); built-in models do not change the gateway's default parameters. `3df0175`

### Improvements

- **Attachments are no longer picky about type**: only size limits apply (images ≤10MB, others ≤20MB), so any file can be selected and sent. `3df0175`
- **Tool steps are folded into groups**: the multiple tool calls in one turn are merged into a single group, so the chat area is no longer flooded by tool steps. `67a603d`
- **Plugin icons are now arranged in order**: free dragging to place them is removed (dragging is only used to pin onto the Dock), and icons flow in registration order without covering each other. `3df0175`
- **Runtime environment info moved to its own context block**: the runtime environment details are split out of the system prompt and injected separately; assistant turns in history replay are explicitly marked "does not represent this round's result", so the model does not mistake history for the current task's output. `3df0175`

### Bug fixes

- **Window layering broke after picking a file on macOS**: window layering is corrected after the file picker closes, so the desktop shell is not covered and sub-session windows no longer appear to have disappeared. `3df0175`

---

## 0.6.5 - 2026-09-08

**Download**

- Windows x64: `https://store.bjctykj.com/app-versions/Windows/1788797196_Shanhai-0.6.5-x64.exe`
- macOS arm64 (Apple Silicon): `https://store.bjctykj.com/app-versions/macOS/1788798042_Shanhai-0.6.5-arm64.dmg`

**Release time**: macOS package 2026-09-08 00:20 (based on the timestamp in the download URL and the server Last-Modified); Windows package 2026-09-08 00:06.

**Version range note**: 0.6.4 was never publicly released (there is no installer for it on this machine, and the repository has no download URL pointing to it), so this version covers all changes from both the 0.6.4 and 0.6.5 version numbers; the corresponding commit is noted at the end of each entry.

### New features

- **One-click message sharing to a friend**: the bottom of AI replies and of your own sent-message cards gains a "Share" button; clicking it and choosing a friend sends that content into the direct-message conversation. `65c978b`
- **The supervisor can message friends directly**: the supervisor can now view your direct-message friend list (nickname, username, unread count, time of the last message), so when you say "tell Zhang San" it no longer needs to ask you for an ID. `65c978b`
- **Creative Space supports app updates**: after an app author publishes a new version, installed apps are marked "Update available" in "Discover" with an "Update" button, so you no longer have to uninstall and reinstall. `f483793`
- **Permission confirmation before update**: when the new version requests more capabilities than the old one, a before/after comparison is shown for confirmation before installation; if you disagree it is not installed and the old version is kept as-is. `f483793`
- **Restore the previous version after an update**: each update automatically keeps a copy of the old version, and the "Installed" panel can restore it with one click. `f483793`
- **Supervisor takes over direct messages**: after enabling "Supervisor takes over direct messages" in settings, friends' incoming messages can be answered directly by the supervisor; there is a confirmation dialog the first time it is enabled, and it can be turned off at any time. `a9c171a`
- **Right-click actions on direct messages**: direct messages support right-click copy and quote into a chosen session, making it easy to carry chat content into a task. `a9c171a`
- **Unread divider**: the start of unread messages is marked in a direct-message conversation, so you can see at a glance what you missed when you return to the window. `a9c171a`
- **Input drafts are kept**: the input of each session is saved separately, so it is no longer lost when switching sessions or restarting the app. `a9c171a`

### Improvements

- **A single direct message can be longer**: the client-side body length limit has been relaxed (about forty thousand bytes, the equivalent of over ten thousand Chinese characters); the limit fully takes effect only once the matching server version is live, and overly long messages may still be rejected while the server has not been updated. `65c978b`
- **Shared and relayed messages are no longer split into several**: one piece of content is sent as a single whole, with no segment numbering, making it easier for the supervisor to take over and process later. `65c978b`
- **Clearer content interception messages**: when a message cannot be sent, it now says roughly which kind of content triggered the interception (such as something suspected to be a key or token), instead of only a generic notice, and the intercepted content itself is not shown. `65c978b`
- **Normal technical discussion is no longer wrongly blocked**: when sharing or relaying messages, server addresses, file paths, and program error output are no longer treated as sensitive content; content suspected to be keys, tokens, passwords, or encoded data is still intercepted. `65c978b`
- **The direct-message window remembers its size**: after dragging or resizing, the next time it opens it keeps the previous window size. `a9c171a`
- **More accurate session status**: adds periodic checks and checks when switching back to the window, avoiding a session showing "running" for a long time or failing to show it when it should. `6cebd0f`
- **More convenient quick questions on the welcome page**: clicking a suggested question replaces the input box content with that question instead of appending to what is already there. `6cebd0f`

### Bug fixes

- **"Back to desktop" needed two clicks**: one click is now enough to fold away all Shanhai windows, leaving only the floating icon. `6cebd0f` `65c978b`
- **The supervisor main window stayed on top and covered other apps**: forced always-on-top is removed; the floating icon still stays in front. `6cebd0f`
- **A dialog with lots of content covered the window buttons**: dialogs now have a height limit and scroll internally, and no longer push out of the window and cover minimize, maximize, and close. `65c978b`
- **The direct-message "quote into session" popup pushed the session list out**: overly long quoted messages now scroll within that area, keeping the session list at the bottom fully intact and clickable. `65c978b`
- **A blank line was left after the cross-device read receipt disappeared**: when the notice is retracted, the space it occupied is retracted with it, leaving no blank strip. `65c978b`
- **The share button did nothing when clicked**: fixes the friend picker layer being carried outside the visible area by the message list container; it now pops up in the middle of the screen as soon as it is clicked. `65c978b`
- **Messages with images could not be shared**: fixes image links being wrongly judged as sensitive content and blocking the share; images and text are now sent together as one message. `65c978b`
- **On Windows, dragging one snapped window automatically resized the other**: fixes wrongly adjusting the other window while in snapped, maximized, or minimized state. `65c978b`
- **Occasional blank pages in individual session views**: fixes a render interruption caused by a change in component call order while a session row is in editing state. `6cebd0f`
- **Status out of sync after retrying or resuming a session**: fills in the missing start and end events so the UI status matches the actual execution. `6cebd0f`

### How to upgrade

Download the installer for the corresponding platform above and run it to install over the old version. Historical sessions, memory, and installed apps are all kept; there is no need to uninstall the old version.

### Insufficient evidence / to be confirmed

- **The Windows installer contents have not been verified on this machine**: there is no Windows artifact under `release/` on this machine, so it cannot be verified the way the macOS package was; the macOS package has been measured to be the same file as the online one (matching size and checksum) and to contain all of this version's change entries.
- **The direct-message length limit depends on the server**: the client-side relaxation is already shipped with the package, but the matching server-side change has not been deployed; until both take effect, overly long messages may be rejected by the server.
- **How macOS allows the first launch**: this version's packaging configures signing and the hardened runtime, but whether notarization has been completed has not been verified on this machine, so no guidance such as "needs to be opened via right-click" is written into the formal entries; it will be added once confirmed.
- **The historical entries for 0.6.2 / 0.6.3 are missing**: this file previously had only a 0.6.1 section, and 0.6.2 and 0.6.3 never had release notes written; they are not being backfilled from memory this round, and can be organized in a later round from the commit records if needed.

---

## 0.6.1 - 2026-09-03

### New features

- **Window snapping and linked movement**: the supervisor window automatically snaps and aligns when dragged close to a session window; after snapping, dragging either window makes the other follow and keep their relative position; once the two windows are pulled apart beyond a threshold they automatically unbind and move independently again.
- **Manual uninstall of "Installed" apps**: each app in the Creative Space "Installed" list gains an "Uninstall" button; clicking it asks for a second confirmation, and on confirmation the plugin is removed from this machine (uninstall is irreversible).
- **Improved card buttons in the Discover panel**: locally installed apps show a greyed-out "Installed" marker on the card (no longer showing the "Download and install" button), and the button is changed to a compact normal size.

### Bug fixes

- **Crosstalk when switching sub-sessions quickly**: fixes a race between main-process broadcasting and switching timing, so that session A's window no longer shows session B's history and security mode state.
- **Switching to a session with data showed the welcome screen**: fixes session-state completion wrongly clearing already-loaded history on switch; switching to a session with history now renders the chat records correctly.
- **Snapped windows dragged sluggishly and disconnected easily**: optimizes the programmatic-move detection and the unbind threshold/buffer, making linked movement more responsive and less likely to wrongly disconnect during a fast flick.
- **The "Installed" marker in the Discover panel failed**: fixes two root causes —— a mismatched plugin id comparison field, and a silent failure when reading the local directory from the main-process artifact —— so locally installed plugins now correctly show "Installed".
- **Download and install returned a 404 "plugin does not exist"**: the front end now prefers the plugin's real identifier, and download and install work again.
- **External remote (relay) connections reported 401 with no UI notice**: fixes the flood of pointless reconnects after login credentials expire; it now stops reconnecting pointlessly and clearly distinguishes "credentials expired, please log in again" from other connection failures in settings.
- **The "Installed" and "Uninstall" buttons in the Installed panel were on separate lines**: they are now shown on the same line, making the buttons compact and the layout cleaner.

---
