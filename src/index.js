import { chromium } from 'playwright';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';

function toWIB(date) {
  return (date || new Date()).toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' }).replace(' ', 'T') + '+07:00';
}

const DEFAULT_COURSE_URL = 'https://e.huawei.com/en/talent/outPage/#/sxz-course/home?courseId=Q96qaZ1Dx6hJx-3t_2bThTJY5ls&operate=1';
const HLS_CONTENT_TYPES = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl'
];

const options = parseArgs(process.argv.slice(2));
const baseDir = process.cwd();
const profileDir = path.resolve(baseDir, options.profileDir);
const logFile = path.resolve(baseDir, options.logFile);
const videosFile = path.resolve(baseDir, options.videosFile);
const detailLogFile = path.resolve(baseDir, options.detailLogFile || 'crawl.log');

async function logDetail(msg) {
  const ts = toWIB();
  await appendFile(detailLogFile, `[${ts}] [DETAIL] ${msg}\n`, 'utf8').catch(() => {});
  if (options.debug) console.log(`[${ts}] [DETAIL] ${msg}`);
}

async function logClean(msg) {
  const ts = toWIB();
  console.log(msg);
  await appendFile(detailLogFile, `[${ts}] [CLEAN] ${msg}\n`, 'utf8').catch(() => {});
}

async function logError(msg) {
  const ts = toWIB();
  console.error(msg);
  await appendFile(detailLogFile, `[${ts}] [ERROR] ${msg}\n`, 'utf8').catch(() => {});
}

const foundUrls = new Set();
let activeCapture = null;
let videosState = null;

main().catch((error) => {
  console.error(`[fatal] ${error.message}`);
  if (options.debug && error.stack) {
    console.error(error.stack);
  }
  process.exitCode = 1;
}).finally(() => {
  setTimeout(() => process.exit(process.exitCode || 0), 500);
});

async function main() {
  await mkdir(profileDir, { recursive: true });
  await mkdir(path.dirname(logFile), { recursive: true });
  await mkdir(path.dirname(videosFile), { recursive: true });

  for (const url of await loadExistingUrls(logFile)) {
    foundUrls.add(url);
  }

  logClean('[start] Huawei HLS capture PoC');
  logDetail(`[info] Course URL: ${options.courseUrl}`);
  logDetail(`[info] Persistent profile: ${profileDir}`);
  logDetail(`[info] URL log: ${logFile}`);
  logDetail(`[info] Videos metadata: ${videosFile}`);
  logDetail(`[info] Debug mode: ${options.debug ? 'on' : 'off'}`);
  logDetail(`[info] Auto lessons: ${options.autoLessons ? 'on' : 'off'}`);

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1366, height: 768 },
    channel: options.channel
  });

  const shutdown = async () => {
    console.log('\n[stop] Closing browser context...');
    await context.close().catch((error) => {
      console.error(`[warn] Failed to close browser cleanly: ${error.message}`);
    });
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  context.on('request', (request) => {
    const requestUrl = request.url();
    if (options.debug) {
      console.log(`[debug][request] ${requestUrl}`);
    }
    void collectIfHlsCandidate({ url: requestUrl, source: 'request' });
  });

  context.on('response', (response) => {
    const responseUrl = response.url();
    const status = response.status();
    const contentType = response.headers()['content-type'] ?? '';

    if (options.debug) {
      console.log(`[debug][response] ${status} ${contentType || '-'} ${responseUrl}`);
    }

    void collectIfHlsCandidate({
      url: responseUrl,
      source: 'response',
      status,
      contentType
    });
  });

  const page = context.pages()[0] ?? await context.newPage();
  page.on('close', () => {
    console.log('\n[info] Browser closed manually. Exiting...');
    process.exit(0);
  });
  page.on('pageerror', (error) => logDetail(`[pageerror] ${error.message}`));
  page.on('crash', () => logDetail('[pageerror] Page crashed'));

  console.log('[action] Opening course page. Login manually if the platform asks for authentication.');
  await page.goto(options.courseUrl, {
    waitUntil: 'domcontentloaded',
    timeout: options.navigationTimeoutMs
  }).catch((error) => {
    console.error(`[warn] Initial navigation did not complete cleanly: ${error.message}`);
    console.error('[warn] Browser remains open so you can continue manually.');
  });

  if (!options.autoLessons && !options.crawlLearningPage && options.waitForEnter) {
    console.log('[pause] If you are not logged in, please log in manually in the Playwright browser.');
    console.log('[pause] Once logged in and the course page is ready, press Enter in the terminal.');
    await waitForEnter();
  } else if (options.crawlLearningPage) {
    logClean('\n=============================================');
    logClean('[pause] Mode --crawl-learning-page active.');
    logClean('[pause] Ensure you are logged in and on the Learning page (with the Sidebar Menu).');
    logClean('[pause] Press Enter in the terminal to start crawling.');
    logClean('=============================================\n');
    await waitForEnter();
  }

  if (options.crawlLearningPage) {
    await crawlLearningPageFlow(page);
    console.log('[done] Crawling learning page finished. Browser remains open for inspection. Press Ctrl+C to stop.');
  } else if (options.autoLessons) {
    await processLessons(page);
    console.log('[done] Auto lesson processing finished. Browser remains open for inspection. Press Ctrl+C to stop.');
  } else {
    console.log('[ready] Monitoring active. Click lesson/video manually in the browser. Press Ctrl+C to stop.');
  }

  await new Promise(() => {});
}

async function waitForEnter() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    await rl.question('Press Enter to start monitoring .m3u8... ');
  } finally {
    rl.close();
  }
}

async function collectIfHlsCandidate(candidate) {
  if (!isHlsCandidate(candidate)) {
    return;
  }

  const normalizedUrl = normalizeUrl(candidate.url);
  const timestamp = toWIB();
  if (foundUrls.has(normalizedUrl)) {
    await attachUrlToActiveLesson({ url: normalizedUrl, timestamp, source: candidate.source, status: candidate.status, contentType: candidate.contentType });
    return;
  }

  foundUrls.add(normalizedUrl);
  const metadata = [
    `source=${candidate.source}`,
    candidate.status ? `status=${candidate.status}` : null,
    candidate.contentType ? `content-type=${candidate.contentType}` : null
  ].filter(Boolean).join(' ');

  try {
    await appendFile(logFile, `[${timestamp}] ${metadata} ${normalizedUrl}\n`, 'utf8');
    await attachUrlToActiveLesson({ url: normalizedUrl, timestamp, source: candidate.source, status: candidate.status, contentType: candidate.contentType });
    console.log(`[hls] ${timestamp} ${normalizedUrl}`);
  } catch (error) {
    foundUrls.delete(normalizedUrl);
    console.error(`[error] Failed to write HLS URL: ${error.message}`);
  }
}

async function attachUrlToActiveLesson({ url, timestamp, source, status, contentType }) {
  if (!activeCapture || !videosState) {
    return;
  }

  let lesson = null;
  if (options.crawlLearningPage) {
    for (const mod of (videosState.modules || [])) {
      lesson = mod.lessons.find((l) => l.lessonId === activeCapture.lessonId);
      if (lesson) break;
    }
  } else {
    lesson = videosState.lessons.find((item) => item.id === activeCapture.lessonId);
  }

  if (!lesson) {
    return;
  }

  if (options.crawlLearningPage) {
    lesson.videos ??= [];
    const streamIndex = lesson.videos.length + 1;
    const existingVideo = lesson.videos.find((v) => v.m3u8Url === url);
    if (existingVideo) return;
    
    lesson.videos.push({
      videoIndex: streamIndex,
      videoTitle: `${lesson.lessonTitle} - Stream ${streamIndex}`,
      m3u8Url: url,
      timestamp,
      source,
      status,
      contentType
    });
    // Let the main flow handle setting status='completed' 
    // to avoid premature completion if we want to wait for more streams.
    lesson.hasVideo = true;
  } else {
    if (lesson.m3u8Urls.includes(url)) return;
    lesson.m3u8Urls.push(url);
    lesson.firstFoundAt ??= timestamp;
    lesson.lastFoundAt = timestamp;
  }

  activeCapture.foundUrls.add(url);
  await saveVideosState();
}

async function processLessons(page) {
  videosState = await loadVideosState();
  console.log('[auto] Waiting for course UI to settle...');
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(options.initialSettleMs);

  console.log('[auto] Discovering lessons from visible UI...');
  const discoveredLessons = await discoverLessons(page);
  mergeDiscoveredLessons(discoveredLessons);
  await saveVideosState();

  console.log(`[auto] Discovered ${videosState.lessons.length} lesson candidates.`);
  if (videosState.lessons.length === 0) {
    console.error('[auto] No lesson candidates found. Try opening/expanding the course content manually, then rerun with --auto-lessons.');
    return;
  }

  for (const lesson of videosState.lessons) {
    if (options.resume && lesson.status === 'completed') {
      console.log(`[skip] Already completed: ${lesson.title}`);
      continue;
    }

    await processLesson(page, lesson);
    await page.waitForTimeout(options.betweenLessonDelayMs);
  }
}

async function processLesson(page, lesson) {
  console.log(`[lesson] ${lesson.title}`);
  lesson.status = 'in_progress';
  lesson.lastTriedAt = toWIB();
  lesson.error = null;
  await saveVideosState();

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    lesson.attempts = (lesson.attempts ?? 0) + 1;
    lesson.lastTriedAt = toWIB();
    await saveVideosState();

    console.log(`[lesson] Attempt ${attempt}/${options.maxAttempts}: ${lesson.title}`);
    activeCapture = {
      lessonId: lesson.id,
      startedAt: Date.now(),
      foundUrls: new Set()
    };

    try {
      const clicked = await clickLesson(page, lesson);
      if (!clicked) {
        throw new Error('Lesson element was not found in current UI.');
      }

      await page.waitForTimeout(options.lessonLoadTimeoutMs);
      await clickVisiblePlayButton(page);
      await waitForCaptureWindow(activeCapture);

      if (lesson.m3u8Urls.length > 0) {
        lesson.status = 'completed';
        lesson.lessonUrl = page.url();
        lesson.completedAt = toWIB();
        lesson.error = null;
        await saveVideosState();
        console.log(`[lesson] Completed with ${lesson.m3u8Urls.length} HLS URL(s): ${lesson.title}`);
        activeCapture = null;
        return;
      }

      lesson.error = 'No HLS URL found during capture window.';
      await saveVideosState();
    } catch (error) {
      lesson.error = error.message;
      console.error(`[warn] Lesson attempt failed: ${lesson.title}: ${error.message}`);
      await saveVideosState();
    } finally {
      activeCapture = null;
    }

    await page.waitForTimeout(options.retryDelayMs);
  }

  lesson.status = lesson.m3u8Urls.length > 0 ? 'completed' : 'no_video_found';
  lesson.lessonUrl = page.url();
  lesson.completedAt = lesson.status === 'completed' ? toWIB() : null;
  await saveVideosState();
  console.log(`[lesson] ${lesson.status}: ${lesson.title}`);
}

async function discoverLessons(page) {
  await expandVisibleSections(page);
  await scrollPageForLazyContent(page);
  await expandVisibleSections(page);

  return page.evaluate(() => {
    const ignoredText = /^(login|log in|logout|search|language|english|share|home|overview|introduction|certificate|exam|test|next|previous|back|close|menu|help|profile)$/i;
    const candidates = [];
    const nodes = Array.from(document.querySelectorAll('a, button, [role="button"], [role="link"], [role="treeitem"], [role="listitem"], [tabindex]'));

    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      const text = cleanText(node.innerText || node.textContent || node.getAttribute('title') || node.getAttribute('aria-label') || '');
      const href = node.href || node.getAttribute('href') || '';

      if (!text || text.length < 3 || text.length > 180) continue;
      if (ignoredText.test(text)) continue;
      if (rect.width < 20 || rect.height < 10) continue;
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
      if (!looksLikeCourseItem(node, text, href)) continue;

      candidates.push({
        title: text,
        href,
        selector: cssPath(node),
        fingerprint: fingerprint(`${text}|${href}`)
      });
    }

    const byFingerprint = new Map();
    for (const item of candidates) {
      if (!byFingerprint.has(item.fingerprint)) {
        byFingerprint.set(item.fingerprint, item);
      }
    }
    return Array.from(byFingerprint.values());

    function cleanText(value) {
      return value.replace(/\s+/g, ' ').trim();
    }

    function looksLikeCourseItem(node, text, href) {
      const lower = `${text} ${href} ${node.getAttribute('class') || ''} ${node.getAttribute('role') || ''}`.toLowerCase();
      if (/lesson|course|chapter|section|module|unit|video|play|learn|content|sxz-course/.test(lower)) return true;
      if (/^\d+[.)\s-]/.test(text)) return true;
      if (/\b(\d{1,2}:\d{2}|\d+\s*(min|mins|minute|minutes))\b/i.test(text)) return true;
      if (href.includes('#/') && !/home$|learning$/.test(href)) return true;
      return node.closest('[aria-expanded], [role="tree"], [role="list"], aside, nav, main, section') !== null && text.length >= 8;
    }

    function cssPath(element) {
      const parts = [];
      let current = element;
      while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
        const tag = current.tagName.toLowerCase();
        const parent = current.parentElement;
        if (!parent) {
          parts.unshift(tag);
          break;
        }
        const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        const index = siblings.indexOf(current) + 1;
        parts.unshift(`${tag}:nth-of-type(${index})`);
        current = parent;
      }
      return parts.join(' > ');
    }

    function fingerprint(value) {
      let hash = 0;
      for (let index = 0; index < value.length; index += 1) {
        hash = Math.imul(31, hash) + value.charCodeAt(index) | 0;
      }
      return `lesson-${Math.abs(hash)}`;
    }
  });
}

async function expandVisibleSections(page) {
  for (let round = 0; round < 3; round += 1) {
    const expanded = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('[aria-expanded="false"]'));
      let count = 0;
      for (const node of nodes.slice(0, 40)) {
        const rect = node.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 10) continue;
        node.scrollIntoView({ block: 'center', inline: 'nearest' });
        node.click();
        count += 1;
      }
      return count;
    });
    if (expanded === 0) return;
    await page.waitForTimeout(800);
  }
}

async function scrollPageForLazyContent(page) {
  let previousHeight = 0;
  for (let index = 0; index < options.discoveryScrolls; index += 1) {
    const height = await page.evaluate(() => {
      window.scrollBy(0, Math.max(window.innerHeight * 0.8, 600));
      for (const element of Array.from(document.querySelectorAll('aside, nav, main, section, [role="tree"], [role="list"]'))) {
        if (element.scrollHeight > element.clientHeight + 50) {
          element.scrollTop += Math.max(element.clientHeight * 0.8, 300);
        }
      }
      return document.documentElement.scrollHeight;
    });
    await page.waitForTimeout(700);
    if (height === previousHeight && index > 2) break;
    previousHeight = height;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function clickLesson(page, lesson) {
  const selectors = [
    lesson.selector,
    `a:has-text("${escapeForSelectorText(lesson.title)}")`,
    `button:has-text("${escapeForSelectorText(lesson.title)}")`,
    `[role="button"]:has-text("${escapeForSelectorText(lesson.title)}")`,
    `[role="treeitem"]:has-text("${escapeForSelectorText(lesson.title)}")`,
    `[role="listitem"]:has-text("${escapeForSelectorText(lesson.title)}")`
  ].filter(Boolean);

  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.count() === 0 || !await locator.isVisible()) continue;
      await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
      await locator.click({ timeout: 10000 });
      return true;
    } catch (error) {
      if (options.debug) console.error(`[debug] Click selector failed: ${selector}: ${error.message}`);
    }
  }

  return false;
}

async function clickVisiblePlayButton(page) {
  const selectors = [
    'button:has-text("Play")',
    '[role="button"]:has-text("Play")',
    'button[aria-label*="play" i]',
    '[role="button"][aria-label*="play" i]',
    '.vjs-big-play-button',
    '.plyr__control--overlaid'
  ];

  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.count() === 0 || !await locator.isVisible()) continue;
      await locator.click({ timeout: 3000 });
      console.log('[lesson] Clicked visible play button.');
      return true;
    } catch {
      // Best-effort only. Some players autoplay or use custom controls.
    }
  }
  return false;
}

async function waitForCaptureWindow(capture) {
  const deadline = Date.now() + options.captureWindowMs;
  while (Date.now() < deadline) {
    if (capture.foundUrls.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.afterFirstHitGraceMs));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function mergeDiscoveredLessons(discoveredLessons) {
  const existingById = new Map(videosState.lessons.map((lesson) => [lesson.id, lesson]));

  for (const discovered of discoveredLessons) {
    const existing = existingById.get(discovered.fingerprint);
    if (existing) {
      existing.title = discovered.title;
      existing.selector = discovered.selector;
      existing.discoveredHref = discovered.href || existing.discoveredHref || '';
      continue;
    }

    videosState.lessons.push({
      id: discovered.fingerprint,
      title: discovered.title,
      lessonUrl: discovered.href || '',
      discoveredHref: discovered.href || '',
      selector: discovered.selector,
      status: 'pending',
      attempts: 0,
      m3u8Urls: [],
      firstFoundAt: null,
      lastFoundAt: null,
      lastTriedAt: null,
      completedAt: null,
      error: null
    });
  }
}

async function loadVideosState() {
  if (!options.resume) {
    return createEmptyVideosState();
  }

  try {
    const parsed = JSON.parse(await readFile(videosFile, 'utf8'));
    parsed.courseUrl = options.courseUrl;
    if (options.crawlLearningPage) {
      parsed.modules ??= [];
      for (const mod of parsed.modules) {
        mod.lessons ??= [];
        for (const lesson of mod.lessons) {
          if (lesson.status === 'error') lesson.status = 'failed';
          lesson.videos ??= [];
          for (const video of lesson.videos) {
            foundUrls.add(video.m3u8Url);
          }
        }
      }
    } else {
      parsed.lessons ??= [];
      for (const lesson of parsed.lessons) {
        lesson.m3u8Urls ??= [];
        for (const url of lesson.m3u8Urls) {
          foundUrls.add(url);
        }
      }
    }
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return createEmptyVideosState();
    }
    throw error;
  }
}

function createEmptyVideosState() {
  const state = {
    courseUrl: options.courseUrl,
    createdAt: toWIB(),
    updatedAt: toWIB()
  };
  if (options.crawlLearningPage) {
    state.modules = [];
  } else {
    state.lessons = [];
  }
  return state;
}

async function saveVideosState() {
  if (!videosState) return;
  videosState.updatedAt = toWIB();
  await writeFile(videosFile, `${JSON.stringify(videosState, null, 2)}\n`, 'utf8');
}

function isHlsCandidate({ url, contentType = '' }) {
  const lowerUrl = url.toLowerCase();
  const lowerContentType = contentType.toLowerCase();

  return lowerUrl.includes('.m3u8')
    || HLS_CONTENT_TYPES.some((type) => lowerContentType.includes(type));
}

function normalizeUrl(url) {
  return url.trim();
}

function escapeForSelectorText(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function loadExistingUrls(filePath) {
  try {
    const content = await readFile(filePath, 'utf8');
    return content.split(/\r?\n/)
      .map(line => line.trim())
      .filter(l => l && !l.startsWith('====='))
      .map(line => {
        // urls.log format: [timestamp] metadata URL
        const match = line.match(/https?:\/\/\S+/);
        return match ? match[0] : line;
      })
      .filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function parseArgs(args) {
  const parsed = {
    courseUrl: process.env.COURSE_URL || DEFAULT_COURSE_URL,
    debug: process.env.DEBUG_HLS_CAPTURE === '1' || process.env.DEBUG_HLS_CAPTURE === 'true',
    profileDir: process.env.PROFILE_DIR || 'playwright-profile',
    logFile: process.env.LOG_FILE || 'urls.log',
    videosFile: process.env.VIDEOS_FILE || 'videos.json',
    autoLessons: process.env.AUTO_LESSONS === '1' || process.env.AUTO_LESSONS === 'true',
    crawlLearningPage: process.env.CRAWL_LEARNING_PAGE === '1' || process.env.CRAWL_LEARNING_PAGE === 'true',
    waitForEnter: process.env.WAIT_FOR_ENTER !== '0' && process.env.WAIT_FOR_ENTER !== 'false',
    resume: process.env.RESUME_CAPTURE !== '0' && process.env.RESUME_CAPTURE !== 'false',
    retryNoVideo: process.env.RETRY_NO_VIDEO === '1' || process.env.RETRY_NO_VIDEO === 'true',
    maxAttempts: Number(process.env.MAX_ATTEMPTS || 3),
    initialSettleMs: Number(process.env.INITIAL_SETTLE_MS || 5000),
    lessonLoadTimeoutMs: Number(process.env.LESSON_LOAD_TIMEOUT_MS || 5000),
    captureWindowMs: Number(process.env.CAPTURE_WINDOW_MS || 20000),
    afterFirstHitGraceMs: Number(process.env.AFTER_FIRST_HIT_GRACE_MS || 5000),
    betweenLessonDelayMs: Number(process.env.BETWEEN_LESSON_DELAY_MS || 1500),
    retryDelayMs: Number(process.env.RETRY_DELAY_MS || 1500),
    discoveryScrolls: Number(process.env.DISCOVERY_SCROLLS || 8),
    navigationTimeoutMs: Number(process.env.NAVIGATION_TIMEOUT_MS || 60000),
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === '--debug') {
      parsed.debug = true;
    } else if (arg === '--crawl-learning-page') {
      parsed.crawlLearningPage = true;
    } else if (arg === '--auto-lessons') {
      parsed.autoLessons = true;
    } else if (arg === '--no-wait') {
      parsed.waitForEnter = false;
    } else if (arg === '--no-resume') {
      parsed.resume = false;
    } else if (arg === '--resume') {
      parsed.resume = true;
    } else if (arg === '--retry-no-video') {
      parsed.retryNoVideo = true;
    } else if (arg === '--url' && next) {
      parsed.courseUrl = next;
      index += 1;
    } else if (arg.startsWith('--url=')) {
      parsed.courseUrl = arg.slice('--url='.length);
    } else if (arg === '--profile-dir' && next) {
      parsed.profileDir = next;
      index += 1;
    } else if (arg.startsWith('--profile-dir=')) {
      parsed.profileDir = arg.slice('--profile-dir='.length);
    } else if (arg === '--videos-file' && next) {
      parsed.videosFile = next;
      index += 1;
    } else if (arg.startsWith('--videos-file=')) {
      parsed.videosFile = arg.slice('--videos-file='.length);
    } else if (arg === '--log-file' && next) {
      parsed.logFile = next;
      index += 1;
    } else if (arg.startsWith('--log-file=')) {
      parsed.logFile = arg.slice('--log-file='.length);
    } else if (arg === '--after-first-hit-grace-ms' && next) {
      parsed.afterFirstHitGraceMs = Number(next);
      index += 1;
    } else if (arg.startsWith('--after-first-hit-grace-ms=')) {
      parsed.afterFirstHitGraceMs = Number(arg.slice('--after-first-hit-grace-ms='.length));
    } else if (arg === '--channel' && next) {
      parsed.channel = next;
      index += 1;
    } else if (arg.startsWith('--channel=')) {
      parsed.channel = arg.slice('--channel='.length);
    } else if (arg === '--max-attempts' && next) {
      parsed.maxAttempts = Number(next);
      index += 1;
    } else if (arg.startsWith('--max-attempts=')) {
      parsed.maxAttempts = Number(arg.slice('--max-attempts='.length));
    } else if (arg === '--capture-window-ms' && next) {
      parsed.captureWindowMs = Number(next);
      index += 1;
    } else if (arg.startsWith('--capture-window-ms=')) {
      parsed.captureWindowMs = Number(arg.slice('--capture-window-ms='.length));
    } else if (arg === '--lesson-load-timeout-ms' && next) {
      parsed.lessonLoadTimeoutMs = Number(next);
      index += 1;
    } else if (arg.startsWith('--lesson-load-timeout-ms=')) {
      parsed.lessonLoadTimeoutMs = Number(arg.slice('--lesson-load-timeout-ms='.length));
    } else if (arg === '--help' || arg === '-h') {
      printHelpAndExit();
    } else {
      console.error(`[error] Unknown or incomplete argument: ${arg}`);
      printHelpAndExit(1);
    }
  }

  for (const key of ['navigationTimeoutMs', 'maxAttempts', 'initialSettleMs', 'lessonLoadTimeoutMs', 'captureWindowMs', 'afterFirstHitGraceMs', 'betweenLessonDelayMs', 'retryDelayMs', 'discoveryScrolls']) {
    if (!Number.isFinite(parsed[key]) || parsed[key] <= 0) {
      throw new Error(`${key} must be a positive number.`);
    }
  }

  return parsed;
}

function printHelpAndExit(exitCode = 0) {
  console.log(`Usage:
  npm run crawl -- --url <course-url>
  npm start -- --url <course-url>
  npm run start:debug -- --url <course-url>
  npm start -- --url <course-url> --auto-lessons

Options:
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

Environment Variables:
  COURSE_URL, DEBUG_HLS_CAPTURE, PROFILE_DIR, LOG_FILE, VIDEOS_FILE,
  AUTO_LESSONS, CRAWL_LEARNING_PAGE, WAIT_FOR_ENTER, RESUME_CAPTURE, RETRY_NO_VIDEO,
  MAX_ATTEMPTS, INITIAL_SETTLE_MS, LESSON_LOAD_TIMEOUT_MS, CAPTURE_WINDOW_MS, AFTER_FIRST_HIT_GRACE_MS,
  BETWEEN_LESSON_DELAY_MS, RETRY_DELAY_MS, DISCOVERY_SCROLLS, NAVIGATION_TIMEOUT_MS, PLAYWRIGHT_CHANNEL
`);
  process.exit(exitCode);
}

// --- New Crawl Learning Page Logic ---

async function crawlLearningPageFlow(page) {
  logClean('\n============================= START CRAWL SESSION =============================');
  await appendFile(logFile, `\n===== START SESSION [${toWIB()}] =====\n`, 'utf8').catch(() => {});
  videosState = await loadVideosState();
  logDetail('[crawl] Waiting for course UI to settle...');
  await page.waitForTimeout(options.initialSettleMs);

  logClean('[crawl] Expanding all Modules/Sections in sidebar...');
  const sidebarExists = await expandSidebarItems(page);
  if (!sidebarExists) {
    logError('[crawl] Failed to find sidebar. Ensure you are on the course material page.');
    logClean('\n============================== END CRAWL SESSION ==============================\n');
    return;
  }

  logDetail('[crawl] Building hierarchy from sidebar...');
  const modules = await buildSidebarHierarchy(page);
  videosState.modules = modules;
  await saveVideosState();

  const totalLessons = modules.reduce((sum, m) => sum + m.lessons.length, 0);
  logClean(`[crawl] Successfully found ${videosState.modules.length} Modules with a total of ${totalLessons} lessons.`);
  logClean('\n--- CRAWLING STARTED ---');
  
  if (totalLessons === 0) {
    console.error('[crawl] No lessons found in the sidebar. Please verify the UI state.');
    logClean('\n============================== END CRAWL SESSION ==============================\n');
    return;
  }

  await processHierarchicalLessons(page);
  await appendFile(logFile, `===== END SESSION [${toWIB()}] =====\n`, 'utf8').catch(() => {});
  logClean('\n============================== END CRAWL SESSION ==============================\n');
}

async function expandSidebarItems(page) {
  // First check if the content is inside an iframe
  let targetFrame = page.mainFrame();
  for (const frame of page.frames()) {
    try {
      const menuCount = await frame.locator('text=/Menu/i').count();
      if (menuCount > 0) {
        targetFrame = frame;
        break;
      }
    } catch(e) {}
  }

  // Iterate to expand everything
  let expandedCount = 0;
  for (let round = 0; round < 10; round++) {
    const newlyExpanded = await targetFrame.evaluate(() => {
      let count = 0;
      window._clickedExpanders = window._clickedExpanders || new Set();
      
      const getSidebar = () => {
         const trees = document.querySelectorAll('[role="tree"], ul.el-menu, .sidebar, aside, .menu, .left-menu');
         for (const t of trees) {
             if (/Course Introduction/i.test(t.textContent) || /WLAN/i.test(t.textContent)) return t;
         }
         const all = document.querySelectorAll('*');
         for (const n of all) {
             const txt = n.textContent.trim();
             if (txt.length < 100 && (/Course Introduction/i.test(txt) || /^\d+\.?\s/i.test(txt))) {
                 const container = n.closest('ul, [role="tree"], .sidebar, aside, .menu, .left-menu');
                 if (container) return container;
                 let p = n;
                 for (let i = 0; i < 4; i++) { if (p.parentElement) p = p.parentElement; }
                 return p;
             }
         }
         return null;
      };
      
      const sidebar = getSidebar();
      if (!sidebar) return false;
      const nodes = Array.from(sidebar.querySelectorAll('[aria-expanded="false"], i[class*="arrow"], i[class*="caret"], .expand-icon, [class*="expand"]'));
      
      for (const node of nodes) {
        if (window._clickedExpanders.has(node)) continue;
        
        const treeNode = node.closest('.tree-node, [role="treeitem"], li');
        if (treeNode && (treeNode.classList.contains('is-expanded') || treeNode.classList.contains('expanded') || treeNode.getAttribute('aria-expanded') === 'true')) continue;
        
        if (node.closest('header, .header, .nav-bar, .top-bar, .global-nav')) continue;
        
        const rect = node.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          node.scrollIntoView({ block: 'center' });
          node.click();
          window._clickedExpanders.add(node);
          count++;
        }
      }
      return count;
    });

    if (newlyExpanded === false) return false;
    if (newlyExpanded === 0) break;
    expandedCount += newlyExpanded;
    await page.waitForTimeout(1500);
  }
  
  logClean(`[crawl] Expanded ${expandedCount} items in sidebar.`);
  return true;
}

async function buildSidebarHierarchy(page) {
  let targetFrame = page.mainFrame();
  for (const frame of page.frames()) {
    try {
      if (await frame.locator('text=/Menu/i').count() > 0) {
        targetFrame = frame;
        break;
      }
    } catch(e) {}
  }

  return await targetFrame.evaluate(() => {
    const getSidebar = () => {
         const trees = document.querySelectorAll('[role="tree"], ul.el-menu, .sidebar, aside, .menu, .left-menu');
         for (const t of trees) {
             if (/Course Introduction/i.test(t.textContent) || /WLAN/i.test(t.textContent)) return t;
         }
         const all = document.querySelectorAll('*');
         for (const n of all) {
             const txt = n.textContent.trim();
             if (txt.length < 100 && (/Course Introduction/i.test(txt) || /^\d+\.?\s/i.test(txt))) {
                 const container = n.closest('ul, [role="tree"], .sidebar, aside, .menu, .left-menu');
                 if (container) return container;
                 let p = n;
                 for (let i = 0; i < 4; i++) { if (p.parentElement) p = p.parentElement; }
                 return p;
             }
         }
         return null;
    };
    
    const sidebar = getSidebar();
    if (!sidebar) return [];
    const modules = [];
    const nodes = Array.from(sidebar.querySelectorAll('[role="treeitem"], li, .el-menu-item, .el-submenu__title, .tree-node'));
    let currentModule = null;

    const blocklist = ['English', 'Français', 'العربية', 'Español', 'Português', 'Italiano', 'Deutsch', 'Türk', 'Русский', '日本語', 'ไทย', 'Bahasa malaysia', 'Indonesia', 'Filipino', 'اردو', 'Қазақша', 'Polski', 'Nederlands', 'Original'];

    const cleanText = (el) => {
        const titleEl = el.querySelector('p.text, .el-tree-node__label, span[title]');
        if (titleEl && titleEl.getAttribute('title')) return titleEl.getAttribute('title').trim();
        if (titleEl) return titleEl.textContent.replace(/\s+/g, ' ').trim();
        
        let directText = '';
        for (const child of (el.querySelector('.tree-node-content, .el-submenu__title') || el).childNodes) {
            if (child.nodeType === 3) directText += child.textContent;
        }
        if (directText.trim()) return directText.replace(/\s+/g, ' ').trim();
        return el.textContent.replace(/\s+/g, ' ').trim();
    };

    for (const node of nodes) {
       const text = cleanText(node);
       if (!text || text.length < 3 || text.length > 80) continue; 
       if (blocklist.includes(text)) continue;

       const isLevel1 = /^\d+\.?\s+[a-zA-Z]/i.test(text) || /^Course Introduction/i.test(text) || /^Final Exam/i.test(text) || /^Training Materials/i.test(text) || /^Quiz$/i.test(text);
       const isLevel2 = /^\d+\.\d+\s+/i.test(text) || /^Introduction to/i.test(text) || /^HCIA-/i.test(text);
       
       const contentWrapper = node.querySelector(':scope > .tree-node-content, :scope > .el-submenu__title') || node;
       const htmlContent = contentWrapper.innerHTML.toLowerCase();
       const hasPlayIcon = contentWrapper.querySelector('i[class*="play"], i[class*="video"], svg path[d*="M8 5v14l11-7z"]') !== null || htmlContent.includes('#icon-catalog-video') || htmlContent.includes('video');
       const hasDocIcon = contentWrapper.querySelector('i[class*="document"], i[class*="file"], i[class*="text"]') !== null || htmlContent.includes('#icon-catalog-document') || htmlContent.includes('document');
       
       // Detect if it's a leaf node. If it has no submenu/children, it's a leaf.
       const hasChildren = node.querySelector(':scope > ul, :scope > .el-menu, :scope > [role="group"], :scope > .tree-node-children') !== null || node.getAttribute('aria-expanded') !== null;
       const isLeaf = !hasChildren || hasPlayIcon || hasDocIcon;

       if (isLevel1 && !isLeaf) {
         if (!currentModule || currentModule.moduleTitle !== text) {
             currentModule = {
               moduleIndex: text.split('.')[0] || `M${modules.length+1}`,
               moduleTitle: text,
               lessons: []
             };
             modules.push(currentModule);
         }
       } else if (isLeaf) {
         if (!currentModule) {
           currentModule = { moduleIndex: '0', moduleTitle: 'Uncategorized', lessons: [] };
           modules.push(currentModule);
         }
         
         const lastLesson = currentModule.lessons[currentModule.lessons.length - 1];
         if (!lastLesson || lastLesson.lessonTitle !== text) {
             // Generate a stable ID based on module, lesson title, and length
             let hash = 0;
             const fText = `${currentModule.moduleTitle}|${text}|${currentModule.lessons.length}`;
             for (let i = 0; i < fText.length; i++) { hash = Math.imul(31, hash) + fText.charCodeAt(i) | 0; }
             const fingerprint = `lesson-${Math.abs(hash)}`;
             
             // To get the exact selector
             const parts = [];
             let current = node;
             while (current && current.tagName !== 'BODY' && parts.length < 5) {
               const tag = current.tagName.toLowerCase();
               if (current.id) {
                 parts.unshift(`#${current.id}`);
                 break;
               }
               let cl = current.getAttribute('class');
               if (cl) {
                 cl = cl.split(' ').find(c => c && !c.includes(':'));
                 if (cl) parts.unshift(`${tag}.${cl}`);
                 else parts.unshift(tag);
               } else {
                 parts.unshift(tag);
               }
               current = current.parentElement;
             }

             currentModule.lessons.push({
               lessonIndex: text.split(' ')[0] || `L${currentModule.lessons.length+1}`,
               lessonTitle: text,
               selector: parts.join(' > '),
               fingerprint,
               textToMatch: text
             });
         }
       }
    }
    return modules;
  });
}

function mergeHierarchicalModules(discoveredModules) {
  // Merge into videosState.modules
  for (const discMod of discoveredModules) {
    let stateMod = videosState.modules.find(m => m.moduleTitle === discMod.moduleTitle);
    if (!stateMod) {
      stateMod = {
        moduleIndex: discMod.moduleIndex,
        moduleTitle: discMod.moduleTitle,
        lessons: []
      };
      videosState.modules.push(stateMod);
    }

    for (const discLes of discMod.lessons) {
      let stateLes = stateMod.lessons.find(l => l.lessonId === discLes.fingerprint);
      if (!stateLes) {
        stateMod.lessons.push({
          lessonId: discLes.fingerprint,
          lessonIndex: discLes.lessonIndex,
          lessonTitle: discLes.lessonTitle,
          textToMatch: discLes.textToMatch,
          selector: discLes.selector,
          status: 'pending',
          hasVideo: false,
          lessonUrl: '',
          attempts: 0,
          videos: [],
          error: null
        });
      } else {
        // Update selectors in case DOM changed
        stateLes.selector = discLes.selector;
        stateLes.textToMatch = discLes.textToMatch;
      }
    }
  }
}

async function processHierarchicalLessons(page) {
  for (const module of videosState.modules) {
    logClean(`\n[BAB] ${module.moduleTitle}`);
    for (const lesson of module.lessons) {
      if (options.resume && (lesson.status === 'completed' || (lesson.status === 'no_video' && !options.retryNoVideo))) {
        logClean(`  [-] ${lesson.lessonTitle} -> (Skipped, already ${lesson.status})`);
        logDetail(`Skipped ${lesson.lessonTitle} because status is ${lesson.status}`);
        continue;
      }

      await processHierarchicalLesson(page, lesson);
      await page.waitForTimeout(options.betweenLessonDelayMs);
    }
  }
}

async function processHierarchicalLesson(page, lesson) {
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    lesson.status = 'in_progress';
    lesson.error = null;
    lesson.attempts = attempt;
    await saveVideosState();

    try {
      // Set activeCapture BEFORE clicking so network interceptor catches m3u8 during page load
      activeCapture = {
        lessonId: lesson.lessonId,
        videoIndex: 1,
        startedAt: Date.now(),
        foundUrls: new Set()
      };

      // Re-expand sidebar because Huawei collapses other BABs/sub-BABs after each click
      await expandSidebarItems(page);

      const clicked = await clickSidebarLesson(page, lesson);
      if (!clicked) {
        throw new Error('Lesson element not found in sidebar.');
      }

      // Wait for page to load (video player will auto-load and trigger m3u8 request)
      await page.waitForTimeout(options.lessonLoadTimeoutMs);
      
      // Give extra time for network interceptor to catch m3u8
      await waitForCaptureWindow(activeCapture);
      
      lesson.lessonUrl = page.url();

      if (activeCapture.foundUrls.size > 0) {
        lesson.status = 'completed';
        lesson.hasVideo = true;
        logClean(`  [-] ${lesson.lessonTitle} -> [OK] m3u8 captured (${activeCapture.foundUrls.size} URLs)`);
      } else {
        lesson.status = 'no_video';
        lesson.hasVideo = false;
        logClean(`  [-] ${lesson.lessonTitle} -> No video (Text/Quiz)`);
      }
      
    } catch (error) {
      lesson.error = error.message;
      lesson.status = 'failed';
      logError(`  [-] ${lesson.lessonTitle} -> [ERROR] ${error.message}`);
    } finally {
      activeCapture = null;
      await saveVideosState();
    }

    if (lesson.status === 'completed') {
      break; // Success
    }

    if (attempt < options.maxAttempts) {
      logDetail(`[lesson] Retrying ${lesson.lessonTitle} in ${options.retryDelayMs}ms... (Attempt ${attempt + 1}/${options.maxAttempts})`);
      await page.waitForTimeout(options.retryDelayMs);
    } else {
      if (lesson.status === 'no_video') {
        logClean(`  [-] ${lesson.lessonTitle} -> [FINISH] Still no video (Text/Quiz) after ${options.maxAttempts} attempts.`);
      } else {
        logClean(`  [-] ${lesson.lessonTitle} -> [FAIL] Failed to process after ${options.maxAttempts} attempts.`);
      }
    }
  }
}

async function clickSidebarLesson(page, lesson) {
  let targetFrame = page.mainFrame();
  for (const frame of page.frames()) {
    try {
      if (await frame.locator('text=/Menu/i').count() > 0) {
        targetFrame = frame;
        break;
      }
    } catch(e) {}
  }

  // First try the strict selector, filtering for visible
  try {
    const loc = targetFrame.locator(lesson.selector).locator('visible=true').first();
    if (await loc.count() > 0) {
      await loc.scrollIntoViewIfNeeded();
      await loc.click({ timeout: 5000 });
      return true;
    }
  } catch (e) {}

  // Fallback: match text exactly within sidebar, ONLY visible elements
  const safeText = escapeForSelectorText(lesson.textToMatch);
  
  try {
    // 1. Try exact text match in frame
    const exactLocs = targetFrame.getByText(lesson.textToMatch, { exact: true }).locator('visible=true');
    const exactCount = await exactLocs.count();
    if (exactCount > 0) {
      const target = exactLocs.nth(exactCount - 1); // Get the last one
      await target.scrollIntoViewIfNeeded();
      await target.click({ timeout: 5000 });
      return true;
    }
  } catch (e) {}

  try {
    // 2. Try partial text match in frame
    const partialLocs = targetFrame.getByText(lesson.textToMatch).locator('visible=true');
    const partialCount = await partialLocs.count();
    if (partialCount > 0) {
      const target = partialLocs.nth(partialCount - 1); // Get the last one
      await target.scrollIntoViewIfNeeded();
      await target.click({ timeout: 5000 });
      return true;
    }
  } catch (e) {}

  return false;
}

async function countVideosInMainArea(page) {
  return await page.evaluate(async () => {
    // Look strictly in main content area
    const main = document.querySelector('main, .content, .course-content, .el-main') || document.body;
    
    // Scroll down to trigger lazy loading
    let scrollAttempts = 0;
    return new Promise(resolve => {
      const interval = setInterval(() => {
        if (main !== document.body) {
          main.scrollTop += 800;
        }
        window.scrollBy(0, 800);
        scrollAttempts++;
        if (scrollAttempts > 5) {
          clearInterval(interval);
          setTimeout(() => {
            const players = main.querySelectorAll('video, iframe, .vjs-big-play-button, .plyr, [data-vjs-player]');
            // Filter out hidden ones
            let count = 0;
            for (const p of players) {
              const rect = p.getBoundingClientRect();
              if (rect.width > 20 && rect.height > 20 && window.getComputedStyle(p).display !== 'none') {
                 // simple dedup: if it's a video inside a .plyr, don't double count
                 if (p.tagName.toLowerCase() === 'video' && p.closest('.plyr, [data-vjs-player]')) continue;
                 count++;
              }
            }
            resolve(count);
          }, 500);
        }
      }, 400);
    });
  });
}

async function playVideoInMainArea(page, videoIndex) {
  // In playwright, we can find the nth video player and click it
  const playSelectors = [
    'main button:has-text("Play")',
    'main .vjs-big-play-button',
    'main .plyr__control--overlaid',
    '.content .vjs-big-play-button',
    'main video',
    '.content video'
  ];

  for (const sel of playSelectors) {
    try {
      const locators = page.locator(sel);
      const count = await locators.count();
      if (count >= videoIndex) {
        const target = locators.nth(videoIndex - 1);
        if (await target.isVisible()) {
          await target.scrollIntoViewIfNeeded();
          await target.click({ timeout: 3000 });
          return true;
        }
      }
    } catch (e) {}
  }
  return false;
}
