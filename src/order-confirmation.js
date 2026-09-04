const API_BASE =
  import.meta.env.VITE_STORE_API_URL ||
  "https://cajamoda-storeload-api.onrender.com";

const $ = id => document.getElementById(id);
const confirmationQuery = new URLSearchParams(location.search);

function confirmationReference(queryName, storageKey) {
  const queryValue = confirmationQuery.get(queryName) || "";
  if (queryValue) {
    try { sessionStorage.setItem(storageKey, queryValue); } catch {}
    return queryValue;
  }
  try { return sessionStorage.getItem(storageKey) || ""; }
  catch { return ""; }
}

const checkoutId = (() => {
  const query = new URLSearchParams(location.search).get("checkoutId");
  if (query) return query;
  try { return localStorage.getItem("cajamoda-pending-checkout") || ""; }
  catch { return ""; }
})();

const stripeSessionId = confirmationReference("stripeSessionId", "cajamoda-confirmation-stripe-session");
const paymentIntentId = confirmationReference("paymentIntent", "cajamoda-confirmation-payment-intent");
const nequiOrderNumber = new URLSearchParams(location.search).get("nequiOrder") || "";

if (confirmationQuery.has("stripeSessionId") || confirmationQuery.has("paymentIntent")) {
  history.replaceState(history.state, document.title, `${location.pathname}${location.hash}`);
}

let confirmation = null;
const shareButtons = Array.from(document.querySelectorAll("[data-share-channel]"));

function displayOrderNumber(order) {
  const wixNumber = String(order?.number ?? "").replace(/^#/, "").trim();
  const stableId = String(order?.id ?? "").replace(/[^a-z0-9]/gi, "");
  const value = wixNumber && wixNumber !== "0"
    ? wixNumber
    : stableId
      ? stableId.slice(-8).toUpperCase()
      : "SIN-ID";
  return value.startsWith("CM-") ? value : `CM-${value}`;
}

function renderOrderNumber(order) {
  $("orderNumber").textContent = `Pedido #${displayOrderNumber(order)}`;
}

function setReferralAvailable(available) {
  $("shareIcons").hidden = !available;
  shareButtons.forEach(button => { button.disabled = !available; });
}

function setShareBusy(busy) {
  shareButtons.forEach(button => { button.disabled = busy; });
}

function setStatus(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
}

function renderShipmentCards(shipments) {
  const container = $("shipmentCards");
  const nationalShipments = Array.isArray(shipments) ? shipments : [];
  container.replaceChildren();
  container.hidden = !nationalShipments.length;

  nationalShipments.forEach(shipment => {
    const type = String(shipment?.type || "").toUpperCase();
    const hasTracking = Boolean(shipment?.trackingNumber);
    const card = document.createElement("article");
    card.className = "shipmentCard";

    const heading = document.createElement("div");
    heading.className = "shipmentHeading";
    const title = document.createElement("div");
    title.className = "shipmentTitle";
    title.textContent = shipment?.label || (type === "L" ? "Libéralo" : "Rápido y Fácil");
    const status = document.createElement("div");
    status.className = "shipmentStatus";
    status.textContent = shipment?.statusLabel ||
      (shipment?.status === "delivered"
        ? "Entregado"
        : shipment?.status === "out_for_delivery"
          ? "En reparto"
          : shipment?.status === "in_transit"
            ? "En tránsito"
            : shipment?.status === "exception"
              ? "Novedad en el envío"
              : hasTracking
                ? "Enviado"
                : type === "L"
                  ? "Libéralo en proceso"
                  : "Listo para enviar");
    heading.append(title, status);

    const message = document.createElement("p");
    message.className = "shipmentMessage";
    message.textContent = type === "L" && !hasTracking
      ? "Seguimiento de Envia pendiente. Recibirás tu número cuando el paquete esté listo para salir desde Cartagena. Entrega estimada: 14–28 días."
      : !hasTracking
        ? `Preparando tu envío desde Cartagena. Entrega estimada: ${shipment?.estimate || "4–7 días"}.`
        : `Entrega estimada: ${shipment?.estimate || (type === "L" ? "14–28 días" : "4–7 días")}.`;

    card.append(heading, message);

    if (hasTracking) {
      const tracking = document.createElement("div");
      tracking.className = "shipmentTracking";
      const carrier = shipment?.carrier ? `${shipment.carrier} · ` : "";
      tracking.append(document.createTextNode(`${carrier}${shipment.trackingNumber}`));
      if (shipment?.trackingLink) {
        tracking.append(document.createTextNode(" · "));
        const link = document.createElement("a");
        link.href = shipment.trackingLink;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = "Rastrear envío";
        tracking.append(link);
      }
      card.append(tracking);
    }

    container.append(card);
  });
}

async function loadConfirmation() {
  if (nequiOrderNumber) {
    $("confirmationTitle").textContent = "PEDIDO RECIBIDO";
    renderOrderNumber({ number: nequiOrderNumber });
    $("paymentStatus").textContent = "Pago Nequi por confirmar";
    $("deliveryMethod").textContent = "Entrega CajaModa";
    $("deliveryMessage").textContent = "Confirmaremos el pago y te enviaremos la información de entrega.";
    setReferralAvailable(false);
    setStatus("Tu pedido está reservado mientras verificamos el pago.");
    try { localStorage.removeItem("cajamoda-pending-nequi-order"); } catch {}
    return;
  }
  if (paymentIntentId) {
    const response = await fetch(
      `${API_BASE}/api/stripe/intent-confirmation?paymentIntent=${encodeURIComponent(paymentIntentId)}`,
      { headers: { Accept: "application/json" } }
    );
    const payload = await response.json();
    if (!response.ok || !payload?.ok || (!payload?.order?.paid && !payload?.order?.authorized)) {
      throw new Error(payload?.error || "El pago todavía no está confirmado.");
    }
    confirmation = payload.order;
    renderShipmentCards(confirmation.shipments);
    $("confirmationTitle").textContent = confirmation.paid ? "COMPRA CONFIRMADA" : "PAGO AUTORIZADO";
    renderOrderNumber(confirmation);
    $("paymentStatus").textContent = confirmation.payment;
    $("deliveryMethod").textContent = confirmation.delivery?.method || "Entrega CajaModa";
    $("deliveryMessage").textContent = confirmation.delivery?.message || "Te enviaremos actualizaciones por correo.";
    setReferralAvailable(Boolean(checkoutId));
    try { localStorage.removeItem("cajamoda-pending-stripe-intent"); } catch {}
    return;
  }
  if (stripeSessionId) {
    const response = await fetch(
      `${API_BASE}/api/stripe/confirmation?sessionId=${encodeURIComponent(stripeSessionId)}`,
      { headers: { Accept: "application/json" } }
    );
    const payload = await response.json();
    if (!response.ok || !payload?.ok || (!payload?.order?.paid && !payload?.order?.authorized)) {
      throw new Error(payload?.error || "El pago todavía no está confirmado.");
    }
    confirmation = payload.order;
    renderShipmentCards(confirmation.shipments);
    $("confirmationTitle").textContent = confirmation.paid ? "COMPRA CONFIRMADA" : "PAGO AUTORIZADO";
    renderOrderNumber(confirmation);
    $("paymentStatus").textContent = confirmation.payment;
    $("deliveryMethod").textContent = confirmation.delivery?.method || "Entrega CajaModa";
    $("deliveryMessage").textContent = confirmation.delivery?.message || "Te enviaremos actualizaciones por correo.";
    setReferralAvailable(Boolean(checkoutId));
    return;
  }
  if (!checkoutId) throw new Error("No encontramos el identificador de tu compra.");

  const response = await fetch(
    `${API_BASE}/api/order-confirmation?checkoutId=${encodeURIComponent(checkoutId)}`,
    { headers: { Accept: "application/json" } }
  );
  const payload = await response.json();
  if (!response.ok || !payload?.ok) throw new Error(payload?.error || "No pudimos confirmar tu compra.");

  confirmation = payload.order;
  renderShipmentCards(confirmation.shipments);
  $("confirmationTitle").textContent = "COMPRA CONFIRMADA";
  renderOrderNumber(confirmation);
  $("paymentStatus").textContent = confirmation.payment;
  $("deliveryMethod").textContent = confirmation.delivery?.method || "Método de entrega confirmado";
  $("deliveryMessage").textContent = confirmation.delivery?.message || "Te enviaremos actualizaciones sobre tu pedido.";
  setReferralAvailable(true);
  try { localStorage.removeItem("cajamoda-pending-checkout"); } catch {}
}

async function createReferral(channel) {
  if (!confirmation || !checkoutId) return;
  setShareBusy(true);
  setStatus("Preparando el descuento…");

  try {
    const response = await fetch(`${API_BASE}/api/referrals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ checkoutId })
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || "No pudimos preparar el descuento.");

    $("referralCode").hidden = false;
    $("referralCode").textContent = `Código ${payload.code} · un solo uso`;
    const shareText = `Te regalo 10% en CajaModa. Usa el código ${payload.code}: ${payload.url}`;

    if (channel === "whatsapp") {
      window.open(`https://wa.me/?text=${encodeURIComponent(shareText)}`, "_blank", "noopener,noreferrer");
      setStatus(`Código ${payload.code} listo para compartir.`);
    } else if (navigator.share) {
      await navigator.share({ title: "10% en CajaModa", text: shareText, url: payload.url });
      setStatus(`Código ${payload.code} listo para tu amiga.`);
    } else {
      await navigator.clipboard.writeText(shareText);
      setStatus(`Código ${payload.code} y enlace copiados.`);
    }
  } catch (error) {
    if (error?.name !== "AbortError") setStatus(error?.message || "No pudimos compartir el descuento.", true);
  } finally {
    setShareBusy(false);
  }
}

shareButtons.forEach(button => {
  button.addEventListener("click", () => createReferral(button.dataset.shareChannel || ""));
});

loadConfirmation().catch(error => {
  $("confirmationTitle").textContent = "COMPRA RECIBIDA";
  $("paymentStatus").textContent = "Revisa tu correo de confirmación";
  setStatus(error?.message || "No pudimos cargar los detalles.", true);
});
