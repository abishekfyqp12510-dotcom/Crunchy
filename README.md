# Smart Canteen – Online Food Pre-Order System

A static HTML/CSS/JavaScript front end backed by Supabase (PostgreSQL, Auth, Realtime).
No build step is needed.

## Files

```
smart-canteen/
├── index.html          Student app: login, menu, cart, my orders
├── admin.html          Admin dashboard: live orders, menu, sales report
├── css/styles.css
├── js/config.js        Your Supabase URL and anon key
├── js/app.js           All app logic (student + admin)
├── supabase/schema.sql Tables, security rules, order functions, sample menu
└── README.md
```

## 1. Create the Supabase project

1. Go to supabase.com, create a project, and wait for it to provision.
2. Open **SQL Editor**, paste the entire `supabase/schema.sql`, and click **Run**.
3. Open **Authentication > Providers > Email** and turn off **Confirm email** for local testing.
   (Turn it back on before real use. The signup flow handles both cases.)

## 2. Connect the app

Open `js/config.js` and paste your values from **Project Settings > API**:

```js
export const SUPABASE_URL = "https://xxxx.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOi...";
```

Use only the **anon public** key here. Never put the `service_role` key in the browser.

## 3. Create the first admin

1. Open `index.html` locally (or through a local server, see below), choose **Create account**, and sign up with your admin email.
2. In the Supabase SQL Editor, promote that account:

```sql
update profiles set role = 'admin' where student_id = 'YOUR-ID';
```

3. Open `admin.html` and log in. Existing admins can promote others the same way.

Local server (needed because the app uses ES modules):

```bash
npx serve .        # or: python -m http.server 8000
```

## 4. Deploy

Push this folder to a GitHub repo, then import the repo in **Vercel** or **Netlify**.
Framework preset: *Other / None*. Output directory: `/` (the root). No build command.

Add your deployed domain under **Authentication > URL Configuration** in Supabase.

## How it works

| Rule | Where it is enforced |
|---|---|
| Students see only their own orders | Row Level Security on `orders`, `order_items`, `order_status_history` |
| Only admins edit the menu or change order status | RLS policies + `is_admin()` checks in functions |
| Students cannot make themselves admin | `protect_role` trigger on `profiles` |
| Prices and totals come from the database | `place_order()` reads prices itself; the browser only sends item IDs and quantities |
| No overselling | `place_order()` locks rows, checks stock and availability, and rolls back the whole order if anything fails |
| Stock is returned on cancel or reject | `apply_status()` |
| Cancel only before preparation starts | `cancel_order()` allows only `Pending` or `Accepted` |
| Live updates | Supabase Realtime on `menu_items`, `orders`, and `notifications` |

## Order status flow

`Pending → Accepted → Preparing → Ready for Pickup → Completed`
Admins can also set `Rejected`. Students can set `Cancelled` while the order is still `Pending` or `Accepted`.

## Known limits of this version

- **Images** are entered as URLs. To upload files, create a public bucket in Supabase Storage and upload from `admin.html`.
- **Modifying an order** is not included. Students can cancel and reorder. Adding an `update_order` function is the next step.
- **Notifications** appear as in-app toasts and in the database table. Browser push or email needs an extra service.
- **Reports** are a 31-day summary plus a CSV download. Monthly PDF reports would need a library.
- **Daily menu**: students see items whose `menu_date` is today. Admins schedule future days by setting the date when adding an item.
- **Sample data** in `schema.sql` is for testing. Delete it before going live:
  `delete from menu_items;`
