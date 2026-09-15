class FudaSecondProductPopup extends HTMLElement {
  connectedCallback() {
    this.panel = this.querySelector('.fuda-upsell__panel');
    this.body = this.querySelector('.fuda-upsell__body');
    this.closeButtons = this.querySelectorAll('[data-fuda-upsell-close]');
    this.collectionHandle = this.dataset.collectionHandle || '';
    this.productFilter = this.dataset.productFilter || '';
    this.currentProductId = String(this.dataset.currentProductId || '');
    this.previouslyFocused = null;
    this.pendingMainAdd = false;
    this.collectionState = { page: 0, loading: false, done: false, initialized: Boolean(this.querySelector('[data-fuda-products] [data-variant-id]')) };
    this.pageSize = 50;

    this.closeButtons.forEach((button) => button.addEventListener('click', () => this.close()));
    this.body?.addEventListener('scroll', this.onBodyScroll, { passive: true });
    this.addEventListener('click', this.onPopupClick);
    document.addEventListener('click', this.onDocumentClick, true);
    document.addEventListener('submit', this.onDocumentSubmit, true);
    document.addEventListener('keydown', this.onKeydown);
    document.addEventListener('cart:update', this.onCartUpdate);
  }

  disconnectedCallback() {
    this.body?.removeEventListener('scroll', this.onBodyScroll);
    this.removeEventListener('click', this.onPopupClick);
    document.removeEventListener('click', this.onDocumentClick, true);
    document.removeEventListener('submit', this.onDocumentSubmit, true);
    document.removeEventListener('keydown', this.onKeydown);
    document.removeEventListener('cart:update', this.onCartUpdate);
  }

  matchesMainForm(element) {
    if (!(element instanceof Element)) return false;
    const formComponent = element.closest('product-form-component');
    if (!formComponent || this.contains(formComponent)) return false;
    const productId = String(formComponent.dataset.productId || '');
    return !this.currentProductId || !productId || productId === this.currentProductId;
  }

  onDocumentClick = (event) => {
    const button = event.target instanceof Element ? event.target.closest('button, [type="submit"], add-to-cart-component') : null;
    if (button && this.matchesMainForm(button)) this.pendingMainAdd = true;
  };

  onDocumentSubmit = (event) => {
    if (this.matchesMainForm(event.target)) this.pendingMainAdd = true;
  };

  onCartUpdate = (event) => {
    const data = event.detail?.data || {};
    if (data.didError) { this.pendingMainAdd = false; return; }

    const eventOriginatedInsidePopup = event.target && this.contains(event.target);
    if (eventOriginatedInsidePopup || data.source === 'fuda-second-product-popup') {
      this.pendingMainAdd = false;
      this.close();
      return;
    }

    if (data.source !== 'product-form-component') return;

    const addedProductId = String(data.productId || '');
    const idMatches = !addedProductId || !this.currentProductId || addedProductId === this.currentProductId;
    const targetMatches = this.matchesMainForm(event.target);
    if (!idMatches && !targetMatches && !this.pendingMainAdd) return;

    this.pendingMainAdd = false;
    window.setTimeout(() => this.open(), 180);
  };

  onKeydown = (event) => { if (!this.hidden && event.key === 'Escape') this.close(); };

  onBodyScroll = () => {
    if (!this.body || this.collectionState.done) return;
    const distanceFromBottom = this.body.scrollHeight - this.body.scrollTop - this.body.clientHeight;
    if (distanceFromBottom < 500) this.loadNextPage();
  };

  onPopupClick = async (event) => {
    const button = event.target.closest('[data-fuda-ajax-add]');
    if (!button) return;
    event.preventDefault();
    if (button.disabled) return;

    const variantId = button.dataset.variantId;
    if (!variantId) return;
    const textNode = button.querySelector('[data-button-text]');
    const originalText = textNode?.textContent || 'Sepete Ekle';
    button.disabled = true;
    if (textNode) textNode.textContent = 'Ekleniyor...';

    try {
      const root = window.Shopify?.routes?.root || '/';
      const addResponse = await fetch(`${root}cart/add.js`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ items: [{ id: Number(variantId), quantity: 1 }] }),
      });
      if (!addResponse.ok) throw new Error('ColorPuff sepete eklenemedi.');
      const cartResponse = await fetch(`${root}cart.js`, { headers: { Accept: 'application/json' } });
      if (!cartResponse.ok) throw new Error('Sepet güncellenemedi.');
      const cart = await cartResponse.json();
      if (textNode) textNode.textContent = 'Sepete Eklendi';
      document.dispatchEvent(new CustomEvent('cart:update', { bubbles: true, detail: { resource: cart, data: { source: 'fuda-second-product-popup' } } }));
    } catch (error) {
      console.error(error);
      if (textNode) textNode.textContent = 'Tekrar Dene';
      button.disabled = false;
      return;
    }

    setTimeout(() => { button.disabled = false; if (textNode) textNode.textContent = originalText; }, 1200);
  };

  productMatches(product) {
    if (!this.productFilter) return true;
    return String(product?.title || '').toLocaleLowerCase('tr-TR').includes(this.productFilter.toLocaleLowerCase('tr-TR'));
  }

  variantIsAvailable(variant) { return variant?.available !== false; }

  async ensureCollectionLoaded() {
    if (this.collectionState.initialized || this.collectionState.loading) return;
    const container = this.querySelector('[data-fuda-products]');
    if (!container) return;
    if (!this.collectionHandle) {
      container.innerHTML = '<p class="fuda-upsell__empty">ColorPuff koleksiyonu bulunamadı.</p>';
      this.collectionState.done = true; this.collectionState.initialized = true; return;
    }
    await this.loadNextPage(true);
  }

  async loadNextPage(replace = false) {
    const state = this.collectionState;
    if (!this.collectionHandle || state.loading || state.done) return;
    const container = this.querySelector('[data-fuda-products]');
    if (!container) return;
    state.loading = true;
    try {
      let foundProducts = [];
      while (!state.done && foundProducts.length === 0) {
        const nextPage = state.page + 1;
        const root = window.Shopify?.routes?.root || '/';
        const response = await fetch(`${root}collections/${encodeURIComponent(this.collectionHandle)}/products.json?limit=${this.pageSize}&page=${nextPage}`, { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`ColorPuff koleksiyonu yüklenemedi: ${response.status}`);
        const payload = await response.json();
        const products = Array.isArray(payload.products) ? payload.products : [];
        foundProducts = products.filter((product) => this.productMatches(product) && Array.isArray(product.variants) && product.variants.length);
        state.page = nextPage;
        state.done = products.length < this.pageSize;
      }
      if (replace || !state.initialized) container.innerHTML = '';
      if (foundProducts.length) container.insertAdjacentHTML('beforeend', foundProducts.flatMap((product) => this.productVariantMarkups(product)).join(''));
      state.initialized = true;
      if (state.done && container.children.length === 0) container.innerHTML = '<p class="fuda-upsell__empty">ColorPuff ürünü bulunmuyor.</p>';
    } catch (error) {
      console.error(error);
      if (!state.initialized) container.innerHTML = '<p class="fuda-upsell__empty">ColorPuff ürünleri yüklenemedi. Lütfen tekrar deneyin.</p>';
    } finally { state.loading = false; }
  }

  productVariantMarkups(product) { return (Array.isArray(product.variants) ? product.variants : []).map((variant) => this.variantMarkup(product, variant)); }

  variantMarkup(product, variant) {
    const image = this.variantImage(product, variant);
    const productUrl = `${window.Shopify?.routes?.root || '/'}products/${product.handle}?variant=${variant.id}`;
    const rawTitle = String(variant.title || '').trim();
    const variantTitle = rawTitle && rawTitle.toLocaleLowerCase('tr-TR') !== 'default title' ? rawTitle : '';
    const isAvailable = this.variantIsAvailable(variant);
    return `<article class="fuda-upsell__product" data-variant-id="${variant.id}">
      <a class="fuda-upsell__image" href="${this.escapeAttribute(productUrl)}" tabindex="-1">${image ? `<img src="${this.escapeAttribute(image)}" loading="lazy" alt="${this.escapeAttribute(product.title)}">` : ''}</a>
      <div class="fuda-upsell__product-info">
        <a class="fuda-upsell__product-title" href="${this.escapeAttribute(productUrl)}">${this.escapeHtml(product.title)}</a>
        ${variantTitle ? `<div class="fuda-upsell__variant-title">${this.escapeHtml(variantTitle)}</div>` : ''}
        <div class="fuda-upsell__offer-label">ColorPuff Hediye</div>
        <div class="fuda-upsell__quick-add"><button type="button" class="fuda-upsell__add-button" data-fuda-ajax-add data-variant-id="${variant.id}" ${isAvailable ? '' : 'disabled'}><span class="fuda-upsell__add-icon" aria-hidden="true">+</span><span data-button-text>${isAvailable ? 'Sepete Ekle' : 'Tükendi'}</span></button></div>
      </div>
    </article>`;
  }

  variantImage(product, variant) {
    const featured = variant?.featured_image;
    if (typeof featured === 'string' && featured) return featured;
    if (featured?.src) return featured.src;
    const images = Array.isArray(product?.images) ? product.images : [];
    const matched = images.find((image) => Array.isArray(image?.variant_ids) && image.variant_ids.map(String).includes(String(variant?.id)));
    if (matched?.src) return matched.src;
    if (typeof matched === 'string') return matched;
    const first = images[0];
    return first?.src || (typeof first === 'string' ? first : '');
  }

  escapeHtml(value = '') { const div = document.createElement('div'); div.textContent = String(value); return div.innerHTML; }
  escapeAttribute(value = '') { return this.escapeHtml(value).replace(/`/g, '&#96;'); }

  open() {
    if (!this.hidden) return;
    const cartDrawer = document.querySelector('cart-drawer-component');
    if (cartDrawer && typeof cartDrawer.close === 'function') cartDrawer.close();
    this.previouslyFocused = document.activeElement;
    this.hidden = false;
    document.body.classList.add('fuda-upsell-open');
    this.ensureCollectionLoaded();
    requestAnimationFrame(() => this.panel?.focus());
  }

  close() {
    if (this.hidden) return;
    this.hidden = true;
    document.body.classList.remove('fuda-upsell-open');
    if (this.previouslyFocused instanceof HTMLElement) this.previouslyFocused.focus();
  }
}

if (!customElements.get('fuda-second-product-popup')) customElements.define('fuda-second-product-popup', FudaSecondProductPopup);
