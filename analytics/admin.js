(function () {
  "use strict";

  const API_BASE = "";
  const TOKEN_KEY = "cajamoda-store-loader-token";
  const colors = {
    views: "#7f8dff",
    checkouts: "#55f5b4",
    purchases: "#ffbf69"
  };
  let currentData = null;
  let days = 30;
  let sortKey = "views";
  let pollTimer = null;
  let loading = false;
  let drawToken = 0;
  let chatTimer = null;
  let chatOpen = false;
  let lastPeerMessageId = "";

  const $ = id => document.getElementById(id);
  const qsa = selector => [...document.querySelectorAll(selector)];

  function token() {
    try {
      return sessionStorage.getItem(TOKEN_KEY) || "";
    } catch {
      return "";
    }
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function number(value) {
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Number(value || 0));
  }

  function money(value) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "COP",
      maximumFractionDigits: 0
    }).format(Number(value || 0));
  }

  function percent(value) {
    return new Intl.NumberFormat("en-US", {
      style: "percent",
      maximumFractionDigits: 1
    }).format(Number(value || 0));
  }

  function duration(seconds) {
    const value = Math.max(0, Number(seconds || 0));
    if (value < 60) return Math.round(value) + "s";
    return Math.floor(value / 60) + "m " + Math.round(value % 60) + "s";
  }

  function setText(id, value) {
    const element = $(id);
    if (element) element.textContent = value;
  }

  async function request(path, options = {}) {
    const response = await fetch(API_BASE + path, {
      method: options.method || "GET",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: "Bearer " + token()
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || "Analytics could not be loaded.");
    return data;
  }

  function sizeCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    const context = canvas.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { context, width: rect.width, height: rect.height };
  }

  function drawTrend(series) {
    const canvas = $("analyticsTrendCanvas");
    if (!canvas) return;
    const tokenValue = ++drawToken;
    const values = Array.isArray(series) ? series : [];
    const start = performance.now();
    const durationMs = 650;

    function frame(timestamp) {
      if (tokenValue !== drawToken) return;
      const progress = Math.min(1, (timestamp - start) / durationMs);
      const eased = 1 - Math.pow(1 - progress, 3);
      const { context, width, height } = sizeCanvas(canvas);
      context.clearRect(0, 0, width, height);
      const padding = { top: 18, right: 15, bottom: 28, left: 38 };
      const chartWidth = Math.max(1, width - padding.left - padding.right);
      const chartHeight = Math.max(1, height - padding.top - padding.bottom);
      const maximum = Math.max(
        1,
        ...values.flatMap(point => [point.views, point.checkouts, point.purchases].map(Number))
      );

      context.strokeStyle = "rgba(255,255,255,.07)";
      context.lineWidth = 1;
      context.font = "10px Inter, Arial";
      context.fillStyle = "#626772";
      context.textAlign = "right";
      for (let line = 0; line <= 4; line += 1) {
        const y = padding.top + chartHeight * line / 4;
        context.beginPath();
        context.moveTo(padding.left, y);
        context.lineTo(width - padding.right, y);
        context.stroke();
        context.fillText(number(maximum * (1 - line / 4)), padding.left - 8, y + 3);
      }

      const plotted = Math.max(1, Math.ceil(values.length * eased));
      [
        ["views", colors.views],
        ["checkouts", colors.checkouts],
        ["purchases", colors.purchases]
      ].forEach(([key, color]) => {
        context.beginPath();
        values.slice(0, plotted).forEach((point, index) => {
          const x = padding.left + chartWidth * (values.length <= 1 ? 0 : index / (values.length - 1));
          const y = padding.top + chartHeight * (1 - Number(point[key] || 0) / maximum);
          if (index === 0) context.moveTo(x, y);
          else {
            const previous = values[index - 1];
            const previousX = padding.left + chartWidth * (index - 1) / Math.max(1, values.length - 1);
            const previousY = padding.top + chartHeight * (1 - Number(previous[key] || 0) / maximum);
            const midpoint = (previousX + x) / 2;
            context.bezierCurveTo(midpoint, previousY, midpoint, y, x, y);
          }
        });
        context.strokeStyle = color;
        context.lineWidth = key === "views" ? 2.4 : 1.8;
        context.shadowColor = color;
        context.shadowBlur = 12;
        context.stroke();
        context.shadowBlur = 0;
      });

      if (values.length) {
        context.textAlign = "left";
        context.fillStyle = "#626772";
        context.fillText(values[0].date.slice(5), padding.left, height - 7);
        context.textAlign = "right";
        context.fillText(values[values.length - 1].date.slice(5), width - padding.right, height - 7);
      }
      if (progress < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function drawDonut(channels) {
    const canvas = $("analyticsDonutCanvas");
    if (!canvas) return;
    const { context, width, height } = sizeCanvas(canvas);
    context.clearRect(0, 0, width, height);
    const rows = (Array.isArray(channels) ? channels : []).filter(row => Number(row.sessions || 0) > 0);
    const total = rows.reduce((sum, row) => sum + Number(row.sessions || 0), 0);
    const palette = {
      whatsapp: "#55f5b4",
      instagram: "#ca77ff",
      tiktok: "#5de2ff",
      meta: "#7f8dff",
      direct: "#ffbf69",
      other: "#777c87"
    };
    const radius = Math.max(35, Math.min(width, height) * .31);
    const lineWidth = Math.max(18, radius * .24);
    const centerX = width / 2;
    const centerY = height / 2;
    let angle = -Math.PI / 2;
    if (!total) {
      context.strokeStyle = "rgba(255,255,255,.07)";
      context.lineWidth = lineWidth;
      context.beginPath();
      context.arc(centerX, centerY, radius, 0, Math.PI * 2);
      context.stroke();
      return;
    }
    rows.forEach(row => {
      const span = Math.PI * 2 * Number(row.sessions || 0) / total;
      context.beginPath();
      context.strokeStyle = palette[row.channel] || palette.other;
      context.lineWidth = lineWidth;
      context.lineCap = "round";
      context.arc(centerX, centerY, radius, angle + .025, angle + span - .025);
      context.stroke();
      angle += span;
    });
  }

  function renderProducts() {
    const body = $("analyticsProductRows");
    if (!body || !currentData) return;
    qsa("[data-product-sort]").forEach(header => {
      header.classList.toggle("sorted", header.dataset.productSort === sortKey);
    });
    const products = [...(currentData.topProducts || [])]
      .sort((left, right) => {
        if (sortKey === "name") return String(left.name).localeCompare(String(right.name));
        return Number(right[sortKey] || 0) - Number(left[sortKey] || 0) ||
          Number(right.views || 0) - Number(left.views || 0);
      })
      .slice(0, 10);
    body.innerHTML = products.length ? products.map(product => {
      const image = product.image
        ? '<img src="' + escapeHtml(product.image) + '" alt="" loading="lazy">'
        : '<span class="analyticsProductFallback">CM</span>';
      return '<tr>' +
        '<td><div class="analyticsProduct">' + image + '<div><strong>' + escapeHtml(product.name || "Product") + '</strong><span>' + escapeHtml(product.productId) + '</span></div></div></td>' +
        '<td>' + number(product.views) + '</td>' +
        '<td>' + number(product.favorites) + '</td>' +
        '<td>' + number(product.shares) + '</td>' +
        '<td>' + number(product.addToCart) + '</td>' +
        '<td>' + number(product.checkouts) + '</td>' +
        '<td>' + number(product.purchases) + '</td>' +
      '</tr>';
    }).join("") : '<tr><td colspan="7"><div class="analyticsEmpty">No product events have been recorded in this range yet.</div></td></tr>';
    body.querySelectorAll("img").forEach(image => {
      image.addEventListener("error", () => {
        const fallback = document.createElement("span");
        fallback.className = "analyticsProductFallback";
        fallback.textContent = "CM";
        image.replaceWith(fallback);
      }, { once: true });
    });
  }

  function renderFunnel(rows) {
    const root = $("analyticsFunnel");
    if (!root) return;
    const values = Array.isArray(rows) ? rows : [];
    const maximum = Math.max(1, ...values.map(item => Number(item.value || 0)));
    root.innerHTML = values.map(item =>
      '<div class="analyticsFunnelRow">' +
        '<div class="analyticsFunnelLabel">' + escapeHtml(item.label) + '</div>' +
        '<div class="analyticsFunnelTrack"><div class="analyticsFunnelFill" style="width:' + Math.max(1, Number(item.value || 0) / maximum * 100) + '%"></div></div>' +
        '<div class="analyticsFunnelValue">' + number(item.value) + '</div>' +
      '</div>'
    ).join("");
  }

  function renderChannels(rows) {
    const root = $("analyticsChannels");
    if (!root) return;
    const values = Array.isArray(rows) ? rows : [];
    const maximum = Math.max(1, ...values.map(item => Number(item.sessions || 0)));
    root.innerHTML = values.map(item => {
      const roas = item.roas === null ? "—" : Number(item.roas).toFixed(2) + "×";
      return '<div class="analyticsChannelRow">' +
        '<div class="analyticsChannelName">' + escapeHtml(item.channel) + '</div>' +
        '<div class="analyticsChannelTrack"><div class="analyticsChannelFill" style="width:' + Math.max(1, Number(item.sessions || 0) / maximum * 100) + '%"></div></div>' +
        '<div class="analyticsChannelValue">' + number(item.sessions) + ' sessions · ' + number(item.purchases) + ' sales<br>' + money(item.revenue) + ' · ROAS ' + roas + '</div>' +
      '</div>';
    }).join("");
  }

  function renderLive(realtime) {
    const rows = realtime?.sessions || [];
    setText("analyticsLiveCount", number(rows.length));
    const root = $("analyticsLiveRows");
    if (!root) return;
    root.innerHTML = rows.length ? rows.map(item =>
      '<div class="analyticsLiveRow">' +
        '<span class="analyticsSessionId">' + escapeHtml(String(item.sessionId || "").slice(-12)) + '</span>' +
        '<strong>' + escapeHtml(item.page || "home") + '</strong>' +
        '<span>' + escapeHtml(item.action || "Browsing") + (item.productName ? " · " + escapeHtml(item.productName) : "") + '</span>' +
        '<span>' + escapeHtml(item.city || "Unknown") + '</span>' +
        '<span>' + duration(item.timeOnSiteSeconds) + '</span>' +
      '</div>'
    ).join("") : '<div class="analyticsEmpty">No visitors are active right now. This updates automatically.</div>';
  }

  function renderCampaigns(campaigns) {
    const root = $("analyticsCampaigns");
    if (!root) return;
    const rows = Array.isArray(campaigns) ? campaigns : [];
    root.innerHTML = rows.length ? rows.map(item =>
      '<div class="analyticsCampaign">' +
        '<span class="analyticsCampaignChannel">' + escapeHtml(item.channel) + '</span>' +
        '<strong class="analyticsCampaignName">' + escapeHtml(item.campaign || "Untracked") + '</strong>' +
        '<span class="analyticsCampaignValue">' + number(item.sessions) + '</span>' +
        '<span class="analyticsCampaignRevenue">' + money(item.revenue) + '</span>' +
      '</div>'
    ).join("") : '<div class="analyticsEmpty">Campaign rows appear when ad links include UTM campaign values.</div>';
  }

  function populateSettings(settings) {
    if ($("analyticsMonth") && settings?.month) $("analyticsMonth").value = settings.month;
    [
      ["analyticsSpendWhatsapp", settings?.adSpendWhatsapp],
      ["analyticsSpendInstagram", settings?.adSpendInstagram],
      ["analyticsSpendTiktok", settings?.adSpendTiktok],
      ["analyticsInventoryInput", settings?.inventorySpend]
    ].forEach(([id, value]) => {
      const input = $(id);
      if (input && document.activeElement !== input) input.value = Number(value || 0);
    });
  }

  function render(data) {
    currentData = data;
    const overview = data.overview || {};
    setText("analyticsLiveVisitors", number(overview.liveVisitors));
    setText("analyticsViews", number(overview.productViews));
    setText("analyticsCart", number(overview.addToCart));
    setText("analyticsCheckouts", number(overview.checkouts));
    setText("analyticsPurchases", number(overview.purchases));
    setText("analyticsRevenue", money(overview.revenue));
    setText("analyticsRevenueMeta", money(overview.cardRevenue) + " card · " + money(overview.nequiRevenue) + " Nequi");
    setText("analyticsFavorites", number(overview.favorites));
    setText("analyticsShares", number(overview.shares));
    setText("analyticsConversion", percent(overview.conversionRate));
    setText("analyticsAov", money(overview.averageOrderValue));
    setText("analyticsAbandoned", number(overview.abandonedCarts));
    setText("analyticsGrowth", percent(overview.monthlyGrowth));
    setText("analyticsInventorySpend", money(overview.inventorySpend));
    setText("analyticsCogs", money(overview.costOfGoodsSold));
    setText("analyticsInventoryValue", money(overview.remainingInventoryValue));
    setText("analyticsGrossProfit", money(overview.grossProfit));
    setText("analyticsGrossMargin", percent(Number(overview.grossMarginPercent || 0) / 100) + " gross margin");
    setText("analyticsSessionTotal", number(overview.sessions));
    setText(
      "analyticsBusinessReadout",
      "Ad spend " + money(overview.adSpend) +
      " · CAC " + money(overview.customerAcquisitionCost) +
      " · Gross profit " + money(overview.grossProfit)
    );
    setText(
      "analyticsStatus",
      "Live · " + number(data.storage?.eventCount) + " stored events · updated " +
      new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(data.generatedAt))
    );
    drawTrend(data.timeseries || []);
    drawDonut(data.channels || []);
    renderFunnel(data.funnel || []);
    renderChannels(data.channels || []);
    renderProducts();
    renderLive(data.realtime || {});
    renderCampaigns(data.campaigns || []);
    populateSettings(data.settings || {});
  }

  async function load(force = false) {
    if (loading && !force) return;
    if (!token()) return;
    loading = true;
    $("analyticsRefresh")?.classList.add("loading");
    setText("analyticsStatus", "Refreshing live data…");
    try {
      const month = $("analyticsMonth")?.value || new Date().toISOString().slice(0, 7);
      render(await request("/api/store-owner/analytics?days=" + encodeURIComponent(days) + "&month=" + encodeURIComponent(month)));
    } catch (error) {
      setText("analyticsStatus", error?.message || "Analytics could not be loaded.");
    } finally {
      loading = false;
      $("analyticsRefresh")?.classList.remove("loading");
    }
  }

  function start() {
    stop();
    pollTimer = window.setInterval(() => {
      if ($("panel-analytics")?.classList.contains("active") && document.visibilityState === "visible") {
        load();
      }
    }, 8000);
  }

  function stop() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  async function saveSettings() {
    const button = $("analyticsSaveSettings");
    if (button) {
      button.disabled = true;
      button.textContent = "Saving…";
    }
    try {
      await request("/api/store-owner/analytics/settings", {
        method: "POST",
        body: {
          adSpendWhatsapp: Number($("analyticsSpendWhatsapp")?.value || 0),
          adSpendInstagram: Number($("analyticsSpendInstagram")?.value || 0),
          adSpendTiktok: Number($("analyticsSpendTiktok")?.value || 0),
          inventorySpend: Number($("analyticsInventoryInput")?.value || 0)
          ,month: $("analyticsMonth")?.value || new Date().toISOString().slice(0, 7)
        }
      });
      await load(true);
    } catch (error) {
      setText("analyticsStatus", error?.message || "Business inputs could not be saved.");
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "Save Monthly Inputs";
      }
    }
  }

  if ($("analyticsMonth")) {
    $("analyticsMonth").value = new Date().toISOString().slice(0, 7);
    $("analyticsMonth").addEventListener("change", () => load(true));
  }
  qsa("[data-range-days]").forEach(button => {
    button.addEventListener("click", () => {
      days = Number(button.dataset.rangeDays || 30);
      qsa("[data-range-days]").forEach(candidate => candidate.classList.toggle("active", candidate === button));
      load(true);
    });
  });
  qsa("[data-product-sort]").forEach(header => {
    header.addEventListener("click", () => {
      sortKey = header.dataset.productSort || "views";
      renderProducts();
    });
  });
  $("analyticsRefresh")?.addEventListener("click", () => load(true));
  $("analyticsSaveSettings")?.addEventListener("click", saveSettings);

  function organizeMetrics() {
    const root = $("analyticsKpis");
    if (!root || root.dataset.organized) return;
    root.dataset.organized = "true";
    root.className = "analyticsMetricGroups";
    const groups = [
      ["Sales and Revenue", ["analyticsPurchases", "analyticsRevenue", "analyticsAov", "analyticsGrowth"]]
    ];
    groups.forEach(([label, ids], index) => {
      const details = document.createElement("details");
      details.className = "analyticsMetricGroup";
      if (index < 2) details.open = true;
      const summary = document.createElement("summary");
      summary.textContent = label;
      const grid = document.createElement("div");
      grid.className = "analyticsMetricGroupGrid";
      ids.forEach(id => {
        const card = $(id)?.closest(".analyticsKpi");
        if (card) grid.appendChild(card);
      });
      details.append(summary, grid);
      root.appendChild(details);
    });
  }
  organizeMetrics();

  function renderChat(data) {
    const selfAdmin = data.self === "admin";
    setText("chatHead", selfAdmin ? "Karolay" : "Reign");
    const presence = $("chatPeerPresence");
    if (presence) {
      presence.textContent = data.peerActive ? "Active" : "Inactive";
      presence.classList.toggle("active", Boolean(data.peerActive));
    }
    const root = $("chatMessages");
    if (!root) return;
    const peerMessages = (data.messages || []).filter(item => item.sender !== data.self);
    const newestPeer = peerMessages[peerMessages.length - 1];
    if (!chatOpen && newestPeer?.id && newestPeer.id !== lastPeerMessageId) {
      const badge = $("chatUnread");
      if (badge) {
        badge.hidden = false;
        badge.textContent = "1";
      }
    }
    if (newestPeer?.id) lastPeerMessageId = newestPeer.id;
    root.innerHTML = (data.messages || []).map(item =>
      '<div class="chatMessage ' + (item.sender === data.self ? 'mine' : '') + '">' +
      escapeHtml(item.message) + '<time>' +
      new Intl.DateTimeFormat("en-US", {hour:"numeric",minute:"2-digit"}).format(new Date(item.sentAt)) +
      '</time></div>'
    ).join("") || '<div class="analyticsEmpty">No messages yet.</div>';
    root.scrollTop = root.scrollHeight;
  }

  async function loadChat() {
    if (!token()) return;
    try {
      renderChat(await request("/api/store-owner/chat"));
      setText("chatStatus", "");
    } catch (error) {
      setText("chatStatus", error?.message || "Chat could not be loaded.");
    }
  }

  $("chatComposer")?.addEventListener("submit", async event => {
    event.preventDefault();
    const input = $("chatInput");
    const message = String(input?.value || "").trim();
    if (!message) return;
    try {
      const data = await request("/api/store-owner/chat", {method:"POST", body:{message}});
      if (input) input.value = "";
      renderChat(data);
      setText("chatStatus", "");
    } catch (error) {
      setText("chatStatus", error?.message || "Message was not sent.");
    }
  });
  $("chatBubble")?.addEventListener("click", () => {
    chatOpen = !chatOpen;
    $("chatShell")?.classList.toggle("open", chatOpen);
    if (chatOpen) {
      if ($("chatUnread")) $("chatUnread").hidden = true;
      loadChat();
      $("chatInput")?.focus();
    }
  });
  clearInterval(chatTimer);
  chatTimer = setInterval(loadChat, 8000);
  window.addEventListener("focus", loadChat);
  window.addEventListener("storage", loadChat);
  setTimeout(() => {
    loadChat();
  }, 1000);
  window.addEventListener("resize", () => {
    clearTimeout(window.__cajaAnalyticsResize);
    window.__cajaAnalyticsResize = window.setTimeout(() => {
      if (currentData) {
        drawTrend(currentData.timeseries || []);
        drawDonut(currentData.channels || []);
      }
    }, 120);
  });

  window.CajaModaAdminAnalytics = { load, start, stop };
})();
