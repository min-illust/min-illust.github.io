// Min. ILLUST LOG — サイトを組み立てるスクリプト（GitHub Actionsで自動実行）
// content/ の作品データと images/ の画像から、_site/ に公開用のサイトを作ります。
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "_site");
const CACHE = path.join(ROOT, ".cache", "img");
const SITE_URL = (process.env.SITE_URL || "https://min-illust.github.io").replace(/\/$/, "");
const BASE = (process.env.BASE_PATH || "").replace(/\/$/, ""); // "" か "/repo名"
const ADMIN_URL = "https://min-illust.netlify.app/admin/";

let sharp = null;
try { sharp = (await import("sharp")).default; } catch { console.warn("sharp なし：画像は圧縮せずにコピーします"); }

const readJSON = async (p, fb) => { try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return fb; } };
const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const day = (d) => String(d || "").slice(0, 10);
const list = (v) => (Array.isArray(v) ? v : v ? String(v).split(/[,、]/) : [])
  .map((x) => (typeof x === "string" ? x : x && (x.src || x.url || x.image)) || "")
  .map((x) => String(x).trim()).filter(Boolean);
const isHttps = (u) => /^https:\/\//i.test(u);
// 画像パス：「/images/〜」と「https://min-illust.github.io/images/〜」のどちらでも images/〜 として読む
const imgRel = (src) => String(src || "").trim().replace(/^https?:\/\/min-illust\.github\.io\/images\//i, "images/").replace(/^\/+/, "");

// ---------- 画像 ----------
const imgDone = new Map();
async function processImage(src) {
  if (imgDone.has(src)) return imgDone.get(src);
  const rel = imgRel(src);
  const file = path.join(ROOT, rel);
  if (!rel.startsWith("images/") || !(await exists(file))) { console.warn("画像が見つかりません:", src); imgDone.set(src, null); return null; }
  const buf = await fs.readFile(file);
  const hash = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 12);
  const names = { full: `img/${hash}.webp`, thumb: `img/${hash}-t.webp`, og: `img/${hash}-og.jpg`, meta: `${hash}.json` };
  let meta = await readJSON(path.join(CACHE, names.meta), null);
  if (!meta || !(await exists(path.join(CACHE, path.basename(names.full))))) {
    await fs.mkdir(CACHE, { recursive: true });
    if (sharp) {
      const base = () => sharp(buf, { failOn: "none" }).rotate();
      const full = await base().resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
      const thumb = await base().resize({ width: 720, height: 720, fit: "inside", withoutEnlargement: true }).webp({ quality: 76 }).toBuffer();
      const og = await base().resize(1200, 630, { fit: "cover", position: "attention" }).jpeg({ quality: 82 }).toBuffer();
      await fs.writeFile(path.join(CACHE, path.basename(names.full)), full.data);
      await fs.writeFile(path.join(CACHE, path.basename(names.thumb)), thumb);
      await fs.writeFile(path.join(CACHE, path.basename(names.og)), og);
      meta = { w: full.info.width, h: full.info.height };
    } else {
      for (const k of ["full", "thumb", "og"]) await fs.writeFile(path.join(CACHE, path.basename(names[k])), buf);
      meta = { w: 0, h: 0 };
    }
    await fs.writeFile(path.join(CACHE, names.meta), JSON.stringify(meta));
  }
  await fs.mkdir(path.join(OUT, "img"), { recursive: true });
  for (const k of ["full", "thumb", "og"]) await fs.copyFile(path.join(CACHE, path.basename(names[k])), path.join(OUT, names[k]));
  const r = { src: `${BASE}/${names.full}`, thumb: `${BASE}/${names.thumb}`, og: `${SITE_URL}/${names.og}`, w: meta.w, h: meta.h };
  imgDone.set(src, r);
  return r;
}

// ---------- 曲・動画 ----------
async function resolveSunoShort(url) {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(url, { redirect: "manual", signal: ctrl.signal, headers: { "user-agent": "Mozilla/5.0" } });
    clearTimeout(t);
    const loc = r.headers.get("location") || "";
    const m = loc.match(/\/song\/([0-9a-f-]{36})/i);
    return m ? m[1] : null;
  } catch { return null; }
}
async function parseMedia(url) {
  if (!isHttps(url)) return null;
  let u; try { u = new URL(url); } catch { return null; }
  const host = u.hostname.replace(/^www\.|^m\./, "");
  if (host === "youtu.be" || host.endsWith("youtube.com") || host === "youtube-nocookie.com") {
    let id = null, vertical = false;
    if (host === "youtu.be") id = u.pathname.slice(1);
    else if (u.pathname.startsWith("/shorts/")) { id = u.pathname.split("/")[2]; vertical = true; }
    else if (u.pathname.startsWith("/embed/") || u.pathname.startsWith("/live/")) id = u.pathname.split("/")[2];
    else id = u.searchParams.get("v");
    id = (id || "").match(/^[\w-]{6,20}/)?.[0];
    if (id) return { type: "youtube", id, vertical, url, thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` };
  }
  if (host.endsWith("suno.com") || host === "suno.ai" || host === "app.suno.ai") {
    let id = u.pathname.match(/\/(?:song|embed)\/([0-9a-f-]{36})/i)?.[1] || null;
    if (!id && u.pathname.startsWith("/s/")) id = await resolveSunoShort(url);
    return { type: "suno", id, url };
  }
  return { type: "link", url };
}

// ---------- データ ----------
const site = Object.assign({ description: "", goatcounter: "", x_handle: "" }, await readJSON(path.join(ROOT, "content/site.json"), {}));
const gc = /^[a-z0-9-]{2,50}$/i.test(String(site.goatcounter || "").trim()) ? String(site.goatcounter).trim() : "";
const xh = String(site.x_handle || "").replace(/^@/, "").match(/^\w{1,15}$/)?.[0] || "";
const catFile = await readJSON(path.join(ROOT, "content/categories.json"), { categories: [] });

// ---------- キャラリンク集の作品（投稿との紐づけに先に使う） ----------
const CHARA_CATS = ["1:1ロールプレイ", "シミュレーション"];
const CHARA_GENRES = ["恋愛", "日常・現代", "ファンタジー", "BL", "その他"];
const isKyarapu = (u) => {
  try { const x = new URL(String(u).trim()); return x.protocol === "https:" && (x.hostname === "kyarapu.com" || x.hostname.endsWith(".kyarapu.com")); }
  catch { return false; }
};
const urlKey = (u) => { try { const x = new URL(String(u).trim()); return (x.hostname + x.pathname).replace(/\/+$/, "").toLowerCase(); } catch { return ""; } };
// ひらがな・カタカナ、全角・半角、スペースの違いを同じものとして扱う
const normName = (s) => String(s || "").normalize("NFKC").toLowerCase()
  .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60)).replace(/\s/g, "");
const uniqTags = (arr) => { const seen = new Set(), out = []; for (const t of arr) { const v = String(t || "").replace(/^#/, "").trim(); const k = normName(v); if (v && !seen.has(k)) { seen.add(k); out.push(v); } } return out; };

const charaDir = path.join(ROOT, "content/characters");
const charaFiles = (await exists(charaDir)) ? (await fs.readdir(charaDir)).filter((f) => f.endsWith(".json")) : [];
const works = []; // { id, f, raw, title, charas, keys, names }
for (const f of charaFiles) {
  const raw = await readJSON(path.join(charaDir, f), null);
  if (!raw || !raw.title || !day(raw.published)) { console.warn("読み込めないキャラ:", f); continue; }
  const title = String(raw.title).trim();
  works.push({
    id: f.replace(/\.json$/, "").replace(/[^\w-]/g, "-"), f, raw, title,
    charas: uniqTags(list(raw.charas)),
    keys: [raw.story, raw.talk].filter((u) => u && isKyarapu(u)).map(urlKey),
    names: [title, ...list(raw.illust_tags)].map(normName).filter(Boolean),
  });
}
// 投稿 → 作品：キャラぷのURLが同じ > 作品名（または別名）が同じ > 旧データのタグが作品名と同じ
function findWork(charapu, names, oldTags) {
  const k = charapu ? urlKey(charapu) : "";
  let w = k && works.find((x) => x.keys.includes(k));
  if (w) return w;
  const ns = names.map(normName).filter(Boolean);
  w = ns.length && works.find((x) => x.names.some((n) => ns.includes(n)));
  if (w) return w;
  const ts = oldTags.map(normName);
  return works.find((x) => x.names.some((n) => ts.includes(n))) || null;
}

const postDir = path.join(ROOT, "content/posts");
const files = (await exists(postDir)) ? (await fs.readdir(postDir)).filter((f) => f.endsWith(".json")) : [];
const posts = [];
for (const f of files) {
  const raw = await readJSON(path.join(postDir, f), null);
  if (!raw || !day(raw.date)) { console.warn("読み込めない作品:", f); continue; }
  const slug = f.replace(/\.json$/, "").replace(/[^\w-]/g, "-");
  // 画像は「画像だけ（文字列）」と「画像＋一言＋表紙」の両方に対応
  const rawImgs = Array.isArray(raw.images) ? raw.images : raw.images ? [raw.images] : raw.image ? [raw.image] : [];
  const images = [];
  let coverIdx = -1;
  for (const it of rawImgs) {
    const src = typeof it === "string" ? it : it && (it.src || it.url || it.image);
    if (!src) continue;
    const r = await processImage(String(src).trim());
    if (!r) continue;
    const obj = it && typeof it === "object";
    if (obj && it.cover && coverIdx < 0) coverIdx = images.length;
    images.push({ ...r, caption: obj ? String(it.caption || "").trim() : "", ownCharas: obj ? list(it.charas) : [], ownTags: obj ? list(it.tags) : [] });
  }
  // まとめて追加した画像は、1枚ずつの画像のあとに並べる。一言は「上から順に1行ずつ」、表紙は「何枚目か」
  const bulkCaps = String(raw.bulk_captions || "").split(/\r?\n/);
  const bulkTags = String(raw.bulk_tags || "").split(/\r?\n/);
  const bulkCover = parseInt(raw.bulk_cover, 10);
  let bi = 0;
  for (const src of list(raw.images_bulk)) {
    const n = bi++;
    const r = await processImage(src);
    if (!r || images.some((x) => x.src === r.src)) continue;
    if (coverIdx < 0 && bulkCover === n + 1) coverIdx = images.length;
    images.push({ ...r, caption: String(bulkCaps[n] || "").trim(), ownCharas: [], ownTags: String(bulkTags[n] || "").split(/[,、，]/) });
  }
  const media = [];
  for (const m of list(raw.media)) { const r = await parseMedia(m); if (r) media.push(r); }
  const title = String(raw.title || "").trim();
  const category = String(raw.category || "その他");
  const isOrig = category === "オリジナル";
  const tags = uniqTags(list(raw.tags));
  const charapu = isHttps(String(raw.charapu || "").trim()) ? String(raw.charapu).trim() : "";
  const workSel = String(raw.work || "").trim(), workName = String(raw.work_name || "").trim();
  const w = isOrig ? null : findWork(charapu, [workSel, workName].filter(Boolean), tags);
  const work = w ? w.title : workSel || workName || (isOrig ? "オリジナル" : "");
  let charas = uniqTags([...list(raw.charas), ...list(raw.charas_free)]);
  if (!charas.length && w && w.charas.length === 1) charas = [w.charas[0]]; // 1人だけの作品はキャラ名を自動で
  // 旧データ：作品名・キャラ名がタグに入っている場合は、属性タグから外す
  const attr = tags.filter((t) => normName(t) !== normName(work) && !charas.some((c) => normName(c) === normName(t)) && !(w && w.names.includes(normName(t))));
  // 画像ごと：キャラ（空なら投稿のキャラ名）と、属性タグ（投稿全体のタグ＋その画像のタグ）
  for (const im of images) {
    const own = uniqTags(im.ownCharas);
    im.charas = own.length ? own : charas;
    im.tags = uniqTags([...attr, ...im.ownTags]).filter((t) => !im.charas.some((c) => normName(c) === normName(t)) && normName(t) !== normName(work));
    delete im.ownCharas; delete im.ownTags;
  }
  const allCharas = uniqTags([...charas, ...images.flatMap((im) => im.charas)]);
  const allAttrs = uniqTags([...attr, ...images.flatMap((im) => im.tags)]);
  const [, mm, dd] = day(raw.date).split("-");
  posts.push({
    slug, title, date: day(raw.date),
    label: (isOrig ? charas[0] || "オリジナル" : work || charas[0] || attr[0]) || `${+mm}/${+dd}の作品`, // 表示名は作品名・キャラ名（タイトルは管理用でサイトには出さない）
    category, images, media, coverIdx: coverIdx < 0 ? 0 : coverIdx,
    comment: String(raw.comment || ""),
    work, workId: w ? w.id : "", charas: allCharas,
    tags: uniqTags([work, ...allCharas, ...allAttrs]), // 表示するタグ：作品名 → キャラ名 → 属性の順
    attrs: attr,
    unmatched: !w && !isOrig && (workSel || category === "キャラぷ") ? (workSel || workName || "（作品名なし）") : "",
    charapu, pickup: !!raw.pickup,
    url: `${BASE}/w/${slug}/`,
  });
}
posts.sort((a, b) => b.date.localeCompare(a.date) || b.slug.localeCompare(a.slug));

const catNames = [...new Set([...(catFile.categories || []).map((c) => String(c.name || "").trim()).filter(Boolean), ...posts.map((p) => p.category)])];
const catDesc = Object.fromEntries((catFile.categories || []).map((c) => [String(c.name || "").trim(), String(c.description || "")]));
const coverOf = (p) => p.images[p.coverIdx]?.thumb || p.images[0]?.thumb || p.media.find((m) => m.thumb)?.thumb || "";
const categories = catNames.map((name) => {
  const ps = posts.filter((p) => p.category === name);
  return { name, description: catDesc[name] || "", count: ps.length, cover: ps.map(coverOf).find(Boolean) || "" };
}).filter((c) => c.count > 0 || catDesc[c.name] !== undefined);

// ---------- 書き出し ----------
await fs.mkdir(path.join(OUT, "data"), { recursive: true });

const template = await fs.readFile(path.join(ROOT, "site/app.html"), "utf8");
const siteTitle = "Min. ILLUST LOG";
const defaultOg = posts.find((p) => p.images[0])?.images[0].og || "";
function page({ title, desc, url, og, post }) {
  const head = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(desc)}">`,
    `<link rel="canonical" href="${esc(url)}">`,
    `<meta property="og:type" content="${post ? "article" : "website"}">`,
    `<meta property="og:site_name" content="${siteTitle}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    og ? `<meta property="og:image" content="${esc(og)}">` : "",
    `<meta name="twitter:card" content="${og ? "summary_large_image" : "summary"}">`,
    xh ? `<meta name="twitter:site" content="@${xh}">` : "",
  ].filter(Boolean).join("\n");
  const boot = `<script>window.__BOOT=${JSON.stringify({ base: BASE, site: SITE_URL, post: post || null, x: xh, admin: ADMIN_URL }).replace(/</g, "\\u003c")};</script>`;
  const analytics = gc ? `<script data-goatcounter="https://${gc}.goatcounter.com/count" data-goatcounter-settings='{"no_onload":true}' async src="https://gc.zgo.at/count.js"></script>` : "";
  return template.replace("<!--HEAD-->", head).replace("<!--BOOT-->", boot + analytics).replaceAll("__BASE__", BASE);
}

await fs.writeFile(path.join(OUT, "index.html"), page({ title: siteTitle, desc: site.description || "Min.のイラストアーカイブ", url: `${SITE_URL}/`, og: defaultOg }));
for (const p of posts) {
  const dir = path.join(OUT, "w", p.slug);
  await fs.mkdir(dir, { recursive: true });
  const desc = (p.comment || `${p.category}｜${p.tags.map((t) => "#" + t).join(" ")}`).replace(/\s+/g, " ").slice(0, 120);
  await fs.writeFile(path.join(dir, "index.html"), page({ title: `${p.label}｜${siteTitle}`, desc, url: `${SITE_URL}/w/${p.slug}/`, og: (p.images[p.coverIdx] || p.images[0])?.og || defaultOg, post: p.slug }));
}

// ---------- キャラリンク集（/chara/・キャラぷに貼る用） ----------
// キャラぷ以外へのリンクは出さない。イラストは ILLUST LOG の作品から自動で紐づけ（リンクはせず画像だけ）。
// サムネ：正方形に切り抜き（顔が入りやすいよう注目領域を優先）
const thumbDone = new Map();
async function charaThumb(src) {
  if (!src) return "";
  if (thumbDone.has(src)) return thumbDone.get(src);
  const rel = imgRel(src);
  const file = path.join(ROOT, rel);
  if (!rel.startsWith("images/") || !(await exists(file))) { console.warn("キャラのサムネが見つかりません:", src); thumbDone.set(src, ""); return ""; }
  const buf = await fs.readFile(file);
  const hash = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 12);
  const name = sharp ? `img/c-${hash}.webp` : `img/c-${hash}${path.extname(rel) || ".jpg"}`;
  const cached = path.join(CACHE, path.basename(name));
  if (!(await exists(cached))) {
    await fs.mkdir(CACHE, { recursive: true });
    if (sharp) {
      const out = await sharp(buf).rotate().resize({ width: 480, height: 480, fit: "cover", position: sharp.strategy.attention }).webp({ quality: 80 }).toBuffer();
      await fs.writeFile(cached, out);
    } else await fs.writeFile(cached, buf);
  }
  await fs.mkdir(path.join(OUT, "img"), { recursive: true });
  await fs.copyFile(cached, path.join(OUT, name));
  const r = `${BASE}/${name}`;
  thumbDone.set(src, r);
  return r;
}

const characters = [];
for (const w of works) {
  const { raw, f } = w;
  const story = isKyarapu(raw.story || "") ? String(raw.story).trim() : "";
  const talk = isKyarapu(raw.talk || "") ? String(raw.talk).trim() : "";
  if (raw.story && !story) console.warn("キャラぷ以外のURLなので外しました:", f, raw.story);
  if (raw.talk && !talk) console.warn("キャラぷ以外のURLなので外しました:", f, raw.talk);
  const genres = list(raw.genres).filter((g) => CHARA_GENRES.includes(g));
  const updates = (Array.isArray(raw.updates) ? raw.updates : [])
    .map((u) => ({ date: day(u && u.date), text: String((u && u.text) || "").trim() }))
    .filter((u) => u.date && u.text).sort((a, b) => b.date.localeCompare(a.date));
  const illusts = [];
  for (const p of posts) if (p.workId === w.id) for (const im of p.images) illusts.push({ src: im.src, thumb: im.thumb, title: im.caption || p.label, date: p.date, charas: im.charas, tags: im.tags });
  // タグ：作品名 → 登場キャラ名 → 属性（旧データで作品名・キャラ名がタグにあっても二重にしない）
  const attr = uniqTags(list(raw.tags)).filter((t) => normName(t) !== normName(w.title) && !w.charas.some((c) => normName(c) === normName(t)));
  characters.push({
    id: w.id,
    title: w.title,
    category: CHARA_CATS.includes(raw.category) ? raw.category : CHARA_CATS[0],
    genres: genres.length ? genres : ["その他"],
    tagline: String(raw.tagline || "").trim(),
    charas: w.charas,
    tags: uniqTags([w.title, ...w.charas, ...attr]),
    featured: !!raw.featured,
    published: day(raw.published),
    thumb: await charaThumb(raw.thumb),
    story, talk, updates, illusts,
  });
}
characters.sort((a, b) => b.published.localeCompare(a.published) || b.id.localeCompare(a.id));

{
  const tpl = await fs.readFile(path.join(ROOT, "site/chara.html"), "utf8");
  const ctitle = "Min. | Characters";
  const cdesc = "Min.がキャラぷで公開しているキャラクターの一覧";
  const abs = (u) => (u ? SITE_URL + u.replace(BASE, "") : "");
  const cog = characters.find((c) => c.thumb)?.thumb;
  const headOf = ({ title, desc, url, og }) => [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(desc)}">`,
    `<link rel="canonical" href="${esc(url)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    og ? `<meta property="og:image" content="${esc(og)}">` : "",
  ].filter(Boolean).join("\n");
  const analytics = gc ? `<script data-goatcounter="https://${gc}.goatcounter.com/count" async src="https://gc.zgo.at/count.js"></script>` : "";
  const bootOf = (data) => `<script>window.__CHARA=${JSON.stringify({ updated: new Date().toISOString(), base: BASE, categories: CHARA_CATS, genres: CHARA_GENRES, ...data }).replace(/</g, "\\u003c")};</script>` + analytics;

  // 最新データ（ページが古く覚えられていても、開くたびにこちらを読む）
  await fs.mkdir(path.join(OUT, "data"), { recursive: true });
  await fs.writeFile(path.join(OUT, "data/chara.json"), JSON.stringify({ updated: new Date().toISOString(), characters }));

  // 一覧ページ（/chara/）
  await fs.mkdir(path.join(OUT, "chara"), { recursive: true });
  await fs.writeFile(path.join(OUT, "chara/index.html"),
    tpl.replace("<!--HEAD-->", headOf({ title: ctitle, desc: cdesc, url: `${SITE_URL}/chara/`, og: abs(cog) }))
      .replace("<!--BOOT-->", bootOf({ characters })));

  // 作品ごとのページ（/chara/w/作品ID/・その作品だけを表示。キャラぷの作品ページに貼る用）
  for (const c of characters) {
    const dir = path.join(OUT, "chara", "w", c.id);
    await fs.mkdir(dir, { recursive: true });
    const desc = (c.tagline || `${c.category}｜${c.genres.join(" / ")}`).replace(/\s+/g, " ").slice(0, 120);
    await fs.writeFile(path.join(dir, "index.html"),
      tpl.replace("<!--HEAD-->", headOf({ title: `${c.title}｜Min.`, desc, url: `${SITE_URL}/chara/w/${c.id}/`, og: abs(c.thumb || c.illusts[0]?.thumb) }))
        .replace("<!--BOOT-->", bootOf({ single: c.id, characters })));  // 「同じタグの作品」用に全作品を渡す
  }
  console.log(`キャラリンク集：${characters.length} 作品（作品ページ ${characters.length} 件）／イラスト紐づけ ${characters.reduce((n, c) => n + c.illusts.length, 0)} 枚`);
}

// ---------- ILLUST LOG：作品ごとのまとめ ----------
// キャラぷの作品は作品単位（シミュも1つ）。オリジナルはキャラ名ごと（名前なしは「オリジナル」）。それ以外は作品名（MVは曲名）。
const origFile = await readJSON(path.join(ROOT, "content/originals.json"), { covers: [] });
const origCovers = new Map();
for (const c of origFile.covers || []) { const n = normName(c && c.name); if (n && c.image) origCovers.set(n, await charaThumb(c.image)); }
const groupMap = new Map();
for (const p of posts) { // posts は新しい順
  let key, name;
  if (p.workId) { key = `w:${p.workId}`; name = p.work; }
  else if (p.category === "オリジナル") { key = `o:${normName(p.charas[0] || "")}`; name = p.charas[0] || "オリジナル"; }
  else if (p.work) { key = `n:${normName(p.work)}`; name = p.work; }
  else if (p.attrs[0]) { key = `t:${normName(p.attrs[0])}`; name = p.attrs[0]; }
  else { key = `c:${p.category}`; name = p.category; }
  p.group = key;
  let g = groupMap.get(key);
  if (!g) groupMap.set(key, g = { key, name, updated: p.date, first: p.date, cover: "", cats: [], posts: [], pics: 0, charapu: "" });
  g.posts.push(p.slug);
  g.pics += p.images.length;
  g.first = p.date;                    // いちばん古い投稿の日付（NEW/UPの判定用）
  const cv = coverOf(p); if (cv) g.cover = cv; // 表紙はいちばん古い投稿の表紙で固定（下で上書きあり）
  if (!g.charapu && p.charapu) g.charapu = p.charapu;
  if (!g.cats.includes(p.category)) g.cats.push(p.category);
}
for (const g of groupMap.values()) {
  if (g.key.startsWith("w:")) { const c = characters.find((x) => `w:${x.id}` === g.key); if (c && c.thumb) g.cover = c.thumb; }      // キャラぷ：キャラリンク集の顔
  if (g.key.startsWith("o:")) { const cv = origCovers.get(normName(g.name)); if (cv) g.cover = cv; }                                  // オリジナル：専用の表紙
}
const groups = [...groupMap.values()].sort((a, b) => b.updated.localeCompare(a.updated));
await fs.writeFile(path.join(OUT, "data/site.json"), JSON.stringify({ updated: new Date().toISOString(), categories, posts, groups }));
console.log(`作品まとめ：${groups.length} 件`);

// ---------- 自分用：作品名のチェック（/check/・どこからもリンクしない） ----------
{
  const lev = (a, b) => { const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]); for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[m][n]; };
  const suggest = (name) => { const n = normName(name); let best = null;
    for (const w of works) { const dist = lev(n, normName(w.title)); if (!best || dist < best.dist) best = { title: w.title, dist }; }
    return best && best.dist <= Math.max(2, Math.ceil(n.length * 0.3)) ? best.title : ""; };
  const bad = posts.filter((p) => p.unmatched);
  const noIll = characters.filter((c) => !c.illusts.length);
  const row = (p) => { const s = suggest(p.unmatched); return `<tr><td>${esc(p.date)}</td><td>${esc(p.label)}</td><td><b>${esc(p.unmatched)}</b></td><td>${s ? `もしかして「${esc(s)}」？` : "似た作品なし（まだ登録していない？）"}</td></tr>`; };
  const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>作品名チェック</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:20px 16px 48px;max-width:760px;margin-inline:auto;line-height:1.6;background:#f6f4ef;color:#141312}h1{font-size:22px}h2{font-size:16px;margin-top:28px;border-bottom:2px solid #141312}table{width:100%;border-collapse:collapse;font-size:13px}td,th{border-bottom:1px solid #ccc;padding:6px 4px;text-align:left;vertical-align:top}.ok{color:#1a7f37;font-weight:700}small{color:#666}@media(prefers-color-scheme:dark){body{background:#121110;color:#efece4}h2{border-color:#efece4}td,th{border-color:#444}small{color:#aaa}.ok{color:#5fd07d}}</style>
<h1>作品名チェック（自分用）</h1><p><small>${esc(new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }))} 時点。ILLUST LOGの投稿のうち、キャラ（リンク集）のどの作品とも結びついていないものです。</small></p>
<h2>結びついていないイラスト投稿（${bad.length}件）</h2>${bad.length ? `<table><tr><th>日付</th><th>投稿</th><th>入力した作品名</th><th>候補</th></tr>${bad.map(row).join("")}</table><p><small>直し方：投稿の「キャラぷの作品」を一覧から選び直すか、作品名をキャラ（リンク集）と同じにする。キャラぷのURLを入れても結びつきます。</small></p>` : `<p class="ok">すべて結びついています</p>`}
<h2>イラストがまだない作品（${noIll.length}件）</h2>${noIll.length ? `<table>${noIll.map((c) => `<tr><td>${esc(c.published)}</td><td>${esc(c.title)}</td></tr>`).join("")}</table>` : `<p class="ok">なし</p>`}
</html>`;
  await fs.mkdir(path.join(OUT, "check"), { recursive: true });
  await fs.writeFile(path.join(OUT, "check/index.html"), html);
  console.log(`作品名チェック：結びついていない投稿 ${bad.length} 件`);
}

// 管理画面はNetlify側へ案内（ログインの仕組みがNetlifyのため）
await fs.mkdir(path.join(OUT, "admin"), { recursive: true });
await fs.writeFile(path.join(OUT, "admin/index.html"), `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0;url=${ADMIN_URL}"><a href="${ADMIN_URL}">管理画面へ</a>`);
// Netlifyの管理画面で画像を確認できるよう、元の画像を /images/ に置く（サイト本体は軽くした img/ を使う）
if (await exists(path.join(ROOT, "images"))) await fs.cp(path.join(ROOT, "images"), path.join(OUT, "images"), { recursive: true });

// 自分用：透かしツール（/tool/・どこからもリンクしない）
await fs.mkdir(path.join(OUT, "tool"), { recursive: true });
await fs.copyFile(path.join(ROOT, "site/tool.html"), path.join(OUT, "tool/index.html"));
await fs.copyFile(path.join(ROOT, "site/sign.png"), path.join(OUT, "tool/sign.png"));

// AI学習用クローラーへのお断り
const aiBots = ["GPTBot", "ChatGPT-User", "OAI-SearchBot", "CCBot", "Google-Extended", "anthropic-ai", "ClaudeBot", "Claude-Web", "PerplexityBot", "Bytespider", "Applebot-Extended", "meta-externalagent", "FacebookBot", "cohere-ai", "Diffbot", "ImagesiftBot", "Omgilibot", "Timpibot", "img2dataset", "Amazonbot"];
await fs.writeFile(path.join(OUT, "robots.txt"), aiBots.map((b) => `User-agent: ${b}\nDisallow: /`).join("\n\n") + `\n\nUser-agent: *\nDisallow: /admin/\nDisallow: /images/\nDisallow: /check/\nDisallow: /tool/\nAllow: /\n`);
await fs.writeFile(path.join(OUT, ".nojekyll"), "");
await fs.writeFile(path.join(OUT, "404.html"), `<!doctype html><meta charset="utf-8"><title>ページが見つかりません</title><meta http-equiv="refresh" content="3;url=${BASE}/"><p style="font-family:sans-serif;padding:24px">ページが見つかりませんでした。トップに戻ります…</p>`);

console.log(`完了：作品 ${posts.length} 件／分類 ${categories.length} 件／画像 ${[...imgDone.values()].filter(Boolean).length} 枚`);
