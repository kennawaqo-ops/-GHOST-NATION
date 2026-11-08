require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const app = express();
const db = new Database(process.env.DB_PATH || "orders.db");
app.use(express.json({ limit: "20kb" }));
app.use(express.static("public"));

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  package_name TEXT NOT NULL,
  payment_reference TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS packages (
  name TEXT PRIMARY KEY,
  price INTEGER NOT NULL DEFAULT 0
);
`);

const defaultPackages = [
  ["100 Coins", 0],
  ["550 Coins", 0],
  ["1040 Coins", 0]
];
const insertPackage = db.prepare(
  "INSERT OR IGNORE INTO packages (name, price) VALUES (?, ?)"
);
for (const item of defaultPackages) insertPackage.run(...item);

function verifyTelegramInitData(initData) {
  if (!process.env.BOT_TOKEN || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) return null;
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`).join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData")
    .update(process.env.BOT_TOKEN).digest();
  const calculated = crypto.createHmac("sha256", secretKey)
    .update(dataCheckString).digest("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(calculated, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const user = JSON.parse(params.get("user") || "{}");
    return user.id ? user : null;
  } catch {
    return null;
  }
}

function getUser(req, res, next) {
  const user = verifyTelegramInitData(req.get("x-telegram-init-data"));
  if (!user) return res.status(401).json({ error: "Open this app inside Telegram." });
  req.telegramUser = user;
  next();
}

function adminOnly(req, res, next) {
  const expected = process.env.ADMIN_KEY;
  const supplied = req.get("x-admin-key") || "";
  if (!expected || supplied.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    return res.status(401).json({ error: "Incorrect admin key." });
  }
  next();
}

app.get("/api/config", (_req, res) => {
  const packages = db.prepare("SELECT name, price FROM packages ORDER BY rowid").all();
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
    return res.status(400).json({ error: "This package is not available yet. Please contact the shop admin." });
  }
  const result = db.prepare(
    "INSERT INTO orders (telegram_id, customer_name, package_name, payment_reference) VALUES (?, ?, ?, ?)"
  ).run(String(req.telegramUser.id), String(customerName).slice(0, 80),
        selectedPackage.name, String(paymentReference).slice(0, 120));
  res.json({ ok: true, orderId: result.lastInsertRowid, status: "pending" });
});

app.get("/api/orders", getUser, (req, res) => {
  const orders = db.prepare(
    "SELECT id, package_name, status, created_at FROM orders WHERE telegram_id = ? ORDER BY id DESC"
  ).all(String(req.telegramUser.id));
  res.json({ orders });
});

app.get("/api/admin/packages", adminOnly, (_req, res) => {
  res.json({ packages: db.prepare("SELECT name, price FROM packages ORDER BY rowid").all() });
});

app.put("/api/admin/packages/:name", adminOnly, (req, res) => {
  const price = Number(req.body && req.body.price);
  if (!Number.isSafeInteger(price) || price < 1 || price > 10000000) {
    return res.status(400).json({ error: "Enter a whole-number price greater than 0 ETB." });
  }
  const result = db.prepare("UPDATE packages SET price = ? WHERE name = ?")
    .run(price, req.params.name);
  if (!result.changes) return res.status(404).json({ error: "Package not found." });
  res.json({ ok: true });
});

app.get("/api/admin/orders", adminOnly, (_req, res) => {
  res.json({ orders: db.prepare("SELECT * FROM orders ORDER BY id DESC LIMIT 300").all() });
});

app.post("/api/admin/orders/:id/status", adminOnly, (req, res) => {
  const status = ["pending", "paid", "rejected"].includes(req.body.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ error: "Invalid status." });
  const result = db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, req.params.id);
  res.json({ ok: result.changes > 0 });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`GHOST_NATION app listening on ${port}`));
