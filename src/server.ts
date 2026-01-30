import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { trimWav } from "./cli.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_PORT = Number(process.env.PORT || 5173);

type Job = {
  id: string;
  status: "uploading" | "processing" | "done" | "error";
  progress: number;
  outPath?: string;
  tmpDir?: string;
  error?: string;
  cleanupTimer?: NodeJS.Timeout;
};

const jobs = new Map<string, Job>();

const INDEX_HTML = `<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>PolyWAV Trimmer</title>
    <style>
      :root {
        --ink: #121415;
        --muted: #5c6670;
        --paper: #f6f2ea;
        --accent: #e46a3a;
        --accent-2: #2f6b64;
        --card: #fffaf0;
        --ring: rgba(18, 20, 21, 0.15);
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        color: var(--ink);
        background:
          radial-gradient(1200px 500px at 20% -10%, #f7d9b9 0%, transparent 60%),
          radial-gradient(900px 400px at 90% 10%, #c7e0d6 0%, transparent 55%),
          linear-gradient(135deg, #f3efe7 0%, #efe7da 45%, #f7efe4 100%);
        min-height: 100vh;
        font-family: "Gill Sans", "Trebuchet MS", sans-serif;
        letter-spacing: 0.2px;
      }

      .wrap {
        max-width: 980px;
        margin: 0 auto;
        padding: 48px 20px 72px;
        position: relative;
      }

      header {
        display: flex;
        flex-direction: column;
        gap: 12px;
        margin-bottom: 28px;
        animation: slideIn 600ms ease-out;
      }

      h1 {
        font-family: "Palatino", "Book Antiqua", serif;
        font-size: clamp(28px, 4vw, 40px);
        margin: 0;
        font-weight: 600;
      }

      .tagline {
        max-width: 660px;
        color: var(--muted);
        font-size: 16px;
        line-height: 1.5;
      }

      .card {
        background: var(--card);
        border-radius: 18px;
        box-shadow: 0 18px 50px rgba(18, 20, 21, 0.12);
        border: 1px solid rgba(18, 20, 21, 0.08);
        padding: 28px;
        display: grid;
        gap: 24px;
        animation: rise 700ms ease-out 80ms both;
      }

      .row {
        display: grid;
        gap: 14px;
      }

      .file-drop {
        border: 2px dashed rgba(18, 20, 21, 0.2);
        border-radius: 16px;
        padding: 20px;
        background: #fff;
        display: grid;
        gap: 12px;
      }

      .file-drop input[type="file"] {
        font-size: 15px;
      }

      .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        color: var(--muted);
        font-size: 14px;
      }

      .channels {
        display: grid;
        gap: 12px;
      }

      .chip-row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }

      .chip {
        border-radius: 999px;
        padding: 8px 12px;
        border: 1px solid var(--ring);
        background: #fff;
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 14px;
        cursor: pointer;
        transition: transform 140ms ease, box-shadow 140ms ease;
      }

      .chip input { accent-color: var(--accent); }
      .chip:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(18, 20, 21, 0.08); }
      .chip .meta {
        display: flex;
        flex-direction: column;
        gap: 2px;
        line-height: 1.2;
      }
      .chip .name {
        font-size: 12px;
        color: var(--muted);
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: center;
      }

      .player {
        display: grid;
        gap: 10px;
        padding: 16px;
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.7);
        border: 1px solid var(--ring);
      }

      .transport {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
      }

      .time {
        font-size: 14px;
        color: var(--muted);
      }

      .solo-btn {
        border: 1px solid var(--ring);
        background: #fff;
        border-radius: 8px;
        padding: 4px 8px;
        font-size: 12px;
        cursor: pointer;
      }

      .chip.solo {
        border-color: var(--accent-2);
        box-shadow: 0 10px 24px rgba(47, 107, 100, 0.18);
      }
      .chip .solo-btn.active {
        background: #f2c94c;
        border-color: #d2a736;
        color: #1d1d1d;
      }
      .footer-stamp {
        position: fixed;
        right: 20px;
        bottom: 14px;
        font-size: 12px;
        color: var(--muted);
        opacity: 0.7;
        pointer-events: none;
      }

      .progress {
        height: 10px;
        width: 100%;
        border-radius: 999px;
        background: rgba(18, 20, 21, 0.08);
        overflow: hidden;
      }

      .progress .bar {
        height: 100%;
        width: 0%;
        background: linear-gradient(90deg, var(--accent-2), var(--accent));
        transition: width 180ms ease;
      }

      button {
        border: none;
        padding: 12px 18px;
        border-radius: 12px;
        font-size: 15px;
        font-weight: 600;
        cursor: pointer;
      }

      .primary {
        background: linear-gradient(135deg, var(--accent), #f08a53);
        color: #fff;
        box-shadow: 0 10px 24px rgba(228, 106, 58, 0.35);
      }

      .ghost {
        background: #fff;
        color: var(--ink);
        border: 1px solid var(--ring);
      }

      .status {
        min-height: 22px;
        font-size: 14px;
        color: var(--muted);
      }

      @keyframes slideIn {
        from { opacity: 0; transform: translateY(10px); }
        to { opacity: 1; transform: translateY(0); }
      }

      @keyframes rise {
        from { opacity: 0; transform: translateY(16px); }
        to { opacity: 1; transform: translateY(0); }
      }

      @media (max-width: 720px) {
        .card { padding: 20px; }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <header>
        <h1>PolyWAV Trimmer</h1>
        <div class="tagline">Drop a WAV, select channels, get a new file. No cloud, fully local.</div>
      </header>

      <section class="card">
        <div class="row file-drop">
          <label><strong>Select file</strong></label>
          <input id="fileInput" type="file" accept=".wav,audio/wav" />
          <div class="meta">
            <span id="fileName">No file selected</span>
            <span id="fileInfo"></span>
          </div>
        </div>

        <div class="channels">
          <strong>Channels</strong>
          <div id="channels" class="chip-row"></div>
          <div class="actions">
            <button id="selectAll" class="ghost" type="button">All</button>
            <button id="selectNone" class="ghost" type="button">None</button>
          </div>
        </div>

        <div class="player">
          <strong>Player</strong>
          <div class="transport">
            <button id="playBtn" class="ghost" type="button">Play</button>
            <button id="stopBtn" class="ghost" type="button">Stop</button>
            <div id="timeLabel" class="time">0:00 / 0:00</div>
          </div>
          <input id="seekBar" type="range" min="0" max="0" value="0" step="0.01" />
          <div id="soloStatus" class="status">Stereo (Ch 1-2)</div>
        </div>

        <div class="actions">
          <button id="trimBtn" class="primary" type="button">Trim</button>
          <div class="status" id="status"></div>
        </div>
        <div class="progress">
          <div id="progressBar" class="bar"></div>
        </div>
        <div class="status" id="progressText"></div>
      </section>
      <div class="footer-stamp">Freshly made for you by Mamamia &amp; Codex</div>
    </div>

    <script>
      const fileInput = document.getElementById("fileInput");
      const fileName = document.getElementById("fileName");
      const fileInfo = document.getElementById("fileInfo");
      const channelsWrap = document.getElementById("channels");
      const statusEl = document.getElementById("status");
      const trimBtn = document.getElementById("trimBtn");
      const selectAllBtn = document.getElementById("selectAll");
      const selectNoneBtn = document.getElementById("selectNone");
      const progressBar = document.getElementById("progressBar");
      const progressText = document.getElementById("progressText");
      const playBtn = document.getElementById("playBtn");
      const stopBtn = document.getElementById("stopBtn");
      const seekBar = document.getElementById("seekBar");
      const timeLabel = document.getElementById("timeLabel");
      const soloStatus = document.getElementById("soloStatus");
      let pollTimer = null;
      let activeJobId = null;
      let downloadStarted = false;
      let audioCtx = null;
      let audioEl = null;
      let sourceNode = null;
      let splitterNode = null;
      let mergerNode = null;
      let isPlaying = false;
      let soloChannel = null;
      let rafId = null;
      let channelCount = 0;
      let objectUrl = null;

      function setStatus(msg) {
        statusEl.textContent = msg || "";
      }

      function setSoloStatus() {
        if (soloChannel) {
          soloStatus.textContent = "Solo (Ch " + soloChannel + ")";
        } else {
          soloStatus.textContent = "Stereo (Ch 1-2)";
        }
      }

      function formatTime(seconds) {
        const s = Math.max(0, Math.floor(seconds));
        const m = Math.floor(s / 60);
        const r = s % 60;
        return m + ":" + String(r).padStart(2, "0");
      }

      function getCurrentTime() {
        if (!audioEl) return 0;
        return audioEl.currentTime || 0;
      }

      function updateTimeUI() {
        if (!audioEl || !Number.isFinite(audioEl.duration)) {
          timeLabel.textContent = "0:00 / 0:00";
          seekBar.value = "0";
          return;
        }
        const current = getCurrentTime();
        timeLabel.textContent = formatTime(current) + " / " + formatTime(audioEl.duration);
        seekBar.value = String(current);
      }

      function startTicker() {
        if (rafId) return;
        const tick = () => {
          updateTimeUI();
          if (isPlaying) {
            rafId = requestAnimationFrame(tick);
          } else {
            rafId = null;
          }
        };
        tick();
      }

      function stopPlayback(resetOffset) {
        if (audioEl) {
          audioEl.pause();
          if (resetOffset) audioEl.currentTime = 0;
        }
        isPlaying = false;
        playBtn.textContent = "Play";
      }

      function buildGraph() {
        if (!audioCtx || !sourceNode || !channelCount) return;
        if (splitterNode) splitterNode.disconnect();
        if (mergerNode) mergerNode.disconnect();
        sourceNode.disconnect();

        splitterNode = audioCtx.createChannelSplitter(channelCount);
        mergerNode = audioCtx.createChannelMerger(2);
        sourceNode.connect(splitterNode);

        if (soloChannel && soloChannel <= channelCount) {
          const idx = soloChannel - 1;
          splitterNode.connect(mergerNode, idx, 0);
          splitterNode.connect(mergerNode, idx, 1);
        } else {
          if (channelCount >= 2) {
            splitterNode.connect(mergerNode, 0, 0);
            splitterNode.connect(mergerNode, 1, 1);
          } else {
            splitterNode.connect(mergerNode, 0, 0);
            splitterNode.connect(mergerNode, 0, 1);
          }
        }

        mergerNode.connect(audioCtx.destination);
      }

      async function startPlayback() {
        if (!audioEl) return;
        if (!audioCtx) audioCtx = new AudioContext();
        await audioCtx.resume();
        buildGraph();
        await audioEl.play();
        isPlaying = true;
        playBtn.textContent = "Pause";
        startTicker();
      }

      function togglePlay() {
        if (!audioEl) return;
        if (isPlaying) {
          stopPlayback(false);
          playBtn.textContent = "Play";
        } else {
          startPlayback();
        }
      }

      function seekTo(value) {
        if (!audioEl || !Number.isFinite(audioEl.duration)) return;
        audioEl.currentTime = Math.min(audioEl.duration, Math.max(0, value));
        updateTimeUI();
      }

      function setSolo(channel) {
        if (soloChannel === channel) {
          soloChannel = null;
        } else {
          soloChannel = channel;
        }
        document.querySelectorAll(".chip").forEach(el => el.classList.remove("solo"));
        document.querySelectorAll(".solo-btn").forEach(el => el.classList.remove("active"));
        if (soloChannel) {
          const el = document.querySelector('.chip[data-channel="' + soloChannel + '"]');
          if (el) {
            el.classList.add("solo");
            const btn = el.querySelector(".solo-btn");
            if (btn) btn.classList.add("active");
          }
        }
        setSoloStatus();
        buildGraph();
      }

      function setProgress(value, msg) {
        const clamped = Math.max(0, Math.min(100, value));
        progressBar.style.width = clamped + "%";
        progressText.textContent = msg ? msg + " " + clamped + "%" : clamped + "%";
      }

      function buildChannelChips(count, names, tracks) {
        channelsWrap.innerHTML = "";
        const channelList = tracks && tracks.length
          ? tracks.slice().sort((a, b) => a.interleave - b.interleave)
          : (() => {
              const nameKeys = names ? Object.keys(names).map(n => Number(n)).filter(n => Number.isFinite(n)) : [];
              const channels = nameKeys.length
                ? nameKeys.sort((a, b) => a - b)
                : Array.from({ length: count }, (_, i) => i + 1);
              return channels.map(i => ({ interleave: i, channelIndex: i, name: names && names[i] ? names[i] : "" }));
            })();
        for (const ch of channelList) {
          const label = document.createElement("label");
          label.className = "chip";
          label.dataset.channel = String(ch.interleave);
          const input = document.createElement("input");
          input.type = "checkbox";
          input.value = String(ch.channelIndex);
          input.dataset.keep = String(ch.channelIndex);
          input.checked = true;
          const meta = document.createElement("span");
          meta.className = "meta";
          const title = document.createElement("span");
          title.textContent = "Channel " + ch.channelIndex;
          const name = document.createElement("span");
          name.className = "name";
          const labelName = ch.name || "";
          name.textContent = labelName;
          const soloBtn = document.createElement("button");
          soloBtn.type = "button";
          soloBtn.className = "solo-btn";
          soloBtn.textContent = "Solo";
          soloBtn.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            setSolo(ch.interleave);
          });
          meta.appendChild(title);
          if (labelName) meta.appendChild(name);
          label.appendChild(input);
          label.appendChild(meta);
          label.appendChild(soloBtn);
          channelsWrap.appendChild(label);
        }
      }

      function getSelectedChannels() {
        return Array.from(channelsWrap.querySelectorAll("input[type='checkbox']"))
          .filter(el => el.checked)
          .map(el => el.dataset.keep || el.value);
      }

      function updateSelectionStatus() {
        const selected = getSelectedChannels().length;
        const total = channelsWrap.querySelectorAll("input[type='checkbox']").length;
        if (total > 0) {
          setStatus(total + " channels found. " + selected + " selected.");
        }
      }

      function parseIXMLTracks(ixmlText) {
        const tracksOut = [];
        try {
          const parser = new DOMParser();
          const doc = parser.parseFromString(ixmlText, "application/xml");
          const tracks = doc.getElementsByTagName("TRACK");
          for (const track of tracks) {
            const chNode = track.getElementsByTagName("CHANNEL_INDEX")[0];
            const trackNode =
              track.getElementsByTagName("TRACK_INDEX")[0] ||
              track.getElementsByTagName("TRACK_NO")[0];
            const channelIndex = chNode ? Number(chNode.textContent) : null;
            const trackIndex = trackNode ? Number(trackNode.textContent) : null;
            const nameNode =
              track.getElementsByTagName("NAME")[0] ||
              track.getElementsByTagName("TRACK_NAME")[0];
            const name = nameNode ? nameNode.textContent : "";
            if (name) {
              tracksOut.push({
                channelIndex: Number.isFinite(channelIndex) ? channelIndex : null,
                trackIndex: Number.isFinite(trackIndex) ? trackIndex : null,
                name
              });
            }
          }
        } catch {
          return tracksOut;
        }
        return tracksOut;
      }

      function readWavInfo(file) {
        const slice = file.slice(0, 1024 * 1024);
        return slice.arrayBuffer().then((buf) => {
          const dv = new DataView(buf);
          if (buf.byteLength < 16) return null;
          const riff = String.fromCharCode(
            dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)
          );
          const wave = String.fromCharCode(
            dv.getUint8(8), dv.getUint8(9), dv.getUint8(10), dv.getUint8(11)
          );
          if (riff !== "RIFF" || wave !== "WAVE") return null;

          let pos = 12;
          let channels = null;
          let names = {};
          let tracks = [];
          const chnaEntries = [];
          while (pos + 8 <= buf.byteLength) {
            const id = String.fromCharCode(
              dv.getUint8(pos), dv.getUint8(pos + 1), dv.getUint8(pos + 2), dv.getUint8(pos + 3)
            );
            const size = dv.getUint32(pos + 4, true);
            const dataStart = pos + 8;
            if (id === "fmt ") {
              if (dataStart + 4 > buf.byteLength) return null;
              channels = dv.getUint16(dataStart + 2, true);
            }
            if (id === "iXML" && dataStart + size <= buf.byteLength) {
              const bytes = new Uint8Array(buf, dataStart, size);
              const text = new TextDecoder("utf-8").decode(bytes).replace(/\u0000+$/g, "");
              tracks = parseIXMLTracks(text);
            }
            if (id === "chna" && dataStart + size <= buf.byteLength && size >= 4) {
              const numUIDs = dv.getUint16(dataStart + 2, true);
              const entrySize = 40;
              const maxEntries = Math.floor((size - 4) / entrySize);
              const entries = Math.min(numUIDs, maxEntries);
              for (let i = 0; i < entries; i++) {
                const off = dataStart + 4 + i * entrySize;
                const trackIndex = dv.getUint16(off, true);
                const channelIndex = dv.getUint16(off + 2, true);
                if (trackIndex && channelIndex) {
                  chnaEntries.push({ trackIndex, channelIndex });
                }
              }
            }
            pos = dataStart + size + (size % 2);
          }
          let trackList = [];
          if (chnaEntries.length) {
            const nameByTrack = {};
            const nameByChannel = {};
            for (const t of tracks) {
              if (t.trackIndex) nameByTrack[t.trackIndex] = t.name;
              if (t.channelIndex) nameByChannel[t.channelIndex] = t.name;
            }
            trackList = chnaEntries.map((entry) => {
              const name = nameByTrack[entry.trackIndex] || nameByChannel[entry.channelIndex] || "";
              if (name) names[entry.channelIndex] = name;
              return {
                interleave: entry.trackIndex,
                channelIndex: entry.channelIndex,
                name
              };
            });
          } else if (tracks.length) {
            trackList = tracks.map((t, idx) => {
              const interleave = t.trackIndex || idx + 1;
              const channelIndex = t.channelIndex || t.trackIndex || idx + 1;
              if (t.name) names[channelIndex] = t.name;
              return { interleave, channelIndex, name: t.name || "" };
            });
          }
          if (!channels) return null;
          return { channels, names, tracks: trackList };
        });
      }

      setSoloStatus();
      updateTimeUI();

      fileInput.addEventListener("change", async () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        fileName.textContent = file.name;
        fileInfo.textContent = (file.size / (1024 * 1024)).toFixed(2) + " MB";
        setProgress(0, "");
        setStatus("Reading header...");
        const info = await readWavInfo(file);
        if (!info) {
          setStatus("Could not read channel count.");
          channelsWrap.innerHTML = "";
          return;
        }
        buildChannelChips(info.channels, info.names, info.tracks);
        updateSelectionStatus();
        soloChannel = null;
        setSoloStatus();

        try {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          objectUrl = URL.createObjectURL(file);
          if (!audioCtx) audioCtx = new AudioContext();
          if (audioEl) audioEl.pause();
          if (sourceNode) sourceNode.disconnect();
          if (splitterNode) splitterNode.disconnect();
          if (mergerNode) mergerNode.disconnect();
          audioEl = new Audio();
          audioEl.src = objectUrl;
          audioEl.preload = "metadata";
          audioEl.onloadedmetadata = () => {
            seekBar.max = String(audioEl.duration || 0);
            updateTimeUI();
          };
          audioEl.onended = () => {
            isPlaying = false;
            playBtn.textContent = "Play";
            updateTimeUI();
          };
          audioEl.onerror = () => {
            setStatus("Audio load failed.");
          };
          channelCount = info.channels;
          sourceNode = audioCtx.createMediaElementSource(audioEl);
          buildGraph();
          seekBar.value = "0";
          stopPlayback(true);
          updateTimeUI();
        } catch {
          setStatus("Audio setup failed.");
          audioEl = null;
        }
      });

      selectAllBtn.addEventListener("click", () => {
        channelsWrap.querySelectorAll("input[type='checkbox']").forEach(el => el.checked = true);
        updateSelectionStatus();
      });

      selectNoneBtn.addEventListener("click", () => {
        channelsWrap.querySelectorAll("input[type='checkbox']").forEach(el => el.checked = false);
        updateSelectionStatus();
      });

      channelsWrap.addEventListener("change", (event) => {
        if (event.target && event.target.matches("input[type='checkbox']")) {
          updateSelectionStatus();
        }
      });

      playBtn.addEventListener("click", () => {
        togglePlay();
      });

      stopBtn.addEventListener("click", () => {
        stopPlayback(true);
        updateTimeUI();
      });

      seekBar.addEventListener("input", (event) => {
        const value = Number(event.target.value);
        seekTo(value);
      });

      trimBtn.addEventListener("click", async () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) {
          setStatus("Please choose a WAV file first.");
          return;
        }
        const keep = getSelectedChannels();
        if (keep.length === 0) {
          setStatus("Select at least one channel.");
          return;
        }
        if (trimBtn.disabled) return;
        trimBtn.disabled = true;
        downloadStarted = false;
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        setStatus("Uploading...");
        setProgress(0, "Upload");
        const body = file;
        const params = new URLSearchParams();
        params.set("keep", keep.join(","));
        params.set("name", file.name);

        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/trim?" + params.toString(), true);
        xhr.responseType = "json";
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        xhr.upload.onprogress = (evt) => {
          if (!evt.lengthComputable) return;
          const pct = Math.round((evt.loaded / evt.total) * 40);
          setProgress(pct, "Upload");
        };
        xhr.onerror = () => {
          setStatus("Fehler beim Upload.");
        };
        xhr.onload = async () => {
          if (xhr.status !== 200 || !xhr.response || !xhr.response.jobId) {
            setStatus("Failed to start job.");
            trimBtn.disabled = false;
            return;
          }
          const jobId = xhr.response.jobId;
          activeJobId = jobId;
          setStatus("Processing...");
          setProgress(40, "Processing");
          pollTimer = setInterval(async () => {
            const res = await fetch("/api/status?id=" + encodeURIComponent(jobId));
            if (!res.ok) return;
            const data = await res.json();
            if (data.status === "processing") {
              const pct = 40 + Math.round((data.progress || 0) * 50);
              setProgress(pct, "Processing");
            } else if (data.status === "done") {
              clearInterval(pollTimer);
              pollTimer = null;
              if (downloadStarted || activeJobId !== jobId) return;
              downloadStarted = true;
              setStatus("Starting download...");
              setProgress(92, "Download");

              const downloadUrl = "/api/download?id=" + encodeURIComponent(jobId);
              const a = document.createElement("a");
              a.href = downloadUrl;
              a.download = file.name;
              document.body.appendChild(a);
              a.click();
              a.remove();

              setTimeout(() => {
                setProgress(100, "Done");
                setStatus("Done. Download started.");
                trimBtn.disabled = false;
              }, 400);
            } else if (data.status === "error") {
              clearInterval(pollTimer);
              pollTimer = null;
              setStatus("Error: " + (data.error || "Unknown"));
              trimBtn.disabled = false;
            }
          }, 500);
        };
        xhr.send(body);
      });
    </script>
  </body>
</html>`;

function send(res: http.ServerResponse, status: number, body: string, headers?: Record<string, string>) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...headers });
  res.end(body);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function parseKeepParam(raw: string | null): number[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n) && n >= 1);
}

function collectBodyToFile(req: http.IncomingMessage, filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(filePath);
    req.pipe(stream);
    req.on("error", reject);
    stream.on("error", reject);
    stream.on("finish", resolve);
  });
}

function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function createJob(tmpDir: string): Job {
  const id = Math.random().toString(36).slice(2, 10);
  const job: Job = { id, status: "uploading", progress: 0, tmpDir };
  jobs.set(id, job);
  return job;
}

function scheduleCleanup(job: Job) {
  if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
  job.cleanupTimer = setTimeout(() => {
    if (job.tmpDir) fs.rmSync(job.tmpDir, { recursive: true, force: true });
    jobs.delete(job.id);
  }, 30 * 60 * 1000);
}

function createServer() {
  return http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/") {
    send(res, 200, INDEX_HTML);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/trim") {
    const keep = parseKeepParam(url.searchParams.get("keep"));
    const name = safeFilename(url.searchParams.get("name") || "output.wav");

    if (keep.length === 0) {
      send(res, 400, "Keep list is empty.");
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "polywav-"));
    const inputPath = path.join(tmpDir, name);
    const outDir = path.join(tmpDir, "out");
    const job = createJob(tmpDir);

    try {
      await collectBodyToFile(req, inputPath);
      job.status = "processing";
      sendJson(res, 200, { jobId: job.id });

      trimWav(inputPath, keep, {
        outDir,
        onProgress: (ratio) => {
          job.progress = ratio;
        }
      }).then((outPath) => {
        job.status = "done";
        job.outPath = outPath;
        scheduleCleanup(job);
      }).catch((err: any) => {
        job.status = "error";
        job.error = err?.message || "Failed to trim file.";
        scheduleCleanup(job);
      });
    } catch (err: any) {
      job.status = "error";
      job.error = err?.message || "Failed to trim file.";
      scheduleCleanup(job);
      send(res, 500, job.error || "Failed to trim file.");
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    const id = url.searchParams.get("id") || "";
    const job = jobs.get(id);
    if (!job) {
      sendJson(res, 404, { status: "error", error: "Job not found." });
      return;
    }
    sendJson(res, 200, {
      status: job.status,
      progress: job.progress,
      error: job.error
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/download") {
    const id = url.searchParams.get("id") || "";
    const job = jobs.get(id);
    if (!job || job.status !== "done" || !job.outPath) {
      send(res, 404, "Not ready.");
      return;
    }
    const stat = fs.statSync(job.outPath);
    res.writeHead(200, {
      "Content-Type": "audio/wav",
      "Content-Length": String(stat.size),
      "Content-Disposition": `attachment; filename="${path.basename(job.outPath)}"`
    });
    fs.createReadStream(job.outPath).pipe(res);
    res.on("finish", () => scheduleCleanup(job));
    return;
  }

  send(res, 404, "Not found.");
  });
}

export function startServer(port = DEFAULT_PORT) {
  const server = createServer();
  return new Promise<http.Server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      console.log("UI running on http://localhost:" + port);
      resolve(server);
    });
  });
}

const isDirectRun = process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url;
if (isDirectRun) {
  startServer().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
