import { app, BrowserWindow } from "electron";
import http from "node:http";
import path from "node:path";
import { startServer } from "./server.js";

const PORT = Number(process.env.PORT || 5173);
let mainWindow: BrowserWindow | null = null;

function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, res => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - started > timeoutMs) {
          reject(new Error("Server start timeout."));
          return;
        }
        setTimeout(tick, 250);
      });
    };
    tick();
  });
}

async function createWindow() {
  if (mainWindow) {
    mainWindow.focus();
    return;
  }

  const win = new BrowserWindow({
    width: 1100,
    height: 780,
    backgroundColor: "#f6f2ea",
    webPreferences: {
      nodeIntegration: false
    }
  });
  mainWindow = win;
  win.on("closed", () => {
    mainWindow = null;
  });

  const url = `http://localhost:${PORT}`;
  try {
    await waitForServer(url, 15000);
    await win.loadURL(url);
  } catch (err: any) {
    const message = err?.message || "Failed to start local server.";
    const html = `
      <html>
        <body style="font-family: sans-serif; padding: 24px;">
          <h2>PolyWAV Trimmer</h2>
          <p>Failed to start the local server.</p>
          <pre>${message}</pre>
        </body>
      </html>`;
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  }
}

app.whenReady().then(async () => {
  try {
    await startServer(PORT);
    await createWindow();
  } catch (err) {
    console.error(err);
    app.quit();
  }

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else {
      void createWindow();
    }
  });
}
