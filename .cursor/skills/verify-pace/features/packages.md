# Packages

Packages is the Resource Management page. The user installs, updates, and inspects Pi packages and resources from the main sidebar. Changes apply to the next new Session.

## Sub-features

- `open-packages` opens the page from the sidebar.
- `installed-empty` shows an empty toolkit when the isolated Pi agent directory has no packages.
- `resources-dialog` opens the resources and configuration dialog.
- `environment-check` jumps from that dialog back to preflight.

## How to get to it (user POV)

- Press Packages in the sidebar group "Trajectory and usage navigation". The hash route is `#/packages`. Old `#/setup` links redirect here.
- The page title is Packages. Tabs are Discover, Installed, and Updates.
- Search is the textbox "Search packages".
- Press "Resources & configuration" to open the dialog of that name. "Add local resource" copies a local resource into the Pi agent directory. "Run environment check" opens preflight.
- Press "Install package" to enter an `npm:` or `git:` source. Local paths use Add local resource, not that field.

## Driving it with Playwright

Preconditions:

- Doctor exits 0 and the in-drive doctor passes.
- `launchPace({ seedPreflightAuth: true })` so preflight is already complete and the agent directory is the empty temp `agent/`.
- Do not set `PI_CODING_AGENT_DIR` to `~/.pi/agent`.

- **Open the page.** Click button "Packages". Heading "Packages" is visible. The Packages button has `aria-current="page"`. URL matches `/#\/packages$/`.
- **Installed toolkit.** Click the tab whose name matches `/^Installed · 0/`. Heading "Your toolkit" is visible. Empty state title "Your toolkit starts here" is visible.
- **Resources dialog.** Click button "Resources & configuration". Dialog "Resources & configuration" is visible, including the text "Changes apply to the next new Session." and button "Run environment check". Button "Add local resource" is visible inside the dialog. Do not click it. The native file picker is not part of this proof.
- **Back to preflight.** Click "Run environment check". Heading "Before your first session" is visible and the URL matches `/#\/preflight$/`. Because this profile already completed preflight, the page is the same gate opened again, not a wiped data directory.
- **Proof.** Screenshot the Installed empty state before opening the dialog. `result.txt` says `packages`. No package was installed and the temp `agent/` directory gained no package files. Copy a directory listing of `agent/` into the evidence directory before `close()` if you assert that.

## Gotchas

- Discover loads a network catalogue. Failure text is "The package catalogue couldn't load" with button "View installed". A catalogue failure does not fail the Installed proof. Do not install from Discover in a verification run.
- The Installed tab label includes the count: `Installed · ${n}`. Match the prefix.
- "Add local resource" and "Install package" mutate `PI_CODING_AGENT_DIR`. Leave them unclicked unless the recipe is specifically the install path, and then only against the temp agent directory.
- Theme resources are shown read-only. They do not change the Pace GUI.
- Settings and package filter changes apply on the next Session creation, not to a session that is already open.
