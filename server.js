require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const app = express();
const db = new Database(process.env.DB_PATH || "orders.db");
app.use(express.json());
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
)`);

function verifyTelegramInitData(initData) {
  if (!process.env.BOT_TOKEN || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`).join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData")
    .update(process.env.BOT_TOKEN).digest();
  const calculated = crypto.createHmac("sha256", secretKey)
    .update(dataCheckString).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(calculated, "hex"))) return null;
  const user = JSON.parse(params.get("user") || "{}");
  return user.id ? user : null;
}

function getUser(req, res, next) {
  const user = verifyTelegramInitData(req.get("x-telegram-init-data"));
  if (!user) return res.status(401).json({ error: "Open this app inside Telegram." });
  req.telegramUser = user;
  next();
}

app.get("/api/config", (_req, res) => {
  res.json({
    paymentProvider: process.env.PAYMENT_PROVIDER || "Manual payment",
    paymentName: process.env.PAYMENT_ACCOUNT_NAME || "Set payment name in server settings",
    paymentNumber: process.env.PAYMENT_ACCOUNT_NUMBER || "Set payment number in server settings",
    currency: "ETB",
    packages: [
      { name: "100 Coins", price: 0 },
      { name: "550 Coins", price: 0 },
      { name: "1040 Coins", price: 0 }
    ]
  });
});

app.post("/api/orders", getUser, (req, res) => {
  const { customerName, packageName, paymentReference } = req.body || {};
  if (!customerName || !packageName || !paymentReference) {
    return res.status(400).json({ error: "Please complete all fields." });
  }
  const result = db.prepare(
    "INSERT INTO orders (telegram_id, customer_name, package_name, payment_reference) VALUES (?, ?, ?, ?)"
  ).run(String(req.telegramUser.id), String(customerName).slice(0, 80),
        String(packageName).slice(0, 80), String(paymentReference).slice(0, 120));
  res.json({ ok: true, orderId: result.lastInsertRowid, status: "pending" });
});

app.get("/api/orders", getUser, (req, res) => {
  const orders = db.prepare(
    "SELECT id, package_name, status, created_at FROM orders WHERE telegram_id = ? ORDER BY id DESC"
  ).all(String(req.telegramUser.id));
  res.json({ orders });
});

function adminOnly(req, res, next) {
  const key = req.get("x-admin-key");
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}
app.get("/api/admin/orders", adminOnly, (_req, res) => {
  res.json({ orders: db.prepare("SELECT * FROM orders ORDER BY id DESC").all() });
});
app.post("/api/admin/orders/:id/status", adminOnly, (req, res) => {
  const status = ["pending", "paid", "rejected"].includes(req.body.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ error: "Invalid status" });
  const result = db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, req.params.id);
  res.json({ ok: result.changes > 0 });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`GHOST_NATION app listening on ${port}`));