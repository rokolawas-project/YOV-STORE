(() => {
  "use strict";
  const config = window.YOV_STORE_CONFIG || { appName: "Yov Store", version: "V2.1.6", storageKey: "yov_store_transactions_v1" };
  const $ = (selector) => document.querySelector(selector);
  const state = { transactions: [], view: "dashboard", dashboardAccount: "all", user: null, realtimeChannel: null, authMode: "login", busy: false };
  // Pertahankan sesi login pada browser/perangkat ini sampai pengguna logout.
  // Perangkat baru tetap memerlukan login tersendiri.
  const supabaseClient = window.supabase?.createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storage: window.localStorage
    }
  });
  const form = $("#transactionForm");
  const modal = $("#transactionModal");
  const errorBox = $("#formError");
  let toastTimer;

  const rupiah = (amount) => new Intl.NumberFormat("id-ID", {
    style: "currency", currency: "IDR", maximumFractionDigits: 0
  }).format(Number(amount) || 0);

  // Saldo dashboard ditampilkan dalam satuan ribuan rupiah.
  // Contoh: saldo Rp1.000.000 ditampilkan sebagai 1.000.
  const dashboardAmount = (amount) => new Intl.NumberFormat("id-ID", {
    maximumFractionDigits: 3
  }).format((Number(amount) || 0) / 1000);

  // Format riwayat: tanggal/bulan/dua digit tahun, contoh 8/10/26.
  const formatDate = (value) => {
    if (!value) return "—";
    const parts = String(value).split("-");
    if (parts.length === 3 && parts.every((part) => /^\d+$/.test(part))) {
      const [year, month, day] = parts;
      return `${Number(day)}/${Number(month)}/${year.slice(-2)}`;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return `${date.getDate()}/${date.getMonth() + 1}/${String(date.getFullYear()).slice(-2)}`;
  };

  const todayISO = () => {
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  };

  function loadLocalTransactions() {
    try {
      const saved = localStorage.getItem(config.storageKey);
      const parsed = saved ? JSON.parse(saved) : [];
      return Array.isArray(parsed) ? parsed.filter(isValidTransaction).map((item) => ({
        ...item, account: ["BCA", "CASH", "CASH KHUSUS"].includes(item.account) ? item.account : "CASH"
      })) : [];
    } catch (error) { showToast("Data lokal lama tidak dapat dibaca."); return []; }
  }

  function userCacheKey(userId = state.user?.id) {
    return userId ? `${config.storageKey}_user_${userId}` : null;
  }

  function loadCachedTransactions(userId) {
    try {
      const key = userCacheKey(userId);
      const parsed = key ? JSON.parse(localStorage.getItem(key) || "[]") : [];
      return Array.isArray(parsed) ? parsed.filter(isValidTransaction).map((item) => ({
        ...item, account: ["BCA", "CASH", "CASH KHUSUS"].includes(item.account) ? item.account : "CASH"
      })) : [];
    } catch (error) {
      console.warn("Cache transaksi tidak dapat dibaca:", error);
      return [];
    }
  }

  async function loadTransactions() {
    const { data, error } = await supabaseClient.from("transactions")
      .select("id,user_id,title,type,account,amount,transaction_date,note,created_at,updated_at")
      .eq("user_id", state.user.id)
      .order("transaction_date", { ascending: false }).order("created_at", { ascending: false });
    if (error) throw error;
    state.transactions = (data || []).map((row) => ({
      id: row.id, title: row.title, type: row.type, account: row.account,
      amount: Number(row.amount), date: row.transaction_date, note: row.note || "", createdAt: row.created_at
    }));
    localStorage.setItem(config.storageKey, JSON.stringify(state.transactions));
    render();
  }

  async function migrateLocalTransactionsOnce() {
    const marker = `yov_store_supabase_migrated_${state.user.id}`;
    if (localStorage.getItem(marker)) return;
    const localItems = loadLocalTransactions();
    if (!localItems.length) { localStorage.setItem(marker, "done"); return; }
    const { count, error: countError } = await supabaseClient.from("transactions")
      .select("id", { count: "exact", head: true }).eq("user_id", state.user.id);
    if (countError) throw countError;
    if ((count || 0) > 0) { localStorage.setItem(marker, "skipped-existing-online-data"); return; }
    const payload = localItems.map((item) => ({
      user_id: state.user.id, title: item.title, type: item.type, account: item.account || "CASH",
      amount: Number(item.amount), transaction_date: item.date || todayISO(), note: item.note || null
    }));
    const { error } = await supabaseClient.from("transactions").insert(payload);
    if (error) throw error;
    localStorage.setItem(marker, "done");
  }

  function isValidTransaction(item) {
    return item && typeof item.id === "string" && typeof item.title === "string"
      && Number.isFinite(Number(item.amount)) && Number(item.amount) > 0
      && ["income", "expense"].includes(item.type);
  }

  function saveTransactions() {
    try {
      localStorage.setItem(config.storageKey, JSON.stringify(state.transactions));
      return true;
    } catch (error) {
      showToast("Penyimpanan browser penuh atau tidak tersedia.");
      return false;
    }
  }

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
  }

  function getTotals() {
    return state.transactions.reduce((totals, item) => {
      if (item.type === "income") totals.income += Number(item.amount);
      else totals.expense += Number(item.amount);
      return totals;
    }, { income: 0, expense: 0 });
  }

  function transactionRows(items) {
    if (!items.length) return `<div class="empty-state"><div class="empty-icon">＋</div><strong>Belum ada transaksi</strong><p>Transaksi yang kamu tambahkan akan muncul di sini.</p></div>`;
    const rows = items.map((item) => {
      const income = item.type === "income";
      return `<tr>
        <td class="history-type"><span class="type-badge ${income ? "income" : "expense"}">${income ? "IN" : "OUT"}</span></td>
        <td class="history-date">${formatDate(item.date)}</td>
        <td class="history-name"><span class="transaction-name">${escapeHTML(item.title)}</span>${item.note ? `<span class="transaction-note">${escapeHTML(item.note)}</span>` : ""}</td>
        <td class="amount ${income ? "income" : "expense"}">${dashboardAmount(item.amount)}</td>
        <td class="history-actions"><div class="row-actions"><button class="small-action" data-action="edit" data-id="${escapeHTML(item.id)}" aria-label="Edit transaksi" title="Edit"><svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg></button><button class="small-action" data-action="delete" data-id="${escapeHTML(item.id)}" aria-label="Hapus transaksi" title="Delete"><svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg></button></div></td>
      </tr>`;
    }).join("");
    return `<div class="table-wrap history-table-wrap"><table class="history-table"><colgroup><col class="col-type"><col class="col-date"><col class="col-name"><col class="col-amount"><col class="col-actions"></colgroup><thead><tr><th>Jenis</th><th>Tgl</th><th>Nama Transaksi</th><th>Nominal</th><th>Aksi</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function render() {
    const accountBalances = { "BCA": 0, "CASH": 0, "CASH KHUSUS": 0 };
    state.transactions.forEach((item) => {
      const account = ["BCA", "CASH", "CASH KHUSUS"].includes(item.account) ? item.account : "CASH";
      accountBalances[account] += item.type === "income" ? Number(item.amount) : -Number(item.amount);
    });
    $("#bcaBalance").textContent = dashboardAmount(accountBalances["BCA"]);
    $("#cashBalance").textContent = dashboardAmount(accountBalances["CASH"]);
    $("#specialCashBalance").textContent = dashboardAmount(accountBalances["CASH KHUSUS"]);
    $("#todayLabel").textContent = new Intl.DateTimeFormat("id-ID", {
      weekday: "long", day: "numeric", month: "long", year: "numeric"
    }).format(new Date());
    renderAllTransactions();
    renderDashboardTransactions();
  }

  function renderDashboardTransactions() {
    const account = state.dashboardAccount;
    const title = account === "all" ? "Semua transaksi" : `Transaksi ${account}`;
    $("#dashboardTransactionsTitle").textContent = title;
    document.querySelectorAll(".account-card").forEach((card) => {
      const selected = card.dataset.account === account;
      card.classList.toggle("account-card-selected", selected);
      card.setAttribute("aria-pressed", String(selected));
    });
    const searchInput = $("#dashboardHistorySearch");
    const search = searchInput ? searchInput.value.trim().toLocaleLowerCase("id-ID") : "";
    const items = [...state.transactions]
      .filter((item) => account === "all" || (item.account || "CASH") === account)
      .filter((item) => `${item.title || ""} ${item.note || ""}`.toLocaleLowerCase("id-ID").includes(search))
      .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || "").localeCompare(a.createdAt || ""));
    $("#dashboardTransactionsList").innerHTML = items.length ? transactionRows(items) : '<p class="empty-state">Transaksi tidak ditemukan.</p>';
  }

  function renderAllTransactions() {
    const search = $("#searchInput").value.trim().toLocaleLowerCase("id-ID");
    const type = $("#typeFilter").value;
    const account = $("#accountFilter").value;
    const items = [...state.transactions]
      .filter((item) => type === "all" || item.type === type)
      .filter((item) => account === "all" || (item.account || "CASH") === account)
      .filter((item) => `${item.title} ${item.note || ""}`.toLocaleLowerCase("id-ID").includes(search))
      .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || "").localeCompare(a.createdAt || ""));
    $("#allTransactions").innerHTML = transactionRows(items);
  }

  function setView(view) {
    state.view = view;
    $("#dashboardView").classList.toggle("hidden", view !== "dashboard");
    $("#transactionsView").classList.toggle("hidden", view !== "transactions");
    $("#pageTitle").textContent = view === "dashboard" ? "Ringkasan" : "Transaksi";
    document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
    $("#sidebar").classList.remove("open");
    $("#sidebarBackdrop").classList.remove("visible");
    $("#menuToggle").setAttribute("aria-expanded", "false");
    $("#dashboardActions").classList.toggle("hidden", view !== "dashboard");
    if (view === "transactions") renderAllTransactions();
  }

  function openModal(item = null) {
    form.reset();
    errorBox.classList.add("hidden");
    form.elements.date.value = item?.date || todayISO();
    form.elements.title.value = item?.title || "";
    form.elements.amount.value = item ? Number(item.amount) / 1000 : "";
    const accountValue = item?.account || "CASH";
    const accountRadio = form.querySelector(`input[name="account"][value="${accountValue}"]`);
    if (accountRadio) accountRadio.checked = true;
    const selectedType = item?.type || "income";
    form.querySelector(`input[name="type"][value="${selectedType}"]`).checked = true;
    form.dataset.editId = item?.id || "";
    $("#modalTitle").textContent = item ? "Edit transaksi" : "Tambah transaksi";
    modal.classList.remove("hidden");
    setTimeout(() => form.elements.title.focus(), 20);
  }

  function closeModal() {
    modal.classList.add("hidden");
    errorBox.classList.add("hidden");
    delete form.dataset.editId;
  }

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add("hidden"), 2800);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (state.busy) return;
    errorBox.classList.add("hidden");
    const saveButton = $("#saveTransactionButton");
    try {
      const data = new FormData(form);
      const title = String(data.get("title") || "").trim();
      const amountText = String(data.get("amount") || "").trim().replace(/,/g, ".");
      const amountInput = Number(amountText), amount = amountInput * 1000;
      const date = String(data.get("date") || ""), type = String(data.get("type") || "");
      const account = String(data.get("account") || "");
      if (!title || !date || !amountText || !Number.isFinite(amountInput) || amountInput <= 0 || !Number.isFinite(amount) || !["income", "expense"].includes(type) || !["BCA", "CASH", "CASH KHUSUS"].includes(account)) {
        errorBox.textContent = "Lengkapi nama, nominal (lebih dari 0), tanggal, jenis, dan sumber uang dengan benar.";
        errorBox.classList.remove("hidden"); return;
      }
      if (!state.user) throw new Error("Sesi login tidak ditemukan. Silakan masuk kembali.");
      state.busy = true; saveButton.disabled = true; saveButton.textContent = "Menyimpan…";
      const editId = form.dataset.editId;
      const existingTransaction = editId ? state.transactions.find((item) => item.id === editId) : null;
      const note = existingTransaction?.note || null;
      const payload = { user_id: state.user.id, title, amount, transaction_date: date, type, note, account };
      let result;
      if (editId) result = await supabaseClient.from("transactions").update(payload).eq("id", editId).eq("user_id", state.user.id).select("id").maybeSingle();
      else result = await supabaseClient.from("transactions").insert(payload).select("id").single();
      if (result.error) throw result.error;
      if (editId && !result.data) throw new Error("Transaksi tidak ditemukan atau tidak dapat diubah.");
      await loadTransactions(); closeModal();
      showToast(editId ? "Transaksi berhasil diperbarui di Supabase." : "Transaksi berhasil disimpan ke Supabase.");
    } catch (error) {
      console.error("Gagal menyimpan transaksi Supabase:", error);
      errorBox.textContent = `Gagal menyimpan ke Supabase: ${error.message || "periksa koneksi, login, dan policy RLS."}`;
      errorBox.classList.remove("hidden");
    } finally { state.busy = false; saveButton.disabled = false; saveButton.textContent = "Simpan transaksi"; }
  }

  async function handleTableAction(event) {
    const button = event.target.closest("button[data-action]");
    if (!button || state.busy) return;
    const item = state.transactions.find((transaction) => transaction.id === button.dataset.id);
    if (!item) return;
    if (button.dataset.action === "edit") openModal(item);
    else if (button.dataset.action === "delete") {
      if (!window.confirm(`Hapus transaksi "${item.title}" dari Supabase?`)) return;
      try {
        state.busy = true;
        const { error } = await supabaseClient.from("transactions").delete().eq("id", item.id).eq("user_id", state.user.id);
        if (error) throw error;
        await loadTransactions(); showToast("Transaksi berhasil dihapus dari Supabase.");
      } catch (error) {
        console.error("Gagal menghapus transaksi:", error);
        showToast(`Gagal menghapus: ${error.message || "periksa koneksi dan policy RLS."}`);
      } finally { state.busy = false; }
    }
  }

  document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  $("#addTransactionTop").addEventListener("click", () => openModal());
  // Tombol viewAllTransactions sudah dihapus dari dashboard; jangan bind listener ke elemen yang tidak ada.
  $("#closeModal").addEventListener("click", closeModal);
  $("#cancelModal").addEventListener("click", closeModal);
  function setSidebarOpen(open) {
    $("#sidebar").classList.toggle("open", open);
    $("#sidebarBackdrop").classList.toggle("visible", open);
    $("#menuToggle").setAttribute("aria-expanded", String(open));
  }
  $("#menuToggle").addEventListener("click", () => setSidebarOpen(!$("#sidebar").classList.contains("open")));
  $("#sidebarBackdrop").addEventListener("click", () => setSidebarOpen(false));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") setSidebarOpen(false); });
  document.addEventListener("click", (event) => {
    if (window.matchMedia("(max-width: 760px)").matches && $("#sidebar").classList.contains("open") && !$("#sidebar").contains(event.target) && !$("#menuToggle").contains(event.target)) setSidebarOpen(false);
  });
  $("#searchInput").addEventListener("input", renderAllTransactions);
  $("#typeFilter").addEventListener("change", renderAllTransactions);
  $("#accountFilter").addEventListener("change", renderAllTransactions);
  function selectDashboardAccount(account) {
    state.dashboardAccount = account;
    renderDashboardTransactions();
  }
  document.querySelectorAll(".account-card").forEach((card) => {
    card.addEventListener("click", () => selectDashboardAccount(card.dataset.account));
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectDashboardAccount(card.dataset.account);
      }
    });
  });
  $("#dashboardHistorySearch").addEventListener("input", renderDashboardTransactions);
  $("#showAllDashboardTransactions").addEventListener("click", () => {
    const searchInput = $("#dashboardHistorySearch");
    if (searchInput) searchInput.value = "";
    selectDashboardAccount("all");
  });
  $("#dashboardTransactionsList").addEventListener("click", handleTableAction);
  form.addEventListener("submit", handleSubmit);
  $("#allTransactions").addEventListener("click", handleTableAction);
  modal.addEventListener("click", (event) => { if (event.target === modal) closeModal(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !modal.classList.contains("hidden")) closeModal(); });

  function setAuthMessage(message) {
    const node = $("#authError"); node.textContent = message || ""; node.classList.toggle("hidden", !message);
  }

  let startupUserId = null;
  let startupPromise = null;
  async function startAuthenticatedApp(session) {
    if (state.user?.id === session.user.id && !$("#appShell").classList.contains("hidden")) return;
    if (startupUserId === session.user.id && startupPromise) return startupPromise;
    startupUserId = session.user.id;
    state.user = session.user;
    $("#authGate").classList.add("hidden");
    $("#appShell").classList.remove("hidden");
    $("#signedInEmail").textContent = session.user.email || "Akun masuk";

    // Tampilkan cache milik akun ini seketika, sebelum jaringan selesai merespons.
    state.transactions = loadCachedTransactions(session.user.id);
    render();
    $("#connectionStatus").textContent = state.transactions.length
      ? "Memuat pembaruan…"
      : "Menghubungkan Supabase…";

    startupPromise = (async () => {
      try {
        await migrateLocalTransactionsOnce();
        await loadTransactions();
        $("#connectionStatus").textContent = "Supabase aktif";
        if (state.realtimeChannel) await supabaseClient.removeChannel(state.realtimeChannel);
        state.realtimeChannel = supabaseClient.channel(`transactions-${session.user.id}`)
          .on("postgres_changes", { event: "*", schema: "public", table: "transactions", filter: `user_id=eq.${session.user.id}` }, async () => {
            try { await loadTransactions(); } catch (error) { console.error("Realtime reload gagal:", error); }
          }).subscribe((status) => {
            if (status === "SUBSCRIBED") $("#connectionStatus").textContent = "Realtime aktif";
            if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") $("#connectionStatus").textContent = "Realtime terputus";
          });
      } catch (error) {
        console.error("Inisialisasi Supabase gagal:", error);
        $("#connectionStatus").textContent = "Koneksi bermasalah";
        showToast(`Supabase gagal dimuat: ${error.message || "periksa konfigurasi."}`);
      } finally {
        startupPromise = null;
      }
    })();
    return startupPromise;
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    const email = $("#authEmail").value.trim(), password = $("#authPassword").value, button = $("#authSubmit");
    button.disabled = true; button.textContent = state.authMode === "login" ? "Memeriksa…" : "Mendaftarkan…"; setAuthMessage("");
    try {
      if (!supabaseClient) throw new Error("Library Supabase tidak termuat. Periksa koneksi internet.");
      const result = state.authMode === "login"
        ? await supabaseClient.auth.signInWithPassword({ email, password })
        : await supabaseClient.auth.signUp({ email, password });
      if (result.error) throw result.error;
      if (state.authMode === "signup" && !result.data.session) setAuthMessage("Akun dibuat. Periksa email untuk konfirmasi, lalu masuk setelah dikonfirmasi.");
      else if (result.data.session) await startAuthenticatedApp(result.data.session);
    } catch (error) { setAuthMessage(error.message || "Autentikasi gagal."); }
    finally { button.disabled = false; button.textContent = state.authMode === "login" ? "Masuk" : "Buat akun"; }
  }

  $("#authForm").addEventListener("submit", handleAuthSubmit);
  $("#authModeToggle").addEventListener("click", () => {
    state.authMode = state.authMode === "login" ? "signup" : "login";
    $("#authTitle").textContent = state.authMode === "login" ? "Masuk ke Yov Store" : "Buat akun Yov Store";
    $("#authSubmit").textContent = state.authMode === "login" ? "Masuk" : "Buat akun";
    $("#authModeToggle").textContent = state.authMode === "login" ? "Belum punya akun? Daftar" : "Sudah punya akun? Masuk";
    $("#authPassword").autocomplete = state.authMode === "login" ? "current-password" : "new-password"; setAuthMessage("");
  });
  $("#signOutButton").addEventListener("click", async () => {
    if (!window.confirm("Keluar dari akun Yov Store?")) return;
    if (state.realtimeChannel) await supabaseClient.removeChannel(state.realtimeChannel);
    await supabaseClient.auth.signOut(); state.user = null; state.transactions = [];
    $("#appShell").classList.add("hidden"); $("#authGate").classList.remove("hidden");
  });

  if (!supabaseClient) setAuthMessage("Library Supabase gagal dimuat. Pastikan perangkat terhubung ke internet.");
  else {
    supabaseClient.auth.getSession().then(({ data, error }) => {
      if (error) setAuthMessage(error.message); else if (data.session) startAuthenticatedApp(data.session);
    });
    supabaseClient.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" && session && !state.user) startAuthenticatedApp(session);
    });
  }
})();
