const puppeteer = require("puppeteer-extra");
const fs = require("fs-extra");

function convertSameSite(sameSite) {
  if (!sameSite || sameSite === "no_restriction") return "None";
  if (sameSite === "lax") return "Lax";
  if (sameSite === "strict") return "Strict";
  return "Lax";
}

async function createCookieTemplate(cookieFile) {
  const template = {
    _comment: "Paste cookie tu Cookie Editor vao day",
    cookies: [],
  };
  await fs.writeJson(cookieFile, template, { spaces: 2 });
  console.log(`Da tao file mau: ${cookieFile}`);
}

async function loadCookiesFromFile(mainPage, cookieFile) {
  try {
    if (!(await fs.pathExists(cookieFile))) {
      console.log("Khong tim thay fb_cookies.json");
      await createCookieTemplate(cookieFile);
      return false;
    }

    let data = await fs.readJson(cookieFile);
    let cookies = Array.isArray(data) ? data : data.cookies || [];
    if (cookies.length === 0) {
      console.log("Mang cookies rong!");
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
      sameSite: convertSameSite(cookie.sameSite),
    }));

    await mainPage.setCookie(...cookies);
    console.log(`Da load ${cookies.length} cookies`);
    return true;
  } catch (error) {
    console.error("Loi khi doc cookie:", error.message);
    return false;
  }
}

async function checkLogin(mainPage, CONSTANTS) {
  try {
    await mainPage.goto("https://www.facebook.com", {
      waitUntil: "networkidle2",
      timeout: CONSTANTS.TIMEOUTS.LOGIN_CHECK,
    });

    await new Promise(r => setTimeout(r, CONSTANTS.DELAYS.CHECK_LOGIN));

    const hasLoginForm = await mainPage.evaluate(() => {
      return !!document.querySelector('input[name="email"]');
    });

    if (hasLoginForm) {
      console.log("Cookie khong hop le (hien form login)");
      return false;
    }

    const userInfo = await mainPage.evaluate(() => {
      const cUserCookie = document.cookie
        .split(";")
        .find((c) => c.includes("c_user="));
      const userId = cUserCookie ? cUserCookie.split("=")[1].trim() : null;
      return { userId };
    });

    if (userInfo.userId) {
      console.log(`Dang nhap thanh cong, userId: ${userInfo.userId}`);
      return true;
    }

    console.log("Da dang nhap (khong tim thay userId cu the)");
    return true;
  } catch (error) {
    console.error("Loi check login:", error.message);
    return false;
  }
}

async function refreshCookies(mainPage, cookieFile) {
  try {
    const newCookies = await mainPage.cookies();

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
      cookieFile,
      {
        cookies: cookieEditorFormat,
        lastUpdate: new Date().toISOString(),
      },
      { spaces: 2 }
    );

    console.log("Cookies da duoc refresh");
    return true;
  } catch (error) {
    console.error("Khong the refresh cookies:", error.message);
    return false;
  }
}

/**
 * Initialize browser with cookies and login check.
 * Returns { browser, mainPage } after setting up user agent, cookies, and verifying login.
 */
async function initBrowser(CONSTANTS, cookieFile) {
  const launchArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--lang=vi-VN",
    "--disable-features=IsolateOrigins,site-per-process",
    "--disable-dev-shm-usage",
  ];

  try {
    console.log("Dang khoi dong browser...");
    const browser = await puppeteer.launch({
      headless: true,
      args: launchArgs,
      defaultViewport: null,
      ignoreHTTPSErrors: true,
    });

    const mainPage = await browser.newPage();
    await mainPage.setUserAgent(CONSTANTS.USER_AGENT);

    // Load cookies
    await loadCookiesFromFile(mainPage, cookieFile);

    // Check login
    const loginOk = await checkLogin(mainPage, CONSTANTS);
    if (!loginOk) {
      console.log("Login check failed");
    }

    console.log("Browser da san sang");
    return { browser, mainPage };
  } catch (error) {
    console.log(`Loi khoi dong browser: ${error.message}`);
    throw error;
  }
}

module.exports = {
  initBrowser,
  checkLogin,
  loadCookiesFromFile,
  refreshCookies,
  convertSameSite,
};