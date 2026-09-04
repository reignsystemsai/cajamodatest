import crypto from "node:crypto";

const COLLECTION_ID = "CajaModaAnalyticsEvents";
const SETTINGS_ID = "cajamoda-analytics-settings";
const ACTIVE_WINDOW_MS = 45 * 1000;
const MAX_QUERY_ITEMS = 20000;
const LOADER_ACTIVE_WINDOW_MS = 45 * 1000;
const ALLOWED_EVENTS = new Set([
  "page_view",
  "product_view",
  "product_click",
  "favorite",
  "unfavorite",
  "share",
  "add_to_cart",
  "bag_open",
  "checkout",
  "buy_now",
  "purchase",
  "order_created",
  "heartbeat",
  "page_leave",
  "category_anchor_click",
  "category_filter",
  "product_category_switch",
  "product_swipe",
  "product_details_open",
  "delivery_info_open",
  "search",
  "plus_menu_open",
  "profile_open",
  "size_selected",
  "sold_out_selected"
  ,"chat_message"
]);

function safeText(value, limit = 300) {
  return String(value ?? "").trim().slice(0, limit);
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function boundedNumber(value, minimum, maximum, fallback = 0) {
  return Math.min(maximum, Math.max(minimum, finiteNumber(value, fallback)));
}

function eventDate(value, fallback = new Date()) {
  const date = value instanceof Date ? value : new Date(value || fallback);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function compactValue(value, depth = 0) {
  if (depth > 4 || value === undefined || typeof value === "function") return null;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return safeText(value, 1500);
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (Array.isArray(value)) return value.slice(0, 50).map(item => compactValue(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 40)
        .map(([key, item]) => [safeText(key, 80), compactValue(item, depth + 1)])
    );
  }
  return safeText(value, 300);
}

function channelName(value) {
  const channel = safeText(value, 80).toLowerCase();
  if (channel.includes("whatsapp") || channel === "wa") return "whatsapp";
  if (channel.includes("instagram") || channel === "ig") return "instagram";
  if (channel.includes("tiktok")) return "tiktok";
  if (channel.includes("facebook") || channel.includes("meta")) return "meta";
  if (!channel || channel === "none") return "direct";
  return ["direct", "other"].includes(channel) ? channel : "other";
}

function startOfUtcDay(value) {
  const date = eventDate(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function dayKey(value) {
  return startOfUtcDay(value).toISOString().slice(0, 10);
}

function monthBounds(reference = new Date()) {
  const currentStart = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), 1));
  const previousStart = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() - 1, 1));
  const nextStart = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() + 1, 1));
  return { currentStart, previousStart, nextStart };
}

function monthKey(value = new Date()) {
  const match = safeText(value, 20).match(/^(\d{4})-(\d{2})$/);
  if (match) return match[1] + "-" + match[2];
  const date = eventDate(value);
  return date.getUTCFullYear() + "-" + String(date.getUTCMonth() + 1).padStart(2, "0");
}

function selectedMonthBounds(value) {
  const key = monthKey(value);
  const [year, month] = key.split("-").map(Number);
  return {
    key,
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 1)),
    days: new Date(Date.UTC(year, month, 0)).getUTCDate()
  };
}

function paidOrder(order) {
  return ["PAID", "PARTIALLY_PAID"].includes(safeText(order?.paymentStatus, 40).toUpperCase());
}

function cleanAnalyticsContext(input = {}) {
  const firstTouch = compactValue(input?.firstTouch || {});
  const lastTouch = compactValue(input?.lastTouch || {});
  const location = compactValue(input?.location || {});
  return {
    sessionId: safeText(input?.sessionId, 100),
    visitorId: safeText(input?.visitorId, 100),
    firstTouch,
    lastTouch,
    location
  };
}

function stripeMetadataFromContext(input = {}) {
  const context = cleanAnalyticsContext(input);
  const first = context.firstTouch || {};
  const last = context.lastTouch || {};
  const location = context.location || {};
  return {
    analyticsSessionId: safeText(context.sessionId, 100),
    analyticsVisitorId: safeText(context.visitorId, 100),
    analyticsChannel: safeText(last.channel, 80),
    analyticsSource: safeText(last.source, 120),
    analyticsMedium: safeText(last.medium, 120),
    analyticsCampaign: safeText(last.campaign, 180),
    analyticsContent: safeText(last.content, 180),
    analyticsClickId: safeText(last.clickId, 300),
    analyticsFirstChannel: safeText(first.channel, 80),
    analyticsFirstSource: safeText(first.source, 120),
    analyticsCity: safeText(location.city, 150),
    analyticsRegion: safeText(location.region, 150),
    analyticsCountry: safeText(location.country, 10)
  };
}

function contextFromStripeMetadata(metadata = {}) {
  return cleanAnalyticsContext({
    sessionId: metadata.analyticsSessionId,
    visitorId: metadata.analyticsVisitorId,
    firstTouch: {
      channel: metadata.analyticsFirstChannel,
      source: metadata.analyticsFirstSource
    },
    lastTouch: {
      channel: metadata.analyticsChannel,
      source: metadata.analyticsSource,
      medium: metadata.analyticsMedium,
      campaign: metadata.analyticsCampaign,
      content: metadata.analyticsContent,
      clickId: metadata.analyticsClickId
    },
    location: {
      city: metadata.analyticsCity,
      region: metadata.analyticsRegion,
      country: metadata.analyticsCountry
    }
  });
}

function productMetricRecord(event) {
  return {
    productId: safeText(event?.productId, 120),
    name: safeText(event?.productName, 300) || "Product",
    image: safeText(event?.productImage, 1500),
    views: 0,
    favorites: 0,
    shares: 0,
    addToCart: 0,
    checkouts: 0,
    purchases: 0
  };
}

function lineItemsFromProperties(event) {
  const items = event?.properties?.items;
  return Array.isArray(items) ? items.slice(0, 50) : [];
}

function displayAction(eventType) {
  const labels = {
    page_view: "Viewing page",
    product_view: "Viewing product",
    product_click: "Opened product",
    favorite: "Added favorite",
    unfavorite: "Removed favorite",
    share: "Shared product",
    add_to_cart: "Added to cart",
    bag_open: "Opened cart",
    checkout: "At checkout",
    buy_now: "Buying now",
    purchase: "Purchased",
    order_created: "Order created",
    heartbeat: "Browsing",
    page_leave: "Left page"
  };
  return labels[eventType] || safeText(eventType, 80).replaceAll("_", " ");
}

export function createAnalyticsService({ wix, getOrders }) {
  let collectionReady = null;
  const activeSessions = new Map();
  const rateLimits = new Map();
  const loaderPresence = new Map();

  function requireWix() {
    if (!wix?.dataItems || !wix?.dataCollections) {
      const error = new Error("Analytics storage is not configured.");
      error.statusCode = 503;
      throw error;
    }
  }

  async function ensureCollection() {
    requireWix();
    if (collectionReady) return collectionReady;
    collectionReady = (async () => {
      try {
        await wix.dataCollections.getDataCollection(COLLECTION_ID);
        return true;
      } catch {}

      const fields = [
        ["eventId", "TEXT"],
        ["eventType", "TEXT"],
        ["occurredAt", "DATETIME"],
        ["receivedAt", "DATETIME"],
        ["sessionId", "TEXT"],
        ["visitorId", "TEXT"],
        ["page", "TEXT"],
        ["path", "TEXT"],
        ["productId", "TEXT"],
        ["productName", "TEXT"],
        ["productImage", "URL"],
        ["categoryId", "TEXT"],
        ["quantity", "NUMBER"],
        ["value", "NUMBER"],
        ["currency", "TEXT"],
        ["channel", "TEXT"],
        ["source", "TEXT"],
        ["medium", "TEXT"],
        ["campaign", "TEXT"],
        ["content", "TEXT"],
        ["term", "TEXT"],
        ["clickId", "TEXT"],
        ["firstChannel", "TEXT"],
        ["firstSource", "TEXT"],
        ["city", "TEXT"],
        ["region", "TEXT"],
        ["country", "TEXT"],
        ["locale", "TEXT"],
        ["timezone", "TEXT"],
        ["referrer", "URL"],
        ["properties", "ANY"],
        ["orderId", "TEXT"],
        ["paymentMethod", "TEXT"],
        ["serverVerified", "BOOLEAN"],
        ["adSpendWhatsapp", "NUMBER"],
        ["adSpendInstagram", "NUMBER"],
        ["adSpendTiktok", "NUMBER"],
        ["inventorySpend", "NUMBER"],
        ["month", "TEXT"],
        ["grossMarginPercent", "NUMBER"]
      ].map(([key, type]) => ({
        key,
        type,
        displayName: key
      }));

      try {
        await wix.dataCollections.createDataCollection({
          _id: COLLECTION_ID,
          displayName: "CajaModa Analytics Events",
          displayField: "eventType",
          fields,
          permissions: {
            insert: "ADMIN",
            update: "ADMIN",
            remove: "ADMIN",
            read: "ADMIN"
          }
        });
      } catch (createError) {
        try {
          await wix.dataCollections.getDataCollection(COLLECTION_ID);
        } catch {
          collectionReady = null;
          throw createError;
        }
      }
      return true;
    })();
    return collectionReady;
  }

  function analyticsItem(event, serverVerified = false) {
    const first = compactValue(event?.firstTouch || {});
    const last = compactValue(event?.lastTouch || {});
    const location = compactValue(event?.location || {});
    const eventId = safeText(event?.eventId, 100) || crypto.randomUUID();
    const sessionId = safeText(event?.sessionId, 100);
    const digest = crypto
      .createHash("sha256")
      .update(sessionId + "|" + eventId)
      .digest("hex")
      .slice(0, 40);
    return {
      _id: "a-" + digest,
      eventId,
      eventType: safeText(event?.eventType, 50).toLowerCase(),
      occurredAt: eventDate(event?.occurredAt),
      receivedAt: new Date(),
      sessionId,
      visitorId: safeText(event?.visitorId, 100),
      page: safeText(event?.page, 80),
      path: safeText(event?.path, 1000),
      productId: safeText(event?.productId, 120),
      productName: safeText(event?.productName, 300),
      productImage: safeText(event?.productImage, 1500),
      categoryId: safeText(event?.categoryId, 120),
      quantity: boundedNumber(event?.quantity, 0, 100000, 0),
      value: boundedNumber(event?.value, 0, 1000000000000, 0),
      currency: safeText(event?.currency || "COP", 10),
      channel: channelName(last.channel || last.source),
      source: safeText(last.source, 120),
      medium: safeText(last.medium, 120),
      campaign: safeText(last.campaign, 180),
      content: safeText(last.content, 180),
      term: safeText(last.term, 180),
      clickId: safeText(last.clickId, 300),
      firstChannel: channelName(first.channel || first.source),
      firstSource: safeText(first.source, 120),
      city: safeText(location.city, 150),
      region: safeText(location.region, 150),
      country: safeText(location.country, 10),
      locale: safeText(location.locale, 40),
      timezone: safeText(location.timezone, 80),
      referrer: safeText(event?.referrer, 1000),
      properties: compactValue(event?.properties || {}),
      orderId: safeText(event?.orderId, 150),
      paymentMethod: safeText(event?.paymentMethod, 40),
      serverVerified: serverVerified || event?.serverVerified === true
    };
  }

  function updateLiveSession(event) {
    const sessionId = safeText(event?.sessionId, 100);
    if (!sessionId) return;
    if (event.eventType === "page_leave") {
      activeSessions.delete(sessionId);
      return;
    }
    const timestamp = eventDate(event.occurredAt).getTime();
    const current = activeSessions.get(sessionId) || {
      sessionId,
      visitorId: safeText(event.visitorId, 100),
      firstSeenAt: timestamp
    };
    activeSessions.set(sessionId, {
      ...current,
      visitorId: safeText(event.visitorId, 100) || current.visitorId,
      page: safeText(event.page, 80) || current.page,
      path: safeText(event.path, 1000) || current.path,
      city: safeText(event.location?.city, 150) || current.city,
      region: safeText(event.location?.region, 150) || current.region,
      country: safeText(event.location?.country, 10) || current.country,
      channel: channelName(event.lastTouch?.channel || event.lastTouch?.source || current.channel),
      campaign: safeText(event.lastTouch?.campaign, 180) || current.campaign,
      productName: safeText(event.productName, 300) || current.productName,
      lastAction: ["heartbeat", "page_view"].includes(event.eventType)
        ? current.lastAction || displayAction(event.eventType)
        : displayAction(event.eventType),
      lastSeenAt: Date.now(),
      durationSeconds: Math.max(
        finiteNumber(event.properties?.durationSeconds, 0),
        Math.round((Date.now() - current.firstSeenAt) / 1000)
      )
    });
  }

  function allowRequest(request, events) {
    const sessionId = safeText(events?.[0]?.sessionId, 100);
    const forwarded = safeText(request?.headers?.["x-forwarded-for"], 200).split(",")[0].trim();
    const key = sessionId || forwarded || "anonymous";
    const timestamp = Date.now();
    const current = rateLimits.get(key);
    if (!current || current.windowStartedAt < timestamp - 60000) {
      rateLimits.set(key, { windowStartedAt: timestamp, count: events.length });
      return true;
    }
    current.count += events.length;
    if (current.count > 120) return false;
    if (rateLimits.size > 5000) {
      for (const [candidate, state] of rateLimits) {
        if (state.windowStartedAt < timestamp - 120000) rateLimits.delete(candidate);
      }
    }
    return true;
  }

  async function writeEvents(events, serverVerified = false) {
    if (!events.length) return 0;
    await ensureCollection();
    const items = events.map(event => analyticsItem(event, serverVerified));
    await wix.dataItems.bulkSave(COLLECTION_ID, items);
    return items.length;
  }

  async function ingestClientEvents(request, rawEvents) {
    const events = (Array.isArray(rawEvents) ? rawEvents : [])
      .slice(0, 20)
      .map(event => ({
        ...event,
        eventType: safeText(event?.eventType, 50).toLowerCase(),
        properties: compactValue(event?.properties || {}),
        firstTouch: compactValue(event?.firstTouch || {}),
        lastTouch: compactValue(event?.lastTouch || {}),
        location: compactValue(event?.location || {})
      }))
      .filter(event =>
        ALLOWED_EVENTS.has(event.eventType) &&
        safeText(event.eventId, 100) &&
        safeText(event.sessionId, 100)
      );

    if (!events.length) {
      const error = new Error("No valid analytics events were received.");
      error.statusCode = 400;
      throw error;
    }
    if (!allowRequest(request, events)) {
      const error = new Error("Analytics rate limit exceeded.");
      error.statusCode = 429;
      throw error;
    }

    events.forEach(updateLiveSession);
    const accepted = await writeEvents(events, false);
    return { accepted };
  }

  async function readSettings(month = monthKey()) {
    await ensureCollection();
    const key = monthKey(month);
    const item = await wix.dataItems.get(COLLECTION_ID, SETTINGS_ID + "-" + key).catch(() => null);
    return {
      month: key,
      adSpendWhatsapp: boundedNumber(item?.adSpendWhatsapp, 0, 1000000000000, 0),
      adSpendInstagram: boundedNumber(item?.adSpendInstagram, 0, 1000000000000, 0),
      adSpendTiktok: boundedNumber(item?.adSpendTiktok, 0, 1000000000000, 0),
      inventorySpend: boundedNumber(item?.inventorySpend, 0, 1000000000000, 0),
      grossMarginPercent: boundedNumber(item?.grossMarginPercent, 0, 100, 0),
      updatedAt: item?._updatedDate || null
    };
  }

  async function saveSettings(input = {}) {
    await ensureCollection();
    const month = monthKey(input.month);
    const settings = {
      month,
      adSpendWhatsapp: boundedNumber(input.adSpendWhatsapp, 0, 1000000000000, 0),
      adSpendInstagram: boundedNumber(input.adSpendInstagram, 0, 1000000000000, 0),
      adSpendTiktok: boundedNumber(input.adSpendTiktok, 0, 1000000000000, 0),
      inventorySpend: boundedNumber(input.inventorySpend, 0, 1000000000000, 0),
      grossMarginPercent: boundedNumber(input.grossMarginPercent, 0, 100, 0)
    };
    await wix.dataItems.save(COLLECTION_ID, {
      _id: SETTINGS_ID + "-" + month,
      eventId: SETTINGS_ID + "-" + month,
      eventType: "settings",
      occurredAt: new Date(),
      receivedAt: new Date(),
      serverVerified: true,
      ...settings
    });
    return readSettings(month);
  }

  async function queryEvents(since) {
    await ensureCollection();
    let page = await wix.dataItems
      .query(COLLECTION_ID)
      .ge("occurredAt", since)
      .ne("eventType", "settings")
      .descending("occurredAt")
      .limit(1000)
      .find();
    const events = [...page.items];
    while (page.hasNext() && events.length < MAX_QUERY_ITEMS) {
      page = await page.next();
      events.push(...page.items);
    }
    return events.slice(0, MAX_QUERY_ITEMS);
  }

  async function findOrderContext(orderId) {
    if (!orderId) return null;
    await ensureCollection();
    const result = await wix.dataItems
      .query(COLLECTION_ID)
      .eq("orderId", safeText(orderId, 150))
      .descending("occurredAt")
      .limit(10)
      .find();
    return result.items.find(item => item.eventType === "order_created" || item.eventType === "purchase") || null;
  }

  function eventFromStoredContext(stored = {}) {
    return {
      sessionId: stored.sessionId,
      visitorId: stored.visitorId,
      firstTouch: {
        channel: stored.firstChannel,
        source: stored.firstSource
      },
      lastTouch: {
        channel: stored.channel,
        source: stored.source,
        medium: stored.medium,
        campaign: stored.campaign,
        content: stored.content,
        term: stored.term,
        clickId: stored.clickId
      },
      location: {
        city: stored.city,
        region: stored.region,
        country: stored.country
      }
    };
  }

  async function recordOrderContext({ externalId, order, analyticsContext, items, value, paymentMethod }) {
    const context = cleanAnalyticsContext(analyticsContext);
    const orderId = safeText(order?._id || order?.id, 150);
    return writeEvents([{
      eventId: "order-created-" + safeText(externalId || orderId, 150),
      eventType: "order_created",
      occurredAt: new Date(),
      orderId,
      paymentMethod: safeText(paymentMethod, 40),
      value: finiteNumber(value, 0),
      currency: "COP",
      ...context,
      properties: {
        orderNumber: safeText(order?.number, 100),
        items: compactValue(items || [])
      }
    }], true);
  }

  async function recordPurchase({
    externalId,
    order,
    analyticsContext,
    stripeMetadata,
    items,
    value,
    paymentMethod
  }) {
    const orderId = safeText(order?._id || order?.id, 150);
    let context = cleanAnalyticsContext(
      analyticsContext ||
      (stripeMetadata ? contextFromStripeMetadata(stripeMetadata) : {})
    );
    if (!context.sessionId && orderId) {
      const stored = await findOrderContext(orderId).catch(() => null);
      if (stored) context = cleanAnalyticsContext(eventFromStoredContext(stored));
    }
    return writeEvents([{
      eventId: "verified-purchase-" + safeText(externalId || orderId, 150),
      eventType: "purchase",
      occurredAt: new Date(),
      orderId,
      paymentMethod: safeText(paymentMethod, 40),
      value: finiteNumber(value, 0),
      currency: "COP",
      ...context,
      properties: {
        orderNumber: safeText(order?.number, 100),
        items: compactValue(items || [])
      }
    }], true);
  }

  function sessionAttribution(events) {
    const sessions = new Map();
    for (const event of events) {
      const sessionId = safeText(event.sessionId, 100);
      if (!sessionId || sessions.has(sessionId)) continue;
      sessions.set(sessionId, {
        channel: channelName(event.channel || event.source),
        source: safeText(event.source, 120),
        campaign: safeText(event.campaign, 180) || "Untracked"
      });
    }
    return sessions;
  }

  function getLiveSessions() {
    const timestamp = Date.now();
    const result = [];
    for (const [sessionId, session] of activeSessions) {
      if (session.lastSeenAt < timestamp - ACTIVE_WINDOW_MS) {
        activeSessions.delete(sessionId);
        continue;
      }
      result.push({
        sessionId,
        visitorId: session.visitorId,
        page: session.page || "home",
        path: session.path || "/",
        city: session.city || "Unknown",
        region: session.region || "",
        country: session.country || "",
        channel: session.channel || "direct",
        campaign: session.campaign || "",
        productName: session.productName || "",
        action: session.lastAction || "Browsing",
        timeOnSiteSeconds: Math.max(
          finiteNumber(session.durationSeconds, 0),
          Math.round((timestamp - session.firstSeenAt) / 1000)
        ),
        lastSeenAt: new Date(session.lastSeenAt).toISOString()
      });
    }
    return result.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
  }

  async function dashboard(daysInput = 30, monthInput = monthKey()) {
    const selected = selectedMonthBounds(monthInput);
    const days = selected.days;
    const since = selected.start;
    const [rawEvents, allOrders, settings] = await Promise.all([
      queryEvents(since),
      getOrders(),
      readSettings(selected.key)
    ]);
    const events = rawEvents.filter(event => eventDate(event.occurredAt) < selected.end);
    const orders = (Array.isArray(allOrders) ? allOrders : [])
      .filter(order => paidOrder(order) && eventDate(order.date) >= since && eventDate(order.date) < selected.end);
    const eventCounts = new Map();
    for (const event of events) {
      eventCounts.set(event.eventType, (eventCounts.get(event.eventType) || 0) + 1);
    }

    const sessionMap = sessionAttribution(events);
    const checkoutSessions = new Set(
      events.filter(event => event.eventType === "checkout").map(event => event.sessionId).filter(Boolean)
    );
    const purchaseEvents = events.filter(event => event.eventType === "purchase" && event.serverVerified);
    const purchaseByOrder = new Map(
      purchaseEvents.filter(event => event.orderId).map(event => [String(event.orderId), event])
    );
    const purchaseSessions = new Set(purchaseEvents.map(event => event.sessionId).filter(Boolean));
    const productViewSessions = new Set(
      events.filter(event => event.eventType === "product_view").map(event => event.sessionId).filter(Boolean)
    );
    const cartSessions = new Set(
      events.filter(event => event.eventType === "add_to_cart").map(event => event.sessionId).filter(Boolean)
    );

    const productMetrics = new Map();
    function productRecord(productId, source = {}) {
      const id = safeText(productId, 120);
      if (!id) return null;
      if (!productMetrics.has(id)) {
        productMetrics.set(id, {
          ...productMetricRecord(source),
          productId: id
        });
      }
      const record = productMetrics.get(id);
      const candidateName = safeText(source.productName || source.name, 300);
      const candidateImage = safeText(source.productImage || source.image, 1500);
      if (candidateName && record.name === "Product") record.name = candidateName;
      if (candidateImage && !record.image) record.image = candidateImage;
      return record;
    }

    for (const event of events) {
      const direct = productRecord(event.productId, event);
      if (direct) {
        if (event.eventType === "product_view") direct.views += 1;
        if (event.eventType === "favorite") direct.favorites += 1;
        if (event.eventType === "share") direct.shares += 1;
        if (event.eventType === "add_to_cart") direct.addToCart += Math.max(1, finiteNumber(event.quantity, 1));
      }
      if (event.eventType === "checkout") {
        const seenProducts = new Set();
        for (const item of lineItemsFromProperties(event)) {
          const id = safeText(item.productId, 120);
          if (!id || seenProducts.has(id)) continue;
          seenProducts.add(id);
          const record = productRecord(id, item);
          if (record) record.checkouts += 1;
        }
      }
    }

    for (const order of orders) {
      for (const item of Array.isArray(order.items) ? order.items : []) {
        const record = productRecord(item.productId, item);
        if (record) record.purchases += Math.max(1, finiteNumber(item.quantity, 1));
      }
    }

    const today = startOfUtcDay(new Date());
    const series = Array.from({ length: days }, (_, index) => {
      const date = new Date(since.getTime() + index * 24 * 60 * 60 * 1000);
      return {
        date: dayKey(date),
        views: 0,
        favorites: 0,
        shares: 0,
        addToCart: 0,
        checkouts: 0,
        purchases: 0,
        revenue: 0
      };
    });
    const seriesByDate = new Map(series.map(item => [item.date, item]));
    for (const event of events) {
      const point = seriesByDate.get(dayKey(event.occurredAt));
      if (!point) continue;
      if (event.eventType === "product_view") point.views += 1;
      if (event.eventType === "favorite") point.favorites += 1;
      if (event.eventType === "share") point.shares += 1;
      if (event.eventType === "add_to_cart") point.addToCart += 1;
      if (event.eventType === "checkout") point.checkouts += 1;
    }
    for (const order of orders) {
      const point = seriesByDate.get(dayKey(order.date));
      if (!point) continue;
      point.purchases += 1;
      point.revenue += finiteNumber(order.total, 0);
    }

    const channels = new Map();
    const spendByChannel = {
      whatsapp: settings.adSpendWhatsapp,
      instagram: settings.adSpendInstagram,
      tiktok: settings.adSpendTiktok,
      meta: 0,
      direct: 0,
      other: 0
    };
    function channelRecord(key) {
      const channel = channelName(key);
      if (!channels.has(channel)) {
        channels.set(channel, {
          channel,
          sessions: new Set(),
          views: 0,
          addToCart: 0,
          checkouts: 0,
          purchases: 0,
          revenue: 0,
          spend: finiteNumber(spendByChannel[channel], 0)
        });
      }
      return channels.get(channel);
    }
    for (const [sessionId, attribution] of sessionMap) {
      channelRecord(attribution.channel).sessions.add(sessionId);
    }
    for (const event of events) {
      const attribution = sessionMap.get(event.sessionId) || { channel: event.channel || "direct" };
      const record = channelRecord(attribution.channel);
      if (event.eventType === "product_view") record.views += 1;
      if (event.eventType === "add_to_cart") record.addToCart += 1;
      if (event.eventType === "checkout") record.checkouts += 1;
    }
    for (const order of orders) {
      const purchase = purchaseByOrder.get(String(order.id));
      const attribution = sessionMap.get(purchase?.sessionId) || {
        channel: purchase?.channel || "direct"
      };
      const record = channelRecord(attribution.channel);
      record.purchases += 1;
      record.revenue += finiteNumber(order.total, 0);
    }

    ["whatsapp", "instagram", "tiktok", "direct"].forEach(channelRecord);
    const channelRows = [...channels.values()].map(record => ({
      ...record,
      sessions: record.sessions.size,
      roas: record.spend > 0 ? record.revenue / record.spend : null
    })).sort((left, right) => right.revenue - left.revenue || right.sessions - left.sessions);

    const campaignMap = new Map();
    for (const [sessionId, attribution] of sessionMap) {
      const key = attribution.channel + "|" + attribution.campaign;
      if (!campaignMap.has(key)) {
        campaignMap.set(key, {
          channel: attribution.channel,
          campaign: attribution.campaign,
          sessions: new Set(),
          purchases: 0,
          revenue: 0
        });
      }
      campaignMap.get(key).sessions.add(sessionId);
    }
    for (const order of orders) {
      const purchase = purchaseByOrder.get(String(order.id));
      const attribution = sessionMap.get(purchase?.sessionId) || {
        channel: channelName(purchase?.channel),
        campaign: safeText(purchase?.campaign, 180) || "Untracked"
      };
      const key = attribution.channel + "|" + attribution.campaign;
      if (!campaignMap.has(key)) {
        campaignMap.set(key, {
          channel: attribution.channel,
          campaign: attribution.campaign,
          sessions: new Set(),
          purchases: 0,
          revenue: 0
        });
      }
      const campaign = campaignMap.get(key);
      campaign.purchases += 1;
      campaign.revenue += finiteNumber(order.total, 0);
    }
    const campaigns = [...campaignMap.values()]
      .map(item => ({
        ...item,
        sessions: item.sessions.size,
        conversionRate: item.sessions.size ? item.purchases / item.sessions.size : 0
      }))
      .sort((left, right) => right.revenue - left.revenue || right.sessions - left.sessions)
      .slice(0, 20);

    const abandonedCarts = [...checkoutSessions].filter(sessionId => {
      if (purchaseSessions.has(sessionId)) return false;
      const latestCheckout = events.find(event => event.sessionId === sessionId && event.eventType === "checkout");
      return latestCheckout && eventDate(latestCheckout.occurredAt).getTime() < Date.now() - 30 * 60 * 1000;
    }).length;
    const revenue = orders.reduce((sum, order) => sum + finiteNumber(order.total, 0), 0);
    const cardRevenue = orders
      .filter(order => order.paymentMethod === "card")
      .reduce((sum, order) => sum + finiteNumber(order.total, 0), 0);
    const nequiRevenue = orders
      .filter(order => order.paymentMethod === "nequi")
      .reduce((sum, order) => sum + finiteNumber(order.total, 0), 0);
    const customerKeys = new Set(
      orders.map(order =>
        safeText(order.email, 250).toLowerCase() ||
        safeText(order.phone, 80) ||
        safeText(order.customer, 200)
      ).filter(Boolean)
    );
    const adSpend = settings.adSpendWhatsapp + settings.adSpendInstagram + settings.adSpendTiktok;
    const costOfGoodsSold = orders.reduce((sum, order) =>
      sum + (order.items || []).reduce((itemSum, item) =>
        itemSum + Math.max(0, finiteNumber(item.cost, 0)) * Math.max(1, finiteNumber(item.quantity, 1)), 0
      ), 0);
    const inventorySpend = finiteNumber(settings.inventorySpend, 0);
    const remainingInventoryValue = Math.max(0, inventorySpend - costOfGoodsSold);
    const grossProfit = revenue - costOfGoodsSold;
    const grossMarginPercent = revenue > 0 ? grossProfit / revenue * 100 : 0;
    const currentStart = selected.start;
    const nextStart = selected.end;
    const previousStart = new Date(Date.UTC(currentStart.getUTCFullYear(), currentStart.getUTCMonth() - 1, 1));
    const currentMonthRevenue = allOrders
      .filter(order => paidOrder(order) && eventDate(order.date) >= currentStart && eventDate(order.date) < nextStart)
      .reduce((sum, order) => sum + finiteNumber(order.total, 0), 0);
    const previousMonthRevenue = allOrders
      .filter(order => paidOrder(order) && eventDate(order.date) >= previousStart && eventDate(order.date) < currentStart)
      .reduce((sum, order) => sum + finiteNumber(order.total, 0), 0);
    const monthlyGrowth = previousMonthRevenue > 0
      ? (currentMonthRevenue - previousMonthRevenue) / previousMonthRevenue
      : currentMonthRevenue > 0 ? 1 : 0;

    const topProducts = [...productMetrics.values()]
      .sort((left, right) =>
        right.views - left.views ||
        right.addToCart - left.addToCart ||
        right.purchases - left.purchases
      )
      .slice(0, 100);
    const liveSessions = getLiveSessions();

    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      rangeDays: days,
      storage: {
        connected: true,
        collection: COLLECTION_ID,
        eventCount: events.length,
        capped: events.length >= MAX_QUERY_ITEMS
      },
      overview: {
        sessions: sessionMap.size,
        liveVisitors: liveSessions.length,
        productViews: eventCounts.get("product_view") || 0,
        favorites: eventCounts.get("favorite") || 0,
        shares: eventCounts.get("share") || 0,
        addToCart: eventCounts.get("add_to_cart") || 0,
        checkouts: checkoutSessions.size,
        purchases: orders.length,
        abandonedCarts,
        revenue,
        cardRevenue,
        nequiRevenue,
        customers: customerKeys.size,
        averageOrderValue: orders.length ? revenue / orders.length : 0,
        adSpend,
        customerAcquisitionCost: customerKeys.size ? adSpend / customerKeys.size : 0,
        inventorySpend,
        costOfGoodsSold,
        remainingInventoryValue,
        grossMarginPercent,
        grossProfit,
        monthlyGrowth,
        conversionRate: sessionMap.size ? orders.length / sessionMap.size : 0
      },
      funnel: [
        { key: "views", label: "Product views", value: productViewSessions.size },
        { key: "cart", label: "Added to cart", value: cartSessions.size },
        { key: "checkout", label: "Checkout", value: checkoutSessions.size },
        { key: "purchase", label: "Purchase", value: Math.max(purchaseSessions.size, orders.length) }
      ],
      timeseries: series,
      topProducts,
      channels: channelRows,
      campaigns,
      realtime: {
        activeVisitors: liveSessions.length,
        sessions: liveSessions
      },
      settings
    };
  }

  function touchLoader(role) {
    loaderPresence.set(role === "admin" ? "admin" : "owner", Date.now());
  }

  async function chat(role) {
    const self = role === "admin" ? "admin" : "owner";
    touchLoader(self);
    await ensureCollection();
    const result = await wix.dataItems.query(COLLECTION_ID)
      .eq("eventType", "chat_message")
      .descending("occurredAt")
      .limit(200)
      .find();
    const messages = [...result.items].reverse().map(item => ({
      id: item._id,
      sender: safeText(item.properties?.sender, 20),
      recipient: safeText(item.properties?.recipient, 20),
      message: safeText(item.properties?.message, 1000),
      sentAt: eventDate(item.occurredAt).toISOString()
    }));
    const peer = self === "admin" ? "owner" : "admin";
    return {
      self,
      peer,
      peerActive: finiteNumber(loaderPresence.get(peer), 0) > Date.now() - LOADER_ACTIVE_WINDOW_MS,
      messages: messages.filter(item =>
        (item.sender === self && item.recipient === peer) ||
        (item.sender === peer && item.recipient === self)
      )
    };
  }

  async function sendChatMessage(role, message) {
    const sender = role === "admin" ? "admin" : "owner";
    const recipient = sender === "admin" ? "owner" : "admin";
    const text = safeText(message, 1000);
    if (!text) {
      const error = new Error("Write a message first.");
      error.statusCode = 400;
      throw error;
    }
    touchLoader(sender);
    await writeEvents([{
      eventId: "chat-" + crypto.randomUUID(),
      eventType: "chat_message",
      occurredAt: new Date(),
      sessionId: "loader-" + sender,
      properties: { sender, recipient, message: text }
    }], true);
    return chat(sender);
  }

  return {
    ensureCollection,
    ingestClientEvents,
    dashboard,
    saveSettings,
    chat,
    sendChatMessage,
    recordOrderContext,
    recordPurchase,
    stripeMetadataFromContext,
    contextFromStripeMetadata
  };
}
