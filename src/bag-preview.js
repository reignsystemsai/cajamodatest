(() => {
  "use strict";

  /*
    Home already contains the canonical bag drawer.
    Do not create a second drawer there.
  */
  if(document.getElementById("bagOverlay")){
    return;
  }

  const CART_KEY =
    "cajamoda-cart";

  const CHECKOUT_CART_KEY =
    "cajamoda-checkout-cart";

  let autoCloseTimer =
    null;

  function readJson(
    key,
    fallback
  ){
    try{
      const raw =
        localStorage.getItem(key);

      return raw
        ? JSON.parse(raw)
        : fallback;
    }catch{
      return fallback;
    }
  }

  function saveJson(
    key,
    value
  ){
    try{
      localStorage.setItem(
        key,
        JSON.stringify(value)
      );
    }catch{}
  }

  function normalizePrice(
    ...candidates
  ){
    function readCandidate(
      candidate
    ){
      if(
        candidate === null ||
        candidate === undefined ||
        candidate === ""
      ){
        return null;
      }

      if(
        typeof candidate ===
        "object"
      ){
        const nestedCandidates = [
          candidate.amount,
          candidate.value,
          candidate.discountedPrice,
          candidate.price
        ];

        for(
          const nestedCandidate
          of nestedCandidates
        ){
          const nested =
            readCandidate(
              nestedCandidate
            );

          if(
            nested !== null
          ){
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

    for(
      const candidate
      of candidates
    ){
      const numeric =
        readCandidate(candidate);

      if(numeric !== null){
        return numeric;
      }
    }

    return 0;
  }

  function normalizeCart(
    cart
  ){
    const sourceItems =
      Array.isArray(cart?.items)
        ? cart.items
        : Array.isArray(cart?.lineItems)
          ? cart.lineItems
          : [];

    const items =
      sourceItems.map(
        item => {
          const unitPrice =
            normalizePrice(
              item.unitPrice,
              item.price,
              item.lineItemPrice
            );

          return {
            ...item,

            id:
              item.id ||
              item._id ||
              item.lineItemId ||
              `${Date.now()}-${Math.random()}`,

            quantity:
              Math.max(
                1,
                Number(
                  item.quantity ||
                  1
                )
              ),

            unitPrice,

            price:
              unitPrice
          };
        }
      );

    return {
      items,

      count:
        items.reduce(
          (
            total,
            item
          ) =>
            total +
            item.quantity,
          0
        ),

      total:
        items.reduce(
          (
            total,
            item
          ) =>
            total +
            (
              item.unitPrice *
              item.quantity
            ),
          0
        ),

      revision: Math.max(0,Number(cart?.revision || 0)),
      updatedAt: Math.max(0,Number(cart?.updatedAt || 0)),
      authoritative: cart?.authoritative === true
    };
  }

  function readCart(){
    const checkoutCart =
      readJson(
        CHECKOUT_CART_KEY,
        null
      );

    const regularCart =
      readJson(
        CART_KEY,
        null
      );

    return normalizeCart(
      regularCart !== null
        ? regularCart
        : checkoutCart
    );
  }

  function saveCart(
    cart
  ){
    const normalized =
      normalizeCart(cart);

    normalized.revision = Math.max(
      Number(readJson(CART_KEY,null)?.revision || 0),
      Number(cart?.revision || 0)
    ) + 1;
    normalized.updatedAt = Date.now();
    normalized.authoritative = true;

    saveJson(
      CART_KEY,
      normalized
    );

    saveJson(
      CHECKOUT_CART_KEY,
      normalized
    );

    window.postMessage({
      source:"CAJAMODA_STOREFRONT",
      type:"SYNC_CART",
      payload:{cart:normalized}
    },"*");

    updateExistingBadges(
      normalized.count
    );

    window.dispatchEvent(new CustomEvent("cajamoda:cart-updated",{detail:normalized}));

    renderBag();

    return normalized;
  }

  function money(
    amount
  ){
    return new Intl.NumberFormat(
      "es-CO",
      {
        style:
          "currency",

        currency:
          "COP",

        maximumFractionDigits:
          0
      }
    ).format(
      Number(amount || 0)
    );
  }

  function escapeHtml(
    value
  ){
    return String(value ?? "")
      .replaceAll("&","&amp;")
      .replaceAll("<","&lt;")
      .replaceAll(">","&gt;")
      .replaceAll('"',"&quot;")
      .replaceAll("'","&#039;");
  }

  function updateExistingBadges(
    count
  ){
    [
      "photoBagBadge",
      "detailsBagCount",
      "navBagBadge",
      "headerBagBadge",
      "bottomBagBadge",
      "topBagBadge"
    ].forEach(
      id => {
        const badge =
          document.getElementById(id);

        if(badge){
          badge.textContent =
            String(count);
        }
      }
    );
  }

  const style =
    document.createElement(
      "style"
    );

  style.textContent = `
    #sharedBagOverlay{
      position:fixed;
      inset:0;
      z-index:9999;
      display:flex;
      align-items:flex-end;
      justify-content:center;
      padding:8px;
      background:rgba(0,0,0,.10);
      backdrop-filter:blur(6px);
      -webkit-backdrop-filter:blur(6px);
      opacity:0;
      visibility:hidden;
      pointer-events:none;
      transition:opacity .18s ease,visibility .18s ease;
    }

    #sharedBagOverlay.open{
      opacity:1;
      visibility:visible;
      pointer-events:auto;
    }

    .sharedBagDrawer{
      width:min(100%,520px);
      max-height:79dvh;
      overflow-y:auto;
      padding:14px 13px calc(15px + env(safe-area-inset-bottom));
      border:1px solid rgba(255,255,255,.98);
      border-radius:23px;
      background:linear-gradient(145deg,rgba(255,255,255,.95),rgba(255,255,255,.60));
      box-shadow:
        0 0 0 1px rgba(0,0,0,.04),
        inset 0 1px 0 #fff,
        0 20px 48px rgba(0,0,0,.10);
      backdrop-filter:blur(31px) saturate(178%);
      -webkit-backdrop-filter:blur(31px) saturate(178%);
    }

    .sharedBagHeader{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
      padding-bottom:7px;
    }

    .sharedBagTitle{
      color:#090909;
      font-family:Inter,Arial,sans-serif;
      font-size:16px;
      font-weight:800;
    }

    .sharedBagSubtitle{
      margin-top:2px;
      color:#777;
      font-size:7px;
    }

    .sharedBagBulkActions{
      display:flex;
      align-items:center;
      gap:12px;
      padding:5px 0 8px;
      border-bottom:1px solid rgba(0,0,0,.07);
    }

    .sharedBagBulkButton{
      padding:0;
      border:0;
      background:none;
      color:#555;
      font-size:8px;
      font-weight:700;
      cursor:pointer;
    }

    .sharedBagBulkButton:disabled{opacity:.35}

    .sharedBagSelect{
      width:18px;
      height:18px;
      margin:0;
      accent-color:#080808;
    }

    .sharedBagClose{
      width:39px;
      height:39px;
      flex:none;
      display:grid;
      place-items:center;
      border:1px solid rgba(255,255,255,.92);
      border-radius:50%;
      background:rgba(255,255,255,.72);
      color:#111;
      font-size:20px;
      cursor:pointer;
    }

    .sharedBagItem{
      display:grid;
      grid-template-columns:18px 61px 1fr auto;
      gap:9px;
      padding:10px 0;
      border-bottom:1px solid rgba(0,0,0,.07);
    }

    .sharedBagImage{
      width:61px;
      height:76px;
      overflow:hidden;
      border-radius:10px;
      background:#ececec;
    }

    .sharedBagImage img{
      width:100%;
      height:100%;
      object-fit:cover;
    }

    .sharedBagName{
      color:#111;
      font-size:9px;
      font-weight:800;
    }

    .sharedBagOptions{
      margin-top:4px;
      color:#777;
      font-size:7px;
      line-height:1.45;
    }

    .sharedBagControls{
      margin-top:8px;
      display:flex;
      align-items:center;
      gap:8px;
    }

    .sharedBagQuantityButton{
      width:29px;
      height:29px;
      display:grid;
      place-items:center;
      border:1px solid rgba(0,0,0,.10);
      border-radius:50%;
      background:rgba(255,255,255,.64);
      color:#111;
      cursor:pointer;
    }

    .sharedBagQuantity{
      min-width:16px;
      text-align:center;
      font-size:9px;
      font-weight:800;
    }

    .sharedBagRemove{
      margin-top:8px;
      padding:0;
      border:0;
      background:none;
      color:#777;
      font-size:7px;
      text-decoration:underline;
      cursor:pointer;
    }

    .sharedBagPrice{
      color:#111;
      font-size:9px;
      font-weight:800;
      white-space:nowrap;
    }

    .sharedBagEmpty{
      padding:28px 8px;
      color:#777;
      font-size:9px;
      text-align:center;
    }

    .sharedBagSummary{
      padding-top:10px;
    }

    .sharedBagSummaryRow{
      display:flex;
      justify-content:space-between;
      padding:7px 0;
      color:#555;
      font-size:8px;
    }

    .sharedBagSummaryTotal{
      color:#111;
      font-size:13px;
      font-weight:800;
    }

    .sharedBagCheckout{
      width:100%;
      height:48px;
      margin-top:8px;
      border:0;
      border-radius:14px;
      background:#090909;
      color:#fff;
      font-size:9px;
      font-weight:800;
      cursor:pointer;
    }

    .sharedBagCheckout:disabled{
      opacity:.42;
      cursor:not-allowed;
    }
  `;

  document.head.appendChild(
    style
  );

  const overlay =
    document.createElement(
      "div"
    );

  overlay.id =
    "sharedBagOverlay";

  overlay.innerHTML = `
    <section
      class="sharedBagDrawer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sharedBagTitle"
    >
      <header class="sharedBagHeader">
        <div>
          <div
            id="sharedBagTitle"
            class="sharedBagTitle"
          >
            Mi bolsa
          </div>

          <div class="sharedBagSubtitle">
            Revisa tus productos antes de pagar.
          </div>
        </div>

        <button
          id="sharedBagClose"
          class="sharedBagClose"
          type="button"
          aria-label="Cerrar bolsa"
        >
          ×
        </button>
      </header>

      <div class="sharedBagBulkActions">
        <button id="sharedBagSelectAll" class="sharedBagBulkButton" type="button">Seleccionar todo</button>
        <button id="sharedBagRemoveSelected" class="sharedBagBulkButton" type="button" disabled>Eliminar seleccionados</button>
      </div>

      <div id="sharedBagItems"></div>

      <div
        id="sharedBagEmpty"
        class="sharedBagEmpty"
        hidden
      >
        Tu bolsa está vacía.
        <br>
        Encuentra algo que te encante.
      </div>

      <div class="sharedBagSummary">
        <div class="sharedBagSummaryRow">
          <span>Productos</span>
          <span id="sharedBagCount">0</span>
        </div>

        <div class="sharedBagSummaryRow sharedBagSummaryTotal">
          <span>Subtotal</span>
          <span id="sharedBagSubtotal">$0</span>
        </div>

        <button
          id="sharedBagCheckout"
          class="sharedBagCheckout"
          type="button"
        >
          Ir a pagar
        </button>
      </div>
    </section>
  `;

  document.body.appendChild(
    overlay
  );

  const drawer =
    overlay.querySelector(
      ".sharedBagDrawer"
    );

  const itemsElement =
    document.getElementById(
      "sharedBagItems"
    );

  const emptyElement =
    document.getElementById(
      "sharedBagEmpty"
    );

  const countElement =
    document.getElementById(
      "sharedBagCount"
    );

  const subtotalElement =
    document.getElementById(
      "sharedBagSubtotal"
    );

  const checkoutButton =
    document.getElementById(
      "sharedBagCheckout"
    );

  const selectedItems = new Set();
  const selectAllButton = document.getElementById("sharedBagSelectAll");
  const removeSelectedButton = document.getElementById("sharedBagRemoveSelected");

  function syncBulkActions(cart){
    const validIds = new Set(cart.items.map(item => String(item.id)));
    [...selectedItems].forEach(id => {
      if(!validIds.has(id)) selectedItems.delete(id);
    });

    const allSelected = cart.items.length > 0 && cart.items.every(item => selectedItems.has(String(item.id)));
    selectAllButton.textContent = allSelected ? "Deseleccionar todo" : "Seleccionar todo";
    selectAllButton.disabled = cart.items.length === 0;
    removeSelectedButton.disabled = selectedItems.size === 0;
  }

  function cancelAutoClose(){
    clearTimeout(
      autoCloseTimer
    );

    autoCloseTimer =
      null;
  }

  function closeBag(){
    cancelAutoClose();

    overlay.classList.remove(
      "open"
    );

    document.body.style.overflow =
      "";
  }

  function scheduleAutoClose(){
    cancelAutoClose();
  }

  function renderBag(){
    const cart =
      readCart();

    document.getElementById(
      "sharedBagTitle"
    ).textContent =
      `Mi bolsa (${cart.count})`;

    countElement.textContent =
      String(cart.count);

    subtotalElement.textContent =
      money(cart.total);

    checkoutButton.disabled =
      cart.items.length === 0;

    emptyElement.hidden =
      cart.items.length !== 0;

    itemsElement.innerHTML =
      cart.items.map(
        item => `
          <article class="sharedBagItem">
            <input class="sharedBagSelect" type="checkbox" data-shared-select="${escapeHtml(item.id)}" aria-label="Seleccionar ${escapeHtml(item.name || "Producto")}" ${selectedItems.has(String(item.id)) ? "checked" : ""}>
            <div class="sharedBagImage">
              ${
                item.image
                  ? `
                    <img
                      src="${escapeHtml(item.image)}"
                      alt="${escapeHtml(item.name)}"
                    >
                  `
                  : ""
              }
            </div>

            <div>
              <div class="sharedBagName">
                ${escapeHtml(item.name || "Producto")}
              </div>

              <div class="sharedBagOptions">
                ${
                  item.color
                    ? `Color: ${escapeHtml(item.color)}<br>`
                    : ""
                }

                ${
                  item.size
                    ? `Talla: ${escapeHtml(item.size)}`
                    : ""
                }
              </div>

              <div class="sharedBagControls">
                <button
                  class="sharedBagQuantityButton"
                  type="button"
                  data-shared-minus="${escapeHtml(item.id)}"
                  aria-label="Reducir cantidad"
                >
                  −
                </button>

                <span class="sharedBagQuantity">
                  ${item.quantity}
                </span>

                <button
                  class="sharedBagQuantityButton"
                  type="button"
                  data-shared-plus="${escapeHtml(item.id)}"
                  aria-label="Aumentar cantidad"
                >
                  +
                </button>
              </div>

              <button
                class="sharedBagRemove"
                type="button"
                data-shared-remove="${escapeHtml(item.id)}"
              >
                Eliminar
              </button>
            </div>

            <div class="sharedBagPrice">
              ${money(item.unitPrice * item.quantity)}
            </div>
          </article>
        `
      ).join("");

    updateExistingBadges(
      cart.count
    );

    syncBulkActions(cart);
  }

  function changeQuantity(
    itemId,
    amount
  ){
    const cart =
      readCart();

    const item =
      cart.items.find(
        candidate =>
          String(candidate.id) ===
          String(itemId)
      );

    if(!item){
      return;
    }

    item.quantity +=
      amount;

    if(item.quantity <= 0){
      cart.items =
        cart.items.filter(
          candidate =>
            String(candidate.id) !==
            String(itemId)
        );
    }

    saveCart(cart);
  }

  function removeItem(
    itemId
  ){
    const cart =
      readCart();

    cart.items =
      cart.items.filter(
        item =>
          String(item.id) !==
          String(itemId)
      );

    saveCart(cart);
  }

  function openBag(){
    renderBag();

    overlay.classList.add(
      "open"
    );

    document.body.style.overflow =
      "hidden";

    scheduleAutoClose();
  }

  [
    "pointerdown",
    "touchstart",
    "wheel",
    "scroll",
    "focusin",
    "keydown"
  ].forEach(
    eventName => {
      drawer.addEventListener(
        eventName,
        scheduleAutoClose
      );
    }
  );

  document.getElementById(
    "sharedBagClose"
  ).onclick =
    closeBag;

  overlay.onclick =
    event => {
      if(event.target === overlay){
        closeBag();
      }
    };

  itemsElement.onclick =
    event => {
      const minus =
        event.target.closest(
          "[data-shared-minus]"
        );

      const plus =
        event.target.closest(
          "[data-shared-plus]"
        );

      const remove =
        event.target.closest(
          "[data-shared-remove]"
        );

      const select = event.target.closest("[data-shared-select]");

      if(select){
        const id = String(select.dataset.sharedSelect);
        select.checked ? selectedItems.add(id) : selectedItems.delete(id);
        syncBulkActions(readCart());
        return;
      }

      if(minus){
        changeQuantity(
          minus.dataset.sharedMinus,
          -1
        );
      }

      if(plus){
        changeQuantity(
          plus.dataset.sharedPlus,
          1
        );
      }

      if(remove){
        removeItem(
          remove.dataset.sharedRemove
        );
      }
    };

  selectAllButton.onclick = () => {
    const cart = readCart();
    const allSelected = cart.items.length > 0 && cart.items.every(item => selectedItems.has(String(item.id)));
    selectedItems.clear();
    if(!allSelected) cart.items.forEach(item => selectedItems.add(String(item.id)));
    renderBag();
  };

  removeSelectedButton.onclick = () => {
    const cart = readCart();
    cart.items = cart.items.filter(item => !selectedItems.has(String(item.id)));
    selectedItems.clear();
    saveCart(cart);
  };

  checkoutButton.onclick =
    () => {
      const cart =
        readCart();

      if(!cart.items.length){
        return;
      }

      saveCart(cart);

      if(
        location.pathname.startsWith(
          "/checkout"
        )
      ){
        closeBag();
        return;
      }

      location.href =
        "/checkout/";
    };

  const bagSelector = [
    "#photoBag",
    "#detailsBag",
    "#navBag",
    "#headerBag",
    "#bottomBagButton",
    'a.bottomNavItem[href="/checkout/"]'
  ].join(",");

  document.addEventListener(
    "click",
    event => {
      const bagButton =
        event.target.closest(
          bagSelector
        );

      if(!bagButton){
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();

      openBag();
    },
    true
  );

  window.addEventListener(
    "storage",
    event => {
      if(
        event.key === CART_KEY ||
        event.key === CHECKOUT_CART_KEY
      ){
        renderBag();
      }
    }
  );

  window.addEventListener("pagehide",closeBag);
  window.addEventListener("pageshow",closeBag);

  document.addEventListener("visibilitychange",() => {
    if(document.hidden){
      closeBag();
    }
  });

  window.CajaModaBagPreview = {
    open:
      openBag,

    close:
      closeBag,

    render:
      renderBag
  };
})();
