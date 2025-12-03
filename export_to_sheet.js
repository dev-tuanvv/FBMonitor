const { google } = require("googleapis");
const fs = require("fs-extra");

async function exportAllPostsToSheet() {
  try {
    console.log("Dang export toan bo bai viet vao Google Sheet...");

    // Load results.json
    const results = await fs.readJson("results.json");
    console.log(`Tim thay ${results.length} bai viet trong results.json`);

    if (results.length === 0) {
      console.log("Khong co bai viet nao de export");
      return;
    }

    // Load config để lấy Sheet ID
    const config = await fs.readJson("config.json");
    const sheetConfig = config.notification?.googleSheet;

    if (!sheetConfig || !sheetConfig.enabled) {
      console.log("Google Sheet chua duoc bat trong config.json");
      return;
    }

    // Init Google Sheets API
    const auth = new google.auth.GoogleAuth({
      keyFile: sheetConfig.serviceAccountKeyFile,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const client = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: client });

    const sheetId = sheetConfig.sheetId;

    // Tạo header
    const header = [
      "Thời gian quét",
      "Nhóm",
      "Tác giả",
      "Link bài viết",
      "Từ khóa",
      "Nội dung preview",
      "Thời gian đăng",
      "Lần đầu thấy",
      "Lần cuối thấy",
    ];

    // Chuyển đổi dữ liệu
    const values = results.map((post) => [
      new Date().toLocaleString("vi-VN"), // Thời gian quét (thời điểm export)
      post.groupId,
      post.authorName,
      post.postUrl,
      post.matchedKeywords.join(", "),
      post.textPreview,
      post.timestamp
        ? new Date(post.timestamp).toLocaleString("vi-VN")
        : "Unknown",
      post.firstSeen
        ? new Date(post.firstSeen).toLocaleString("vi-VN")
        : "Unknown",
      post.lastSeen
        ? new Date(post.lastSeen).toLocaleString("vi-VN")
        : "Unknown",
    ]);

    // Xóa dữ liệu cũ (nếu có) và ghi header + data mới
    console.log("Dang xoa du lieu cu...");
    await sheets.spreadsheets.values.clear({
      spreadsheetId: sheetId,
      range: "A1:Z10000", // Xóa toàn bộ sheet
    });

    console.log("Dang ghi du lieu moi...");
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: "A1",
      valueInputOption: "USER_ENTERED",
      resource: {
        values: [header, ...values],
      },
    });

    // Format header (bold, background color)
    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        resource: {
          requests: [
            {
              repeatCell: {
                range: {
                  startRowIndex: 0,
                  endRowIndex: 1,
                  startColumnIndex: 0,
                  endColumnIndex: 9,
                },
                cell: {
                  userEnteredFormat: {
                    backgroundColor: {
                      red: 0.2,
                      green: 0.6,
                      blue: 0.9,
                    },
                    textFormat: {
                      foregroundColor: {
                        red: 1.0,
                        green: 1.0,
                        blue: 1.0,
                      },
                      bold: true,
                    },
                  },
                },
                fields: "userEnteredFormat(backgroundColor,textFormat)",
              },
            },
            // Auto-resize columns
            {
              autoResizeDimensions: {
                dimensions: {
                  sheetId: 0,
                  dimension: "COLUMNS",
                  startIndex: 0,
                  endIndex: 9,
                },
              },
            },
          ],
        },
      });
    } catch (formatError) {
      console.log("Khong the format sheet (co the do quyen han):", formatError.message);
    }

    console.log(`\n✅ Export thanh cong!`);
    console.log(`   - Da ghi ${results.length} bai viet vao Google Sheet`);
    console.log(`   - Header: ${header.length} cot`);
    console.log(`\nMở Google Sheet để xem kết quả:`);
    console.log(`https://docs.google.com/spreadsheets/d/${sheetId}/edit`);
  } catch (error) {
    console.error("❌ Loi khi export:", error.message);
    if (error.response) {
      console.error("Chi tiet loi:", JSON.stringify(error.response.data, null, 2));
    }
  }
}

exportAllPostsToSheet();

