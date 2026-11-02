import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => "₹" + Number(n).toFixed(2);
const slug = (s) => s.toLowerCase().replace(/\s+/g, "-");
const todayStr = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local
const toast = (msg) => {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3500);
};

// ---------- AUTH (shared) ----------

async function getProfile() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;
  const { data } = await sb.from("profiles").select("*").eq("id", user.id).maybeSingle();
  return data;
}

function bindAuth(onLoggedIn) {
  $("#auth-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const email = f.get("email");
    const password = f.get("password");

    if (f.get("mode") === "signup") {
      const { data, error } = await sb.auth.signUp({ email, password });
      if (error) return toast(error.message);
      if (!data.session) return toast("Check your email to confirm, then log in.");
      const { error: pErr } = await sb.from("profiles").insert({
        id: data.user.id,
        full_name: f.get("name"),
        student_id: f.get("student_id"),
        department: f.get("department"),
      });
      if (pErr) return toast(pErr.message);
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) return toast(error.message);
    }
    onLoggedIn();
  };

  const modeSel = $("#mode");
  if (modeSel) {
    modeSel.onchange = () => {
      const signup = modeSel.value === "signup";
      document.querySelector(".signup-only").hidden = !signup;
    };
  }
  $("#logout").onclick = async () => {
    await sb.auth.signOut();
    location.reload();
  };
}

async function boot(requiredRole) {
  const profile = await getProfile();
  $("#logout").hidden = false;
  if (!profile) {
    $("#auth").hidden = false;
    bindAuth(() => location.reload());
    return null;
  }
  if (requiredRole && profile.role !== requiredRole) {
    $("#app").hidden = true;
    $("#auth").hidden = true;
    $("#denied").hidden = false;
    return null;
  }
  $("#app").hidden = false;
  return profile;
}

// ============================================================
// STUDENT PAGE
// ============================================================

const state = { cat: "all", q: "", cart: new Map(), menu: [] };

async function initStudent() {
  const profile = await boot(null);
  if (!profile) return;
  if (profile.role === "admin") {
    location.href = "admin.html";
    return;
  }
  $("#greet").textContent = `Hi ${profile.full_name.split(" ")[0]}`;

  const min = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString().slice(0, 16);
  $("#pickup").min = min;

  // Tabs
  document.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.onclick = () => showView(btn.dataset.tab);
  });

  // Filters
  $("#search").oninput = (e) => { state.q = e.target.value.trim(); renderMenu(); };
  document.querySelectorAll("[data-cat]").forEach((btn) => {
    btn.onclick = () => {
      state.cat = btn.dataset.cat;
      document.querySelectorAll("[data-cat]").forEach((b) => b.classList.toggle("on", b === btn));
      renderMenu();
    };
  });

  // Add / remove from cart
  $("#menu").onclick = (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const id = btn.dataset.id;
    const item = state.menu.find((m) => m.id === id);
    const cur = state.cart.get(id)?.qty || 0;
    if (btn.dataset.act === "inc") {
      if (cur >= item.stock) return toast(`Only ${item.stock} left`);
      state.cart.set(id, { item, qty: cur + 1 });
    } else {
      cur <= 1 ? state.cart.delete(id) : state.cart.set(id, { item, qty: cur - 1 });
    }
    renderMenu();
    renderCart();
  };

  $("#place").onclick = placeOrder;
  $("#orders-list").onclick = async (e) => {
    const id = e.target.dataset.cancel;
    if (!id || !confirm("Cancel this order?")) return;
    const { error } = await sb.rpc("cancel_order", { p_order: id });
    if (error) return toast(error.message);
    toast("Order cancelled. Items returned to stock.");
    loadOrders();
    loadMenu();
  };

  // Live updates
  sb.channel("student-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "menu_items" }, loadMenu)
    .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, loadOrders)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications" },
      (p) => toast(p.new.message))
    .subscribe();

  await Promise.all([loadMenu(), loadOrders()]);
}

function showView(name) {
  document.querySelectorAll("[data-view]").forEach((v) => (v.hidden = v.dataset.view !== name));
  document.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
}

async function loadMenu() {
  const { data, error } = await sb.from("menu_items").select("*")
    .eq("menu_date", todayStr()).order("category").order("name");
  if (error) return toast(error.message);
  state.menu = data;
  renderMenu();
  renderCart();
}

function renderMenu() {
  const q = state.q.toLowerCase();
  const items = state.menu.filter((m) =>
    (state.cat === "all" || m.category === state.cat) && m.name.toLowerCase().includes(q));

  $("#menu").innerHTML = items.length
    ? items.map((m) => {
        const out = !m.is_available || m.stock <= 0;
        const inCart = state.cart.get(m.id)?.qty || 0;
        const control = out
          ? `<span class="tag">Sold out</span>`
          : inCart
          ? `<div class="qty">
               <button data-act="dec" data-id="${m.id}" aria-label="Remove one">−</button>
               <span>${inCart}</span>
               <button data-act="inc" data-id="${m.id}" aria-label="Add one">+</button>
             </div>`
          : `<button class="add" data-act="inc" data-id="${m.id}">Add</button>`;
        return `
          <article class="card ${out ? "out" : ""}">
            <div class="thumb">${m.image_url
              ? `<img src="${esc(m.image_url)}" alt="${esc(m.name)}">`
              : `<span>${esc(m.name[0])}</span>`}</div>
            <div class="body">
              <h3>${esc(m.name)}</h3>
              <p>${esc(m.description || "")}</p>
              <p class="meta">${m.category} · ${out ? "unavailable" : m.stock + " left"}</p>
              <div class="row"><strong>${money(m.price)}</strong>${control}</div>
            </div>
          </article>`;
      }).join("")
    : `<p class="empty">Nothing matches. Try another category or search.</p>`;
}

function renderCart() {
  const lines = [...state.cart.values()];
  const total = lines.reduce((s, l) => s + l.item.price * l.qty, 0);
  $("#cart-lines").innerHTML = lines.length
    ? lines.map((l) => `<li><span>${esc(l.item.name)} × ${l.qty}</span><span>${money(l.item.price * l.qty)}</span></li>`).join("")
    : `<li class="empty">Your cart is empty.</li>`;
  $("#cart-total").textContent = money(total);
  $("#place").disabled = lines.length === 0;
}

async function placeOrder() {
  const pickup = $("#pickup").value;
  if (!pickup) return toast("Choose a pickup time");
  const items = [...state.cart].map(([id, v]) => ({ menu_item_id: id, quantity: v.qty }));
  const { error } = await sb.rpc("place_order", {
    p_items: items,
    p_pickup: new Date(pickup).toISOString(),
  });
  if (error) {
    toast(error.message);
    return loadMenu();
  }
  state.cart.clear();
  $("#pickup").value = "";
  renderCart();
  await Promise.all([loadMenu(), loadOrders()]);
  showView("orders");
  toast("Order placed. You'll be notified as it moves along.");
}

async function loadOrders() {
  const { data, error } = await sb.from("orders")
    .select("*, order_items(item_name, quantity)")
    .order("created_at", { ascending: false });
  if (error) return toast(error.message);
  $("#orders-list").innerHTML = data.length
    ? data.map((o) => `
        <article class="card order">
          <div class="row">
            <strong>#${o.id.slice(0, 8).toUpperCase()}</strong>
            <span class="status s-${slug(o.status)}">${esc(o.status)}</span>
          </div>
          <p>${o.order_items.map((i) => `${esc(i.item_name)} × ${i.quantity}`).join(", ")}</p>
          <p class="meta">Pickup ${new Date(o.pickup_time).toLocaleString()} · Total ${money(o.total)}</p>
          ${["Pending", "Accepted"].includes(o.status)
            ? `<button class="ghost" data-cancel="${o.id}">Cancel order</button>` : ""}
        </article>`).join("")
    : `<p class="empty">No orders yet. Pick something from the menu.</p>`;
}

// ============================================================
// ADMIN PAGE
// ============================================================

const STATUSES = ["Pending", "Accepted", "Preparing", "Ready for Pickup", "Completed", "Rejected", "Cancelled"];

async function initAdmin() {
  const profile = await boot("admin");
  if (!profile) return;
  $("#greet").textContent = `Admin · ${profile.full_name}`;

  document.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.onclick = () => showView(btn.dataset.tab);
  });

  // Orders: change status
  $("#orders-list").onchange = async (e) => {
    if (!e.target.matches("select[data-order]")) return;
    const { error } = await sb.rpc("set_order_status", {
      p_order: e.target.dataset.order, p_status: e.target.value,
    });
    if (error) toast(error.message);
    else toast(`Status set to ${e.target.value}`);
    loadOrders();
  };

  // Menu: save a row, delete, or add new
  $("#menu-admin").onclick = async (e) => {
    const row = e.target.closest("tr[data-id]");
    if (!row) return;
    const id = row.dataset.id;
    if (e.target.dataset.act === "save") {
      const { error } = await sb.from("menu_items").update({
        price: Number(row.querySelector('[name="price"]').value),
        stock: Number(row.querySelector('[name="stock"]').value),
        is_available: row.querySelector('[name="available"]').checked,
      }).eq("id", id);
      toast(error ? error.message : "Saved");
    }
    if (e.target.dataset.act === "delete" && confirm("Delete this item?")) {
      const { error } = await sb.from("menu_items").delete().eq("id", id);
      if (error) toast(error.message);
      loadMenu();
    }
  };

  $("#add-item").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const { error } = await sb.from("menu_items").insert({
      name: f.get("name"),
      description: f.get("description"),
      price: Number(f.get("price")),
      stock: Number(f.get("stock")),
      category: f.get("category"),
      image_url: f.get("image_url") || null,
      menu_date: f.get("menu_date") || todayStr(),
      is_available: true,
    });
    if (error) return toast(error.message);
    e.target.reset();
    toast("Item added");
    loadMenu();
  };

  $("#export-csv").onclick = exportSales;

  sb.channel("admin-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, loadOrders)
    .on("postgres_changes", { event: "*", schema: "public", table: "menu_items" }, loadMenu)
    .subscribe();

  await Promise.all([loadOrders(), loadMenu(), loadSales()]);
}

async function loadOrders() {
  const { data, error } = await sb.from("orders")
    .select("*, profiles(full_name, student_id, department), order_items(item_name, quantity, unit_price)")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return toast(error.message);
  $("#orders-list").innerHTML = data.length
    ? data.map((o) => `
        <article class="card order">
          <div class="row">
            <strong>#${o.id.slice(0, 8).toUpperCase()}</strong>
            <span class="meta">${new Date(o.created_at).toLocaleString()}</span>
          </div>
          <p>${esc(o.profiles?.full_name)} · ${esc(o.profiles?.student_id)} · ${esc(o.profiles?.department)}</p>
          <p>${o.order_items.map((i) => `${esc(i.item_name)} × ${i.quantity}`).join(", ")}</p>
          <p class="meta">Pickup ${new Date(o.pickup_time).toLocaleString()} · Total ${money(o.total)}</p>
          <label>Status
            <select data-order="${o.id}">
              ${STATUSES.map((s) => `<option ${s === o.status ? "selected" : ""}>${s}</option>`).join("")}
            </select>
          </label>
        </article>`).join("")
    : `<p class="empty">No orders yet.</p>`;
  loadSales();
}

async function loadMenu() {
  const { data, error } = await sb.from("menu_items").select("*")
    .order("menu_date", { ascending: false }).order("category").order("name");
  if (error) return toast(error.message);
  $("#menu-admin").innerHTML = `
    <table>
      <thead><tr><th>Item</th><th>Date</th><th>Category</th><th>Price ₹</th><th>Stock</th><th>Available</th><th></th></tr></thead>
      <tbody>${data.map((m) => `
        <tr data-id="${m.id}">
          <td>${esc(m.name)}</td>
          <td>${m.menu_date}</td>
          <td>${m.category}</td>
          <td><input name="price" type="number" min="0" step="0.5" value="${m.price}"></td>
          <td><input name="stock" type="number" min="0" value="${m.stock}"></td>
          <td><input name="available" type="checkbox" ${m.is_available ? "checked" : ""}></td>
          <td>
            <button data-act="save">Save</button>
            <button class="ghost" data-act="delete">Delete</button>
          </td>
        </tr>`).join("")}
      </tbody>
    </table>`;
}

// Sales summary (excludes cancelled and rejected orders)
let salesRows = [];
async function loadSales() {
  const since = new Date();
  since.setDate(since.getDate() - 31);
  const { data, error } = await sb.from("orders")
    .select("id, created_at, total, status")
    .gte("created_at", since.toISOString());
  if (error) return toast(error.message);
  salesRows = data.filter((o) => !["Cancelled", "Rejected"].includes(o.status));

  const today = todayStr();
  const monthKey = today.slice(0, 7);
  const sumOf = (rows) => rows.reduce((s, o) => s + Number(o.total), 0);
  const todayRows = salesRows.filter((o) => new Date(o.created_at).toLocaleDateString("en-CA") === today);
  const monthRows = salesRows.filter((o) => new Date(o.created_at).toLocaleDateString("en-CA").startsWith(monthKey));

  $("#stats").innerHTML = `
    <div class="stat"><span>Today's orders</span><strong>${todayRows.length}</strong></div>
    <div class="stat"><span>Today's sales</span><strong>${money(sumOf(todayRows))}</strong></div>
    <div class="stat"><span>This month</span><strong>${money(sumOf(monthRows))}</strong></div>`;
}

function exportSales() {
  const lines = [["order_id", "date", "total", "status"]];
  salesRows.forEach((o) => lines.push([o.id, new Date(o.created_at).toISOString(), o.total, o.status]));
  const blob = new Blob([lines.map((r) => r.join(",")).join("\n")], { type: "text/csv" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: `sales-${todayStr()}.csv`,
  });
  a.click();
}

// ---------- ENTRY ----------

if (document.body.dataset.page === "admin") initAdmin();
else initStudent();
