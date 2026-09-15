const PAGE_SIZE = 50;

function esc(value = '') {
  const node = document.createElement('div');
  node.textContent = String(value);
  return node.innerHTML;
}

function formatMoney(value) {
  const currency = window.Shopify?.currency?.active || 'TRY';
  const n = Number(value || 0);
  const amount = n > 10000 ? n / 100 : n;
  return new Intl.NumberFormat('tr-TR', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
}

function productIsAvailable(product) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  if (!variants.length) return true;
  return variants.some((variant) => variant?.available !== false);
}

function matchesFilter(product, filter) {
  if (!filter) return true;
  return String(product?.title || '').toLocaleLowerCase('tr-TR').includes(filter.toLocaleLowerCase('tr-TR'));
}

function firstImage(product) {
  const images = Array.isArray(product?.images) ? product.images : [];
  const first = images[0];
  return first?.src || (typeof first === 'string' ? first : '');
}

function productCardMarkup(product, showCollection, showPrice) {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const usable = variants.filter((variant) => variant?.available !== false);
  const prices = (usable.length ? usable : variants).map((variant) => Number(variant.price || 0)).filter(Number.isFinite);
  const compares = (usable.length ? usable : variants).map((variant) => Number(variant.compare_at_price || 0)).filter(Number.isFinite);
  const price = prices.length ? Math.min(...prices) : Number(product.price || 0);
  const compare = compares.length ? Math.max(...compares) : Number(product.compare_at_price || 0);
  const image = firstImage(product);
  const root = window.Shopify?.routes?.root || '/';
  const url = `${root}products/${encodeURIComponent(product.handle)}`;

  return `<article class="fuda-bundle-card" role="listitem" data-fuda-bundle-card data-product-id="${esc(product.id)}">
    <a class="fuda-bundle-card__link" href="${esc(url)}">
      <div class="fuda-bundle-card__media">${image ? `<img class="fuda-bundle-card__image" src="${esc(image)}" loading="lazy" alt="${esc(product.title)}">` : ''}</div>
      <div class="fuda-bundle-card__body">
        ${showCollection ? '<span class="fuda-bundle-card__collection">ColorPuff Hediye</span>' : ''}
        <span class="fuda-bundle-card__title">${esc(product.title)}</span>
        ${showPrice ? `<span class="fuda-bundle-card__price"><strong>${formatMoney(price)}</strong>${compare > price ? `<s>${formatMoney(compare)}</s>` : ''}</span>` : ''}
      </div>
    </a>
  </article>`;
}

async function fetchPage(handle, page) {
  const root = window.Shopify?.routes?.root || '/';
  const response = await fetch(`${root}collections/${encodeURIComponent(handle)}/products.json?limit=${PAGE_SIZE}&page=${page}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`FUDA bundle request failed: ${response.status}`);
  const data = await response.json();
  return Array.isArray(data.products) ? data.products : [];
}

function init(root) {
  if (!root || root.dataset.fudaReady === '1') return;
  const track = root.querySelector('[data-fuda-track]');
  if (!track) return;
  root.dataset.fudaReady = '1';

  const prev = root.querySelector('[data-fuda-prev]');
  const next = root.querySelector('[data-fuda-next]');
  const showCollection = root.dataset.showCollection !== 'false';
  const showPrice = root.dataset.showPrice !== 'false';
  const filter = root.dataset.productFilter || '';
  const state = { handle: root.dataset.sourceHandle || '', total: Number(root.dataset.sourceTotal || 0), page: 0, done: false, loading: false };
  const seen = new Set([...track.querySelectorAll('[data-product-id]')].map((card) => String(card.dataset.productId || '')));

  function step() {
    const card = track.querySelector('[data-fuda-bundle-card]');
    if (!card) return Math.max(track.clientWidth * .7, 180);
    const gap = parseFloat(getComputedStyle(track).gap || '10') || 10;
    return card.getBoundingClientRect().width + gap;
  }

  function updateButtons() {
    const max = Math.max(0, track.scrollWidth - track.clientWidth);
    if (prev) prev.disabled = track.scrollLeft <= 3;
    if (next) next.disabled = max <= 3 || track.scrollLeft >= max - 3;
  }

  async function loadMoreProducts() {
    if (!state.handle || state.loading || state.done) return '';
    state.loading = true;
    try {
      let html = '';
      while (!state.done && !html) {
        const nextPage = state.page + 1;
        const products = await fetchPage(state.handle, nextPage);
        state.page = nextPage;
        state.done = products.length < PAGE_SIZE || (state.total > 0 && nextPage * PAGE_SIZE >= state.total);
        for (const product of products) {
          const id = String(product.id || '');
          if (!id || seen.has(id) || !productIsAvailable(product) || !matchesFilter(product, filter)) continue;
          seen.add(id);
          html += productCardMarkup(product, showCollection, showPrice);
        }
      }
      return html;
    } catch (error) {
      console.error(error);
      state.done = true;
      return '';
    } finally { state.loading = false; }
  }

  let loadingMore = false;
  async function maybeLoadMore(force = false) {
    const distance = track.scrollWidth - track.scrollLeft - track.clientWidth;
    if ((!force && distance > Math.max(track.clientWidth, 480)) || loadingMore || state.done) return;
    loadingMore = true;
    try {
      const html = await loadMoreProducts();
      const loading = track.querySelector('[data-fuda-bundle-loading]');
      if (html) {
        loading?.remove();
        track.insertAdjacentHTML('beforeend', html);
      } else if (!track.querySelector('[data-fuda-bundle-card]') && state.done && loading) {
        loading.textContent = 'ColorPuff seçenekleri şu anda yüklenemiyor.';
      }
      updateButtons();
    } finally { loadingMore = false; }
  }

  prev?.addEventListener('click', () => track.scrollBy({ left: -step() * 2, behavior: 'smooth' }));
  next?.addEventListener('click', () => { track.scrollBy({ left: step() * 2, behavior: 'smooth' }); setTimeout(() => maybeLoadMore(), 250); });
  track.addEventListener('scroll', () => { updateButtons(); maybeLoadMore(); }, { passive: true });
  window.addEventListener('resize', updateButtons, { passive: true });
  requestAnimationFrame(() => { updateButtons(); maybeLoadMore(!track.querySelector('[data-fuda-bundle-card]')); });
}

document.querySelectorAll('[data-fuda-bundle-slider]').forEach(init);
document.addEventListener('shopify:section:load', (event) => event.target.querySelectorAll?.('[data-fuda-bundle-slider]').forEach(init));
