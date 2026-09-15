class FudaOxfordColorPuffBadge extends HTMLElement {
  static imagePoolPromise = null;

  connectedCallback() {
    this.loadImage();
  }

  async loadImage() {
    const image = this.querySelector('.fuda-oxford-card-badge__image');
    if (!image) return;

    try {
      const pool = await FudaOxfordColorPuffBadge.getImagePool();
      if (!pool.length) return;

      const seed = this.hash(String(this.dataset.productId || Math.random()));
      const src = pool[seed % pool.length];
      if (!src) return;

      image.src = this.resizeShopifyImage(src, 220);
      image.hidden = false;
      this.dataset.imageLoaded = 'true';
    } catch (error) {
      console.warn('[FUDA] ColorPuff kart rozeti görseli yüklenemedi.', error);
    }
  }

  static getImagePool() {
    if (!this.imagePoolPromise) {
      this.imagePoolPromise = this.fetchImagePool();
    }
    return this.imagePoolPromise;
  }

  static async fetchImagePool() {
    const root = window.Shopify?.routes?.root || '/';
    const sources = [
      { handle: 'colorpuff', filterTitle: false },
      { handle: 'color-puff', filterTitle: false },
      { handle: 'puff-go', filterTitle: true },
    ];

    for (const source of sources) {
      try {
        const url = `${root}collections/${encodeURIComponent(source.handle)}/products.json?limit=250`;
        const response = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!response.ok) continue;

        const payload = await response.json();
        let products = Array.isArray(payload.products) ? payload.products : [];
        if (source.filterTitle) {
          products = products.filter((product) =>
            String(product?.title || '').toLocaleLowerCase('tr-TR').includes('colorpuff')
          );
        }

        const images = [];
        for (const product of products) {
          const candidates = [];

          if (product?.image?.src) candidates.push(product.image.src);
          if (typeof product?.image === 'string') candidates.push(product.image);

          if (Array.isArray(product?.images)) {
            for (const item of product.images) {
              if (typeof item === 'string') candidates.push(item);
              else if (item?.src) candidates.push(item.src);
            }
          }

          if (Array.isArray(product?.variants)) {
            for (const variant of product.variants) {
              const featured = variant?.featured_image;
              if (typeof featured === 'string') candidates.push(featured);
              else if (featured?.src) candidates.push(featured.src);
            }
          }

          for (const src of candidates) {
            if (src && !images.includes(src)) images.push(src);
          }
        }

        if (images.length) return images;
      } catch (error) {
        console.warn(`[FUDA] ${source.handle} ColorPuff görselleri okunamadı.`, error);
      }
    }

    return [];
  }

  hash(value) {
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
      hash = ((hash << 5) - hash) + value.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  resizeShopifyImage(src, width) {
    try {
      const url = new URL(src, window.location.origin);
      url.searchParams.set('width', String(width));
      return url.toString();
    } catch (_) {
      return src;
    }
  }
}

if (!customElements.get('fuda-oxford-colorpuff-badge')) {
  customElements.define('fuda-oxford-colorpuff-badge', FudaOxfordColorPuffBadge);
}
