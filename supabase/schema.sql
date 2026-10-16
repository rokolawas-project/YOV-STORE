-- Skema awal opsional untuk Supabase.
-- Jangan menaruh service_role key di browser. Aktifkan RLS dan kebijakan akses
-- yang sesuai sebelum menggunakan database ini untuk data usaha sungguhan.

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) >= 1),
  type text not null check (type in ('income', 'expense')),
  amount numeric(14, 0) not null check (amount > 0),
  transaction_date date not null,
  note text check (note is null or char_length(note) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.transactions enable row level security;

-- Contoh kebijakan: pengguna hanya bisa mengakses transaksi miliknya sendiri.
create policy "Users can read their transactions"
  on public.transactions for select
  using (auth.uid() = user_id);

create policy "Users can insert their transactions"
  on public.transactions for insert
  with check (auth.uid() = user_id);

create policy "Users can update their transactions"
  on public.transactions for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete their transactions"
  on public.transactions for delete
  using (auth.uid() = user_id);


-- Nama transaksi tidak dibatasi panjang karakter oleh constraint ini.
alter table public.transactions drop constraint if exists transactions_title_check;
alter table public.transactions add constraint transactions_title_check check (char_length(title) >= 1);
