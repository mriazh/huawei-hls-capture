import { chromium } from 'playwright';
import { appendFile, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';

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

process.on('exit', () => {
  if (videosState) {
    try {
      videosState.updatedAt = toWIB();
      writeFileSync(videosFile, `${JSON.stringify(videosState, null, 2)}\n`, 'utf8');
    } catch (e) {}
  }
});

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

  const isExplicitConvert = options.convert;
  const isExplicitCrawl = options.crawlLearningPage || options.autoLessons || process.argv.slice(2).some(arg => arg.startsWith('--url'));

  if (isExplicitConvert) {
    await convertVideosFromState({ returnToMenu: false });
    return;
  }

  if (isExplicitCrawl) {
    await runCrawlWorkflow();
    if (options.autoConvert) {
      await convertVideosFromState({ returnToMenu: false });
    } else if (options.askConvert) {
      await promptConversionAfterCrawl({ returnToMenu: false });
    }
    return;
  }

  // No explicit mode flags -> interactive menu
  await showMainMenu();
}

async function runCrawlWorkflow() {
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
    console.log('[done] Crawling learning page finished.');
  } else if (options.autoLessons) {
    await processLessons(page);
    console.log('[done] Auto lesson processing finished.');
  } else {
    console.log('[ready] Monitoring active. Click lesson/video manually in the browser. Press Ctrl+C to stop.');
    await new Promise(() => {}); // hang forever if manual
  }

  if (!options.askConvert) {
     console.log('[info] Browser remains open for inspection. Press Ctrl+C to stop.');
     await new Promise(() => {});
  } else {
     await context.close().catch(() => {});
  }
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

function getLessonKey(lesson) {
  return lesson.lessonId || lesson.fingerprint || lesson.id;
}

function normalizeHierarchicalLessonIds(modules) {
  for (const mod of modules || []) {
    for (const lesson of mod.lessons || []) {
      lesson.lessonId ??= lesson.fingerprint || lesson.id;
    }
  }
}

function normalizeLessonVideoTitles(lesson) {
  lesson.videos ??= [];
  if (lesson.videos.length === 1) {
    lesson.videos[0].videoTitle = lesson.lessonTitle;
  } else if (lesson.videos.length > 1) {
    lesson.videos.forEach((video, index) => {
      video.videoTitle = `${lesson.lessonTitle} - Part ${index + 1}`;
    });
  }
}

async function attachUrlToActiveLesson({ url, timestamp, source, status, contentType }) {
  if (!activeCapture || !videosState) {
    return;
  }

  let lesson = null;
  if (options.crawlLearningPage) {
    for (const mod of (videosState.modules || [])) {
      lesson = mod.lessons.find((l) => getLessonKey(l) === activeCapture.lessonId);
      if (lesson) break;
    }
  } else {
    lesson = videosState.lessons.find((item) => getLessonKey(item) === activeCapture.lessonId);
  }

  if (!lesson) {
    return;
  }

  if (options.crawlLearningPage) {
    lesson.videos ??= [];
    const streamIndex = lesson.videos.length + 1;
    const existingVideo = lesson.videos.find((v) => v.m3u8Url === url);
    if (existingVideo) return;

    if (options.maxStreamsPerLesson > 0 && lesson.videos.length >= options.maxStreamsPerLesson) {
      logDetail(`[capture] Ignoring extra HLS URL for ${lesson.lessonTitle}; max streams per lesson reached (${options.maxStreamsPerLesson}).`);
      return;
    }
    
    lesson.videos.push({
      videoIndex: streamIndex,
      videoTitle: lesson.lessonTitle,
      m3u8Url: url,
      timestamp,
      source,
      status,
      contentType
    });

    normalizeLessonVideoTitles(lesson);
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
  const start = Date.now();
  let firstHitAt = null;
  let lastHitCount = 0;
  let lastHitAt = null;

  while (Date.now() - start < options.captureWindowMs) {
    const count = capture.foundUrls.size;

    if (count > 0 && !firstHitAt) {
      firstHitAt = Date.now();
      lastHitAt = firstHitAt;
      lastHitCount = count;
    }

    if (count > lastHitCount) {
      lastHitAt = Date.now();
      lastHitCount = count;
    }

    if (options.maxStreamsPerLesson > 0 && count >= options.maxStreamsPerLesson) {
      return;
    }

    if (firstHitAt && Date.now() - lastHitAt >= options.afterFirstHitGraceMs) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
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
    if (parsed.modules) {
      for (const mod of parsed.modules) {
        mod.lessons ??= [];
        for (const lesson of mod.lessons) {
          if (lesson.status === 'error' || lesson.status === 'in_progress') lesson.status = 'failed';
          lesson.videos ??= [];
          for (const video of lesson.videos) {
            foundUrls.add(video.m3u8Url);
            if (video.download && video.download.status === 'in_progress') {
              video.download.status = 'failed';
              video.download.error = 'Process crashed/exited during download';
            }
          }
        }
      }
    } else if (parsed.lessons) {
      for (const lesson of parsed.lessons) {
        if (lesson.status === 'error' || lesson.status === 'in_progress') lesson.status = 'failed';
        if (lesson.download && lesson.download.status === 'in_progress') {
          lesson.download.status = 'failed';
          lesson.download.error = 'Process crashed/exited during download';
        }
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
    maxStreamsPerLesson: Number(process.env.MAX_STREAMS_PER_LESSON || 0),
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
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    convert: false,
    askConvert: false,
    downloadsDir: process.env.DOWNLOADS_DIR || 'downloads',
    ytDlpPath: process.env.YT_DLP_PATH || 'yt-dlp',
    ffmpegLocation: process.env.FFMPEG_LOCATION || undefined,
    downloadConcurrency: Number(process.env.DOWNLOAD_CONCURRENCY || 1),
    downloadTimeoutMs: Number(process.env.DOWNLOAD_TIMEOUT_MS || 0),
    retryFailedDownloads: process.env.RETRY_FAILED_DOWNLOADS === '1' || process.env.RETRY_FAILED_DOWNLOADS === 'true',
    forceDownload: process.env.FORCE_DOWNLOAD === '1' || process.env.FORCE_DOWNLOAD === 'true',
    autoConvert: process.env.AUTO_CONVERT === '1' || process.env.AUTO_CONVERT === 'true',
    downloadLimit: Number(process.env.DOWNLOAD_LIMIT || 0)
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
    } else if (arg === '--max-streams-per-lesson' && next) {
      parsed.maxStreamsPerLesson = Number(next);
      index += 1;
    } else if (arg.startsWith('--max-streams-per-lesson=')) {
      parsed.maxStreamsPerLesson = Number(arg.slice('--max-streams-per-lesson='.length));
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
    } else if (arg === '--convert') {
      parsed.convert = true;
    } else if (arg === '--ask-convert') {
      parsed.askConvert = true;
    } else if (arg === '--auto-convert') {
      parsed.autoConvert = true;
    } else if (arg === '--retry-failed-downloads') {
      parsed.retryFailedDownloads = true;
    } else if (arg === '--force-download') {
      parsed.forceDownload = true;
    } else if (arg === '--downloads-dir' && next) {
      parsed.downloadsDir = next;
      index += 1;
    } else if (arg.startsWith('--downloads-dir=')) {
      parsed.downloadsDir = arg.slice('--downloads-dir='.length);
    } else if (arg === '--yt-dlp-path' && next) {
      parsed.ytDlpPath = next;
      index += 1;
    } else if (arg.startsWith('--yt-dlp-path=')) {
      parsed.ytDlpPath = arg.slice('--yt-dlp-path='.length);
    } else if (arg === '--ffmpeg-location' && next) {
      parsed.ffmpegLocation = next;
      index += 1;
    } else if (arg.startsWith('--ffmpeg-location=')) {
      parsed.ffmpegLocation = arg.slice('--ffmpeg-location='.length);
    } else if (arg === '--download-concurrency' && next) {
      parsed.downloadConcurrency = Number(next);
      index += 1;
    } else if (arg.startsWith('--download-concurrency=')) {
      parsed.downloadConcurrency = Number(arg.slice('--download-concurrency='.length));
    } else if (arg === '--download-timeout-ms' && next) {
      parsed.downloadTimeoutMs = Number(next);
      index += 1;
    } else if (arg.startsWith('--download-timeout-ms=')) {
      parsed.downloadTimeoutMs = Number(arg.slice('--download-timeout-ms='.length));
    } else if (arg === '--download-limit' && next) {
      parsed.downloadLimit = Number(next);
      index += 1;
    } else if (arg.startsWith('--download-limit=')) {
      parsed.downloadLimit = Number(arg.slice('--download-limit='.length));
    } else {
      console.error(`[error] Unknown or incomplete argument: ${arg}`);
      printHelpAndExit(1);
    }
  }

  if (!Number.isInteger(parsed.downloadConcurrency) || parsed.downloadConcurrency < 1) {
    console.error('[error] --download-concurrency must be a positive integer.');
    process.exit(1);
  }
  if (Number.isNaN(parsed.downloadTimeoutMs) || parsed.downloadTimeoutMs < 0) {
    console.error('[error] --download-timeout-ms must be a non-negative number.');
    process.exit(1);
  }
  if (!Number.isInteger(parsed.downloadLimit) || parsed.downloadLimit < 0) {
    console.error('[error] --download-limit must be a non-negative integer.');
    process.exit(1);
  }

  for (const key of ['navigationTimeoutMs', 'maxAttempts', 'initialSettleMs', 'lessonLoadTimeoutMs', 'captureWindowMs', 'afterFirstHitGraceMs', 'betweenLessonDelayMs', 'retryDelayMs', 'discoveryScrolls']) {
    if (!Number.isFinite(parsed[key]) || parsed[key] <= 0) {
      throw new Error(`${key} must be a positive number.`);
    }
  }

  if (!Number.isInteger(parsed.maxStreamsPerLesson) || parsed.maxStreamsPerLesson < 0) {
    console.error('[error] --max-streams-per-lesson must be a non-negative integer.');
    process.exit(1);
  }

  return parsed;
}

function printHelpAndExit(exitCode = 0) {
  console.log(`Usage:
  npm start
  node src/index.js
  npm run crawl -- --url <course-url>
  npm run convert
  npm run scrape-and-convert -- --url <course-url>

Options:
  --convert               Convert/download existing videos.json to MP4
  --ask-convert           Prompt to convert after crawling
  --auto-convert          Automatically convert after crawling without prompt
  --downloads-dir <path>  Output directory for MP4s, default: downloads
  --retry-failed-downloads Retry streams marked as failed
  --force-download        Redownload even if file exists
  --yt-dlp-path <path>    Path to yt-dlp executable, default: yt-dlp
  --ffmpeg-location <path> Path to ffmpeg executable
  --download-concurrency <n> Number of parallel downloads, default: 1
  --download-timeout-ms <n> Timeout for yt-dlp process, default: 0 (no timeout)
  --download-limit <n>    Max number of streams to download, default: 0 (no limit)
  --url <url>             Huawei course page to open
  --debug                 Print request URL, response URL, status, and content-type
  --crawl-learning-page   Parse sidebar menu hierarchically and crawl lessons automatically
  --auto-lessons          Discover and click lesson candidates automatically (Legacy)
  --no-wait               Do not wait for Enter before manual monitoring
  --resume                Resume from videos.json, default: enabled
  --no-resume             Ignore existing videos.json and rebuild state
  --retry-no-video        Retry lessons marked as no_video on resume
  --max-attempts <n>      Retry attempts per lesson, default: 3
  --max-streams-per-lesson <n> Max HLS streams captured per lesson, default: 0 (no limit)
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
  MAX_ATTEMPTS, MAX_STREAMS_PER_LESSON, INITIAL_SETTLE_MS, LESSON_LOAD_TIMEOUT_MS, CAPTURE_WINDOW_MS, AFTER_FIRST_HIT_GRACE_MS,
  BETWEEN_LESSON_DELAY_MS, RETRY_DELAY_MS, DISCOVERY_SCROLLS, NAVIGATION_TIMEOUT_MS, PLAYWRIGHT_CHANNEL,
  DOWNLOADS_DIR, YT_DLP_PATH, FFMPEG_LOCATION, DOWNLOAD_CONCURRENCY, DOWNLOAD_TIMEOUT_MS,
  RETRY_FAILED_DOWNLOADS, FORCE_DOWNLOAD, DOWNLOAD_LIMIT, AUTO_CONVERT
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
  normalizeHierarchicalLessonIds(modules);
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
        lessonId: getLessonKey(lesson),
        startedAt: Date.now(),
        foundUrls: new Set()
      };

      if (!activeCapture.lessonId) {
        throw new Error(`Lesson key missing for ${lesson.lessonTitle}`);
      }

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
        normalizeLessonVideoTitles(lesson);
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

// --- Interactive Menu & MP4 Convert Logic ---

async function showMainMenu() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log('\nHuawei HLS Capture\n');
  console.log('1. Scrape learning page, then optionally convert to MP4');
  console.log('2. Convert/download existing videos.json to MP4');
  console.log('3. Exit\n');

  try {
    const answer = await rl.question('Choose option: ');
    rl.close();

    const choice = answer.trim();
    if (choice === '1') {
      await promptForCourseUrlAndCrawl({ returnToMenu: true });
    } else if (choice === '2') {
      await convertVideosFromState({ returnToMenu: true });
    } else if (choice === '3') {
      console.log('Exiting...');
      process.exit(0);
    } else {
      console.log('Invalid option.');
      await showMainMenu();
    }
  } catch (error) {
    rl.close();
  }
}

async function promptForCourseUrlAndCrawl({ returnToMenu = true } = {}) {
  if (options.courseUrl === DEFAULT_COURSE_URL || !options.courseUrl) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    try {
      const url = await rl.question('Enter course URL: ');
      if (url.trim()) {
        options.courseUrl = url.trim();
      }
    } finally {
      rl.close();
    }
  }

  options.crawlLearningPage = true;
  options.askConvert = true;
  await runCrawlWorkflow();
  await promptConversionAfterCrawl({ returnToMenu });
}

async function promptConversionAfterCrawl({ returnToMenu = false } = {}) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    const answer = await rl.question('\nScraping finished. Continue convert/download to MP4? [y/N] ');
    if (answer.trim().toLowerCase() === 'y') {
      rl.close();
      await convertVideosFromState({ returnToMenu });
    } else {
      rl.close();
      if (returnToMenu) {
        await showMainMenu();
      }
    }
  } catch (error) {
    rl.close();
  }
}

async function convertVideosFromState({ returnToMenu = false } = {}) {
  console.log('[convert] Loading videos.json...');
  try {
    videosState = await loadVideosState();
  } catch (error) {
    console.log('videos.json not found. Run scraping first.');
    if (returnToMenu) {
      await showMainMenu();
    }
    return;
  }

  const jobs = collectDownloadJobs(videosState);
  if (jobs.length === 0) {
    console.log('[convert] No HLS streams found in videos.json.');
    if (returnToMenu) {
      await showMainMenu();
    }
    return;
  }

  const courseTitle = videosState.courseTitle || 'Huawei Talent Course';
  const numModules = videosState.modules ? videosState.modules.length : 0;
  const numLessons = videosState.modules ? videosState.modules.reduce((sum, m) => sum + (m.lessons ? m.lessons.length : 0), 0) : videosState.lessons.length;
  
  let downloaded = 0;
  let pending = 0;
  let failed = 0;

  for (const job of jobs) {
    const status = job.stream.download?.status;
    if (status === 'completed') downloaded++;
    else if (status === 'failed') failed++;
    else pending++;
  }

  console.log(`\n[convert] Summary:`);
  console.log(`  Course: ${courseTitle}`);
  console.log(`  Modules: ${numModules}`);
  console.log(`  Lessons: ${numLessons}`);
  console.log(`  HLS Streams: ${jobs.length}`);
  console.log(`  Already Downloaded: ${downloaded}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Pending: ${pending}`);
  console.log(`  Output Dir: ${path.resolve(options.downloadsDir)}`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  let confirm = 'n';
  try {
    const answer = await rl.question('\nContinue downloading/converting m3u8 to MP4? [y/N] ');
    confirm = answer.trim().toLowerCase();
  } finally {
    rl.close();
  }

  if (confirm !== 'y') {
    if (returnToMenu) {
      await showMainMenu();
    }
    return;
  }

  const hasYtDlp = await ensureToolAvailable(options.ytDlpPath, ['--version']);
  if (!hasYtDlp) {
    console.log('\nyt-dlp was not found. Install it first:');
    console.log('winget install yt-dlp.yt-dlp');
    console.log('or:');
    console.log('pip install -U yt-dlp\n');
    if (returnToMenu) {
      await showMainMenu();
    }
    return;
  }

  const ffmpegCheckArgs = options.ffmpegLocation ? ['-version'] : ['-version'];
  const ffmpegCmd = options.ffmpegLocation || 'ffmpeg';
  const hasFfmpeg = await ensureToolAvailable(ffmpegCmd, ffmpegCheckArgs);
  if (!hasFfmpeg) {
    console.log('[warn] ffmpeg was not found. yt-dlp may fail to merge video and audio.');
  }

  let successCount = 0;
  let skipCount = 0;
  let failCount = 0;

  // Simple concurrency
  if (options.downloadLimit > 0) {
    console.log(`[convert] Download limit: ${options.downloadLimit}`);
  }

  const onInterrupt = async () => {
    console.log('\n[interrupt] Download interrupted. Saving progress...');
    await saveVideosState();
    console.log('[interrupt] Progress saved.');
    process.exit(0);
  };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);

  const queue = [...jobs];
  const workers = [];
  
  const worker = async () => {
    while (queue.length > 0) {
      if (options.downloadLimit > 0 && successCount >= options.downloadLimit) {
        queue.length = 0; // stop processing
        break;
      }
      const job = queue.shift();
      const result = await downloadStreamWithYtDlp(job);
      if (result === 'completed') successCount++;
      else if (result === 'skipped') skipCount++;
      else failCount++;
    }
  };

  for (let i = 0; i < options.downloadConcurrency; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);

  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onInterrupt);

  console.log(`\n[convert] Done. completed=${successCount} skipped=${skipCount} failed=${failCount}`);
  
  if (returnToMenu) {
    await showMainMenu();
  }
}

function collectDownloadJobs(state) {
  const jobs = [];
  const courseTitle = state.courseTitle || 'Huawei Talent Course';

  if (state.modules) {
    for (const mod of state.modules) {
      for (const lesson of mod.lessons || []) {
        for (const video of lesson.videos || []) {
          if (video.m3u8Url) {
            jobs.push({
              courseTitle,
              moduleTitle: mod.moduleTitle,
              lessonTitle: lesson.lessonTitle,
              stream: video
            });
          }
        }
      }
    }
  } else if (state.lessons) {
    for (const lesson of state.lessons) {
      for (const url of lesson.m3u8Urls || []) {
        jobs.push({
          courseTitle,
          moduleTitle: 'Lessons',
          lessonTitle: lesson.title,
          stream: { m3u8Url: url, videoTitle: lesson.title, download: lesson.download }
        });
      }
    }
  }
  return jobs;
}

function sanitizePathSegment(value) {
  if (!value) return 'Unknown';
  let sanitized = value.replace(/[<>:"/\\|?*]/g, '');
  sanitized = sanitized.replace(/\s+/g, ' ').trim();
  const upper = sanitized.toUpperCase();
  const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/;
  if (reserved.test(upper)) {
    sanitized = `_${sanitized}`;
  }
  if (sanitized === '' || sanitized === '.' || sanitized === '..') {
    sanitized = 'Unknown';
  }
  return sanitized.substring(0, 100);
}

function buildDownloadOutputPath(job) {
  const course = sanitizePathSegment(job.courseTitle);
  const mod = sanitizePathSegment(job.moduleTitle);
  const lesson = sanitizePathSegment(job.lessonTitle);
  const streamName = sanitizePathSegment(job.stream.videoTitle || 'Stream');
  
  const base = path.join(options.downloadsDir, course, mod, lesson);
  return path.join(base, `${streamName}.mp4`);
}

async function fileExistsWithSize(filePath) {
  try {
    const s = await stat(filePath);
    return s.isFile() && s.size > 0;
  } catch (e) {
    return false;
  }
}

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatEta(seconds) {
  if (seconds == null || isNaN(seconds)) return 'N/A';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function ensureToolAvailable(command, args) {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { stdio: 'ignore', shell: false });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}

const IMPORTANT_STATUS_MARKERS = [
  '[download] Destination',
  '[download] Downloading',
  '[Merger]',
  '[FixupM3u8]',
  '[VideoRemuxer]',
  '[ExtractAudio]',
  '[MoveFiles]',
  '[ffmpeg]',
  'Merging formats into',
  'Fixing MPEG-TS',
  'Deleting original file',
  'has already been downloaded'
];

const POSTPROCESS_MARKERS = [
  '[Merger]',
  '[FixupM3u8]',
  '[VideoRemuxer]',
  '[ExtractAudio]',
  '[MoveFiles]',
  '[ffmpeg]',
  'Merging formats into',
  'Fixing MPEG-TS',
  'Deleting original file'
];

function isImportantStatusLine(line) {
  return IMPORTANT_STATUS_MARKERS.some((marker) => line.includes(marker));
}

function runYtDlp(args, onProgress, onStatus) {
  return new Promise((resolve) => {
    const proc = spawn(options.ytDlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });

    let errorOutput = '';
    let stdoutRemainder = '';
    let stderrRemainder = '';
    let settled = false;
    let timeoutId = null;

    const handleOutputLine = (rawLine, source) => {
      const line = rawLine.trim();
      if (!line) return;

      if (line.includes('~ytdlp-progress-')) {
        const marker = '~ytdlp-progress-';
        const markerIndex = line.indexOf(marker);
        const jsonStr = line.slice(markerIndex + marker.length);

        try {
          const progress = JSON.parse(jsonStr);
          if (onProgress) onProgress(progress);
        } catch {
          // Ignore malformed progress output.
        }
      } else if (isImportantStatusLine(line)) {
        if (onStatus) onStatus(line);
      } else if (source === 'stderr') {
        errorOutput += line + '\n';
      }
    };

    const handleOutputChunk = (data, source) => {
      const text = data.toString();
      const current = (source === 'stdout' ? stdoutRemainder : stderrRemainder) + text;
      const parts = current.split(/\r?\n|\r/);
      const remainder = parts.pop() || '';

      if (source === 'stdout') {
        stdoutRemainder = remainder;
      } else {
        stderrRemainder = remainder;
      }

      for (const rawLine of parts) {
        handleOutputLine(rawLine, source);
      }
    };

    const flushRemainder = () => {
      if (stdoutRemainder.trim()) {
        handleOutputLine(stdoutRemainder, 'stdout');
        stdoutRemainder = '';
      }
      if (stderrRemainder.trim()) {
        handleOutputLine(stderrRemainder, 'stderr');
        stderrRemainder = '';
      }
    };

    proc.stdout.on('data', (data) => handleOutputChunk(data, 'stdout'));
    proc.stderr.on('data', (data) => handleOutputChunk(data, 'stderr'));

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      resolve(result);
    };

    if (options.downloadTimeoutMs > 0) {
      timeoutId = setTimeout(() => {
        proc.kill('SIGKILL');
        finish({ success: false, error: 'Process timed out' });
      }, options.downloadTimeoutMs);
    }

    proc.on('error', (err) => finish({ success: false, error: err.message }));

    proc.on('close', (code) => {
      flushRemainder();

      if (code === 0) {
        finish({ success: true });
      } else {
        finish({
          success: false,
          error: `yt-dlp exited with code ${code}. ${errorOutput.trim().substring(0, 200)}`
        });
      }
    });
  });
}

async function downloadStreamWithYtDlp(job) {
  const stream = job.stream;
  const title = stream.videoTitle || job.lessonTitle || 'Stream';
  
  const outputFile = buildDownloadOutputPath(job);
  const fileExists = await fileExistsWithSize(outputFile);
  
  stream.download ??= {};

  if (fileExists && !options.forceDownload) {
    console.log(`[download] SKIP already exists: ${outputFile}`);
    stream.download.status = 'completed';
    stream.download.outputFile = outputFile;
    stream.download.error = null;
    await saveVideosState();
    return 'skipped';
  }

  if (stream.download.status === 'completed' && !options.forceDownload && !fileExists) {
    // metadata says completed but file is missing -> redownload
  } else if (stream.download.status === 'completed' && !options.forceDownload) {
    console.log(`[download] SKIP marked completed: ${title}`);
    return 'skipped';
  }

  if (stream.download.status === 'failed' && !options.retryFailedDownloads && !options.forceDownload) {
    console.log(`[download] SKIP previously failed (use --retry-failed-downloads): ${title}`);
    return 'skipped';
  }

  console.log(`[download] ${title}`);
  console.log('[stage] Downloading...');
  
  stream.download.status = 'in_progress';
  stream.download.startedAt = toWIB();
  stream.download.outputFile = outputFile;
  stream.download.error = null;
  await saveVideosState();

  await mkdir(path.dirname(outputFile), { recursive: true });

  const args = [
    stream.m3u8Url,
    '-o', outputFile,
    '--merge-output-format', 'mp4',
    '--continue',
    '--no-overwrites',
    '--progress',
    '--newline',
    '--progress-template', '~ytdlp-progress-%(progress)j'
  ];

  if (options.ffmpegLocation) {
    args.push('--ffmpeg-location', options.ffmpegLocation);
  }

  let postprocessAnnounced = false;
  let wroteProgress = false;

  const result = await runYtDlp(args, (progress) => {
    wroteProgress = true;
    const downloaded = progress.downloaded_bytes || 0;
    const total = progress.total_bytes || progress.total_bytes_estimate || 0;
    
    let percentStr = '0.0';
    if (total > 0) {
      percentStr = ((downloaded / total) * 100).toFixed(1);
    }
    
    const sizeStr = `${formatBytes(downloaded)} / ${total > 0 ? formatBytes(total) : 'Unknown'}`;
    const speedStr = progress.speed ? `${formatBytes(progress.speed)}/s` : 'N/A';
    const etaStr = progress.eta != null ? formatEta(progress.eta) : 'N/A';
    
    stream.download.percent = percentStr;
    stream.download.totalSize = sizeStr;
    stream.download.speed = speedStr;
    stream.download.eta = etaStr;
    
    process.stdout.write(`\r[download] ${title.substring(0, 30)}: ${percentStr}% | ${sizeStr} | ${speedStr} | ETA ${etaStr}`.padEnd(100));
  }, (line) => {
    if (wroteProgress) {
      console.log('');
      wroteProgress = false;
    }
    const isPostprocess = POSTPROCESS_MARKERS.some((marker) => line.includes(marker));
    if (isPostprocess && !postprocessAnnounced) {
      console.log('[stage] Post-processing/remuxing...');
      postprocessAnnounced = true;
    }
    if (isPostprocess) {
      console.log(`[postprocess] ${line}`);
    } else {
      console.log(`[yt-dlp] ${line}`);
    }
  });

  if (wroteProgress || stream.download.percent) {
    console.log(''); // newline after progress
  }

  if (result.success) {
    console.log('[stage] Completed.');
    console.log(`[download] OK ${outputFile}`);
    stream.download.status = 'completed';
    stream.download.completedAt = toWIB();
    stream.download.error = null;
    await saveVideosState();
    return 'completed';
  } else {
    // If forbidden/expired
    const isExpired = result.error.includes('403') || result.error.includes('Forbidden') || result.error.includes('HTTP Error 40');
    let errMsg = result.error;
    if (isExpired) {
      errMsg = 'URL is expired/inaccessible. Re-scrape to get fresh URLs.';
    }

    console.log(`[download] FAIL ${title}: ${errMsg}`);
    stream.download.status = 'failed';
    stream.download.error = errMsg;
    await saveVideosState();
    return 'failed';
  }
}

