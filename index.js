const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs-extra");
const axios = require("axios");
const { google } = require("googleapis");
const cookBrowser = require("./cook_browser");

puppeteer.use(StealthPlugin());

// ========== GOOGLE SHEET SERVICE ==========
class GoogleSheetService {
  constructor(config) {
    this.enabled = config?.enabled || false;
    this.sheetId = config?.sheetId;
    this.keyFile = config?.serviceAccountKeyFile;
    this.auth = null;
    this.sheets = null;
  }

  async init() {
    if (!this.enabled || !this.sheetId || !this.keyFile) {
      return false;
    }

    try {
      if (!(await fs.pathExists(this.keyFile))) {
        console.log(`[Google Sheet] Khong tim thay key file: ${this.keyFile}`);
        return false;
      }

      this.auth = new google.auth.GoogleAuth({
        keyFile: this.keyFile,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });

      const client = await this.auth.getClient();
      this.sheets = google.sheets({ version: "v4", auth: client });
      console.log("[Google Sheet] Da ket noi thanh cong");
      return true;
    } catch (error) {
      console.error("[Google Sheet] Loi ket noi:", error.message);
      return false;
    }
  }

  async export(posts) {
    if (!this.sheets || !this.sheetId || posts.length === 0) return;

    try {
      const values = posts.map((post) => [
        new Date().toLocaleString("vi-VN"), // Thoi gian quet
        post.groupId,
        post.authorName,
        post.postUrl,
        post.matchedKeywords.join(", "),
        post.textPreview,
        post.timestamp
          ? new Date(post.timestamp).toLocaleString("vi-VN")
          : "Unknown",
      ]);

      await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.sheetId,
        range: "A1", // Append vao sheet dau tien
        valueInputOption: "USER_ENTERED",
        resource: {
          values: values,
        },
      });

      console.log(`[Google Sheet] Da them ${posts.length} dong moi`);
    } catch (error) {
      console.error("[Google Sheet] Loi khi ghi du lieu:", error.message);
    }
  }
}

// ========== CONSTANTS ==========
const CONSTANTS = {
  DELAYS: {
    CHECK_LOGIN: 3000,
    PAGE_LOAD: 3000,
    RETRY: 5000,
    NOTIFICATION: 1000,
    BATCH_DEFAULT: 3000,
  },
  TIMEOUTS: {
    PAGE_NAVIGATION: 60000,
    LOGIN_CHECK: 30000,
    CONTENT_WAIT: 5000,
    ARTICLES_WAIT: 3000,
  },
  SCROLL: {
    MAX_EMPTY_SCROLLS: 5,
    SCROLL_RATIO: 0.8,
    SCROLL_THRESHOLD: 100,
  },
  POST: {
    MAX_PREVIEW_LENGTH: 300,
    MAX_MESSAGE_LENGTH: 500,
    OLD_POST_DAYS: 3,
  },
  USER_AGENT: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

class FacebookGroupMonitor {
  constructor() {
    this.browser = null;
    this.mainPage = null;

    this.cookieFile = "fb_cookies.json";
    this.configFile = "config.json";
    this.resultsFile = "results.json";
    this.cacheIndexFile = "cacheIndexpost.json";

    this.keywords = [];
    this.keywordsSet = null; // Cache for fast lookup
    this.groupIds = [];
    this.existingResults = new Map();

    this.maxConcurrentTabs = 5;
    this.notificationConfig = null;
    this.sheetService = null; // Google Sheet Service

    this.groupStats = new Map(); // thong ke tung nhom
    this.latestPostIndex = new Map();

    this.groupCooldownMinutes = 30; // default cooldown
    this.maxRetries = 2; // default retries
    this.batchDelayMs = 3000; // default batch delay

    this.scrollConfig = {
      maxScrolls: 30,
      maxNoNewPosts: 3,
      scrollWaitMin: 2000,
      scrollWaitMax: 4000,
    };
  }

  async initBrowser() {
    const { browser, mainPage } = await cookBrowser.initBrowser(CONSTANTS, this.cookieFile);
    this.browser = browser;
    this.mainPage = mainPage;
  }

  convertSameSite(sameSite) {
    return cookBrowser.convertSameSite(sameSite);
  }

  async checkLogin() {
    return await cookBrowser.checkLogin(this.mainPage, CONSTANTS);
  }

  async refreshCookies() {
    return await cookBrowser.refreshCookies(this.mainPage, this.cookieFile);
  }

  async loadConfig() {
    try {
      if (await fs.pathExists(this.configFile)) {
        const config = await fs.readJson(this.configFile);

        this.keywords = config.keywords || [];
        this.keywordsSet = new Set(this.keywords.map(kw => kw.toLowerCase()));
        this.groupIds = config.groupIds || [];
        this.maxConcurrentTabs = config.maxConcurrentTabs || 5;

        if (config.scrollConfig) {
          this.scrollConfig = { ...this.scrollConfig, ...config.scrollConfig };
        }

        if (config.notification) {
          this.notificationConfig = config.notification;
          // Init Google Sheet Service
          if (config.notification.googleSheet) {
            this.sheetService = new GoogleSheetService(
              config.notification.googleSheet
            );
            await this.sheetService.init();
          }
        }

        if (config.performance) {
          if (config.performance.maxConcurrentTabs) {
            this.maxConcurrentTabs = config.performance.maxConcurrentTabs;
          }
          if (config.performance.groupCooldownMinutes) {
            this.groupCooldownMinutes = config.performance.groupCooldownMinutes;
          }
          if (config.performance.maxRetries) {
            this.maxRetries = config.performance.maxRetries;
          }
          if (config.performance.batchDelayMs) {
            this.batchDelayMs = config.performance.batchDelayMs;
          }
        }

        console.log(
          `Config: ${this.keywords.length} keywords, ${this.groupIds.length} groups`
        );
        console.log(
          `Max tabs: ${this.maxConcurrentTabs}, stop sau ${this.scrollConfig.maxNoNewPosts} lan khong co bai moi`
        );
        return true;
      }
    } catch (error) {
      console.log("Khong load duoc config:", error.message);
    }

    return false;
  }

  async createDefaultConfig() {
    const config = {
      keywords: ["mua", "ban", "can tim", "thanh ly", "ship cod", "gia re"],
      groupIds: [],
      maxConcurrentTabs: 10,
      scrollConfig: {
        maxNoNewPosts: 3,
        scrollWaitMin: 2000,
        scrollWaitMax: 4000,
      },
      performance: {
        maxConcurrentTabs: 10,
        groupCooldownMinutes: 30,
        maxRetries: 2,
        batchDelayMs: 3000,
      },
      notification: {
        telegram: {
          enabled: false,
          botToken: "",
          chatId: "",
        },
        zalo: {
          enabled: false,
          accessToken: "",
          groupId: "",
          webhookUrl: "",
        },
      },
    };

    await fs.writeJson(this.configFile, config, { spaces: 2 });
    this.keywords = config.keywords;
    this.keywordsSet = new Set(this.keywords.map(kw => kw.toLowerCase()));
    this.groupIds = config.groupIds;
    console.log(`Da tao config mac dinh: ${this.configFile}`);
  }

  async loadExistingResults() {
    try {
      if (await fs.pathExists(this.resultsFile)) {
        const results = await fs.readJson(this.resultsFile);
        this.existingResults = new Map(
          results.map((item) => [item.postUrl, item])
        );
        console.log(
          `Da load ${this.existingResults.size} ket qua cu tu results.json`
        );
        return true;
      }
    } catch (error) {
      console.error("Loi load results cu:", error.message);
    }

    this.existingResults = new Map();
    return false;
  }

  async loadLatestPostIndex() {
    try {
      if (await fs.pathExists(this.cacheIndexFile)) {
        const data = await fs.readJson(this.cacheIndexFile);
        const entries = data.posts || data;
        this.latestPostIndex = new Map(Object.entries(entries || {}));
        console.log(
          `Da load cache post index cho ${this.latestPostIndex.size} nhom`
        );
        return true;
      }
    } catch (error) {
      console.error("Loi load cache index:", error.message);
    }

    this.latestPostIndex = new Map();
    return false;
  }

  async saveLatestPostIndex() {
    try {
      const data = {
        lastUpdate: new Date().toISOString(),
        posts: Object.fromEntries(this.latestPostIndex),
      };
      await fs.writeJson(this.cacheIndexFile, data, { spaces: 2 });
    } catch (error) {
      console.error("Loi save cache index:", error.message);
    }
  }


  shouldSkipGroup(groupId) {
    const stat = this.groupStats.get(groupId);
    if (!stat || !stat.lastScan) {
      return { skip: false };
    }

    const lastScanTime = new Date(stat.lastScan);
    const now = new Date();
    const minutesSinceLastScan = (now - lastScanTime) / (1000 * 60);

    if (minutesSinceLastScan < this.groupCooldownMinutes) {
      const remaining = Math.ceil(
        this.groupCooldownMinutes - minutesSinceLastScan
      );
      return { skip: true, reason: `Cooldown con ${remaining} phut` };
    }

    return { skip: false };
  }

  getScrollConfigForGroup(groupId) {
    const stat = this.groupStats.get(groupId);
    const baseConfig = { ...this.scrollConfig };

    if (stat?.lastNewPostCount === 0) {
      baseConfig.maxNoNewPosts = Math.max(1, baseConfig.maxNoNewPosts - 1);
    }

    return baseConfig;
  }

  updateGroupStat(groupId, updates) {
    const current = this.groupStats.get(groupId) || {};
    this.groupStats.set(groupId, {
      ...current,
      ...updates,
      lastScan: updates.lastScan || current.lastScan || new Date().toISOString(),
    });
  }

  mergeResult(newResult) {
    const now = new Date().toISOString();
    const existingResult = this.existingResults.get(newResult.postUrl);
    
    if (existingResult) {
      const updated = {
        ...existingResult,
        textPreview: newResult.textPreview,
        matchedKeywords: newResult.matchedKeywords,
        lastUpdated: now,
        lastSeen: now,
        scanCount: (existingResult.scanCount || 1) + 1,
      };
      this.existingResults.set(newResult.postUrl, updated);
      return { isNew: false, result: updated };
    } else {
      const created = {
        ...newResult,
        firstSeen: now,
        lastSeen: now,
        lastUpdated: now,
        scanCount: 1,
      };
      this.existingResults.set(newResult.postUrl, created);
      return { isNew: true, result: created };
    }
  }

  hasKeyword(text) {
    if (!text || !this.keywordsSet) return false;
    const lowerText = text.toLowerCase();
    return Array.from(this.keywordsSet).some((kw) => lowerText.includes(kw));
  }

  getMatchedKeywords(text) {
    if (!text || !this.keywordsSet) return [];
    const lowerText = text.toLowerCase();
    return Array.from(this.keywordsSet).filter((kw) => lowerText.includes(kw));
  }

  extractPostId(url) {
    const patterns = [
      /\/posts\/(\d+)/,
      /\/permalink\/(\d+)/,
      /story_fbid=(\d+)/,
      /pfbid[a-zA-Z0-9]+/,
    ];
    for (let pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1] || match[0];
    }
    return url.split("?")[0].split("/").pop();
  }

  // ========== SMART SCROLL ==========

  async smartScroll(page) {
    return await page.evaluate((SCROLL_RATIO, SCROLL_THRESHOLD) => {
      const scrollBefore = window.pageYOffset;
      const scrollHeight = document.documentElement.scrollHeight;
      const clientHeight = document.documentElement.clientHeight;

      window.scrollBy(0, clientHeight * SCROLL_RATIO);

      const scrollAfter = window.pageYOffset;

      if (scrollAfter + clientHeight >= scrollHeight - SCROLL_THRESHOLD) {
        return false;
      }

      if (scrollAfter === scrollBefore) {
        return false;
      }

      return true;
    }, CONSTANTS.SCROLL.SCROLL_RATIO, CONSTANTS.SCROLL.SCROLL_THRESHOLD);
  }

  async waitForNewContent(page) {
    try {
        await page
        .waitForFunction(
          () => {
            const spinners = document.querySelectorAll('[role="progressbar"]');
            return spinners.length === 0;
          },
          { timeout: CONSTANTS.TIMEOUTS.CONTENT_WAIT }
        )
        .catch(() => {});

      await page
        .waitForFunction(
          () => {
            const articles = document.querySelectorAll('[role="article"]');
            return articles.length > 0;
          },
          { timeout: CONSTANTS.TIMEOUTS.ARTICLES_WAIT }
        )
        .catch(() => {});
    } catch (error) {
      // timeout ok
    }
  }

  async extractPosts(page) {
    return await page.evaluate(() => {
      // Chon tat ca article chua duoc scan
      const articles = document.querySelectorAll(
        '[role="article"]:not([data-monitor-scanned="true"])'
      );
      const data = [];

      articles.forEach((article) => {
        // Danh dau da scan de lan sau bo qua
        article.setAttribute("data-monitor-scanned", "true");

        try {
          const text = article.innerText || "";

          const links = article.querySelectorAll("a[href]");
          let postUrl = "";
          for (let link of links) {
            const href = link.href;
            if (
              href.includes("/posts/") ||
              href.includes("/permalink/") ||
              href.includes("story_fbid=")
            ) {
              postUrl = href.split("?")[0];
              break;
            }
          }
          if (!postUrl) return;

          let timestamp = null;
          const timeSelectors = [
            "abbr[data-utime]",
            "span[data-utime]",
            "div[data-utime]",
            "abbr[data-timestamp]",
            "span[data-timestamp]",
            "div[data-timestamp]",
            "time[datetime]",
          ];

          for (let sel of timeSelectors) {
            const timeEl = article.querySelector(sel);
            if (timeEl) {
              const utime =
                timeEl.getAttribute("data-utime") ||
                timeEl.getAttribute("data-timestamp");
              if (utime) {
                const numeric = parseInt(utime, 10);
                if (!isNaN(numeric)) {
                  timestamp = utime.length === 10 ? numeric * 1000 : numeric;
                  break;
                }
              }
              const datetime = timeEl.getAttribute("datetime");
              if (datetime) {
                const parsed = Date.parse(datetime);
                if (!isNaN(parsed)) {
                  timestamp = parsed;
                  break;
                }
              }
            }
          }

          if (!timestamp) {
            const timeLink = article.querySelector(
              'a[aria-label*="luc"], a[aria-label*="at"]'
            );
            if (timeLink) {
              const ariaLabel = timeLink.getAttribute("aria-label");
              const parsed = Date.parse(ariaLabel);
              if (!isNaN(parsed)) {
                timestamp = parsed;
              }
            }
          }

          let authorName = "Unknown";
          const nameSelectors = [
            "h2 span.x193iq5w",
            "h3 span.x193iq5w",
            "h4 span",
            'a[role="link"] strong span',
            "strong span",
          ];
          for (let sel of nameSelectors) {
            const nameEl = article.querySelector(sel);
            if (nameEl && nameEl.textContent.trim()) {
              authorName = nameEl.textContent.trim();
              break;
            }
          }

          let userId = "";
          const profileLink = article.querySelector(
            'a[href*="/user/"], a[href*="/profile.php?id="]'
          );
          if (profileLink) {
            const href = profileLink.href;
            const userMatch = href.match(/\/user\/(\d+)/);
            const idMatch = href.match(/id=(\d+)/);
            userId = userMatch ? userMatch[1] : idMatch ? idMatch[1] : "";
          }

          data.push({
            text,
            postUrl,
            authorName,
            userId: userId || "unknown",
            timestamp,
          });
        } catch (e) {
          // skip
        }
      });

      return data;
    });
  }


  // ========== QUET 1 NHOM ==========

  async scanGroupInTab(groupId, cookies, tabIndex, retryCount = 0) {
    let page = null;
    try {
      page = await this.browser.newPage();
      
      // Optimize: Block unnecessary resources (images, media, fonts)
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        const resourceType = req.resourceType();
        if (
          resourceType === "image" ||
          resourceType === "media" ||
          resourceType === "font"
        ) {
          req.abort();
        } else {
          req.continue();
        }
      });

      await page.setCookie(...cookies);
      await page.setUserAgent(CONSTANTS.USER_AGENT);

      console.log(`\n[Tab ${tabIndex}] Quet nhom: ${groupId}`);

      const url = `https://www.facebook.com/groups/${groupId}?sorting_setting=CHRONOLOGICAL`;

      await page.goto(url, {
        waitUntil: "networkidle2",
        timeout: CONSTANTS.TIMEOUTS.PAGE_NAVIGATION,
      });

      await this.delay(CONSTANTS.DELAYS.PAGE_LOAD);

      const canAccess = await page.evaluate(() => {
        const bodyText = document.body.innerText;
        return !bodyText.includes("Ban hien khong xem duoc noi dung nay");
      });

      if (!canAccess) {
        console.log(
          `[Tab ${tabIndex}] Khong truy cap duoc nhom (ID: ${groupId})`
        );
        await page.close();
        return { newPosts: [], updatedPosts: [] };
      }

      const newPosts = [];
      const updatedPosts = [];
      const processedUrls = new Set();

      const latestKnownPostId = this.latestPostIndex.get(groupId) || null;
      const hasLatestPostId = Boolean(latestKnownPostId);

      const threeDaysAgo = Date.now() - CONSTANTS.POST.OLD_POST_DAYS * 24 * 60 * 60 * 1000;

      let latestPostIdThisRun = null;
      let reachedKnownPost = false;
      let reachedOldPost = false;
      let reachedFeedEnd = false;

      let noNewPostsCount = 0;
      let scrollCount = 0;
      let consecutiveEmptyScrolls = 0;

      const scrollConfig = this.getScrollConfigForGroup(groupId);
      const { maxNoNewPosts, scrollWaitMin, scrollWaitMax } = scrollConfig;

      console.log(
        `[Tab ${tabIndex}] Bat dau smart scroll (knownLatest: ${
          hasLatestPostId ? `YES ${latestKnownPostId}` : "NO"
        }, stop sau ${maxNoNewPosts} lan khong co moi hoac bai cu > 3 ngay)`
      );

      while (
        noNewPostsCount < maxNoNewPosts &&
        consecutiveEmptyScrolls < CONSTANTS.SCROLL.MAX_EMPTY_SCROLLS &&
        !reachedKnownPost &&
        !reachedOldPost
      ) {
        scrollCount++;

        const scrolled = await this.smartScroll(page);
        if (!scrolled) {
          console.log(`[Tab ${tabIndex}] Da den cuoi feed`);
          reachedFeedEnd = true;
          break;
        }

        await this.waitForNewContent(page);

        const waitTime =
          scrollWaitMin + Math.random() * (scrollWaitMax - scrollWaitMin);
        await this.delay(waitTime);

        const posts = await this.extractPosts(page);
        if (!posts || posts.length === 0) {
          consecutiveEmptyScrolls++;
          console.log(
            `[Tab ${tabIndex}] Scroll ${scrollCount} - Khong co post nao (empty ${consecutiveEmptyScrolls}/5)`
          );
          if (consecutiveEmptyScrolls >= CONSTANTS.SCROLL.MAX_EMPTY_SCROLLS) {
            console.log(
              `[Tab ${tabIndex}] Qua nhieu scroll khong co posts, dung`
            );
            break;
          }
          continue;
        }

        consecutiveEmptyScrolls = 0;
        console.log(
          `[Tab ${tabIndex}] Scroll ${scrollCount} - Extract duoc ${posts.length} bai`
        );

        let foundNewInThisScroll = 0;
        let foundNewPostsInScroll = false;

        for (let post of posts) {
          const postId = this.extractPostId(post.postUrl);
          if (!postId) continue;

          if (!latestPostIdThisRun) {
            latestPostIdThisRun = postId;
            console.log(
              `[Tab ${tabIndex}] Luu moc post ID dau tien: ${postId}`
            );
          }

          if (hasLatestPostId && postId === latestKnownPostId) {
            reachedKnownPost = true;
            console.log(
              `[Tab ${tabIndex}] Dung: gap lai bai viet moi nhat da luu (${postId})`
            );
            break;
          }

          if (
            !hasLatestPostId &&
            post.timestamp &&
            post.timestamp < threeDaysAgo
          ) {
            reachedOldPost = true;
            const postDate = new Date(post.timestamp).toLocaleString("vi-VN");
            console.log(
              `[Tab ${tabIndex}] Dung: gap bai cu hon 3 ngay (${postDate})`
            );
            break;
          }

          if (processedUrls.has(post.postUrl)) {
            continue;
          }

          processedUrls.add(post.postUrl);
          foundNewPostsInScroll = true;

          if (this.hasKeyword(post.text)) {
            foundNewInThisScroll++;
            const newResult = {
              groupId,
              postId,
              userId: post.userId,
              postUrl: post.postUrl,
              authorName: post.authorName,
              textPreview: post.text.substring(0, CONSTANTS.POST.MAX_PREVIEW_LENGTH).replaceAll("\n", " "),
              matchedKeywords: this.getMatchedKeywords(post.text),
              timestamp: post.timestamp || null,
            };

            const { isNew, result } = this.mergeResult(newResult);

            if (isNew) {
              newPosts.push(result);
              console.log(
                `[Tab ${tabIndex}] NEW ${result.authorName} | ${result.postId}`
              );
            } else {
              updatedPosts.push(result);
              console.log(
                `[Tab ${tabIndex}] UPDATE ${result.authorName} | ${result.postId} (#${result.scanCount})`
              );
            }
          }
        }

        if (reachedKnownPost || reachedOldPost) {
          break;
        }

        if (!foundNewPostsInScroll) {
          noNewPostsCount++;
          console.log(
            `[Tab ${tabIndex}] Scroll ${scrollCount} - Khong co bai moi chua xu ly (${noNewPostsCount}/${maxNoNewPosts})`
          );
        } else {
          if (foundNewInThisScroll === 0) {
            noNewPostsCount = 0;
            console.log(
              `[Tab ${tabIndex}] Scroll ${scrollCount} - Co bai moi nhung khong match keyword`
            );
          } else {
            noNewPostsCount = 0;
            console.log(
              `[Tab ${tabIndex}] Scroll ${scrollCount} - Tim thay ${foundNewInThisScroll} bai match; Tong: ${newPosts.length} new, ${updatedPosts.length} update`
            );
          }
        }
      }

      if (reachedKnownPost) {
        console.log(
          `[Tab ${tabIndex}] Dung: gap bai viet moi nhat da luu (${latestKnownPostId})`
        );
      } else if (reachedOldPost) {
        console.log(`[Tab ${tabIndex}] Dung: gap bai cu hon 3 ngay`);
      } else if (reachedFeedEnd) {
        console.log(`[Tab ${tabIndex}] Dung: da den cuoi feed nhom`);
      } else if (noNewPostsCount >= maxNoNewPosts) {
        console.log(
          `[Tab ${tabIndex}] Dung: ${maxNoNewPosts} lan khong co bai moi`
        );
      }

      console.log(
        `[Tab ${tabIndex}] Hoan thanh - New: ${newPosts.length}, Update: ${updatedPosts.length} (${scrollCount} scroll, ${processedUrls.size} posts)`
      );

      this.updateGroupStat(groupId, {
        lastNewPostCount: newPosts.length,
        errorCount: 0,
        lastScan: new Date().toISOString(),
      });

      if (latestPostIdThisRun) {
        this.latestPostIndex.set(groupId, latestPostIdThisRun);
        console.log(
          `[Tab ${tabIndex}] Luu moc post ID cho nhom ${groupId}: ${latestPostIdThisRun}`
        );
      } else {
        console.log(
          `[Tab ${tabIndex}] Khong co post ID nao de luu moc cho nhom ${groupId}`
        );
      }

      await page.close();
      return { newPosts, updatedPosts };
    } catch (error) {
      console.error(
        `[Tab ${tabIndex}] Loi khi quet group ${groupId}:`,
        error.message
      );
      if (page) await page.close();

      if (retryCount < this.maxRetries) {
        console.log(
          `[Tab ${tabIndex}] Retry ${retryCount + 1}/${
            this.maxRetries
          } sau 5s...`
        );
        await this.delay(CONSTANTS.DELAYS.RETRY);
        return this.scanGroupInTab(groupId, cookies, tabIndex, retryCount + 1);
      }

      this.updateGroupStat(groupId, {
        errorCount: (this.groupStats.get(groupId)?.errorCount || 0) + 1,
        lastScan: new Date().toISOString(),
      });

      return { newPosts: [], updatedPosts: [] };
    }
  }

  // ========== QUET NHIEU NHOM SONG SONG ==========

  async scanAllGroupsParallel(cookies) {
    if (this.groupIds.length === 0) {
      console.log("Chua cau hinh groupIds trong config.json");
      return { newPosts: [], updatedPosts: [] };
    }

    const groupsToScan = [];
    const skippedGroups = [];

    for (const groupId of this.groupIds) {
      const skipCheck = this.shouldSkipGroup(groupId);
      if (skipCheck.skip) {
        skippedGroups.push({ groupId, reason: skipCheck.reason });
      } else {
        groupsToScan.push(groupId);
      }
    }

    console.log(`\nTong: ${this.groupIds.length} nhom`);
    console.log(`Can quet: ${groupsToScan.length} nhom`);

    if (skippedGroups.length > 0) {
      console.log(`Skip (cooldown): ${skippedGroups.length} nhom`);
      if (skippedGroups.length <= 5) {
        skippedGroups.forEach(({ groupId, reason }) => {
          console.log(` - ${groupId}: ${reason}`);
        });
      }
    }

    if (groupsToScan.length === 0) {
      console.log("Tat ca nhom dang trong cooldown, khong quet them.");
      return { newPosts: [], updatedPosts: [] };
    }

    const allNewPosts = [];
    const allUpdatedPosts = [];

    const batches = [];
    for (let i = 0; i < groupsToScan.length; i += this.maxConcurrentTabs) {
      batches.push(groupsToScan.slice(i, i + this.maxConcurrentTabs));
    }

    console.log(
      `\nChia thanh ${batches.length} batch, moi batch toi da ${this.maxConcurrentTabs} tab\n`
    );

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];

      console.log("\n" + "=".repeat(60));
      console.log(
        `BATCH ${batchIndex + 1}/${batches.length} - ${batch.length} nhom`
      );
      console.log("=".repeat(60));

      const promises = batch.map((groupId, index) => {
        const tabIndex = batchIndex * this.maxConcurrentTabs + index + 1;
        return this.scanGroupInTab(groupId, cookies, tabIndex);
      });

      const results = await Promise.all(promises);
      results.forEach(({ newPosts, updatedPosts }) => {
        allNewPosts.push(...newPosts);
        allUpdatedPosts.push(...updatedPosts);
      });

      console.log(`\nBatch ${batchIndex + 1} hoan thanh!`);
      console.log(
        ` New: ${results.reduce((sum, r) => sum + r.newPosts.length, 0)}`
      );
      console.log(
        ` Update: ${results.reduce((sum, r) => sum + r.updatedPosts.length, 0)}`
      );

      if (batchIndex < batches.length - 1) {
        console.log(
          `\nCho ${this.batchDelayMs / 1000}s truoc batch tiep theo...`
        );
        await this.delay(this.batchDelayMs || CONSTANTS.DELAYS.BATCH_DEFAULT);
      }
    }
    return { newPosts: allNewPosts, updatedPosts: allUpdatedPosts };
  }

  async saveResults() {
    const allResults = Array.from(this.existingResults.values());
    allResults.sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
    await fs.writeJson(this.resultsFile, allResults, { spaces: 2 });
    console.log(
      `\nDa luu ${allResults.length} ket qua vao ${this.resultsFile}`
    );
    return allResults;
  }

  // ========== NOTIFICATION TELEGRAM ==========

  async sendToTelegram(message) {
    if (!this.notificationConfig?.telegram) {
      return false;
    }

    const { botToken, chatId } = this.notificationConfig.telegram;
    if (!botToken || !chatId) {
      console.log("Thieu Telegram config (botToken hoac chatId)");
      return false;
    }

    try {
      const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
      const response = await axios.post(url, {
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: false,
      });

      if (response.data.ok) {
        return true;
      } else {
        console.error("Telegram API error:", response.data);
        return false;
      }
    } catch (error) {
      console.error("Loi gui Telegram:", error.message);
      return false;
    }
  }

  // ========== NOTIFICATION ZALO ==========

  async sendToZalo(message) {
    if (!this.notificationConfig?.zalo) {
      return false;
    }

    const { accessToken, groupId, webhookUrl } = this.notificationConfig.zalo;

    if (webhookUrl) {
      try {
        const response = await axios.post(webhookUrl, {
          text: message,
        });
        if (response.status === 200) {
          return true;
        }
      } catch (error) {
        console.error("Loi gui Zalo webhook:", error.message);
        return false;
      }
    }

    if (!accessToken || !groupId) {
      console.log("Thieu Zalo config (accessToken/groupId hoac webhookUrl)");
      return false;
    }

    try {
      const url = `https://openapi.zalo.me/v2.0/oa/message`;
      const response = await axios.post(
        url,
        {
          recipient: {
            group_id: groupId,
          },
          message: {
            text: message,
          },
        },
        {
          headers: {
            access_token: accessToken,
            "Content-Type": "application/json",
          },
        }
      );

      if (response.data.error === 0) {
        return true;
      } else {
        console.error("Zalo API error:", response.data);
        return false;
      }
    } catch (error) {
      console.error("Loi gui Zalo:", error.message);
      return false;
    }
  }

  async sendNewPosts(newPosts) {
    if (!newPosts || newPosts.length === 0) {
      return;
    }

    if (!this.notificationConfig) {
      console.log("Chua cau hinh notification");
      return;
    }

    console.log(`\nDang gui ${newPosts.length} bai moi...`);

    for (let post of newPosts) {
      if (this.notificationConfig.telegram?.enabled) {
        const telegramMessage = this.formatPostMessage(post, "telegram");
        await this.sendToTelegram(telegramMessage);
        await this.delay(CONSTANTS.DELAYS.NOTIFICATION);
      }

      if (this.notificationConfig.zalo?.enabled) {
        const zaloMessage = this.formatPostMessage(post, "zalo");
        await this.sendToZalo(zaloMessage);
        await this.delay(CONSTANTS.DELAYS.NOTIFICATION);
      }
    }

    console.log(`Da gui ${newPosts.length} bai moi`);

    // Export to Google Sheet if enabled
    if (this.sheetService) {
      await this.sheetService.export(newPosts);
    }
  }

  formatPostMessage(post, platform = "telegram") {
    const keywords = post.matchedKeywords.join(", ");
    const preview =
      post.textPreview.length > CONSTANTS.POST.MAX_MESSAGE_LENGTH
        ? post.textPreview.substring(0, CONSTANTS.POST.MAX_MESSAGE_LENGTH) + "..."
        : post.textPreview;

    if (platform === "telegram") {
      return `
Bai viet moi
Tac gia: ${post.authorName}
Nhom: ${post.groupId}
Tu khoa: ${keywords}
Noi dung:
${preview.replaceAll("<", "<").replaceAll(">", ">")}
Link: ${post.postUrl}
`;
    } else {
      return `
Bai viet moi
Tac gia: ${post.authorName}
Nhom: ${post.groupId}
Tu khoa: ${keywords}
Noi dung:
${preview}
Link: ${post.postUrl}
`;
    }
  }

  getStats() {
    const results = Array.from(this.existingResults.values());
    const stats = {
      total: results.length,
      today: 0,
      byGroup: {},
      byKeyword: {},
    };

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    results.forEach((r) => {
      const lastSeen = new Date(r.lastSeen);
      if (lastSeen >= today) stats.today++;

      stats.byGroup[r.groupId] = (stats.byGroup[r.groupId] || 0) + 1;

      r.matchedKeywords.forEach((kw) => {
        stats.byKeyword[kw] = (stats.byKeyword[kw] || 0) + 1;
      });
    });

    return stats;
  }

  printStats(stats) {
    console.log("\n" + "=".repeat(60));
    console.log("THONG KE");
    console.log("=".repeat(60));
    console.log(`Tong: ${stats.total} bai`);
    console.log(`Hom nay: ${stats.today} bai`);

    console.log("\nTheo nhom:");
    Object.entries(stats.byGroup).forEach(([groupId, count]) => {
      console.log(` ${groupId}: ${count} bai`);
    });

    console.log("\nTop keywords:");
    Object.entries(stats.byKeyword)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .forEach(([kw, count]) => {
        console.log(` "${kw}": ${count} bai`);
      });

    console.log("=".repeat(60));
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
    }
  }
}

// ========== MAIN ==========

async function main() {
  const monitor = new FacebookGroupMonitor();
  const startTime = Date.now();

  try {
    console.log("\n" + "=".repeat(60));
    console.log(" FACEBOOK GROUP MONITOR - SMART SCROLL MODE");
    console.log("=".repeat(60) + "\n");

    await monitor.initBrowser();

    const cookies = await monitor.loadCookiesFromFile();
    if (!cookies) {
      console.log("\nKhong load duoc cookies\n");
      await monitor.close();
      return;
    }

    const isLoggedIn = await monitor.checkLogin();
    if (!isLoggedIn) {
      console.log("\nCookie khong hop le\n");
      await monitor.close();
      return;
    }

    await monitor.refreshCookies();

    const hasConfig = await monitor.loadConfig();
    if (!hasConfig) {
      await monitor.createDefaultConfig();
    }

    if (monitor.groupIds.length === 0) {
      console.log(
        "\nChua co nhom trong config.json (them groupIds roi chay lai)\n"
      );
      await monitor.close();
      return;
    }

    await monitor.loadExistingResults();
    await monitor.loadLatestPostIndex();

    console.log("\n" + "=".repeat(60));
    console.log("BAT DAU QUET (SMART SCROLL + MULTI TAB)");
    console.log("=".repeat(60));
    console.log(`Keywords: ${monitor.keywords.join(", ")}`);
    console.log(`Tong: ${monitor.groupIds.length} nhom`);
    console.log(`Max tabs: ${monitor.maxConcurrentTabs} tabs/batch`);
    console.log(
      `Scroll: stop sau ${monitor.scrollConfig.maxNoNewPosts} lan khong co bai moi / gap bai da luu / bai cu hon 3 ngay`
    );
    console.log("=".repeat(60));

    const { newPosts, updatedPosts } = await monitor.scanAllGroupsParallel(
      cookies
    );

    await monitor.saveResults();
    await monitor.saveLatestPostIndex();

    if (newPosts.length > 0) {
      await monitor.sendNewPosts(newPosts);
    }

    const stats = monitor.getStats();
    monitor.printStats(stats);

    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);

    console.log("\n" + "=".repeat(60));
    console.log("HOAN THANH");
    console.log("=".repeat(60));
    console.log(`Thoi gian: ${duration} phut`);
    console.log(`Bai moi: ${newPosts.length}`);
    console.log(`Bai cap nhat: ${updatedPosts.length}`);
    console.log(`Tong database: ${stats.total} bai`);
    console.log(`File JSON: ${monitor.resultsFile}`);
    console.log("=".repeat(60) + "\n");
  } catch (error) {
    console.error("\nLOI:", error.message);
    console.error(error.stack);
  } finally {
    await monitor.close();
    process.exit(0);
  }
}

main();
