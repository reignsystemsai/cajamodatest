import { createClient, OAuthStrategy } from "@wix/sdk";
import { products, productsV3, collections } from "@wix/stores";
import * as categoriesV3 from "@wix/categories_categories";
import { currentCart } from "@wix/ecom";
import { redirects } from "@wix/redirects";

/* ============================================================
   CAJAMODA
   WIX PRODUCT + CART + CHECKOUT BRIDGE
   ============================================================ */

const CLIENT_ID =
  import.meta.env.VITE_WIX_CLIENT_ID;

const TEST_MODE = !CLIENT_ID;

const WIX_STORES_APP_ID =
  "215238eb-22a5-4c36-9e7b-e7c08025e04e";

const CATEGORY_ROUTER_URL =
  import.meta.env
    .VITE_CATEGORY_ROUTER_URL ||
  "/api/category-routes";

const SESSION_KEY =
  "wixSession";

/* ============================================================
   STORAGE
   ============================================================ */

function readJson(
  key,
  fallback = null
) {
  try {
    const raw =
      localStorage.getItem(key);

    if (!raw) {
      return fallback;
    }

    return JSON.parse(raw);

  } catch {
    return fallback;
  }
}

function saveJson(
  key,
  value
) {
  try {
    localStorage.setItem(
      key,
      JSON.stringify(value)
    );
  } catch {}
}

function removeStorage(
  key
) {
  try {
    localStorage.removeItem(key);
  } catch {}
}

/* ============================================================
   VISITOR TOKENS
   ============================================================ */

function getStoredTokens() {
  const tokens =
    readJson(
      SESSION_KEY,
      null
    );

  if (
    !tokens ||
    typeof tokens !== "object"
  ) {
    return undefined;
  }

  return tokens;
}

const storedTokens =
  getStoredTokens();

/* ============================================================
   WIX CLIENT
   ============================================================ */

const wix = TEST_MODE ? null :
  createClient({
    modules: {
      products,
      productsV3,
      categoriesV3,
      collections,
      currentCart,
      redirects
    },

    auth:
      OAuthStrategy({
        clientId:
          CLIENT_ID,

        tokens:
          storedTokens ??
          undefined
      })
  });

/* ============================================================
   STATE
   ============================================================ */

let catalog = [];

let responseSource =
  "CAJAMODA_WIX";

let lastCart =
  normalizeLocalCart(
    readJson(
      "cajamoda-cart",
      null
    )
  );

/* Serialize Wix mutations so an older request can never finish after a newer cart. */
let cartSyncQueue = Promise.resolve();

/* ============================================================
   BRIDGE
   ============================================================ */

function send(
  type,
  payload = {}
) {
  window.postMessage(
    {
      source:
        responseSource,

      type,

      payload
    },
    window.location.origin
  );
}

/* ============================================================
   TEXT
   ============================================================ */

function cleanText(
  html = ""
) {
  const element =
    document.createElement(
      "div"
    );

  element.innerHTML =
    String(html);

  return (
    element.textContent ||
    element.innerText ||
    ""
  );
}

/* ============================================================
   PRICE
   ============================================================ */

function normalizePrice(
  ...candidates
) {
  function readCandidate(
    candidate
  ) {
    if (
      candidate === null ||
      candidate === undefined ||
      candidate === ""
    ) {
      return null;
    }

    if (
      typeof candidate === "object"
    ) {
      const nestedCandidates = [
        candidate.amount,
        candidate.value,
        candidate.discountedPrice,
        candidate.price
      ];

      for (
        const nestedCandidate
        of nestedCandidates
      ) {
        const nested =
          readCandidate(
            nestedCandidate
          );

        if (
          nested !== null
        ) {
          return nested;
        }
      }

      return null;
    }

    if(typeof candidate === "string"){
      const cleaned=candidate
        .replace(/[^0-9,.-]/g,"")
        .replace(/\.(?=\d{3}(?:\D|$))/g,"")
        .replace(",",".");
      const parsed=Number(cleaned);
      return Number.isFinite(parsed)?Math.round(parsed):null;
    }

    const numeric=Number(candidate);
    return Number.isFinite(numeric)?Math.round(numeric):null;
  }

  for (
    const candidate
    of candidates
  ) {
    const numeric =
      readCandidate(
        candidate
      );

    if (
      numeric !== null
    ) {
      return numeric;
    }
  }

  return 0;
}

function getPrice(
  product
) {
  return normalizePrice(
    product?.priceData?.discountedPrice,
    product?.priceData?.price,
    product?.price,
    product?.discountedPrice
  );
}


/* ============================================================
   IMAGES
   ============================================================ */

function getImages(
  product
) {
  const urls = [];

  function add(
    value
  ) {
    const raw = typeof value === "string"
      ? value
      : value?.url || value?.src || value?.imageUrl || value?._id || value?.id || "";
    const url = raw.startsWith("wix:image://")
      ? `https://static.wixstatic.com/media/${raw.replace(/^wix:image:\/\/v1\//, "").split("/")[0].split("#")[0]}`
      : raw && !/^https?:\/\//i.test(raw) && /^[a-f0-9_~-]+\.(?:jpe?g|png|webp|gif)$/i.test(raw)
        ? `https://static.wixstatic.com/media/${raw}`
        : raw;
    if (
      url &&
      !urls.includes(url)
    ) {
      urls.push(url);
    }
  }

  add(
    product
      ?.media
      ?.mainMedia
      ?.image
  );

  add(
    product
      ?.media
      ?.mainMedia
      ?.url
  );

  add(
    product
      ?.image
      ?.url
  );

  add(
    product
      ?.imageUrl
  );

  const mediaItems =
    product
      ?.media
      ?.items ||
    [];

  for (
    const item
    of mediaItems
  ) {
    add(
      item
        ?.image
    );

    add(
      item
        ?.url
    );

    add(
      item
        ?.imageUrl
    );
  }

  add(product?.v3Media?.main?.image);
  add(product?.v3Media?.main);
  add(product?.v3Thumbnail);

  const v3MediaItems = product?.v3Media?.itemsInfo?.items || product?.v3Media?.items || [];
  for (const item of v3MediaItems) {
    add(item?.image || item);
    add(item?.url);
  }

  return urls;
}

/* ============================================================
   PRODUCT TYPE
   ============================================================ */

function getProductType(
  product
) {
  const text =
    String(
      product?.name ||
      ""
    )
      .toLowerCase();

  if (
    text.includes("top") ||
    text.includes("blusa") ||
    text.includes("camisa")
  ) {
    return "Tops";
  }

  if (
    text.includes("conjunto") ||
    text.includes("set")
  ) {
    return "Conjuntos";
  }

  if (
    text.includes("enterizo") ||
    text.includes("jumpsuit")
  ) {
    return "Enterizos";
  }

  return "Vestidos";
}

/* ============================================================
   WIX CATEGORY MAPPING
   ============================================================ */

const CATEGORY_VIBE_BY_NAME =
  Object.freeze({
    "noches largas":
      "late",

    "dias tranquilos":
      "chill",

    "rapido y facil":
      "quick",

    "bano de sol":
      "sun"
  });

function normalizeCategoryName(
  value
) {
  return String(
    value ||
    ""
  )
    .normalize("NFD")
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

function categoryVibeFromName(
  name
) {
  return (
    CATEGORY_VIBE_BY_NAME[
      normalizeCategoryName(
        name
      )
    ] ||
    ""
  );
}

/* ============================================================
   VARIANT CHOICES
   ============================================================ */

function getChoices(
  variant
) {
  return (
    variant
      ?.choices ||

    variant
      ?.variant
      ?.choices ||

    {}
  );
}

function getSize(
  variant
) {
  const choices =
    getChoices(
      variant
    );

  return normalizeSizeLabel(
    choices.Size ||
    choices.size ||
    choices.Talla ||
    choices.talla ||
    ""
  );
}

function normalizeSizeLabel(
  value
) {
  const size = String(value || "").trim();
  const key = size.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");

  if (key === "small") return "S";
  if (key === "medium") return "M";
  if (key === "large") return "L";
  if (key === "x large" || key === "extra large") return "XL";

  return size.toUpperCase();
}

function getColor(
  variant
) {
  const choices =
    getChoices(
      variant
    );

  return (
    choices.Color ||
    choices.color ||
    choices.Colour ||
    choices.colour ||
    ""
  );
}

/* ============================================================
   NORMALIZE VARIANT
   ============================================================ */

function deliveryModesFromSku(value) {
  const sku = String(value || "").trim().toUpperCase();
  const code = sku.match(/^(PRL|PR|RP|PL|LP|RL|LR|P|R|L)(?:-|$)/)?.[1] || "R";
  return code === "PRL"
    ? ["pickup", "fast", "ship"]
    : code === "PR" || code === "RP"
      ? ["pickup", "fast"]
      : code === "PL" || code === "LP"
        ? ["pickup", "ship"]
        : code === "RL" || code === "LR"
          ? ["fast", "ship"]
          : code === "P"
            ? ["pickup"]
            : code === "L"
              ? ["ship"]
              : ["fast"];
}

function normalizeDeliveryModes(values) {
  const source = Array.isArray(values) ? values : [];
  return [...new Set(source.map(value => {
    const mode = String(value || "").trim().toLowerCase();
    if (["pickup", "pronto", "pick", "p"].includes(mode)) return "pickup";
    if (["ship", "liberalo", "liberala", "release", "global", "l"].includes(mode)) return "ship";
    if (["fast", "rapido", "rápido", "r"].includes(mode)) return "fast";
    return "";
  }).filter(Boolean))];
}

function normalizeVariant(
  productId,
  variant,
  basePrice
) {
  const raw =
    variant?.variant ||
    variant;

  const id =
    variant?._id ||
    variant?.id ||
    raw?._id ||
    raw?.id ||
    variant?.variantId ||
    "";

  const price =
  normalizePrice(
    raw?.priceData?.discountedPrice,
    raw?.priceData?.price,
    variant?.priceData?.discountedPrice,
    variant?.priceData?.price,
    raw?.price,
    variant?.price,
    basePrice
  );

  const inStock =
    raw
      ?.stock
      ?.inStock !== false &&

    variant
      ?.stock
      ?.inStock !== false;

  const inventoryQuantity =
    raw?.stock?.quantity ??
    variant?.stock?.quantity ??
    null;

  const sku =
    raw?.sku ||
    variant?.sku ||
    "";
  const deliveryModes = deliveryModesFromSku(sku);

  return {
    id,

    productId,

    size:
      getSize(
        variant
      ),

    color:
      getColor(
        variant
      ),

    sku,

    deliveryMode:
      deliveryModes[0],

    deliveryModes,

    price,

    inStock,

    inventoryQuantity:
      inventoryQuantity !== null && Number.isFinite(Number(inventoryQuantity))
        ? Math.max(0, Math.floor(Number(inventoryQuantity)))
        : null
  };
}

/* ============================================================
   NORMALIZE PRODUCT
   ============================================================ */

function normalizeProduct(
  product,
  index,
  collectionVibes,
  productCategoryVibes
) {
  const id =
    product?._id ||
    product?.id ||
    "";

  const basePrice =
    getPrice(
      product
    );

  const rawVariants =
    Array.isArray(
      product?.variants
    )
      ? product.variants
      : [];

  const variants =
    rawVariants
      .map(
        variant =>
          normalizeVariant(
            id,
            variant,
            basePrice
          )
      )
      .filter(
        variant =>
          variant.id
      );

  const sizes =
    [
      ...new Set(
        variants
          .map(
            variant =>
              variant.size
          )
          .filter(Boolean)
      )
    ];

  const fulfillmentSku = String(
    variants.find(variant => variant.sku)?.sku ||
    product?.sku ||
    ""
  ).trim().toUpperCase();
  const deliveryModes = deliveryModesFromSku(fulfillmentSku);
  const deliveryMode = deliveryModes[0];

  /*
    Preserve the existing four CajaModa category rails.
  */

  const vibes = [
    "late",
    "chill",
    "quick",
    "sun"
  ];

  const brandVibe =
    categoryVibeFromName(
      product?.brand?.name ||
      product?.brand
    );

  const collectionVibe =
    brandVibe ||
    productCategoryVibes.get(
      String(id)
    ) ||
    (
      Array.isArray(
        product?.collectionIds
      )
        ? product.collectionIds
        : []
    )
      .map(
        collectionId =>
          collectionVibes.get(
            String(
              collectionId
            )
          ) ||
          ""
      )
      .find(Boolean) ||
    "";

  const legacyVibe =
    product
      ?.additionalInfoSections
      ?.find?.(
        section =>
          String(
            section?.title ||
            ""
          )
            .toLowerCase() ===
          "vibe"
      )
      ?.description ||
    "";

  const vibeId =
    collectionVibe ||
    legacyVibe ||
    "";

  return {
    id,

    masterProductId:
      id,

    source:
      "wix",

    name:
      product?.name ||
      "Producto",

    productType:
      getProductType(
        product
      ),

    vibeId:
      String(
        vibeId
      )
        .toLowerCase()
        .trim(),

    vibes: [
      String(
        vibeId
      )
        .toLowerCase()
        .trim()
    ],

    price:
      basePrice,

    media:
      getImages(
        product
      ),

    sizes,

    variants,

    deliveryMode,

    deliveryModes,

    inventoryMode:
      product
        ?.stock
        ?.trackInventory
        ? "STOCKED"
        : "WIX",

    inventoryStatus:
      product
        ?.stock
        ?.inStock === false
        ? "OUT_OF_STOCK"
        : "AVAILABLE",

    inventoryQuantity:
      product
        ?.stock
        ?.quantity ??
      null,

    fulfillmentConfidence:
      null,

    supplyRef:
      null,

    defaultLocationId:
      null,

    inventoryItems:
      [],

    supplySyncAt:
      new Date()
        .toISOString(),

    description:
      cleanText(
        product?.description ||
        ""
      ),

    showcaseSlot:
      Number(product?.showcaseSlot) || null,

    reviews:
      []
  };
}

/* ============================================================
   PRODUCT LOOKUP
   ============================================================ */

function findProduct(
  id
) {
  return (
    catalog.find(
      product =>
        String(
          product.id
        ) ===
        String(id)
    ) ||
    null
  );
}

/* ============================================================
   LOCAL CART
   ============================================================ */

function emptyCart() {
  return {
    items: [],
    count: 0,
    total: 0
  };
}

function createLocalId() {
  if (
    window.crypto
      ?.randomUUID
  ) {
    return window.crypto
      .randomUUID();
  }

  return (
    `${Date.now()}-` +
    Math.random()
      .toString(16)
      .slice(2)
  );
}

function normalizeLocalCart(
  cart
) {
  const sourceItems =
    Array.isArray(
      cart?.items
    )
      ? cart.items
      : Array.isArray(
          cart?.lineItems
        )
        ? cart.lineItems
        : [];

  const items =
    sourceItems.map(
      item => ({
        id:
          item.id ||
          item._id ||
          item.lineItemId ||
          createLocalId(),

        productId:
          item.productId ||
          item
            ?.catalogReference
            ?.catalogItemId ||
          null,

        variantId:
          item.variantId ||
          item
            ?.catalogReference
            ?.options
            ?.variantId ||
          null,

        name:
          item.name ||
          item
            ?.productName
            ?.translated ||
          item
            ?.productName
            ?.original ||
          item.productName ||
          "Producto",

        image:
          item.image ||
          item.imageUrl ||
          item
            ?.media
            ?.url ||
          "",

        size:
          normalizeSizeLabel(
          item.size ||
          item
            ?.options
            ?.Size ||
          item
            ?.options
            ?.size ||
          ""),

        color:
          item.color ||
          item
            ?.options
            ?.Color ||
          item
            ?.options
            ?.color ||
          "",

        deliveryMode:
          item.deliveryMode ||
          "fast",

        allowedDeliveryModes: (() => {
          const allowed = normalizeDeliveryModes(item.allowedDeliveryModes || item.deliveryModes);
          return allowed.length ? allowed : normalizeDeliveryModes([item.deliveryMode || "fast"]);
        })(),

        selectedDeliveryMode: (() => {
          const allowed = normalizeDeliveryModes(item.allowedDeliveryModes || item.deliveryModes);
          const selected = normalizeDeliveryModes([item.selectedDeliveryMode])[0] || "";
          const effectiveAllowed = allowed.length ? allowed : normalizeDeliveryModes([item.deliveryMode || "fast"]);
          return selected && effectiveAllowed.includes(selected)
            ? selected
            : effectiveAllowed.length === 1
              ? effectiveAllowed[0]
              : "";
        })(),

        quantity:
          Math.max(
            1,
            Number(
              item.quantity ||
              1
            )
          ),

  unitPrice:
  normalizePrice(
    item.unitPrice,
    item.price,
    item.lineItemPrice
  ),

price:
  normalizePrice(
    item.unitPrice,
    item.price,
    item.lineItemPrice
  ),

        autoSelected:
          item.autoSelected ===
          true
      })
    );

  const count =
    items.reduce(
      (
        total,
        item
      ) =>
        total +
        item.quantity,
      0
    );

  const total =
    items.reduce(
      (
        subtotal,
        item
      ) =>
        subtotal +
        (
          item.unitPrice *
          item.quantity
        ),
      0
    );

  return {
    items,
    count,
    total,
    revision: Math.max(0,Number(cart?.revision || 0)),
    updatedAt: Math.max(0,Number(cart?.updatedAt || 0)),
    authoritative: cart?.authoritative === true
  };
}

function saveLocalCart(
  cart
) {
  const previous = readJson("cajamoda-cart",null);
  const normalized =
    normalizeLocalCart(
      cart
    );

  /* Never let completion of an older Wix request overwrite a newer local edit. */
  if (
    previous?.authoritative === true &&
    cart?.authoritative === true &&
    Number(previous.revision || 0) > Number(cart.revision || 0)
  ) {
    lastCart = normalizeLocalCart(previous);
    return lastCart;
  }

  normalized.revision = Math.max(
    Number(previous?.revision || 0),
    Number(cart?.revision || 0)
  ) + 1;
  normalized.updatedAt = Date.now();
  normalized.authoritative = true;

  saveJson(
    "cajamoda-cart",
    normalized
  );

  saveJson(
    "cajamoda-checkout-cart",
    normalized
  );

  lastCart =
    normalized;

  return normalized;
}

function readBestLocalCart() {
  const regularRaw = readJson("cajamoda-cart",null);
  const checkoutRaw = readJson("cajamoda-checkout-cart",null);

  /* A stored empty cart is intentional. Never replace it with an older cart. */
  if (regularRaw !== null) return normalizeLocalCart(regularRaw);
  if (checkoutRaw !== null) return normalizeLocalCart(checkoutRaw);

  return emptyCart();
}

function hasAuthoritativeLocalCart() {
  return localStorage.getItem("cajamoda-cart") !== null ||
    localStorage.getItem("cajamoda-checkout-cart") !== null;
}

/* ============================================================
   VARIANT LOOKUP
   ============================================================ */

function normalizeChoice(
  value
) {
  return String(
    value ||
    ""
  )
    .toLowerCase()
    .trim();
}
function cartLineKey(
  item
) {
  const productId =
    String(
      item?.productId ||
      ""
    );

  const variantId =
    String(
      item?.variantId ||
      ""
    );

  if (
    variantId
  ) {
    return `${productId}:variant:${variantId}`;
  }

  return [
    productId,
    "options",
    normalizeChoice(item?.size),
    normalizeChoice(item?.color)
  ].join(":");
}
function findVariant(
  product,
  item
) {
  if (
    !product ||
    !Array.isArray(
      product.variants
    ) ||
    !product.variants.length
  ) {
    return null;
  }

  /*
    First use a known Wix variant ID.
  */

  if (
    item.variantId
  ) {
    const direct =
      product.variants.find(
        variant =>
          String(
            variant.id
          ) ===
          String(
            item.variantId
          )
      );

    if (direct) {
      return direct;
    }
  }

  const wantedSize =
    normalizeChoice(
      item.size
    );

  const wantedColor =
    normalizeChoice(
      item.color
    );

  /*
    Exact size + color.
  */

  if (
    wantedSize &&
    wantedColor
  ) {
    const exact =
      product.variants.find(
        variant =>
          normalizeChoice(
            variant.size
          ) ===
            wantedSize &&

          normalizeChoice(
            variant.color
          ) ===
            wantedColor &&

          variant.inStock !==
            false
      );

    if (exact) {
      return exact;
    }
  }

  /*
    Size match is enough when the current
    visual color selector doesn't correspond
    to a Wix variant option.
  */

  if (
    wantedSize
  ) {
    const sizeMatch =
      product.variants.find(
        variant =>
          normalizeChoice(
            variant.size
          ) ===
            wantedSize &&

          variant.inStock !==
            false
      );

    if (sizeMatch) {
      return sizeMatch;
    }
  }

  /*
    Final fallback to the first available variant.
  */

  return (
    product.variants.find(
      variant =>
        variant.inStock !==
        false
    ) ||
    product.variants[0] ||
    null
  );
}

/* ============================================================
   WIX CART -> CAJAMODA CART
   ============================================================ */

function normalizeWixCart(
  rawCart
) {
  const wixCart =
    rawCart?.cart ||
    rawCart;

  const lineItems =
    Array.isArray(
      wixCart?.lineItems
    )
      ? wixCart.lineItems
      : [];
const localItems = 
   readBestLocalCart().items;
  const items =
    lineItems.map(
      line => {
        const productId =
          line
            ?.catalogReference
            ?.catalogItemId ||
          null;

        const variantId =
          line
            ?.catalogReference
            ?.options
            ?.variantId ||
          null;

        const product =
          findProduct(
            productId
          );

        const variant =
          product
            ?.variants
            ?.find(
              candidate =>
                String(
                  candidate.id
                ) ===
                String(
                  variantId
                )
            );
const size =
  variant?.size ||
  "";

const color =
  variant?.color ||
  "";

const localLine =
  localItems.find(
    item =>
      cartLineKey(item) ===
      cartLineKey({
        productId,
        variantId,
        size,
        color
      })
  );

const unitPrice =
  normalizePrice(
    line?.price,
    line?.lineItemPrice,
    variant?.price,
    product?.price,
    localLine?.unitPrice,
    localLine?.price
  );
        return {
          id:
            line?._id ||
            line?.id ||
            createLocalId(),

          productId,

          variantId,

          name:
            line
              ?.productName
              ?.translated ||
            line
              ?.productName
              ?.original ||
            product?.name ||
            "Producto",

          image:
            product
              ?.media
              ?.[0] ||
            "",
           
            size,

          color,

          deliveryMode:
            variant?.deliveryMode ||
            localLine?.deliveryMode ||
            product?.deliveryMode ||
            "fast",

          allowedDeliveryModes: normalizeDeliveryModes(
            variant?.deliveryModes || product?.deliveryModes || localLine?.allowedDeliveryModes
          ),

          selectedDeliveryMode: localLine?.selectedDeliveryMode || "",

          /* Use Wix's confirmed quantity. Local quantity must never mask a failed sync. */
          quantity:
            Math.max(
              1,
              Number(
                line?.quantity ??
                1
              )
            ),

          unitPrice,

          price:
            unitPrice,

          autoSelected:
            localLine?.autoSelected ??
            true
        };
      }
    );

  return normalizeLocalCart({
    items
  });
}

/* ============================================================
   CART COMPARISON
   ============================================================ */

function cartFingerprint(
  cart
) {
  const normalized =
    normalizeLocalCart(
      cart
    );

  return normalized.items
    .map(
     item => [
  cartLineKey(item),
  Number(
    item.quantity ||
    1
  )
]
        .join(":")
    )
    .sort()
    .join("|");
}

function canonicalizeCartForWix(
  localCart
) {
  const input = normalizeLocalCart(localCart);
  const grouped = new Map();

  for (const item of input.items) {
    const product = findProduct(item.productId);

    if (!product) {
      throw new Error(`No pudimos encontrar ${item.name || "un producto"} en Wix.`);
    }

    const variant = findVariant(product,item);

    if (product.variants.length) {
      if (!variant?.id) {
        throw new Error(`Selecciona una talla disponible para ${product.name}.`);
      }

      const wantedSize = normalizeChoice(item.size);
      const wantedColor = normalizeChoice(item.color);

      if (wantedSize && normalizeChoice(variant.size) !== wantedSize) {
        throw new Error(`La talla ${item.size} de ${product.name} no coincide con Wix.`);
      }

      if (wantedColor && variant.color && normalizeChoice(variant.color) !== wantedColor) {
        throw new Error(`El color ${item.color} de ${product.name} no coincide con Wix.`);
      }
    }

    const canonical = {
      ...item,
      productId: product.id,
      variantId: variant?.id || null,
      name: product.name,
      image: product.media?.[0] || item.image || "",
      size: variant?.size || item.size || "",
      color: variant?.color || item.color || "",
      deliveryMode: variant?.deliveryMode || item.deliveryMode || product.deliveryMode || "fast",
      allowedDeliveryModes: normalizeDeliveryModes(
        variant?.deliveryModes || product.deliveryModes || item.allowedDeliveryModes
      ),
      selectedDeliveryMode: item.selectedDeliveryMode || "",
      quantity: Math.max(1,Math.floor(Number(item.quantity || 1))),
      unitPrice: normalizePrice(variant?.price,product.price),
      price: normalizePrice(variant?.price,product.price)
    };

    const key = cartLineKey(canonical);
    const existing = grouped.get(key);

    if (existing) {
      existing.quantity += canonical.quantity;
    } else {
      grouped.set(key,canonical);
    }
  }

  return normalizeLocalCart({items:[...grouped.values()]});
}

function wixCartSubtotal(rawCart, fallbackCart) {
  const wixCart = rawCart?.cart || rawCart || {};
  return normalizePrice(
    wixCart?.subtotal?.amount,
    wixCart?.subtotal,
    wixCart?.priceSummary?.subtotal?.amount,
    wixCart?.priceSummary?.subtotal,
    fallbackCart?.total
  );
}

function assertWixCartMatches(expectedCart, rawWixCart) {
  const expected = normalizeLocalCart(expectedCart);
  const confirmed = normalizeWixCart(rawWixCart);

  if (cartFingerprint(expected) !== cartFingerprint(confirmed)) {
    throw new Error("No pudimos actualizar tu bolsa. Intenta nuevamente.");
  }

  const confirmedTotal = wixCartSubtotal(rawWixCart,confirmed);
  const expectedTotal = expected.total;

  if (Math.abs(confirmedTotal - expectedTotal) > 0.01) {
    throw new Error("No pudimos confirmar el total de tu bolsa. Intenta nuevamente.");
  }

  return confirmed;
}

/* ============================================================
   VISITOR SESSION
   ============================================================ */

function persistCurrentTokens() {
  try {
    const tokens =
      wix.auth
        .getTokens();

    if (tokens) {
      saveJson(
        SESSION_KEY,
        tokens
      );
    }
  } catch {}
}

async function prepareVisitorSession() {
  try {
    const tokens =
      await wix.auth
        .generateVisitorTokens(
          storedTokens
        );

    saveJson(
      SESSION_KEY,
      tokens
    );

    return tokens;

  } catch (
    firstError
  ) {
    /*
      If old stored tokens are unusable,
      create a fresh anonymous visitor session.
    */

    console.warn(
      "[CajaModa] Renewing Wix visitor session."
    );

    removeStorage(
      SESSION_KEY
    );

    try {
      const tokens =
        await wix.auth
          .generateVisitorTokens();

      saveJson(
        SESSION_KEY,
        tokens
      );

      return tokens;

    } catch (
      error
    ) {
      throw (
        error ||
        firstError
      );
    }
  }
}

/* ============================================================
   ERROR HELPERS
   ============================================================ */

function getStatus(
  error
) {
  return Number(
    error
      ?.response
      ?.status ||
    error
      ?.status ||
    error
      ?.statusCode ||
    0
  );
}

function isNotFound(
  error
) {
  return (
    getStatus(error) ===
    404
  );
}

/* ============================================================
   GET CURRENT WIX CART
   ============================================================ */

async function getWixCart() {
  try {
    const result =
      await wix
        .currentCart
        .getCurrentCart();

    persistCurrentTokens();

    return result;

  } catch (
    error
  ) {
    if (
      isNotFound(error)
    ) {
      return null;
    }

    throw error;
  }
}

/* ============================================================
   CART PERSISTENCE
   ============================================================ */

async function getPersistentCart() {
  /*
    CajaModa local storage is intentionally
    preferred when it already has items.

    This prevents Home from erasing a Product-page
    selection while Wix synchronization is still
    finishing.
  */

  const local =
    readBestLocalCart();

  let wixCart = null;

  try {
    wixCart =
      await getWixCart();

  } catch (
    error
  ) {
    console.warn(
      "[CajaModa] Wix cart read warning:",
      error
    );
  }

  const normalizedWix =
    wixCart
      ? normalizeWixCart(
          wixCart
        )
      : emptyCart();

  if (hasAuthoritativeLocalCart()) {
    lastCart =
      local;

    /*
      If Wix is behind the local bag,
      synchronize quietly in the background.
    */

    if (
      catalog.length &&
      cartFingerprint(local) !==
        cartFingerprint(
          normalizedWix
        )
    ) {
      queueCartSync(local)
        .catch(
          error => {
            console.warn(
              "[CajaModa] Background cart sync:",
              error
            );
          }
        );
    }

    return local;
  }

  if (
    normalizedWix
      .items
      .length
  ) {
    return saveLocalCart(
      normalizedWix
    );
  }

  lastCart =
    emptyCart();

  return lastCart;
}

/* ============================================================
   TURN LOCAL BAG INTO WIX LINE ITEMS
   ============================================================ */

function buildWixLineItems(
  localCart
) {
  const cart =
    canonicalizeCartForWix(
      localCart
    );

  if (
    !cart.items.length
  ) {
    return [];
  }

  return cart.items.map(
    item => {
      const product =
        findProduct(
          item.productId
        );

      if (
        !product
      ) {
        throw new Error(
          `No pudimos encontrar ${item.name || "un producto"} en Wix.`
        );
      }

      const variant =
        findVariant(
          product,
          item
        );

      if (
        product.variants.length &&
        !variant?.id
      ) {
        throw new Error(
          `Selecciona una talla disponible para ${product.name}.`
        );
      }

      const catalogReference = {
        appId:
          WIX_STORES_APP_ID,

        catalogItemId:
          product.id
      };

      if (
        variant?.id
      ) {
        catalogReference.options = {
          variantId:
            variant.id
        };
      }

      return {
        catalogReference,

        quantity:
          Math.max(
            1,
            Number(
              item.quantity ||
              1
            )
          )
      };
    }
  );
}

/* ============================================================
   SYNC CAJAMODA BAG -> REAL WIX CART
   ============================================================ */

async function syncLocalCartToWix(
  localCart
) {
  const cart =
    canonicalizeCartForWix(
      localCart
    );

  if (
    !cart.items.length
  ) {
    try {
      await wix.currentCart.deleteCurrentCart();
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
    persistCurrentTokens();
    return saveLocalCart(cart);
  }

  const lineItems =
    buildWixLineItems(
      cart
    );

  /*
    Remove the old Wix current cart so that
    the checkout exactly matches the visible
    CajaModa bag and doesn't duplicate items.
  */

  try {
    await wix
      .currentCart
      .deleteCurrentCart();

  } catch (
    error
  ) {
    if (
      !isNotFound(error)
    ) {
      throw error;
    }
  }

  const result =
    await wix
      .currentCart
      .addToCurrentCart({
        lineItems
      });

  persistCurrentTokens();

  /* Read the cart back from Wix; the add response alone is not sufficient proof. */
  const confirmedRaw =
    await getWixCart() ||
    result?.cart ||
    result;

  assertWixCartMatches(cart,confirmedRaw);

  /* Keep CajaModa metadata, but only after Wix confirms identity, quantity and total. */
  return saveLocalCart(cart);
}

function queueCartSync(cart) {
  const snapshot = normalizeLocalCart(cart);
  cartSyncQueue = cartSyncQueue
    .catch(() => undefined)
    .then(() => syncLocalCartToWix(snapshot));
  return cartSyncQueue;
}

/* ============================================================
   SEND INIT
   ============================================================ */

function sendInit() {
  send(
    "INIT",
    {
      products:
        catalog,

      sellerId:
        "CAJAMODA",

      storefrontId:
        "CAJAMODA",

      storefrontSlug:
        "cajamoda",

      brand: {
        name:
          "CAJAMODA",

        publicName:
          "CajaModa",

        monogram:
          "CM"
      },

      /*
        Important:
        never initialize the storefront with a
        fake empty cart when a local bag exists.
      */

      cart:
        lastCart,

      features: {
        reviewsEnabled:
          true
      },

      supplyContext: {
        enabled:
          true,

        checkoutMode:
          "DEFAULT_LOCATION_NATIVE",

        supportsLocationInventory:
          false,

        supportsReservations:
          false,

        supportsPreorder:
          false,

        supportsCustomMultiLocationCheckout:
          false,

        locations:
          [],

        inventoryItems:
          []
      },

      inventoryCheckoutMode:
        "DEFAULT_LOCATION_NATIVE"
    }
  );
}

/* ============================================================
   LOAD WIX PRODUCTS
   ============================================================ */


async function loadRenderCategoryRoutes() {

  try {

    const response =
      await fetch(
        CATEGORY_ROUTER_URL,
        {
          headers: {
            Accept:
              "application/json"
          }
        }
      );

    if (
      !response.ok
    ) {

      throw new Error(
        `Category router returned ${response.status}`
      );
    }

    const payload =
      await response.json();

    const routes = new Map(
      Object.entries(
        payload?.routes ||
        {}
      )
        .map(
          (
            [
              productId,
              vibeId
            ]
          ) => [
            String(
              productId
            ),

            String(
              vibeId ||
              ""
            )
          ]
        )
        .filter(
          (
            [
              productId,
              vibeId
            ]
          ) =>
            productId &&
            vibeId
        )
    );
    routes.showcaseSlots = new Map(Object.entries(payload?.showcaseSlots || {}).map(([productId, slot]) => [String(productId), Number(slot)]));
    return routes;

  } catch (
    error
  ) {

    console.warn(
      "[CajaModa] Render category router warning:",
      error
    );

    return new Map();
  }
}

async function loadReviewData(products) {
  const ids = products.map(product => product.id).filter(Boolean);
  if (!ids.length) return;

  try {
    const response = await fetch(
      `/api/reviews?productIds=${encodeURIComponent(ids.join(","))}`,
      { credentials: "same-origin" }
    );
    if (!response.ok) throw new Error("Reviews unavailable");
    const payload = await response.json();

    products.forEach(product => {
      const reviews = payload?.reviews?.[product.id] || [];
      const summary = payload?.summaries?.[product.id] || {};
      product.reviews = reviews;
      product.reviewSummary = {
        count: Number(summary.count || 0),
        average: Number(summary.average || 0)
      };
    });
  } catch (error) {
    console.warn("[CajaModa] Wix reviews warning:", error);
    products.forEach(product => {
      product.reviews = [];
      product.reviewSummary = { count: 0, average: 0 };
    });
  }
}

async function loadCatalog() {
  if (TEST_MODE) {
    const result = await fetch("/api/test/catalog").then(response => response.json());
    catalog = Array.isArray(result?.products) ? result.products : [];
    lastCart = readBestLocalCart();
    sendInit();
    return;
  }
  const [
    productResult,
    collectionResult,
    categoryProductResult,
    categoryResult,
    renderCategoryRoutes
  ] =
    await Promise.all([
      wix
        .products
        .queryProducts()
        .limit(100)
        .find(),

      wix
        .collections
        .queryCollections()
        .limit(100)
        .find()
        .catch(error => {
          console.warn(
            "[CajaModa] Wix category read warning:",
            error
          );

          return { items: [] };
        }),

      wix
        .productsV3
        .queryProducts({
          fields: [
            "DIRECT_CATEGORIES_INFO",
            "BREADCRUMBS_INFO",
            "MEDIA_ITEMS_INFO",
            "THUMBNAIL"
          ]
        })
        .limit(100)
        .find()
        .catch(error => {
          console.warn(
            "[CajaModa] Wix V3 category read warning:",
            error
          );

          return { items: [] };
        }),

      wix
        .categoriesV3
        .queryCategories({
          treeReference: {
            appNamespace:
              "@wix/stores"
          },
          returnNonVisibleCategories:
            true
        })
        .limit(1000)
        .find()
        .catch(error => {
          console.warn(
            "[CajaModa] Wix category-name read warning:",
            error
          );

          return { items: [] };
        }),

      loadRenderCategoryRoutes()
    ]);

  const wixProducts =
    productResult?.items ||
    [];

  const wixCollections =
    collectionResult?.items ||
    [];

  const categoryProducts =
    categoryProductResult?.items ||
    [];

  const v3ProductsById = new Map(
    categoryProducts.map(product => [String(product?._id || product?.id || ""), product])
  );

  const categoryVibes =
    new Map(
      (
        categoryResult?.items ||
        []
      )
        .map(category => [
          String(
            category?._id ||
            category?.id ||
            ""
          ),
          categoryVibeFromName(
            category?.name
          )
        ])
        .filter(
          ([categoryId, vibeId]) =>
            categoryId &&
            vibeId
        )
    );

  const productCategoryVibes =
    new Map(
      [
        ...categoryProducts
        .map(product => {
          const vibeId =
            categoryVibeFromName(
              product?.brand?.name ||
              product?.brand
            ) ||
            (
              product
                ?.breadcrumbsInfo
                ?.breadcrumbs ||
              []
            )
              .map(breadcrumb =>
                categoryVibeFromName(
                  breadcrumb?.categoryName
                )
              )
              .find(Boolean) ||
            (
              product
                ?.directCategoriesInfo
                ?.categories ||
              []
            )
              .map(category =>
                categoryVibes.get(
                  String(
                    category?._id ||
                    category?.id ||
                    ""
                  )
                )
              )
              .find(Boolean) ||
            "";

          return [
            String(
              product?._id ||
              product?.id ||
              ""
            ),
            vibeId
          ];
        })
        .filter(
          ([productId, vibeId]) =>
            productId &&
            vibeId
        ),

        ...Array.from(
          renderCategoryRoutes
            .entries()
        )
      ]
    );

  const collectionVibes =
    new Map(
      wixCollections
        .map(
          collection => [
            String(
              collection?._id ||
              collection?.id ||
              ""
            ),

            categoryVibeFromName(
              collection?.name
            )
          ]
        )
        .filter(
          (
            [
              collectionId,
              vibeId
            ]
          ) =>
            collectionId &&
            vibeId
        )
    );

  catalog =
    wixProducts
      .map(
        (
          product,
          index
        ) =>
          normalizeProduct(
            {
              ...product,
              v3Media: v3ProductsById.get(String(product?._id || product?.id || ""))?.media,
              v3Thumbnail: v3ProductsById.get(String(product?._id || product?.id || ""))?.thumbnail,
              showcaseSlot: renderCategoryRoutes.showcaseSlots?.get(String(product?._id || product?.id || "")) || null
            },
            index,
            collectionVibes,
            productCategoryVibes
          )
      )
      .filter(
        product =>
          product.id
      );

  await loadReviewData(catalog);

  console.log(
    `[CajaModa] Loaded ${catalog.length} Wix products`
  );

  /* Re-price legacy saved lines from the live Wix catalog before any checkout. */
  const storedCart = readBestLocalCart();
  if (hasAuthoritativeLocalCart() && storedCart.items.length) {
    try {
      saveLocalCart(canonicalizeCartForWix(storedCart));
    } catch (error) {
      console.warn("[CajaModa] Saved-cart migration needs customer review:",error);
    }
  }

  /*
    Resolve the best persistent bag only after
    the catalog is available so variants can be
    matched correctly.
  */

  lastCart =
    await getPersistentCart();

  sendInit();
}

/* ============================================================
   CREATE REAL WIX CHECKOUT
   ============================================================ */

async function createPaymentCheckout(
  payload
) {
  try {
    if (TEST_MODE) {
      const cart = normalizeLocalCart(payload?.cart || readBestLocalCart());
      const response = await fetch("/api/test/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cart, customer: payload?.customer || {} })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error || "No pudimos crear el pedido de prueba.");
      send("CHECKOUT_URL", { url: result.url, checkoutId: result.orderNumber });
      return;
    }
    const suppliedCart =
      normalizeLocalCart(
        payload?.cart
      );

    const localCart = payload?.cart
      ? suppliedCart
      : readBestLocalCart();

    const canonicalCart = canonicalizeCartForWix(localCart);

    if (
      !canonicalCart
        .items
        .length
    ) {
      throw new Error(
        "Tu bolsa está vacía."
      );
    }

    /*
      Make Wix's current cart match exactly
      what the customer sees on Checkout.
    */

    await queueCartSync(canonicalCart);

    /* Final pre-checkout verification immediately before Wix creates the checkout. */
    const verifiedWixCart = await getWixCart();
    assertWixCartMatches(canonicalCart,verifiedWixCart);

    const customer =
      payload?.customer ||
      {};

    const channelType =
      currentCart
        ?.ChannelType
        ?.OTHER_PLATFORM ||
      "OTHER_PLATFORM";

    const checkoutOptions = {
      channelType
    };

    /*
      Email is safe to prefill.
      Wix's hosted checkout remains responsible
      for final shipping and payment validation.
    */

    if (
      customer.email
    ) {
      checkoutOptions.email =
        customer.email;
    }

    const checkoutResult =
      await wix
        .currentCart
        .createCheckoutFromCurrentCart(
          checkoutOptions
        );

    const checkoutId =
      checkoutResult
        ?.checkoutId ||
      checkoutResult
        ?._id ||
      checkoutResult
        ?.id ||
      "";

    if (
      !checkoutId
    ) {
      throw new Error(
        "Wix no devolvió un checkout válido."
      );
    }

    persistCurrentTokens();

    /*
      Generate the Wix-hosted secure checkout URL.
    */

    const redirectResult =
      await wix
        .redirects
        .createRedirectSession({
          callbacks: {
            postFlowUrl:
              `${window.location.origin}/order-confirmation/`
          },

          ecomCheckout: {
            checkoutId
          },

          origin:
            window.location.origin,

          preferences: {
            checkIfPublish:
              true
          }
        });

    const checkoutUrl =
      redirectResult
        ?.redirectSession
        ?.fullUrl ||
      "";

    if (
      !checkoutUrl
    ) {
      throw new Error(
        "Wix no devolvió la dirección de pago."
      );
    }

    send(
      "CHECKOUT_URL",
      {
        url:
          checkoutUrl,

        checkoutId
      }
    );

  } catch (
    error
  ) {
    console.error(
      "[CajaModa] Checkout error:",
      error
    );

    send(
      "CHECKOUT_ERROR",
      {
        message:
          error?.message ||
          "No pudimos abrir el pago seguro."
      }
    );
  }
}

/* ============================================================
   MESSAGE LISTENER
   ============================================================ */

window.addEventListener(
  "message",
  async event => {
    /*
      All CajaModa HTML pages and this bridge
      execute inside the same browser window.
    */

    if (
      event.source !==
      window
    ) {
      return;
    }

    const message =
      event.data ||
      {};

    const acceptedSources =
      new Set([
        "MODAPOP_IFRAME",
        "CAJAMODA_IFRAME",
        "CAJAMODA_STOREFRONT",
        "CAJAMODA_CHECKOUT"
      ]);

    if (
      !acceptedSources.has(
        message.source
      )
    ) {
      return;
    }

    if (
      message.source ===
      "MODAPOP_IFRAME"
    ) {
      responseSource =
        "MODAPOP_WIX";

    } else {
      responseSource =
        "CAJAMODA_WIX";
    }

    const payload =
      message.payload ||
      {};

    switch (
      message.type
    ) {

      /* ======================================================
         READY
         ====================================================== */

      case "READY":
        sendInit();
        break;

      /* ======================================================
         PRODUCT VARIANTS
         ====================================================== */

      case "REQUEST_VARIANTS": {
        const product =
          findProduct(
            payload.productId
          );

        if (
          product
        ) {
          send(
            "VARIANTS",
            {
              productId:
                product.id,

              variants:
                product.variants
            }
          );
        }

        break;
      }

      /* ======================================================
         PRODUCT META
         ====================================================== */

      case "REQUEST_PRODUCT_META": {
        const product =
          findProduct(
            payload.productId
          );

        if (
          product
        ) {
          send(
            "PRODUCT_META",
            product
          );
        }

        break;
      }

      /* ======================================================
         SUPPLY CONTEXT
         ====================================================== */

      case "REQUEST_SUPPLY_CONTEXT":
        send(
          "SUPPLY_CONTEXT",
          {
            enabled:
              true,

            checkoutMode:
              "DEFAULT_LOCATION_NATIVE",

            supportsLocationInventory:
              false,

            supportsReservations:
              false,

            supportsPreorder:
              false,

            supportsCustomMultiLocationCheckout:
              false,

            locations:
              [],

            inventoryItems:
              []
          }
        );

        break;

      /* ======================================================
         PRODUCT SUPPLY
         ====================================================== */

      case "REQUEST_PRODUCT_SUPPLY":
        send(
          "PRODUCT_SUPPLY",
          {
            productId:
              payload.productId,

            locations:
              [],

            inventoryItems:
              []
          }
        );

        break;

      /* ======================================================
         VARIANT INVENTORY
         ====================================================== */

      case "REQUEST_VARIANT_INVENTORY":
        send(
          "VARIANT_INVENTORY",
          {
            productId:
              payload.productId,

            variantId:
              payload.variantId,

            locations:
              [],

            inventoryItems:
              []
          }
        );

        break;

      /* ======================================================
         PURCHASE VALIDATION
         ====================================================== */

      case "VALIDATE_PURCHASE_PATH":
        send(
          "PURCHASE_PATH_STATE",
          {
            allowed:
              true,

            sellable:
              true,

            checkoutMode:
              "DEFAULT_LOCATION_NATIVE",

            supplyIntent:
              payload.supplyIntent ||
              null
          }
        );

        break;

      /* ======================================================
         PRODUCT PAGE ADDED TO BAG
         ====================================================== */

      case "ADD_TO_CART": {
        const localCart=normalizeLocalCart(
          payload?.cart?.items?payload.cart:readBestLocalCart()
        );
        lastCart=localCart;
        saveLocalCart(localCart);
        send("CART_STATE",localCart);

        if(catalog.length && !TEST_MODE){
          queueCartSync(localCart)
            .then(cart=>send("CART_STATE",cart))
            .catch(error=>console.warn("[CajaModa] Cart sync warning:",error));
        }
        break;
      }

      case "SYNC_CART": {
        const localCart = saveLocalCart(
          normalizeLocalCart(payload?.cart || readBestLocalCart())
        );
        send("CART_STATE",localCart);

        if (catalog.length && !TEST_MODE) {
          queueCartSync(localCart)
            .then(cart=>send("CART_STATE",cart))
            .catch(error=>console.warn("[CajaModa] Cart sync warning:",error));
        }
        break;
      }

      /* ======================================================
         GET CART
         ====================================================== */

      case "GET_CART": {
        const cart =
          await getPersistentCart();

        send(
          "CART_STATE",
          cart
        );

        break;
      }

      /* ======================================================
         CREATE REAL PAYMENT
         ====================================================== */

      case "CREATE_CHECKOUT":
        await createPaymentCheckout(
          payload
        );

        break;

      default:
        break;
    }
  }
);

/* ============================================================
   STORAGE SYNC
   ============================================================ */

window.addEventListener(
  "storage",
  event => {
    if (
      event.key ===
      "cajamoda-cart"
    ) {
      const cart =
        readBestLocalCart();

      lastCart = cart;
    }
  }
);

/* ============================================================
   START
   ============================================================ */

async function start() {
  /*
    Maintain the same anonymous Wix visitor
    across Home, Product and Checkout.
  */

  if (!TEST_MODE) await prepareVisitorSession();

  await loadCatalog();
}

start()
  .catch(
    error => {
      console.error(
        "[CajaModa] Wix startup error:",
        error
      );

      /*
        Keep the local storefront usable even
        if Wix temporarily fails.
      */

      lastCart =
        readBestLocalCart();

      send(
        "INIT",
        {
          products:
            catalog,

          sellerId:
            "CAJAMODA",

          storefrontId:
            "CAJAMODA",

          storefrontSlug:
            "cajamoda",

          brand: {
            name:
              "CAJAMODA",

            publicName:
              "CajaModa",

            monogram:
              "CM"
          },

          cart:
            lastCart,

          features: {
            reviewsEnabled:
              false
          }
        }
      );

      send(
        "SUPPLY_ERROR",
        {
          message:
            "No pudimos conectar CajaModa con Wix."
        }
      );
    }
  );
