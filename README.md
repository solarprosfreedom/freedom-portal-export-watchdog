# Freedom Portal Export Watchdog

## How to run

1. Copy the `outputs/freedom_all_projects` progress folder into this repo. Do not reset `state.json`.

2. Start the local relay:

   ```sh
   ./start-all-projects.sh
   ```

   It should listen on `http://127.0.0.1:8775`.

3. Open a signed-in Portal tab: `https://portal.freedomforever.com`

## How to set up the browser extension

1. In Microsoft Edge, open `edge://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select the `edge-portal-watchdog` folder in this repo.
5. Reload the Portal tab. The extension badge should show **RUN**.
