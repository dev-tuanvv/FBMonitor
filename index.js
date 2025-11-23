const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs-extra");
const axios = require("axios");

puppeteer.use(StealthPlugin());

class FacebookGroupMonitor {
  constructor() {
    this.browser = null;
    this.mainPage = null;
    this.cookieFile = "fb_cookies.json";
    this.configFile = "config.json";
    this.resultsFile = "results.json";
    this.keywords = [];
    this.groupIds = [];
    this.existingResults = new Map();
    this.maxConcurrentTabs = 5;
    this.notificationConfig = null;
    this.scrollConfig = {
      maxScrolls: 30, // Tối đa 30 lần scroll
      maxNoNewPosts: 3, // Dừng sau 3 lần scroll không thấy bài mới
      scrollWaitMin: 2000, // Đợi tối thiểu 2s
      scrollWaitMax: 4000, // Đợi tối đa 4s
    };
  }

  async initBrowser() {
    console.log("🚀 Đang khởi động browser...");

    this.browser = await puppeteer.launch({
      headless: false,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--lang=vi-VN",
        "--disable-features=IsolateOrigins,site-per-process",
      ],
      defaultViewport: null,
    });

    this.mainPage = await this.browser.newPage();

    await this.mainPage.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    console.log("✅ Browser đã sẵn sàng");
  }

  async createCookieTemplate() {
    const template = {
      _comment: "Paste cookie từ Cookie Editor vào đây",
      cookies: [],
    };

    await fs.writeJson(this.cookieFile, template, { spaces: 2 });
    console.log(`✅ Đã tạo file mẫu: ${this.cookieFile}`);
  }

  async loadCookiesFromFile() {
    try {
      if (!(await fs.pathExists(this.cookieFile))) {
        console.log("⚠️ Không tìm thấy fb_cookies.json");
        await this.createCookieTemplate();
        return false;
      }

      let data = await fs.readJson(this.cookieFile);
      let cookies = Array.isArray(data) ? data : data.cookies || [];

      if (cookies.length === 0) {
        console.log("⚠️ Mảng cookies rỗng!");
        return false;
      }

      cookies = cookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || "/",
        expires: cookie.expirationDate || -1,
        httpOnly: cookie.httpOnly || false,
        secure: cookie.secure || false,
        sameSite: this.convertSameSite(cookie.sameSite),
      }));

      await this.mainPage.setCookie(...cookies);

      console.log(`✅ Đã load ${cookies.length} cookies`);
      return cookies;
    } catch (error) {
      console.error("❌ Lỗi khi đọc cookie:", error.message);
      return false;
    }
  }

  convertSameSite(sameSite) {
    if (!sameSite || sameSite === "no_restriction") return "None";
    if (sameSite === "lax") return "Lax";
    if (sameSite === "strict") return "Strict";
    return "Lax";
  }

  async checkLogin() {
    console.log("🔍 Kiểm tra đăng nhập...");

    try {
      await this.mainPage.goto("https://www.facebook.com", {
        waitUntil: "networkidle2",
        timeout: 30000,
      });

      await this.delay(3000);

      const hasLoginForm = await this.mainPage.evaluate(() => {
        return !!document.querySelector('input[name="email"]');
      });

      if (hasLoginForm) {
        console.log("❌ Cookie không hợp lệ");
        return false;
      }

      const userInfo = await this.mainPage.evaluate(() => {
        const cUserCookie = document.cookie
          .split(";")
          .find((c) => c.includes("c_user="));
        const userId = cUserCookie ? cUserCookie.split("=")[1].trim() : null;
        return { userId };
      });

      if (userInfo.userId) {
        console.log(`✅ Đăng nhập thành công! User ID: ${userInfo.userId}`);
        return true;
      }

      console.log("✅ Đã đăng nhập");
      return true;
    } catch (error) {
      console.error("❌ Lỗi check login:", error.message);
      return false;
    }
  }

  async refreshCookies() {
    console.log("🔄 Refresh cookies...");

    try {
      const newCookies = await this.mainPage.cookies();

      const cookieEditorFormat = newCookies.map((cookie) => ({
        domain: cookie.domain,
        expirationDate: cookie.expires,
        hostOnly: false,
        httpOnly: cookie.httpOnly,
        name: cookie.name,
        path: cookie.path,
        sameSite:
          cookie.sameSite === "None"
            ? "no_restriction"
            : (cookie.sameSite || "lax").toLowerCase(),
        secure: cookie.secure,
        session: cookie.expires === -1,
        value: cookie.value,
      }));

      await fs.writeJson(
        this.cookieFile,
        {
          cookies: cookieEditorFormat,
          lastUpdate: new Date().toISOString(),
        },
        { spaces: 2 }
      );

      console.log("✅ Cookies đã refresh");
      return true;
    } catch (error) {
      console.error("⚠️ Không thể refresh:", error.message);
      return false;
    }
  }

  async loadConfig() {
    try {
      if (await fs.pathExists(this.configFile)) {
        const config = await fs.readJson(this.configFile);
        this.keywords = config.keywords || [];
        this.groupIds = config.groupIds || [];
        this.maxConcurrentTabs = config.maxConcurrentTabs || 5;

        // Load scroll config
        if (config.scrollConfig) {
          this.scrollConfig = { ...this.scrollConfig, ...config.scrollConfig };
        }

        // Load notification config
        if (config.notification) {
          this.notificationConfig = config.notification;
        }

        console.log(
          `✅ Config: ${this.keywords.length} keywords, ${this.groupIds.length} groups`
        );
        console.log(
          `⚙️  Max tabs: ${this.maxConcurrentTabs}, Max scrolls: ${this.scrollConfig.maxScrolls}`
        );
        return true;
      }
    } catch (error) {
      console.log("⚠️ Không load được config");
    }
    return false;
  }

  async createDefaultConfig() {
    const config = {
      keywords: ["mua", "bán", "cần tìm", "thanh lý", "ship cod", "giá rẻ"],
      groupIds: [],
      maxConcurrentTabs: 5,
      scrollConfig: {
        maxScrolls: 30,
        maxNoNewPosts: 3,
        scrollWaitMin: 2000,
        scrollWaitMax: 4000,
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
        },
      },
    };

    await fs.writeJson(this.configFile, config, { spaces: 2 });
    this.keywords = config.keywords;
    this.groupIds = config.groupIds;

    console.log(`✅ Đã tạo config: ${this.configFile}`);
  }

  async loadExistingResults() {
    try {
      if (await fs.pathExists(this.resultsFile)) {
        const results = await fs.readJson(this.resultsFile);
        this.existingResults = new Map(
          results.map((item) => [item.postUrl, item])
        );
        console.log(`📂 Đã load ${this.existingResults.size} kết quả cũ`);
        return true;
      }
    } catch (error) {
      console.error("⚠️ Lỗi load results cũ:", error.message);
    }

    this.existingResults = new Map();
    return false;
  }

  mergeResult(newResult) {
    const existingResult = this.existingResults.get(newResult.postUrl);

    if (existingResult) {
      const updated = {
        ...existingResult,
        textPreview: newResult.textPreview,
        matchedKeywords: newResult.matchedKeywords,
        lastUpdated: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        scanCount: (existingResult.scanCount || 1) + 1,
      };

      this.existingResults.set(newResult.postUrl, updated);
      return { isNew: false, result: updated };
    } else {
      const created = {
        ...newResult,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        scanCount: 1,
      };

      this.existingResults.set(newResult.postUrl, created);
      return { isNew: true, result: created };
    }
  }

  hasKeyword(text) {
    if (!text) return false;
    const lowerText = text.toLowerCase();
    return this.keywords.some((kw) => lowerText.includes(kw.toLowerCase()));
  }

  getMatchedKeywords(text) {
    const lowerText = text.toLowerCase();
    return this.keywords.filter((kw) => lowerText.includes(kw.toLowerCase()));
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
    return await page.evaluate(() => {
      const scrollBefore = window.pageYOffset;
      const scrollHeight = document.documentElement.scrollHeight;
      const clientHeight = document.documentElement.clientHeight;

      // Scroll xuống 80% viewport
      window.scrollBy(0, clientHeight * 0.8);

      // Check scroll position
      const scrollAfter = window.pageYOffset;

      // Đã ở cuối trang
      if (scrollAfter + clientHeight >= scrollHeight - 100) {
        return false;
      }

      // Không scroll được (stuck)
      if (scrollAfter === scrollBefore) {
        return false;
      }

      return true;
    });
  }

  // ========== ĐỢI CONTENT LOAD ==========
  async waitForNewContent(page) {
    try {
      // Đợi loading spinner biến mất
      await page
        .waitForFunction(
          () => {
            const spinners = document.querySelectorAll('[role="progressbar"]');
            return spinners.length === 0;
          },
          { timeout: 5000 }
        )
        .catch(() => {});

      // Đợi có article
      await page
        .waitForFunction(
          () => {
            const articles = document.querySelectorAll('[role="article"]');
            return articles.length > 0;
          },
          { timeout: 3000 }
        )
        .catch(() => {});
    } catch (error) {
      // Timeout ok
    }
  }

  // ========== EXTRACT POSTS ==========
  async extractPosts(page) {
    return await page.evaluate(() => {
      const articles = document.querySelectorAll('[role="article"]');
      const data = [];

      articles.forEach((article) => {
        try {
          const text = article.innerText || "";

          // Link bài đăng
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

          // Tên tác giả
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

          // User ID
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
          });
        } catch (e) {
          // Skip
        }
      });

      return data;
    });
  }

  // ========== QUÉT 1 NHÓM VỚI SMART SCROLL ==========
  async scanGroupInTab(groupId, cookies, tabIndex) {
    let page = null;

    try {
      page = await this.browser.newPage();
      await page.setCookie(...cookies);

      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      );

      console.log(`\n[Tab ${tabIndex}] 📊 Quét nhóm: ${groupId}`);

      const url = `https://www.facebook.com/groups/${groupId}`;

      await page.goto(url, {
        waitUntil: "networkidle2",
        timeout: 60000,
      });

      await this.delay(3000);

      const canAccess = await page.evaluate(() => {
        const bodyText = document.body.innerText;
        return (
          !bodyText.includes("Nội dung không khả dụng") &&
          !bodyText.includes("Content Not Found") &&
          !bodyText.includes("Tham gia nhóm")
        );
      });

      if (!canAccess) {
        console.log(`[Tab ${tabIndex}] ⚠️ Không truy cập được nhóm`);
        await page.close();
        return { newPosts: [], updatedPosts: [] };
      }

      const newPosts = [];
      const updatedPosts = [];
      const processedUrls = new Set();

      // ========== SMART SCROLL LOOP ==========
      let noNewPostsCount = 0;
      let scrollCount = 0;
      const { maxScrolls, maxNoNewPosts, scrollWaitMin, scrollWaitMax } =
        this.scrollConfig;

      console.log(
        `[Tab ${tabIndex}] 🔄 Bắt đầu smart scroll (max: ${maxScrolls}, stop: ${maxNoNewPosts} lần không có mới)`
      );

      while (scrollCount < maxScrolls && noNewPostsCount < maxNoNewPosts) {
        scrollCount++;

        // Scroll xuống
        const scrolled = await this.smartScroll(page);

        if (!scrolled) {
          console.log(`[Tab ${tabIndex}]    ⚠️ Đã đến cuối feed`);
          break;
        }

        // Đợi content load
        await this.waitForNewContent(page);

        // Random delay
        const waitTime =
          scrollWaitMin + Math.random() * (scrollWaitMax - scrollWaitMin);
        await this.delay(waitTime);

        // Lấy tất cả posts hiện tại
        const posts = await this.extractPosts(page);

        // Process posts
        let foundNewInThisScroll = 0;

        for (let post of posts) {
          // Check trùng và keyword
          if (!processedUrls.has(post.postUrl)) {
            processedUrls.add(post.postUrl); // Đánh dấu đã xử lý

            if (this.hasKeyword(post.text)) {
              foundNewInThisScroll++;

              const newResult = {
                groupId,
                postId: this.extractPostId(post.postUrl),
                userId: post.userId,
                postUrl: post.postUrl,
                authorName: post.authorName,
                textPreview: post.text.substring(0, 300).replace(/\n/g, " "),
                matchedKeywords: this.getMatchedKeywords(post.text),
              };

              const { isNew, result } = this.mergeResult(newResult);

              if (isNew) {
                newPosts.push(result);
                console.log(
                  `[Tab ${tabIndex}]    🆕 ${result.authorName} | ${result.postId}`
                );
              } else {
                updatedPosts.push(result);
                console.log(
                  `[Tab ${tabIndex}]    🔄 ${result.authorName} | ${result.postId} (#${result.scanCount})`
                );
              }
            }
          }
        }

        // Check xem có bài mới không
        if (foundNewInThisScroll === 0) {
          noNewPostsCount++;
          console.log(
            `[Tab ${tabIndex}]    ⚪ Scroll ${scrollCount}/${maxScrolls} - Không có bài mới (${noNewPostsCount}/${maxNoNewPosts})`
          );
        } else {
          noNewPostsCount = 0; // Reset counter
          console.log(
            `[Tab ${tabIndex}]    ✅ Scroll ${scrollCount}/${maxScrolls} - Tìm thấy ${foundNewInThisScroll} bài phù hợp | Tổng: ${newPosts.length} mới, ${updatedPosts.length} update`
          );
        }
      }

      // Summary
      if (noNewPostsCount >= maxNoNewPosts) {
        console.log(
          `[Tab ${tabIndex}] ⏹️  Dừng: ${maxNoNewPosts} lần không có bài mới`
        );
      } else if (scrollCount >= maxScrolls) {
        console.log(`[Tab ${tabIndex}] ⏹️  Dừng: Đã đạt ${maxScrolls} scrolls`);
      }

      console.log(
        `[Tab ${tabIndex}] ✅ Hoàn thành - Mới: ${newPosts.length}, Update: ${updatedPosts.length} (${scrollCount} scrolls, ${processedUrls.size} posts đã xem)`
      );

      await page.close();
      return { newPosts, updatedPosts };
    } catch (error) {
      console.error(`[Tab ${tabIndex}] ❌ Lỗi:`, error.message);
      if (page) await page.close();
      return { newPosts: [], updatedPosts: [] };
    }
  }

  // ========== QUÉT TẤT CẢ NHÓM (SONG SONG) ==========
  async scanAllGroupsParallel(cookies) {
    if (this.groupIds.length === 0) {
      console.log("⚠️ Chưa có nhóm!");
      return { newPosts: [], updatedPosts: [] };
    }

    const allNewPosts = [];
    const allUpdatedPosts = [];

    // Chia batch
    const batches = [];
    for (let i = 0; i < this.groupIds.length; i += this.maxConcurrentTabs) {
      batches.push(this.groupIds.slice(i, i + this.maxConcurrentTabs));
    }

    console.log(
      `\n🔥 Chia thành ${batches.length} batch, mỗi batch ${this.maxConcurrentTabs} tabs\n`
    );

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];

      console.log(`\n${"=".repeat(60)}`);
      console.log(
        `📦 BATCH ${batchIndex + 1}/${batches.length} - ${batch.length} nhóm`
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

      console.log(`\n✅ Batch ${batchIndex + 1} hoàn thành!`);
      console.log(
        `   🆕 Mới: ${results.reduce((sum, r) => sum + r.newPosts.length, 0)}`
      );
      console.log(
        `   🔄 Update: ${results.reduce(
          (sum, r) => sum + r.updatedPosts.length,
          0
        )}`
      );

      if (batchIndex < batches.length - 1) {
        console.log(`\n⏳ Chờ 5s trước batch tiếp theo...`);
        await this.delay(5000);
      }
    }

    return { newPosts: allNewPosts, updatedPosts: allUpdatedPosts };
  }

  async saveResults() {
    const allResults = Array.from(this.existingResults.values());
    allResults.sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
    await fs.writeJson(this.resultsFile, allResults, { spaces: 2 });
    console.log(`\n💾 Đã lưu ${allResults.length} kết quả tổng`);
    return allResults;
  }

  // ========== GỬI THÔNG BÁO QUA TELEGRAM ==========
  async sendToTelegram(message) {
    if (!this.notificationConfig?.telegram) {
      return false;
    }

    const { botToken, chatId } = this.notificationConfig.telegram;

    if (!botToken || !chatId) {
      console.log("⚠️ Thiếu Telegram config (botToken hoặc chatId)");
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
        console.error("❌ Telegram API error:", response.data);
        return false;
      }
    } catch (error) {
      console.error("❌ Lỗi gửi Telegram:", error.message);
      return false;
    }
  }

  // ========== GỬI THÔNG BÁO QUA ZALO ==========
  async sendToZalo(message) {
    if (!this.notificationConfig?.zalo) {
      return false;
    }

    const { accessToken, groupId, webhookUrl } = this.notificationConfig.zalo;

    // Nếu có webhookUrl (Zalo Webhook), dùng webhook
    if (webhookUrl) {
      try {
        const response = await axios.post(webhookUrl, {
          text: message,
        });

        if (response.status === 200) {
          return true;
        }
      } catch (error) {
        console.error("❌ Lỗi gửi Zalo Webhook:", error.message);
        return false;
      }
    }

    // Nếu dùng Zalo Official Account API
    if (!accessToken || !groupId) {
      console.log("⚠️ Thiếu Zalo config (accessToken/groupId hoặc webhookUrl)");
      return false;
    }

    try {
      // Zalo Official Account API - Gửi tin nhắn vào group
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
        console.error("❌ Zalo API error:", response.data);
        return false;
      }
    } catch (error) {
      console.error("❌ Lỗi gửi Zalo:", error.message);
      return false;
    }
  }

  // ========== GỬI BÀI VIẾT MỚI ==========
  async sendNewPosts(newPosts) {
    if (!newPosts || newPosts.length === 0) {
      return;
    }

    if (!this.notificationConfig) {
      console.log("⚠️ Chưa cấu hình notification");
      return;
    }

    console.log(`\n📤 Đang gửi ${newPosts.length} bài mới...`);

    for (let post of newPosts) {
      // Gửi Telegram
      if (this.notificationConfig.telegram?.enabled) {
        const telegramMessage = this.formatPostMessage(post, "telegram");
        await this.sendToTelegram(telegramMessage);
        await this.delay(1000); // Delay 1s giữa các tin nhắn
      }

      // Gửi Zalo
      if (this.notificationConfig.zalo?.enabled) {
        const zaloMessage = this.formatPostMessage(post, "zalo");
        await this.sendToZalo(zaloMessage);
        await this.delay(1000); // Delay 1s giữa các tin nhắn
      }
    }

    console.log(`✅ Đã gửi ${newPosts.length} bài mới`);
  }

  // ========== FORMAT MESSAGE ==========
  formatPostMessage(post, platform = "telegram") {
    const keywords = post.matchedKeywords.join(", ");
    const preview = post.textPreview.length > 500 
      ? post.textPreview.substring(0, 500) + "..." 
      : post.textPreview;

    if (platform === "telegram") {
      // Format cho Telegram (HTML)
      return `
🆕 <b>BÀI VIẾT MỚI</b>

👤 <b>Tác giả:</b> ${post.authorName}
📂 <b>Nhóm:</b> ${post.groupId}
🔍 <b>Từ khóa:</b> ${keywords}

📝 <b>Nội dung:</b>
${preview.replace(/</g, "&lt;").replace(/>/g, "&gt;")}

🔗 <a href="${post.postUrl}">Xem bài viết</a>
`;
    } else {
      // Format cho Zalo (plain text)
      return `
🆕 BÀI VIẾT MỚI

👤 Tác giả: ${post.authorName}
📂 Nhóm: ${post.groupId}
🔍 Từ khóa: ${keywords}

📝 Nội dung:
${preview}

🔗 ${post.postUrl}
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
    console.log("📊 THỐNG KÊ");
    console.log("=".repeat(60));
    console.log(`📝 Tổng: ${stats.total} bài`);
    console.log(`🆕 Hôm nay: ${stats.today} bài`);

    console.log("\n📂 Theo nhóm:");
    Object.entries(stats.byGroup).forEach(([groupId, count]) => {
      console.log(`   ${groupId}: ${count} bài`);
    });

    console.log("\n🔍 Top keywords:");
    Object.entries(stats.byKeyword)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .forEach(([kw, count]) => {
        console.log(`   "${kw}": ${count} bài`);
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
    console.log("  FACEBOOK GROUP MONITOR - SMART SCROLL MODE");
    console.log("=".repeat(60) + "\n");

    await monitor.initBrowser();

    const cookies = await monitor.loadCookiesFromFile();
    if (!cookies) {
      console.log("\n❌ Không load được cookies!\n");
      await monitor.close();
      return;
    }

    const isLoggedIn = await monitor.checkLogin();
    if (!isLoggedIn) {
      console.log("\n❌ Cookie không hợp lệ!\n");
      await monitor.close();
      return;
    }

    await monitor.refreshCookies();

    const hasConfig = await monitor.loadConfig();
    if (!hasConfig) {
      await monitor.createDefaultConfig();
    }

    if (monitor.groupIds.length === 0) {
      console.log("\n⚠️ Chưa có nhóm trong config.json\n");
      await monitor.close();
      return;
    }

    await monitor.loadExistingResults();

    console.log("\n" + "=".repeat(60));
    console.log("🔍 BẮT ĐẦU QUÉT (SMART SCROLL + MULTI-TAB)");
    console.log("=".repeat(60));
    console.log(`📝 Keywords: ${monitor.keywords.join(", ")}`);
    console.log(`📂 Tổng: ${monitor.groupIds.length} nhóm`);
    console.log(`🖥️  Max tabs: ${monitor.maxConcurrentTabs} tabs/batch`);
    console.log(
      `🔄 Scroll: max ${monitor.scrollConfig.maxScrolls}, stop sau ${monitor.scrollConfig.maxNoNewPosts} lần không có mới`
    );
    console.log("=".repeat(60));

    const { newPosts, updatedPosts } = await monitor.scanAllGroupsParallel(
      cookies
    );

    await monitor.saveResults();

    // Gửi thông báo bài mới
    if (newPosts.length > 0) {
      await monitor.sendNewPosts(newPosts);
    }

    const stats = monitor.getStats();
    monitor.printStats(stats);

    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);

    console.log("\n" + "=".repeat(60));
    console.log("✅ HOÀN THÀNH");
    console.log("=".repeat(60));
    console.log(`⏱️  Thời gian: ${duration} phút`);
    console.log(`🆕 Bài mới: ${newPosts.length}`);
    console.log(`🔄 Bài cập nhật: ${updatedPosts.length}`);
    console.log(`📊 Tổng database: ${stats.total} bài`);
    console.log(`📁 JSON: ${monitor.resultsFile}`);
    console.log("=".repeat(60) + "\n");
  } catch (error) {
    console.error("\n❌ LỖI:", error.message);
    console.error(error.stack);
  } finally {
    await monitor.close();
    process.exit(0);
  }
}

main();
