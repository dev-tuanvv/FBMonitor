const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs-extra');

puppeteer.use(StealthPlugin());

class FacebookGroupMonitor {
  constructor() {
    this.browser = null;
    this.page = null;
    this.cookieFile = 'fb_cookies.json';
    this.configFile = 'config.json';
    this.resultsFile = 'results.json';
    this.keywords = [];
    this.groupIds = [];
  }

  async initBrowser() {
    console.log('🚀 Đang khởi động browser...');

    this.browser = await puppeteer.launch({
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--lang=vi-VN'
      ],
      defaultViewport: null
    });

    this.page = await this.browser.newPage();

    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    console.log('✅ Browser đã sẵn sàng');
  }

  // Tạo file cookie mẫu
  async createCookieTemplate() {
    const template = {
      "_comment": "Paste cookie từ Cookie Editor vào đây (thay thế mảng cookies bên dưới)",
      "cookies": [
        {
          "domain": ".facebook.com",
          "expirationDate": 1773154865.974922,
          "hostOnly": false,
          "httpOnly": true,
          "name": "datr",
          "path": "/",
          "sameSite": "no_restriction",
          "secure": true,
          "session": false,
          "value": "YOUR_COOKIE_VALUE_HERE"
        }
      ]
    };

    await fs.writeJson(this.cookieFile, template, { spaces: 2 });
    console.log(`✅ Đã tạo file mẫu: ${this.cookieFile}`);
    console.log('📝 Vui lòng paste cookie vào file này và chạy lại!');
  }

  // Đọc và validate cookie từ file
  async loadCookiesFromFile() {
    try {
      if (!await fs.pathExists(this.cookieFile)) {
        console.log('⚠️ Không tìm thấy file fb_cookies.json');
        await this.createCookieTemplate();
        return false;
      }

      const data = await fs.readJson(this.cookieFile);

      // Validate
      if (!data.cookies || !Array.isArray(data.cookies)) {
        console.log('❌ Format cookie không đúng!');
        console.log('⚠️ File phải có dạng: { "cookies": [...] }');
        return false;
      }

      if (data.cookies.length === 0) {
        console.log('⚠️ Mảng cookies rỗng!');
        return false;
      }

      // Check xem có phải cookie mẫu không
      if (data.cookies[0].value === 'YOUR_COOKIE_VALUE_HERE') {
        console.log('⚠️ Vui lòng thay thế cookie mẫu bằng cookie thật!');
        console.log('📌 Hướng dẫn:');
        console.log('   1. Cài Cookie-Editor extension');
        console.log('   2. Đăng nhập Facebook');
        console.log('   3. Click Cookie-Editor > Export');
        console.log('   4. Copy và paste vào fb_cookies.json');
        return false;
      }

      // Convert sang format Puppeteer
      const cookies = data.cookies.map(cookie => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || '/',
        expires: cookie.expirationDate || -1,
        httpOnly: cookie.httpOnly || false,
        secure: cookie.secure || false,
        sameSite: this.convertSameSite(cookie.sameSite)
      }));

      // Set cookies
      await this.page.setCookie(...cookies);

      console.log(`✅ Đã load ${cookies.length} cookies từ file`);
      return true;

    } catch (error) {
      console.error('❌ Lỗi khi đọc cookie:', error.message);

      if (error.message.includes('Unexpected token')) {
        console.log('⚠️ File JSON không hợp lệ! Kiểm tra lại format.');
      }

      return false;
    }
  }

  // Convert sameSite
  convertSameSite(sameSite) {
    if (!sameSite || sameSite === 'no_restriction') return 'None';
    if (sameSite === 'lax') return 'Lax';
    if (sameSite === 'strict') return 'Strict';
    return 'Lax';
  }

  // Kiểm tra đăng nhập
  async checkLogin() {
    console.log('🔍 Kiểm tra trạng thái đăng nhập...');

    try {
      await this.page.goto('https://www.facebook.com', {
        waitUntil: 'networkidle2',
        timeout: 30000
      });

      await this.delay(3000);

      // Check form đăng nhập
      const hasLoginForm = await this.page.evaluate(() => {
        return !!document.querySelector('input[name="email"]');
      });

      if (hasLoginForm) {
        console.log('❌ Cookie không hợp lệ - vẫn thấy form đăng nhập');
        return false;
      }

      // Check đã vào được Facebook chưa
      const currentUrl = this.page.url();
      if (currentUrl.includes('login') || currentUrl.includes('checkpoint')) {
        console.log('❌ Cookie hết hạn hoặc tài khoản bị checkpoint');
        return false;
      }

      // Lấy tên user
      const userInfo = await this.page.evaluate(() => {
        // Tìm user ID từ cookie
        const cUserCookie = document.cookie.split(';').find(c => c.includes('c_user='));
        const userId = cUserCookie ? cUserCookie.split('=')[1].trim() : null;

        // Tìm tên
        const selectors = [
          'div[aria-label*="Tài khoản"] span',
          'a[aria-label*="Trang cá nhân"] span',
          'span[dir="auto"]'
        ];

        let userName = null;
        for (let selector of selectors) {
          const el = document.querySelector(selector);
          if (el && el.textContent.trim()) {
            userName = el.textContent.trim();
            break;
          }
        }

        return { userId, userName };
      });

      if (userInfo.userId) {
        console.log(`✅ Đăng nhập thành công!`);
        console.log(`👤 User ID: ${userInfo.userId}`);
        if (userInfo.userName) {
          console.log(`👤 Tên: ${userInfo.userName}`);
        }
        return true;
      }

      console.log('✅ Đã đăng nhập (không lấy được thông tin)');
      return true;

    } catch (error) {
      console.error('❌ Lỗi khi check login:', error.message);
      return false;
    }
  }

  // Refresh và lưu cookies mới
  async refreshCookies() {
    console.log('🔄 Đang refresh cookies...');

    try {
      await this.page.goto('https://www.facebook.com', {
        waitUntil: 'networkidle2',
        timeout: 30000
      });

      await this.delay(2000);

      const newCookies = await this.page.cookies();

      // Convert về Cookie Editor format
      const cookieEditorFormat = newCookies.map(cookie => ({
        domain: cookie.domain,
        expirationDate: cookie.expires,
        hostOnly: false,
        httpOnly: cookie.httpOnly,
        name: cookie.name,
        path: cookie.path,
        sameSite: cookie.sameSite === 'None' ? 'no_restriction' : (cookie.sameSite || 'lax').toLowerCase(),
        secure: cookie.secure,
        session: cookie.expires === -1,
        value: cookie.value
      }));

      await fs.writeJson(this.cookieFile, {
        cookies: cookieEditorFormat,
        lastUpdate: new Date().toISOString()
      }, { spaces: 2 });

      console.log('✅ Cookies đã được refresh và lưu lại');
      return true;
    } catch (error) {
      console.error('⚠️ Không thể refresh cookies:', error.message);
      return false;
    }
  }

  // Load config
  async loadConfig() {
    try {
      if (await fs.pathExists(this.configFile)) {
        const config = await fs.readJson(this.configFile);
        this.keywords = config.keywords || [];
        this.groupIds = config.groupIds || [];
        console.log(`✅ Loaded config: ${this.keywords.length} keywords, ${this.groupIds.length} groups`);
        return true;
      }
    } catch (error) {
      console.log('⚠️ Không load được config');
    }
    return false;
  }

  // Tạo config mặc định
  async createDefaultConfig() {
    const config = {
      keywords: [
        'mua',
        'bán',
        'cần tìm',
        'thanh lý',
        'ship cod',
        'giá rẻ',
        'inbox',
        'zalo'
      ],
      groupIds: [
        // Thêm ID nhóm vào đây
        // VD: "274780009358113"
      ]
    };

    await fs.writeJson(this.configFile, config, { spaces: 2 });
    this.keywords = config.keywords;
    this.groupIds = config.groupIds;

    console.log(`✅ Đã tạo file config: ${this.configFile}`);
  }

  // Check keyword
  hasKeyword(text) {
    if (!text) return false;
    const lowerText = text.toLowerCase();
    return this.keywords.some(kw => lowerText.includes(kw.toLowerCase()));
  }

  // Get matched keywords
  getMatchedKeywords(text) {
    const lowerText = text.toLowerCase();
    return this.keywords.filter(kw => lowerText.includes(kw.toLowerCase()));
  }

  // Extract Post ID
  extractPostId(url) {
    const patterns = [
      /\/posts\/(\d+)/,
      /\/permalink\/(\d+)/,
      /story_fbid=(\d+)/,
      /pfbid[a-zA-Z0-9]+/
    ];

    for (let pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1] || match[0];
    }

    return url.split('?')[0].split('/').pop();
  }

  // Lấy bài đăng từ nhóm
  async getGroupPosts(groupId, maxScroll = 5) {
    console.log(`\n📊 Đang quét nhóm: ${groupId}`);

    const url = `https://www.facebook.com/groups/${groupId}`;

    try {
      await this.page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: 60000
      });

      await this.delay(3000);

      // Check có vào được nhóm không
      const canAccess = await this.page.evaluate(() => {
        const bodyText = document.body.innerText;
        return !bodyText.includes('Nội dung không khả dụng') &&
          !bodyText.includes('Content Not Found') &&
          !bodyText.includes('Tham gia nhóm');
      });

      if (!canAccess) {
        console.log(`⚠️ Không thể truy cập nhóm ${groupId}`);
        console.log('   → Kiểm tra: Đã join nhóm chưa? Nhóm có tồn tại?');
        return [];
      }

      const results = [];
      const processedUrls = new Set();

      for (let i = 0; i < maxScroll; i++) {
        // Scroll
        await this.page.evaluate(() => {
          window.scrollBy(0, window.innerHeight);
        });

        await this.delay(2000 + Math.random() * 1000);

        // Lấy bài đăng
        const posts = await this.page.evaluate(() => {
          const articles = document.querySelectorAll('[role="article"]');
          const data = [];

          articles.forEach(article => {
            try {
              const text = article.innerText || '';

              // Link bài đăng
              const links = article.querySelectorAll('a[href]');
              let postUrl = '';

              for (let link of links) {
                const href = link.href;
                if (href.includes('/posts/') ||
                  href.includes('/permalink/') ||
                  href.includes('story_fbid=')) {
                  postUrl = href.split('?')[0];
                  break;
                }
              }

              if (!postUrl) return;

              // Tên người đăng
              let authorName = 'Unknown';
              const nameSelectors = [
                'h2 span.x193iq5w',
                'h3 span.x193iq5w',
                'h4 span',
                'a[role="link"] strong span',
                'strong span'
              ];

              for (let sel of nameSelectors) {
                const nameEl = article.querySelector(sel);
                if (nameEl && nameEl.textContent.trim()) {
                  authorName = nameEl.textContent.trim();
                  break;
                }
              }

              // User ID
              let userId = '';
              const profileLink = article.querySelector('a[href*="/user/"], a[href*="/profile.php?id="]');
              if (profileLink) {
                const href = profileLink.href;
                const userMatch = href.match(/\/user\/(\d+)/);
                const idMatch = href.match(/id=(\d+)/);
                userId = userMatch ? userMatch[1] : (idMatch ? idMatch[1] : '');
              }

              data.push({
                text,
                postUrl,
                authorName,
                userId: userId || 'unknown'
              });

            } catch (e) {
              // Skip
            }
          });

          return data;
        });

        // Filter
        for (let post of posts) {
          if (!processedUrls.has(post.postUrl) && this.hasKeyword(post.text)) {
            processedUrls.add(post.postUrl);

            const result = {
              groupId,
              postId: this.extractPostId(post.postUrl),
              userId: post.userId,
              postUrl: post.postUrl,
              authorName: post.authorName,
              textPreview: post.text.substring(0, 300).replace(/\n/g, ' '),
              matchedKeywords: this.getMatchedKeywords(post.text),
              timestamp: new Date().toISOString()
            };

            results.push(result);
            console.log(`   ✅ ${result.authorName} | Post: ${result.postId}`);
          }
        }

        console.log(`   Scroll ${i + 1}/${maxScroll} - Tìm thấy ${results.length} bài`);
      }

      return results;

    } catch (error) {
      console.error(`❌ Lỗi nhóm ${groupId}:`, error.message);
      return [];
    }
  }

  // Quét tất cả nhóm
  async scanAllGroups(maxScroll = 5) {
    if (this.groupIds.length === 0) {
      console.log('⚠️ Chưa có nhóm trong config!');
      return [];
    }

    const allResults = [];

    for (let i = 0; i < this.groupIds.length; i++) {
      const groupId = this.groupIds[i];
      console.log(`\n[${i + 1}/${this.groupIds.length}] Nhóm: ${groupId}`);

      const results = await this.getGroupPosts(groupId, maxScroll);
      allResults.push(...results);

      if (i < this.groupIds.length - 1) {
        await this.delay(3000 + Math.random() * 2000);
      }
    }

    return allResults;
  }

  // Lưu kết quả
  async saveResults(results) {
    let allResults = [];

    if (await fs.pathExists(this.resultsFile)) {
      allResults = await fs.readJson(this.resultsFile);
    }

    allResults.push(...results);

    // Remove duplicates
    const uniqueResults = Array.from(
      new Map(allResults.map(item => [item.postUrl, item])).values()
    );

    uniqueResults.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    await fs.writeJson(this.resultsFile, uniqueResults, { spaces: 2 });
    console.log(`\n💾 Lưu: ${uniqueResults.length} tổng (${results.length} mới)`);
  }

  // Export CSV
  async exportCSV(filename = 'results.csv') {
    if (!await fs.pathExists(this.resultsFile)) {
      return;
    }

    const results = await fs.readJson(this.resultsFile);

    const csvRows = [
      ['STT', 'Thời gian', 'Nhóm ID', 'Tác giả', 'User ID', 'Post ID', 'Keywords', 'URL', 'Nội dung']
    ];

    results.forEach((r, i) => {
      csvRows.push([
        i + 1,
        new Date(r.timestamp).toLocaleString('vi-VN'),
        r.groupId,
        `"${r.authorName}"`,
        r.userId,
        r.postId,
        `"${r.matchedKeywords.join(', ')}"`,
        r.postUrl,
        `"${r.textPreview.replace(/"/g, '""')}"`
      ]);
    });

    const csvContent = csvRows.map(row => row.join(',')).join('\n');
    await fs.writeFile(filename, '\ufeff' + csvContent, 'utf8');

    console.log(`📄 Export CSV: ${results.length} bài`);
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

  try {
    console.log('\n' + '='.repeat(60));
    console.log('  FACEBOOK GROUP MONITOR');
    console.log('='.repeat(60) + '\n');

    // 1. Khởi tạo browser
    await monitor.initBrowser();

    // 2. Load cookies từ file
    const cookieLoaded = await monitor.loadCookiesFromFile();

    if (!cookieLoaded) {
      console.log('\n❌ Không thể load cookies!');
      console.log('📝 Vui lòng:');
      console.log('   1. Mở file fb_cookies.json');
      console.log('   2. Paste cookie từ Cookie-Editor');
      console.log('   3. Chạy lại: node index.js\n');
      await monitor.close();
      return;
    }

    // 3. Kiểm tra đăng nhập
    const isLoggedIn = await monitor.checkLogin();

    if (!isLoggedIn) {
      console.log('\n❌ Cookie không hợp lệ!');
      console.log('📝 Vui lòng cập nhật cookie mới vào fb_cookies.json\n');
      await monitor.close();
      return;
    }

    // 4. Refresh cookies
    await monitor.refreshCookies();

    // 5. Load config
    const hasConfig = await monitor.loadConfig();
    if (!hasConfig) {
      await monitor.createDefaultConfig();
    }

    if (monitor.groupIds.length === 0) {
      console.log('\n⚠️ Chưa có nhóm!');
      console.log('📝 Vui lòng thêm groupIds vào config.json\n');
      await monitor.close();
      return;
    }

    // 6. Quét
    console.log('\n' + '='.repeat(60));
    console.log('🔍 BẮT ĐẦU QUÉT');
    console.log('='.repeat(60));
    console.log(`📝 Keywords: ${monitor.keywords.join(', ')}`);
    console.log(`📂 Nhóm: ${monitor.groupIds.length}`);
    console.log('='.repeat(60));

    const results = await monitor.scanAllGroups(5);

    // 7. Lưu
    if (results.length > 0) {
      await monitor.saveResults(results);
      await monitor.exportCSV();
    }

    // 8. Tổng kết
    console.log('\n' + '='.repeat(60));
    console.log('✅ HOÀN THÀNH');
    console.log('='.repeat(60));
    console.log(`📊 Kết quả: ${results.length} bài đăng mới`);
    console.log(`📁 JSON: ${monitor.resultsFile}`);
    console.log(`📄 CSV: results.csv`);
    console.log('='.repeat(60) + '\n');

  } catch (error) {
    console.error('\n❌ LỖI:', error.message);
  } finally {
    await monitor.close();
    process.exit(0);
  }
}

main();