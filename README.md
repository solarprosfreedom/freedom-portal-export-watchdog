# Freedom Portal Export Watchdog

Edge extension plus a local Node relay that exports unfiltered Freedom Portal projects to CSV. Progress is saved on disk, so a new machine can continue from the last checkpoint.

## Current checkpoint

All Projects was last saved at page **1584 / 2458** (`updatedAt`: 2026-09-25).

| Field | Value |
| --- | --- |
| Portal total | 614,276 |
| Pages scanned | 1,584 / 2,458 |
| Known project IDs | 405,605 |
| Details saved | 197,316 |
| Details partial | 203,556 |
| Installs export | finished (do not rerun) |

GitHub cannot hold the live progress files. `project-results.json` is over GitHub’s 100 MB file limit. Copy the `outputs/` folder separately, then place it in this repo before starting.

## What the next person needs

- macOS
- Node.js (`node` on PATH)
- Microsoft Edge
- A signed-in [Freedom Portal](https://portal.freedomforever.com) session
- This repo
- The separate `outputs/` progress pack

## Setup

```sh
git clone https://github.com/solarprosfreedom/freedom-portal-export-watchdog.git
cd freedom-portal-export-watchdog
```

Copy the progress pack into place so these files exist:

```
outputs/freedom_all_projects/state.json
outputs/freedom_all_projects/project-candidates.json
outputs/freedom_all_projects/project-results.json
outputs/freedom_all_projects/FreedomPortal_All_Projects.csv
```

Do not delete or reset `state.json`. That file is the resume point.

## Run

1. Start the All Projects relay from this repo folder:

   ```sh
   ./start-all-projects.sh
   ```

   You should see it listening on `http://127.0.0.1:8775`.

2. In Edge open `edge://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the `edge-portal-watchdog` folder.

3. Open a signed-in Portal tab: `https://portal.freedomforever.com`

4. Reload that tab. The extension badge should show **RUN**.

It resumes at page 1584 because `state.json` already has that checkpoint.

## Check progress

Read `outputs/freedom_all_projects/state.json`.

Watch `nextPage`, `listRowsScanned`, `detailsSaved`, and `updatedAt`. If `updatedAt` is hours old, reload the Portal tab.

Finished CSV:

`outputs/freedom_all_projects/FreedomPortal_All_Projects.csv`

Optional valid-phone filter:

```sh
node filter-all-projects-valid-phones.mjs
```

## Keep it running after reboot

Edit `launch-agents/com.freedomportal.all-projects-relay.plist.example`, replace `REPLACE_WITH_REPO_PATH`, then install it:

```sh
cp launch-agents/com.freedomportal.all-projects-relay.plist.example ~/Library/LaunchAgents/com.freedomportal.all-projects-relay.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.freedomportal.all-projects-relay.plist
```

## Do not

- Run `npm install` (this project has no npm dependencies)
- Commit `outputs/*.json`, `outputs/*.csv`, or `.relay-token`
- Change `nextPage` in `state.json`
- Start a second copy of the same job from an empty `outputs/` folder
