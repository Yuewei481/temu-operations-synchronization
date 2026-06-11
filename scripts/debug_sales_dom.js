import { executeChromeJavascript, findSellerHomeTab } from './chrome_automation.js';

const tab = await findSellerHomeTab();
if (!tab) {
  throw new Error('agentseller.temu.com tab not found');
}

const result = await executeChromeJavascript(
  tab,
  String.raw`
    (function () {
      function text(element) {
        return (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
      }

      function rect(element) {
        var value = element.getBoundingClientRect();
        return [
          Math.round(value.left),
          Math.round(value.top),
          Math.round(value.width),
          Math.round(value.height)
        ].join(',');
      }

      var elements = Array.from(document.querySelectorAll('body *'));
      var lines = [
        'url=' + location.href,
        'bodySkuIndex=' + document.body.innerText.indexOf('SKU ID'),
        'bodyTodayIndex=' + document.body.innerText.indexOf('今日'),
        'bodyTotalIndex=' + document.body.innerText.indexOf('合计')
      ];

      ['SKU ID', '合计', '今日'].forEach(function (key) {
        var found = [];
        for (var index = 0; index < elements.length && found.length < 30; index += 1) {
          var value = text(elements[index]);
          if (value === key || (value.indexOf(key) >= 0 && value.length < 120)) {
            found.push(value + ' @ ' + rect(elements[index]) + ' <' + elements[index].tagName + '>');
          }
        }

        lines.push(key + ': ' + found.join(' || '));
      });

      return lines.join('\n');
    })();
  `,
);

console.log(result);
