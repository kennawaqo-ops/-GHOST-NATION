
require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY");
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

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
    console.error("Telegram verification failed:", error.message);
    return null;
  }
}

function getUser(req, res, next) {
  const user = verifyTelegramInitData(
    req.get("x-telegram-init-data") || ""
  );

  if (!user) {
    return res.status(401).json({
      error: "Telegram verification failed. Reopen the shop using the bot."
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

  if (
    typeof value !== "string" ||
    value.length > 1400000 ||
    !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value)
  ) {
    throw new Error("Choose a JPG, PNG or WEBP image smaller than about 1 MB.");
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

function dbError(error) {
  console.error("Supabase error:", error.message);
  return error.code === "23505"
    ? "A package with this name already exists."
    : "Database error. Please try again.";
}

// Create default packages only when they do not already exist.
async function initializePackages() {
  const defaults = [
    { name: "100 Coins", price: 0, image_data: "", sort_order: 1 },
    { name: "550 Coins", price: 0, image_data: "", sort_order: 2 },
    { name: "1040 Coins", price: 0, image_data: "", sort_order: 3 }
  ];

  const { error } = await supabase
    .from("packages")
    .upsert(defaults, {
      onConflict: "name",
      ignoreDuplicates: true
    });

  if (error) throw error;

  console.log("Supabase packages initialized.");
}

// Customer shop configuration
app.get("/api/config", async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("packages")
      .select("name, price, image_data")
      .order("sort_order", { ascending: true });

    if (error) throw error;

    const packages = (data || []).map(item => ({
      name: item.name,
      price: Number(item.price),
      imageData: item.image_data || ""
    }));

    res.json({
      paymentProvider: process.env.PAYMENT_PROVIDER || "Manual payment",
      paymentName: process.env.PAYMENT_ACCOUNT_NAME || "",
      paymentNumber: process.env.PAYMENT_ACCOUNT_NUMBER || "",
      currency: "ETB",
      packages
    });
  } catch (error) {
    res.status(500).json({ error: dbError(error) });
  }
});

// Submit customer order
app.post("/api/orders", getUser, async (req, res) => {
  try {
    const { customerName, packageName, paymentReference } = req.body || {};

    if (!customerName || !packageName || !paymentReference) {
      return res.status(400).json({
        error: "Please complete all fields."
      });
    }

    const { data: selectedPackage, error: packageError } = await supabase
      .from("packages")
      .select("name, price")
      .eq("name", String(packageName))
      .maybeSingle();

    if (packageError) throw packageError;

    if (!selectedPackage || Number(selectedPackage.price) <= 0) {
      return res.status(400).json({
        error: "This package is not available yet. Contact the shop admin."
      });
    }

    const customer = String(customerName).trim().slice(0, 80);
    const reference = String(paymentReference).trim().slice(0, 120);

    if (!customer || !reference) {
      return res.status(400).json({
        error: "Please complete all fields."
      });
    }

    const user = req.telegramUser;

    const { data: order, error } = await supabase
      .from("orders")
      .insert({
        telegram_id: String(user.id),
        telegram_username: String(user.username || ""),
        customer_name: customer,
        package_name: selectedPackage.name,
        payment_reference: reference
      })
      .select("id")
      .single();

    if (error) throw error;

    const username = user.username
      ? "@" + user.username
      : "Not provided";

    const notice =
      `🛒 GHOST_NATION — New order #${order.id}\n` +
      `Customer: ${customer}\n` +
      `Telegram: ${username}\n` +
      `Package: ${selectedPackage.name}\n` +
      `Payment reference: ${reference}\n` +
      `Status: PENDING\n\n` +
      `Open Admin Panel: ${process.env.PUBLIC_URL || ""}/admin.html`;

    if (process.env.ADMIN_TELEGRAM_ID) {
      sendTelegramMessage(process.env.ADMIN_TELEGRAM_ID, notice);
    }

    res.json({
      ok: true,
      orderId: order.id,
      status: "pending"
    });
  } catch (error) {
    res.status(500).json({ error: dbError(error) });
  }
});

// Customer order history
app.get("/api/orders", getUser, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("orders")
      .select("id, package_name, status, created_at")
      .eq("telegram_id", String(req.telegramUser.id))
      .order("id", { ascending: false });

    if (error) throw error;

    res.json({ orders: data || [] });
  } catch (error) {
    res.status(500).json({ error: dbError(error) });
  }
});

// Admin package list
app.get("/api/admin/packages", adminOnly, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("packages")
      .select("name, price, image_data")
      .order("sort_order", { ascending: true });

    if (error) throw error;

    res.json({
      packages: (data || []).map(item => ({
        name: item.name,
        price: Number(item.price),
        imageData: item.image_data || ""
      }))
    });
  } catch (error) {
    res.status(500).json({ error: dbError(error) });
  }
});

// Add package
app.post("/api/admin/packages", adminOnly, async (req, res) => {
  try {
    const name = cleanPackageName(req.body && req.body.name);
    const price = cleanPrice(req.body && req.body.price);
    const imageData = cleanImageData(req.body && req.body.imageData);

    const { data: last, error: readError } = await supabase
      .from("packages")
      .select("sort_order")
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (readError) throw readError;

    const { error } = await supabase
      .from("packages")
      .insert({
        name,
        price,
        image_data: imageData,
        sort_order: Number(last?.sort_order || 0) + 1
      });

    if (error) throw error;

    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({
      error: error.code === "23505"
        ? "A package with this name already exists."
        : error.message || "Could not add package."
    });
  }
});

// Update package
app.put("/api/admin/packages/:name", adminOnly, async (req, res) => {
  try {
    const price = cleanPrice(req.body && req.body.price);
    const hasImage = Object.prototype.hasOwnProperty.call(
      req.body || {},
      "imageData"
    );

    const update = { price };

    if (hasImage) {
      update.image_data = cleanImageData(req.body.imageData);
    }

    const { data, error } = await supabase
      .from("packages")
      .update(update)
      .eq("name", req.params.name)
      .select("name")
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({ error: "Package not found." });
    }

    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not update package." });
  }
});

// Delete package
app.delete("/api/admin/packages/:name", adminOnly, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("packages")
      .delete()
      .eq("name", req.params.name)
      .select("name")
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({ error: "Package not found." });
    }

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: dbError(error) });
  }
});

// Admin order list
app.get("/api/admin/orders", adminOnly, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .order("id", { ascending: false })
      .limit(300);

    if (error) throw error;

    res.json({ orders: data || [] });
  } catch (error) {
    res.status(500).json({ error: dbError(error) });
  }
});

// Approve or reject order
app.post("/api/admin/orders/:id/status", adminOnly, async (req, res) => {
  try {
    const status = ["pending", "paid", "rejected"].includes(req.body?.status)
      ? req.body.status
      : null;

    if (!status) {
      return res.status(400).json({ error: "Invalid status." });
    }

    const { data: order, error: readError } = await supabase
      .from("orders")
      .select("*")
      .eq("id", req.params.id)
      .maybeSingle();

    if (readError) throw readError;

    if (!order) {
      return res.status(404).json({ error: "Order not found." });
    }

    const { error: updateError } = await supabase
      .from("orders")
      .update({ status })
      .eq("id", req.params.id);

    if (updateError) throw updateError;

    if (order.status !== status && status !== "pending") {
      const message = status === "paid"
        ? `✅ GHOST_NATION: Your order #${order.id} (${order.package_name}) has been approved. Contact @Ghosstt141 for the next step.`
        : `❌ GHOST_NATION: Your order #${order.id} (${order.package_name}) was not approved. Please contact @Ghosstt141.`;

      sendTelegramMessage(order.telegram_id, message);
    }

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: dbError(error) });
  }
});

const port = process.env.PORT || 3000;

initializePackages()
  .then(() => {
    app.listen(port, () => {
      console.log(`GHOST_NATION app listening on ${port}`);
    });
  })
  .catch(error => {
    console.error("Supabase initialization failed:", error.message);
    process.exit(1);
  });
