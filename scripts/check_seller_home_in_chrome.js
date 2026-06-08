import { SELLER_HOME_ORIGIN, findSellerHomeTab } from './chrome_automation.js';

async function main() {
  const sellerTab = await findSellerHomeTab();

  if (!sellerTab) {
    console.log(`Seller Central home tab not found: ${SELLER_HOME_ORIGIN}/`);
    process.exitCode = 1;
    return;
  }

  console.log('Seller Central home tab detected.');
  console.log(`Window: ${sellerTab.windowIndex}`);
  console.log(`Tab: ${sellerTab.tabIndex}`);
  console.log(`Title: ${sellerTab.title}`);
  console.log(`URL: ${sellerTab.url}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
