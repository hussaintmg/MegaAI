/**
 * Synthetic page templates — the source of MegaAI's own vision dataset.
 *
 * Each template renders a realistic page of a known KIND (login, checkout,
 * dashboard …) with randomised colours, spacing, copy and element counts, so
 * thousands of distinct pages come out of a handful of layouts. Because we
 * render them ourselves, every element's class and box can be read straight
 * from the DOM — perfect labels, no manual annotation.
 *
 * `defects` deliberately breaks a page in a named way, which is how the
 * defect-detector's dataset gets its labels for free.
 */

/** The screen kinds the classifier learns. */
export const SCREEN_KINDS = [
  'login',
  'signup',
  'checkout',
  'cart',
  'product-list',
  'dashboard',
  'contact-form',
  'article',
  'error',
  'settings',
];

/** The defect kinds the defect detector learns ('clean' = no defect). */
export const DEFECT_KINDS = ['clean', 'overflow', 'overlap', 'cutoff', 'broken-image', 'tiny-text', 'low-contrast'];

/**
 * Page kinds that reliably contain images.
 *
 * The `broken-image` defect is only meaningful here: injected into a page with
 * no <img>, it renders identically to a clean page, so the label would be a
 * lie and the model cannot possibly learn it. (Measured: a first run that
 * ignored this scored 3.8% on broken-image, with 24 of 26 predicted clean.)
 */
export const KINDS_WITH_IMAGES = ['product-list', 'article'];

const FONTS = [
  'system-ui, sans-serif',
  'Georgia, serif',
  '"Helvetica Neue", Arial, sans-serif',
  '"Courier New", monospace',
  'Verdana, Geneva, sans-serif',
];

const PALETTES = [
  { bg: '#ffffff', fg: '#1a1a1a', muted: '#6b7280', accent: '#2563eb', border: '#e5e7eb', panel: '#f9fafb' },
  { bg: '#0b0e14', fg: '#e6e9f0', muted: '#8b94a7', accent: '#5b8cff', border: '#232838', panel: '#131722' },
  { bg: '#fffdf7', fg: '#2d2a26', muted: '#7c7266', accent: '#c2410c', border: '#ece5d8', panel: '#faf6ee' },
  { bg: '#f0fdf4', fg: '#14532d', muted: '#4d7c5f', accent: '#16a34a', border: '#bbf7d0', panel: '#dcfce7' },
  { bg: '#faf5ff', fg: '#3b0764', muted: '#7e64a3', accent: '#9333ea', border: '#e9d5ff', panel: '#f3e8ff' },
  { bg: '#fff1f2', fg: '#4c0519', muted: '#9f6070', accent: '#e11d48', border: '#fecdd3', panel: '#ffe4e6' },
];

const BRANDS = ['Nova', 'Acme', 'Lumen', 'Orbit', 'Vertex', 'Bloom', 'Kite', 'Atlas', 'Pixel', 'Harbor'];
const PRODUCTS = ['Wireless Headphones', 'Running Shoes', 'Coffee Grinder', 'Desk Lamp', 'Backpack', 'Mechanical Keyboard', 'Yoga Mat', 'Water Bottle', 'Sunglasses', 'Notebook Set'];
const NAV_ITEMS = ['Home', 'Products', 'Pricing', 'About', 'Contact', 'Blog', 'Docs', 'Support', 'Careers', 'FAQ'];

/** Deterministic helpers bound to a seeded RNG. */
export function makeHelpers(rng) {
  const pick = (list) => list[Math.floor(rng() * list.length)];
  const int = (min, max) => min + Math.floor(rng() * (max - min + 1));
  const chance = (p) => rng() < p;
  const some = (list, n) => {
    const copy = list.slice();
    const out = [];
    for (let i = 0; i < n && copy.length > 0; i++) out.push(copy.splice(Math.floor(rng() * copy.length), 1)[0]);
    return out;
  };
  return { pick, int, chance, some };
}

function baseStyles(p, font, scale) {
  return `
  *{box-sizing:border-box}
  body{margin:0;background:${p.bg};color:${p.fg};font-family:${font};font-size:${scale}px;line-height:1.5}
  .wrap{max-width:${880 + Math.round(scale * 10)}px;margin:0 auto;padding:${Math.round(scale * 1.6)}px}
  header{display:flex;align-items:center;gap:14px;padding:14px 20px;border-bottom:1px solid ${p.border}}
  .brand{font-weight:800;font-size:1.15em}
  nav{margin-left:auto;display:flex;gap:14px;flex-wrap:wrap}
  nav a{color:${p.muted};text-decoration:none;font-size:.92em}
  h1{font-size:1.9em;margin:.5em 0 .3em}
  h2{font-size:1.3em;margin:1em 0 .4em}
  p{color:${p.muted};margin:.4em 0}
  .panel{background:${p.panel};border:1px solid ${p.border};border-radius:10px;padding:18px;margin:14px 0}
  label{display:block;margin:12px 0 5px;font-size:.88em;color:${p.muted}}
  input,select,textarea{width:100%;padding:10px 12px;border:1px solid ${p.border};border-radius:8px;
    background:${p.bg};color:${p.fg};font:inherit}
  textarea{min-height:90px}
  button{background:${p.accent};color:#fff;border:0;border-radius:8px;padding:11px 20px;font:inherit;
    font-weight:600;cursor:pointer}
  button.ghost{background:transparent;border:1px solid ${p.border};color:${p.fg}}
  .row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:14px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px}
  .card{border:1px solid ${p.border};border-radius:10px;padding:14px;background:${p.panel}}
  .card img{width:100%;height:110px;object-fit:cover;border-radius:8px;background:${p.border}}
  .check{display:flex;align-items:center;gap:8px;margin:10px 0}
  .check input{width:auto}
  table{width:100%;border-collapse:collapse}
  th,td{text-align:left;padding:9px 8px;border-bottom:1px solid ${p.border};font-size:.92em}
  .stat{border:1px solid ${p.border};border-radius:10px;padding:14px;background:${p.panel}}
  .stat b{display:block;font-size:1.6em}
  footer{border-top:1px solid ${p.border};padding:18px 20px;color:${p.muted};font-size:.85em}
  `;
}

// A tiny inline SVG stands in for photography — keeps pages self-contained
// (no network) while still giving the detector real <img> boxes to find.
function img(seedColor) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='300' height='200'><rect width='300' height='200' fill='${seedColor}'/><circle cx='150' cy='100' r='55' fill='rgba(255,255,255,.35)'/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function header(h, brand, p) {
  const items = h.some(NAV_ITEMS, h.int(3, 6));
  return `<header><span class="brand">${brand}</span><nav>${items
    .map((item) => `<a href="/${item.toLowerCase()}">${item}</a>`)
    .join('')}</nav>${h.chance(0.5) ? '<button class="ghost">Sign in</button>' : ''}</header>`;
}

/* ------------------------------------------------------------------ *
 * Page bodies, one per screen kind
 * ------------------------------------------------------------------ */

const BODIES = {
  login: (h, brand, p, opts) => `
    <div class="wrap" style="max-width:420px">
      <h1>Sign in to ${brand}</h1>
      <p>Welcome back. Enter your details to continue.</p>
      <div class="panel">
        <label>Email</label><input type="email" name="email" placeholder="you@example.com">
        <label>Password</label><input type="password" name="password" placeholder="••••••••">
        ${h.chance(0.7) ? '<div class="check"><input type="checkbox" id="rm"><label for="rm" style="margin:0">Remember me</label></div>' : ''}
        <div class="row"><button type="submit">Sign in</button>${h.chance(0.6) ? '<a href="/reset">Forgot password?</a>' : ''}</div>
      </div>
      ${h.chance(0.5) ? `<p>New here? <a href="/signup">Create an account</a></p>` : ''}
    </div>`,

  signup: (h, brand, p, opts) => `
    <div class="wrap" style="max-width:460px">
      <h1>Create your ${brand} account</h1>
      <div class="panel">
        <label>Full name</label><input type="text" name="name" placeholder="Jane Doe">
        <label>Email</label><input type="email" name="email" placeholder="you@example.com">
        <label>Password</label><input type="password" name="password">
        ${h.chance(0.6) ? '<label>Confirm password</label><input type="password" name="confirm">' : ''}
        <div class="check"><input type="checkbox" id="tos"><label for="tos" style="margin:0">I agree to the terms</label></div>
        <div class="row"><button type="submit">Create account</button><button class="ghost">Cancel</button></div>
      </div>
    </div>`,

  checkout: (h, brand, p, opts) => `
    <div class="wrap">
      <h1>Checkout</h1>
      <div class="panel">
        <h2>Shipping</h2>
        <label>Full name</label><input type="text" name="name">
        <label>Address</label><input type="text" name="address">
        <div class="row" style="gap:12px">
          <div style="flex:1"><label>City</label><input type="text" name="city"></div>
          <div style="flex:1"><label>Postcode</label><input type="text" name="zip"></div>
        </div>
        <label>Country</label>
        <select name="country"><option>Pakistan</option><option>United States</option><option>United Kingdom</option></select>
      </div>
      <div class="panel">
        <h2>Payment</h2>
        <label>Card number</label><input type="text" name="card" placeholder="4242 4242 4242 4242">
        <div class="row"><div style="flex:1"><label>Expiry</label><input type="text" name="exp"></div>
        <div style="flex:1"><label>CVC</label><input type="text" name="cvc"></div></div>
        <div class="row"><button type="submit">Place order</button><button class="ghost">Back to cart</button></div>
      </div>
    </div>`,

  cart: (h, brand, p) => {
    const rows = h.some(PRODUCTS, h.int(2, 4));
    return `
    <div class="wrap">
      <h1>Your cart</h1>
      <table>
        <tr><th>Item</th><th>Qty</th><th>Price</th><th></th></tr>
        ${rows
          .map(
            (item) =>
              `<tr><td>${item}</td><td><input type="number" value="${h.int(1, 3)}" style="width:70px"></td><td>$${h.int(15, 240)}</td><td><button class="ghost">Remove</button></td></tr>`,
          )
          .join('')}
      </table>
      <div class="row"><input type="text" placeholder="Discount code" style="max-width:220px"><button class="ghost">Apply</button></div>
      <div class="row"><button>Proceed to checkout</button><a href="/products">Continue shopping</a></div>
    </div>`;
  },

  'product-list': (h, brand, p) => {
    const items = h.some(PRODUCTS, h.int(4, 8));
    return `
    <div class="wrap">
      <h1>Shop ${brand}</h1>
      <div class="row"><input type="search" placeholder="Search products" style="max-width:280px">
        <select><option>Sort: popular</option><option>Price: low to high</option></select>
        <button class="ghost">Filter</button></div>
      <div class="grid">
        ${items
          .map(
            (item) =>
              `<div class="card"><img src="${img(p.accent)}" alt="${item}"><h2 style="font-size:1em">${item}</h2><p>$${h.int(19, 299)}</p><button>Add to cart</button></div>`,
          )
          .join('')}
      </div>
    </div>`;
  },

  dashboard: (h, brand, p, opts) => `
    <div class="wrap">
      <h1>Dashboard</h1>
      <div class="grid">
        ${['Revenue', 'Orders', 'Customers', 'Refunds']
          .map((label) => `<div class="stat"><b>${h.int(12, 9800)}</b><span>${label}</span></div>`)
          .join('')}
      </div>
      <div class="panel">
        <h2>Recent orders</h2>
        <table>
          <tr><th>Order</th><th>Customer</th><th>Status</th><th></th></tr>
          ${Array.from({ length: h.int(3, 6) })
            .map(
              (_, i) =>
                `<tr><td>#${1000 + i}</td><td>Customer ${i + 1}</td><td>${h.pick(['paid', 'pending', 'shipped'])}</td><td><button class="ghost">View</button></td></tr>`,
            )
            .join('')}
        </table>
      </div>
      <div class="row"><button>Export report</button><button class="ghost">Settings</button></div>
    </div>`,

  'contact-form': (h, brand, p, opts) => `
    <div class="wrap" style="max-width:560px">
      <h1>Contact us</h1>
      <p>We usually reply within one business day.</p>
      <div class="panel">
        <label>Your name</label><input type="text" name="name">
        <label>Email</label><input type="email" name="email">
        <label>Subject</label><select><option>Support</option><option>Sales</option><option>Other</option></select>
        <label>Message</label><textarea name="message"></textarea>
        <div class="check"><input type="checkbox" id="nl"><label for="nl" style="margin:0">Subscribe to the newsletter</label></div>
        <div class="row"><button type="submit">Send message</button></div>
      </div>
    </div>`,

  article: (h, brand, p, opts) => `
    <div class="wrap" style="max-width:680px">
      <h1>How ${brand} rebuilt its platform</h1>
      <p>Published ${h.int(1, 28)} March · ${h.int(3, 12)} min read</p>
      ${opts.forceImages || h.chance(0.8) ? `<img src="${img(p.accent)}" alt="cover" style="width:100%;height:220px;object-fit:cover;border-radius:10px">` : ''}
      ${Array.from({ length: h.int(3, 5) })
        .map(
          () =>
            `<p>${'The team focused on reliability, shipping smaller changes more often and measuring the result at every step. '.repeat(h.int(1, 3))}</p>`,
        )
        .join('')}
      <h2>What changed</h2>
      <p>${'Deployment moved to a fully automated pipeline with checks at every stage. '.repeat(2)}</p>
      <div class="row"><button>Share</button><a href="/blog">More articles</a></div>
    </div>`,

  error: (h, brand, p, opts) => `
    <div class="wrap" style="max-width:520px;text-align:center;padding-top:70px">
      <h1>${h.pick(['404', '500', 'Something went wrong'])}</h1>
      <p>${h.pick(['We could not find that page.', 'An unexpected error occurred.', 'This link may have expired.'])}</p>
      <div class="row" style="justify-content:center"><button>Go home</button><button class="ghost">Contact support</button></div>
    </div>`,

  settings: (h, brand, p, opts) => `
    <div class="wrap" style="max-width:640px">
      <h1>Settings</h1>
      <div class="panel">
        <h2>Profile</h2>
        <label>Display name</label><input type="text" name="display">
        <label>Email</label><input type="email" name="email">
        <label>Time zone</label><select><option>UTC</option><option>Asia/Karachi</option></select>
      </div>
      <div class="panel">
        <h2>Notifications</h2>
        <div class="check"><input type="checkbox" id="n1"><label for="n1" style="margin:0">Email me about activity</label></div>
        <div class="check"><input type="checkbox" id="n2"><label for="n2" style="margin:0">Weekly summary</label></div>
        <div class="check"><input type="radio" name="freq" id="r1"><label for="r1" style="margin:0">Daily digest</label></div>
        <div class="check"><input type="radio" name="freq" id="r2"><label for="r2" style="margin:0">Realtime</label></div>
      </div>
      <div class="row"><button>Save changes</button><button class="ghost">Cancel</button><button class="ghost">Delete account</button></div>
    </div>`,
};

/** CSS that breaks a page in a specific, labelled way. */
const DEFECT_CSS = {
  clean: '',
  overflow: `.wrap{min-width:1500px}  img{min-width:900px}`,
  overlap: `h1{position:relative;top:26px;z-index:2}  p{position:relative;top:-14px}  button{position:relative;top:-18px;left:8px}`,
  cutoff: `.panel{height:70px;overflow:hidden}  .card{height:80px;overflow:hidden}  h1{height:14px;overflow:hidden}`,
  'broken-image': '',
  'tiny-text': `p,label,td,nav a{font-size:5px}  h2{font-size:8px}`,
  'low-contrast': `body{color:#d8d8d8}  p,label,.muted,nav a,td{color:#e8e8e8}  button{background:#efefef;color:#f6f6f6}`,
};

/**
 * Build one page. Returns the HTML plus the labels that describe it, so a
 * screenshot of this HTML is training data for all three vision models.
 */
export function buildPage(rng, options = {}) {
  const h = makeHelpers(rng);
  const kind = options.kind ?? h.pick(SCREEN_KINDS);
  const defect = options.defect ?? 'clean';
  const palette = h.pick(PALETTES);
  const font = h.pick(FONTS);
  const scale = h.int(13, 18);
  const brand = h.pick(BRANDS);

  let body = BODIES[kind](h, brand, palette, { forceImages: options.forceImages === true });
  // A "broken image" is a real broken src, not a CSS trick.
  if (defect === 'broken-image') body = body.replace(/src="data:[^"]*"/g, 'src="/missing-asset-404.png"');

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${brand} — ${kind}</title>
<style>${baseStyles(palette, font, scale)}${DEFECT_CSS[defect] ?? ''}</style></head>
<body>${h.chance(0.75) && kind !== 'error' ? header(h, brand, palette) : ''}${body}
${h.chance(0.5) ? `<footer>© ${brand}. All rights reserved.</footer>` : ''}</body></html>`;

  return { html, kind, defect, brand };
}
