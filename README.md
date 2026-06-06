# Huawei HLS Capture PoC

Proof-of-concept Node.js tool to monitor legitimate browser traffic from a manually logged-in Huawei Talent Online Learning account, and save candidate HLS video URLs.

This tool does not perform authentication bypass, read Chrome cookies directly, reverse engineer private APIs, download videos, modify requests, or handle DRM.

## Design Rationale

1. `launchPersistentContext` is used so that Chromium Playwright has a persistent profile. After logging in manually once, the session can be reused from the `playwright-profile/` folder.
2. A separate Playwright profile is created from the main Chrome to avoid reading personal browser cookies and to be safer for experimentation.
3. Network monitoring uses official Playwright events: `request` and `response`. The script only observes the browser traffic originating from the opened page.
4. HLS candidates are detected from URLs containing `.m3u8` or response `content-type` for HLS: `application/vnd.apple.mpegurl` and `application/x-mpegURL`.
5. Deduplication uses an in-memory `Set`. The existing content of `urls.log` is read at startup, preventing the script from rewriting the same URLs upon restart.
6. `urls.log` stores timestamps, short metadata, and unique HLS URLs.
7. Debug mode is optional because modern pages can generate a vast amount of requests and responses.

## Project Structure

```text
huawei-hls-capture/
  package.json
  README.md
  .gitignore
  src/
    index.js
```

Generated runtime files:

```text
playwright-profile/  # persistent Chromium profile
urls.log             # log of timestamps for each new URL and metadata
videos.json          # module/lesson metadata and crawl results
```

## Requirements

1. Windows 11
2. Node.js 18 or newer
3. Internet access
4. Huawei Talent Online Learning account to log in manually via the Playwright browser

## Installation

```powershell
cd C:\Users\adima\OneDrive\Dokumen\Github\huawei-hls-capture
npm install
npx playwright install chromium
```

## How to Run

Run with the Huawei course URL:

```powershell
npm start -- --url "https://example-huawei-course-url"
```

Default manual workflow:

1. Run `npm start`.
2. The Playwright Chromium browser will open.
3. If not logged in, log in manually first in that browser window.
4. Once logged in, ensure the course page is open and ready.
5. Press Enter in the CMD when prompted.
6. Click lessons/videos manually one by one in the browser.
7. Every `.m3u8` observed from the browser's network will be logged to `urls.log`.

The script will continue monitoring the network until stopped with `Ctrl+C`.

If you do not want to wait for the Enter prompt and prefer monitoring to be active immediately:

```powershell
npm start -- --url "https://example-huawei-course-url" --no-wait
```

## Auto Lesson Mode

This mode attempts to enumerate lessons from the course UI, click them one by one, wait for the player to load the video, and save the `.m3u8` observed from normal browser traffic.

```powershell
npm start -- --url "https://example-huawei-course-url" --auto-lessons
```

With debug mode:

```powershell
npm run start:debug -- --url "https://example-huawei-course-url" --auto-lessons
```

Auto mode strategy:

1. Open the course page using the same persistent profile.
2. Expand visible elements with `aria-expanded="false"` to open modules/sections.
3. Scroll the page and general containers to trigger lazy loading.
4. Fetch lesson candidates from visible clickable elements like `a`, `button`, role `button`, role `treeitem`, role `listitem`, and elements with tabindex.
5. Click lesson candidates through the normal UI, instead of calling internal endpoints.
6. Wait for the player/video request to appear within the capture window.
7. Retry the lesson if no `.m3u8` is found.
8. Write progress after every lesson to enable resuming.

Resume is enabled by default. If the process stops, run the same command and lessons with the status `completed` will be skipped.

To rebuild metadata from scratch:

```powershell
npm start -- --url "https://example-huawei-course-url" --auto-lessons --no-resume
```

General tuning:

```powershell
npm start -- --url "https://example-huawei-course-url" --auto-lessons --max-attempts 3 --capture-window-ms 30000 --lesson-load-timeout-ms 8000
```

## Crawl Learning Page Mode

The newest and highly recommended mode. This mode assumes you are already on the Learning page with the sidebar menu on the left. The script will automatically detect modules and sub-modules, expand the menu, and capture HLS URLs from each material sequentially.

```powershell
npm run crawl -- --url "https://example-huawei-course-url"
```

This is equivalent to using the flag:
```powershell
npm start -- --crawl-learning-page --url "https://example-huawei-course-url"
```

## Debug Mode

```powershell
npm run start:debug -- --url "https://example-huawei-course-url"
```

Debug mode displays:

1. request URL
2. response URL
3. response status
4. response `content-type`

Alternative via environment variable:

```powershell
$env:DEBUG_HLS_CAPTURE="1"
npm start -- --url "https://example-huawei-course-url"
```

## CLI Options

```text
--url <url>             Huawei course page to open
--debug                 Print request URL, response URL, status, and content-type
--crawl-learning-page   Parse sidebar menu hierarchically and crawl lessons automatically
--auto-lessons          Discover and click lesson candidates automatically (Legacy)
--no-wait               Do not wait for Enter before manual monitoring
--resume                Resume from videos.json, default: enabled
--no-resume             Ignore existing videos.json and rebuild state
--retry-no-video        Retry lessons marked as no_video on resume
--max-attempts <n>      Retry attempts per lesson, default: 3
--capture-window-ms <n> Wait time for HLS after clicking lesson, default: 20000
--after-first-hit-grace-ms <n> Extra wait time after first m3u8 is found, default: 5000
--lesson-load-timeout-ms <n> Wait after clicking lesson before capture, default: 5000
--profile-dir <path>    Persistent browser profile directory, default: playwright-profile
--videos-file <path>    Custom output path for videos metadata, default: videos.json
--log-file <path>       Custom output path for URL logs, default: urls.log
--channel <name>        Optional browser channel, for example: chrome or msedge
```

Example using the Microsoft Edge channel if available:

```powershell
npm start -- --channel msedge --url "https://example-huawei-course-url"
```

## Output

When a new URL is found, the console displays:

```text
[hls] 2026-06-04T14:00:00.000Z https://example/video/master.m3u8
```

`videos.json` (for `--crawl-learning-page` format):

```json
{
  "courseUrl": "https://e.huawei.com/...",
  "createdAt": "2026-06-06T10:00:00.000Z",
  "updatedAt": "2026-06-06T10:15:00.000Z",
  "modules": [
    {
      "moduleIndex": "1",
      "moduleTitle": "1. WLAN Technical Basics",
      "lessons": [
        {
          "lessonId": "lesson-123456",
          "lessonIndex": "1.1",
          "lessonTitle": "1.1 Enterprise WLAN Overview",
          "textToMatch": "1.1 Enterprise WLAN Overview",
          "selector": "span.text",
          "status": "completed",
          "hasVideo": true,
          "lessonUrl": "https://e.huawei.com/...",
          "attempts": 1,
          "videos": [
            {
              "videoIndex": 1,
              "m3u8Url": "https://example/video/master.m3u8",
              "timestamp": "2026-06-06T10:05:00.000Z",
              "source": "response",
              "status": 200,
              "contentType": "application/vnd.apple.mpegurl"
            }
          ]
        }
      ]
    }
  ]
}
```

## Operational Notes

1. If no `.m3u8` appears, it's possible the video hasn't played or the player hasn't loaded the HLS playlist.
2. Auto lesson mode uses heuristic selectors because Huawei's UI may change. If discovery is incomplete, expand modules/sections manually and rerun.
3. HLS URLs are sometimes temporary or tied to the account session.
4. If the platform uses DRM or strict tokens, this tool still only logs the URLs visible to the normal browser.
5. The tool does not perform private API reverse engineering and does not access endpoints unused by the normal browser.

## Troubleshooting

If the browser fails to open:

```powershell
npx playwright install chromium
```

If a navigation timeout occurs, the browser is left open. Log in manually or reload the page from the browser.

If debug output is too noisy, use normal mode:

```powershell
npm start -- --url "https://example-huawei-course-url"
```
