
require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const app = express();
const db = new Database(process.env.DB_PATH || "orders.db");

app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL,
  telegram_username TEXT NOT NULL DEFAULT '',
  customer_name TEXT NOT NULL,
  package_name TEXT NOT NULL,
  payment_reference TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS packages (
  name TEXT PRIMARY KEY,
  price INTEGER NOT NULL DEFAULT 0,
  image_data TEXT NOT NULL DEFAULT ''
);
`);

const orderColumns = db.prepare("PRAGMA table_info(orders)").all().map(c => c.name);
if (!orderColumns.includes("telegram_username")) {
  db.exec("ALTER TABLE orders ADD COLUMN telegram_username TEXT NOT NULL DEFAULT ''");
}

const packageColumns = db.prepare("PRAGMA table_info(packages)").all().map(c => c.name);
if (!packageColumns.includes("image_data")) {
  db.exec("ALTER TABLE packages ADD COLUMN image_data TEXT NOT NULL DEFAULT ''");
}

async function sendTelegramMessage(chatId, message) {
  if (!process.env.BOT_TOKEN || !chatId) return false;

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: String(chatId),
          text: message,
          disable_web_page_preview: true
        })
      }
    );

    const result = await response.json();
    return response.ok && result.ok === true;
  } catch (error) {
    console.error("Telegram notification failed:", error.message);
    return false;
  }
}

const defaultPackages = [
  ["100 Coins", 0],
  ["550 Coins", 0],
  ["1040 Coins", 0]
];

const insertPackage = db.prepare(
  "INSERT OR IGNORE INTO packages (name, price) VALUES (?, ?)"
);

for (const item of defaultPackages) {
  insertPackage.run(...item);
}

function verifyTelegramInitData(initData) {
  if (!process.env.BOT_TOKEN || typeof initData !== "string" || !initData) {
    return null;
  }

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");

    if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) return null;

    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(process.env.BOT_TOKEN)
      .digest();

    const calculatedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    const received = Buffer.from(hash, "hex");
    const calculated = Buffer.from(calculatedHash, "hex");

    if (
      received.length !== calculated.length ||
      !crypto.timingSafeEqual(received, calculated)
    ) {
      return null;
    }

    const user = JSON.parse(params.get("user") || "{}");
    return user && user.id ? user : null;
  } catch (error) {
    console.error("Telegram initData verification failed:", error.message);
    return null;
  }
}

function getUser(req, res, next) {
  const initData = req.get("x-telegram-init-data") || "";
  const user = verifyTelegramInitData(initData);

  if (!user) {
    return res.status(401).json({
      error: "Telegram verification failed. Close the shop and reopen it using the Telegram bot."
    });
  }

  req.telegramUser = user;
  next();
}

function adminOnly(req, res, next) {
  const expected = process.env.ADMIN_KEY;
  const supplied = req.get("x-admin-key") || "";

  if (
    !expected ||
    supplied.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
  ) {
    return res.status(401).json({ error: "Incorrect admin key." });
  }

  next();
}

function cleanImageData(value) {
  if (value === undefined || value === null || value === "") return "";

  if (typeof value !== "string" || value.length > 1400000) {
    throw new Error("Image is too large. Choose an image smaller than about 1 MB.");
  }

  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) {
    throw new Error("Use a JPG, PNG, or WEBP image.");
  }

  return value;
}

function cleanPackageName(value) {
  const name = String(value || "").trim();

  if (!name || name.length > 60) {
    throw new Error("Package name must be 1–60 characters.");
  }

  return name;
}

function cleanPrice(value) {
  const price = Number(value);

  if (!Number.isSafeInteger(price) || price < 1 || price > 10000000) {
    throw new Error("Enter a whole-number price greater than 0 ETB.");
  }

  return price;
}

app.get("/api/config", (_req, res) => {
  const packages = db.prepare(
    "SELECT name, price, image_data AS imageData FROM packages ORDER BY rowid"
  ).all();

  res.json({
    paymentProvider: process.env.PAYMENT_PROVIDER || "Manual payment",
    paymentName: process.env.PAYMENT_ACCOUNT_NAME || "Set payment name in server settings",
    paymentNumber: process.env.PAYMENT_ACCOUNT_NUMBER || "Set payment number in server settings",
    currency: "ETB",
    packages
  });
});

app.post("/api/orders", getUser, (req, res) => {
  const { customerName, packageName, paymentReference } = req.body || {};

  if (!customerName || !packageName || !paymentReference) {
    return res.status(400).json({ error: "Please complete all fields." });
  }

  const selectedPackage = db.prepare(
    "SELECT name, price FROM packages WHERE name = ?"
  ).get(String(packageName));

  if (!selectedPackage || selectedPackage.price <= 0) {
    return res.status(400).json({
      error: "This package is not available yet. Please contact the shop admin."
    });
  }

  const customer = String(customerName).trim().slice(0, 80);
  const reference = String(paymentReference).trim().slice(0, 120);

  if (!customer || !reference) {
    return res.status(400).json({ error: "Please complete all fields." });
  }

  const user = req.telegramUser;

  const result = db.prepare(`
    INSERT INTO orders
    (telegram_id, telegram_username, customer_name, package_name, payment_reference)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    String(user.id),
    String(user.username || ""),
    customer,
    selectedPackage.name,
    reference
  );

  const orderId = result.lastInsertRowid;
  const username = user.username ? "@" + user.username : "Not provided";

  const notice =
    `🛒 GHOST_NATION — New order #${orderId}\n` +
    `Customer: ${customer}\n` +
    `Telegram: ${username}\n` +
    `Package: ${selectedPackage.name}\n` +
    `Payment reference: ${reference}\n` +
    `Status: PENDING\n\n` +
    `Open Admin Panel: ${process.env.PUBLIC_URL || ""}/admin.html`;

  if (process.env.ADMIN_TELEGRAM_ID) {
    sendTelegramMessage(process.env.ADMIN_TELEGRAM_ID, notice);
  }

  res.json({ ok: true, orderId, status: "pending" });
});

app.get("/api/orders", getUser, (req, res) => {
  const orders = db.prepare(`
    SELECT id, package_name, status, created_at
    FROM orders
    WHERE telegram_id = ?
    ORDER BY id DESC
  `).all(String(req.telegramUser.id));

  res.json({ orders });
});

app.get("/api/admin/packages", adminOnly, (_req, res) => {
  const packages = db.prepare(
    "SELECT name, price, image_data AS imageData FROM packages ORDER BY rowid"
  ).all();

  res.json({ packages });
});

app.post("/api/admin/packages", adminOnly, (req, res) => {
  try {
    const name = cleanPackageName(req.body && req.body.name);
    const price = cleanPrice(req.body && req.body.price);
    const imageData = cleanImageData(req.body && req.body.imageData);

    db.prepare(
      "INSERT INTO packages (name, price, image_data) VALUES (?, ?, ?)"
    ).run(name, price, imageData);

    res.json({ ok: true });
  } catch (error) {
    const duplicate = String(error.message).includes("UNIQUE constraint");

    res.status(400).json({
      error: duplicate ? "A package with this name already exists." : error.message
    });
  }
});

app.put("/api/admin/packages/:name", adminOnly, (req, res) => {
  try {
    const price = cleanPrice(req.body && req.body.price);
    const hasImage = Object.prototype.hasOwnProperty.call(req.body || {}, "imageData");
    const imageData = hasImage ? cleanImageData(req.body.imageData) : undefined;

    const result = hasImage
      ? db.prepare(
          "UPDATE packages SET price = ?, image_data = ? WHERE name = ?"
        ).run(price, imageData, req.params.name)
      : db.prepare(
          "UPDATE packages SET price = ? WHERE name = ?"
        ).run(price, req.params.name);

    if (!result.changes) {
      return res.status(404).json({ error: "Package not found." });
    }

    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete("/api/admin/packages/:name", adminOnly, (req, res) => {
  const result = db.prepare(
    "DELETE FROM packages WHERE name = ?"
  ).run(req.params.name);

  if (!result.changes) {
    return res.status(404).json({ error: "Package not found." });
  }

  res.json({ ok: true });
});

app.get("/api/admin/orders", adminOnly, (_req, res) => {
  const orders = db.prepare(
    "SELECT * FROM orders ORDER BY id DESC LIMIT 300"
  ).all();

  res.json({ orders });
});

app.post("/api/admin/orders/:id/status", adminOnly, (req, res) => {
  const status = ["pending", "paid", "rejected"].includes(req.body.status)
    ? req.body.status
    : null;

  if (!status) {
    return res.status(400).json({ error: "Invalid status." });
  }

  const order = db.prepare(
    "SELECT * FROM orders WHERE id = ?"
  ).get(req.params.id);

  if (!order) {
    return res.status(404).json({ error: "Order not found." });
  }

  const result = db.prepare(
    "UPDATE orders SET status = ? WHERE id = ?"
  ).run(status, req.params.id);

  if (result.changes && order.status !== status && status !== "pending") {
    const customerMessage = status === "paid"
      ? `✅ GHOST_NATION: Your order #${order.id} (${order.package_name}) has been approved. Contact @Ghosstt141 for the next step.`
      : `❌ GHOST_NATION: Your order #${order.id} (${order.package_name}) was not approved. Please contact @Ghosstt141.`;

    sendTelegramMessage(order.telegram_id, customerMessage);
  }

  res.json({ ok: result.changes > 0 });
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`GHOST_NATION app listening on ${port}`);
});
