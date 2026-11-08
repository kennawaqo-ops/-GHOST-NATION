# GHOST_NATION Telegram Mini App

Starter project for an eFootball coin shop using Telegram Mini Apps, manual payment and ETB.

## Important
- This is starter code, not a deployed/live shop.
- Package prices are placeholders (0 ETB). Set real prices in `server.js` before launch.
- Add payment details only in your private hosting environment variables. Do not post bank details, bot tokens, passwords or admin keys in chats.
- Manual payment is not automatically verified. An admin must review the payment reference and update the order status.
- The SQLite database needs persistent storage on your hosting provider. If the host has temporary storage, orders may disappear after restart.

## Run locally
1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and fill values privately.
4. Run `npm start`.
5. Expose the app through an HTTPS host before connecting it to Telegram.

## Telegram setup
In BotFather, choose your bot and configure its Mini App URL after deploying the app to HTTPS. The URL must be public and secure.

## Admin API
Use `GET /api/admin/orders` with header `x-admin-key: YOUR_ADMIN_KEY`.
Update status with `POST /api/admin/orders/ORDER_ID/status` and JSON body `{"status":"paid"}` or `{"status":"rejected"}`.
