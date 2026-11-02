-- ============================================================
-- Smart Canteen - Supabase schema
-- Run this whole file in: Supabase Dashboard > SQL Editor
-- ============================================================

create extension if not exists "pgcrypto";

-- ---------- TABLES ----------

create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null,
  student_id  text unique,
  department  text,
  role        text not null default 'student' check (role in ('student', 'admin')),
  created_at  timestamptz default now()
);

create table if not exists menu_items (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  description  text,
  price        numeric(10,2) not null check (price >= 0),
  category     text not null check (category in ('breakfast', 'lunch', 'snack')),
  image_url    text,
  stock        integer not null default 0 check (stock >= 0),
  is_available boolean not null default true,
  menu_date    date not null default current_date,
  created_at   timestamptz default now()
);

create table if not exists orders (
  id          uuid primary key default gen_random_uuid(),
  student_id  uuid not null references profiles(id) on delete cascade,
  total       numeric(10,2) not null default 0,
  pickup_time timestamptz not null,
  status      text not null default 'Pending'
              check (status in ('Pending','Accepted','Preparing','Ready for Pickup','Completed','Rejected','Cancelled')),
  created_at  timestamptz default now()
);

create table if not exists order_items (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references orders(id) on delete cascade,
  menu_item_id uuid references menu_items(id) on delete set null,
  item_name    text not null,
  unit_price   numeric(10,2) not null,
  quantity     integer not null check (quantity > 0)
);

create table if not exists order_status_history (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references orders(id) on delete cascade,
  status     text not null,
  changed_at timestamptz default now()
);

create table if not exists notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  message    text not null,
  is_read    boolean not null default false,
  created_at timestamptz default now()
);

-- ---------- HELPERS ----------

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin');
$$;

-- Students must not be able to promote themselves to admin
create or replace function protect_role() returns trigger
language plpgsql as $$
begin
  if new.role <> old.role and not is_admin() then
    raise exception 'Only an administrator can change a role';
  end if;
  return new;
end $$;

drop trigger if exists protect_role_trg on profiles;
create trigger protect_role_trg before update on profiles
  for each row execute function protect_role();

-- ---------- ROW LEVEL SECURITY ----------

alter table profiles               enable row level security;
alter table menu_items             enable row level security;
alter table orders                 enable row level security;
alter table order_items            enable row level security;
alter table order_status_history   enable row level security;
alter table notifications          enable row level security;

-- profiles
create policy "profiles: read own or admin" on profiles for select
  using (id = auth.uid() or is_admin());
create policy "profiles: create own student profile" on profiles for insert
  with check (id = auth.uid() and role = 'student');
create policy "profiles: update own" on profiles for update
  using (id = auth.uid() or is_admin()) with check (id = auth.uid() or is_admin());

-- menu: everyone logged in can read; only admins write
create policy "menu: read" on menu_items for select to authenticated using (true);
create policy "menu: admin write" on menu_items for all
  using (is_admin()) with check (is_admin());

-- orders: students see their own; admins see all. Orders are created via place_order().
create policy "orders: read own or admin" on orders for select
  using (student_id = auth.uid() or is_admin());
create policy "orders: admin update" on orders for update
  using (is_admin()) with check (is_admin());

create policy "order_items: read own or admin" on order_items for select
  using (exists (select 1 from orders o where o.id = order_id
                 and (o.student_id = auth.uid() or is_admin())));

create policy "history: read own or admin" on order_status_history for select
  using (exists (select 1 from orders o where o.id = order_id
                 and (o.student_id = auth.uid() or is_admin())));

create policy "notifications: read own" on notifications for select
  using (user_id = auth.uid());
create policy "notifications: mark own read" on notifications for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- ORDER LOGIC ----------

-- Place an order atomically: validates stock + availability, prices from the
-- database (never from the browser), decrements stock, writes history.
-- p_items: [{ "menu_item_id": "<uuid>", "quantity": 2 }, ...]
create or replace function place_order(p_items jsonb, p_pickup timestamptz)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_order  uuid;
  v_row    record;
  v_total  numeric(10,2) := 0;
  v_found  int := 0;
  v_wanted int := jsonb_array_length(coalesce(p_items, '[]'::jsonb));
begin
  if auth.uid() is null then raise exception 'Log in before ordering'; end if;
  if v_wanted = 0 then raise exception 'Your cart is empty'; end if;
  if p_pickup <= now() then raise exception 'Pick a pickup time in the future'; end if;

  insert into orders (student_id, total, pickup_time, status)
  values (auth.uid(), 0, p_pickup, 'Pending')
  returning id into v_order;

  for v_row in
    select m.id, m.name, m.price, m.stock, m.is_available, (x->>'quantity')::int as qty
    from jsonb_array_elements(p_items) x
    join menu_items m on m.id = (x->>'menu_item_id')::uuid
    for update of m
  loop
    v_found := v_found + 1;
    if v_row.qty < 1 then raise exception 'Quantity must be at least 1'; end if;
    if not v_row.is_available or v_row.stock < v_row.qty then
      raise exception '% is sold out or does not have enough stock', v_row.name;
    end if;

    update menu_items set stock = stock - v_row.qty where id = v_row.id;
    insert into order_items (order_id, menu_item_id, item_name, unit_price, quantity)
    values (v_order, v_row.id, v_row.name, v_row.price, v_row.qty);
    v_total := v_total + v_row.price * v_row.qty;
  end loop;

  if v_found <> v_wanted then
    raise exception 'Some items in your cart are no longer on the menu';
  end if;

  update orders set total = v_total where id = v_order;
  insert into order_status_history (order_id, status) values (v_order, 'Pending');
  return v_order;
end $$;

-- Internal: change status, restore stock on cancel/reject, log history, notify student
create or replace function apply_status(p_order uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare v_old text;
begin
  select status into v_old from orders where id = p_order for update;
  if v_old is null or v_old = p_status then return; end if;

  if p_status in ('Cancelled', 'Rejected') and v_old not in ('Cancelled', 'Rejected') then
    update menu_items m set stock = m.stock + oi.quantity
    from order_items oi
    where oi.order_id = p_order and oi.menu_item_id = m.id;
  end if;

  update orders set status = p_status where id = p_order;
  insert into order_status_history (order_id, status) values (p_order, p_status);
  insert into notifications (user_id, message)
    select student_id, 'Your order is now: ' || p_status from orders where id = p_order;
end $$;

revoke execute on function apply_status(uuid, text) from public, anon, authenticated;

-- Admin: change any order's status
create or replace function set_order_status(p_order uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  perform apply_status(p_order, p_status);
end $$;

-- Student: cancel own order, only before the canteen starts preparing it
create or replace function cancel_order(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from orders
    where id = p_order and student_id = auth.uid() and status in ('Pending', 'Accepted')
  ) then
    raise exception 'This order can no longer be cancelled';
  end if;
  perform apply_status(p_order, 'Cancelled');
end $$;

-- ---------- REALTIME (live menu + order updates) ----------

alter publication supabase_realtime add table menu_items;
alter publication supabase_realtime add table orders;
alter publication supabase_realtime add table notifications;

-- ---------- SAMPLE DATA (for testing only) ----------

insert into menu_items (name, description, price, category, stock, menu_date) values
  ('Idli Sambar',     'Two soft idlis with sambar and chutney', 40.00, 'breakfast', 60, current_date),
  ('Masala Dosa',     'Crisp dosa with potato masala',           60.00, 'breakfast', 40, current_date),
  ('Pongal',          'Ghee pongal with coconut chutney',        50.00, 'breakfast', 30, current_date),
  ('Filter Coffee',   'Strong South Indian filter coffee',       20.00, 'breakfast', 100, current_date),
  ('Veg Meals',       'Rice, sambar, rasam, poriyal, curd',      90.00, 'lunch',     80, current_date),
  ('Veg Biryani',     'Fragrant basmati with raita',             110.00,'lunch',     50, current_date),
  ('Chicken Fried Rice','Wok-tossed rice with chicken',          120.00,'lunch',     0,  current_date),
  ('Medu Vada',       'Crispy lentil vada, two pieces',          30.00, 'snack',     70, current_date),
  ('Sundal',          'Sprouted chickpea sundal',                25.00, 'snack',     45, current_date),
  ('Veg Puff',        'Flaky puff with spiced vegetables',       25.00, 'snack',     60, current_date);
