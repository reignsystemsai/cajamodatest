import http from "node:http";
import crypto from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import Stripe from "stripe";

import {
  NATIONAL_SHIPPING,
  STANDARD_CLOTHING_PARCEL,
  buildEnviaNationalPayload,
  customerEnviaTrackingLabel,
  groupNationalShipmentLines,
  groupWixOrderNationalLines,
  nationalLinesDeclaredValue,
  normalizeEnviaTrackingStatus,
  nationalShipmentDefinition,
  publicNationalShipmentPlan
} from "./shipping/shipping-service.js";

import {
  createClient,
  ApiKeyStrategy
} from "@wix/sdk";

import {
  productsV3,
  inventoryItemsV3
} from "@wix/stores";

import {
  files
} from "@wix/media";

import {
  orders as ecomOrders,
  orderFulfillments
} from "@wix/ecom";

import * as categoriesV3
  from "@wix/categories_categories";

import {
  items as wixDataItems,
  collections as wixDataCollections
} from "@wix/data";

import {
  createAnalyticsService
} from "./analytics/server.js";

/* ============================================================
   STORE LOADER BACKEND
   ------------------------------------------------------------
   Store Loader -> Secure Backend -> Wix
   ============================================================ */

const PORT =
  Number(
    process.env.PORT ||
    10000
  );

const DIST_ROOT =
  resolve(
    process.cwd(),
    "dist"
  );

const TEST_MODE = !process.env.WIX_API_KEY && !process.env.WIX_SITE_ID;

const mockProducts = [
  { id:"test-dress-001", masterProductId:"test-dress-001", source:"test", name:"Vestido Aurora", productType:"Vestido", vibeId:"sun", vibes:["sun"], price:129900, media:["https://images.unsplash.com/photo-1595777457583-95e059d581b8?auto=format&fit=crop&w=1200&q=85"], sizes:["S","M","L"], variants:["S","M","L"].map((size,index)=>({id:`test-dress-001-${size}`,productId:"test-dress-001",size,color:"Coral",sku:`P-AUR-${size}`,deliveryMode:"pickup",deliveryModes:["pickup"],price:129900,inStock:true,inventoryQuantity:8-index})), deliveryMode:"pickup",deliveryModes:["pickup"],inventoryMode:"STOCKED",inventoryStatus:"AVAILABLE",inventoryQuantity:21,description:"Vestido ligero de prueba para validar la experiencia CajaModa.",reviews:[] },
  { id:"test-set-002", masterProductId:"test-set-002", source:"test", name:"Set Noche", productType:"Conjunto", vibeId:"late", vibes:["late"], price:159900, media:["https://images.unsplash.com/photo-1566206091558-7f218b696731?auto=format&fit=crop&w=1200&q=85"], sizes:["S","M","L"], variants:["S","M","L"].map((size,index)=>({id:`test-set-002-${size}`,productId:"test-set-002",size,color:"Negro",sku:`P-NOC-${size}`,deliveryMode:"pickup",deliveryModes:["pickup"],price:159900,inStock:true,inventoryQuantity:5-index})), deliveryMode:"pickup",deliveryModes:["pickup"],inventoryMode:"STOCKED",inventoryStatus:"AVAILABLE",inventoryQuantity:12,description:"Conjunto elegante de prueba para noches especiales.",reviews:[] },
  { id:"test-top-003", masterProductId:"test-top-003", source:"test", name:"Top Brisa", productType:"Top", vibeId:"chill", vibes:["chill"], price:69900, media:["https://images.unsplash.com/photo-1564257577054-5f4094b4888c?auto=format&fit=crop&w=1200&q=85"], sizes:["S","M","L"], variants:["S","M","L"].map((size,index)=>({id:`test-top-003-${size}`,productId:"test-top-003",size,color:"Marfil",sku:`P-BRI-${size}`,deliveryMode:"pickup",deliveryModes:["pickup"],price:69900,inStock:true,inventoryQuantity:10-index})), deliveryMode:"pickup",deliveryModes:["pickup"],inventoryMode:"STOCKED",inventoryStatus:"AVAILABLE",inventoryQuantity:27,description:"Top versátil de prueba para looks de día.",reviews:[] }
];

const mockOrders = [];
const mockEvents = [];

function mockInventory() {
  return mockProducts.flatMap(product => product.variants.map(variant => ({
    id:variant.id, productId:product.id, productName:product.name, variantId:variant.id,
    variantName:variant.size, sku:variant.sku, quantity:variant.inventoryQuantity,
    price:product.price, image:product.media[0], category:product.vibeId, visible:true
  })));
}

function mockAnalytics() {
  const counts = type => mockEvents.filter(event => event.eventType === type).length;
  const purchases = mockOrders.length;
  const revenue = mockOrders.reduce((sum, order) => sum + Number(order.total || 0), 0);
  const sessions = Math.max(1, new Set(mockEvents.map(event => event.sessionId).filter(Boolean)).size);
  return {
    generatedAt:new Date().toISOString(), storage:{eventCount:mockEvents.length},
    overview:{liveVisitors:1,sessions,productViews:counts("product_view"),favorites:counts("favorite"),shares:counts("share"),addToCart:counts("add_to_cart"),checkouts:counts("checkout"),purchases,revenue,cardRevenue:0,nequiRevenue:revenue,conversionRate:purchases/sessions,averageOrderValue:purchases?revenue/purchases:0,abandonedCarts:Math.max(0,counts("checkout")-purchases),monthlyGrowth:0,inventorySpend:0,costOfGoodsSold:0,remainingInventoryValue:0,grossProfit:revenue,grossMarginPercent:100,adSpend:0,customerAcquisitionCost:0},
    timeseries:[], channels:[{channel:"direct",sessions,purchases,revenue}],
    funnel:[{key:"view",label:"Product views",value:counts("product_view")},{key:"cart",label:"Added to bag",value:counts("add_to_cart")},{key:"checkout",label:"Checkout",value:counts("checkout")},{key:"purchase",label:"Purchase",value:purchases}],
    topProducts:mockProducts.map(product=>({productId:product.id,name:product.name,image:product.media[0],views:mockEvents.filter(event=>event.productId===product.id&&event.eventType==="product_view").length,favorites:mockEvents.filter(event=>event.productId===product.id&&event.eventType==="favorite").length,shares:mockEvents.filter(event=>event.productId===product.id&&event.eventType==="share").length,addToCart:mockEvents.filter(event=>event.productId===product.id&&event.eventType==="add_to_cart").length,checkouts:0,purchases:0})),
    realtime:{visitors:[{sessionId:"test-session",page:"storefront",action:"Testing",city:"Cartagena",timeOnSiteSeconds:90}]}, campaigns:[], settings:{month:new Date().toISOString().slice(0,7),adSpendWhatsapp:0,adSpendInstagram:0,adSpendTiktok:0,inventorySpend:0}
  };
}

async function handleMockRequest(request,response,url) {
  if (!TEST_MODE) return false;
  if (request.method === "GET" && url.pathname === "/api/test/catalog") return sendJson(response,200,{ok:true,testMode:true,products:mockProducts}) || true;
  if (request.method === "GET" && url.pathname === "/api/category-routes") return sendJson(response,200,{ok:true,routes:{},showcaseSlots:{}}) || true;
  if (request.method === "GET" && url.pathname === "/api/reviews") return sendJson(response,200,{ok:true,reviews:{},summaries:{}}) || true;
  if (request.method === "GET" && url.pathname === "/api/store-owner/profile") return sendJson(response,200,{ok:true,profile:{role:"admin",storeId:"cajamodatest",storeName:"CajaModa Test",ownerName:"Test Workspace",commissionPercent:0,entryPath:"/admin/"}}) || true;
  if (request.method === "GET" && url.pathname === "/api/store-owner/summary") return sendJson(response,200,{ok:true,summary:{products:mockProducts.length,orders:mockOrders.length,inventory:mockInventory().length}}) || true;
  if (request.method === "GET" && url.pathname === "/api/inventory") return sendJson(response,200,{ok:true,inventory:mockInventory(),showcases:{}}) || true;
  if (request.method === "GET" && url.pathname === "/api/orders") return sendJson(response,200,{ok:true,orders:mockOrders}) || true;
  if (request.method === "GET" && url.pathname === "/api/store-owner/analytics") return sendJson(response,200,mockAnalytics()) || true;
  if (request.method === "POST" && url.pathname === "/api/store-owner/analytics/settings") return sendJson(response,200,{ok:true,settings:(await readBody(request))||{}}) || true;
  if (request.method === "POST" && url.pathname === "/api/analytics/events") { const body=await readBody(request); mockEvents.push(...(Array.isArray(body?.events)?body.events:[])); return sendJson(response,202,{ok:true,accepted:Array.isArray(body?.events)?body.events.length:0}) || true; }
  if (request.method === "GET" && url.pathname === "/api/checkout/config") return sendJson(response,200,{ok:true,testMode:true,stripe:{publishableKey:""},nequi:{phone:"3000000000",masked:"300 000 0000 (PRUEBA)"}}) || true;
  if (request.method === "POST" && url.pathname === "/api/checkout/validate") return sendJson(response,200,{ok:true,valid:true}) || true;
  if (request.method === "POST" && url.pathname === "/api/delivery/quote") return sendJson(response,200,{ok:true,quoteToken:"test-quote",quote:{method:"pickup",fee:0,title:"Prueba: recoger en punto"}}) || true;
  if (request.method === "POST" && ["/api/test/checkout","/api/nequi/orders"].includes(url.pathname)) { const body=await readBody(request); const number=`TEST-${String(mockOrders.length+1).padStart(4,"0")}`; const order={id:number,orderNumber:number,date:new Date().toISOString(),status:"paid-test",paymentMethod:"test",total:Number(body?.cart?.total||0),items:body?.cart?.items||[],customer:body?.customer||{},source:"test",canConfirmPayment:false}; mockOrders.unshift(order); mockEvents.push({eventType:"purchase",sessionId:body?.analytics?.sessionId||"test-session",value:order.total}); return sendJson(response,201,{ok:true,orderNumber:number,url:`/order-confirmation/?nequiOrder=${encodeURIComponent(number)}`,testMode:true}) || true; }
  return false;
}

const WIX_API_KEY =
  process.env.WIX_API_KEY;

const WIX_SITE_ID =
  process.env.WIX_SITE_ID;

const PUBLIC_WHATSAPP_NUMBER =
  safeEnv(
    process.env.WHATSAPP_NUMBER ||
    process.env.WHATSAPP_PHONE_NUMBER ||
    process.env.WHATSAPP_PHONE
  ).replace(/\D/g, "");

const LOADER_PASSWORD =
  process.env.LOADER_PASSWORD;

const SKU_4DIGIT_CODE =
  safeEnv(process.env.SKU_4DIGIT_CODE);

const PLATFORM_ADMIN_PASSWORD =
  safeEnv(process.env.PLATFORM_ADMIN_PASSWORD);

const STORE_OWNER_NAME =
  safeEnv(process.env.STORE_OWNER_NAME) || "Karolay Blanco";

const STORE_NAME =
  safeEnv(process.env.STORE_NAME) || "CajaModa Colombia";

const STORE_ID =
  safeEnv(process.env.STORE_ID) || "store-001";

const STORE_COMMISSION_PERCENT = Math.min(
  100,
  Math.max(0, Number(process.env.STORE_COMMISSION_PERCENT || 0))
);

const ALLOWED_ORIGIN =
  process.env.ALLOWED_ORIGIN ||
  "https://cajamoda.onrender.com";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_PUBLISHABLE_KEY = safeEnv(process.env.STRIPE_PUBLISHABLE_KEY);
const NEQUI_PHONE = safeEnv(process.env.NEQUI_PHONE);
const ENVIA_API_TOKEN = safeEnv(process.env.ENVIA_API_TOKEN);
const ENVIA_ENV = safeEnv(process.env.ENVIA_ENV).toLowerCase() === "sandbox" ? "sandbox" : "production";
const ENVIA_API_BASE = ENVIA_ENV === "sandbox" ? "https://api-test.envia.com" : "https://api.envia.com";
const ENVIA_QUERIES_BASE = ENVIA_ENV === "sandbox" ? "https://queries-test.envia.com" : "https://queries.envia.com";
const ENVIA_GEOCODES_BASE = "https://geocodes.envia.com";
const COLOMBIA_MUNICIPALITIES_URL = "https://www.datos.gov.co/resource/gdxc-w37w.json?$select=cod_dpto,dpto,cod_mpio,nom_mpio&$limit=2000";
const ENVIA_PRINT_FORMAT = safeEnv(process.env.ENVIA_PRINT_FORMAT) || "PDF";
const ENVIA_PRINT_SIZE = safeEnv(process.env.ENVIA_PRINT_SIZE) || "PAPER_4X6";
const ENVIA_WEBHOOK_SECRET = safeEnv(process.env.ENVIA_WEBHOOK_SECRET);
const ENVIA_ORIGIN_NAME = safeEnv(process.env.ENVIA_ORIGIN_NAME);
const ENVIA_ORIGIN_PHONE = safeEnv(process.env.ENVIA_ORIGIN_PHONE);
const ENVIA_ORIGIN_STREET = safeEnv(process.env.ENVIA_ORIGIN_STREET);
const ENVIA_ORIGIN_POSTAL_CODE = safeEnv(process.env.ENVIA_ORIGIN_POSTAL_CODE);
const GOOGLE_MAPS_API_KEY = safeEnv(process.env.GOOGLE_MAPS_API_KEY);
const PICKUP_FEE_COP = 10000;
const MOTO_BASE_FEE_COP = 8000;
const MOTO_INCLUDED_KM = 3;
const MOTO_EXTRA_KM_COP = 1000;
const MOTO_QUOTE_CACHE_TTL = 24 * 60 * 60 * 1000;
const motoQuoteCache = new Map();
const colombiaMunicipalityCache = { loadedAt: 0, items: [] };
const googlePlaceDetailsCache = new Map();
const DELIVERY_REFERENCE_CACHE_TTL = 24 * 60 * 60 * 1000;
const GOOGLE_PLACE_CACHE_TTL = 30 * 60 * 1000;
const stripeIntentSyncLocks = new Map();
const nequiConfirmationLocks = new Map();
const enviaLabelLocks = new Map();
const enviaWebhookProcessing = new Set();
const processedEnviaWebhookIds = new Map();
const enviaShipmentStatuses = new Map();
const CARTAGENA_PICKUP_ADDRESS = "Cl. 35 #10-22, piso 1, local 1, San Diego, Cartagena de Indias, Bolívar, Colombia";
const STOREFRONT_URL = String(
  process.env.STOREFRONT_URL || "https://www.cajamoda.com"
).replace(/\/$/, "");

const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY)
  : null;

function safeEnv(value) {
  return String(value || "").trim();
}

/* ============================================================
   REQUIRED ENVIRONMENT
   ============================================================ */

const missing = [];

if (
  !WIX_API_KEY
) {
  missing.push(
    "WIX_API_KEY"
  );
}

if (
  !WIX_SITE_ID
) {
  missing.push(
    "WIX_SITE_ID"
  );
}

if (
  !LOADER_PASSWORD
) {
  missing.push(
    "LOADER_PASSWORD"
  );
}

if (
  missing.length
) {

  console.warn(
    `[Store Loader] Missing environment variables: ${missing.join(", ")}`
  );
}

/* ============================================================
   WIX ADMIN CLIENT
   ============================================================ */

const wix =
  WIX_API_KEY &&
  WIX_SITE_ID

    ? createClient({

        auth:
          ApiKeyStrategy({

            apiKey:
              WIX_API_KEY,

            siteId:
              WIX_SITE_ID
          }),

        modules: {

          productsV3,
          inventoryItemsV3,
          categoriesV3,
          files,

          dataItems:
            wixDataItems,

          dataCollections:
            wixDataCollections,

          orders:
            ecomOrders,

          orderFulfillments
        }
      })

    : null;

const analytics =
  createAnalyticsService({
    wix,
    getOrders:
      getWixOrdersForAnalytics
  });

/* ============================================================
   TEMPORARY STORE LOADER SESSIONS
   ============================================================ */

const sessions =
  new Map();

const SESSION_TTL =
  12 *
  60 *
  60 *
  1000;

/* ============================================================
   BASIC HELPERS
   ============================================================ */

function now() {

  return Date.now();
}

function createToken() {

  return crypto
    .randomBytes(32)
    .toString("hex");
}

function safeText(
  value,
  maxLength = 500
) {

  return String(
    value ??
    ""
  )
    .trim()
    .slice(
      0,
      maxLength
    );
}

function escapeHtml(
  value
) {

  return String(
    value ??
    ""
  )
    .replaceAll(
      "&",
      "&amp;"
    )
    .replaceAll(
      "<",
      "&lt;"
    )
    .replaceAll(
      ">",
      "&gt;"
    )
    .replaceAll(
      '"',
      "&quot;"
    )
    .replaceAll(
      "'",
      "&#039;"
    );
}

function sleep(
  milliseconds
) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        milliseconds
      )
  );
}

/* ============================================================
   CORS
   ============================================================ */

function setCors(
  request,
  response
) {

  const origin =
    request.headers.origin ||
    "";

  const allowed =

    origin ===
      ALLOWED_ORIGIN ||

    origin ===
      "https://admin.cajamoda.com" ||

    origin ===
      "https://cajamoda.com" ||

    origin ===
      "https://www.cajamoda.com" ||

    origin ===
      "http://localhost:5173" ||

    origin ===
      "http://127.0.0.1:5173";

  if (
    allowed
  ) {

    response.setHeader(
      "Access-Control-Allow-Origin",
      origin
    );
  }

  response.setHeader(
    "Vary",
    "Origin"
  );

  response.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PATCH,DELETE,OPTIONS"
  );

  response.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  response.setHeader(
    "Access-Control-Max-Age",
    "86400"
  );
}

/* ============================================================
   RESPONSES
   ============================================================ */

function sendJson(
  response,
  statusCode,
  payload
) {

  response.statusCode =
    statusCode;

  response.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  response.end(
    JSON.stringify(
      payload
    )
  );
}

function sendError(
  response,
  statusCode,
  message
) {

  sendJson(
    response,
    statusCode,
    {
      ok:
        false,

      error:
        message
    }
  );
}

/* ============================================================
   REQUEST BODY
   ============================================================ */

function readBody(
  request
) {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      const chunks = [];

      let size = 0;

      const maxSize =
        35 *
        1024 *
        1024;

      request.on(
        "data",
        chunk => {

          size +=
            chunk.length;

          if (
            size >
            maxSize
          ) {

            reject(
              new Error(
                "La carga es demasiado grande."
              )
            );

            request.destroy();

            return;
          }

          chunks.push(
            chunk
          );
        }
      );

      request.on(
        "end",
        () => {

          try {

            const raw =
              Buffer
                .concat(
                  chunks
                )
                .toString(
                  "utf8"
                );

            resolve(
              raw
                ? JSON.parse(
                    raw
                  )
                : {}
            );

          } catch {

            reject(
              new Error(
                "Solicitud inválida."
              )
            );
          }
        }
      );

      request.on(
        "error",
        reject
      );
    }
  );
}

function readRawBody(request, maxSize = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", chunk => {
      size += chunk.length;
      if (size > maxSize) {
        reject(new Error("La solicitud es demasiado grande."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

/* ============================================================
   STRIPE CHECKOUT
   ============================================================ */

function stripeChoiceText(item) {
  return [
    item?.size ? `Talla ${safeText(item.size, 40)}` : "",
    item?.color ? `Color ${safeText(item.color, 40)}` : ""
  ].filter(Boolean).join(" · ");
}

function wixVariantPrice(variant) {
  const candidates = [
    variant?.price?.actualPrice?.amount,
    variant?.priceData?.discountedPrice,
    variant?.priceData?.price,
    variant?.price?.amount,
    variant?.price
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value >= 0) return Math.round(value);
  }
  return null;
}

const CHECKOUT_ITEM_UNAVAILABLE_CODE = "CART_ITEM_UNAVAILABLE";
const CHECKOUT_ITEM_UNAVAILABLE_MESSAGE = "Uno de los productos de tu bolsa ya no está disponible.";
const PRONTO_LOCATION_UNAVAILABLE_CODE = "PRONTO_LOCATION_UNAVAILABLE";
const PRONTO_LOCATION_UNAVAILABLE_MESSAGE = "Pronto actualmente está disponible únicamente en Cartagena.";
const CHECKOUT_SAFE_ERROR_MESSAGE = "No pudimos preparar el pago. Inténtalo nuevamente.";

class CartItemUnavailableError extends Error {
  constructor(productIds) {
    super(CHECKOUT_ITEM_UNAVAILABLE_MESSAGE);
    this.name = "CartItemUnavailableError";
    this.code = CHECKOUT_ITEM_UNAVAILABLE_CODE;
    this.productIds = [...new Set((productIds || []).map(value => safeText(value, 80)).filter(Boolean))];
  }
}

class ProntoLocationUnavailableError extends Error {
  constructor(cartLineIds) {
    super(PRONTO_LOCATION_UNAVAILABLE_MESSAGE);
    this.name = "ProntoLocationUnavailableError";
    this.code = PRONTO_LOCATION_UNAVAILABLE_CODE;
    this.cartLineIds = [...new Set((cartLineIds || []).map(value => safeText(value, 80)).filter(Boolean))];
  }
}

function wixApplicationErrorCode(error) {
  let details = error?.details;
  if (typeof details === "string") {
    try {
      details = JSON.parse(details);
    } catch {
      details = null;
    }
  }
  return safeText(
    error?.code ||
    error?.applicationError?.code ||
    details?.applicationError?.code ||
    details?.code,
    80
  ).toUpperCase();
}

function isWixNotFoundError(error) {
  return wixApplicationErrorCode(error) === "NOT_FOUND";
}

async function verifiedCheckoutCatalogItems(items) {
  const results = await Promise.allSettled(items.map(stripeLineItemFromCartItem));
  const unavailableProductIds = results.flatMap(result =>
    result.status === "rejected" && result.reason instanceof CartItemUnavailableError
      ? result.reason.productIds
      : []
  );
  if (unavailableProductIds.length) {
    throw new CartItemUnavailableError(unavailableProductIds);
  }
  const failed = results.find(result => result.status === "rejected");
  if (failed) throw failed.reason;
  return results.map(result => result.value);
}

async function protectCheckoutOperation(response, label, operation) {
  try {
    await operation();
  } catch (error) {
    console.error(`[Checkout ${label}]`, error);
    if (error instanceof CartItemUnavailableError) {
      sendJson(response, 409, {
        code: CHECKOUT_ITEM_UNAVAILABLE_CODE,
        message: CHECKOUT_ITEM_UNAVAILABLE_MESSAGE,
        productIds: error.productIds
      });
      return;
    }
    if (error instanceof ProntoLocationUnavailableError) {
      sendJson(response, 409, {
        code: PRONTO_LOCATION_UNAVAILABLE_CODE,
        message: PRONTO_LOCATION_UNAVAILABLE_MESSAGE,
        cartLineIds: error.cartLineIds
      });
      return;
    }
    sendJson(response, 500, {
      code: "PAYMENT_PREPARATION_FAILED",
      message: CHECKOUT_SAFE_ERROR_MESSAGE
    });
  }
}

async function stripeLineItemFromCartItem(item) {
  const cartLineId = safeText(item?.id || item?._id || item?.lineItemId, 80);
  const productId = safeText(item?.productId, 80);
  const variantId = safeText(item?.variantId, 80);
  const quantity = Math.min(20, Math.max(1, Math.floor(Number(item?.quantity || 1))));
  if (!productId) throw new Error("Uno de los productos no tiene un ID válido.");
  if (!wix) throw new Error("Wix no está configurado para verificar precios.");

  let product;
  try {
    product = await wix.productsV3.getProduct(productId);
  } catch (error) {
    if (isWixNotFoundError(error)) throw new CartItemUnavailableError([productId]);
    throw error;
  }
  if (!product || product.visible === false) throw new CartItemUnavailableError([productId]);
  const variants = product?.variantsInfo?.variants || product?.variants || [];
  const variant = variantId
    ? variants.find(candidate => String(candidate?._id || candidate?.id || candidate?.variantId) === variantId)
    : variants[0];
  if (!variant) throw new CartItemUnavailableError([productId]);
  if (variant.visible === false || String(variant.inventoryStatus || "").toUpperCase() === "OUT_OF_STOCK") {
    throw new CartItemUnavailableError([productId]);
  }

  const unitAmount = wixVariantPrice(variant);
  if (!Number.isInteger(unitAmount) || unitAmount < 1) {
    throw new Error(`No pudimos verificar el precio de ${safeText(product?.name, 80)}.`);
  }

  const fulfillmentSku = safeText(variant?.sku || product?.sku, 100).toUpperCase();
  const fulfillmentSegments = fulfillmentSku.split("-").filter(Boolean);
  const fulfillmentCode = [...fulfillmentSegments].reverse().find(segment =>
    ["P", "PR", "RP", "R", "L", "PL", "LP", "RL", "LR", "PRL"].includes(segment)
  ) || fulfillmentSegments[0];
  const normalizedFulfillmentCode = ["P", "PR", "RP", "R", "L", "PL", "LP", "RL", "LR", "PRL"].includes(fulfillmentCode)
    ? fulfillmentCode
    : "R";
  const allowedDeliveryModes = normalizedFulfillmentCode === "PRL"
    ? ["pickup", "fast", "ship"]
    : ["PR", "RP"].includes(normalizedFulfillmentCode)
      ? ["pickup", "fast"]
      : ["PL", "LP"].includes(normalizedFulfillmentCode)
        ? ["pickup", "ship"]
        : ["RL", "LR"].includes(normalizedFulfillmentCode)
          ? ["fast", "ship"]
          : normalizedFulfillmentCode === "P"
            ? ["pickup"]
            : normalizedFulfillmentCode === "L"
              ? ["ship"]
              : ["fast"];
  const requestedMode = safeText(item?.selectedDeliveryMode, 20).toLowerCase();
  const selectedDeliveryMode = requestedMode && allowedDeliveryModes.includes(requestedMode)
    ? requestedMode
    : "";
  if (!selectedDeliveryMode) {
    throw new Error(`Selecciona un método de entrega válido para ${safeText(product?.name, 80)}.`);
  }

  return {
    cartLineId,
    quantity,
    fulfillmentCode: normalizedFulfillmentCode,
    selectedDeliveryMode,
    price_data: {
      currency: "cop",
      // Stripe treats COP as a two-decimal currency in API requests.
      unit_amount: unitAmount * 100,
      product_data: {
        name: safeText(product?.name, 80) || "Producto CajaModa",
        description: stripeChoiceText(item) || undefined,
        metadata: { productId, variantId, fulfillmentCode: normalizedFulfillmentCode, selectedDeliveryMode }
      }
    }
  };
}

function stripeCaptureMethod(lines) {
  return lines.some(line => safeText(line?.selectedDeliveryMode, 20).toLowerCase() === "ship")
    ? "manual"
    : "automatic";
}

function selectedDeliveryLabel(value) {
  const mode = safeText(value, 20).toLowerCase();
  if (mode === "pickup") return "Pronto";
  if (mode === "ship") return "Libéralo";
  return "Rápido Nacional";
}

async function handleCreateStripeCheckout(request, response) {
  if (!stripe) {
    sendError(response, 503, "Stripe todavía no está configurado en el servidor.");
    return;
  }
  const body = await readBody(request);
  const items = Array.isArray(body?.cart?.items) ? body.cart.items.slice(0, 50) : [];
  if (!items.length) {
    sendError(response, 400, "Tu bolsa está vacía.");
    return;
  }
  const catalogLines = await verifiedCheckoutCatalogItems(items);
  // Keep CajaModa fulfillment data server-side. Stripe only accepts documented
  // line item properties, so never forward fulfillmentCode at this level.
  const lineItems = catalogLines.map(({ cartLineId, fulfillmentCode, selectedDeliveryMode, ...line }) => line);
  const customerEmail = safeText(body?.customer?.email, 250);
  const prepareOnly = body?.prepareOnly === true;
  const delivery = prepareOnly
    ? {
        method: "pending",
        title: "Entrega pendiente",
        addressLine: "",
        city: "",
        state: "",
        postalCode: "",
        fee: 0,
        maxBusinessDays: 28,
        quote: { groups: [] }
      }
    : await checkoutDelivery(body, catalogLines);
  const deliveryMethod = delivery.method;
  const deliveryLabel = delivery.title;
  const intentLines = catalogLines.map(line => ({
    productId: safeText(line?.price_data?.product_data?.metadata?.productId, 80),
    variantId: safeText(line?.price_data?.product_data?.metadata?.variantId, 80),
    quantity: Math.max(1, Math.floor(Number(line?.quantity || 1))),
    amount: Number(line?.price_data?.unit_amount || 0) / 100,
    name: safeText(line?.price_data?.product_data?.name, 300) || "Producto CajaModa",
    fulfillmentCode: safeText(line?.fulfillmentCode, 10).toUpperCase(),
    selectedDeliveryMode: safeText(line?.selectedDeliveryMode, 20).toLowerCase()
  }));
  const captureMethod = stripeCaptureMethod(intentLines);
  const intentMetadata = stripeIntentMetadata(intentLines, body, delivery);
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    ui_mode: "elements",
    payment_method_types: ["card"],
    wallet_options: {
      link: { display: "never" }
    },
    payment_intent_data: {
      capture_method: captureMethod,
      receipt_email: customerEmail || undefined,
      metadata: {
        ...intentMetadata,
        source: "cajamoda-checkout-elements"
      }
    },
    line_items: lineItems,
    customer_email: customerEmail || undefined,
    ...(prepareOnly ? {} : {
      shipping_options: [{
        shipping_rate_data: {
          type: "fixed_amount",
          fixed_amount: { amount: delivery.fee * 100, currency: "cop" },
          display_name: deliveryLabel,
          delivery_estimate: {
            minimum: { unit: "business_day", value: 1 },
            maximum: { unit: "business_day", value: delivery.maxBusinessDays }
          }
        }
      }]
    }),
    locale: "es",
    return_url: `${STOREFRONT_URL}/order-confirmation/?stripeSessionId={CHECKOUT_SESSION_ID}`,
    metadata: {
      source: "cajamoda-storefront",
      deliveryMethod,
      deliverySummary: safeText(delivery.title, 300),
      deliveryPlan: safeText(encodedNationalDeliveryPlan(delivery), 500),
      deliveryPromise: safeText(body?.delivery?.promise, 40) || "pronto",
      customerName: safeText(body?.customer?.customerName, 160),
      customerPhone: safeText(body?.customer?.customerPhone, 80),
      deliveryAddress: delivery.addressLine,
      deliveryCity: delivery.city,
      deliveryState: delivery.state,
      deliveryPostalCode: delivery.postalCode
    }
  }, {
    idempotencyKey: safeText(body?.requestId, 100) || undefined
  });
  sendJson(response, 200, {
    ok: true,
    clientSecret: session.client_secret,
    sessionId: session.id,
    amountTotal: session.amount_total
  });
}

async function handleUpdateStripeCheckout(request, response) {
  if (!stripe) {
    sendError(response, 503, "Stripe todavía no está configurado en el servidor.");
    return;
  }
  const body = await readBody(request);
  const sessionId = safeText(body?.sessionId, 100);
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) {
    sendError(response, 400, "La sesión de pago no es válida.");
    return;
  }
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session?.status !== "open" || session?.metadata?.source !== "cajamoda-storefront") {
    sendError(response, 409, "La sesión de pago ya no está disponible.");
    return;
  }
  const items = Array.isArray(body?.cart?.items) ? body.cart.items.slice(0, 50) : [];
  if (!items.length) {
    sendError(response, 400, "Tu bolsa está vacía.");
    return;
  }
  const catalogLines = await verifiedCheckoutCatalogItems(items);
  const lineItems = catalogLines.map(({ cartLineId, fulfillmentCode, selectedDeliveryMode, ...line }) => line);
  const delivery = await checkoutDelivery(body, catalogLines);
  const updated = await stripe.checkout.sessions.update(sessionId, {
    line_items: lineItems,
    shipping_options: [{
      shipping_rate_data: {
        type: "fixed_amount",
        fixed_amount: { amount: delivery.fee * 100, currency: "cop" },
        display_name: delivery.title,
        delivery_estimate: {
          minimum: { unit: "business_day", value: 1 },
          maximum: { unit: "business_day", value: delivery.maxBusinessDays }
        }
      }
    }],
    metadata: {
      ...session.metadata,
      deliveryMethod: delivery.method,
      deliverySummary: safeText(delivery.title, 300),
      deliveryPlan: safeText(encodedNationalDeliveryPlan(delivery), 500),
      deliveryPromise: safeText(body?.delivery?.promise, 40) || "pronto",
      customerName: safeText(body?.customer?.customerName, 160),
      customerPhone: safeText(body?.customer?.customerPhone, 80),
      deliveryAddress: delivery.addressLine,
      deliveryCity: delivery.city,
      deliveryState: delivery.state,
      deliveryPostalCode: delivery.postalCode
    }
  });
  sendJson(response, 200, { ok: true, sessionId: updated.id, amountTotal: updated.amount_total });
}

async function handleStripeConfirmation(request, response, url) {
  if (!stripe) {
    sendError(response, 503, "Stripe todavía no está configurado.");
    return;
  }
  const sessionId = safeText(url.searchParams.get("sessionId"), 100);
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) {
    sendError(response, 400, "La sesión de pago no es válida.");
    return;
  }
  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ["payment_intent"]
  });
  const intent = typeof session.payment_intent === "object"
    ? session.payment_intent
    : null;
  const authorized = intent?.status === "requires_capture";
  const paid = intent?.status === "succeeded" || session.payment_status === "paid";
  sendJson(response, 200, {
    ok: true,
    order: {
      number: session.id.slice(-10).toUpperCase(),
      payment: paid ? "Pago confirmado" : authorized ? "Pago autorizado" : "Pago pendiente",
      paid,
      authorized,
      delivery: {
        method: "Entrega CajaModa",
        message: "Te enviaremos la información de entrega por correo."
      },
      shipments: pendingNationalShipmentsFromEncodedPlan(session?.metadata?.deliveryPlan)
    }
  });
}

function stripeAddressToWix(address = {}) {
  return {
    country: safeText(address.country, 2),
    subdivision: safeText(address.state, 100),
    city: safeText(address.city, 100),
    postalCode: safeText(address.postal_code, 40),
    addressLine: safeText(address.line1, 250),
    addressLine2: safeText(address.line2, 250)
  };
}

function splitCustomerName(value) {
  const parts = safeText(value, 160).split(/\s+/).filter(Boolean);
  return {
    firstName: parts.shift() || "Cliente",
    lastName: parts.join(" ") || "CajaModa"
  };
}

async function getStripePurchasedLines(session) {
  const result = await stripe.checkout.sessions.listLineItems(session.id, {
    limit: 100,
    expand: ["data.price.product"]
  });
  return result.data.map(line => {
    const stripeProduct = typeof line?.price?.product === "object"
      ? line.price.product
      : {};
    const productId = safeText(stripeProduct?.metadata?.productId, 80);
    const variantId = safeText(stripeProduct?.metadata?.variantId, 80);
    const quantity = Math.max(1, Math.floor(Number(line?.quantity || 1)));
    const amount = Number(line?.price?.unit_amount || 0) / 100;
    if (!productId || !variantId || !Number.isFinite(amount) || amount < 1) {
      throw new Error("Stripe devolvió una línea de pedido incompleta.");
    }
    return {
      productId,
      variantId,
      quantity,
      amount,
      name: safeText(line?.description || stripeProduct?.name, 300) || "Producto CajaModa",
      fulfillmentCode: safeText(stripeProduct?.metadata?.fulfillmentCode, 10).toUpperCase(),
      selectedDeliveryMode: safeText(stripeProduct?.metadata?.selectedDeliveryMode, 20).toLowerCase()
    };
  });
}

async function findStripeWixOrder(sessionId) {
  const result = await wix.orders.searchOrders({
    filter: { "channelInfo.externalOrderId": sessionId },
    cursorPaging: { limit: 10 }
  });
  return (result?.orders || [])[0] || null;
}

async function importStripeOrderIntoWix(session, lines) {
  const existing = await findStripeWixOrder(session.id);
  if (existing) return { order: existing, created: false };

  const customer = session?.customer_details || {};
  const shipping = session?.shipping_details || session?.collected_information?.shipping_details || {};
  const name = splitCustomerName(shipping?.name || customer?.name || session?.metadata?.customerName);
  const stripeAddress = stripeAddressToWix(shipping?.address || customer?.address || {});
  const address = session?.metadata?.deliveryMethod === "pickup"
    ? { country: "CO", city: "Cartagena", addressLine: CARTAGENA_PICKUP_ADDRESS }
    : {
        ...stripeAddress,
        country: "CO",
        city: safeText(session?.metadata?.deliveryCity, 100) || stripeAddress.city,
        subdivision: safeText(session?.metadata?.deliveryState, 100) || stripeAddress.subdivision,
        postalCode: safeText(session?.metadata?.deliveryPostalCode, 40) || stripeAddress.postalCode,
        addressLine: safeText(session?.metadata?.deliveryAddress, 250) || stripeAddress.addressLine
      };
  const subtotal = lines.reduce((sum, line) => sum + line.amount * line.quantity, 0);
  const total = Number(session?.amount_total || 0) / 100;

  const imported = await wix.orders.importOrder({
    status: "APPROVED",
    paymentStatus: "PAID",
    fulfillmentStatus: "NOT_FULFILLED",
    channelInfo: { type: "OTHER_PLATFORM", externalOrderId: session.id },
    currency: "COP",
    currencyConversionDetails: { originalCurrency: "COP", conversionRate: "1" },
    buyerInfo: { email: safeText(customer?.email, 250) },
    billingInfo: {
      contactDetails: {
        firstName: name.firstName,
        lastName: name.lastName,
        email: safeText(customer?.email, 250),
        phone: safeText(customer?.phone || session?.metadata?.customerPhone, 80)
      },
      address
    },
    shippingInfo: {
      title: `Stripe – ${safeText(session?.metadata?.deliverySummary, 300) || selectedDeliveryLabel(lines[0]?.selectedDeliveryMode)}`,
      cost: { amount: String(Math.max(0, total - subtotal)) },
      logistics: {
        shippingDestination: {
          address,
          contactDetails: {
            firstName: name.firstName,
            lastName: name.lastName,
            email: safeText(customer?.email, 250),
            phone: safeText(customer?.phone || session?.metadata?.customerPhone, 80)
          }
        }
      }
    },
    lineItems: lines.map(line => ({
      productName: { original: line.name },
      descriptionLines: [{
        name: { original: "Entrega" },
        plainText: { original: selectedDeliveryLabel(line.selectedDeliveryMode) }
      }],
      quantity: line.quantity,
      price: { amount: String(line.amount) },
      itemType: { preset: "PHYSICAL" },
      physicalProperties: { shippable: true },
      catalogReference: {
        appId: WIX_STORES_APP_ID,
        catalogItemId: line.productId,
        options: { variantId: line.variantId }
      }
    })),
    priceSummary: {
      subtotal: { amount: String(subtotal) },
      shipping: { amount: String(Math.max(0, total - subtotal)) },
      tax: { amount: "0" },
      discount: { amount: "0" },
      total: { amount: String(total) }
    }
  });
  return { order: imported?.order || imported, created: true };
}

async function decrementStripeInventory(lines) {
  await wix.inventoryItemsV3.bulkDecrementInventoryItemsByVariantAndLocation(
    lines.map(line => ({
      variantId: line.variantId,
      decrementBy: line.quantity
    })),
    { restrictInventory: true, returnEntity: true, reason: "ORDER" }
  );
}

async function syncCompletedStripeSession(session) {
  if (!wix) throw new Error("Wix no está configurado para recibir el pedido.");
  if (session.payment_status !== "paid") return;
  if (session?.metadata?.wixSync === "complete") return;

  const lines = await getStripePurchasedLines(session);
  const imported = await importStripeOrderIntoWix(session, lines);
  if (imported.created) {
    await decrementStripeInventory(lines);
  }
  await stripe.checkout.sessions.update(session.id, {
    metadata: {
      ...session.metadata,
      wixSync: "complete",
      wixOrderId: safeText(imported?.order?._id || imported?.order?.id, 80)
    }
  });
}

function encodedNationalDeliveryPlan(delivery) {
  const plan = publicNationalShipmentPlan(delivery?.quote?.groups || [])
    .map(shipment => ({
      t: shipment.type,
      f: shipment.fee,
      e: shipment.estimate,
      c: shipment.carrier,
      s: shipment.service
    }));
  return plan.length
    ? Buffer.from(JSON.stringify(plan)).toString("base64url")
    : "";
}

function pendingNationalShipmentsFromEncodedPlan(value) {
  const encoded = safeText(value, 500);
  if (!encoded) return [];
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return (Array.isArray(parsed) ? parsed : [])
      .filter(shipment => ["R", "L"].includes(safeText(shipment?.t, 1).toUpperCase()))
      .map(shipment => {
        const type = safeText(shipment.t, 1).toUpperCase();
        const definition = nationalShipmentDefinition(type);
        return {
          type,
          label: definition?.label || type,
          estimate: safeText(shipment?.e, 40) || definition?.estimate || "",
          status: type === "R" ? "ready" : "processing",
          carrier: "",
          trackingNumber: "",
          trackingLink: ""
        };
      });
  } catch {
    return [];
  }
}

function stripeIntentMetadata(lines, body, delivery) {
  const metadata = {
    source: "cajamoda-custom-card",
    storeId: STORE_ID,
    itemCount: String(lines.length),
    deliveryMethod: safeText(delivery.method, 20),
    deliverySummary: safeText(delivery.title, 300),
    deliveryPromise: safeText(body?.delivery?.promise, 40) || "pronto",
    customerName: safeText(body?.customer?.customerName, 160),
    customerPhone: safeText(body?.customer?.customerPhone, 80),
    customerEmail: safeText(body?.customer?.email, 250),
    deliveryAddress: safeText(delivery.addressLine, 250),
    deliveryCity: safeText(delivery.city, 100),
    deliveryState: safeText(delivery.state, 100),
    deliveryPostalCode: safeText(delivery.postalCode, 40),
    deliveryFee: String(Math.max(0, Number(delivery.fee || 0))),
    deliveryPlan: safeText(encodedNationalDeliveryPlan(delivery), 500)
  };
  lines.forEach((line, index) => {
    metadata[`item${index}`] = Buffer.from(JSON.stringify({
      p: line.productId,
      v: line.variantId,
      q: line.quantity,
      a: line.amount,
      n: safeText(line.name, 180),
      f: safeText(line.fulfillmentCode, 10).toUpperCase(),
      d: safeText(line.selectedDeliveryMode, 20).toLowerCase()
    })).toString("base64url");
  });
  return metadata;
}

function stripeIntentLines(intent) {
  const count = Math.min(35, Math.max(0, Number(intent?.metadata?.itemCount || 0)));
  return Array.from({ length: count }, (_, index) => {
    const encoded = safeText(intent?.metadata?.[`item${index}`], 500);
    const item = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return {
      productId: safeText(item.p, 80),
      variantId: safeText(item.v, 80),
      quantity: Math.max(1, Math.floor(Number(item.q || 1))),
      amount: Number(item.a || 0),
      name: safeText(item.n, 300) || "Producto CajaModa",
      fulfillmentCode: safeText(item.f, 10).toUpperCase(),
      selectedDeliveryMode: safeText(item.d, 20).toLowerCase()
    };
  }).filter(line => line.productId && line.variantId && Number.isFinite(line.amount) && line.amount >= 1);
}

async function handleCreateStripePaymentIntent(request, response) {
  if (!stripe) return sendError(response, 503, "Stripe todavía no está configurado en el servidor.");
  const body = await readBody(request);
  const confirmationTokenId = safeText(body?.confirmationTokenId, 120);
  if (!/^ctoken_[A-Za-z0-9_]+$/.test(confirmationTokenId)) {
    return sendError(response, 400, "Los datos de la tarjeta no son válidos.");
  }
  const items = Array.isArray(body?.cart?.items) ? body.cart.items.slice(0, 35) : [];
  if (!items.length) return sendError(response, 400, "Tu bolsa está vacía.");
  const verified = await verifiedCheckoutCatalogItems(items);
  const lines = verified.map(line => ({
    cartLineId: safeText(line?.cartLineId, 80),
    productId: safeText(line?.price_data?.product_data?.metadata?.productId, 80),
    variantId: safeText(line?.price_data?.product_data?.metadata?.variantId, 80),
    quantity: Math.max(1, Math.floor(Number(line.quantity || 1))),
    amount: Number(line?.price_data?.unit_amount || 0) / 100,
    name: safeText(line?.price_data?.product_data?.name, 300) || "Producto CajaModa",
    fulfillmentCode: safeText(line?.fulfillmentCode, 10).toUpperCase(),
    selectedDeliveryMode: safeText(line?.selectedDeliveryMode, 20).toLowerCase()
  }));
  const captureMethod = stripeCaptureMethod(lines);
  const delivery = await checkoutDelivery(body, lines);
  const subtotalCents = lines.reduce((sum, line) => sum + Math.round(line.amount * 100) * line.quantity, 0);
  const totalCents = subtotalCents + Math.round(Math.max(0, Number(delivery.fee || 0)) * 100);
  const customerName = safeText(body?.customer?.customerName, 160) || "Cliente CajaModa";
  const customerEmail = safeText(body?.customer?.email, 250);
  const customerPhone = safeText(body?.customer?.customerPhone, 80);
  const intent = await stripe.paymentIntents.create({
    amount: totalCents,
    currency: "cop",
    confirm: true,
    confirmation_token: confirmationTokenId,
    use_stripe_sdk: true,
    return_url: `${STOREFRONT_URL}/order-confirmation/`,
    capture_method: captureMethod,
    payment_method_types: ["card"],
    receipt_email: customerEmail || undefined,
    description: `CajaModa · ${lines.length} producto${lines.length === 1 ? "" : "s"}`,
    shipping: {
      name: customerName,
      phone: customerPhone || undefined,
      address: {
        line1: delivery.addressLine || CARTAGENA_PICKUP_ADDRESS,
        city: delivery.city || "Cartagena",
        state: delivery.state || "BL",
        postal_code: delivery.postalCode || "130001",
        country: "CO"
      }
    },
    metadata: stripeIntentMetadata(lines, body, delivery)
  }, {
    idempotencyKey: safeText(body?.requestId, 100) || undefined
  });
  sendJson(response, 200, {
    ok: true,
    clientSecret: intent.client_secret,
    paymentIntentId: intent.id,
    status: intent.status,
    amount: totalCents
  });
}

async function findStripeIntentWixOrder(intentId) {
  const result = await wix.orders.searchOrders({
    filter: { "channelInfo.externalOrderId": intentId },
    cursorPaging: { limit: 10 }
  });
  return (result?.orders || [])[0] || null;
}

async function importStripeIntentIntoWix(intent, lines) {
  const existing = await findStripeIntentWixOrder(intent.id);
  if (existing) return { order: existing, created: false };
  const paymentMethod = typeof intent.payment_method === "object"
    ? intent.payment_method
    : intent.payment_method
      ? await stripe.paymentMethods.retrieve(intent.payment_method)
      : null;
  const billing = paymentMethod?.billing_details || {};
  const name = splitCustomerName(billing.name || intent.metadata.customerName);
  const deliveryMethod = safeText(intent.metadata.deliveryMethod, 20) || "pickup";
  const address = deliveryMethod === "pickup"
    ? { country: "CO", city: "Cartagena", subdivision: "BL", postalCode: "130001", addressLine: CARTAGENA_PICKUP_ADDRESS }
    : {
        country: "CO",
        city: safeText(intent.metadata.deliveryCity, 100),
        subdivision: safeText(intent.metadata.deliveryState, 100),
        postalCode: safeText(intent.metadata.deliveryPostalCode, 40),
        addressLine: safeText(intent.metadata.deliveryAddress, 250)
      };
  const subtotal = lines.reduce((sum, line) => sum + line.amount * line.quantity, 0);
  const total = Number(intent.amount_received || intent.amount || 0) / 100;
  const imported = await wix.orders.importOrder({
    status: "APPROVED",
    paymentStatus: "PAID",
    fulfillmentStatus: "NOT_FULFILLED",
    channelInfo: { type: "OTHER_PLATFORM", externalOrderId: intent.id },
    currency: "COP",
    currencyConversionDetails: { originalCurrency: "COP", conversionRate: "1" },
    buyerInfo: { email: safeText(billing.email || intent.receipt_email || intent.metadata.customerEmail, 250) },
    billingInfo: {
      contactDetails: {
        firstName: name.firstName,
        lastName: name.lastName,
        email: safeText(billing.email || intent.receipt_email || intent.metadata.customerEmail, 250),
        phone: safeText(billing.phone || intent.metadata.customerPhone, 80)
      },
      address
    },
    shippingInfo: {
      title: `Stripe – ${safeText(intent.metadata.deliverySummary, 300) || selectedDeliveryLabel(lines[0]?.selectedDeliveryMode)}`,
      cost: { amount: String(Math.max(0, total - subtotal)) },
      logistics: { shippingDestination: { address, contactDetails: {
        firstName: name.firstName, lastName: name.lastName,
        email: safeText(billing.email || intent.receipt_email || intent.metadata.customerEmail, 250),
        phone: safeText(intent.metadata.customerPhone, 80)
      } } }
    },
    lineItems: lines.map(line => ({
      productName: { original: line.name }, quantity: line.quantity,
      price: { amount: String(line.amount) }, itemType: { preset: "PHYSICAL" },
      physicalProperties: { shippable: true },
      catalogReference: { appId: WIX_STORES_APP_ID, catalogItemId: line.productId, options: { variantId: line.variantId } }
    })),
    priceSummary: {
      subtotal: { amount: String(subtotal) }, shipping: { amount: String(Math.max(0, total - subtotal)) },
      tax: { amount: "0" }, discount: { amount: "0" }, total: { amount: String(total) }
    }
  });
  return { order: imported?.order || imported, created: true };
}

async function syncSucceededStripeIntent(paymentIntent) {
  const existingSync = stripeIntentSyncLocks.get(paymentIntent.id);
  if (existingSync) return existingSync;
  const sync = (async () => {
    if (!wix) throw new Error("Wix no está configurado para recibir el pedido.");
    if (paymentIntent.status !== "succeeded" || paymentIntent?.metadata?.wixSync === "complete") return;
    const latest = await stripe.paymentIntents.retrieve(paymentIntent.id);
    if (latest?.metadata?.wixSync === "complete") return;
    const lines = stripeIntentLines(latest);
    if (!lines.length) throw new Error("Stripe devolvió un pedido sin productos verificables.");
    const imported = await importStripeIntentIntoWix(latest, lines);
    if (imported.created) await decrementStripeInventory(lines);
    await stripe.paymentIntents.update(latest.id, { metadata: {
      ...latest.metadata,
      wixSync: "complete",
      wixOrderId: safeText(imported?.order?._id || imported?.order?.id, 80)
    } });
  })();
  stripeIntentSyncLocks.set(paymentIntent.id, sync);
  try {
    return await sync;
  } finally {
    stripeIntentSyncLocks.delete(paymentIntent.id);
  }
}

async function handleStripeIntentConfirmation(request, response, url) {
  if (!stripe) return sendError(response, 503, "Stripe todavía no está configurado.");
  const intentId = safeText(url.searchParams.get("paymentIntent"), 100);
  if (!/^pi_[A-Za-z0-9]+$/.test(intentId)) return sendError(response, 400, "El pago no es válido.");
  const intent = await stripe.paymentIntents.retrieve(intentId, { expand: ["payment_method"] });
  if (intent.status === "succeeded") await syncSucceededStripeIntent(intent);
  const authorized = intent.status === "requires_capture";
  const deliveryTitle = safeText(intent.metadata.deliverySummary, 300) ||
    (intent.metadata.deliveryMethod === "pickup"
      ? "Pronto: Recoger en punto · 24–48 h"
      : intent.metadata.deliveryMethod === "national"
        ? "Rápido Nacional · 4–7 días"
        : "Pronto a domicilio · 24–48 h");
  sendJson(response, 200, {
    ok: true,
    order: {
      paid: intent.status === "succeeded",
      authorized,
      number: `S-${intent.id.slice(-12).toUpperCase()}`,
      payment: intent.status === "succeeded"
        ? "Pago con tarjeta confirmado"
        : authorized
          ? "Pago con tarjeta autorizado"
          : "Pago en proceso",
      delivery: getConfirmationDelivery({ shippingInfo: { title: deliveryTitle } }),
      shipments: pendingNationalShipmentsFromEncodedPlan(intent?.metadata?.deliveryPlan)
    }
  });
}

async function handleStripeWebhook(request, response) {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    sendError(response, 503, "El webhook de Stripe no está configurado.");
    return;
  }
  const rawBody = await readRawBody(request);
  const signature = request.headers["stripe-signature"];
  const event = stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET);

  // Stripe requires a prompt 2xx response. Wix order creation and inventory
  // updates can take longer than Stripe's webhook timeout, so acknowledge the
  // verified event before starting that existing, idempotent synchronization.
  sendJson(response, 200, { received: true });

  setImmediate(() => {
    void (async () => {
      if (event.type === "checkout.session.completed") {
        await syncCompletedStripeSession(event.data.object);
        console.log(`[Stripe] Payment synchronized with Wix: ${event.data.object.id}`);
      }
      if (event.type === "payment_intent.succeeded") {
        await syncSucceededStripeIntent(event.data.object);
        console.log(`[Stripe] Card payment synchronized with Wix: ${event.data.object.id}`);
      }
    })().catch(error => {
      console.error(`[Stripe] Wix synchronization failed for ${event.id}:`, error);
    });
  });
}

/* ============================================================
   CUSTOM CHECKOUT / NEQUI
   ============================================================ */

function maskedNequiPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length >= 4 ? `••• ••• ${digits.slice(-4)}` : "Número pendiente";
}

function requireDeliveryEnvironment(method) {
  const origin = [ENVIA_ORIGIN_NAME, ENVIA_ORIGIN_PHONE, ENVIA_ORIGIN_STREET, ENVIA_ORIGIN_POSTAL_CODE];
  if (method === "moto" && (!GOOGLE_MAPS_API_KEY || origin.some(value => !value))) {
    throw new Error("La tarifa de moto todavía no está configurada.");
  }
  if (method === "national" && (!ENVIA_API_TOKEN || origin.some(value => !value))) {
    throw new Error("El envío nacional todavía no está configurado.");
  }
}

async function externalJson(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await fetch(url, { ...options, signal: controller.signal });
    const payload = await result.json().catch(() => ({}));
    if (!result.ok) {
      const message = safeText(payload?.error?.message || payload?.message, 300);
      throw new Error(message || `Servicio de entrega no disponible (${result.status}).`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function enviaAddressNumber(value) {
  const street = safeText(value, 250);
  const labeled = street.match(/(?:#|(?:casa|lote|nro|no\.?)\s*)([A-Z0-9]+(?:[-/][A-Z0-9]+)*)/i)?.[1];
  const numbers = street.match(/\d+[A-Z]?(?:[-/]\d+[A-Z]?)?/gi);
  return safeText(labeled || numbers?.at(-1) || "S/N", 30);
}

function fullColombiaAddress(street, city, state = "Bolívar", postalCode = "") {
  return [street, city, state, postalCode, "Colombia"].filter(Boolean).join(", ");
}

function normalizeColombianStreetAddress(value) {
  return safeText(value, 180)
    .replace(/^\s*(?:kr|cra|cr|carrera)\.?\s*/i, "Carrera ")
    .replace(/\s+/g, " ")
    .trim();
}

function completeDeliveryStreet(delivery = {}) {
  const explicitLine = normalizeColombianStreetAddress(delivery?.addressLine1);
  if (!explicitLine) return safeText(delivery?.address, 250);
  const neighborhood = safeText(delivery?.neighborhood, 100);
  const complement = safeText(delivery?.complement, 120);
  const references = safeText(delivery?.references, 180);
  return safeText([
    explicitLine,
    neighborhood ? `Barrio ${neighborhood}` : "",
    complement,
    references ? `Referencia: ${references}` : ""
  ].filter(Boolean).join(", "), 250);
}

async function quoteMotoDelivery(delivery) {
  requireDeliveryEnvironment("moto");
  const destination = completeDeliveryStreet(delivery);
  if (!destination) throw new Error("Ingresa la dirección para calcular la moto.");
  const cacheKey = destination.toLocaleLowerCase("es-CO").replace(/\s+/g, " ");
  const cached = motoQuoteCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < MOTO_QUOTE_CACHE_TTL) return cached.quote;
  const payload = await externalJson("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
      "X-Goog-FieldMask": "routes.distanceMeters"
    },
    body: JSON.stringify({
      origin: { address: fullColombiaAddress(ENVIA_ORIGIN_STREET, "Cartagena de Indias", "Bolívar", ENVIA_ORIGIN_POSTAL_CODE) },
      destination: { address: fullColombiaAddress(destination, "Cartagena de Indias") },
      travelMode: "TWO_WHEELER",
      routingPreference: "TRAFFIC_UNAWARE",
      languageCode: "es-CO",
      units: "METRIC"
    })
  });
  const distanceMeters = Number(payload?.routes?.[0]?.distanceMeters);
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) {
    throw new Error("No pudimos calcular la ruta. Revisa la dirección.");
  }
  const distanceKm = Math.ceil(distanceMeters / 1000);
  const fee = MOTO_BASE_FEE_COP + Math.max(0, distanceKm - MOTO_INCLUDED_KM) * MOTO_EXTRA_KM_COP;
  const quote = { method: "moto", fee, distanceKm, carrier: "Moto CajaModa", service: "Pronto", estimate: "24–48 horas" };
  if (motoQuoteCache.size >= 2000) motoQuoteCache.delete(motoQuoteCache.keys().next().value);
  motoQuoteCache.set(cacheKey, { createdAt: Date.now(), quote });
  return quote;
}

function enviaDataArray(payload) {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.data) ? payload.data : [];
}

function ratePrice(rate) {
  return Number(rate?.totalPrice ?? rate?.price ?? rate?.cost ?? rate?.amount);
}

function rateMaxDays(rate) {
  const raw = safeText(rate?.deliveryEstimate || rate?.deliveryDate || rate?.estimatedDelivery, 100);
  const numbers = raw.match(/\d+/g)?.map(Number) || [];
  return numbers.length ? Math.max(...numbers) : 99;
}

function normalizeLocationName(value) {
  return safeText(value, 160)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

function titleLocationName(value) {
  return safeText(value, 160)
    .toLocaleLowerCase("es-CO")
    .replace(/(^|[\s-])([a-záéíóúüñ])/g, (_match, prefix, letter) =>
      `${prefix}${letter.toLocaleUpperCase("es-CO")}`
    );
}

function locationNamesMatch(left, right) {
  const first = normalizeLocationName(left)
    .replace(/\bde indias\b/g, "")
    .replace(/\bd c\b/g, "")
    .trim();
  const second = normalizeLocationName(right)
    .replace(/\bde indias\b/g, "")
    .replace(/\bd c\b/g, "")
    .trim();
  return Boolean(
    first &&
    second &&
    (first === second || first.includes(second) || second.includes(first))
  );
}

function colombiaStatesMatch(left, right) {
  const stateKey = value => {
    const normalized = normalizeLocationName(value);
    if (["dc", "bogota", "bogota dc", "distrito capital", "bogota distrito capital"].includes(normalized)) {
      return "dc";
    }
    return normalized;
  };
  const first = stateKey(left);
  const second = stateKey(right);
  return Boolean(first && second && first === second);
}

async function validateDeliveryMunicipality(delivery = {}) {
  const daneCode = safeText(delivery?.cityDaneCode, 8);
  if (!daneCode) throw new Error("Selecciona una ciudad o municipio válido.");
  const municipality = (await colombiaMunicipalities())
    .find(item => safeText(item?.daneCode, 8) === daneCode);
  if (!municipality) throw new Error("El municipio seleccionado no es válido.");
  if (
    safeText(delivery?.city, 100) &&
    !locationNamesMatch(delivery.city, municipality.name)
  ) {
    throw new Error("La ciudad no corresponde al municipio seleccionado.");
  }
  if (
    safeText(delivery?.stateName, 100) &&
    !locationNamesMatch(delivery.stateName, municipality.departmentName)
  ) {
    throw new Error("El municipio no corresponde al departamento seleccionado.");
  }
  return municipality;
}

async function locateColombiaCity(city, state) {
  const payload = await externalJson(`${ENVIA_API_BASE}/locate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ city, state, country: "CO" })
  });
  const located = Array.isArray(payload?.data) ? payload.data[0] : payload?.data || payload;
  if (!located?.city) throw new Error("No pudimos validar la ciudad de entrega.");
  return located;
}

async function validateColombiaPostalCode(postalCode, located, selectedState = "") {
  const requested = safeText(postalCode, 20);
  const locatedPostalCode = safeText(located?.postalCode || located?.zipcode, 20);
  if (!requested) {
    if (/^\d{6}$/.test(locatedPostalCode)) return locatedPostalCode;
    throw new Error("Ingresa el código postal colombiano de seis dígitos.");
  }
  if (!/^\d{6}$/.test(requested)) {
    throw new Error("El código postal debe tener seis dígitos.");
  }
  try {
    const payload = await externalJson(
      `${ENVIA_GEOCODES_BASE}/zipcode/CO/${encodeURIComponent(requested)}`,
      {},
      8000
    );
    const resolved = Array.isArray(payload?.data)
      ? payload.data[0]
      : payload?.data || payload;
    const resolvedPostalCode = safeText(resolved?.zipcode || resolved?.postalCode, 20);
    if (!resolvedPostalCode) return requested;
    const postalState = safeText(resolved?.state, 100);
    const expectedStates = [safeText(located?.state, 100), safeText(selectedState, 100)].filter(Boolean);
    if (postalState && expectedStates.length && !expectedStates.some(state => colombiaStatesMatch(state, postalState))) {
      throw new Error("El código postal no corresponde al departamento seleccionado.");
    }
    return resolvedPostalCode;
  } catch (error) {
    if (safeText(error?.message, 300).includes("no corresponde al departamento")) throw error;
    return requested;
  }
}

async function colombiaMunicipalities() {
  if (
    colombiaMunicipalityCache.items.length &&
    Date.now() - colombiaMunicipalityCache.loadedAt < DELIVERY_REFERENCE_CACHE_TTL
  ) {
    return colombiaMunicipalityCache.items;
  }
  const payload = await externalJson(COLOMBIA_MUNICIPALITIES_URL, {}, 20000);
  const items = (Array.isArray(payload) ? payload : [])
    .map(item => ({
      departmentCode: safeText(item?.cod_dpto, 4),
      departmentName: safeText(item?.dpto, 100),
      daneCode: safeText(item?.cod_mpio, 8),
      name: titleLocationName(item?.nom_mpio).replace(/,\s*d\.?c\.?$/i, "")
    }))
    .filter(item => item.departmentName && item.daneCode && item.name);
  if (!items.length) throw new Error("No pudimos cargar los municipios de Colombia.");
  colombiaMunicipalityCache.loadedAt = Date.now();
  colombiaMunicipalityCache.items = items;
  return items;
}

function googleAddressComponent(place, type, short = false) {
  const component = (Array.isArray(place?.addressComponents) ? place.addressComponents : [])
    .find(item => Array.isArray(item?.types) && item.types.includes(type));
  return safeText(short ? component?.shortText : component?.longText, 160);
}

async function googlePlaceDetails(placeId, sessionToken = "") {
  if (!GOOGLE_MAPS_API_KEY) throw new Error("La ayuda de dirección todavía no está configurada.");
  const id = safeText(placeId, 220);
  if (!id) throw new Error("Selecciona una dirección válida.");
  const cached = googlePlaceDetailsCache.get(id);
  if (cached && Date.now() - cached.loadedAt < GOOGLE_PLACE_CACHE_TTL) return cached.place;
  const query = sessionToken ? `?sessionToken=${encodeURIComponent(safeText(sessionToken, 120))}` : "";
  const place = await externalJson(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(id)}${query}`,
    {
      headers: {
        "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask": "id,formattedAddress,addressComponents,location"
      }
    },
    10000
  );
  if (!place?.id) throw new Error("No pudimos verificar la dirección seleccionada.");
  if (googlePlaceDetailsCache.size >= 1000) {
    googlePlaceDetailsCache.delete(googlePlaceDetailsCache.keys().next().value);
  }
  googlePlaceDetailsCache.set(id, { loadedAt: Date.now(), place });
  return place;
}

function publicGoogleAddress(place) {
  const route = googleAddressComponent(place, "route");
  const streetNumber = googleAddressComponent(place, "street_number");
  const city =
    googleAddressComponent(place, "locality") ||
    googleAddressComponent(place, "administrative_area_level_2");
  return {
    placeId: safeText(place?.id, 220),
    formattedAddress: safeText(place?.formattedAddress, 300),
    address: [route, streetNumber].filter(Boolean).join(" ") || safeText(place?.formattedAddress, 300),
    city,
    departmentName: googleAddressComponent(place, "administrative_area_level_1"),
    postalCode: googleAddressComponent(place, "postal_code"),
    latitude: Number(place?.location?.latitude) || null,
    longitude: Number(place?.location?.longitude) || null
  };
}

async function validateSelectedGoogleAddress(delivery) {
  const placeId = safeText(delivery?.addressPlaceId, 220);
  if (!placeId) return null;
  const details = publicGoogleAddress(await googlePlaceDetails(placeId));
  const enteredCity = normalizeLocationName(delivery?.city);
  const placeCity = normalizeLocationName(details.city);
  const enteredState = normalizeLocationName(delivery?.stateName);
  const placeState = normalizeLocationName(details.departmentName);
  if (enteredCity && placeCity && !locationNamesMatch(enteredCity, placeCity)) {
    throw new Error("La dirección seleccionada no corresponde a la ciudad.");
  }
  if (enteredState && placeState && !locationNamesMatch(enteredState, placeState)) {
    throw new Error("La dirección seleccionada no corresponde al departamento.");
  }
  return details;
}

async function enviaCarriers() {
  const payload = await externalJson(`${ENVIA_QUERIES_BASE}/available-carrier/CO/0/1`, {
    headers: { Authorization: `Bearer ${ENVIA_API_TOKEN}` }
  });
  const names = enviaDataArray(payload)
    .map(item => safeText(item?.name || item?.carrier, 60).toLowerCase())
    .filter(Boolean);
  return [...new Set(names)].slice(0, 16);
}

async function quoteNationalDelivery(delivery, customer, declaredValue) {
  requireDeliveryEnvironment("national");
  const city = safeText(delivery?.city, 100);
  const state = safeText(delivery?.state, 5).toUpperCase();
  const street = completeDeliveryStreet(delivery);
  const postalCode = safeText(delivery?.postalCode, 20);
  if (!city || !state || !street) throw new Error("Completa la ciudad, departamento y dirección de entrega.");
  const municipality = safeText(delivery?.cityDaneCode, 8)
    ? await validateDeliveryMunicipality(delivery)
    : null;
  const located = await locateColombiaCity(municipality?.name || city, state);
  const selectedAddress = await validateSelectedGoogleAddress(delivery);
  const verifiedPostalCode = await validateColombiaPostalCode(
    postalCode || selectedAddress?.postalCode,
    located,
    state
  );
  const carriers = await enviaCarriers();
  if (!carriers.length) throw new Error("Envia no devolvió transportadoras disponibles.");
  const quoteBody = carrier => ({
    origin: {
      name: ENVIA_ORIGIN_NAME, phone: ENVIA_ORIGIN_PHONE, street: ENVIA_ORIGIN_STREET,
      city: "13001000", state: "BL", country: "CO", postalCode: ENVIA_ORIGIN_POSTAL_CODE
    },
    destination: {
      name: safeText(customer?.customerName || customer?.name, 120) || "Cliente CajaModa",
      phone: safeText(customer?.customerPhone || customer?.phone, 50), street,
      city: safeText(located.city, 20), state: safeText(located.state || state, 5), country: "CO",
      postalCode: verifiedPostalCode || safeText(located.postalCode || located.zipcode, 20)
    },
    packages: [{
      ...STANDARD_CLOTHING_PARCEL,
      declaredValue: Math.max(1, Math.round(Number(declaredValue) || 1))
    }],
    settings: { currency: "COP" },
    shipment: { type: 1, carrier }
  });
  const responses = await Promise.allSettled(carriers.map(carrier => externalJson(`${ENVIA_API_BASE}/ship/rate/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ENVIA_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(quoteBody(carrier))
  })));
  const rates = responses.flatMap(result => result.status === "fulfilled" ? enviaDataArray(result.value) : [])
    .filter(rate => Number.isFinite(ratePrice(rate)) && ratePrice(rate) >= 0);
  if (!rates.length) throw new Error("No encontramos una tarifa nacional para esta dirección.");
  const timely = rates.filter(rate => rateMaxDays(rate) <= 7);
  const selected = (timely.length ? timely : rates).sort((a, b) => ratePrice(a) - ratePrice(b))[0];
  return {
    method: "national", fee: Math.ceil(ratePrice(selected)),
    carrier: safeText(selected.carrier, 60),
    service: safeText(selected.service, 100),
    serviceDescription: safeText(selected.serviceDescription || selected.service, 100),
    estimate: safeText(selected.deliveryEstimate || "4–7 días", 100),
    postalCode: verifiedPostalCode
  };
}

function checkoutLineDeliveryMode(line) {
  return safeText(
    line?.selectedDeliveryMode || line?.price_data?.product_data?.metadata?.selectedDeliveryMode,
    20
  ).toLowerCase();
}

function checkoutFulfillmentProfile(body, lines = []) {
  const source = lines.length ? lines : Array.isArray(body?.cart?.items) ? body.cart.items : [];
  const modes = source.map(checkoutLineDeliveryMode).filter(Boolean);
  const hasPronto = modes.includes("pickup");
  const hasFast = modes.includes("fast");
  const hasShip = modes.includes("ship");
  const hasNational = hasFast || hasShip;
  const city = safeText(body?.delivery?.city || body?.customer?.deliveryDestinationCity, 100);
  const state = safeText(body?.delivery?.state, 100);
  const stateName = safeText(body?.delivery?.stateName, 100);
  const normalizedCity = city.toLocaleLowerCase("es-CO").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const normalizedState = state.toLocaleLowerCase("es-CO").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const normalizedStateName = stateName.toLocaleLowerCase("es-CO").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const isCartagena = normalizedCity.includes("cartagena");
  const isBolivar = normalizedState === "bl" || normalizedState === "bolivar" || normalizedStateName === "bolivar";
  const prontoCartLineIds = source
    .filter(line => checkoutLineDeliveryMode(line) === "pickup")
    .map(line => safeText(line?.cartLineId || line?.id || line?._id || line?.lineItemId, 80))
    .filter(Boolean);
  const requestedProntoMethod = safeText(body?.delivery?.prontoMethod || body?.delivery?.method, 20).toLowerCase();
  const prontoMethod = hasPronto ? requestedProntoMethod : "";
  if (!hasPronto && !hasNational) throw new Error("Selecciona la entrega de cada producto.");
  if (hasPronto && !["pickup", "moto"].includes(prontoMethod)) {
    throw new Error("Elige cómo recibir tu pedido Pronto en Cartagena.");
  }
  if (hasPronto && prontoMethod === "moto" && (!isCartagena || !isBolivar)) {
    throw new ProntoLocationUnavailableError(prontoCartLineIds);
  }
  return { hasPronto, hasFast, hasShip, hasNational, prontoMethod, city, state };
}

async function calculateDeliveryQuote(body, lines = []) {
  const profile = checkoutFulfillmentProfile(body, lines);
  const groups = [];
  if (profile.hasPronto) {
    const prontoQuote = profile.prontoMethod === "moto"
      ? await quoteMotoDelivery(body?.delivery || {})
      : { method: "pickup", fee: PICKUP_FEE_COP, carrier: "CajaModa", service: "Recoger", estimate: "24–48 horas" };
    groups.push({ ...prontoQuote, fulfillment: "pronto" });
  }
  if (profile.hasNational) {
    const nationalLines = lines.length ? lines : body?.cart?.items;
    const nationalGroups = groupNationalShipmentLines(nationalLines);
    const shipmentQuotes = await Promise.all(
      ["R", "L"]
        .filter(type => nationalGroups[type].length)
        .map(async type => {
          const shipmentLines = nationalGroups[type];
          const quote = await quoteNationalDelivery(
            body?.delivery || {},
            body?.customer || {},
            nationalLinesDeclaredValue(shipmentLines)
          );
          return {
            ...quote,
            type,
            fulfillment: type === "L" ? "liberalo" : "rapido-nacional",
            estimate: nationalShipmentDefinition(type).estimate,
            itemCount: shipmentLines.reduce(
              (total, line) => total + Math.max(1, Math.floor(Number(line?.quantity || 1))),
              0
            )
          };
        })
    );
    groups.push(...shipmentQuotes);
  }
  const method = profile.hasPronto && profile.hasNational
    ? "mixed"
    : profile.hasPronto
      ? profile.prontoMethod
      : "national";
  const labels = [];
  if (profile.hasPronto) labels.push(profile.prontoMethod === "moto" ? "Pronto a domicilio · 24–48 h" : "Pronto: Recoger en punto · 24–48 h");
  if (profile.hasFast) labels.push("Rápido Nacional · 4–7 días");
  if (profile.hasShip) labels.push("Libéralo Nacional · 14–28 días");
  return {
    method,
    prontoMethod: profile.prontoMethod,
    fee: groups.reduce((sum, group) => sum + Math.max(0, Number(group.fee || 0)), 0),
    groups,
    title: labels.join(" + "),
    maxBusinessDays: profile.hasShip ? NATIONAL_SHIPPING.liberalo.maxDays : profile.hasNational ? NATIONAL_SHIPPING.rapido.maxDays : 2
  };
}

function deliveryQuoteFingerprint(body, lines = []) {
  const delivery = body?.delivery || {};
  const cart = lines.map(line => {
    const metadata = line?.price_data?.product_data?.metadata || {};
    return {
      cartLineId: safeText(line?.cartLineId, 80),
      productId: safeText(metadata.productId || line?.productId, 80),
      variantId: safeText(metadata.variantId || line?.variantId, 80),
      quantity: Math.max(1, Math.floor(Number(line?.quantity || 1))),
      selectedDeliveryMode: safeText(line?.selectedDeliveryMode, 20).toLowerCase()
    };
  });
  const destination = {
    method: safeText(delivery.method, 20),
    prontoMethod: safeText(delivery.prontoMethod, 20),
    city: safeText(delivery.city, 100),
    cityDaneCode: safeText(delivery.cityDaneCode, 8),
    state: safeText(delivery.state, 5),
    stateName: safeText(delivery.stateName, 100),
    postalCode: safeText(delivery.postalCode, 20),
    address: safeText(delivery.address, 500),
    addressLine1: safeText(delivery.addressLine1, 180),
    neighborhood: safeText(delivery.neighborhood, 160),
    complement: safeText(delivery.complement, 120),
    references: safeText(delivery.references, 180)
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ cart, destination }))
    .digest("hex");
}

function createDeliveryQuoteToken(body, lines, quote) {
  const encoded = Buffer.from(JSON.stringify({
    expiresAt: Date.now() + (30 * 60 * 1000),
    fingerprint: deliveryQuoteFingerprint(body, lines),
    quote
  })).toString("base64url");
  const signature = crypto
    .createHmac("sha256", ENVIA_API_TOKEN)
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

function verifiedDeliveryQuoteToken(body, lines) {
  const token = safeText(body?.delivery?.quoteToken, 20000);
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("Confirma nuevamente la entrega.");
  const [encoded, signature] = parts;
  const expected = crypto
    .createHmac("sha256", ENVIA_API_TOKEN)
    .update(encoded)
    .digest();
  const received = Buffer.from(signature, "base64url");
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
    throw new Error("Confirma nuevamente la entrega.");
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Confirma nuevamente la entrega.");
  }
  if (
    Number(payload?.expiresAt || 0) < Date.now() ||
    payload?.fingerprint !== deliveryQuoteFingerprint(body, lines) ||
    !payload?.quote ||
    !Number.isFinite(Number(payload.quote.fee))
  ) {
    throw new Error("Confirma nuevamente la entrega.");
  }
  return payload.quote;
}

async function handleDeliveryQuote(request, response) {
  const body = await readBody(request);
  try {
    const items = Array.isArray(body?.cart?.items) ? body.cart.items.slice(0, 50) : [];
    if (!items.length) return sendError(response, 400, "Tu bolsa está vacía.");
    const catalogLines = await verifiedCheckoutCatalogItems(items);
    const quote = await calculateDeliveryQuote(body, catalogLines);
    const quoteToken = createDeliveryQuoteToken(body, catalogLines, quote);
    sendJson(response, 200, { ok: true, quote, quoteToken });
  } catch (error) {
    if (error instanceof CartItemUnavailableError || error instanceof ProntoLocationUnavailableError) {
      throw error;
    }
    sendError(response, 422, safeText(error?.message, 300) || "No pudimos calcular el envío con Envia.");
  }
}

async function handleDeliveryCities(_request, response, url) {
  const stateCode = safeText(url.searchParams.get("state"), 5).toUpperCase();
  const stateName = safeText(url.searchParams.get("stateName"), 100);
  const query = normalizeLocationName(url.searchParams.get("q"));
  if (!stateCode || !stateName) {
    return sendError(response, 400, "Selecciona un departamento.");
  }
  const department = normalizeLocationName(stateName);
  const cities = (await colombiaMunicipalities())
    .filter(item => locationNamesMatch(item.departmentName, department))
    .filter(item => !query || normalizeLocationName(item.name).includes(query))
    .map(item => ({ name: item.name, daneCode: item.daneCode }))
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
  sendJson(response, 200, { ok: true, state: stateCode, cities });
}

async function handleDeliveryPostalCode(_request, response, url) {
  const postalCode = safeText(url.searchParams.get("postalCode"), 20);
  if (!postalCode) return sendError(response, 400, "Ingresa un código postal.");
  const payload = await externalJson(
    `${ENVIA_GEOCODES_BASE}/zipcode/CO/${encodeURIComponent(postalCode)}`,
    {},
    8000
  );
  const located = payload?.data || payload;
  if (!located?.zipcode) return sendError(response, 404, "Código postal no encontrado.");
  sendJson(response, 200, {
    ok: true,
    location: {
      city: safeText(located.city, 100),
      state: safeText(located.state, 5).toUpperCase(),
      postalCode: safeText(located.zipcode, 20)
    }
  });
}

async function handleDeliveryAddressSuggestions(request, response) {
  if (!GOOGLE_MAPS_API_KEY) {
    return sendError(response, 503, "La ayuda de dirección todavía no está configurada.");
  }
  const body = await readBody(request);
  const input = safeText(body?.input, 180);
  if (input.length < 3) return sendJson(response, 200, { ok: true, suggestions: [] });
  const context = [
    input,
    safeText(body?.city, 100),
    safeText(body?.stateName, 100),
    "Colombia"
  ].filter(Boolean).join(", ");
  const payload = await externalJson(
    "https://places.googleapis.com/v1/places:autocomplete",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask": "suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat.mainText.text,suggestions.placePrediction.structuredFormat.secondaryText.text"
      },
      body: JSON.stringify({
        input: context,
        includedRegionCodes: ["co"],
        languageCode: "es",
        regionCode: "co",
        sessionToken: safeText(body?.sessionToken, 120) || undefined
      })
    },
    10000
  );
  const suggestions = (Array.isArray(payload?.suggestions) ? payload.suggestions : [])
    .map(item => item?.placePrediction)
    .filter(Boolean)
    .map(item => ({
      placeId: safeText(item.placeId, 220),
      text: safeText(item?.text?.text, 300),
      mainText: safeText(item?.structuredFormat?.mainText?.text, 180),
      secondaryText: safeText(item?.structuredFormat?.secondaryText?.text, 220)
    }))
    .filter(item => item.placeId && item.text)
    .slice(0, 5);
  sendJson(response, 200, { ok: true, suggestions });
}

async function handleDeliveryAddressDetails(request, response) {
  const body = await readBody(request);
  const place = await googlePlaceDetails(body?.placeId, body?.sessionToken);
  sendJson(response, 200, { ok: true, address: publicGoogleAddress(place) });
}

async function handleDeliveryDepartments(_request, response) {
  if (!ENVIA_API_TOKEN) return sendError(response, 503, "Envia todavía no está configurado.");
  const payload = await externalJson(`${ENVIA_QUERIES_BASE}/state?country_code=CO`, {
    headers: { Authorization: `Bearer ${ENVIA_API_TOKEN}` }
  });
  const departments = enviaDataArray(payload)
    .filter(item => !item?.country_code || String(item.country_code).toUpperCase() === "CO")
    .map(item => ({
    code: safeText(item?.code || item?.code_2_digits || item?.state_code || item?.abbreviation, 5),
    name: safeText(item?.name || item?.state || item?.description, 100)
  })).filter(item => item.code && item.name)
    .filter((item, index, all) => all.findIndex(candidate => candidate.code === item.code) === index)
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
  if (!departments.length) return sendError(response, 502, "Envia no devolvió los departamentos de Colombia.");
  sendJson(response, 200, { ok: true, departments });
}

async function handleCheckoutConfig(_request, response) {
  sendJson(response, 200, {
    ok: true,
    stripe: {
      configured: Boolean(stripe && STRIPE_PUBLISHABLE_KEY),
      publishableKey: STRIPE_PUBLISHABLE_KEY
    },
    nequi: {
      configured: Boolean(NEQUI_PHONE),
      phone: NEQUI_PHONE,
      masked: maskedNequiPhone(NEQUI_PHONE)
    }
  });
}

function checkoutCustomer(body) {
  const customer = body?.customer || {};
  const name = splitCustomerName(customer.customerName || customer.name);
  return {
    name,
    email: safeText(customer.email, 250),
    phone: safeText(customer.customerPhone || customer.phone, 80)
  };
}

async function checkoutDelivery(body, lines = []) {
  const profile = checkoutFulfillmentProfile(body, lines);
  const quote = verifiedDeliveryQuoteToken(body, lines) || await calculateDeliveryQuote(body, lines);
  const method = quote.method;
  const addressLine = method === "pickup"
    ? CARTAGENA_PICKUP_ADDRESS
    : completeDeliveryStreet({
        ...(body?.delivery || {}),
        address: body?.delivery?.address || body?.customer?.deliveryAddress
      });
  const city = method === "pickup" ? "Cartagena" : profile.city;
  if (method !== "pickup" && !addressLine) throw new Error("Ingresa la dirección de entrega.");
  if (profile.hasNational && !safeText(body?.delivery?.state, 5)) {
    throw new Error("Selecciona el departamento de entrega.");
  }
  return {
    method,
    prontoMethod: profile.prontoMethod,
    addressLine,
    city,
    state: safeText(body?.delivery?.state, 5),
    stateName: safeText(body?.delivery?.stateName, 100),
    cityDaneCode: safeText(body?.delivery?.cityDaneCode, 8),
    addressLine1: safeText(body?.delivery?.addressLine1, 180),
    neighborhood: safeText(body?.delivery?.neighborhood, 100),
    complement: safeText(body?.delivery?.complement, 120),
    references: safeText(body?.delivery?.references, 180),
    postalCode: safeText(body?.delivery?.postalCode, 20) ||
      safeText(quote?.groups?.find(group => group?.postalCode)?.postalCode, 20),
    fee: quote.fee,
    title: quote.title,
    maxBusinessDays: quote.maxBusinessDays,
    quote
  };
}

async function verifiedCheckoutLines(items) {
  const verified = await verifiedCheckoutCatalogItems(items);
  return verified.map(line => ({
    cartLineId: safeText(line.cartLineId, 80),
    productId: line.price_data.product_data.metadata.productId,
    variantId: line.price_data.product_data.metadata.variantId,
    quantity: line.quantity,
    amount: Number(line.price_data.unit_amount) / 100,
    name: line.price_data.product_data.name,
    description: line.price_data.product_data.description || "",
    fulfillmentCode: safeText(line.fulfillmentCode, 10).toUpperCase(),
    selectedDeliveryMode: safeText(line.selectedDeliveryMode, 20).toLowerCase(),
    sku: safeText(line.sku, 100).toUpperCase(),
    size: safeText(line.size, 50),
    color: safeText(line.color, 100),
    image: safeText(line.image, 1500)
  }));
}

async function handleValidateCheckoutCart(request, response) {
  const body = await readBody(request);
  const items = Array.isArray(body?.cart?.items) ? body.cart.items.slice(0, 50) : [];
  if (!items.length) return sendError(response, 400, "Tu bolsa está vacía.");
  await verifiedCheckoutCatalogItems(items);
  sendJson(response, 200, { ok: true });
}

function nequiExternalOrderId(requestId) {
  const digest = crypto.createHash("sha256").update(requestId).digest("hex").slice(0, 32);
  return `nequi:${digest}`;
}

function isNequiOrder(order) {
  return String(order?.channelInfo?.externalOrderId || "").startsWith("nequi:");
}

function getNequiReference(order) {
  const title = safeText(order?.shippingInfo?.title, 350);
  const match = title.match(/(?:Ref|Referencia)\s+([^·]+)$/i);
  return safeText(match?.[1], 100).trim();
}

async function handleCreateNequiOrder(request, response) {
  if (!wix) return sendError(response, 503, "Wix no está configurado para recibir el pedido.");
  if (!NEQUI_PHONE) return sendError(response, 503, "El número Nequi todavía no está configurado.");
  const body = await readBody(request);
  const requestId = safeText(body?.requestId, 100);
  const reference = safeText(body?.reference, 100);
  const items = Array.isArray(body?.cart?.items) ? body.cart.items.slice(0, 50) : [];
  if (!requestId || !items.length) return sendError(response, 400, "El pedido no es válido.");
  if (!reference) return sendError(response, 400, "Ingresa el número de referencia Nequi.");

  const externalOrderId = nequiExternalOrderId(requestId);
  const existingResult = await wix.orders.searchOrders({
    filter: { "channelInfo.externalOrderId": externalOrderId },
    cursorPaging: { limit: 1 }
  });
  const existing = existingResult?.orders?.[0];
  if (existing) {
    await analytics.recordOrderContext({
      externalId: externalOrderId,
      order: existing,
      analyticsContext: body?.analytics,
      items,
      value: getOrderTotal(existing),
      paymentMethod: "nequi"
    }).catch(error => {
      console.error("[Analytics] Existing Nequi order attribution failed:", error);
    });
    return sendJson(response, 200, {
      ok: true,
      orderId: existing._id || existing.id,
      orderNumber: existing.number,
      paymentStatus: existing.paymentStatus
    });
  }

  const lines = await verifiedCheckoutLines(items);
  const subtotal = lines.reduce((sum, line) => sum + line.amount * line.quantity, 0);
  const customer = checkoutCustomer(body);
  const delivery = await checkoutDelivery(body, lines);
  const deliveryTitle = delivery.title;
  const title = `${deliveryTitle} · Ref ${reference}`;
  const address = {
    country: "CO",
    city: delivery.city,
    subdivision: delivery.state,
    postalCode: delivery.postalCode,
    addressLine1: delivery.addressLine
  };

  const imported = await wix.orders.importOrder({
    number: importedOrderNumber(externalOrderId),
    status: "APPROVED",
    paymentStatus: "PENDING_MERCHANT",
    fulfillmentStatus: "NOT_FULFILLED",
    channelInfo: { type: "OTHER_PLATFORM", externalOrderId },
    currency: "COP",
    currencyConversionDetails: { originalCurrency: "COP", conversionRate: "1" },
    buyerInfo: { email: customer.email },
    billingInfo: {
      contactDetails: { firstName: customer.name.firstName, lastName: customer.name.lastName, email: customer.email, phone: customer.phone },
      address
    },
    shippingInfo: {
      title,
      cost: { amount: String(delivery.fee) },
      logistics: {
        shippingDestination: {
          address,
          contactDetails: { firstName: customer.name.firstName, lastName: customer.name.lastName, email: customer.email, phone: customer.phone }
        }
      }
    },
    lineItems: lines.map(wixOrderLineItem),
    priceSummary: {
      subtotal: { amount: String(subtotal) },
      shipping: { amount: String(delivery.fee) },
      tax: { amount: "0" },
      discount: { amount: "0" },
      total: { amount: String(subtotal + delivery.fee) }
    }
  });

  const order = imported?.order || imported;
  await analytics.recordOrderContext({
    externalId: externalOrderId,
    order,
    analyticsContext: body?.analytics,
    items: lines.map(line => ({
      productId: line.productId,
      productName: line.name,
      productImage: line.image,
      quantity: line.quantity,
      value: line.amount
    })),
    value: subtotal + delivery.fee,
    paymentMethod: "nequi"
  }).catch(error => {
    console.error("[Analytics] Nequi order attribution failed:", error);
  });
  sendJson(response, 201, {
    ok: true,
    orderId: order?._id || order?.id,
    orderNumber: order?.number,
    paymentStatus: order?.paymentStatus || "PENDING_MERCHANT"
  });
}

async function handleConfirmNequiOrder(request, response, orderId) {
  if (!isAuthorized(request)) return sendError(response, 401, "Inicia sesión en Store Loader.");
  if (!wix) return sendError(response, 503, "Wix no está configurado.");
  const existingConfirmation = nequiConfirmationLocks.get(orderId);
  if (existingConfirmation) {
    const confirmed = await existingConfirmation;
    return sendJson(response, 200, { ok: true, order: normalizeWixOrder(confirmed) });
  }

  const confirmation = (async () => {
    const order = await wix.orders.getOrder(orderId);
    if (!isNequiOrder(order)) throw new Error("Este no es un pedido Nequi.");
    if (String(order.paymentStatus).toUpperCase() === "PAID") {
      await sendOrderConfirmationEmail(order);
      return order;
    }

    const lines = (Array.isArray(order?.lineItems) ? order.lineItems : [])
      .map(line => ({
        productId: safeText(line?.catalogReference?.catalogItemId, 80),
        variantId: safeText(line?.catalogReference?.options?.variantId, 80),
        quantity: Math.max(1, Math.floor(Number(line?.quantity || 1)))
      }))
      .filter(line => line.productId && line.variantId);
    if (!lines.length) throw new Error("El pedido Nequi no tiene inventario verificable.");

    const updated = await wix.orders.importOrder({ ...order, paymentStatus: "PAID" });
    await decrementStripeInventory(lines);
    const confirmed = updated?.order || updated;
    await sendOrderConfirmationEmail(confirmed);
    return confirmed;
  })();

  nequiConfirmationLocks.set(orderId, confirmation);
  try {
    const confirmed = await confirmation;
    await analytics.recordPurchase({
      externalId: "nequi-" + orderId,
      order: confirmed,
      items: (Array.isArray(confirmed?.lineItems) ? confirmed.lineItems : [])
        .map(normalizeWixOrderLineItem)
        .map(line => ({
          productId: line.productId,
          productName: line.name,
          productImage: line.image,
          quantity: line.quantity,
          value: 0
        })),
      value: getOrderTotal(confirmed),
      paymentMethod: "nequi"
    }).catch(error => {
      console.error("[Analytics] Nequi purchase recording failed:", error);
    });
    sendJson(response, 200, { ok: true, order: normalizeWixOrder(confirmed) });
  } finally {
    nequiConfirmationLocks.delete(orderId);
  }
}

/* ============================================================
   PUBLIC WIX PRODUCT REVIEWS
   ============================================================ */

const WIX_REVIEW_NAMESPACE = process.env.WIX_REVIEW_NAMESPACE || "stores";

async function wixReviewsRequest(path,body){
  if(!WIX_API_KEY || !WIX_SITE_ID){
    throw new Error("Wix Reviews no está configurado.");
  }
  const response = await fetch(`https://www.wixapis.com${path}`,{
    method:"POST",
    headers:{
      "Authorization":WIX_API_KEY,
      "wix-site-id":WIX_SITE_ID,
      "Content-Type":"application/json"
    },
    body:JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if(!response.ok){
    throw new Error(payload?.message || payload?.error || "Wix Reviews rechazó la solicitud.");
  }
  return payload;
}

function normalizeWixReview(review){
  return {
    id:review?._id || review?.id || "",
    rating:Number(review?.content?.rating || review?.rating || 0),
    authorName:review?.author?.authorName || review?.author?.displayName || review?.authorName || "Cliente CajaModa",
    content:review?.content?.body || review?.body || "",
    status:review?.moderation?.moderationStatus || review?.moderationStatus || review?.status || "SUBMITTED",
    verified:review?.verified === true
  };
}

async function handleGetProductReviews(request,response,url){
  const productId=String(url.searchParams.get("productId") || "").trim();
  if(!productId){sendError(response,400,"Falta el producto.");return}
  const payload=await wixReviewsRequest("/reviews/v1/reviews/query",{
    query:{
      filter:{namespace:WIX_REVIEW_NAMESPACE,entityId:productId},
      sort:[{fieldName:"createdDate",order:"DESC"}],
      paging:{limit:100}
    }
  });
  const reviews=(payload?.reviews || payload?.items || [])
    .map(normalizeWixReview)
    .filter(review =>
      review.verified &&
      (review.status === "APPROVED" || review.status === "PUBLISHED")
    );
  const count=reviews.length;
  const averageRating=count
    ? reviews.reduce((sum,review)=>sum+review.rating,0)/count
    : 0;
  sendJson(response,200,{ok:true,reviews,summary:{averageRating,reviewCount:count}});
}

/* ============================================================
   AUTHENTICATION
   ============================================================ */

function cleanSessions() {

  const current =
    now();

  for (
    const [
      token,
      session
    ]
    of sessions
  ) {

    if (
      session.expiresAt <=
      current
    ) {

      sessions.delete(
        token
      );
    }
  }
}

function createSession(role = "owner") {

  cleanSessions();

  const token =
    createToken();

  sessions.set(
    token,
    {

      createdAt:
        now(),

      role,

      storeId:
        STORE_ID,

      expiresAt:
        now() +
        SESSION_TTL
    }
  );

  return token;
}

function getBearerToken(
  request
) {

  const header =
    String(
      request
        .headers
        .authorization ||
      ""
    );

  if (
    !header.startsWith(
      "Bearer "
    )
  ) {

    return "";
  }

  return header
    .slice(7)
    .trim();
}

function getAuthorizedSession(
  request
) {

  cleanSessions();

  const token =
    getBearerToken(
      request
    );

  if (
    !token
  ) {

    return null;
  }

  const session =
    sessions.get(
      token
    );

  if (
    !session
  ) {

    return null;
  }

  if (
    session.expiresAt <=
    now()
  ) {

    sessions.delete(
      token
    );

    return null;
  }

  session.expiresAt =
    now() +
    SESSION_TTL;

  return session;
}

function isAuthorized(request) {
  return Boolean(getAuthorizedSession(request));
}

function isPlatformAdmin(request) {
  return getAuthorizedSession(request)?.role === "admin";
}

/* ============================================================
   IMAGE DATA
   ============================================================ */

function parseDataImage(
  dataUrl
) {

  const value =
    String(
      dataUrl ||
      ""
    );

  const match =
    value.match(
      /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/
    );

  if (
    !match
  ) {

    throw new Error(
      "Una de las fotos no tiene un formato válido."
    );
  }

  const mimeType =
    match[1];

  const buffer =
    Buffer.from(
      match[2],
      "base64"
    );

  if (
    !buffer.length
  ) {

    throw new Error(
      "Una de las fotos está vacía."
    );
  }

  const maxImageSize =
    8 *
    1024 *
    1024;

  if (
    buffer.length >
    maxImageSize
  ) {

    throw new Error(
      "Cada foto debe pesar menos de 8 MB."
    );
  }

  return {

    mimeType,

    buffer
  };
}

function extensionForMime(
  mimeType
) {

  switch (
    mimeType
  ) {

    case "image/png":
      return "png";

    case "image/webp":
      return "webp";

    case "image/gif":
      return "gif";

    case "image/heic":
      return "heic";

    case "image/heif":
      return "heif";

    case "image/jpeg":
    case "image/jpg":
    default:
      return "jpg";
  }
}

/* ============================================================
   WAIT FOR WIX MEDIA
   ============================================================ */

async function waitForFileReady(
  fileId
) {

  const attempts =
    24;

  for (
    let attempt = 0;
    attempt < attempts;
    attempt += 1
  ) {

    try {

      const descriptor =
        await wix
          .files
          .getFileDescriptor(
            fileId
          );

      if (
        descriptor
          ?.operationStatus ===
        "READY"
      ) {

        return descriptor;
      }

    } catch (
      error
    ) {

      if (
        attempt ===
        attempts - 1
      ) {

        throw error;
      }
    }

    await sleep(
      500
    );
  }

  throw new Error(
    "Wix todavía está procesando una foto. Intenta publicar otra vez."
  );
}

/* ============================================================
   UPLOAD ONE IMAGE TO WIX
   ============================================================ */

async function uploadImage(
  dataUrl,
  index
) {

  const {
    mimeType,
    buffer
  } =
    parseDataImage(
      dataUrl
    );

  const extension =
    extensionForMime(
      mimeType
    );

  const fileName =
    `store-loader-${Date.now()}-${index + 1}.${extension}`;

  const generated =
    await wix
      .files
      .generateFileUploadUrl(
        mimeType,
        {
          fileName
        }
      );

  const uploadUrl =
    generated
      ?.uploadUrl;

  if (
    !uploadUrl
  ) {

    throw new Error(
      "Wix no devolvió una dirección para cargar la foto."
    );
  }

  const uploadResponse =
    await fetch(
      uploadUrl,
      {

        method:
          "PUT",

        headers: {

          "Content-Type":
            mimeType
        },

        body:
          buffer
      }
    );

  if (
    !uploadResponse.ok
  ) {

    const text =
      await uploadResponse
        .text();

    throw new Error(
      `No pudimos cargar una foto en Wix. ${text}`
    );
  }

  const uploaded =
    await uploadResponse
      .json();

  const fileId =
    uploaded
      ?.file
      ?.id;

  if (
    !fileId
  ) {

    throw new Error(
      "Wix no devolvió el ID de la foto."
    );
  }

  await waitForFileReady(
    fileId
  );

  return fileId;
}

/* ============================================================
   UPLOAD PRODUCT PHOTOS
   ============================================================ */

async function uploadPhotos(
  photos
) {

  const selected =
    Array.isArray(
      photos
    )
      ? photos
          .filter(Boolean)
          .slice(
            0,
            5
          )
      : [];

  const fileIds = [];

  for (
    let index = 0;
    index < selected.length;
    index += 1
  ) {

    const fileId =
      await uploadImage(
        selected[index],
        index
      );

    fileIds.push(
      fileId
    );
  }

  return fileIds;
}

/* ============================================================
   PRODUCT OPTIONS
   ============================================================ */

function cleanList(
  values,
  maxItems = 20
) {

  if (
    !Array.isArray(
      values
    )
  ) {

    return [];
  }

  return [
    ...new Set(
      values
        .map(
          value =>
            safeText(
              value,
              50
            )
        )
        .filter(Boolean)
    )
  ]
    .slice(
      0,
      maxItems
    );
}

function buildOptions(
  sizes,
  colors
) {

  const options = [];

  if (
    sizes.length
  ) {

    options.push({

      name:
        "Size",

      optionRenderType:
        "TEXT_CHOICES",

      choicesSettings: {

        choices:
          sizes.map(
            size => ({

              name:
                size,

              choiceType:
                "CHOICE_TEXT"
            })
          )
      }
    });
  }

  if (
    colors.length
  ) {

    options.push({

      name:
        "Color",

      optionRenderType:
        "TEXT_CHOICES",

      choicesSettings: {

        choices:
          colors.map(
            color => ({

              name:
                color,

              choiceType:
                "CHOICE_TEXT"
            })
          )
      }
    });
  }

  return options;
}

/* ============================================================
   VARIANT COMBINATIONS
   ============================================================ */

function buildCombinations(
  sizes,
  colors
) {

  if (
    sizes.length &&
    colors.length
  ) {

    return sizes.flatMap(
      size =>
        colors.map(
          color => ({
            size,
            color
          })
        )
    );
  }

  if (
    sizes.length
  ) {

    return sizes.map(
      size => ({
        size,
        color:
          ""
      })
    );
  }

  if (
    colors.length
  ) {

    return colors.map(
      color => ({
        size:
          "",
        color
      })
    );
  }

  return [
    {
      size:
        "",
      color:
        ""
    }
  ];
}

function buildVariantChoices(
  combination
) {

  const choices = [];

  if (
    combination.size
  ) {

    choices.push({

      optionChoiceNames: {

        optionName:
          "Size",

        choiceName:
          combination.size,

        renderType:
          "TEXT_CHOICES"
      }
    });
  }

  if (
    combination.color
  ) {

    choices.push({

      optionChoiceNames: {

        optionName:
          "Color",

        choiceName:
          combination.color,

        renderType:
          "TEXT_CHOICES"
      }
    });
  }

  return choices;
}

/* ============================================================
   VARIANTS
   ============================================================ */

function buildVariants(
  sizes,
  colors,
  price,
  cost,
  quantity,
  trackInventory,
  stockStatus,
  allowPreorder,
  fulfillmentCode,
  styleCode,
  variantOverrides = []
) {

  const suppliedOverrides = Array.isArray(variantOverrides) ? variantOverrides : [];
  const combinations = suppliedOverrides.length
    ? suppliedOverrides.map(item => ({size:safeText(item?.size, 20), color:safeText(item?.color, 50)}))
    : buildCombinations(sizes, colors);

  const totalQuantity =
    Math.max(
      0,
      Number(
        quantity ||
        0
      )
    );

  const quantityPerVariant =
    combinations.length
      ? Math.floor(
          totalQuantity /
          combinations.length
        )
      : totalQuantity;

  let remainder =
    combinations.length
      ? totalQuantity %
        combinations.length
      : 0;

  const skuSegment = value => safeText(value, 50)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();

  const overrideMap = new Map(
    suppliedOverrides.map(item => [
      `${safeText(item?.size, 20)}::${safeText(item?.color, 50)}`,
      item
    ])
  );

  const variants = combinations.map(
    combination => {

      const override = overrideMap.get(`${combination.size}::${combination.color}`);
      const defaultQuantity = quantityPerVariant + (remainder > 0 ? 1 : 0);
      const requestedQuantity = Number(override?.quantity);
      const variantQuantity = Number.isInteger(requestedQuantity) && requestedQuantity >= 0
        ? requestedQuantity
        : defaultQuantity;

      if(
        remainder > 0
      ){
        remainder -= 1;
      }

      const variantFulfillment = safeText(override?.fulfillmentCode || fulfillmentCode, 10).toUpperCase();
      const generatedSku = [
          variantFulfillment,
          styleCode,
          combination.color ? skuSegment(combination.color).slice(0, 3) : "",
          combination.size ? skuSegment(combination.size) : ""
        ].filter(Boolean).join("-");
      const customSku = safeText(override?.sku, 100).replace(/[^A-Za-z0-9-]/g, "").toUpperCase();

      return {

        sku: customSku || generatedSku,

        visible:
          true,

        choices:
          buildVariantChoices(
            combination
          ),

        price: {

          actualPrice: {

            amount:
              String(
                price
              )
          }
        },

        revenueDetails: cost > 0 ? { cost: { amount: String(cost) } } : undefined,

        inventoryItem: trackInventory
          ? {
              quantity: stockStatus === "OUT_OF_STOCK" ? 0 : variantQuantity,
              preorderInfo: allowPreorder ? { enabled: true, message: "Disponible para preventa", limit: 100000 } : undefined
            }
          : { inStock: stockStatus !== "OUT_OF_STOCK" },

        physicalProperties:
          {}
      };
    }
  );

  const skus = variants.map(variant => variant.sku);
  if (new Set(skus).size !== skus.length) {
    throw new Error("Los colores y tallas generaron SKUs duplicados. Usa nombres de color más distintos.");
  }

  return variants;
}


/* ============================================================
   CATEGORY LABEL
   ============================================================ */

const CATEGORY_NAMES = {

  late:
    "Noches Largas",

  chill:
    "Dias Tranquilos",

  quick:
    "Rapido y Facil",

  sun:
    "Bano De Sol"
};

function getCategoryName(
  category
) {

  return (
    CATEGORY_NAMES[
      category
    ] ||
    "CajaModa"
  );
}


const WIX_STORES_APP_ID =
  "215238eb-22a5-4c36-9e7b-e7c08025e04e";

const STORE_CATEGORY_TREE = {
  appNamespace:
    "@wix/stores"
};

const CATEGORY_ROUTE_BY_NAME = {
  "noches largas":
    "late",

  "dias tranquilos":
    "chill",

  "rapido y facil":
    "quick",

  "bano de sol":
    "sun"
};

function showcaseLimit(categoryKey) {
  return categoryKey === "sun" ? 4 : 10;
}

async function categoryArrangement(categoryKey) {
  const categories = await queryRoutedCategories();
  const category = categories.find(item => item.vibeId === categoryKey);
  if (!category) throw new Error(`No existe la categoría Wix "${CATEGORY_NAMES[categoryKey] || categoryKey}".`);
  const [listed, arranged] = await Promise.all([
    wix.categoriesV3.listItemsInCategory(category.id, STORE_CATEGORY_TREE, {cursorPaging:{limit:1000}}),
    wix.categoriesV3.getArrangedItems(category.id, STORE_CATEGORY_TREE)
  ]);
  const allIds = (listed?.items || []).map(item => String(item?.catalogItemId || "")).filter(Boolean);
  const orderedIds = (arranged?.items || []).map(item => String(item?.catalogItemId || "")).filter(id => allIds.includes(id));
  allIds.forEach(id => { if (!orderedIds.includes(id)) orderedIds.push(id); });
  return {category, orderedIds};
}

async function saveCategoryArrangement(categoryId, orderedIds) {
  await wix.categoriesV3.setArrangedItems(categoryId, STORE_CATEGORY_TREE, {
    items: orderedIds.map(catalogItemId => ({appId:WIX_STORES_APP_ID, catalogItemId}))
  });
}

async function getShowcaseSlots() {
  const categories = await queryRoutedCategories();
  const entries = await Promise.all(categories.map(async category => {
    const {orderedIds} = await categoryArrangement(category.vibeId);
    return orderedIds
      .slice(0, showcaseLimit(category.vibeId))
      .map((productId, index) => [String(productId), index + 1]);
  }));
  return Object.fromEntries(entries.flat().filter(([id]) => id));
}

async function getCategoryShowcases() {
  const categories = await queryRoutedCategories();
  const entries = await Promise.all(categories.map(async category => {
    const {orderedIds} = await categoryArrangement(category.vibeId);
    const productIds = orderedIds.slice(0, showcaseLimit(category.vibeId));
    const products = await Promise.all(productIds.map(async productId => {
      try {
        const result = await wix.productsV3.getProduct(productId, {
          fields:["MEDIA_ITEMS_INFO","THUMBNAIL"]
        });
        return result?.product || result;
      } catch (error) {
        console.warn(`[Category showcase] No se pudo cargar ${productId}:`, error?.message || error);
        return null;
      }
    }));
    return [category.vibeId, productIds.map((productId, index) => {
      const product = products[index];
      return {
        id:String(productId),
        name:safeText(product?.name, 300),
        image:getProductImageUrl(product),
        photos:getProductImageUrls(product),
        showcaseSlot:index + 1
      };
    })];
  }));
  return Object.fromEntries(entries);
}

async function assignFirstOpenShowcaseSlot(productId, categoryKey) {
  const {category, orderedIds} = await categoryArrangement(categoryKey);
  const id = String(productId);
  const without = orderedIds.filter(itemId => itemId !== id);
  without.push(id);
  await saveCategoryArrangement(category.id, without);
  return without.indexOf(id) + 1;
}

function normalizeCategoryRouteName(
  value
) {

  return String(
    value ||
    ""
  )
    .normalize(
      "NFD"
    )
    .replace(
      /[\u0300-\u036f]/g,
      ""
    )
    .toLowerCase()
    .replace(
      /[^a-z0-9]+/g,
      " "
    )
    .trim();
}

function categoryRouteFromName(
  value
) {

  return (
    CATEGORY_ROUTE_BY_NAME[
      normalizeCategoryRouteName(
        value
      )
    ] ||
    ""
  );
}

let categoryRouteCache = {
  expiresAt:
    0,

  routes:
    {}
};

async function queryRoutedCategories() {

  const results =
    await Promise.all(
      Object.values(
        CATEGORY_NAMES
      ).map(
        name =>
          wix
            .categoriesV3
            .queryCategories({
              treeReference:
                STORE_CATEGORY_TREE,

              returnNonVisibleCategories:
                true
            })
            .eq(
              "name",
              name
            )
            .limit(
              1
            )
            .find()
      )
    );

  return results
    .flatMap(
      result =>
        result?.items ||
        []
    )
    .map(
      category => ({
        id:
          String(
            category?._id ||
            category?.id ||
            ""
          ),

        name:
          String(
            category?.name ||
            ""
          ),

        vibeId:
          categoryRouteFromName(
            category?.name
          )
      })
    )
    .filter(
      category =>
        category.id &&
        category.vibeId
    );
}

async function getCategoryRoutes() {

  if (
    categoryRouteCache
      .expiresAt >
    Date.now()
  ) {

    return (
      categoryRouteCache
        .routes
    );
  }

  if (
    !wix
  ) {

    throw new Error(
      "El servidor todavía no está conectado a Wix."
    );
  }

  const categories =
    await queryRoutedCategories();

  const memberships =
    await Promise.all(
      categories.map(
        async category => {

          const result =
            await wix
              .categoriesV3
              .listItemsInCategory(
                category.id,
                STORE_CATEGORY_TREE,
                {
                  cursorPaging: {
                    limit:
                      100
                  }
                }
              );

          return {
            vibeId:
              category.vibeId,

            productIds:
              (
                result?.items ||
                []
              )
                .filter(
                  item =>
                    !item?.appId ||
                    item.appId ===
                      WIX_STORES_APP_ID
                )
                .map(
                  item =>
                    String(
                      item
                        ?.catalogItemId ||
                      ""
                    )
                )
                .filter(
                  Boolean
                )
          };
        }
      )
    );

  const routes = {};

  for (
    const membership
    of memberships
  ) {

    for (
      const productId
      of membership.productIds
    ) {

      routes[
        productId
      ] =
        membership.vibeId;
    }
  }

  categoryRouteCache = {
    expiresAt:
      Date.now() +
      60 * 1000,

    routes
  };

  return routes;
}

async function assignProductCategory(
  productId,
  categoryKey
) {

  const targetVibe =
    categoryRouteFromName(
      CATEGORY_NAMES[
        categoryKey
      ] ||
      categoryKey
    );

  if (
    !targetVibe
  ) {

    return;
  }

  const categories =
    await queryRoutedCategories();

  const target =
    categories.find(
      category =>
        category.vibeId ===
        targetVibe
    );

  if (
    !target
  ) {

    throw new Error(
      `No existe la categoria Wix "${CATEGORY_NAMES[categoryKey] || categoryKey}".`
    );
  }

  const itemReference = {
    appId: WIX_STORES_APP_ID,
    catalogItemId: String(productId)
  };

  for (const category of categories) {
    if (category.id === target.id) continue;
    const listed = await wix.categoriesV3.listItemsInCategory(
      category.id,
      STORE_CATEGORY_TREE,
      { cursorPaging: { limit: 1000 } }
    );
    const belongsHere = (listed?.items || []).some(item =>
      String(item?.catalogItemId || "") === String(productId) &&
      (!item?.appId || item.appId === WIX_STORES_APP_ID)
    );
    if (belongsHere) {
      await wix.categoriesV3.bulkRemoveItemsFromCategory(
        category.id,
        [itemReference],
        { treeReference: STORE_CATEGORY_TREE }
      );
    }
  }

  await wix
    .categoriesV3
    .bulkAddItemsToCategory(
      target.id,
      [itemReference],
      {
        treeReference:
          STORE_CATEGORY_TREE
      }
    );

  categoryRouteCache
    .expiresAt =
      0;
}

let lastReservedStyleNumber = 0;
async function nextPermanentStyleCode(reserve = false) {
  const result = await wix.inventoryItemsV3
    .queryInventoryItems()
    .ne("_id", "00000000-0000-0000-0000-000000000000")
    .limit(1000)
    .find();
  const items = Array.isArray(result?.items) ? result.items : [];
  const productIds = new Set();
  let highest = 0;
  for (const rawItem of items) {
    const item = normalizeInventoryItem(rawItem);
    if (item.productId) productIds.add(item.productId);
    const match = String(item.sku || "").toUpperCase().match(/(?:^|-)CM(\d+)(?:-|$)/);
    if (match) highest = Math.max(highest, Number(match[1]) || 0);
  }
  const next = Math.max(highest + 1, productIds.size + 1, lastReservedStyleNumber + 1);
  if (reserve) lastReservedStyleNumber = next;
  return `CM${String(next).padStart(4, "0")}`;
}

/* ============================================================
   CREATE WIX PRODUCT
   ============================================================ */

async function createWixProduct(
  input
) {

  if (
    !wix
  ) {

    throw new Error(
      "El servidor todavía no está conectado a Wix."
    );
  }

  const name =
    safeText(
      input.name,
      80
    );

  const description =
    safeText(
      input.description,
      16000
    );

  const cost = Math.max(0, Number(input.cost || 0));
  const price = cost > 0 ? Math.round(cost * 2.816) : 0;
  const trackInventory = input.trackInventory !== false;
  const stockStatus = input.stockStatus === "OUT_OF_STOCK" ? "OUT_OF_STOCK" : "IN_STOCK";
  const allowPreorder = Boolean(input.allowPreorder);

  const quantity =
    Math.max(
      0,
      Number(
        input.quantity ||
        0
      )
    );

  const category =
    safeText(
      input.category,
      30
    );

  const storeId =
    safeText(
      input.storeId,
      100
    ) ||
    "carolize";

  const storeName =
    safeText(
      input.storeName,
      100
    ) ||
    "Carolize Boutique";

  const sizes =
    cleanList(
      input.sizes,
      10
    );

  const colors = [];

  const fulfillmentCode = safeText(input.fulfillmentCode, 10).toUpperCase();
  // The numeric product record is generated on the server so a client cannot
  // accidentally reuse it. It becomes the permanent SKU family for every
  // size of this product and remains unchanged when inventory quantities move.
  const styleCode = await nextPermanentStyleCode(true);

  if (!["P", "R", "PR", "L", "PL", "RL", "PRL"].includes(fulfillmentCode)) {
    throw new Error("Selecciona un tipo de entrega válido.");
  }

  if (
    !name
  ) {

    throw new Error(
      "El producto necesita un nombre."
    );
  }

  if (
    !Number.isFinite(
      price
    ) ||
    price <= 0
  ) {

    throw new Error(
      "El producto necesita un precio válido."
    );
  }

  const photoIds =
    await uploadPhotos(
      input.photos
    );

  const options =
    buildOptions(
      sizes,
      colors
    );

  const variants =
    buildVariants(
      sizes,
      colors,
      price,
      cost,
      quantity,
      trackInventory,
      stockStatus,
      allowPreorder,
      fulfillmentCode,
      styleCode,
      // New catalog records always receive their permanent server-assigned
      // SKU family. Client-side previews must never become the saved record.
      Array.isArray(input.variantOverrides)
        ? input.variantOverrides.map((variant) => ({ ...variant, sku: "" }))
        : []
    );

  const product = {

    name,

    productType:
      "PHYSICAL",

    visible:
      true,

    plainDescription:
      description
        ? `<p>${escapeHtml(description)}</p>`
        : "<p></p>",

    physicalProperties:
      {},

    options,

    variantsInfo: {

      variants
    },

    media:
      photoIds.length
        ? {

            itemsInfo: {

              items:
                photoIds.map(
                  id => ({
                    id
                  })
                )
            }
          }
        : undefined
  };

  const result = await wix.productsV3.createProductWithInventory(product, {
    returnEntity: true,
    fields: ["CURRENCY", "MEDIA_ITEMS_INFO", "THUMBNAIL"]
  });

  let created = result?.product;

  if (
    !created
      ?._id &&
    !created
      ?.id
  ) {

    throw new Error(
      "Wix no devolvió el producto creado."
    );
  }
  const inventoryResults = Array.isArray(result?.inventoryResults?.results)
    ? result.inventoryResults.results
    : [];

  const inventoryFailures = inventoryResults.filter(item => item?.itemMetadata?.success === false);
  const reportedInventoryFailures = Number(result?.inventoryResults?.bulkActionMetadata?.totalFailures || 0);

  if (
    trackInventory &&
    (
      inventoryResults.length !== variants.length ||
      inventoryFailures.length ||
      reportedInventoryFailures > 0 ||
      result?.inventoryResults?.error
    )
  ) {
    await wix.productsV3.deleteProduct(created._id || created.id);
    throw new Error("Wix no creó correctamente el inventario de todas las variantes. No se guardó una copia incompleta.");
  }

  const createdProductId = created._id || created.id;
  let confirmedCreatedVariants = [];
  try {
    const expectedBySize = new Map(
      variants.map(variant => [
        existingVariantSize(variant),
        {
          sku:safeText(variant?.sku, 160).toUpperCase(),
          quantity:Number(variant?.inventoryItem?.quantity || 0),
          inStock:variant?.inventoryItem?.inStock !== false
        }
      ])
    );
    const createdVariants = Array.isArray(created?.variantsInfo?.variants)
      ? created.variantsInfo.variants
      : [];
    if (createdVariants.length !== variants.length) {
      throw new Error("Wix no devolvió todas las variantes para guardar sus SKU.");
    }

    let createdInventory = [];
    for(let attempt = 0; attempt < 8; attempt += 1){
      createdInventory = (await getWixInventory()).filter(
        item => String(item.productId) === String(createdProductId)
      );
      if(!trackInventory || createdInventory.length === createdVariants.length) break;
      if(attempt < 7) await new Promise(resolve => setTimeout(resolve, 750));
    }
    if(trackInventory && createdInventory.length !== createdVariants.length){
      throw new Error("Wix no devolvió todos los inventarios permanentes del producto.");
    }

    const inventoryByVariant = new Map(
      createdInventory.map(item => [String(item.variantId), item])
    );
    const variantsWithInventory = createdVariants.map(variant => {
      const size = existingVariantSize(variant);
      const expected = expectedBySize.get(size);
      const variantId = safeText(variant?._id || variant?.id || variant?.variantId, 150);
      const inventoryItem = inventoryByVariant.get(variantId);
      if(!expected) throw new Error(`Wix no devolvió la talla ${size || "única"} para guardar su SKU.`);
      if(trackInventory && !inventoryItem){
        throw new Error(`Wix no devolvió el inventario permanente de la talla ${size || "única"}.`);
      }
      return {
        ...variant,
        sku:expected.sku,
        inventoryItem:trackInventory
          ? {
              _id:inventoryItem.id,
              revision:inventoryItem.revision,
              quantity:expected.quantity
            }
          : {inStock:expected.inStock}
      };
    });
    const atomicResult = await wix.productsV3.updateProductWithInventory(
      createdProductId,
      {
        revision:created.revision,
        options:created.options || options,
        variantsInfo:{variants:variantsWithInventory}
      },
      {
        returnEntity:true,
        fields:["CURRENCY","MEDIA_ITEMS_INFO","THUMBNAIL"]
      }
    );
    const atomicFailures = Array.isArray(atomicResult?.inventoryResults?.results)
      ? atomicResult.inventoryResults.results.filter(item => item?.itemMetadata?.success === false)
      : [];
    if(
      atomicFailures.length ||
      Number(atomicResult?.inventoryResults?.bulkActionMetadata?.totalFailures || 0) > 0 ||
      atomicResult?.inventoryResults?.error
    ){
      throw new Error("Wix rechazó el SKU o la cantidad de una variante.");
    }
    created = atomicResult?.product || created;
    let confirmationFailure = "";

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const confirmedResult = await wix.productsV3.getProduct(createdProductId, {
        fields:["CURRENCY","MEDIA_ITEMS_INFO","THUMBNAIL"]
      });
      const confirmedProduct = confirmedResult?.product || confirmedResult;
      const confirmedInventory = await getWixInventory();
      const confirmedDetails = productVariantDetails(confirmedProduct, confirmedInventory);
      confirmationFailure = "";

      for (const [size, expected] of expectedBySize) {
        const actual = confirmedDetails.find(variant => variant.size === size);
        if (!actual?.variantId) {
          confirmationFailure = `Wix todavía no devolvió la variante de la talla ${size || "única"}.`;
          break;
        }
        if (actual.sku !== expected.sku) {
          confirmationFailure = `Wix todavía no confirmó el SKU de la talla ${size || "única"}.`;
          break;
        }
        if (trackInventory && !actual.inventoryId) {
          confirmationFailure = `Wix todavía no devolvió el inventario de la talla ${size || "única"}.`;
          break;
        }
        if (trackInventory && Number(actual.quantity) !== expected.quantity) {
          confirmationFailure = `Wix todavía no confirmó la cantidad de la talla ${size || "única"}.`;
          break;
        }
      }

      if (!confirmationFailure) {
        created = confirmedProduct;
        confirmedCreatedVariants = confirmedDetails;
        break;
      }
      if (attempt < 7) await new Promise(resolve => setTimeout(resolve, 750));
    }

    if (!confirmedCreatedVariants.length) {
      throw new Error(confirmationFailure || "Wix no confirmó todos los SKU y cantidades.");
    }
  } catch (error) {
    await wix.productsV3.deleteProduct(createdProductId);
    throw error;
  }

  try {
    await assignProductCategory(createdProductId, category);
    await assignFirstOpenShowcaseSlot(created._id || created.id, category);
  } catch (error) {
    await wix.productsV3.deleteProduct(created._id || created.id);
    throw error;
  }

  return {

    id:
      created._id ||
      created.id,

    name:
      created.name ||
      name,

    slug:
      created.slug ||
      "",

    visible:
      created.visible !==
      false,

    price,

    quantity:confirmedCreatedVariants.reduce((total, variant) => total + Number(variant.quantity || 0), 0),

    variants:confirmedCreatedVariants,

    category,

    categoryName:
      getCategoryName(
        category
      ),

    storeId,

    storeName,

    sizes,

    colors,

    photos:
      [getProductImageUrl(created) || (photoIds[0] ? `https://static.wixstatic.com/media/${photoIds[0]}` : "")].filter(Boolean),

    wixMediaIds:
      photoIds,

    wixProduct:
      created
  };
}

/* ============================================================
   LOGIN
   ============================================================ */

async function handleLogin(
  request,
  response
) {

  if (
    !LOADER_PASSWORD
  ) {

    sendError(
      response,
      503,
      "Store Loader todavía no tiene una contraseña configurada."
    );

    return;
  }

  const body =
    await readBody(
      request
    );

  const password =
    String(
      body.password ||
      ""
    );

  const supplied =
    Buffer.from(
      password
    );

  const ownerExpected = Buffer.from(LOADER_PASSWORD);
  const adminExpected = Buffer.from(PLATFORM_ADMIN_PASSWORD || "");
  const ownerMatches = supplied.length === ownerExpected.length &&
    crypto.timingSafeEqual(supplied, ownerExpected);
  const adminMatches = Boolean(PLATFORM_ADMIN_PASSWORD) &&
    supplied.length === adminExpected.length &&
    crypto.timingSafeEqual(supplied, adminExpected);
  const matches = ownerMatches || adminMatches;

  if (
    !matches
  ) {

    sendError(
      response,
      401,
      "Contraseña incorrecta."
    );

    return;
  }

  const role = adminMatches ? "admin" : "owner";
  const token = createSession(role);

  sendJson(
    response,
    200,
    {

      ok:
        true,

      token,

      profile: {
        role,
        storeId: STORE_ID,
        storeName: STORE_NAME,
        ownerName: STORE_OWNER_NAME,
        commissionPercent: STORE_COMMISSION_PERCENT,
        permissions: role === "admin"
          ? ["products", "inventory", "orders", "payments", "promotions", "platform"]
          : ["products", "inventory", "orders", "commissions", "promotions"]
      },

      expiresIn:
        SESSION_TTL
    }
  );
}

/* ============================================================
   PRODUCT ENDPOINT
   ============================================================ */

async function handleAssistProduct(request, response) {
  if (!isAuthorized(request)) {
    sendError(response, 401, "Inicia sesión en Store Loader.");
    return;
  }
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    sendError(response, 503, "Configura OPENAI_API_KEY en Render para activar esta función.");
    return;
  }
  const body = await readBody(request);
  const kind = body?.kind === "description" ? "description" : "name";
  const photos = (Array.isArray(body?.photos) ? body.photos : [body?.photo])
    .map(photo => String(photo || ""))
    .filter(photo =>
      /^data:image\/(png|jpe?g|webp);base64,/i.test(photo) ||
      /^https:\/\/static\.wixstatic\.com\/media\/[A-Za-z0-9._~-]+/i.test(photo)
    )
    .slice(0, 5);
  if (!photos.length) {
    sendError(response, 400, "Carga una foto válida primero.");
    return;
  }
  const currentName = safeText(body?.currentName, 80);
  const excluded = cleanList(body?.exclude, 5).join(" | ");
  const instruction = kind === "name"
    ? `Analiza todos los ángulos visibles de la prenda en la imagen compuesta. Compárala visualmente con siluetas, cortes y estilos de moda similares que conozcas, sin afirmar una marca o material que no puedas verificar. Crea un nombre comercial original, moderno y fashionable en español para boutique femenina. Devuelve solo el nombre, de 2 a 4 palabras, sin comillas, evita nombres genéricos y no repitas: ${excluded || "ninguno"}.`
    : `Analiza todos los ángulos visibles de la prenda en la imagen compuesta. Escribe una descripción original, corta y contundente en español para boutique femenina. Usa una o dos frases breves y un máximo de 30 palabras en total. Describe solo detalles visibles; no inventes marca ni materiales. Nombre actual: ${currentName || "sin nombre"}. No repitas: ${excluded || "ninguna"}. Devuelve solo la descripción.`;
  const openaiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {"Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json"},
    body: JSON.stringify({
      model: process.env.OPENAI_PRODUCT_MODEL || "gpt-4.1-mini",
      input: [{role:"user", content:[
        {type:"input_text", text:`${instruction}\nVariación creativa: ${Date.now()}`},
        ...photos.map(photo => ({type:"input_image", image_url:photo, detail:"high"}))
      ]}],
      max_output_tokens: 300
    })
  });
  const result = await openaiResponse.json();
  if (!openaiResponse.ok) throw new Error(result?.error?.message || "No pudimos analizar la foto.");
  const responseText = result?.output_text || (Array.isArray(result?.output)
    ? result.output.flatMap(item => Array.isArray(item?.content) ? item.content : []).map(item => item?.text || "").join(" ")
    : "");
  const generated = safeText(responseText, kind === "name" ? 80 : 600);
  const value = kind === "name"
    ? generated
    : (generated.match(/[^.!?]+[.!?]?/g) || [])
        .map(sentence => sentence.trim())
        .filter(Boolean)
        .slice(0, 2)
        .join(" ")
        .split(/\s+/)
        .slice(0, 30)
        .join(" ")
        .replace(/[,;:]$/, "")
        .replace(/([^.!?])$/, "$1.");
  if (!value) throw new Error("No recibimos texto para este producto.");
  sendJson(response, 200, {ok:true, value});
}

async function handleCreateProduct(
  request,
  response
) {

  if (
    !isAuthorized(
      request
    )
  ) {

    sendError(
      response,
      401,
      "Inicia sesión en Store Loader."
    );

    return;
  }

  const body =
    await readBody(
      request
    );

  const product =
    await createWixProduct(
      body
    );

  sendJson(
    response,
    201,
    {

      ok:
        true,

      product
    }
  );
}

function existingVariantSize(variant){
  for(const choice of Array.isArray(variant?.choices) ? variant.choices : []){
    const names = choice?.optionChoiceNames || choice?.choiceNames || choice;
    const optionName = safeText(names?.optionName || names?.name, 50).toLowerCase();
    const choiceName = safeText(names?.choiceName || names?.value, 20).toUpperCase();
    if((optionName === "size" || optionName === "talla") && ["S","M","L","XL"].includes(choiceName)) return choiceName;
  }
  const sku = safeText(variant?.sku, 160).toUpperCase();
  return sku.match(/-(XL|L|M|S)$/)?.[1] || "";
}

function existingSkuPrefix(sku){
  return safeText(sku, 160).toUpperCase().match(/^(PRL|PR|PL|RL|P|R|L)-/)?.[1] || "";
}

function existingSkuTail(sku){
  return safeText(sku, 160).toUpperCase().replace(/^(?:PRL|PR|PL|RL|P|R|L)-/i, "");
}

function productVariantDetails(product, inventory){
  const inventoryByVariant = new Map(
    inventory
      .filter(item => String(item.productId) === String(product?._id || product?.id))
      .map(item => [String(item.variantId), item])
  );
  const productVariants = Array.isArray(product?.variantsInfo?.variants) ? product.variantsInfo.variants : [];
  const hasExplicitSmall = productVariants.some(variant => existingVariantSize(variant) === "S");
  const legacySmall = hasExplicitSmall ? null : productVariants.find(variant => !existingVariantSize(variant));
  return productVariants.map(variant => {
    const variantId = safeText(variant?._id || variant?.id || variant?.variantId, 150);
    const stock = inventoryByVariant.get(variantId);
    return {
      variantId,
      inventoryId:safeText(stock?.id, 150),
      size:existingVariantSize(variant) || (variant === legacySmall ? "S" : ""),
      sku:safeText(variant?.sku, 160).toUpperCase(),
      quantity:Math.max(0, Number(stock?.quantity || 0)),
      enabled:variant?.visible !== false
    };
  });
}

function normalizedProductDetail(product, inventory, showcaseSlot, category){
  const variants = productVariantDetails(product, inventory);
  return {
    id:product?._id || product?.id,
    name:safeText(product?.name, 80),
    description:safeText(String(product?.plainDescription || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " "), 16000),
    visible:product?.visible !== false,
    image:getProductImageUrl(product),
    photos:getProductImageUrls(product),
    cost:Number(product?.variantsInfo?.variants?.[0]?.revenueDetails?.cost?.amount || 0),
    price:Number(product?.variantsInfo?.variants?.[0]?.price?.actualPrice?.amount || 0),
    variants,
    showcaseSlot:Number(showcaseSlot || 0) || null,
    category:safeText(category, 30)
  };
}

async function handleUpdateProduct(request, response, productId) {
  if (!isAuthorized(request)) return sendError(response, 401, "Inicia sesión en Store Loader.");
  if (!wix) return sendError(response, 503, "La tienda todavía no está conectada.");

  const body = await readBody(request);
  if (body?.action === "REGENERATE_PERMANENT_SKU") {
    if (!/^\d{4}$/.test(SKU_4DIGIT_CODE || "")) return sendError(response, 503, "Configura SKU_4DIGIT_CODE en Render con cuatro números.");
    const supplied = Buffer.from(String(body?.adminCode || ""));
    const expected = Buffer.from(SKU_4DIGIT_CODE);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return sendError(response, 403, "Código administrativo incorrecto.");
    const fulfillmentCode = safeText(body?.fulfillmentCode, 10).toUpperCase();
    if (!/^(?:PRL|PR|PL|RL|P|R|L)$/.test(fulfillmentCode)) return sendError(response, 400, "Selecciona los métodos de entrega antes de generar el SKU.");
    const currentResult = await wix.productsV3.getProduct(productId, {fields:["CURRENCY"]});
    const current = currentResult?.product || currentResult;
    if (!current?._id && !current?.id) return sendError(response, 404, "No encontramos el producto.");
    const currentVariants = Array.isArray(current?.variantsInfo?.variants) ? current.variantsInfo.variants : [];
    if (!currentVariants.length) return sendError(response, 400, "Este producto no tiene variantes para actualizar.");
    const styleCode = await nextPermanentStyleCode(true);
    const variants = currentVariants.map((variant, index) => {
      const oldSku = safeText(variant?.sku, 100).toUpperCase();
      const savedSuffix = oldSku.match(/^(?:PRL|PR|PL|RL|P|R|L)-(?:CM\d{4}|[^-]+)-(.+)$/)?.[1];
      const suffix = savedSuffix || (currentVariants.length > 1 ? String(index + 1) : "");
      return {...variant, sku:[fulfillmentCode, styleCode, suffix].filter(Boolean).join("-")};
    });
    await wix.productsV3.updateProduct(productId, {revision:current.revision, options:current.options || [], variantsInfo:{variants}}, {fields:["CURRENCY"]});
    const verifiedResult = await wix.productsV3.getProduct(productId, {fields:["CURRENCY"]});
    const verifiedProduct = verifiedResult?.product || verifiedResult;
    const verifiedSkus = (verifiedProduct?.variantsInfo?.variants || []).map(variant => safeText(variant?.sku, 100).toUpperCase());
    const expectedSkus = variants.map(variant => safeText(variant?.sku, 100).toUpperCase());
    if (expectedSkus.some(sku => !verifiedSkus.includes(sku))) throw new Error("Wix no confirmó el nuevo SKU permanente.");
    sendJson(response, 200, {ok:true, styleCode, skus:verifiedSkus, product:verifiedProduct});
    return;
  }

  const currentResult = await wix.productsV3.getProduct(productId, {
    fields:["PLAIN_DESCRIPTION","MERCHANT_DATA","CURRENCY","MEDIA_ITEMS_INFO","THUMBNAIL"]
  });
  const current = currentResult?.product || currentResult;
  if(!current?._id && !current?.id) return sendError(response, 404, "No encontramos el producto.");

  const name = safeText(body?.name, 80) || safeText(current.name, 80);
  const description = safeText(body?.description, 16000);
  const cost = Math.max(0, Number(body?.cost || 0));
  const currentPrice = Number(current?.variantsInfo?.variants?.[0]?.price?.actualPrice?.amount || 0);
  const price = cost > 0 ? Math.round(cost * 2.816) : Number(body?.price || currentPrice);
  if(!name) return sendError(response, 400, "El producto necesita conservar su nombre.");
  if(!Number.isFinite(price) || price <= 0) return sendError(response, 400, "Agrega un precio válido.");

  const requestedVariants = Array.isArray(body?.variantUpdates)
    ? body.variantUpdates.slice(0, 10).map(item => ({
        size:safeText(item?.size, 10).toUpperCase(),
        variantId:safeText(item?.variantId, 150),
        inventoryId:safeText(item?.inventoryId, 150),
        originalSku:safeText(item?.originalSku, 160).toUpperCase(),
        sku:safeText(item?.sku, 160).toUpperCase(),
        fulfillmentCode:safeText(item?.fulfillmentCode, 10).toUpperCase(),
        quantity:item?.enabled === false ? 0 : Number(item?.quantity),
        enabled:item?.enabled !== false
      }))
    : [];
  if(requestedVariants.length){
    if(requestedVariants.some(item =>
      !["S","M","L","XL"].includes(item.size) ||
      !/^[A-Z0-9]+(?:-[A-Z0-9]+)+$/.test(item.sku) ||
      !/^(?:PRL|PR|PL|RL|P|R|L)$/.test(item.fulfillmentCode) ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 0 ||
      item.quantity > 100000
    )) return sendError(response, 400, "Revisa la talla, entrega y cantidad de cada variante.");
    if(new Set(requestedVariants.map(item => item.size)).size !== requestedVariants.length){
      return sendError(response, 400, "Cada talla debe aparecer una sola vez.");
    }
    if(new Set(requestedVariants.map(item => item.sku)).size !== requestedVariants.length){
      return sendError(response, 400, "Cada variante necesita un SKU permanente único.");
    }
    if(["S","M","L","XL"].some(size => !requestedVariants.some(item => item.size === size))){
      return sendError(response, 400, "Las tallas S, M, L y XL deben guardarse juntas.");
    }
  }

  const currentVariants = Array.isArray(current?.variantsInfo?.variants) ? current.variantsInfo.variants : [];
  if(!currentVariants.length) return sendError(response, 400, "Este producto no tiene una variante base en Wix.");
  const currentInventory = await getWixInventory();
  let variants = currentVariants;
  let options = current.options || [];

  if(requestedVariants.length){
    const currentById = new Map(currentVariants.map(variant => [safeText(variant?._id || variant?.id || variant?.variantId, 150), variant]));
    const inventoryByVariant = new Map(
      currentInventory
        .filter(item => String(item.productId) === String(productId))
        .map(item => [String(item.variantId), item])
    );
    const currentBySize = new Map(currentVariants.map(variant => [existingVariantSize(variant), variant]).filter(([size]) => size));
    const defaultVariant = currentVariants.find(variant => !existingVariantSize(variant));
    const firstWithSku = currentVariants.find(variant => variant?.sku);
    const firstSku = safeText(firstWithSku?.sku, 160).toUpperCase();
    let familyTail = existingSkuTail(firstSku);
    const firstSize = existingVariantSize(firstWithSku);
    if(firstSize && familyTail.endsWith(`-${firstSize}`)) familyTail = familyTail.slice(0, -(firstSize.length + 1));
    if(!familyTail) throw new Error("No pudimos preservar el código permanente de este producto.");

    const usedIds = new Set();
    variants = requestedVariants.map(requested => {
      let existing = requested.variantId ? currentById.get(requested.variantId) : currentBySize.get(requested.size);
      const defaultId = safeText(defaultVariant?._id || defaultVariant?.id || defaultVariant?.variantId, 150);
      if(!existing && requested.size === "S" && defaultVariant && !usedIds.has(defaultId)) existing = defaultVariant;
      const existingId = safeText(existing?._id || existing?.id || existing?.variantId, 150);
      if(existingId) usedIds.add(existingId);
      const currentSku = safeText(existing?.sku, 160).toUpperCase();
      if(existing && requested.originalSku && currentSku !== requested.originalSku){
        throw new Error("Una variante cambió en Wix. Vuelve a abrir el producto antes de guardar.");
      }
      const tail = existingSkuTail(currentSku);
      const expectedSku = existing
        ? `${requested.fulfillmentCode}-${tail}`
        : `${requested.fulfillmentCode}-${familyTail}-${requested.size}`;
      if(requested.sku !== expectedSku){
        throw new Error(`El SKU permanente de la talla ${requested.size} cambió. Vuelve a abrir el producto antes de guardar.`);
      }
      const sku = requested.sku;
      const source = existing || currentVariants[0];
      const inventoryItem = existingId ? inventoryByVariant.get(existingId) : null;
      if(existing && !inventoryItem){
        throw new Error(`Wix no devolvió el inventario permanente de la talla ${requested.size}.`);
      }
      if(existing && requested.inventoryId && String(inventoryItem.id) !== String(requested.inventoryId)){
        throw new Error(`El inventario permanente de la talla ${requested.size} cambió. Vuelve a abrir el producto antes de guardar.`);
      }
      const next = {
        ...source,
        sku,
        visible:requested.enabled,
        choices:buildVariantChoices({size:requested.size,color:""}),
        price:{...(source?.price || {}),actualPrice:{amount:String(Math.round(price))}},
        revenueDetails:cost > 0 ? {...(source?.revenueDetails || {}),cost:{amount:String(cost)}} : source?.revenueDetails,
        inventoryItem:inventoryItem
          ? {
              _id:inventoryItem.id,
              revision:inventoryItem.revision,
              quantity:requested.enabled ? requested.quantity : 0
            }
          : {quantity:requested.enabled ? requested.quantity : 0}
      };
      if(!existing){
        delete next._id;
        delete next.id;
        delete next.variantId;
        delete next.revision;
        delete next.inventory;
      }
      return next;
    });
    if(new Set(variants.map(variant => safeText(variant.sku, 160).toUpperCase())).size !== variants.length){
      throw new Error("Cada variante necesita un SKU permanente único.");
    }
    const requestedSizes = requestedVariants.map(item => item.size);
    options = buildOptions(requestedSizes, []);
  }

  const update = {
    revision:current.revision,
    name,
    plainDescription:description ? `<p>${escapeHtml(description)}</p>` : "<p></p>",
    visible:body?.visible !== false
  };
  if(requestedVariants.length){
    update.options = options;
    update.variantsInfo = {variants};
  }else if(currentVariants.length){
    update.options = current.options || [];
    update.variantsInfo = {
      variants:currentVariants.map(variant => ({
        ...variant,
        price:{...(variant.price || {}),actualPrice:{amount:String(Math.round(price))}},
        revenueDetails:cost > 0 ? {...(variant.revenueDetails || {}),cost:{amount:String(cost)}} : variant.revenueDetails
      }))
    };
  }

  if(Array.isArray(body?.photos)){
    const photoIds = [];
    const seenPhotoIds = new Set();
    for(const [index, photo] of body.photos.filter(Boolean).slice(0, 5).entries()){
      const value = String(photo || "");
      const existingId = wixMediaId(value);
      const photoId = existingId || await uploadImage(value, index);
      if(photoId && !seenPhotoIds.has(photoId)){
        seenPhotoIds.add(photoId);
        photoIds.push(photoId);
      }
    }
    update.media = photoIds.length
      ? {itemsInfo:{items:photoIds.map(id => ({id}))}}
      : {itemsInfo:{items:[]}};
  }

  if(requestedVariants.length){
    const saveResult = await wix.productsV3.updateProductWithInventory(productId, update, {
      returnEntity:true,
      fields:["PLAIN_DESCRIPTION","MERCHANT_DATA","CURRENCY","MEDIA_ITEMS_INFO","THUMBNAIL"]
    });
    const saveFailures = Array.isArray(saveResult?.inventoryResults?.results)
      ? saveResult.inventoryResults.results.filter(item => item?.itemMetadata?.success === false)
      : [];
    if(
      saveFailures.length ||
      Number(saveResult?.inventoryResults?.bulkActionMetadata?.totalFailures || 0) > 0 ||
      saveResult?.inventoryResults?.error
    ){
      throw new Error("Wix rechazó el SKU o la cantidad de una variante.");
    }
  }else{
    await wix.productsV3.updateProduct(productId, update, {
      fields:["PLAIN_DESCRIPTION","MERCHANT_DATA","CURRENCY","MEDIA_ITEMS_INFO","THUMBNAIL"]
    });
  }

  if(body?.category) await assignProductCategory(productId, safeText(body.category, 30));
  if(body?.showcaseSlot) await applyShowcasePosition(productId, safeText(body.category, 30), Number(body.showcaseSlot));

  let confirmedProduct;
  let confirmedInventory;
  let variantsConfirmed = !requestedVariants.length;
  let confirmationFailure = "";

  for(let attempt = 0; attempt < 8; attempt += 1){
    const confirmedResult = await wix.productsV3.getProduct(productId, {
      fields:["PLAIN_DESCRIPTION","MERCHANT_DATA","CURRENCY","MEDIA_ITEMS_INFO","THUMBNAIL"]
    });
    confirmedProduct = confirmedResult?.product || confirmedResult;
    confirmedInventory = await getWixInventory();
    if(!requestedVariants.length) break;

    const details = productVariantDetails(confirmedProduct, confirmedInventory);
    confirmationFailure = "";
    let needsAnotherRead = false;

    for(const expected of requestedVariants){
      const actual = details.find(item => item.size === expected.size);
      if(!actual){
        confirmationFailure = `Wix todavía no devolvió la talla ${expected.size}.`;
        needsAnotherRead = true;
        continue;
      }
      if(actual.sku !== expected.sku){
        confirmationFailure = `Wix todavía no confirmó el SKU de la talla ${expected.size}.`;
        needsAnotherRead = true;
      }
      if(actual.enabled !== expected.enabled){
        confirmationFailure = `Wix todavía no devolvió el estado de la talla ${expected.size}.`;
        needsAnotherRead = true;
      }
      if(!actual.inventoryId){
        confirmationFailure = `Wix todavía no devolvió el inventario de la talla ${expected.size}.`;
        needsAnotherRead = true;
        continue;
      }
      if(expected.inventoryId && String(actual.inventoryId) !== String(expected.inventoryId)){
        confirmationFailure = `Wix cambió el inventario permanente de la talla ${expected.size}.`;
        needsAnotherRead = true;
        continue;
      }
      if(Number(actual.quantity) !== expected.quantity){
        confirmationFailure = `Wix todavía no confirmó la cantidad de la talla ${expected.size}.`;
        needsAnotherRead = true;
      }
    }

    if(!needsAnotherRead){
      variantsConfirmed = true;
      break;
    }
    if(attempt < 7) await new Promise(resolve => setTimeout(resolve, 750));
  }

  if(requestedVariants.length && !variantsConfirmed){
    throw new Error(confirmationFailure || "Wix no confirmó todas las tallas, cantidades y métodos de entrega.");
  }

  const [showcases, categoryRoutes] = await Promise.all([
    getCategoryShowcases().catch(() => ({})),
    getCategoryRoutes().catch(() => ({}))
  ]);
  const confirmedCategory = safeText(categoryRoutes[String(productId)], 30);
  const confirmedShowcase = (showcases[confirmedCategory] || [])
    .find(item => String(item.id) === String(productId));
  sendJson(response, 200, {
    ok:true,
    product:normalizedProductDetail(confirmedProduct, confirmedInventory, confirmedShowcase?.showcaseSlot, confirmedCategory)
  });
}

async function handleNextPermanentSku(request, response) {
  if (!isAuthorized(request)) return sendError(response, 401, "Inicia sesión en Store Loader.");
  if (!wix) return sendError(response, 503, "La tienda todavía no está conectada.");
  sendJson(response, 200, {ok:true, styleCode: await nextPermanentStyleCode()});
}

async function handleGetProduct(request, response, productId) {
  if (!isAuthorized(request)) return sendError(response, 401, "Inicia sesión en Store Loader.");
  if (!wix) return sendError(response, 503, "La tienda todavía no está conectada.");
  const result = await wix.productsV3.getProduct(productId, {
    fields:["PLAIN_DESCRIPTION","MERCHANT_DATA","CURRENCY","MEDIA_ITEMS_INFO","THUMBNAIL"]
  });
  const product = result?.product || result;
  if(!product?._id && !product?.id) return sendError(response, 404, "No encontramos el producto.");
  const [inventory, showcases, categoryRoutes] = await Promise.all([
    getWixInventory(),
    getCategoryShowcases().catch(() => ({})),
    getCategoryRoutes().catch(() => ({}))
  ]);
  const category = safeText(categoryRoutes[String(productId)], 30);
  const showcase = (showcases[category] || [])
    .find(item => String(item.id) === String(productId));
  sendJson(response, 200, {
    ok:true,
    product:normalizedProductDetail(product, inventory, showcase?.showcaseSlot, category)
  });
}

async function applyShowcasePosition(productId, category, targetSlot) {
  const limit = showcaseLimit(category);
  if (!Number.isInteger(targetSlot) || targetSlot < 1 || targetSlot > limit) {
    throw new Error(`Selecciona una posición entre 1 y ${limit}.`);
  }
  const routes = await getCategoryRoutes();
  if (routes[String(productId)] !== category) await assignProductCategory(productId, category);
  const {category: wixCategory, orderedIds} = await categoryArrangement(category);
  const id = String(productId);
  const currentIndex = orderedIds.indexOf(id);
  if (currentIndex < 0) throw new Error("El producto no pertenece a esa categoría de vitrina.");
  const targetIndex = targetSlot - 1;
  const occupantId = orderedIds[targetIndex] || null;
  if (occupantId) [orderedIds[currentIndex], orderedIds[targetIndex]] = [orderedIds[targetIndex], orderedIds[currentIndex]];
  else {
    orderedIds.splice(currentIndex, 1);
    orderedIds.splice(targetIndex, 0, id);
  }
  await saveCategoryArrangement(wixCategory.id, orderedIds);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const confirmed = await categoryArrangement(category);
    const orderConfirmed = confirmed.orderedIds.length === orderedIds.length &&
      orderedIds.every((productId, index) => confirmed.orderedIds[index] === productId);
    if (orderConfirmed) {
      return {
        from:currentIndex + 1,
        to:confirmed.orderedIds.indexOf(id) + 1,
        swappedProductId:occupantId,
        category,
        orderedProductIds:confirmed.orderedIds.slice(0, limit)
      };
    }
    if (attempt < 7) await new Promise(resolve => setTimeout(resolve, 750));
  }
  throw new Error("Wix no confirmó el nuevo orden de la vitrina.");
}

async function handleShowcasePosition(request, response, productId) {
  if (!isAuthorized(request)) return sendError(response, 401, "Inicia sesión en Store Loader.");
  if (!wix) return sendError(response, 503, "La tienda todavía no está conectada.");
  const body = await readBody(request);
  const result = await applyShowcasePosition(productId, safeText(body?.category, 30), Number(body?.targetSlot));
  sendJson(response, 200, {ok:true, ...result});
}

async function handleDeleteProduct(request, response, productId) {
  if (!isAuthorized(request)) return sendError(response, 401, "Inicia sesión en Store Loader.");
  if (!wix) return sendError(response, 503, "La tienda todavía no está conectada.");

  await wix.productsV3.deleteProduct(productId);
  categoryRouteCache.expiresAt = 0;
  sendJson(response, 200, { ok: true, productId });
}

async function handleBulkDeleteProducts(request, response) {
  if (!isAuthorized(request)) return sendError(response, 401, "Inicia sesión en Store Loader.");
  if (!wix) return sendError(response, 503, "La tienda todavía no está conectada.");

  const body = await readBody(request);
  const productIds = [...new Set(
    (Array.isArray(body?.productIds) ? body.productIds : [])
      .map(productId => safeText(productId, 36))
      .filter(Boolean)
  )].slice(0, 100);

  if (!productIds.length) return sendError(response, 400, "Selecciona al menos un producto.");

  // Delete each catalog product through the same confirmed Wix operation used
  // by the per-row action. Wix bulk jobs can be accepted before their items
  // are actually removed, which left stale cards in Store Loader.
  const results = await Promise.allSettled(
    productIds.map(productId => wix.productsV3.deleteProduct(productId))
  );
  const deletedProductIds = [];
  const failed = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") deletedProductIds.push(productIds[index]);
    else failed.push({
      productId: productIds[index],
      message: result.reason?.message || "Wix rechazó la eliminación."
    });
  });

  categoryRouteCache.expiresAt = 0;
  sendJson(response, failed.length ? 207 : 200, {
    ok: failed.length === 0,
    productIds: deletedProductIds,
    deletedCount: deletedProductIds.length,
    failed
  });
}

/* ============================================================
   REAL WIX ORDERS
   ============================================================ */

function getContactDetails(
  order
) {

  return (
    order
      ?.billingInfo
      ?.contactDetails ||

    order
      ?.shippingInfo
      ?.logistics
      ?.shippingDestination
      ?.contactDetails ||

    {}
  );
}

function getOrderCustomerName(
  order
) {

  const contact =
    getContactDetails(
      order
    );

  const directName =
    safeText(
      contact.fullName,
      200
    );

  if (
    directName
  ) {

    return directName;
  }

  const combined =
    [
      safeText(
        contact.firstName,
        100
      ),

      safeText(
        contact.lastName,
        100
      )
    ]
      .filter(Boolean)
      .join(" ");

  if (
    combined
  ) {

    return combined;
  }

  return (
    safeText(
      order
        ?.buyerInfo
        ?.email,
      250
    ) ||
    "Cliente"
  );
}

function getLineItemName(
  item
) {

  return (
    safeText(
      item
        ?.productName
        ?.translated,
      300
    ) ||

    safeText(
      item
        ?.productName
        ?.original,
      300
    ) ||

    safeText(
      item
        ?.productName,
      300
    ) ||

    "Producto"
  );
}

function getOrderLineDescription(item, label) {
  const target = safeText(label, 50).toLowerCase();
  for (const line of Array.isArray(item?.descriptionLines) ? item.descriptionLines : []) {
    const name = safeText(
      line?.name?.translated || line?.name?.original || line?.name,
      100
    ).toLowerCase();
    if (name !== target) continue;
    return safeText(
      line?.plainText?.translated ||
      line?.plainText?.original ||
      line?.plainText ||
      line?.colorInfo?.translated ||
      line?.colorInfo?.original,
      300
    );
  }
  return "";
}

function getOrderLineItemImage(item) {
  const rawImage = typeof item?.image === "string" ? item.image : "";
  const raw = safeText(
    item?.image?.url ||
    item?.image?.id ||
    rawImage ||
    item?.media?.url ||
    item?.media?.id,
    1500
  );
  if (!raw) return "";
  const mediaId = wixMediaId(raw);
  return mediaId ? `https://static.wixstatic.com/media/${mediaId}` : raw;
}

function normalizeWixOrderLineItem(item) {
  return {
    id: safeText(item?._id || item?.id, 150),
    name: getLineItemName(item),
    image: getOrderLineItemImage(item),
    sku: safeText(
      item?.physicalProperties?.sku || getOrderLineDescription(item, "SKU"),
      100
    ).toUpperCase(),
    size: getOrderLineDescription(item, "Talla"),
    color: getOrderLineDescription(item, "Color"),
    delivery: getOrderLineDescription(item, "Entrega"),
    quantity: Math.max(1, Number(item?.quantity || 1)),
    productId: safeText(item?.catalogReference?.catalogItemId, 100),
    variantId: safeText(item?.catalogReference?.options?.variantId, 100)
  };
}

function getOrderProductsText(
  order
) {

  const lineItems =
    Array.isArray(
      order?.lineItems
    )
      ? order.lineItems
      : [];

  return lineItems
    .map(
      item => {

        const quantity =
          Math.max(
            1,
            Number(
              item?.quantity ||
              1
            )
          );

        return (
          `${quantity} × ${getLineItemName(item)}`
        );
      }
    )
    .join(", ");
}

function getOrderShippingAddress(order) {
  const address =
    order?.shippingInfo?.logistics?.shippingDestination?.address ||
    order?.billingInfo?.address ||
    {};
  return {
    addressLine1: safeText(address?.addressLine1 || address?.addressLine, 300),
    addressLine2: safeText(address?.addressLine2, 300),
    city: safeText(address?.city, 150),
    state: safeText(address?.subdivision || address?.state, 150),
    postalCode: safeText(address?.postalCode, 50),
    country: safeText(address?.country, 10)
  };
}

function getOrderTotal(
  order
) {

  const amount =
    order
      ?.priceSummary
      ?.total
      ?.amount;

  const value =
    Number(
      amount ||
      0
    );

  return Number.isFinite(
    value
  )
    ? value
    : 0;
}

function getLocalOrderStatus(
  order
) {

  const fulfillmentStatus =
    String(
      order
        ?.fulfillmentStatus ||
      ""
    )
      .toUpperCase();

  const paymentStatus =
    String(
      order
        ?.paymentStatus ||
      ""
    )
      .toUpperCase();

  if (
    fulfillmentStatus ===
    "FULFILLED"
  ) {

    return "delivered";
  }

  if (
    fulfillmentStatus ===
    "PARTIALLY_FULFILLED"
  ) {

    return "shipped";
  }

  if (
    paymentStatus ===
    "PAID" ||
    paymentStatus ===
    "PARTIALLY_PAID"
  ) {

    return "processing";
  }

  return "new";
}

function getFirstTrackingInfo(
  order
) {

  const fulfillments =
    Array.isArray(
      order?.fulfillments
    )
      ? order.fulfillments
      : [];

  for (
    const fulfillment
    of fulfillments
  ) {

    const trackingInfo =
      fulfillment
        ?.trackingInfo;

    if (
      trackingInfo
    ) {

      return trackingInfo;
    }
  }

  return {};
}

function orderLineId(line) {
  return safeText(line?._id || line?.id, 100);
}

function fulfillmentLineIds(fulfillment) {
  return new Set(
    (Array.isArray(fulfillment?.lineItems) ? fulfillment.lineItems : [])
      .map(orderLineId)
      .filter(Boolean)
  );
}

function normalizedNationalOrderShipments(order) {
  const groups = groupWixOrderNationalLines(order);
  const fulfillments = Array.isArray(order?.fulfillments) ? order.fulfillments : [];
  return ["R", "L"]
    .filter(type => groups[type].length)
    .map(type => {
      const lineIds = new Set(groups[type].map(orderLineId).filter(Boolean));
      const fulfillment = fulfillments.find(candidate => {
        const candidateIds = fulfillmentLineIds(candidate);
        return [...lineIds].some(id => candidateIds.has(id));
      });
      const trackingInfo = fulfillment?.trackingInfo || {};
      const trackingNumber = safeText(trackingInfo?.trackingNumber, 300);
      const definition = nationalShipmentDefinition(type);
      return {
        type,
        label: definition?.label || type,
        estimate: definition?.estimate || "",
        itemCount: groups[type].reduce(
          (total, line) => total + Math.max(1, Math.floor(Number(line?.quantity || 1))),
          0
        ),
        products: groups[type].map(getLineItemName).join(", "),
        status: fulfillment?.completed
          ? "delivered"
          : trackingNumber
            ? (enviaShipmentStatuses.get(trackingNumber)?.status || "shipped")
            : type === "R"
              ? "ready"
              : "processing",
        statusLabel: trackingNumber
          ? customerEnviaTrackingLabel(
              fulfillment?.completed
                ? "delivered"
                : (enviaShipmentStatuses.get(trackingNumber)?.status || "shipped")
            )
          : "",
        carrier: safeText(trackingInfo?.shippingProvider, 200),
        trackingNumber,
        trackingLink: safeText(trackingInfo?.trackingLink, 500),
        fulfillmentId: safeText(fulfillment?._id || fulfillment?.fulfillmentId, 100)
      };
    });
}

function normalizeWixOrder(
  order
) {

  const trackingInfo =
    getFirstTrackingInfo(
      order
    );

  const paymentStatus = safeText(order?.paymentStatus, 100).toUpperCase();
  const commissionEligible = ["PAID", "PARTIALLY_PAID"].includes(paymentStatus);
  const total = getOrderTotal(order);

  return {

    id:
      safeText(
        order?._id ||
        order?.id,
        150
      ),

    number:
      safeText(
        order?.number,
        100
      ),

    date:
      safeText(
        order?._createdDate ||
        order?.createdDate,
        100
      ),

    customer:
      getOrderCustomerName(
        order
      ),

    email:
      safeText(
        order
          ?.buyerInfo
          ?.email,
        250
      ),

    phone:
      safeText(
        getContactDetails(order)?.phone,
        80
      ),

    shippingAddress:
      getOrderShippingAddress(order),

    items:
      (Array.isArray(order?.lineItems) ? order.lineItems : [])
        .map(normalizeWixOrderLineItem),

    products:
      getOrderProductsText(
        order
      ),

    total,

    storeId: STORE_ID,

    commissionPercent: STORE_COMMISSION_PERCENT,

    commissionAmount: commissionEligible
      ? Math.round(total * STORE_COMMISSION_PERCENT) / 100
      : 0,

    commissionStatus: commissionEligible ? "earned" : "pending",

    status:
      getLocalOrderStatus(
        order
      ),

    paymentStatus,

    paymentMethod:
      isNequiOrder(order)
        ? "nequi"
        : "card",

    nequiReference:
      isNequiOrder(order)
        ? getNequiReference(order)
        : "",

    canConfirmPayment:
      isNequiOrder(order) &&
      !["PAID", "PARTIALLY_PAID"].includes(String(order?.paymentStatus || "").toUpperCase()),

    delivery:
      safeText(order?.shippingInfo?.title, 250),

    nationalShipments:
      normalizedNationalOrderShipments(order),

    fulfillmentStatus:
      safeText(
        order
          ?.fulfillmentStatus,
        100
      ),

    carrier:
      safeText(
        trackingInfo
          ?.shippingProvider,
        200
      ),

    trackingNumber:
      safeText(
        trackingInfo
          ?.trackingNumber,
        300
      ),

    trackingLink:
      safeText(
        trackingInfo
          ?.trackingLink,
        500
      )
  };
}

async function getWixOrders() {

  if (
    !wix
  ) {

    throw new Error(
      "El servidor todavía no está conectado a Wix."
    );
  }

  const search = {

    sort: [
      {
        fieldName:
          "createdDate",

        order:
          "DESC"
      }
    ],

    cursorPaging: {

      limit:
        50
    }
  };

  const result =
    await wix
      .orders
      .searchOrders(
        search
      );

  const orderList =
    Array.isArray(
      result?.orders
    )
      ? result.orders
      : [];

  return orderList
    .map(
      normalizeWixOrder
    )
    .filter(
      order =>
        order.id
    );
}

async function getWixOrdersForAnalytics() {
  if (!wix) {
    throw new Error("El servidor todavía no está conectado a Wix.");
  }

  const orders = [];
  let cursor = undefined;

  do {
    const result = await wix.orders.searchOrders({
      sort: [{ fieldName: "createdDate", order: "DESC" }],
      cursorPaging: {
        limit: 100,
        ...(cursor ? { cursor } : {})
      }
    });

    orders.push(...(Array.isArray(result?.orders) ? result.orders : []));
    cursor = safeText(result?.pagingMetadata?.cursors?.next, 500) || undefined;
  } while (cursor && orders.length < 500);

  const normalized = orders
    .slice(0, 500)
    .map(normalizeWixOrder)
    .filter(order => order.id);

  const productIds = [...new Set(
    normalized.flatMap(order => order.items || []).map(item => item.productId).filter(Boolean)
  )];
  const productCosts = new Map();
  for (let index = 0; index < productIds.length; index += 10) {
    const batch = await Promise.all(productIds.slice(index, index + 10).map(async productId => {
      const result = await wix.productsV3.getProduct(productId, { fields: ["CURRENCY"] }).catch(() => null);
      const product = result?.product || result;
      const variants = Array.isArray(product?.variantsInfo?.variants) ? product.variantsInfo.variants : [];
      return [productId, variants];
    }));
    batch.forEach(([productId, variants]) => {
      productCosts.set(productId, new Map(variants.map(variant => [
        safeText(variant?._id || variant?.id || variant?.variantId, 150),
        Math.max(0, Number(variant?.revenueDetails?.cost?.amount || 0))
      ])));
    });
  }

  return normalized.map(order => ({
    ...order,
    items: (order.items || []).map(item => {
      const costs = productCosts.get(item.productId);
      return {
        ...item,
        cost: Number(costs?.get(item.variantId) || [...(costs?.values() || [])][0] || 0)
      };
    })
  }));
}

function normalizeStripeAuthorization(intent, lines = stripeIntentLines(intent)) {
  const deliveryMethod = safeText(intent?.metadata?.deliveryMethod, 20) || "pickup";
  return {
    id: intent.id,
    number: `AUT-${intent.id.slice(-10).toUpperCase()}`,
    date: new Date(Number(intent.created || 0) * 1000).toISOString(),
    customer: safeText(intent?.metadata?.customerName, 160) || "Cliente CajaModa",
    email: safeText(intent?.metadata?.customerEmail, 250),
    phone: safeText(intent?.metadata?.customerPhone, 80),
    shippingAddress: {
      addressLine1: safeText(intent?.metadata?.deliveryAddress, 300),
      addressLine2: "",
      city: safeText(intent?.metadata?.deliveryCity, 150),
      state: safeText(intent?.metadata?.deliveryState, 150),
      postalCode: safeText(intent?.metadata?.deliveryPostalCode, 50),
      country: "CO"
    },
    items: lines.map(line => ({
      id: `${line.productId}:${line.variantId}`,
      name: line.name,
      image: safeText(line.image, 1500),
      sku: safeText(line.sku, 100).toUpperCase(),
      size: safeText(line.size, 50),
      color: safeText(line.color, 100),
      delivery: selectedDeliveryLabel(line.selectedDeliveryMode),
      quantity: line.quantity,
      productId: line.productId,
      variantId: line.variantId
    })),
    products: lines.map(line => `${line.quantity} × ${line.name}`).join(", "),
    total: Number(intent.amount || 0) / 100,
    status: "authorized",
    paymentStatus: "AUTHORIZED",
    paymentMethod: "card",
    source: "stripeAuthorization",
    canCapturePayment: intent.status === "requires_capture",
    canCancelPayment: intent.status === "requires_capture",
    delivery: safeText(intent?.metadata?.deliverySummary, 300)
      ? `Stripe – ${safeText(intent.metadata.deliverySummary, 300)}`
      : deliveryMethod === "pickup"
        ? "Stripe – Pronto – Recoger"
        : deliveryMethod === "national"
          ? "Stripe – Rápido Nacional – Envío nacional 4–7 días"
          : "Stripe – Pronto – Moto"
  };
}

function isCajaModaStripeIntent(intent) {
  return ["cajamoda-checkout-elements", "cajamoda-custom-card"].includes(
    safeText(intent?.metadata?.source, 80)
  );
}

async function getStripeAuthorizations() {
  if (!stripe) return [];
  const [intentResult, sessionResult] = await Promise.all([
    stripe.paymentIntents.list({ limit: 100 }),
    stripe.checkout.sessions.list({ status: "complete", limit: 100 })
  ]);
  const pendingById = new Map(
    intentResult.data
      .filter(intent => intent.status === "requires_capture")
      .map(intent => [intent.id, intent])
  );
  const authorizations = intentResult.data
    .filter(intent => intent.status === "requires_capture" && isCajaModaStripeIntent(intent))
    .map(normalizeStripeAuthorization);
  const included = new Set(authorizations.map(order => order.id));

  for (const session of sessionResult.data) {
    const intentId = typeof session?.payment_intent === "string"
      ? session.payment_intent
      : session?.payment_intent?.id;
    const intent = pendingById.get(intentId);
    if (
      !intent ||
      included.has(intent.id) ||
      safeText(session?.metadata?.source, 80) !== "cajamoda-storefront"
    ) continue;
    const lines = await getStripePurchasedLines(session);
    const customer = session?.customer_details || {};
    authorizations.push(normalizeStripeAuthorization({
      ...intent,
      metadata: {
        ...intent.metadata,
        ...session.metadata,
        customerName: safeText(session?.metadata?.customerName || customer?.name, 160),
        customerPhone: safeText(session?.metadata?.customerPhone || customer?.phone, 80),
        customerEmail: safeText(customer?.email || session?.customer_email, 250)
      }
    }, lines));
    included.add(intent.id);
  }
  return authorizations;
}

async function handleCaptureStripeAuthorization(request, response, intentId) {
  if (!isAuthorized(request)) return sendError(response, 401, "Inicia sesión en Store Loader.");
  if (!isPlatformAdmin(request)) return sendError(response, 403, "Esta acción está reservada para administración de CajaModa.");
  if (!stripe) return sendError(response, 503, "Stripe todavía no está configurado.");
  if (!/^pi_[A-Za-z0-9]+$/.test(intentId)) return sendError(response, 400, "La autorización no es válida.");

  let intent = await stripe.paymentIntents.retrieve(intentId);
  const checkoutSession = await findCajaModaCheckoutSession(intent.id);
  if (!isCajaModaStripeIntent(intent) && !checkoutSession) {
    return sendError(response, 403, "La autorización no pertenece a CajaModa.");
  }
  if (intent.status === "requires_capture") intent = await stripe.paymentIntents.capture(intent.id);
  if (intent.status !== "succeeded") return sendError(response, 409, "Stripe no pudo capturar esta autorización.");

  if (checkoutSession) {
    const latestSession = await stripe.checkout.sessions.retrieve(checkoutSession.id);
    await syncCompletedStripeSession(latestSession);
  } else {
    await syncSucceededStripeIntent(intent);
  }
  sendJson(response, 200, { ok: true, status: intent.status });
}

async function handleCancelStripeAuthorization(request, response, intentId) {
  if (!isAuthorized(request)) return sendError(response, 401, "Inicia sesión en Store Loader.");
  if (!isPlatformAdmin(request)) return sendError(response, 403, "Esta acción está reservada para administración de CajaModa.");
  if (!stripe) return sendError(response, 503, "Stripe todavía no está configurado.");
  if (!/^pi_[A-Za-z0-9]+$/.test(intentId)) return sendError(response, 400, "La autorización no es válida.");

  const intent = await stripe.paymentIntents.retrieve(intentId);
  const checkoutSession = await findCajaModaCheckoutSession(intent.id);
  if (!isCajaModaStripeIntent(intent) && !checkoutSession) {
    return sendError(response, 403, "La autorización no pertenece a CajaModa.");
  }
  if (intent.status === "canceled") return sendJson(response, 200, { ok: true, status: intent.status });
  if (intent.status !== "requires_capture") return sendError(response, 409, "Esta autorización ya no se puede cancelar.");

  const canceled = await stripe.paymentIntents.cancel(intent.id, {
    cancellation_reason: "requested_by_customer"
  });
  sendJson(response, 200, { ok: true, status: canceled.status });
}

async function handleGetOrders(
  request,
  response
) {

  if (
    !isAuthorized(
      request
    )
  ) {

    sendError(
      response,
      401,
      "Inicia sesión en Store Loader."
    );

    return;
  }

  const session = getAuthorizedSession(request);
  await syncPendingStripeCheckoutSessions();
  const [orderList, stripeAuthorizations] = await Promise.all([
    getWixOrders(),
    getStripeAuthorizations()
  ]);

  sendJson(
    response,
    200,
    {

      ok:
        true,

      orders: [...stripeAuthorizations, ...orderList]
        .sort((left, right) => new Date(right.date) - new Date(left.date))
        .map(order => ({
          ...order,
          canConfirmPayment: order.canConfirmPayment,
          canCapturePayment: session.role === "admin" && order.canCapturePayment,
          canCancelPayment: session.role === "admin" && order.canCancelPayment
        }))
    }
  );
}

async function handleAnalyticsEvents(request, response) {
  try {
    const body = await readBody(request);
    const result = await analytics.ingestClientEvents(request, body?.events);
    sendJson(response, 202, { ok: true, ...result });
  } catch (error) {
    console.error("[Analytics] Event ingestion failed:", error);
    sendError(
      response,
      Number(error?.statusCode || 500),
      Number(error?.statusCode || 500) >= 500
        ? "Analytics storage is temporarily unavailable."
        : safeText(error?.message, 250) || "The analytics event was rejected."
    );
  }
}

async function handleStoreOwnerAnalytics(request, response, url) {
  if (!isAuthorized(request)) {
    return sendError(response, 401, "Sign in to Store Loader.");
  }
  if (!isPlatformAdmin(request)) {
    return sendError(response, 403, "Analytics is reserved for CajaModa administration.");
  }

  const days = Number(url.searchParams.get("days") || 30);
  const month = safeText(url.searchParams.get("month"), 20);
  try {
    const result = await analytics.dashboard(days, month);
    sendJson(response, 200, result);
  } catch (error) {
    console.error("[Analytics] Dashboard load failed:", error);
    sendError(response, 503, "Wix Data permission is required for Network Management.");
  }
}

async function handleStoreOwnerAnalyticsSettings(request, response) {
  if (!isAuthorized(request)) {
    return sendError(response, 401, "Sign in to Store Loader.");
  }
  if (!isPlatformAdmin(request)) {
    return sendError(response, 403, "Analytics settings are reserved for CajaModa administration.");
  }

  const body = await readBody(request);
  const settings = await analytics.saveSettings(body || {});
  sendJson(response, 200, { ok: true, settings });
}

async function handleStoreChat(request, response) {
  const session = getAuthorizedSession(request);
  if (!session) return sendError(response, 401, "Sign in to Store Loader.");
  const result = request.method === "POST"
    ? await analytics.sendChatMessage(session.role, (await readBody(request))?.message)
    : await analytics.chat(session.role);
  sendJson(response, 200, { ok: true, ...result });
}

async function handleStoreOwnerProfile(request, response) {
  const session = getAuthorizedSession(request);
  if (!session) return sendError(response, 401, "Inicia sesión en Store Loader.");
  sendJson(response, 200, {
    ok: true,
    profile: {
      role: session.role,
      storeId: session.storeId,
      storeName: STORE_NAME,
      ownerName: STORE_OWNER_NAME,
      commissionPercent: STORE_COMMISSION_PERCENT,
      entryPath: "/startup/"
    }
  });
}

async function handleStoreOwnerSummary(request, response) {
  const session = getAuthorizedSession(request);
  if (!session) return sendError(response, 401, "Inicia sesión en Store Loader.");
  const [orders, inventory] = await Promise.all([getWixOrders(), getWixInventory()]);
  const paidOrders = orders.filter(order => ["PAID", "PARTIALLY_PAID"].includes(order.paymentStatus));
  const grossSales = paidOrders.reduce((sum, order) => sum + Number(order.total || 0), 0);
  const commissionEarned = paidOrders.reduce((sum, order) => sum + Number(order.commissionAmount || 0), 0);
  const pendingNequi = orders.filter(order => order.paymentMethod === "nequi" && order.canConfirmPayment).length;
  const lowStock = inventory.filter(item => item.trackQuantity && Number(item.quantity || 0) > 0 && Number(item.quantity || 0) <= 5).length;
  const outOfStock = inventory.filter(item => item.trackQuantity && Number(item.quantity || 0) <= 0).length;
  sendJson(response, 200, {
    ok: true,
    storeId: session.storeId,
    summary: {
      grossSales,
      paidOrders: paidOrders.length,
      commissionPercent: STORE_COMMISSION_PERCENT,
      commissionEarned,
      commissionPending: 0,
      pendingNequi,
      inventoryVariants: inventory.length,
      lowStock,
      outOfStock,
      wixSynchronized: Boolean(wix),
      stripeOperational: Boolean(stripe)
    }
  });
}

function rawOrderNationalShipment(order, type) {
  const groups = groupWixOrderNationalLines(order);
  const lines = groups[type] || [];
  if (!lines.length) throw new Error(`El pedido no contiene productos ${type}.`);
  return { type, lines, definition: nationalShipmentDefinition(type) };
}

function orderNationalDelivery(order) {
  const destination = order?.shippingInfo?.logistics?.shippingDestination || {};
  const address = getOrderShippingAddress(order);
  const contact = destination?.contactDetails || getContactDetails(order);
  return {
    delivery: {
      address: safeText([address.addressLine1, address.addressLine2].filter(Boolean).join(", "), 250),
      city: address.city,
      state: address.state,
      postalCode: address.postalCode
    },
    customer: {
      name: getOrderCustomerName(order),
      phone: safeText(contact?.phone, 80)
    }
  };
}

function fulfillmentForShipment(fulfillments, lines) {
  const lineIds = new Set(lines.map(orderLineId).filter(Boolean));
  return (Array.isArray(fulfillments) ? fulfillments : []).find(fulfillment => {
    const candidateIds = fulfillmentLineIds(fulfillment);
    return [...lineIds].some(id => candidateIds.has(id));
  });
}

async function handleGenerateEnviaLabel(request, response, orderId, shipmentType) {
  if (!isAuthorized(request)) return sendError(response, 401, "Inicia sesión en Store Loader.");
  if (!wix) return sendError(response, 503, "Wix no está configurado.");
  requireDeliveryEnvironment("national");

  const type = safeText(shipmentType, 1).toUpperCase();
  if (!["R", "L"].includes(type)) return sendError(response, 400, "El grupo de envío no es válido.");
  const body = await readBody(request);
  if (type === "L" && body?.ready !== true) {
    return sendError(response, 409, "Marca el pedido Libéralo como listo antes de generar la guía.");
  }

  const lockKey = `${orderId}:${type}`;
  if (enviaLabelLocks.has(lockKey)) {
    return sendError(response, 409, "La guía de este envío ya se está generando.");
  }
  enviaLabelLocks.set(lockKey, true);

  try {
    const order = await wix.orders.getOrder(orderId);
    const paymentStatus = safeText(order?.paymentStatus, 100).toUpperCase();
    if (!["PAID", "PARTIALLY_PAID", "AUTHORIZED"].includes(paymentStatus)) {
      return sendError(response, 409, "Confirma el pago antes de generar una guía.");
    }

    const shipment = rawOrderNationalShipment(order, type);
    const listed = await wix.orderFulfillments.listFulfillmentsForSingleOrder(orderId);
    const fulfillments = listed?.orderWithFulfillments?.fulfillments || [];
    const existing = fulfillmentForShipment(fulfillments, shipment.lines);
    const existingTracking = safeText(existing?.trackingInfo?.trackingNumber, 300);
    if (existingTracking) {
      return sendJson(response, 200, {
        ok: true,
        duplicatePrevented: true,
        shipment: {
          type,
          carrier: safeText(existing?.trackingInfo?.shippingProvider, 200),
          trackingNumber: existingTracking,
          trackingLink: safeText(existing?.trackingInfo?.trackingLink, 500)
        }
      });
    }

    const destination = orderNationalDelivery(order);
    const quote = await quoteNationalDelivery(
      destination.delivery,
      destination.customer,
      nationalLinesDeclaredValue(shipment.lines)
    );
    if (!quote.carrier || !quote.service) {
      return sendError(response, 502, "Envia no devolvió una transportadora y servicio válidos.");
    }

    const located = await locateColombiaCity(destination.delivery.city, destination.delivery.state);
    const payload = buildEnviaNationalPayload({
      origin: {
        name: ENVIA_ORIGIN_NAME,
        phone: ENVIA_ORIGIN_PHONE,
        street: ENVIA_ORIGIN_STREET,
        city: "13001000",
        state: "BL",
        postalCode: ENVIA_ORIGIN_POSTAL_CODE
      },
      destination: {
        street: destination.delivery.address,
        city: safeText(located?.city, 20),
        state: safeText(located?.state || destination.delivery.state, 5),
        postalCode: destination.delivery.postalCode || safeText(located?.postalCode || located?.zipcode, 20)
      },
      customer: destination.customer,
      carrier: quote.carrier,
      service: quote.service,
      declaredValue: nationalLinesDeclaredValue(shipment.lines),
      printFormat: ENVIA_PRINT_FORMAT,
      printSize: ENVIA_PRINT_SIZE
    });
    payload.origin.number = enviaAddressNumber(payload.origin.street);
    payload.destination.number = enviaAddressNumber(payload.destination.street);
    const generated = await externalJson(`${ENVIA_API_BASE}/ship/generate/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ENVIA_API_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const label = enviaDataArray(generated)[0] || generated?.data || {};
    const trackingNumber = safeText(label?.trackingNumber || label?.tracking_number, 300);
    const labelUrl = safeText(label?.label || label?.labelUrl || label?.label_url, 1000);
    const trackingLink = safeText(label?.trackUrl || label?.trackingLink || label?.tracking_url, 1000);
    const shipmentId = safeText(label?.shipmentId || label?.shipment_id || label?.id, 100);
    if (!trackingNumber || !labelUrl) {
      console.error("[Envia] Label generation response missing required fields", JSON.stringify({
        type,
        carrier: quote.carrier,
        service: quote.service,
        meta: safeText(generated?.meta, 100),
        errorCode: safeText(generated?.error?.code || label?.error?.code || label?.code, 100),
        errorMessage: safeText(
          (typeof generated?.error === "string" ? generated.error : "") ||
          generated?.error?.message ||
          generated?.error?.description ||
          generated?.errors?.[0]?.message ||
          generated?.message ||
          (typeof label?.error === "string" ? label.error : "") ||
          label?.error?.message ||
          label?.error?.description ||
          label?.errors?.[0]?.message ||
          label?.message,
          500
        ),
        responseKeys: generated && typeof generated === "object" ? Object.keys(generated) : [],
        dataKeys: label && typeof label === "object" ? Object.keys(label) : [],
        dataLength: Array.isArray(generated?.data) ? generated.data.length : null,
        hasTrackingNumber: Boolean(trackingNumber),
        hasLabelUrl: Boolean(labelUrl)
      }));
      return sendError(response, 502, "Envia no devolvió la guía y el número de rastreo.");
    }

    const fulfillment = {
      trackingInfo: {
        trackingNumber,
        shippingProvider: quote.carrier,
        ...(trackingLink ? { trackingLink } : {})
      },
      status: "In_Delivery",
      completed: false
    };
    const lineItems = shipment.lines
      .map(line => ({
        _id: orderLineId(line),
        quantity: Math.max(1, Math.floor(Number(line?.quantity || 1)))
      }))
      .filter(line => line._id);

    if (existing?._id || existing?.fulfillmentId) {
      await wix.orderFulfillments.updateFulfillment(
        {
          orderId,
          fulfillmentId: safeText(existing?._id || existing?.fulfillmentId, 100)
        },
        { fulfillment }
      );
    } else {
      await wix.orderFulfillments.createFulfillment(orderId, { ...fulfillment, lineItems });
    }

    sendJson(response, 201, {
      ok: true,
      shipment: {
        type,
        label: shipment.definition?.label || type,
        estimate: shipment.definition?.estimate || "",
        carrier: quote.carrier,
        service: quote.serviceDescription || quote.service,
        trackingNumber,
        trackingLink,
        shipmentId,
        labelUrl,
        price: Number(label?.totalPrice || label?.price || quote.fee || 0),
        environment: ENVIA_ENV
      }
    });
  } finally {
    enviaLabelLocks.delete(lockKey);
  }
}

function timingSafeHexEqual(left, right) {
  if (!/^[a-f0-9]+$/i.test(left) || !/^[a-f0-9]+$/i.test(right)) return false;
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function timingSafeTextEqual(left, right) {
  const leftHash = crypto.createHash("sha256").update(String(left || "")).digest("hex");
  const rightHash = crypto.createHash("sha256").update(String(right || "")).digest("hex");
  return timingSafeHexEqual(leftHash, rightHash);
}

function verifyEnviaWebhook(request, rawBody) {
  if (!ENVIA_WEBHOOK_SECRET) throw new Error("El secreto del webhook de Envia no está configurado.");

  const event = safeText(request.headers["x-webhook-event"], 100);
  const eventId = safeText(request.headers["x-webhook-id"], 200);
  const timestamp = safeText(request.headers["x-webhook-timestamp"], 30);
  const supplied = safeText(request.headers["x-webhook-signature"], 200).replace(/^v1=/i, "");

  if (event && eventId && timestamp && supplied) {
    const numericTimestamp = Number(timestamp);
    const timestampMs = numericTimestamp > 1e12 ? numericTimestamp : numericTimestamp * 1000;
    if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) {
      throw new Error("El webhook de Envia está fuera de la ventana permitida.");
    }

    const signed = `${timestamp}.${event}.${rawBody.toString("utf8")}`;
    const expected = crypto
      .createHmac("sha256", ENVIA_WEBHOOK_SECRET)
      .update(signed)
      .digest("hex");
    if (!timingSafeHexEqual(supplied, expected)) {
      throw new Error("La firma del webhook de Envia no es válida.");
    }
    return { event, eventId };
  }

  const url = new URL(request.url || "/", "http://localhost");
  const token = safeText(url.searchParams.get("token"), 500);
  if (!token || !timingSafeTextEqual(token, ENVIA_WEBHOOK_SECRET)) {
    throw new Error("El token del webhook de Envia no es válido.");
  }

  return {
    event: "onShipmentStatusUpdate",
    eventId: crypto.createHash("sha256").update(rawBody).digest("hex")
  };
}

function rememberProcessedEnviaWebhook(eventId) {
  processedEnviaWebhookIds.set(eventId, Date.now());
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, receivedAt] of processedEnviaWebhookIds) {
    if (receivedAt < cutoff) processedEnviaWebhookIds.delete(id);
  }
}

async function findEnviaFulfillment(trackingNumber, orderNumber = "") {
  let orders = [];
  if (orderNumber) {
    const result = await wix.orders.searchOrders({
      filter: { number: orderNumber },
      cursorPaging: { limit: 10 }
    });
    orders = Array.isArray(result?.orders) ? result.orders : [];
  } else {
    let cursor = "";
    for (let page = 0; page < 10; page += 1) {
      const result = await wix.orders.searchOrders({
        sort: [{ fieldName: "createdDate", order: "DESC" }],
        cursorPaging: { limit: 100, ...(cursor ? { cursor } : {}) }
      });
      orders.push(...(Array.isArray(result?.orders) ? result.orders : []));
      cursor = safeText(result?.pagingMetadata?.cursors?.next, 500);
      if (!cursor) break;
    }
  }

  for (const order of orders) {
    const orderId = safeText(order?._id || order?.id, 150);
    if (!orderId) continue;
    const listed = await wix.orderFulfillments.listFulfillmentsForSingleOrder(orderId);
    const fulfillments = listed?.orderWithFulfillments?.fulfillments || [];
    const fulfillment = fulfillments.find(candidate =>
      safeText(candidate?.trackingInfo?.trackingNumber, 300) === trackingNumber
    );
    if (fulfillment) return { orderId, fulfillment };
  }
  return null;
}

async function processEnviaTrackingWebhook(payload) {
  if (!wix) throw new Error("Wix no está configurado.");

  const type = safeText(payload?.type, 100);
  const isSignedV2 = ["tracking.simple", "tracking.ecommerce"].includes(type);
  const isLegacy = !type && Boolean(
    payload?.trackingNumber ||
    payload?.tracking_number
  );
  if (!isSignedV2 && !isLegacy) return;

  const data = isSignedV2 ? (payload?.data || {}) : payload;
  const trackingNumber = safeText(
    data?.tracking_number ||
    data?.trackingNumber,
    300
  );
  const orderNumber = safeText(
    data?.order_data?.order_number ||
    data?.orderData?.orderNumber,
    100
  );
  if (!trackingNumber) throw new Error("Envia no incluyó un número de rastreo.");

  const matched = await findEnviaFulfillment(trackingNumber, orderNumber);
  if (!matched) throw new Error(`No se encontró el cumplimiento Wix para ${trackingNumber}.`);

  const status = normalizeEnviaTrackingStatus(
    data?.status ||
    data?.shipment_status ||
    data?.shipmentStatus
  );
  const fulfillmentId = safeText(
    matched.fulfillment?._id || matched.fulfillment?.fulfillmentId,
    150
  );
  const completed = status === "delivered";
  enviaShipmentStatuses.set(trackingNumber, {
    status,
    description: safeText(
      data?.status_description ||
      data?.statusDescription,
      300
    ),
    updatedAt: new Date().toISOString()
  });

  const currentStatus = safeText(matched.fulfillment?.status, 100).toLowerCase();
  if ((completed && matched.fulfillment?.completed) ||
      (!completed && currentStatus === "in_delivery")) {
    return;
  }

  await wix.orderFulfillments.updateFulfillment(
    { orderId: matched.orderId, fulfillmentId },
    {
      fulfillment: {
        trackingInfo: matched.fulfillment?.trackingInfo,
        status: completed ? "Fulfilled" : "In_Delivery",
        completed
      }
    }
  );
}

async function handleEnviaWebhook(request, response) {
  if (!ENVIA_WEBHOOK_SECRET) {
    return sendError(response, 503, "El webhook de Envia no está configurado.");
  }

  const rawBody = await readRawBody(request);
  let verified;
  try {
    verified = verifyEnviaWebhook(request, rawBody);
  } catch (error) {
    return sendError(response, 401, error?.message || "Webhook de Envia rechazado.");
  }

  if (processedEnviaWebhookIds.has(verified.eventId) ||
      enviaWebhookProcessing.has(verified.eventId)) {
    return sendJson(response, 200, { received: true, duplicate: true });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return sendError(response, 400, "El webhook de Envia no contiene JSON válido.");
  }

  enviaWebhookProcessing.add(verified.eventId);
  sendJson(response, 200, { received: true });

  setImmediate(() => {
    void processEnviaTrackingWebhook(payload)
      .then(() => rememberProcessedEnviaWebhook(verified.eventId))
      .catch(error => console.error("[Envia] Webhook processing failed:", error))
      .finally(() => enviaWebhookProcessing.delete(verified.eventId));
  });
}

async function handleSaveOrderTracking(request, response, orderId) {
  if (!isAuthorized(request)) return sendError(response, 401, "Inicia sesión en Store Loader.");
  if (!wix) return sendError(response, 503, "Wix no está configurado.");

  const body = await readBody(request);
  const status = safeText(body?.status, 30).toLowerCase();
  const carrier = safeText(body?.carrier, 100);
  const trackingNumber = safeText(body?.trackingNumber, 100);
  if (!trackingNumber || !carrier) return sendError(response, 400, "Ingresa la transportadora y el número de rastreo.");

  const order = await wix.orders.getOrder(orderId);
  const fulfillmentStatus = status === "delivered"
    ? "Fulfilled"
    : status === "shipped"
      ? "In_Delivery"
      : status === "processing"
        ? "Accepted"
        : "Pending";
  const completed = status === "delivered";
  const listed = await wix.orderFulfillments.listFulfillmentsForSingleOrder(orderId);
  const existing = listed?.orderWithFulfillments?.fulfillments?.[0];
  const trackingLink =
    `https://envia.com/es-CO/rastreo?label=${encodeURIComponent(trackingNumber)}`;
  const fulfillment = {
    trackingInfo: { trackingNumber, shippingProvider: carrier, trackingLink },
    status: fulfillmentStatus,
    completed
  };

  if (existing?.fulfillmentId) {
    await wix.orderFulfillments.updateFulfillment(
      { orderId, fulfillmentId: existing.fulfillmentId },
      { fulfillment }
    );
  } else {
    const lineItems = (Array.isArray(order?.lineItems) ? order.lineItems : [])
      .map(line => ({
        _id: safeText(line?._id || line?.id, 100),
        quantity: Math.max(1, Math.floor(Number(line?.quantity || 1)))
      }))
      .filter(line => line._id);
    if (!lineItems.length) return sendError(response, 409, "El pedido no tiene productos para despachar.");
    await wix.orderFulfillments.createFulfillment(orderId, { ...fulfillment, lineItems });
  }

  const refreshed = await wix.orders.getOrder(orderId);
  if (status === "shipped") {
    const trackingInfo = getFirstTrackingInfo(refreshed);
    await sendOrderShipmentEmail(
      refreshed,
      carrier,
      trackingNumber,
      safeText(trackingInfo?.trackingLink, 500)
    );
  }
  sendJson(response, 200, { ok: true, order: normalizeWixOrder(refreshed) });
}
async function handleTrackOrder(
  request,
  response,
  url
) {

  const orderNumber =
    safeText(
      url.searchParams.get(
        "order"
      ),
      100
    ).trim();

  const email =
    safeText(
      url.searchParams.get(
        "email"
      ),
      250
    )
      .trim()
      .toLowerCase();

  if(
    !orderNumber ||
    !email
  ){

    sendError(
      response,
      400,
      "Ingresa tu número de pedido y correo electrónico."
    );

    return;
  }

  const result =
    await wix
      .orders
      .searchOrders(
        {
          filter: {
            number:
              orderNumber
          },

          cursorPaging: {
            limit:
              10
          }
        }
      );

  const wixOrders =
    Array.isArray(
      result?.orders
    )
      ? result.orders
      : [];

  const matchedOrder =
    wixOrders.find(
      order => {

        const orderEmail =
          safeText(
            order
              ?.buyerInfo
              ?.email,
            250
          )
            .trim()
            .toLowerCase();

        return (
          safeText(
            order?.number,
            100
          ) === orderNumber &&
          orderEmail === email
        );
      }
    );

  if(
    !matchedOrder
  ){

    sendError(
      response,
      404,
      "No pudimos encontrar un pedido con esos datos."
    );

    return;
  }

  const order =
    normalizeWixOrder(
      matchedOrder
    );

  sendJson(
    response,
    200,
    {
      ok:
        true,

      order: {
        number:
          order.number,

        date:
          order.date,

        products:
          order.products,

        total:
          order.total,

        status:
          order.status,

        fulfillmentStatus:
          order.fulfillmentStatus,

        carrier:
          order.carrier,

        trackingNumber:
          order.trackingNumber,

        trackingLink:
          order.trackingLink,

        shipments:
          order.nationalShipments
      }
    }
  );
}

const CONFIRMED_PAYMENT_STATUSES = new Set([
  "PAID",
  "PARTIALLY_PAID",
  "AUTHORIZED"
]);

function isCheckoutId(value) {
  return /^[a-z0-9-]{20,80}$/i.test(value);
}

async function findOrderByCheckoutId(checkoutId) {
  if (!wix) throw new Error("Wix no está configurado.");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await wix.orders.searchOrders({
      filter: { checkoutId },
      cursorPaging: { limit: 10 }
    });
    const order = (result?.orders || []).find(
      candidate => safeText(candidate?.checkoutId, 100) === checkoutId
    );
    if (order) return order;
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 700));
  }
  return null;
}

function getConfirmationDelivery(order) {
  const title = safeText(
    order?.shippingInfo?.title ||
    order?.shippingInfo?.logistics?.deliveryTime ||
    order?.shippingInfo?.logistics?.shippingDestination?.address?.city,
    160
  ).trim();
  const normalized = title.toLowerCase();

  if (normalized.includes("pickup") || normalized.includes("recog")) {
    return { method: title || "Pickup Ahora", message: "Te avisaremos cuando tu pedido esté listo." };
  }
  if (normalized.includes("libér") || normalized.includes("liber")) {
    return { method: title || "Libéralo", message: "Te enviaremos actualizaciones durante los próximos 14–28 días." };
  }
  return { method: title || "Entrega CajaModa", message: "Te enviaremos la información de entrega por correo." };
}

async function handleOrderConfirmation(request, response, url) {
  const checkoutId = safeText(url.searchParams.get("checkoutId"), 100).trim();
  if (!isCheckoutId(checkoutId)) {
    sendError(response, 400, "El identificador del pedido no es válido.");
    return;
  }

  const order = await findOrderByCheckoutId(checkoutId);
  if (!order) {
    sendError(response, 404, "El pedido todavía no está disponible.");
    return;
  }

  const paymentStatus = safeText(order?.paymentStatus, 100).toUpperCase();
  const payment = paymentStatus === "AUTHORIZED"
    ? "Pago autorizado"
    : CONFIRMED_PAYMENT_STATUSES.has(paymentStatus)
      ? "Pago confirmado"
      : "Pedido recibido";

  sendJson(response, 200, {
    ok: true,
    order: {
      number: safeText(order?.number, 100),
      payment,
      delivery: getConfirmationDelivery(order),
      shipments: normalizedNationalOrderShipments(order)
    }
  });
}

async function wixCouponsRequest(path, body) {
  if (!WIX_API_KEY || !WIX_SITE_ID) throw new Error("Wix Coupons no está configurado.");
  const result = await fetch(`https://www.wixapis.com${path}`, {
    method: "POST",
    headers: {
      "Authorization": WIX_API_KEY,
      "wix-site-id": WIX_SITE_ID,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const payload = await result.json().catch(() => ({}));
  if (!result.ok) {
    throw new Error(payload?.message || payload?.error || "Wix Coupons rechazó la solicitud.");
  }
  return payload;
}

function createReferralCode(order) {
  const orderNumber = safeText(order?.number, 40).replace(/[^a-z0-9]/gi, "");
  const digest = crypto.createHash("sha256")
    .update(safeText(order?.checkoutId, 100))
    .digest("hex")
    .slice(0, 5)
    .toUpperCase();
  return `AMIGA${orderNumber}${digest}`.slice(0, 20).toUpperCase();
}

async function ensureReferralCoupon(order) {
  const code = createReferralCode(order);
  const queried = await wixCouponsRequest("/stores/v2/coupons/query", {
    query: {
      filter: { "specification.code": code },
      paging: { limit: 1 }
    }
  });
  const existing = (queried?.coupons || []).find(
    coupon => coupon?.specification?.code === code
  );

  if (!existing) {
    await wixCouponsRequest("/stores/v2/coupons", {
      specification: {
        name: `Amiga pedido ${safeText(order?.number, 40)}`,
        code,
        percentOffRate: 10,
        scope: { namespace: "stores", group: { name: "product" } },
        startTime: new Date().toISOString(),
        expirationTime: new Date(Date.now() + 30 * 86400000).toISOString(),
        usageLimit: 1,
        limitPerCustomer: 1,
        active: true
      }
    });
  }
  return code;
}

async function handleCreateReferral(request, response) {
  const body = await readBody(request);
  const checkoutId = safeText(body?.checkoutId, 100).trim();
  if (!isCheckoutId(checkoutId)) {
    sendError(response, 400, "El identificador del pedido no es válido.");
    return;
  }

  const order = await findOrderByCheckoutId(checkoutId);
  const paymentStatus = safeText(order?.paymentStatus, 100).toUpperCase();
  if (!order || !CONFIRMED_PAYMENT_STATUSES.has(paymentStatus)) {
    sendError(response, 403, "El pedido debe estar confirmado antes de compartir un descuento.");
    return;
  }

  const code = await ensureReferralCoupon(order);
  sendJson(response, 200, { ok: true, code, url: "https://www.cajamoda.com/" });
}

async function ensureProfileCoupon(email, name) {
  const code = `CAJA${crypto.createHash("sha256").update(email).digest("hex").slice(0, 8).toUpperCase()}`;
  const queried = await wixCouponsRequest("/stores/v2/coupons/query", {
    query: {
      filter: { "specification.code": code },
      paging: { limit: 1 }
    }
  });
  const existing = (queried?.coupons || []).find(
    coupon => coupon?.specification?.code === code
  );

  if (!existing) {
    await wixCouponsRequest("/stores/v2/coupons", {
      specification: {
        name: `Perfil CajaModa · ${safeText(name, 100) || email}`,
        code,
        percentOffRate: 10,
        scope: { namespace: "stores", group: { name: "product" } },
        startTime: new Date().toISOString(),
        expirationTime: new Date(Date.now() + 30 * 86400000).toISOString(),
        usageLimit: 1,
        limitPerCustomer: 1,
        active: true
      }
    });
  }

  return code;
}

async function handleProfileCoupon(request, response) {
  const body = await readBody(request);
  const name = safeText(body?.name, 100).trim();
  const email = safeText(body?.email, 250).trim().toLowerCase();

  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    sendError(response, 400, "Completa tu nombre y correo electrónico.");
    return;
  }

  const code = await ensureProfileCoupon(email, name);
  sendJson(response, 200, {
    ok: true,
    code,
    discountPercent: 10,
    singleUse: true
  });
}

/* ============================================================
   REAL WIX INVENTORY
   ============================================================ */

function normalizeInventoryItem(
  item
) {

  return {

    id:
      safeText(
        item?._id ||
        item?.id,
        150
      ),

    productId:
      safeText(
        item?.productId,
        150
      ),

    variantId:
      safeText(
        item?.variantId,
        150
      ),

    locationId:
      safeText(
        item?.locationId,
        150
      ),

    productName:
      safeText(
        item
          ?.product
          ?.name,
        300
      ),

    variantName:
      safeText(
        item
          ?.product
          ?.variantName,
        300
      ),

    sku:
      safeText(item?.product?.variantSku || item?.product?.sku || item?.sku, 160),

    revision:
      safeText(item?.revision, 100),

    quantity:
      Number.isFinite(
        Number(
          item?.quantity
        )
      )
        ? Number(
            item.quantity
          )
        : 0,

    trackQuantity:
      Boolean(
        item?.trackQuantity
      ),

    inStock:
      Boolean(
        item?.inStock
      ),

    availabilityStatus:
      safeText(
        item?.availabilityStatus,
        100
      )
  };
}

function wixMediaId(value) {
  const raw = safeText(value, 2000);
  if (!raw || /^data:image\//i.test(raw)) return "";
  if (raw.startsWith("wix:image://")) return raw.replace(/^wix:image:\/\/v1\//, "").split("/")[0].split("#")[0];
  const match = raw.match(/static\.wixstatic\.com\/media\/([^/?#]+)/i);
  return match?.[1] || "";
}

function productImageCandidates(product) {
  return [
    product?.media?.main?.image,
    product?.media?.main,
    product?.media?.mainMedia?.image,
    product?.media?.mainMedia,
    ...(product?.media?.itemsInfo?.items || []),
    ...(product?.media?.items || []),
    ...(product?.mediaItems || []),
    product?.thumbnail
  ];
}

function imageCandidateValue(candidate) {
  if (typeof candidate === "string") return candidate;
  return candidate?.image?.url || candidate?.image?.imageInfo?.url || candidate?.imageInfo?.url ||
    candidate?.thumbnail?.url || candidate?.url || candidate?.image?._id || candidate?.image?.id ||
    candidate?._id || candidate?.id || "";
}

function getProductImageUrls(product) {
  const urls = [];
  const seenMediaIds = new Set();
  for (const candidate of productImageCandidates(product)) {
    const value = imageCandidateValue(candidate);
    const mediaId = wixMediaId(value) || (!/^https?:\/\//i.test(value) ? safeText(value, 1500).split("/")[0].split("#")[0] : "");
    const key = mediaId || safeText(value, 1500);
    if (!key || seenMediaIds.has(key)) continue;
    seenMediaIds.add(key);
    urls.push(mediaId ? `https://static.wixstatic.com/media/${mediaId}` : value);
    if (urls.length === 5) break;
  }
  return urls;
}

function getProductImageUrl(product) {
  const resolved = getProductImageUrls(product)[0];
  if (resolved) return resolved;
  const candidates = [
    product?.media?.main?.image?.url,
    typeof product?.media?.main?.image === "string" ? product.media.main.image : "",
    product?.media?.main?.image?._id,
    product?.media?.main?.image?.id,
    product?.media?.main?.url,
    product?.media?.main?.id,
    product?.media?.main?.thumbnail?.url,
    product?.media?.mainMedia?.image?.url,
    product?.media?.mainMedia?.image?._id,
    product?.media?.mainMedia?.image?.id,
    product?.media?.mainMedia?.image?.imageInfo?.url,
    product?.media?.mainMedia?.imageInfo?.url,
    product?.media?.mainMedia?.url,
    product?.media?.mainMedia?._id,
    product?.media?.mainMedia?.id,
    product?.media?.itemsInfo?.items?.[0]?.image?.url,
    typeof product?.media?.itemsInfo?.items?.[0]?.image === "string" ? product.media.itemsInfo.items[0].image : "",
    product?.media?.itemsInfo?.items?.[0]?.image?._id,
    product?.media?.itemsInfo?.items?.[0]?.image?.id,
    product?.media?.itemsInfo?.items?.[0]?.image?.imageInfo?.url,
    product?.media?.itemsInfo?.items?.[0]?.url,
    typeof product?.media?.itemsInfo?.items?.[0] === "string" ? product.media.itemsInfo.items[0] : "",
    product?.media?.itemsInfo?.items?.[0]?._id,
    product?.media?.itemsInfo?.items?.[0]?.id,
    product?.media?.items?.[0]?.image?.url,
    product?.media?.items?.[0]?.image?.imageInfo?.url,
    product?.media?.items?.[0]?.thumbnail?.url,
    product?.media?.items?.[0]?.url,
    product?.mediaItems?.[0]?.image?.url,
    product?.mediaItems?.[0]?.url,
    product?.thumbnail?.url,
    typeof product?.thumbnail === "string" ? product.thumbnail : "",
    product?.thumbnail?._id,
    product?.thumbnail?.id
  ];
  const value = safeText(candidates.find(Boolean), 1500);
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  const mediaId = value.startsWith("wix:image://")
    ? value.replace(/^wix:image:\/\/v1\//, "").split("/")[0].split("#")[0]
    : value.split("/")[0].split("#")[0];
  return mediaId ? `https://static.wixstatic.com/media/${mediaId}` : "";
}

async function getWixInventory() {

  if (
    !wix
  ) {

    throw new Error(
      "El servidor todavía no está conectado a Wix."
    );
  }

const result =
  await wix
    .inventoryItemsV3
    .queryInventoryItems()
    .ne(
      "_id",
      "00000000-0000-0000-0000-000000000000"
    )
    .limit(
      1000
    )
    .find();

console.log(
  "[WIX INVENTORY RAW]",
  JSON.stringify(
    result,
    null,
    2
  )
);

const inventoryItems =
  Array.isArray(
    result?.items
  )
    ? result.items
    : [];
  const normalized = inventoryItems
    .map(
      normalizeInventoryItem
    )
    .filter(
      item =>
        item.id
    );

  const productIds = [...new Set(normalized.map(item => item.productId).filter(Boolean))];
  const productEntries = await Promise.all(productIds.map(async productId => {
    try {
      const result = await wix.productsV3.getProduct(productId, {
        fields: ["MEDIA_ITEMS_INFO", "THUMBNAIL"]
      });
      return [productId, result?.product || result];
    } catch (error) {
      console.warn(`[WIX INVENTORY] No se pudo cargar la foto del producto ${productId}:`, error?.message || error);
      return [productId, null];
    }
  }));
  const productsById = new Map(productEntries);
  const categoryRoutes = await getCategoryRoutes().catch(() => ({}));
  const showcaseSlots = await getShowcaseSlots().catch(() => ({}));

  return normalized.map(item => {
    const product = productsById.get(item.productId);
    const variants = product?.variantsInfo?.variants || product?.variants || [];
    const variant = variants.find(candidate => String(candidate?._id || candidate?.id || candidate?.variantId) === item.variantId);
    return {
      ...item,
      productName: item.productName || safeText(product?.name, 300),
      variantName: existingVariantSize(variant) || item.variantName,
      sku: safeText(variant?.sku, 160).toUpperCase() || item.sku,
      image: getProductImageUrl(product),
      category: safeText(categoryRoutes[item.productId], 30),
      price: wixVariantPrice(variant) ?? wixVariantPrice(product),
      visible: product?.visible !== false,
      showcaseSlot: Number(showcaseSlots[item.productId] || 0) || null
    };
  });
}

async function handleGetInventory(
  request,
  response
) {

  if (
    !isAuthorized(
      request
    )
  ) {

    sendError(
      response,
      401,
      "Inicia sesión en Store Loader."
    );

    return;
  }

  const [inventory, showcases] =
    await Promise.all([
      getWixInventory(),
      getCategoryShowcases()
    ]);

  sendJson(
    response,
    200,
    {

      ok:
        true,

      inventory,
      showcases
    }
  );
}

async function handleUpdateInventory(request, response) {
  const session = getAuthorizedSession(request);
  if (!session) return sendError(response, 401, "Inicia sesión en Store Loader.");
  if (!wix) return sendError(response, 503, "Wix no está configurado.");
  const body = await readBody(request);
  const changes = Array.isArray(body?.changes) ? body.changes.slice(0, 100) : [];
  if (!changes.length) return sendError(response, 400, "Selecciona al menos una variante para actualizar.");

  const current = await getWixInventory();
  const byId = new Map(current.map(item => [item.id, item]));
  const updates = changes.map(change => {
    const id = safeText(change?.id, 150);
    const quantity = Number(change?.quantity);
    const item = byId.get(id);
    if (!item) throw new Error("Una variante ya no existe en el inventario de Wix.");
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 100000) {
      throw new Error("Cada cantidad debe ser un número entero entre 0 y 100000.");
    }
    return { item, quantity };
  });

  for (const { item, quantity } of updates) {
    await wix.inventoryItemsV3.updateInventoryItem(
      item.id,
      { id: item.id, revision: item.revision, quantity },
      { reason: "MANUAL" }
    );
  }

  sendJson(response, 200, {
    ok: true,
    storeId: session.storeId,
    updated: updates.length,
    inventory: await getWixInventory()
  });
}

const STATIC_CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".webp": "image/webp"
};

async function serveStaticFile(request, response, pathname) {
  if (!["GET", "HEAD"].includes(request.method)) return false;

  let relativePath;
  try {
    relativePath = decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    return false;
  }

  if (!relativePath || relativePath.endsWith("/")) {
    relativePath += "index.html";
  }

  const filePath = resolve(DIST_ROOT, relativePath);
  if (filePath !== DIST_ROOT && !filePath.startsWith(DIST_ROOT + sep)) {
    return false;
  }

  try {
    const file = await stat(filePath);
    if (!file.isFile()) return false;
    const content = await readFile(filePath);
    const extension = extname(filePath).toLowerCase();
    response.statusCode = 200;
    response.setHeader(
      "Content-Type",
      STATIC_CONTENT_TYPES[extension] || "application/octet-stream"
    );
    response.setHeader(
      "Cache-Control",
      extension === ".html" ? "no-cache" : "public, max-age=31536000, immutable"
    );
    response.setHeader("Content-Length", content.length);
    response.end(request.method === "HEAD" ? undefined : content);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

/* ============================================================
   SERVER
   ============================================================ */

const server =
  http.createServer(
    async (
      request,
      response
    ) => {

      setCors(
        request,
        response
      );

      if (
        request.method ===
        "OPTIONS"
      ) {

        response.statusCode =
          204;

        response.end();

        return;
      }

      const url =
        new URL(
          request.url,
          `http://${request.headers.host || "localhost"}`
        );

      try {

        if (await handleMockRequest(request, response, url)) {
          return;
        }

        /* ------------------------------------------------------
           HEALTH
           ------------------------------------------------------ */

        if (
          request.method === "POST" &&
          url.pathname === "/api/products/assist"
        ) {
          await handleAssistProduct(request, response);
          return;
        }

        if (
          request.method ===
            "GET" &&
          url.pathname ===
            "/health"
        ) {

          sendJson(
            response,
            200,
            {

              ok:
                true,

              service:
                "Store Loader API",

              wixConfigured:
                Boolean(
                  WIX_API_KEY &&
                  WIX_SITE_ID
                ),

              loaderConfigured:
                Boolean(
                  LOADER_PASSWORD
                )
            }
          );

          return;
        }

        const captureStripeMatch = url.pathname.match(/^\/api\/stripe\/authorizations\/(pi_[A-Za-z0-9]+)\/capture$/);
        if (request.method === "POST" && captureStripeMatch) {
          await handleCaptureStripeAuthorization(request, response, captureStripeMatch[1]);
          return;
        }

        const cancelStripeMatch = url.pathname.match(/^\/api\/stripe\/authorizations\/(pi_[A-Za-z0-9]+)\/cancel$/);
        if (request.method === "POST" && cancelStripeMatch) {
          await handleCancelStripeAuthorization(request, response, cancelStripeMatch[1]);
          return;
        }

        const enviaLabelMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/shipments\/([RL])\/label$/);
        if (request.method === "POST" && enviaLabelMatch) {
          await handleGenerateEnviaLabel(
            request,
            response,
            decodeURIComponent(enviaLabelMatch[1]),
            enviaLabelMatch[2]
          );
          return;
        }

        const orderTrackingMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/tracking$/);
        if (request.method === "POST" && orderTrackingMatch) {
          await handleSaveOrderTracking(request, response, decodeURIComponent(orderTrackingMatch[1]));
          return;
        }

        /* ------------------------------------------------------
           PUBLIC STOREFRONT CATEGORY ROUTER
           ------------------------------------------------------ */

        if (
          request.method ===
            "GET" &&
          url.pathname ===
            "/api/category-routes"
        ) {

          try {

            const routes =
              await getCategoryRoutes();

            const showcaseSlots =
              await getShowcaseSlots().catch(error => {
                console.warn("[Category arrangement]", error?.message || error);
                return {};
              });

            sendJson(
              response,
              200,
              {
                routes,
                showcaseSlots
              }
            );

          } catch (
            error
          ) {

            console.error(
              "[Category Router]",
              error
            );

            sendJson(
              response,
              500,
              {
                error:
                  "No se pudieron resolver las categorias."
              }
            );
          }

          return;
        }

        if(request.method === "GET" && url.pathname === "/api/reviews"){
          await handleGetProductReviews(request,response,url);
          return;
        }

        if(request.method === "GET" && url.pathname === "/api/order-confirmation"){
          await handleOrderConfirmation(request,response,url);
          return;
        }

        if(request.method === "POST" && url.pathname === "/api/referrals"){
          await handleCreateReferral(request,response);
          return;
        }

        if(request.method === "POST" && url.pathname === "/api/profile-coupon"){
          await handleProfileCoupon(request,response);
          return;
        }

        if(request.method === "GET" && url.pathname === "/api/public-config"){
          sendJson(response,200,{
            ok:true,
            whatsappNumber:PUBLIC_WHATSAPP_NUMBER,
            supportEmail:"ayuda@cajamoda.com"
          });
          return;
        }

        if(request.method === "POST" && url.pathname === "/api/analytics/events"){
          await handleAnalyticsEvents(request,response);
          return;
        }

        if(request.method === "POST" && url.pathname === "/api/stripe/checkout"){
          await protectCheckoutOperation(response,"Stripe",() => handleCreateStripeCheckout(request,response));
          return;
        }

        if(request.method === "POST" && url.pathname === "/api/stripe/checkout/update"){
          await protectCheckoutOperation(response,"Stripe update",() => handleUpdateStripeCheckout(request,response));
          return;
        }

        if(request.method === "POST" && url.pathname === "/api/stripe/payment-intent"){
          await protectCheckoutOperation(response,"Stripe intent",() => handleCreateStripePaymentIntent(request,response));
          return;
        }

        if(request.method === "GET" && url.pathname === "/api/stripe/confirmation"){
          await handleStripeConfirmation(request,response,url);
          return;
        }

        if(request.method === "GET" && url.pathname === "/api/stripe/intent-confirmation"){
          await handleStripeIntentConfirmation(request,response,url);
          return;
        }

        if(request.method === "POST" && url.pathname === "/api/stripe/webhook"){
          await handleStripeWebhook(request,response);
          return;
        }

        if(request.method === "POST" && url.pathname === "/api/webhooks/envia"){
          await handleEnviaWebhook(request,response);
          return;
        }

        if(request.method === "GET" && url.pathname === "/api/checkout/config"){
          await handleCheckoutConfig(request,response);
          return;
        }

        if(request.method === "POST" && url.pathname === "/api/checkout/validate"){
          await protectCheckoutOperation(response,"validation",() => handleValidateCheckoutCart(request,response));
          return;
        }

        if(request.method === "POST" && url.pathname === "/api/delivery/quote"){
          await protectCheckoutOperation(response,"delivery quote",() => handleDeliveryQuote(request,response));
          return;
        }

        if(request.method === "GET" && url.pathname === "/api/delivery/departments"){
          await handleDeliveryDepartments(request,response);
          return;
        }

        if(request.method === "GET" && url.pathname === "/api/delivery/cities"){
          await handleDeliveryCities(request,response,url);
          return;
        }

        if(request.method === "GET" && url.pathname === "/api/delivery/postal-code"){
          await handleDeliveryPostalCode(request,response,url);
          return;
        }

        if(request.method === "POST" && url.pathname === "/api/delivery/address-suggestions"){
          await handleDeliveryAddressSuggestions(request,response);
          return;
        }

        if(request.method === "POST" && url.pathname === "/api/delivery/address-details"){
          await handleDeliveryAddressDetails(request,response);
          return;
        }

        if(request.method === "POST" && url.pathname === "/api/nequi/orders"){
          await protectCheckoutOperation(response,"Nequi",() => handleCreateNequiOrder(request,response));
          return;
        }

        const nequiConfirmMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/confirm-nequi$/);
        if(request.method === "POST" && nequiConfirmMatch){
          await handleConfirmNequiOrder(request,response,decodeURIComponent(nequiConfirmMatch[1]));
          return;
        }

        /* ------------------------------------------------------
           LOGIN
           ------------------------------------------------------ */

        if (
          request.method ===
            "POST" &&
          url.pathname ===
            "/api/login"
        ) {

          await handleLogin(
            request,
            response
          );

          return;
        }

        if (request.method === "GET" && url.pathname === "/api/store-owner/profile") {
          await handleStoreOwnerProfile(request, response);
          return;
        }

        if (request.method === "GET" && url.pathname === "/api/store-owner/summary") {
          await handleStoreOwnerSummary(request, response);
          return;
        }

        if (request.method === "GET" && url.pathname === "/api/store-owner/analytics") {
          await handleStoreOwnerAnalytics(request, response, url);
          return;
        }

        if (request.method === "POST" && url.pathname === "/api/store-owner/analytics/settings") {
          await handleStoreOwnerAnalyticsSettings(request, response);
          return;
        }

        if (["GET", "POST"].includes(request.method) && url.pathname === "/api/store-owner/chat") {
          await handleStoreChat(request, response);
          return;
        }

        if (request.method === "GET" && url.pathname === "/api/products/next-sku") {
          await handleNextPermanentSku(request, response);
          return;
        }
        const showcasePositionMatch = url.pathname.match(/^\/api\/products\/([^/]+)\/showcase-position$/);
        if (request.method === "POST" && showcasePositionMatch) {
          await handleShowcasePosition(request, response, decodeURIComponent(showcasePositionMatch[1]));
          return;
        }
        const productUpdateMatch = url.pathname.match(/^\/api\/products\/([^/]+)$/);
        if (request.method === "GET" && productUpdateMatch) {
          await handleGetProduct(request, response, decodeURIComponent(productUpdateMatch[1]));
          return;
        }
        if (request.method === "PATCH" && productUpdateMatch) {
          await handleUpdateProduct(request, response, decodeURIComponent(productUpdateMatch[1]));
          return;
        }
        if (request.method === "DELETE" && productUpdateMatch) {
          await handleDeleteProduct(request, response, decodeURIComponent(productUpdateMatch[1]));
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/products/bulk-delete") {
          await handleBulkDeleteProducts(request, response);
          return;
        }

        /* ------------------------------------------------------
           CREATE PRODUCT
           ------------------------------------------------------ */

        if (
          request.method ===
            "POST" &&
          url.pathname ===
            "/api/products"
        ) {

          await handleCreateProduct(
            request,
            response
          );

          return;
        }

        /* ------------------------------------------------------
           REAL ORDERS
           ------------------------------------------------------ */

        if (
          request.method ===
            "GET" &&
          url.pathname ===
            "/api/orders"
        ) {

          await handleGetOrders(
            request,
            response
          );

          return;
        }
        /* ------------------------------------------------------
   CUSTOMER ORDER TRACKING
   ------------------------------------------------------ */

if (
  request.method ===
    "GET" &&
  url.pathname ===
    "/api/track-order"
) {

  await handleTrackOrder(
    request,
    response,
    url
  );

  return;
}

if (request.method === "PATCH" && url.pathname === "/api/inventory") {
  await handleUpdateInventory(request, response);
  return;
}
/* ------------------------------------------------------
   REAL INVENTORY
   ------------------------------------------------------ */

if (
  request.method ===
    "GET" &&
  url.pathname ===
    "/api/inventory"
) {

  await handleGetInventory(
    request,
    response
  );

  return;
}
        if (await serveStaticFile(request, response, url.pathname)) {
          return;
        }
        /* ------------------------------------------------------
           NOT FOUND
           ------------------------------------------------------ */

        sendError(
          response,
          404,
          "Ruta no encontrada."
        );

      } catch (
        error
      ) {

        console.error(
          "[Store Loader API]",
          error
        );

        sendError(
          response,
          500,
          error?.message ||
          "Ocurrió un error en Store Loader."
        );
      }
    }
  );

/* ============================================================
   START
   ============================================================ */

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `[Store Loader API] Running on port ${PORT}`
    );
  }
);
