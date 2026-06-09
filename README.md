# Huawei HLS Capture PoC

Proof-of-concept Node.js tool to monitor legitimate browser traffic from a manually logged-in Huawei Talent Online Learning account, and save candidate HLS video URLs. The tool can also convert these HLS `.m3u8` streams into `.mp4` using `yt-dlp`.

This tool does not perform authentication bypass, read Chrome cookies directly, reverse engineer private APIs, modify requests, or handle DRM.

## Design Rationale

1. `launchPersistentContext` is used so that Chromium Playwright has a persistent profile. After logging in manually once, the session can be reused from the `playwright-profile/` folder.
2. A separate Playwright profile is created from the main Chrome to avoid reading personal browser cookies and to be safer for experimentation.
3. Network monitoring uses official Playwright events: `request` and `response`. The script only observes the browser traffic originating from the opened page.
4. HLS candidates are detected from URLs containing `.m3u8` or response `content-type` for HLS: `application/vnd.apple.mpegurl` and `application/x-mpegURL`.
5. Video downloading delegates to `yt-dlp`, which safely captures chunks and merges them using `ffmpeg`.

## Project Structure

```text
huawei-hls-capture/
  package.json
  README.md
  .gitignore
  convert.bat          # Direct batch file to convert existing videos.json
  menu.bat             # Direct batch file for interactive menu
  src/
    index.js
```

Generated runtime files:

```text
playwright-profile/  # persistent Chromium profile
urls.log             # log of timestamps for each new URL and metadata
videos.json          # module/lesson metadata and crawl results
downloads/           # Output directory for converted .mp4 files
```

## Requirements

1. Windows 11
2. Node.js 18 or newer
3. Internet access
4. Huawei Talent Online Learning account to log in manually via the Playwright browser
5. `yt-dlp` installed for conversion feature (`winget install yt-dlp.yt-dlp` or `pip install -U yt-dlp`)
6. `ffmpeg` installed to properly merge video/audio tracks during conversion

## How to Run

### Interactive Menu (Recommended)

Simply start the app without flags to get an interactive menu:

```powershell
npm start
# or
node src/index.js
```

The menu will prompt:
```text
Huawei HLS Capture

1. Scrape learning page, then optionally convert to MP4
2. Convert/download existing videos.json to MP4
3. Exit
```

### Crawl Learning Page Mode

Assuming you are already on the Learning page with the sidebar menu on the left. The script will automatically detect modules and sub-modules, expand the menu, and capture HLS URLs from each material sequentially.

```powershell
npm run crawl -- --url "https://example-huawei-course-url"
```

If you want the tool to ask you to convert to MP4 immediately after crawling completes:
```powershell
npm run scrape-and-convert -- --url "https://example-huawei-course-url"
```

### Direct Convert Mode

If you already have a `videos.json` from a previous crawl session and want to download them:

```powershell
npm run convert
# or
convert.bat
```

## Download & Conversion Workflow

The conversion process reads `videos.json` and creates a clean directory structure reflecting the course hierarchy:

```text
downloads/
  Huawei Talent Course/
    1. WLAN Technical Basics/
      1.1 Enterprise WLAN Overview/
        1.1 Enterprise WLAN Overview - Stream 1.mp4
```

### Resume Behavior

- If the output `.mp4` file exists and is not empty, the script automatically skips the download and marks it completed.
- If a stream previously failed, you must use `--retry-failed-downloads` to attempt downloading it again.
- If you want to force redownloading already completed streams, use `--force-download`.
- `videos.json` is incrementally updated after each download so you won't lose progress if the script stops.

## Maintenance and Verification

To verify that metadata perfectly matches the physical `.mp4` files and generate a structured JSON or Markdown report:
```powershell
node src/index.js --verify-downloads --videos-file videos-fixed-3.json --downloads-dir downloads-final
node src/index.js --verify-downloads --videos-file videos-fixed-3.json --downloads-dir downloads-final --report-file download-report.md
```

To clean up leftover `yt-dlp` partial/temporary files after an interrupted download (this will ask for confirmation before deleting):
```powershell
node src/index.js --clean-temp-files --downloads-dir downloads-final
```

## CLI Options

```text
--convert                 Convert/download existing videos.json to MP4
--ask-convert             Prompt to convert after crawling
--downloads-dir <path>    Output directory for MP4s, default: downloads
--retry-failed-downloads  Retry streams marked as failed
--force-download          Redownload even if file exists
--yt-dlp-path <path>      Path to yt-dlp executable, default: yt-dlp
--ffmpeg-location <path>  Path to ffmpeg executable
--download-concurrency <n> Number of parallel downloads, default: 1
--download-timeout-ms <n> Timeout for yt-dlp process, default: 0 (no timeout)
--verify-downloads        Verify videos metadata against physical MP4 files
--clean-temp-files        Delete leftover yt-dlp temporary files in downloads dir
--clean-force             Bypass confirmation prompt when cleaning temp files
--report-file <path>      Write verification report JSON or Markdown, default: download-report.json
--postprocess-retries <n> Retry file-lock postprocess failures, default: 3
--postprocess-retry-delay-ms <n> Delay between postprocess retries, default: 5000
--url <url>               Huawei course page to open
--debug                   Print request URL, response URL, status, and content-type
--crawl-learning-page     Parse sidebar menu hierarchically and crawl lessons automatically
--auto-lessons            Discover and click lesson candidates automatically (Legacy)
--no-wait                 Do not wait for Enter before manual monitoring
--resume                  Resume from videos.json, default: enabled
--no-resume               Ignore existing videos.json and rebuild state
--retry-no-video          Retry lessons marked as no_video on resume
--max-attempts <n>        Retry attempts per lesson, default: 3
--capture-window-ms <n>   Wait time for HLS after clicking lesson, default: 20000
--after-first-hit-grace-ms <n> Extra wait time after first m3u8 is found, default: 5000
--lesson-load-timeout-ms <n> Wait after clicking lesson before capture, default: 5000
--profile-dir <path>      Persistent browser profile directory, default: playwright-profile
--videos-file <path>      Custom output path for videos metadata, default: videos.json
--log-file <path>         Custom output path for URL logs, default: urls.log
--channel <name>          Optional browser channel, for example: chrome or msedge
```

## Operational Notes

1. If no `.m3u8` appears, it's possible the video hasn't played or the player hasn't loaded the HLS playlist.
2. HLS URLs are sometimes temporary or tied to the account session. If the download fails due to an expired link (e.g. `HTTP Error 403: Forbidden`), the script will mark it as `failed` and you will need to re-scrape the learning page to obtain fresh links.
3. If the platform uses DRM or strict tokens, this tool still only logs the URLs visible to the normal browser. It does not attempt to bypass DRM.
4. The tool does not perform private API reverse engineering and does not access endpoints unused by the normal browser.

## Troubleshooting

If the browser fails to open:

```powershell
npx playwright install chromium
```

If conversion fails due to missing commands:
- Install `yt-dlp`: `winget install yt-dlp.yt-dlp`
- Install `ffmpeg`: Ensure it is in your system PATH or provide the path with `--ffmpeg-location`.
