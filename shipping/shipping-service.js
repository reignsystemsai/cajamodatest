const NATIONAL_MODES = Object.freeze({
  rapido: "fast",
  liberalo: "ship"
});

export const NATIONAL_SHIPPING = Object.freeze({
  rapido: Object.freeze({
    type: "R",
    mode: NATIONAL_MODES.rapido,
    label: "Rápido Nacional",
    estimate: "4–7 días",
    maxDays: 7
  }),
  liberalo: Object.freeze({
    type: "L",
    mode: NATIONAL_MODES.liberalo,
    label: "Libéralo",
    estimate: "14–28 días",
    maxDays: 28
  })
});

export function normalizeEnviaTrackingStatus(value) {
  const status = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (/(delivered|entregado|entregada)/.test(status)) return "delivered";
  if (/(out_for_delivery|reparto|ruta_de_entrega)/.test(status)) return "out_for_delivery";
  if (/(exception|failed|failure|return|cancel|novedad|incidencia)/.test(status)) return "exception";
  if (/(transit|picked|pickup|collected|recolect|en_camino|despach)/.test(status)) return "in_transit";
  return "shipped";
}

export function customerEnviaTrackingLabel(status) {
  if (status === "delivered") return "Entregado";
  if (status === "out_for_delivery") return "En reparto";
  if (status === "in_transit") return "En tránsito";
  if (status === "exception") return "Novedad en el envío";
  return "Enviado";
}

export const STANDARD_CLOTHING_PARCEL = Object.freeze({
  type: "box",
  content: "Ropa para mujer",
  amount: 1,
  lengthUnit: "CM",
  weightUnit: "KG",
  weight: 0.5,
  dimensions: Object.freeze({
    length: 30,
    width: 25,
    height: 5
  })
});

function selectedDeliveryMode(line) {
  return String(
    line?.selectedDeliveryMode ||
    line?.price_data?.product_data?.metadata?.selectedDeliveryMode ||
    ""
  ).trim().toLowerCase();
}

export function nationalShipmentType(line) {
  const mode = selectedDeliveryMode(line);
  if (mode === NATIONAL_MODES.rapido) return "R";
  if (mode === NATIONAL_MODES.liberalo) return "L";
  return "";
}

export function groupNationalShipmentLines(lines = []) {
  const groups = { R: [], L: [] };
  for (const line of Array.isArray(lines) ? lines : []) {
    const type = nationalShipmentType(line);
    if (type) groups[type].push(line);
  }
  return groups;
}

export function nationalShipmentDefinition(type) {
  if (type === "R") return NATIONAL_SHIPPING.rapido;
  if (type === "L") return NATIONAL_SHIPPING.liberalo;
  return null;
}

function descriptionLineText(line) {
  return (Array.isArray(line?.descriptionLines) ? line.descriptionLines : [])
    .map(description => String(
      description?.plainText?.translated ||
      description?.plainText?.original ||
      description?.plainText ||
      ""
    ))
    .join(" ")
    .toLowerCase();
}

export function wixLineNationalShipmentType(line) {
  const description = descriptionLineText(line);
  if (description.includes("libéralo") || description.includes("liberalo")) return "L";
  if (description.includes("rápido") || description.includes("rapido")) return "R";
  return nationalShipmentType(line);
}

export function groupWixOrderNationalLines(order = {}) {
  const groups = { R: [], L: [] };
  for (const line of Array.isArray(order?.lineItems) ? order.lineItems : []) {
    const type = wixLineNationalShipmentType(line);
    if (type) groups[type].push(line);
  }
  return groups;
}

export function nationalLinesDeclaredValue(lines = []) {
  return (Array.isArray(lines) ? lines : []).reduce((total, line) => {
    const quantity = Math.max(1, Math.floor(Number(line?.quantity || 1)));
    const amount = Number(
      line?.price?.amount ||
      line?.price_data?.unit_amount / 100 ||
      line?.unitPrice ||
      (typeof line?.price === "number" ? line.price : 0) ||
      line?.amount ||
      0
    );
    return total + (Number.isFinite(amount) ? Math.max(0, amount) * quantity : 0);
  }, 0);
}

export function buildEnviaNationalPayload({
  origin = {},
  destination = {},
  customer = {},
  carrier = "",
  service = "",
  declaredValue = 0,
  printFormat = "",
  printSize = ""
} = {}) {
  const payload = {
    origin: {
      name: String(origin.name || ""),
      phone: String(origin.phone || ""),
      street: String(origin.street || ""),
      city: String(origin.city || "13001000"),
      state: String(origin.state || "BL"),
      country: "CO",
      postalCode: String(origin.postalCode || "")
    },
    destination: {
      name: String(customer.name || "Cliente CajaModa"),
      phone: String(customer.phone || ""),
      street: String(destination.street || ""),
      city: String(destination.city || ""),
      state: String(destination.state || ""),
      country: "CO",
      postalCode: String(destination.postalCode || "")
    },
    packages: [{
      ...STANDARD_CLOTHING_PARCEL,
      declaredValue: Math.max(1, Math.round(Number(declaredValue) || 1))
    }],
    shipment: {
      type: 1,
      carrier: String(carrier || ""),
      service: String(service || "")
    }
  };
  if (printFormat && printSize) {
    payload.settings = {
      currency: "COP",
      printFormat: String(printFormat),
      printSize: String(printSize)
    };
  }
  return payload;
}

export function buildNationalShipmentPlan(lines = [], quotes = {}) {
  const groups = groupNationalShipmentLines(lines);
  return ["R", "L"]
    .filter(type => groups[type].length)
    .map(type => {
      const definition = nationalShipmentDefinition(type);
      const quote = quotes[type] || {};
      return {
        type,
        mode: definition.mode,
        label: definition.label,
        estimate: definition.estimate,
        maxDays: definition.maxDays,
        items: groups[type],
        fee: Math.max(0, Number(quote.fee || 0)),
        carrier: String(quote.carrier || ""),
        service: String(quote.service || "")
      };
    });
}

export function nationalShipmentCount(lines = []) {
  return buildNationalShipmentPlan(lines).length;
}

export function applyNationalQuoteToPlan(lines = [], quote = {}) {
  const groups = groupNationalShipmentLines(lines);
  const quotes = {
    R: groups.R.length ? quote : {},
    L: groups.L.length ? quote : {}
  };
  return buildNationalShipmentPlan(lines, quotes);
}

export function publicNationalShipmentPlan(plan = []) {
  return (Array.isArray(plan) ? plan : [])
    .filter(shipment => shipment?.type === "R" || shipment?.type === "L")
    .map(shipment => ({
      type: shipment.type,
      label: String(shipment.label || ""),
      estimate: String(shipment.estimate || ""),
      fee: Math.max(0, Number(shipment.fee || 0)),
      carrier: String(shipment.carrier || ""),
      service: String(shipment.service || ""),
      itemCount: Array.isArray(shipment.items)
        ? shipment.items.reduce(
            (total, line) => total + Math.max(1, Math.floor(Number(line?.quantity || 1))),
            0
          )
        : Math.max(0, Math.floor(Number(shipment.itemCount || 0)))
    }));
}

export function nationalShippingSummary(lines = []) {
  return buildNationalShipmentPlan(lines)
    .map(shipment => `${shipment.label} · ${shipment.estimate}`)
    .join(" + ");
}
