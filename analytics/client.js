(function () {
  "use strict";

  if (window.CajaModaAnalytics) return;

  const ENDPOINT = "/api/analytics/events";
  const VISITOR_KEY = "cajamoda-analytics-visitor";
  const SESSION_KEY = "cajamoda-analytics-session";
  const FIRST_TOUCH_KEY = "cajamoda-analytics-first-touch";
  const LAST_TOUCH_KEY = "cajamoda-analytics-last-touch";
  const LOCATION_KEY = "cajamoda-analytics-location";
  const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
  const HEARTBEAT_MS = 15 * 1000;
  const queue = [];
  let flushTimer = 0;
  const startedAt = Date.now();

  function createId(prefix) {
    const value = window.crypto?.randomUUID
      ? window.crypto.randomUUID()
      : String(Date.now()) + "-" + Math.random().toString(16).slice(2);
    return (prefix + "_" + value).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  }

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }

  function safeText(value, limit = 300) {
    return String(value ?? "").trim().slice(0, limit);
  }

  function visitorId() {
    let id = safeText(readJson(VISITOR_KEY, ""), 80);
    if (!id) {
      id = createId("vis");
      writeJson(VISITOR_KEY, id);
    }
    return id;
  }

  function session() {
    const current = readJson(SESSION_KEY, null);
    const timestamp = Date.now();
    if (current?.id && Number(current.lastSeenAt || 0) > timestamp - SESSION_TIMEOUT_MS) {
      current.lastSeenAt = timestamp;
      writeJson(SESSION_KEY, current);
      return current;
    }
    const next = {
      id: createId("ses"),
      startedAt: timestamp,
      lastSeenAt: timestamp
    };
    writeJson(SESSION_KEY, next);
    return next;
  }

  function channelFrom(value) {
    const source = safeText(value, 120).toLowerCase();
    if (/whats?app|wa\.me/.test(source)) return "whatsapp";
    if (/instagram|\big\b|instagr\.am/.test(source)) return "instagram";
    if (/tiktok|tik tok/.test(source)) return "tiktok";
    if (/facebook|\bfb\b|meta/.test(source)) return "meta";
    return source ? "other" : "direct";
  }

  function captureAttribution() {
    const params = new URLSearchParams(location.search);
    const referrer = safeText(document.referrer, 1000);
    const referrerHost = (() => {
      try {
        return new URL(referrer).hostname;
      } catch {
        return "";
      }
    })();
    const source = safeText(
      params.get("utm_source") ||
      params.get("source") ||
      (params.get("ttclid") ? "tiktok" : "") ||
      (params.get("fbclid") ? "meta" : "") ||
      referrerHost,
      120
    );
    const hasCampaignSignal = [
      "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
      "fbclid", "ttclid", "wbraid", "gbraid"
    ].some(key => params.has(key));
    const touch = {
      channel: channelFrom(source),
      source: source || "direct",
      medium: safeText(params.get("utm_medium") || (hasCampaignSignal ? "paid_social" : "none"), 120),
      campaign: safeText(params.get("utm_campaign"), 180),
      content: safeText(params.get("utm_content"), 180),
      term: safeText(params.get("utm_term"), 180),
      clickId: safeText(
        params.get("ttclid") ||
        params.get("fbclid") ||
        params.get("wbraid") ||
        params.get("gbraid"),
        300
      ),
      landingPage: safeText(location.pathname + location.search, 1000),
      referrer,
      capturedAt: new Date().toISOString()
    };

    const first = readJson(FIRST_TOUCH_KEY, null);
    if (!first) writeJson(FIRST_TOUCH_KEY, touch);
    if (hasCampaignSignal || !readJson(LAST_TOUCH_KEY, null)) {
      writeJson(LAST_TOUCH_KEY, touch);
    }
    return {
      firstTouch: readJson(FIRST_TOUCH_KEY, touch),
      lastTouch: readJson(LAST_TOUCH_KEY, touch)
    };
  }

  const attribution = captureAttribution();
  const currentSession = session();

  function activeProduct() {
    const product = readJson("cajamoda-active-product", null);
    return product && typeof product === "object" ? product : {};
  }

  function currentLocation() {
    return readJson(LOCATION_KEY, {});
  }

  function eventPage() {
    const path = location.pathname.toLowerCase();
    if (path.startsWith("/product")) return "product";
    if (path.startsWith("/checkout")) return "checkout";
    if (path.startsWith("/order-confirmation")) return "order-confirmation";
    return "home";
  }

  function normalizeEventName(name, properties) {
    const type = safeText(name, 80).toLowerCase();
    const aliases = {
      product_view: "product_view",
      product_click: "product_click",
      favorite_toggle: properties?.active === false ? "unfavorite" : "favorite",
      share: "share",
      add_to_cart: "add_to_cart",
      bag_open: "bag_open",
      checkout_route: "checkout",
      checkout_started: "checkout",
      purchase_attempt: "buy_now",
      purchase: "purchase",
      page_view: "page_view",
      heartbeat: "heartbeat",
      page_leave: "page_leave"
    };
    return aliases[type] || type.replace(/[^a-z0-9_]/g, "_").slice(0, 50);
  }

  function baseEvent(name, properties = {}) {
    const product = activeProduct();
    const locationData = currentLocation();
    const productId = safeText(properties.productId || product.id, 120);
    const productMatches = !properties.productId || String(product.id || "") === String(properties.productId);
    const value = Number(
      properties.value ??
      properties.cartTotal ??
      properties.price ??
      (productMatches ? product.price : 0)
    );
    const quantity = Number(properties.quantity ?? properties.cartCount ?? 0);
    return {
      eventId: safeText(properties.eventId || createId("evt"), 80),
      eventType: normalizeEventName(name, properties),
      occurredAt: safeText(properties.occurredAt || new Date().toISOString(), 40),
      sessionId: currentSession.id,
      visitorId: visitorId(),
      page: safeText(properties.page || eventPage(), 80),
      path: safeText(location.pathname + location.search, 1000),
      productId,
      productName: safeText(
        properties.productName || (productMatches ? product.name : ""),
        300
      ),
      productImage: safeText(
        properties.productImage ||
        properties.image ||
        (productMatches ? product.image || product.media?.[0]?.url : ""),
        1500
      ),
      categoryId: safeText(properties.categoryId || (productMatches ? product.category : ""), 120),
      quantity: Number.isFinite(quantity) ? quantity : 0,
      value: Number.isFinite(value) ? value : 0,
      currency: safeText(properties.currency || "COP", 10),
      firstTouch: attribution.firstTouch,
      lastTouch: attribution.lastTouch,
      location: {
        city: safeText(properties.city || locationData.city, 150),
        region: safeText(properties.region || properties.state || locationData.region, 150),
        country: safeText(properties.country || locationData.country || "CO", 10),
        locale: safeText(navigator.language, 40),
        timezone: safeText(Intl.DateTimeFormat().resolvedOptions().timeZone, 80)
      },
      referrer: safeText(document.referrer, 1000),
      properties: Object.fromEntries(
        Object.entries(properties)
          .filter(([key]) => !["eventId", "occurredAt"].includes(key))
          .slice(0, 40)
      )
    };
  }

  function flush(useBeacon = false) {
    clearTimeout(flushTimer);
    flushTimer = 0;
    if (!queue.length) return;
    const events = queue.splice(0, 20);
    const body = JSON.stringify({ events });
    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }));
    } else {
      fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body,
        keepalive: true,
        credentials: "same-origin"
      }).then(response => {
        if (!response.ok) throw new Error("Analytics request failed.");
      }).catch(() => {
        const retryable = events
          .filter(event => Number(event.retryCount || 0) < 2)
          .map(event => ({ ...event, retryCount: Number(event.retryCount || 0) + 1 }));
        if (retryable.length) {
          window.setTimeout(() => {
            queue.unshift(...retryable);
            if (!flushTimer) flushTimer = window.setTimeout(() => flush(false), 250);
          }, 1000 * (retryable[0].retryCount + 1));
        }
      });
    }
    if (queue.length) flushTimer = window.setTimeout(() => flush(false), 250);
  }

  function track(name, properties = {}) {
    queue.push(baseEvent(name, properties));
    if (queue.length >= 10) flush(false);
    else if (!flushTimer) flushTimer = window.setTimeout(() => flush(false), 180);
  }

  function setLocation(locationData = {}) {
    const current = currentLocation();
    const next = {
      ...current,
      city: safeText(locationData.city || current.city, 150),
      region: safeText(locationData.region || locationData.state || current.region, 150),
      country: safeText(locationData.country || current.country || "CO", 10)
    };
    writeJson(LOCATION_KEY, next);
    return next;
  }

  function context() {
    return {
      sessionId: currentSession.id,
      visitorId: visitorId(),
      firstTouch: attribution.firstTouch,
      lastTouch: attribution.lastTouch,
      location: currentLocation()
    };
  }

  window.CajaModaAnalytics = {
    track,
    flush,
    context,
    setLocation,
    version: "build-241"
  };

  track("PAGE_VIEW", {
    title: document.title,
    viewport: String(window.innerWidth) + "x" + String(window.innerHeight)
  });

  if (eventPage() === "checkout") {
    window.setTimeout(() => {
      const cart = readJson("cajamoda-checkout-cart", readJson("cajamoda-cart", {}));
      const items = Array.isArray(cart?.items) ? cart.items : [];
      if (items.length) {
        track("CHECKOUT_STARTED", {
          cartCount: Number(cart.count || items.reduce((sum, item) => sum + Number(item.quantity || 1), 0)),
          cartTotal: Number(cart.total || items.reduce((sum, item) => sum + Number(item.price || item.unitPrice || 0) * Number(item.quantity || 1), 0)),
          items: items.slice(0, 50).map(item => ({
            productId: safeText(item.productId, 120),
            productName: safeText(item.name || item.productName, 300),
            productImage: safeText(item.image, 1500),
            quantity: Math.max(1, Number(item.quantity || 1)),
            value: Number(item.price || item.unitPrice || 0)
          }))
        });
      }
    }, 0);
  }

  const heartbeat = window.setInterval(() => {
    if (document.visibilityState === "visible") {
      track("HEARTBEAT", {
        durationSeconds: Math.round((Date.now() - startedAt) / 1000)
      });
    }
  }, HEARTBEAT_MS);

  window.addEventListener("pagehide", () => {
    clearInterval(heartbeat);
    queue.push(baseEvent("PAGE_LEAVE", {
      durationSeconds: Math.round((Date.now() - startedAt) / 1000)
    }));
    flush(true);
  });
})();
