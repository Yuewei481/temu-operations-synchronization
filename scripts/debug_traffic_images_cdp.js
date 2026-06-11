import { CdpPage, listCdpPages } from './cdp_client.js';

const pages = await listCdpPages();
const pageInfo = pages.find((page) => page.type === 'page' && page.url.includes('flux-analysis-full'))
  || pages.find((page) => page.type === 'page' && page.url.includes('agentseller'));
if (!pageInfo) {
  throw new Error('No Seller Central page found');
}

const page = new CdpPage(pageInfo);
await page.send('Runtime.enable');

try {
  const output = await page.evaluate(`
    (() => {
      function normalizedText(element) {
        return (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim();
      }

      function visibleElements() {
        return Array.from(document.querySelectorAll('body *')).filter((element) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        });
      }

      function centerY(rect) {
        return rect.top + rect.height / 2;
      }

      function plainRect(rect) {
        return {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      }

      function productRowFor(element) {
        let current = element;
        for (let depth = 0; current && current !== document.body && depth < 10; depth += 1) {
          if (/SPU\\s*[：:]\\s*\\d+/.test(normalizedText(current))) {
            return current;
          }
          current = current.parentElement;
        }
        return null;
      }

      function imageFor(rowElement, buttonRect) {
        const rowImage = rowElement.querySelector('img');
        if (rowImage) {
          const rect = rowImage.getBoundingClientRect();
          return {
            src: rowImage.currentSrc || rowImage.src || '',
            alt: rowImage.alt || '',
            status: rowImage.complete && rowImage.naturalWidth > 0 ? 'loaded' : 'not-loaded',
            rect: plainRect(rect),
            via: 'row-img',
          };
        }

        const targetY = centerY(buttonRect);
        const nearbyImage = Array.from(document.images)
          .map((image) => ({ image, rect: image.getBoundingClientRect() }))
          .filter((item) => item.rect.width > 20 && item.rect.height > 20)
          .filter((item) => item.rect.left > 240 && item.rect.left < 460)
          .filter((item) => Math.abs(centerY(item.rect) - targetY) < 70)
          .sort((a, b) => Math.abs(centerY(a.rect) - targetY) - Math.abs(centerY(b.rect) - targetY))[0];
        if (nearbyImage) {
          return {
            src: nearbyImage.image.currentSrc || nearbyImage.image.src || '',
            alt: nearbyImage.image.alt || '',
            status: nearbyImage.image.complete && nearbyImage.image.naturalWidth > 0 ? 'loaded' : 'not-loaded',
            rect: plainRect(nearbyImage.rect),
            via: 'nearby-img',
          };
        }

        const nearbyBackground = visibleElements()
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const match = window.getComputedStyle(element).backgroundImage.match(/url\\(["']?(.*?)["']?\\)/);
            return { element, rect, src: match?.[1] || '' };
          })
          .filter((item) => item.src)
          .filter((item) => item.rect.width > 20 && item.rect.height > 20)
          .filter((item) => item.rect.left > 240 && item.rect.left < 460)
          .filter((item) => Math.abs(centerY(item.rect) - targetY) < 70)
          .sort((a, b) => Math.abs(centerY(a.rect) - targetY) - Math.abs(centerY(b.rect) - targetY))[0];
        if (nearbyBackground) {
          return {
            src: nearbyBackground.src,
            alt: nearbyBackground.element.getAttribute('aria-label') || nearbyBackground.element.getAttribute('title') || '',
            status: 'css-background',
            rect: plainRect(nearbyBackground.rect),
            via: 'nearby-background',
          };
        }

        return { src: '', alt: '', status: 'not-found-or-not-loaded', rect: null, via: 'none' };
      }

      const rows = Array.from(document.querySelectorAll('a'))
        .filter((anchor) => normalizedText(anchor) === '查看详情')
        .map((anchor) => ({ anchor, rect: anchor.getBoundingClientRect(), row: productRowFor(anchor) }))
        .filter((item) => item.row)
        .filter((item) => item.rect.left > 1000 && item.rect.width <= 90 && item.rect.height <= 32)
        .sort((a, b) => a.rect.top - b.rect.top);

      return JSON.stringify({
        url: location.href,
        rowCount: rows.length,
        imageCount: document.images.length,
        items: rows.slice(0, 8).map((item) => {
          const rowText = normalizedText(item.row);
          return {
            spuId: rowText.match(/SPU\\s*[：:]\\s*(\\d+)/)?.[1] || '',
            title: rowText.split(' 办公用品')[0].split(' 健康和家居用品')[0].slice(0, 100),
            buttonTop: Math.round(item.rect.top),
            image: imageFor(item.row, item.rect),
          };
        }),
      });
    })();
  `);

  console.log(output);
} finally {
  await page.close();
}
