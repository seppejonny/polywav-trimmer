# PolyWAV Trimmer

Trim channels from PolyWAV/BWF files while preserving metadata (bext, iXML, chna).

## Features
- Select channels to keep and export a new WAV
- Preserves iXML/bext/chna where possible
- Local UI with player and solo per channel
- Works with large files (streaming playback)

## Local UI
```bash
npm install
npm run ui
```
Open `http://localhost:5173`.

## CLI
```bash
npm install
npm run dev -- "in.wav" "1,2,3"
```

## Build Desktop App (macOS)
```bash
npm install
npm run build
npm run electron:dist
```
DMG output in `release/`.

## Build Desktop App (Windows)
Run the same commands on Windows:
```bash
npm install
npm run build
npm run electron:dist
```
EXE output in `release/`.

## GitHub Releases
Create a tag to trigger the release workflow:
```bash
git tag v1.0.1
git push --tags
```
Artifacts appear under GitHub Releases.

## Notes
- macOS builds are not code-signed by default (Gatekeeper warning).
- Windows builds must be created on Windows (or CI).
