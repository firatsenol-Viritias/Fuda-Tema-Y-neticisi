/**
 * "Bir alana bir bedava" kampanya popup'i.
 *
 * Sepete ekleme olayini dinler. Eklenen urun kampanya koleksiyonlarindan
 * birine aitse ve musterinin o koleksiyondan sepetteki adedi tek sayiysa
 * (yani bir urun daha eklerse bedava ciftini tamamlayacaksa) popup acilir.
 *
 * Popup indirim uygulamaz; bedava urun Shopify'daki "Buy X Get Y" otomatik
 * indirimi ile sepette dusulur. Bu yuzden urun kartlarinda fiyat "0" olarak
 * gosterilmez, indirimin sepette uygulanacagi yazilir.
 */

const SOURCE = 'fuda-campaign-popup';
const PAGE_SIZE = 50;

class FudaCampaignPopup extends HTMLElement {
  connectedCallback() {
    this.panel = this.querySelector('.fuda-upsell__panel');
    this.body = this.querySelector('.fuda-upsell__body');
    this.productsContainer = this.querySelector('[data-fuda-products]');

    this.campaigns = this.readCampaigns();
    if (!this.campaigns.length) return;

    this.lastItemCount = Number(this.dataset.initialItemCount || 0);
    this.activeCampaign = null;
    this.activeCount = 0;
    this.dismissed = null;
    this.previouslyFocused = null;

    this.querySelectorAll('[data-fuda-upsell-close]').forEach((button) =>
      button.addEventListener('click', () => this.close(true))
    );
    this.addEventListener('click', this.onPopupClick);
    document.addEventListener('keydown', this.onKeydown);
    document.addEventListener('cart:update', this.onCartUpdate);
  }

  disconnectedCallback() {
    this.removeEventListener('click', this.onPopupClick);
    document.removeEventListener('keydown', this.onKeydown);
    document.removeEventListener('cart:update', this.onCartUpdate);
  }

  readCampaigns() {
    const node = this.querySelector('[data-fuda-campaigns]');
    if (!node) return [];
    try {
      const parsed = JSON.parse(node.textContent || '[]');
      return (Array.isArray(parsed) ? parsed : [])
        .filter((campaign) => campaign?.handle && Array.isArray(campaign.productIds) && campaign.productIds.length)
        .map((campaign) => ({ ...campaign, productIds: new Set(campaign.productIds.map(Number)) }));
    } catch (error) {
      console.error('Kampanya yapilandirmasi okunamadi.', error);
      return [];
    }
  }

  /** Sepette bu kampanyaya ait toplam adet. */
  countInCart(campaign, cart) {
    return (Array.isArray(cart?.items) ? cart.items : []).reduce(
      (total, item) => (campaign.productIds.has(Number(item.product_id)) ? total + Number(item.quantity || 0) : total),
      0
    );
  }

  /**
   * Hangi kampanyanin popup'i acilmali?
   * Tek sayi = bir urun daha eklenirse bedava cift tamamlanir.
   *
   * Eklenen urun biliniyorsa yalnizca o urunun kampanyasi acilir. Boylece
   * sepetinde tek hasir olan biri kampanya disi bir urun eklediginde popup
   * onune cikmaz; ayrica eski ColorPuff hediye popup'i ile ayni anda
   * acilma durumu ortadan kalkar.
   *
   * Urun ID'si bilinmiyorsa (orn. sepet cekmecesinde adet artirma) tek
   * sayidaki ilk kampanyaya dusulur.
   */
  pickCampaign(cart, addedProductId) {
    const candidates = this.campaigns
      .map((campaign) => ({ campaign, count: this.countInCart(campaign, cart) }))
      .filter(({ count }) => count > 0 && count % 2 === 1);

    if (!candidates.length) return null;
    if (addedProductId) {
      return candidates.find(({ campaign }) => campaign.productIds.has(Number(addedProductId))) || null;
    }
    return candidates[0];
  }

  async fetchCart() {
    const root = window.Shopify?.routes?.root || '/';
    const response = await fetch(`${root}cart.js`, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Sepet okunamadi: ${response.status}`);
    return response.json();
  }

  onCartUpdate = async (event) => {
    const data = event.detail?.data || {};
    if (data.didError) return;

    // Popup'in kendi eklemesi: cifti tamamladi, kapat.
    if (data.source === SOURCE || (event.target && this.contains(event.target))) {
      this.close();
      return;
    }

    let cart = event.detail?.resource;
    if (!cart || !Array.isArray(cart.items)) {
      try {
        cart = await this.fetchCart();
      } catch (error) {
        console.error(error);
        return;
      }
    }

    const itemCount = Number(cart.item_count || 0);
    const increased = itemCount > this.lastItemCount;
    this.lastItemCount = itemCount;
    // Adet dusuyorsa (silme, azaltma) popup acma.
    if (!increased) return;

    const picked = this.pickCampaign(cart, data.productId);
    if (!picked) {
      this.close();
      return;
    }

    // Ayni kampanya + ayni adet icin kullanici zaten kapattiysa tekrar acma.
    if (this.dismissed && this.dismissed.handle === picked.campaign.handle && this.dismissed.count === picked.count) return;

    this.open(picked.campaign, picked.count);
  };

  onKeydown = (event) => {
    if (!this.hidden && event.key === 'Escape') this.close(true);
  };

  onPopupClick = async (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-fuda-ajax-add]') : null;
    if (!button || button.disabled) return;
    event.preventDefault();

    const variantId = button.dataset.variantId;
    if (!variantId) return;
    const textNode = button.querySelector('[data-button-text]');
    const originalText = textNode?.textContent || 'Sepete Ekle';
    button.disabled = true;
    if (textNode) textNode.textContent = 'Ekleniyor...';

    try {
      const root = window.Shopify?.routes?.root || '/';
      const addResponse = await fetch(`${root}cart/add.js`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ items: [{ id: Number(variantId), quantity: 1 }] }),
      });
      if (!addResponse.ok) throw new Error('Ürün sepete eklenemedi.');
      const cart = await this.fetchCart();
      this.lastItemCount = Number(cart.item_count || 0);
      if (textNode) textNode.textContent = 'Sepete Eklendi';
      document.dispatchEvent(
        new CustomEvent('cart:update', { bubbles: true, detail: { resource: cart, data: { source: SOURCE } } })
      );
    } catch (error) {
      console.error(error);
      if (textNode) textNode.textContent = 'Tekrar Dene';
      button.disabled = false;
      return;
    }

    window.setTimeout(() => {
      button.disabled = false;
      if (textNode) textNode.textContent = originalText;
    }, 1200);
  };

  async loadProducts(campaign) {
    const container = this.productsContainer;
    if (!container) return;
    if (campaign.markup) {
      container.innerHTML = campaign.markup;
      return;
    }

    container.innerHTML = '<p class="fuda-upsell__empty">Ürünler yükleniyor...</p>';
    const root = window.Shopify?.routes?.root || '/';
    const collected = [];

    try {
      for (let page = 1; ; page += 1) {
        const response = await fetch(
          `${root}collections/${encodeURIComponent(campaign.handle)}/products.json?limit=${PAGE_SIZE}&page=${page}`,
          { headers: { Accept: 'application/json' } }
        );
        if (!response.ok) throw new Error(`Koleksiyon yüklenemedi: ${response.status}`);
        const payload = await response.json();
        const products = Array.isArray(payload.products) ? payload.products : [];
        collected.push(...products.filter((product) => Array.isArray(product.variants) && product.variants.length));
        if (products.length < PAGE_SIZE) break;
      }
    } catch (error) {
      console.error(error);
      if (!collected.length) {
        container.innerHTML = '<p class="fuda-upsell__empty">Ürünler yüklenemedi. Lütfen tekrar deneyin.</p>';
        return;
      }
    }

    const markup = collected
      .flatMap((product) => product.variants.map((variant) => this.variantMarkup(campaign, product, variant)))
      .join('');
    campaign.markup = markup;
    container.innerHTML = markup || '<p class="fuda-upsell__empty">Bu koleksiyonda ürün bulunmuyor.</p>';
  }

  variantMarkup(campaign, product, variant) {
    const root = window.Shopify?.routes?.root || '/';
    const image = this.variantImage(product, variant);
    const productUrl = `${root}products/${product.handle}?variant=${variant.id}`;
    const rawTitle = String(variant.title || '').trim();
    const variantTitle = rawTitle && rawTitle.toLocaleLowerCase('tr-TR') !== 'default title' ? rawTitle : '';
    const isAvailable = variant?.available !== false;

    return `<article class="fuda-upsell__product" data-variant-id="${variant.id}">
      <a class="fuda-upsell__image" href="${this.escapeAttribute(productUrl)}" tabindex="-1">${
        image
          ? `<img src="${this.escapeAttribute(image)}" loading="lazy" alt="${this.escapeAttribute(product.title)}">`
          : ''
      }</a>
      <div class="fuda-upsell__product-info">
        <a class="fuda-upsell__product-title" href="${this.escapeAttribute(productUrl)}">${this.escapeHtml(product.title)}</a>
        ${variantTitle ? `<div class="fuda-upsell__variant-title">${this.escapeHtml(variantTitle)}</div>` : ''}
        <div class="fuda-upsell__offer-label">${this.escapeHtml(campaign.offerLabel || '2. ÜRÜN BEDAVA')}</div>
        <div class="fuda-upsell__quick-add">
          <button type="button" class="fuda-upsell__add-button" data-fuda-ajax-add data-variant-id="${variant.id}" ${
            isAvailable ? '' : 'disabled'
          }>
            <span class="fuda-upsell__add-icon" aria-hidden="true">+</span>
            <span data-button-text>${isAvailable ? 'Sepete Ekle' : 'Tükendi'}</span>
          </button>
        </div>
      </div>
    </article>`;
  }

  variantImage(product, variant) {
    const featured = variant?.featured_image;
    if (typeof featured === 'string' && featured) return featured;
    if (featured?.src) return featured.src;
    const images = Array.isArray(product?.images) ? product.images : [];
    const matched = images.find(
      (image) => Array.isArray(image?.variant_ids) && image.variant_ids.map(String).includes(String(variant?.id))
    );
    if (matched?.src) return matched.src;
    if (typeof matched === 'string') return matched;
    const first = images[0];
    return first?.src || (typeof first === 'string' ? first : '');
  }

  escapeHtml(value = '') {
    const div = document.createElement('div');
    div.textContent = String(value);
    return div.innerHTML;
  }

  escapeAttribute(value = '') {
    return this.escapeHtml(value).replace(/`/g, '&#96;');
  }

  applyCopy(campaign) {
    const set = (selector, value) => {
      const node = this.querySelector(selector);
      if (node) node.textContent = value || '';
    };
    set('[data-fuda-eyebrow]', campaign.eyebrow);
    set('[data-fuda-heading]', campaign.heading);
    set('[data-fuda-description]', campaign.description);
    set('[data-fuda-footer]', campaign.footer);
  }

  open(campaign, campaignCount = 0) {
    const alreadyOpenForCampaign = !this.hidden && this.activeCampaign?.handle === campaign.handle;
    this.activeCampaign = campaign;
    this.activeCount = campaignCount;
    this.applyCopy(campaign);
    this.loadProducts(campaign);
    if (alreadyOpenForCampaign) return;

    const cartDrawer = document.querySelector('cart-drawer-component');
    if (cartDrawer && typeof cartDrawer.close === 'function') cartDrawer.close();
    // Eski ColorPuff hediye popup'i aciksa kampanya popup'i onceliklidir.
    const legacyPopup = document.querySelector('fuda-second-product-popup');
    if (legacyPopup && typeof legacyPopup.close === 'function') legacyPopup.close();
    this.previouslyFocused = document.activeElement;
    this.hidden = false;
    document.body.classList.add('fuda-upsell-open');
    requestAnimationFrame(() => this.panel?.focus());
  }

  close(dismissedByUser = false) {
    if (this.hidden) return;
    this.hidden = true;
    document.body.classList.remove('fuda-upsell-open');
    if (dismissedByUser && this.activeCampaign) {
      this.dismissed = { handle: this.activeCampaign.handle, count: this.activeCount };
    }
    if (this.previouslyFocused instanceof HTMLElement) this.previouslyFocused.focus();
  }
}

if (!customElements.get('fuda-campaign-popup')) customElements.define('fuda-campaign-popup', FudaCampaignPopup);
