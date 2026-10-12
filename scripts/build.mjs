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

// ---------- 画像 ----------
const imgDone = new Map();
async function processImage(src) {
  if (imgDone.has(src)) return imgDone.get(src);
  const rel = src.replace(/^\/+/, "");
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

const postDir = path.join(ROOT, "content/posts");
const files = (await exists(postDir)) ? (await fs.readdir(postDir)).filter((f) => f.endsWith(".json")) : [];
const posts = [];
for (const f of files) {
  const raw = await readJSON(path.join(postDir, f), null);
  if (!raw || !raw.title || !day(raw.date)) { console.warn("読み込めない作品:", f); continue; }
  const slug = f.replace(/\.json$/, "").replace(/[^\w-]/g, "-");
  const images = [];
  for (const s of list(raw.images ?? raw.image)) { const r = await processImage(s); if (r) images.push(r); }
  const media = [];
  for (const m of list(raw.media)) { const r = await parseMedia(m); if (r) media.push(r); }
  posts.push({
    slug, title: String(raw.title), date: day(raw.date),
    category: String(raw.category || "その他"),
    images, media,
    comment: String(raw.comment || ""),
    tags: [...new Set(list(raw.tags).map((t) => t.replace(/^#/, "")))],
    charapu: isHttps(String(raw.charapu || "").trim()) ? String(raw.charapu).trim() : "",
    pickup: !!raw.pickup,
    url: `${BASE}/w/${slug}/`,
  });
}
posts.sort((a, b) => b.date.localeCompare(a.date) || b.slug.localeCompare(a.slug));

const catNames = [...new Set([...(catFile.categories || []).map((c) => String(c.name || "").trim()).filter(Boolean), ...posts.map((p) => p.category)])];
const catDesc = Object.fromEntries((catFile.categories || []).map((c) => [String(c.name || "").trim(), String(c.description || "")]));
const coverOf = (p) => p.images[0]?.thumb || p.media.find((m) => m.thumb)?.thumb || "";
const categories = catNames.map((name) => {
  const ps = posts.filter((p) => p.category === name);
  return { name, description: catDesc[name] || "", count: ps.length, cover: ps.map(coverOf).find(Boolean) || "" };
}).filter((c) => c.count > 0 || catDesc[c.name] !== undefined);

// ---------- 書き出し ----------
await fs.mkdir(path.join(OUT, "data"), { recursive: true });
await fs.writeFile(path.join(OUT, "data/site.json"), JSON.stringify({ updated: new Date().toISOString(), categories, posts }));

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
  await fs.writeFile(path.join(dir, "index.html"), page({ title: `${p.title}｜${siteTitle}`, desc, url: `${SITE_URL}/w/${p.slug}/`, og: p.images[0]?.og || defaultOg, post: p.slug }));
}

// ---------- キャラリンク集（/chara/・キャラぷに貼る用） ----------
// キャラぷ以外へのリンクは出さない。イラストは ILLUST LOG の作品から自動で紐づけ（リンクはせず画像だけ）。
const CHARA_CATS = ["1:1ロールプレイ", "シミュレーション"];
const CHARA_GENRES = ["恋愛", "日常・現代", "ファンタジー", "BL", "その他"];
const isKyarapu = (u) => {
  try { const x = new URL(String(u).trim()); return x.protocol === "https:" && (x.hostname === "kyarapu.com" || x.hostname.endsWith(".kyarapu.com")); }
  catch { return false; }
};
const urlKey = (u) => { try { const x = new URL(String(u).trim()); return (x.hostname + x.pathname).replace(/\/+$/, "").toLowerCase(); } catch { return ""; } };
const normName = (s) => String(s || "").normalize("NFKC").toLowerCase()
  .replace(/[\u30a1-\u30f6]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60)).replace(/\s/g, "");

// サムネ：正方形に切り抜き（顔が入りやすいよう注目領域を優先）
const thumbDone = new Map();
async function charaThumb(src) {
  if (!src) return "";
  if (thumbDone.has(src)) return thumbDone.get(src);
  const rel = String(src).replace(/^\/+/, "");
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

const charaDir = path.join(ROOT, "content/characters");
const charaFiles = (await exists(charaDir)) ? (await fs.readdir(charaDir)).filter((f) => f.endsWith(".json")) : [];
const characters = [];
for (const f of charaFiles) {
  const raw = await readJSON(path.join(charaDir, f), null);
  if (!raw || !raw.title || !day(raw.published)) { console.warn("読み込めないキャラ:", f); continue; }
  const story = isKyarapu(raw.story || "") ? String(raw.story).trim() : "";
  const talk = isKyarapu(raw.talk || "") ? String(raw.talk).trim() : "";
  if (raw.story && !story) console.warn("キャラぷ以外のURLなので外しました:", f, raw.story);
  if (raw.talk && !talk) console.warn("キャラぷ以外のURLなので外しました:", f, raw.talk);
  const genres = list(raw.genres).filter((g) => CHARA_GENRES.includes(g));
  const updates = (Array.isArray(raw.updates) ? raw.updates : [])
    .map((u) => ({ date: day(u && u.date), text: String((u && u.text) || "").trim() }))
    .filter((u) => u.date && u.text).sort((a, b) => b.date.localeCompare(a.date));

  // イラストの紐づけ：キャラぷURLが同じ作品 or タグがキャラ名（別名）と同じ作品
  const keys = [story, talk].filter(Boolean).map(urlKey);
  const names = [raw.title, ...list(raw.illust_tags)].map(normName).filter(Boolean);
  const illusts = [];
  for (const p of posts) {
    const byUrl = p.charapu && keys.includes(urlKey(p.charapu));
    const byTag = p.tags.some((t) => names.includes(normName(t)));
    if (byUrl || byTag) for (const im of p.images) illusts.push({ src: im.src, thumb: im.thumb, title: p.title, date: p.date });
  }

  characters.push({
    id: f.replace(/\.json$/, "").replace(/[^\w-]/g, "-"),
    title: String(raw.title).trim(),
    category: CHARA_CATS.includes(raw.category) ? raw.category : CHARA_CATS[0],
    genres: genres.length ? genres : ["その他"],
    tagline: String(raw.tagline || "").trim(),
    tags: [...new Set(list(raw.tags).map((t) => t.replace(/^#/, "")))],
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
  const bootOf = (data) => `<script>window.__CHARA=${JSON.stringify({ updated: new Date().toISOString(), base: BASE, categories: CHARA_CATS, genres: CHARA_GENRES, ...data }).replace(/</g, "\\u003c")};</script>`;

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
        .replace("<!--BOOT-->", bootOf({ single: c.id, characters: [c] })));
  }
  console.log(`キャラリンク集：${characters.length} 作品（作品ページ ${characters.length} 件）／イラスト紐づけ ${characters.reduce((n, c) => n + c.illusts.length, 0)} 枚`);
}

// 管理画面はNetlify側へ案内
await fs.mkdir(path.join(OUT, "admin"), { recursive: true });
await fs.writeFile(path.join(OUT, "admin/index.html"), `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0;url=${ADMIN_URL}"><a href="${ADMIN_URL}">管理画面へ</a>`);

// AI学習用クローラーへのお断り
const aiBots = ["GPTBot", "ChatGPT-User", "OAI-SearchBot", "CCBot", "Google-Extended", "anthropic-ai", "ClaudeBot", "Claude-Web", "PerplexityBot", "Bytespider", "Applebot-Extended", "meta-externalagent", "FacebookBot", "cohere-ai", "Diffbot", "ImagesiftBot", "Omgilibot", "Timpibot", "img2dataset", "Amazonbot"];
await fs.writeFile(path.join(OUT, "robots.txt"), aiBots.map((b) => `User-agent: ${b}\nDisallow: /`).join("\n\n") + `\n\nUser-agent: *\nDisallow: /admin/\nAllow: /\n`);
await fs.writeFile(path.join(OUT, ".nojekyll"), "");
await fs.writeFile(path.join(OUT, "404.html"), `<!doctype html><meta charset="utf-8"><title>ページが見つかりません</title><meta http-equiv="refresh" content="3;url=${BASE}/"><p style="font-family:sans-serif;padding:24px">ページが見つかりませんでした。トップに戻ります…</p>`);

console.log(`完了：作品 ${posts.length} 件／分類 ${categories.length} 件／画像 ${[...imgDone.values()].filter(Boolean).length} 枚`);
