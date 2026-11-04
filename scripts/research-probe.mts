// Runs the DB-free parts of research against live stores. Used to validate parsers.
// node --conditions=react-server --import tsx scripts/research-probe.mts loopycases.com ...
import { fetchText } from "../src/lib/research/fetch";
import { detectShopify, getBestSellerHandles, getProductRating, getProducts, getShopMeta, handlesFromHtml, normalizeStoreUrl } from "../src/lib/research/shopify";
import { cleanBrandName, findColors, findHeadingFont, findLogo, pageBasics } from "../src/lib/research/brand";
import { diverseTop, dominantType, imageKind, scoreProducts } from "../src/lib/research/pick";
import { factsFromText } from "../src/lib/research/facts";

for (const url of process.argv.slice(2)) {
  const t = normalizeStoreUrl(url);
  const home = await fetchText(t.origin);
  const shop = detectShopify(home);
  const basics = pageBasics(home.text);
  const [meta, prods, bs] = await Promise.all([getShopMeta(t.origin), getProducts(t.origin, 2), getBestSellerHandles(t.origin)]);
  const name = cleanBrandName(meta.data?.name ?? basics.siteName ?? basics.title);
  const logo = findLogo(home.text, t.origin, name);
  const scored = scoreProducts(prods.products, bs.handles, handlesFromHtml(home.text));
  const top = diverseTop(scored, 3);
  const ratings = await Promise.all(top.map((c) => getProductRating(t.origin, c.product.handle)));
  const out = {
    store: t.domain, home: home.status, shopify: shop.isShopify, name,
    colors: findColors(home.text), font: findHeadingFont(home.text, t.origin),
    logo: logo ? (logo.type === "img" ? { img: logo.url.slice(0, 110), why: logo.why } : { svg: logo.svg.length, why: logo.why }) : null,
    products: prods.products.length, domType: dominantType(prods.products), bestSellers: bs.handles.slice(0, 5),
    top: top.map((c, i) => ({ h: c.product.handle, type: c.product.product_type, score: c.score, why: c.reasons.slice(0, 2), img: c.image ? `${c.image.width}x${c.image.height} ${imageKind(c.image.alt)}` : null, rating: ratings[i] ? `${ratings[i]!.rating}/${ratings[i]!.count}` : null })),
    facts: factsFromText(basics.description, "meta", null).map((f) => `${f.kind}: ${f.text}`),
  };
  console.log(JSON.stringify(out));
}
