// Local check: a packshot with a product + two small badge graphics; badges must be dropped.
import sharp from "sharp";
import { plainBackgroundMask } from "../src/lib/render/guide";
const img = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800" fill="#f4f4f4"/><rect x="300" y="150" width="260" height="480" rx="12" fill="#b3261e"/><rect x="200" y="300" width="60" height="320" fill="#222"/><circle cx="130" cy="680" r="38" fill="#2e7d32"/><circle cx="230" cy="690" r="38" fill="#1565c0"/></svg>`)).jpeg().toBuffer();
const m = await plainBackgroundMask(img);
const raw = await sharp(m!).resize(800, 800).toColourspace("b-w").raw().toBuffer();
const at = (x: number, y: number) => raw[y * 800 + x] > 128;
console.log({ product: at(430, 400), stick: at(230, 450), badge1: at(130, 680), badge2: at(230, 690) });
