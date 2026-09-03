// Document schemas for the test injector's synthetic datasets.
//
// Shapes mirror the memory-benchmarks-compare datasets (tasks / orders / movies)
// so generated NDJSON is format-compatible with that repo's dataset folder —
// the injector accepts either. ALL content is fabricated; only the structure
// matches. Each schema is `{ name, build(rng, ctx) }` where ctx carries the
// zero-based sequence number; generation is deterministic per --seed.

// ─── Deterministic RNG (mulberry32) ────────────────────────────
export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,                                        // [0,1)
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),   // inclusive
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    weighted: (values, weights) => {
      const total = weights.reduce((s, w) => s + w, 0);
      let roll = next() * total;
      for (let i = 0; i < values.length; i++) {
        roll -= weights[i];
        if (roll <= 0) return values[i];
      }
      return values[values.length - 1];
    },
  };
}

export function uuid(rng) {
  const hex = () => rng.int(0, 15).toString(16);
  let s = '';
  for (let i = 0; i < 32; i++) s += hex();
  const v4 = s.slice(0, 12) + '4' + s.slice(13, 16)
    + '89ab'[rng.int(0, 3)] + s.slice(17);
  return `${v4.slice(0, 8)}-${v4.slice(8, 12)}-${v4.slice(12, 16)}-${v4.slice(16, 20)}-${v4.slice(20)}`;
}

const iso = (d) => d.toISOString().replace('Z', '000Z'); // µs-precision look of the source format

// ═══ tasks — tiny CRUD docs (benchmarks: datasets/tasks) ═════════
const TASK_NAMES = [
  'Update roadmap', 'Migrate incident review', 'Audit sync scopes',
  'Tune compaction window', 'Review mesh topology', 'Draft runbook',
  'Rotate playground tokens', 'Profile query plan', 'Prune tombstones',
];
const TASK_DETAILS = [
  'Coordinate with the team and confirm it is ready.',
  'Clean up the stale entries and archive the report.',
  'Verify behaviour against a two-peer LAN mesh.',
  'Capture before/after numbers for the comparison sheet.',
];

const tasks = {
  name: 'tasks',
  build(rng) {
    return {
      _id: uuid(rng),
      name: rng.pick(TASK_NAMES),
      details: rng.pick(TASK_DETAILS),
      isCompleted: rng.next() < 0.5,
      isDeleted: false,
    };
  },
};

// ═══ movies — mflix-shaped docs (benchmarks: datasets/movies) ════
const MOVIE_WORDS = ['Iron', 'Silent', 'Golden', 'Crimson', 'Electric', 'Paper', 'Midnight', 'Cedar', 'Neon', 'Hollow'];
const GENRES = ['Short', 'Western', 'Drama', 'Comedy', 'Documentary', 'Animation'];
const RATED = ['UNRATED', 'G', 'PG', 'PG-13', 'R'];
const FIRST = ['Charles', 'Alice', 'Broncho', 'Mabel', 'Orson', 'Hedy', 'Buster', 'Clara'];
const LAST = ['Kayser', 'Ott', 'Anderson', 'Barnes', 'Dickson', 'Keaton', 'Bow', 'Lamarr'];

const sentence = (rng, n) => Array.from({ length: n }, () =>
  `${rng.pick(MOVIE_WORDS)} ${rng.pick(['meets', 'falls into', 'escapes', 'discovers', 'betrays'])} ${rng.pick(MOVIE_WORDS).toLowerCase()}.`,
).join(' ');

const movies = {
  name: 'movies',
  build(rng, ctx) {
    const title = `The ${rng.pick(MOVIE_WORDS)} ${rng.pick(MOVIE_WORDS)}`;
    const year = String(rng.int(1893, 2026));
    const wins = rng.int(0, 12);
    const nominations = wins + rng.int(0, 8);
    const rating = Math.round(rng.next() * 90 + 10) / 10;
    return {
      _id: { id: uuid(rng).replaceAll('-', '').slice(0, 24), title, year, type: 'movie' },
      plot: sentence(rng, 1),
      genres: [...new Set([rng.pick(GENRES), rng.pick(GENRES)])],
      runtime: rng.int(1, 180),
      cast: Array.from({ length: rng.int(1, 4) }, () => `${rng.pick(FIRST)} ${rng.pick(LAST)}`),
      num_mflix_comments: rng.int(0, 40),
      fullplot: sentence(rng, 6),
      countries: ['USA'],
      released: iso(new Date(Date.UTC(Number(year), rng.int(0, 11), rng.int(1, 28)))),
      directors: [`${rng.pick(FIRST)} ${rng.pick(LAST)}`],
      rated: rng.pick(RATED),
      awards: { wins, nominations, text: `${wins} wins.` },
      lastupdated: `2015-08-26 00:0${ctx.seq % 10}:50.133000000`,
      imdb: { rating, votes: rng.int(50, 900_000), id: ctx.seq + 5 },
      tomatoes: {
        viewer: { rating: rng.int(1, 5), numReviews: rng.int(10, 5_000), meter: rng.int(0, 100) },
        lastUpdated: iso(new Date(Date.UTC(2015, 5, 28))),
      },
    };
  },
};

// ═══ orders — QSR order docs (benchmarks: datasets/orders) ═══════
// Ported from tools/generate-orders.py in the benchmarks repo; the nested
// model_data.order structure (cart/taxes/status/timestamps/store/payments)
// is preserved field-for-field, values are fabricated.
const PRODUCTS = [
  ['Zesty Bean Wrap', '700101'], ['Crispy Ranch Roll', '700102'],
  ['Spicy Corn Pocket', '700103'], ['Smoky Pepper Bowl', '700104'],
  ['Garden Crunch Cup', '700105'], ['Fiesta Rice Plate', '700106'],
  ['Toasted Cheese Stick', '700107'], ['Loaded Spud Bites', '700108'],
];
const BUNDLES = [
  ['Value Duo Box', '800201'], ['Family Feast Pack', '800202'], ['Solo Combo Tray', '800203'],
];
const MODIFIERS = [
  ['Smoky Pepper Blend', '9001'], ['Crumbled Plant Protein', '9002'],
  ['Shredded Carrot Mix', '9003'], ['Tangy Lime Drizzle', '9004'],
  ['Toasted Onion Bits', '9005'], ['Creamy Avocado Spread', '9006'],
];
const SLOTS = [['Protein Choices', 'SLOT_PROTEIN'], ['Toppings', 'SLOT_TOPPINGS'], ['Sauces', 'SLOT_SAUCE']];
const EMP_FIRST = ['Riley', 'Jordan', 'Casey', 'Morgan', 'Avery', 'Quinn'];
const EMP_LAST = ['Brooks', 'Nguyen', 'Patel', 'Garza', 'Okafor', 'Romano'];
const TITLES = ['Crew Member', 'Shift Lead', 'Assistant Manager', 'Cashier'];
const STATION_TYPES = ['Drive Thru Cashier', 'Front Counter', 'Kitchen Display', 'Expo'];
const CITIES = [
  ['Maplewood', 'Ohio', 'America/New_York', 41.0, -81.5],
  ['Cedar Falls', 'Iowa', 'America/Chicago', 42.5, -92.4],
  ['Stony Creek', 'Texas', 'America/Chicago', 30.3, -97.7],
  ['Fox Harbor', 'Oregon', 'America/Los_Angeles', 45.5, -122.6],
];
const OCCASIONS = ['DRIVE_THRU', 'DINE_IN', 'TAKEOUT'];
const POS_FLOW = ['EDITING', 'SALE_PENDING', 'EDITING', 'SALE_PENDING', 'SALE_COMPLETE'];
const INSTORE_FLOW = ['INIT', 'ENTERED'];
const LINE_ITEM_COUNTS = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15];
const LINE_ITEM_WEIGHTS = [20, 22, 18, 12, 9, 6, 4, 3, 3, 2, 1];

const money = (cents) => ({ amount: Math.round(cents), currencyCode: 'USD' });

function modifier(rng) {
  const [name, code] = rng.pick(MODIFIERS);
  const weight = { name: 'Regular', price: money(0), value: 2.0, code };
  return {
    id: uuid(rng), code, name,
    slotCode: rng.pick(SLOTS)[1],
    selectedWeight: weight, defaultWeight: weight,
    modifierStatus: 'DEFAULT', regulatoryTags: [],
  };
}

function lineItem(rng, isBundle) {
  const [name, code] = rng.pick(isBundle ? BUNDLES : PRODUCTS);
  const qty = rng.int(1, 3);
  const unit = rng.int(99, 899);
  const full = unit * qty;
  const mods = Array.from({ length: rng.int(0, 4) }, () => modifier(rng));
  const slots = mods.map(m => ({
    slotId: m.slotCode, name: rng.pick(SLOTS)[0], orderModifiers: [m],
    exclusiveModifier: rng.next() < 0.5,
    validity: { __typename: 'Valid' }, brandTags: [],
  }));
  const item = {
    __typename: isBundle ? 'ORDER_BUNDLE' : 'ORDER_PRODUCT',
    id: uuid(rng), name, menuProductCode: code,
    menuItemTypes: [], quantity: qty,
    selectedVariant: {
      name, code,
      selectedOptions: [{ code: 'singlevariant', optionTypeCode: 'singlevariant' }],
      floorPrice: money(unit), regulatoryTags: [], brandTags: [],
    },
    modifiers: mods, slots,
    unitPrice: money(unit), fullPrice: money(full),
    promotions: [], fullPriceAfterPromotions: money(full),
    regulatoryTags: [],
  };
  if (isBundle) {
    item.selectedChoices = Array.from({ length: rng.int(1, 3) }, () => {
      const [n, c] = rng.pick(PRODUCTS);
      return { id: uuid(rng), name: n, code: c };
    });
  }
  return { item, full };
}

function taxes(rng, items, totals) {
  const net = totals.reduce((s, t) => s + t, 0);
  const taxTotal = Math.round(net * 0.10);
  const ruleId = uuid(rng);
  return [{
    name: 'Sales Tax 1', amount: money(taxTotal),
    taxByRules: [{
      ruleId, ruleName: '10% Sales Tax',
      total: money(taxTotal), roundingMode: 'CLOSEST',
      hasRegulatoryTag: false, isTaxInclusive: false,
      taxes: items.map((li, i) => ({
        __typename: 'LINE_ITEM', amount: Math.round(totals[i] * 0.10), itemId: li.id,
      })),
    }],
  }, taxTotal];
}

function transitions(rng, base, flow) {
  const out = [];
  let t = base;
  for (const status of flow) {
    out.push({ status, timestamp: iso(t) });
    t = new Date(t.getTime() + rng.int(5, 45) * 1000);
  }
  return out;
}

function employeeEdits(rng, base, station) {
  const empId = String(rng.int(1000, 9999));
  const name = `${rng.pick(EMP_FIRST)} ${rng.pick(EMP_LAST)}`;
  const title = rng.pick(TITLES);
  const stype = rng.pick(STATION_TYPES);
  const extras = ['RECALL', 'PAYMENT', 'EDIT', 'TENDER'].sort(() => rng.next() - 0.5).slice(0, rng.int(1, 3));
  let t = base;
  return ['ORDERED', ...extras].map(a => {
    const edit = {
      actionType: a, employeeId: empId, employeeName: name,
      employeeTitle: title, stationName: station, stationType: stype,
      timestamp: iso(t),
    };
    t = new Date(t.getTime() + rng.int(10, 60) * 1000);
    return edit;
  });
}

const orders = {
  name: 'orders',
  build(rng, ctx) {
    const org = ctx.org;
    const store = ctx.store;
    const orderId = uuid(rng);
    const nItems = rng.weighted(LINE_ITEM_COUNTS, LINE_ITEM_WEIGHTS);
    const lineItems = [];
    const totals = [];
    for (let i = 0; i < nItems; i++) {
      const { item, full } = lineItem(rng, rng.next() < 0.3);
      lineItems.push(item); totals.push(full);
    }
    const net = totals.reduce((s, t) => s + t, 0);
    const [taxBlock, taxTotal] = taxes(rng, lineItems, totals);
    const total = net + taxTotal;
    const productCount = lineItems.reduce((s, li) => s + li.quantity, 0);
    const station = `${store}_POS${String(rng.int(1, 14)).padStart(2, '0')}`;
    const occasion = rng.pick(OCCASIONS);
    const [city, state, tz, lat, lon] = rng.pick(CITIES);
    // Spread across an 11h service window (09:00–20:00) on ctx.businessDate.
    const orderDt = new Date(`${ctx.businessDate}T09:00:00.000Z`);
    orderDt.setSeconds(orderDt.getSeconds() + rng.int(0, 11 * 3600));
    const promised = new Date(orderDt.getTime() + 20 * 60_000);
    const tendered = new Date(orderDt.getTime() + rng.int(40, 240) * 1000);
    const seq = ctx.seq + 1;
    const businessDate = ctx.businessDate;
    const businessDayId = `${businessDate}@${org}-${store}`;
    const payType = rng.pick(['CASH', 'CARD']);
    const payInfo = payType === 'CASH'
      ? { cashInformation: { cashReceived: money(total), changeReturned: money(0), transactionTime: iso(tendered) } }
      : { cardInformation: { last4: String(rng.int(0, 9999)).padStart(4, '0'), transactionTime: iso(tendered) } };

    return {
      _id: { org, store, orderId },
      schema_version: '2.0.7',
      last_modified: iso(tendered),
      app_version_name: '5.5.0-bench',
      app_version_code: 5005000,
      business_day_id: businessDayId,
      digital_order_id: '',
      created_at_time_iso: iso(orderDt),
      promised_time_iso: iso(promised),
      sequential_id: String(seq),
      in_store_order_number: String(seq),
      occasion_type: occasion,
      order_status: 'ENTERED',
      partial_status: '',
      drive_thru_lane: '',
      drive_thru_sequencing: 'COMPLETE',
      entered_drive_thru_iso: iso(new Date(orderDt.getTime() + 30_000)),
      is_same_car: false,
      payment_status: 'PAID',
      customer_name: '',
      completed_at_time_iso: '',
      source: 'STORE',
      destination: occasion,
      agent: 'CUSTOMER',
      total: `${total}:USD`,
      product_count: productCount,
      digital_order_status: '',
      digital_order_check_in_time_iso: '',
      external_digital_order_number: '',
      business_date: businessDate,
      can_be_checked_in: false,
      till_id: uuid(rng),
      tender_time_iso: iso(tendered),
      net_total: `${net}:USD`,
      last_payment_action_station: station,
      pos_order_status: 'SALE_COMPLETE',
      table_number: '',
      estimated_ready_time: '',
      model_data: {
        order: {
          id: orderId, schemaVersion: '2.0.7',
          revision: `5-${uuid(rng).replaceAll('-', '')}`,
          cart: {
            lineItems,
            taxes: [taxBlock],
            addedTaxTotal: money(taxTotal),
            inclusiveTaxTotal: money(0),
            taxTotal: money(taxTotal),
            fees: [], promotions: [], donations: [], overrides: [],
          },
          customer: { isLoyaltyCustomer: false, metadata: {}, isEbtCardholder: false },
          status: {
            inStoreOrderStatus: 'ENTERED',
            inStoreStatusTransitions: transitions(rng, orderDt, INSTORE_FLOW),
            digitalStatusTransitions: [],
            partialOrderStatus: null,
            partialOrderStatusTransitions: [],
            posOrderStatus: 'SALE_COMPLETE',
            posOrderStatusTransitions: transitions(rng, orderDt, POS_FLOW),
            kitchenOrderStatus: null,
            kitchenOrderStatusTransitions: [],
          },
          timestamps: {
            created: iso(orderDt), completed: null, requested: null,
            promised: iso(promised), tendered: iso(tendered),
            agentVerifiedTime: iso(new Date(orderDt.getTime() + 29_000)),
            estimatedReady: null,
          },
          externalIds: {},
          fulfillmentInfo: { agent: 'CUSTOMER', destination: occasion, source: 'STORE' },
          employeeEdits: employeeEdits(rng, orderDt, station),
          store: {
            storeNumber: store, timezone: tz,
            address: {
              address1: `${rng.int(100, 9999)} Sample Road`,
              city, state,
              postalCode: String(rng.int(10000, 99999)), countryCode: 'US',
              phone: `+1555${rng.int(1000000, 9999999)}`,
              position: { coordinates: [lon, lat] },
            },
          },
          sequentialId: String(seq), businessDayId,
          payments: {
            paymentStatus: 'PAID',
            payments: [{ id: uuid(rng), total: money(total), paymentStatus: 'PAID', paymentType: payType, paymentInfo: payInfo }],
          },
          menuId: `Bench Menu@${businessDate}T00:00:00.000Z-${uuid(rng).slice(0, 6)}`,
          occasion,
          totals: {
            itemDiscountsValue: money(0), orderDiscountsValue: money(0),
            itemTotalBeforeItemDiscounts: money(net), itemTotalAfterItemDiscounts: money(net),
            itemTotalAfterAllDiscounts: money(net), discountValue: money(0),
            taxTotal: money(taxTotal), donationTotal: money(0), total: money(total),
          },
          tillId: uuid(rng),
          driveThruInfo: {
            isSameCar: false, driveThruLane: null, sequencing: 'COMPLETE',
            enteredDriveThru: iso(new Date(orderDt.getTime() + 30_000)),
            exitedDriveThru: iso(tendered),
          },
          isRefund: false, privateMetafields: [], orderType: 'INSTORE',
          excludedPromotions: [],
          loyaltyInfo: { loyaltyBarcode: null, appliedLoyaltyOffers: [] },
        },
      },
    };
  },
};

export const SCHEMAS = { tasks, orders, movies };
