-- Yov Store V3.1.10: hapus batas panjang nama transaksi dari constraint lama.
-- Jalankan manual di Supabase Dashboard > SQL Editor.
-- Tidak menghapus tabel atau data dan tidak mengubah Auth/RLS.

alter table public.transactions
  drop constraint if exists transactions_title_check;

alter table public.transactions
  add constraint transactions_title_check
  check (char_length(title) >= 1);
